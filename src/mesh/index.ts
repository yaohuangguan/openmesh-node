import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { PeerCertificate } from 'node:tls';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { certificateHasExclusiveWorkloadIdentity, validateWorkloadIdentity } from '../security/identity.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export interface Peer { id: string; url: string; }

export type PeerSelectionStrategy = 'rendezvous' | 'p2c';

export interface AdaptiveConcurrencyOptions {
  min?: number;
  initial?: number;
  max?: number;
  targetLatencyMs?: number;
  decreaseRatio?: number;
  increaseStep?: number;
  sampleSize?: number;
}

interface ResolvedAdaptiveConcurrency {
  min: number;
  max: number;
  targetLatencyMs: number;
  decreaseRatio: number;
  increaseStep: number;
  sampleSize: number;
}

export type PeerPoolEvent =
  | { type: 'admission.queued'; at: number; inflight: number; queued: number }
  | { type: 'admission.rejected'; at: number; inflight: number; queued: number }
  | { type: 'peer.attempt'; at: number; peer: Peer; method: string; path: string; attempt: number }
  | { type: 'peer.success'; at: number; peer: Peer; method: string; path: string; attempt: number; statusCode: number; latencyMs: number }
  | { type: 'peer.failure'; at: number; peer: Peer; method: string; path: string; attempt: number; latencyMs: number; code?: string; statusCode?: number }
  | { type: 'peer.cancelled'; at: number; peer: Peer; method: string; path: string; attempt: number }
  | { type: 'concurrency.changed'; at: number; previous: number; current: number; reason: 'latency' | 'failure'; observedLatencyMs?: number };

export type PeerPoolObserver = (event: PeerPoolEvent) => void;

export interface PeerOptions {
  method?: string;
  key?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeout?: number;
  retries?: number;
  retryUnsafe?: boolean;
  idempotencyKey?: string;
  peerIds?: readonly string[];
}

export interface PeerStreamOptions extends PeerOptions {
  idleTimeout?: number;
}

export interface TransportRequest {
  peer: Peer;
  url: URL;
  method: string;
  headers: Record<string, string | number>;
  body?: string | Buffer | Uint8Array;
  signal: AbortSignal;
  maxResponseBytes: number;
  idleTimeout?: number;
}

export interface TransportResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface StreamTransportResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

export interface PeerStats extends Peer {
  failures: number;
  attempts: number;
  successes: number;
  inflight: number;
  lastLatencyMs: number | null;
  ewmaLatencyMs: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  circuit: 'open' | 'half-open' | 'closed';
  probing: boolean;
}

interface PeerState {
  url: string;
  failures: number;
  unavailableUntil: number;
  probing: boolean;
  attempts: number;
  successes: number;
  inflight: number;
  lastLatencyMs: number | null;
  ewmaLatencyMs: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

interface DiscoveryWatcher {
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

interface AdmissionWaiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

export interface PeerPoolStats {
  inflight: number;
  queued: number;
  overloadRejections: number;
  maxInflight: number;
  maxQueue: number;
  concurrencyLimit: number;
  adaptive: boolean;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;
export type StreamTransport = (request: TransportRequest) => Promise<StreamTransportResponse>;

interface PreparedPeerRequest {
  method: string;
  headers: Record<string, string | number>;
  body?: string | Buffer | Uint8Array;
  timeout: number;
  attempts: number;
  candidates: Peer[];
}

export class PeerError extends Error {
  code: string;
  peer?: Peer;
  statusCode?: number;
  response?: TransportResponse;

  constructor(message: string, code: string, options: ErrorOptions & {
    peer?: Peer;
    statusCode?: number;
    response?: TransportResponse;
  } = {}) {
    super(message, options);
    this.name = 'PeerError';
    this.code = code;
    if (options.peer) this.peer = options.peer;
    if (options.statusCode) this.statusCode = options.statusCode;
    if (options.response) this.response = options.response;
  }
}

export class PeerResponse {
  peer: Peer;
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;

  constructor(peer: Peer, response: TransportResponse) {
    this.peer = peer;
    this.statusCode = response.statusCode;
    this.headers = response.headers;
    this.body = response.body;
  }

  text(): string { return this.body.toString('utf8'); }
  json(): unknown { return JSON.parse(this.text()); }
}

export class PeerStreamResponse {
  peer: Peer;
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;

  constructor(peer: Peer, response: StreamTransportResponse) {
    this.peer = peer;
    this.statusCode = response.statusCode;
    this.headers = response.headers;
    this.body = response.body;
  }

  async text(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  async json(): Promise<unknown> { return JSON.parse(await this.text()); }
  destroy(error?: Error): void { this.body.destroy(error); }
}

function validatePeers(peers: Peer[], requireTls = false): Readonly<Peer>[] {
  if (!Array.isArray(peers)) throw new TypeError('Peers must be an array');
  const ids = new Set<string>();
  return peers.map(peer => {
    if (!peer || typeof peer.id !== 'string' || !peer.id || ids.has(peer.id)) {
      throw new TypeError('Peers need unique nonempty ids');
    }
    const url = new URL(peer.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('Peer URL must be a trusted HTTP(S) origin or path prefix without credentials, query or fragment');
    }
    if (requireTls && url.protocol !== 'https:') {
      throw new TypeError('Peer URL must use HTTPS when workload identity verification is enabled');
    }
    ids.add(peer.id);
    return Object.freeze({ id: peer.id, url: url.origin + url.pathname.replace(/\/$/, '') });
  });
}

function targetURL(peer: Peer, path: string): URL {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path)) {
    throw new TypeError('RPC path must be an absolute local path, not a URL');
  }
  return new URL(peer.url + path);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); }
    );
  });
}

export interface PeerTlsOptions {
  ca?: https.AgentOptions['ca'];
  cert?: https.AgentOptions['cert'];
  key?: https.AgentOptions['key'];
  passphrase?: string;
  minVersion?: https.AgentOptions['minVersion'];
  rejectUnauthorized?: boolean;
  expectedIdentity?: string;
}

export interface PeerTlsRotationOptions {
  graceMs?: number;
}

export interface PeerPoolOptions {
  peers?: Peer[];
  tls?: PeerTlsOptions;
  timeout?: number;
  retries?: number;
  failureThreshold?: number;
  cooldown?: number;
  maxResponseBytes?: number;
  maxSockets?: number;
  maxInflight?: number;
  maxQueue?: number;
  selection?: PeerSelectionStrategy;
  transport?: Transport;
  streamTransport?: StreamTransport;
  onEvent?: PeerPoolObserver;
  adaptiveConcurrency?: boolean | AdaptiveConcurrencyOptions;
}

function createHttpsAgent(
  tlsOptions: PeerTlsOptions | undefined,
  maxSockets: number
): { agent: https.Agent; requireTls: boolean } {
  if (tlsOptions !== undefined && (!tlsOptions || typeof tlsOptions !== 'object' || Array.isArray(tlsOptions))) {
    throw new TypeError('tls must be a TLS client options object');
  }
  if ((tlsOptions?.cert === undefined) !== (tlsOptions?.key === undefined)) {
    throw new TypeError('TLS client cert and key must be configured together');
  }

  const expectedIdentity = tlsOptions?.expectedIdentity;
  if (expectedIdentity !== undefined) {
    validateWorkloadIdentity(expectedIdentity);
    if (tlsOptions?.rejectUnauthorized === false) {
      throw new TypeError('rejectUnauthorized cannot be false when workload identity verification is enabled');
    }
  }

  const { expectedIdentity: _expectedIdentity, ...agentTls } = tlsOptions || {};
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets,
    maxTotalSockets: 256,
    ...agentTls,
    ...(expectedIdentity
      ? {
          checkServerIdentity: (_hostname: string, certificate: PeerCertificate) => {
            if (!certificateHasExclusiveWorkloadIdentity(certificate, expectedIdentity)) {
              return new PeerError(
                'Peer certificate does not match workload identity ' + expectedIdentity,
                'IDENTITY_MISMATCH'
              );
            }
            return undefined;
          }
        }
      : {})
  });

  return { agent, requireTls: expectedIdentity !== undefined };
}

export class PeerPool {
  timeout: number;
  retries: number;
  failureThreshold: number;
  cooldown: number;
  maxResponseBytes: number;
  maxInflight: number;
  maxQueue: number;
  selection: PeerSelectionStrategy;
  private _http: http.Agent;
  private _https: https.Agent;
  private _maxSockets: number;
  private _requireTls = false;
  private _retiredHttpsAgents = new Map<https.Agent, NodeJS.Timeout>();
  private _transport: Transport;
  private _streamTransport: StreamTransport;
  private _observer: PeerPoolObserver | null;
  private _states = new Map<string, PeerState>();
  private _peers: Readonly<Peer>[] = [];
  private _cache = new Map<string, Readonly<Peer>[]>();
  private _active = new Set<AbortController>();
  private _admitted = 0;
  private _queue: AdmissionWaiter[] = [];
  private _overloadRejections = 0;
  private _adaptive: ResolvedAdaptiveConcurrency | null = null;
  private _concurrencyLimit: number;
  private _latencySamples: number[] = [];
  private _counter = 0;
  private _closed = false;
  private _watch: DiscoveryWatcher | null = null;

  constructor(options: PeerPoolOptions = {}) {
    this.timeout = options.timeout ?? 2000;
    this.retries = options.retries ?? 1;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldown = options.cooldown ?? 10000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.maxInflight = options.maxInflight ?? 256;
    this.maxQueue = options.maxQueue ?? 1024;
    this.selection = options.selection ?? 'p2c';
    this._concurrencyLimit = this.maxInflight;

    for (const name of ['timeout', 'failureThreshold', 'cooldown', 'maxResponseBytes', 'maxInflight'] as const) {
      if (!Number.isSafeInteger(this[name]) || this[name] <= 0) throw new TypeError(name + ' must be a positive integer');
    }
    if (!Number.isSafeInteger(this.retries) || this.retries < 0) throw new TypeError('Retries must be a nonnegative integer');
    if (!Number.isSafeInteger(this.maxQueue) || this.maxQueue < 0) throw new TypeError('maxQueue must be a nonnegative integer');
    if (!['rendezvous', 'p2c'].includes(this.selection)) throw new TypeError('selection must be rendezvous or p2c');

    if (options.adaptiveConcurrency) {
      const adaptive = options.adaptiveConcurrency === true ? {} : options.adaptiveConcurrency;
      const min = adaptive.min ?? 8;
      const max = adaptive.max ?? this.maxInflight;
      const initial = adaptive.initial ?? Math.min(max, Math.max(min, 32));
      const targetLatencyMs = adaptive.targetLatencyMs ?? 100;
      const decreaseRatio = adaptive.decreaseRatio ?? 0.8;
      const increaseStep = adaptive.increaseStep ?? 1;
      const sampleSize = adaptive.sampleSize ?? 20;

      if (
        !Number.isSafeInteger(min) || min < 1 ||
        !Number.isSafeInteger(max) || max < min || max > this.maxInflight ||
        !Number.isSafeInteger(initial) || initial < min || initial > max ||
        !Number.isSafeInteger(targetLatencyMs) || targetLatencyMs < 1 ||
        typeof decreaseRatio !== 'number' || !Number.isFinite(decreaseRatio) || decreaseRatio <= 0 || decreaseRatio >= 1 ||
        !Number.isSafeInteger(increaseStep) || increaseStep < 1 ||
        !Number.isSafeInteger(sampleSize) || sampleSize < 1
      ) {
        throw new TypeError('Invalid adaptiveConcurrency options');
      }

      this._adaptive = { min, max, targetLatencyMs, decreaseRatio, increaseStep, sampleSize };
      this._concurrencyLimit = initial;
    }

    const maxSockets = options.maxSockets ?? 32;
    if (!Number.isSafeInteger(maxSockets) || maxSockets <= 0) throw new TypeError('maxSockets must be a positive integer');
    if (options.transport !== undefined && typeof options.transport !== 'function') throw new TypeError('Transport must be a function');
    if (options.streamTransport !== undefined && typeof options.streamTransport !== 'function') throw new TypeError('streamTransport must be a function');
    if (options.onEvent !== undefined && typeof options.onEvent !== 'function') throw new TypeError('onEvent must be a function');

    this._maxSockets = maxSockets;
    const secure = createHttpsAgent(options.tls, maxSockets);
    this._requireTls = secure.requireTls;

    this._observer = options.onEvent || null;
    this._http = new http.Agent({ keepAlive: true, maxSockets, maxTotalSockets: 256 });
    this._https = secure.agent;
    this._transport = options.transport || (request => this._send(request));
    this._streamTransport = options.streamTransport
      || (options.transport
        ? async request => {
            const response = await this._transport(request);
            return { ...response, body: Readable.from(response.body) };
          }
        : request => this._sendStream(request));
    this.updatePeers(options.peers || []);
  }

  updateTls(tls: PeerTlsOptions, { graceMs = 30000 }: PeerTlsRotationOptions = {}): this {
    if (this._closed) throw new PeerError('Peer pool is closed', 'POOL_CLOSED');
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      throw new TypeError('TLS rotation graceMs must be a nonnegative integer');
    }

    const secure = createHttpsAgent(tls, this._maxSockets);
    try {
      validatePeers(this.peers, secure.requireTls);
    } catch (error) {
      secure.agent.destroy();
      throw error;
    }

    const previous = this._https;
    this._https = secure.agent;
    this._requireTls = secure.requireTls;

    if (graceMs === 0) {
      previous.destroy();
      return this;
    }

    const timer = setTimeout(() => {
      this._retiredHttpsAgents.delete(previous);
      previous.destroy();
    }, graceMs);
    timer.unref();
    this._retiredHttpsAgents.set(previous, timer);
    return this;
  }

  updatePeers(peers: Peer[]): this {
    if (this._closed) throw new PeerError('Peer pool is closed', 'POOL_CLOSED');
    const next = validatePeers(peers, this._requireTls);
    const states = new Map<string, PeerState>();
    for (const peer of next) {
      const previous = this._states.get(peer.id);
      states.set(peer.id, previous?.url === peer.url ? previous : {
        url: peer.url,
        failures: 0,
        unavailableUntil: 0,
        probing: false,
        attempts: 0,
        successes: 0,
        inflight: 0,
        lastLatencyMs: null,
        ewmaLatencyMs: null,
        lastSuccessAt: null,
        lastFailureAt: null
      });
    }
    this._states = states;
    this._peers = next;
    this._cache.clear();
    return this;
  }

  get peers(): Peer[] { return this._peers.map(peer => ({ ...peer })); }

  rank(key: string): Peer[] {
    const normalized = String(key);
    let ranked = this._cache.get(normalized);
    if (!ranked) {
      ranked = this._peers
        .map(peer => ({
          peer,
          score: createHash('sha256').update(JSON.stringify([normalized, peer.id])).digest().readBigUInt64BE()
        }))
        .sort((a, b) => a.score > b.score ? -1 : a.score < b.score ? 1 : a.peer.id.localeCompare(b.peer.id))
        .map(value => value.peer);
      if (this._cache.size >= 1024) {
        const first = this._cache.keys().next().value as string | undefined;
        if (first !== undefined) this._cache.delete(first);
      }
      this._cache.set(normalized, ranked);
    }
    return ranked.map(peer => ({ ...peer }));
  }

  private _compareLoad(a: Peer, b: Peer, now: number): number {
    const left = this._states.get(a.id);
    const right = this._states.get(b.id);
    if (!left || !right) return 0;

    const leftBlocked = left.unavailableUntil > now || left.probing ? 1 : 0;
    const rightBlocked = right.unavailableUntil > now || right.probing ? 1 : 0;
    if (leftBlocked !== rightBlocked) return leftBlocked - rightBlocked;
    if (left.failures !== right.failures) return left.failures - right.failures;
    if (left.inflight !== right.inflight) return left.inflight - right.inflight;

    const leftLatency = left.ewmaLatencyMs ?? 0;
    const rightLatency = right.ewmaLatencyMs ?? 0;
    return leftLatency - rightLatency;
  }

  private _candidates(key?: string, peerIds?: readonly string[]): Peer[] {
    let ranked = this.rank(key ?? String(this._counter++));

    if (peerIds) {
      const allowed = new Set(peerIds);
      ranked = ranked.filter(peer => allowed.has(peer.id));
    }

    if (key !== undefined || this.selection === 'rendezvous' || ranked.length < 2) return ranked;

    if (this._compareLoad(ranked[1]!, ranked[0]!, Date.now()) < 0) {
      [ranked[0], ranked[1]] = [ranked[1]!, ranked[0]!];
    }
    return ranked;
  }

  stats(): PeerStats[] {
    const now = Date.now();
    return this._peers.map(peer => {
      const state = this._states.get(peer.id)!;
      return {
        ...peer,
        failures: state.failures,
        attempts: state.attempts,
        successes: state.successes,
        inflight: state.inflight,
        lastLatencyMs: state.lastLatencyMs,
        ewmaLatencyMs: state.ewmaLatencyMs,
        lastSuccessAt: state.lastSuccessAt,
        lastFailureAt: state.lastFailureAt,
        circuit: state.unavailableUntil > now ? 'open' : state.failures >= this.failureThreshold ? 'half-open' : 'closed',
        probing: state.probing
      };
    });
  }

  poolStats(): PeerPoolStats {
    return {
      inflight: this._admitted,
      queued: this._queue.length,
      overloadRejections: this._overloadRejections,
      maxInflight: this.maxInflight,
      maxQueue: this.maxQueue,
      concurrencyLimit: this._concurrencyLimit,
      adaptive: this._adaptive !== null
    };
  }

  private _emit(event: PeerPoolEvent): void {
    if (!this._observer) return;
    try { this._observer(event); } catch {}
  }

  private _drainAdmission(): void {
    while (this._admitted < this._concurrencyLimit && this._queue.length) {
      const waiter = this._queue.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this._admitted++;
      waiter.resolve(() => this._releaseAdmission());
    }
  }

  private _releaseAdmission(): void {
    this._admitted = Math.max(0, this._admitted - 1);
    this._drainAdmission();
  }

  private _setConcurrencyLimit(next: number, reason: 'latency' | 'failure', observedLatencyMs?: number): void {
    if (!this._adaptive) return;
    next = Math.max(this._adaptive.min, Math.min(this._adaptive.max, next));
    if (next === this._concurrencyLimit) return;
    const previous = this._concurrencyLimit;
    this._concurrencyLimit = next;
    this._emit({
      type: 'concurrency.changed',
      at: Date.now(),
      previous,
      current: next,
      reason,
      ...(observedLatencyMs !== undefined ? { observedLatencyMs } : {})
    });
    this._drainAdmission();
  }

  private _concurrencyFeedback(latencyMs: number, failed: boolean): void {
    const adaptive = this._adaptive;
    if (!adaptive) return;

    if (failed) {
      this._latencySamples.length = 0;
      this._setConcurrencyLimit(
        Math.max(adaptive.min, Math.floor(this._concurrencyLimit * adaptive.decreaseRatio)),
        'failure',
        latencyMs
      );
      return;
    }

    this._latencySamples.push(latencyMs);
    if (this._latencySamples.length < adaptive.sampleSize) return;

    const sorted = this._latencySamples.splice(0).sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil(sorted.length * 0.9) - 1);
    const p90 = sorted[index]!;
    if (p90 > adaptive.targetLatencyMs * 1.2) {
      this._setConcurrencyLimit(
        Math.max(adaptive.min, Math.floor(this._concurrencyLimit * adaptive.decreaseRatio)),
        'latency',
        p90
      );
    } else if (p90 <= adaptive.targetLatencyMs) {
      this._setConcurrencyLimit(
        Math.min(adaptive.max, this._concurrencyLimit + adaptive.increaseStep),
        'latency',
        p90
      );
    }
  }

  private _admit(signal: AbortSignal): Promise<() => void> {
    if (this._closed) return Promise.reject(new PeerError('Peer pool is closed', 'POOL_CLOSED'));
    if (signal.aborted) return Promise.reject(signal.reason);

    if (this._admitted < this._concurrencyLimit) {
      this._admitted++;
      return Promise.resolve(() => this._releaseAdmission());
    }

    if (this._queue.length >= this.maxQueue) {
      this._overloadRejections++;
      this._emit({ type: 'admission.rejected', at: Date.now(), inflight: this._admitted, queued: this._queue.length });
      return Promise.reject(new PeerError('Peer pool admission queue is full', 'POOL_OVERLOADED'));
    }

    return new Promise((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this._queue.indexOf(waiter);
          if (index >= 0) this._queue.splice(index, 1);
          reject(signal.reason);
        }
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this._queue.push(waiter);
      this._emit({ type: 'admission.queued', at: Date.now(), inflight: this._admitted, queued: this._queue.length });
    });
  }

  private _claim(peer: Peer): PeerState | null {
    const state = this._states.get(peer.id);
    if (!state || state.url !== peer.url || state.unavailableUntil > Date.now() || state.probing) return null;
    if (state.failures >= this.failureThreshold) state.probing = true;
    state.attempts++;
    state.inflight++;
    return state;
  }

  private _latency(state: PeerState, latency: number): void {
    state.lastLatencyMs = latency;
    state.ewmaLatencyMs = state.ewmaLatencyMs === null ? latency : state.ewmaLatencyMs * 0.8 + latency * 0.2;
  }

  private _success(state: PeerState, latency: number): void {
    state.inflight = Math.max(0, state.inflight - 1);
    state.successes++;
    this._latency(state, latency);
    state.lastSuccessAt = Date.now();
    state.failures = 0;
    state.unavailableUntil = 0;
    state.probing = false;
  }

  private _failure(state: PeerState, latency: number): void {
    state.inflight = Math.max(0, state.inflight - 1);
    state.failures++;
    this._latency(state, latency);
    state.lastFailureAt = Date.now();
    state.probing = false;
    if (state.failures >= this.failureThreshold) state.unavailableUntil = Date.now() + this.cooldown;
  }

  private _cancel(state: PeerState): void {
    state.inflight = Math.max(0, state.inflight - 1);
    state.probing = false;
  }

  private _prepare(path: string, options: PeerOptions = {}, onlyPeer: Peer | null = null): PreparedPeerRequest {
    if (this._closed) throw new PeerError('Peer pool is closed', 'POOL_CLOSED');

    const method = (options.method || 'GET').toUpperCase();
    const headers: Record<string, string | number> = { ...options.headers };
    let body: string | Buffer | Uint8Array | undefined;
    if (options.body !== undefined && options.body !== null) {
      if (Buffer.isBuffer(options.body) || options.body instanceof Uint8Array || typeof options.body === 'string') {
        body = options.body;
      } else {
        body = JSON.stringify(options.body);
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
    }
    if (body !== undefined && !Object.keys(headers).some(key => ['content-length', 'transfer-encoding'].includes(key.toLowerCase()))) {
      headers['content-length'] = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
    }

    const retries = options.retries ?? this.retries;
    const timeout = options.timeout ?? this.timeout;
    if (!Number.isSafeInteger(retries) || retries < 0 || !Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new TypeError('Retries and timeout must be valid integers');
    }
    if (options.retryUnsafe && (typeof options.idempotencyKey !== 'string' || !options.idempotencyKey)) {
      throw new TypeError('retryUnsafe requires an idempotencyKey and server-side deduplication');
    }
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    const attempts = SAFE_METHODS.has(method) || options.retryUnsafe ? retries + 1 : 1;

    if (
      options.peerIds !== undefined &&
      (
        !Array.isArray(options.peerIds) ||
        !options.peerIds.length ||
        options.peerIds.some(id => typeof id !== 'string' || !id)
      )
    ) {
      throw new TypeError('peerIds must be a nonempty array of peer ids');
    }

    const candidates = onlyPeer ? [onlyPeer] : this._candidates(options.key, options.peerIds);
    if (!candidates.length) throw new PeerError('No peers available', 'NO_PEERS');
    for (const peer of candidates) targetURL(peer, path);

    return { method, headers, body, timeout, attempts, candidates };
  }

  private _send({ url, method, headers, body, signal, maxResponseBytes }: TransportRequest): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      const secure = url.protocol === 'https:';
      const req = (secure ? https : http).request(url, {
        method,
        headers,
        signal,
        agent: secure ? this._https : this._http
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        let stopped = false;
        res.on('data', (chunk: Buffer) => {
          if (stopped) return;
          size += chunk.length;
          if (size > maxResponseBytes) {
            stopped = true;
            reject(new PeerError('Peer response exceeds size limit', 'RESPONSE_TOO_LARGE'));
            res.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        res.once('end', () => {
          if (!stopped) resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks, size) });
        });
        res.once('error', reject);
        res.once('aborted', () => reject(new PeerError('Peer response aborted', 'RESPONSE_ABORTED')));
      });
      req.once('error', reject);
      req.end(body);
    });
  }

  private _sendStream({ url, method, headers, body, signal, maxResponseBytes, idleTimeout }: TransportRequest): Promise<StreamTransportResponse> {
    return new Promise((resolve, reject) => {
      const secure = url.protocol === 'https:';
      const req = (secure ? https : http).request(url, {
        method,
        headers,
        signal,
        agent: secure ? this._https : this._http
      }, res => {
        let size = 0;
        const limiter = new Transform({
          transform(chunk: Buffer | string, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > maxResponseBytes) {
              callback(new PeerError('Peer response exceeds size limit', 'RESPONSE_TOO_LARGE'));
              return;
            }
            callback(null, bytes);
          }
        });

        const abort = (): void => {
          const reason = signal.reason instanceof Error
            ? signal.reason
            : new PeerError('Peer stream aborted', 'STREAM_ABORTED');
          res.destroy(reason);
          limiter.destroy(reason);
        };
        const cleanup = (): void => {
          signal.removeEventListener('abort', abort);
          if (idleTimeout) res.setTimeout(0);
        };
        if (idleTimeout) {
          res.setTimeout(idleTimeout, () => {
            const error = new PeerError('Peer stream idle timeout exceeded', 'STREAM_IDLE_TIMEOUT');
            limiter.destroy(error);
            res.destroy(error);
          });
        }
        signal.addEventListener('abort', abort, { once: true });
        limiter.once('close', () => {
          cleanup();
          if (!res.complete) res.destroy();
        });
        limiter.on('error', () => res.destroy());
        res.once('error', error => limiter.destroy(error));
        res.once('aborted', () => limiter.destroy(new PeerError('Peer response aborted', 'RESPONSE_ABORTED')));
        res.pipe(limiter);

        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: limiter });
      });
      req.once('error', reject);
      req.end(body);
    });
  }

  request(path: string, options: PeerOptions = {}): Promise<PeerResponse> {
    return this._request(path, options);
  }

  private async _request(path: string, options: PeerOptions = {}, onlyPeer: Peer | null = null): Promise<PeerResponse> {
    const { method, headers, body, timeout, attempts, candidates } = this._prepare(path, options, onlyPeer);

    const controller = new AbortController();
    this._active.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new PeerError('Peer request deadline exceeded', 'DEADLINE_EXCEEDED')), timeout);
    let releaseAdmission: (() => void) | null = null;
    let count = 0;
    let lastError: unknown;

    try {
      if (signal.aborted) throw signal.reason;
      releaseAdmission = await this._admit(signal);
      if (signal.aborted) throw signal.reason;
      for (const peer of candidates) {
        const state = this._claim(peer);
        if (!state) continue;
        count++;
        const attempt = count;
        const started = performance.now();
        this._emit({ type: 'peer.attempt', at: Date.now(), peer: { ...peer }, method, path, attempt });
        try {
          const response = await raceAbort(
            this._transport({ peer, url: targetURL(peer, path), method, headers, body, signal, maxResponseBytes: this.maxResponseBytes }),
            signal
          );
          if (response.statusCode >= 500) {
            throw new PeerError('Peer returned HTTP ' + response.statusCode, 'REMOTE_HTTP_ERROR', {
              peer,
              statusCode: response.statusCode,
              response
            });
          }
          const latencyMs = performance.now() - started;
          this._success(state, latencyMs);
          this._concurrencyFeedback(latencyMs, false);
          this._emit({ type: 'peer.success', at: Date.now(), peer: { ...peer }, method, path, attempt, statusCode: response.statusCode, latencyMs });
          return new PeerResponse(peer, response);
        } catch (error) {
          if (options.signal?.aborted || this._closed) {
            this._cancel(state);
            this._emit({ type: 'peer.cancelled', at: Date.now(), peer: { ...peer }, method, path, attempt });
            throw signal.reason || error;
          }
          const latencyMs = performance.now() - started;
          this._failure(state, latencyMs);
          this._concurrencyFeedback(latencyMs, true);
          const peerError = error instanceof PeerError ? error : null;
          this._emit({
            type: 'peer.failure',
            at: Date.now(),
            peer: { ...peer },
            method,
            path,
            attempt,
            latencyMs,
            ...(peerError?.code ? { code: peerError.code } : {}),
            ...(peerError?.statusCode ? { statusCode: peerError.statusCode } : {})
          });
          lastError = error;
          if (signal.aborted) throw signal.reason;
          if (count >= attempts) break;
        }
      }
      throw lastError || new PeerError('All peer circuits are open', 'NO_HEALTHY_PEERS');
    } finally {
      releaseAdmission?.();
      clearTimeout(timer);
      this._active.delete(controller);
    }
  }

  requestStream(path: string, options: PeerStreamOptions = {}): Promise<PeerStreamResponse> {
    return this._requestStream(path, options);
  }

  private async _requestStream(path: string, options: PeerStreamOptions = {}, onlyPeer: Peer | null = null): Promise<PeerStreamResponse> {
    const { method, headers, body, timeout, attempts, candidates } = this._prepare(path, options, onlyPeer);
    const idleTimeout = options.idleTimeout ?? 0;
    if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 0) throw new TypeError('idleTimeout must be a nonnegative integer');
    const controller = new AbortController();
    this._active.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(
      () => controller.abort(new PeerError('Peer response headers deadline exceeded', 'DEADLINE_EXCEEDED')),
      timeout
    );
    let releaseAdmission: (() => void) | null = null;
    let handedOff = false;
    let count = 0;
    let lastError: unknown;

    try {
      if (signal.aborted) throw signal.reason;
      releaseAdmission = await this._admit(signal);
      if (signal.aborted) throw signal.reason;

      for (const peer of candidates) {
        const state = this._claim(peer);
        if (!state) continue;
        count++;
        const attempt = count;
        const started = performance.now();
        this._emit({ type: 'peer.attempt', at: Date.now(), peer: { ...peer }, method, path, attempt });

        try {
          const response = await raceAbort(
            this._streamTransport({ peer, url: targetURL(peer, path), method, headers, body, signal, maxResponseBytes: this.maxResponseBytes, ...(idleTimeout ? { idleTimeout } : {}) }),
            signal
          );

          if (response.statusCode >= 500) {
            response.body.destroy();
            throw new PeerError('Peer returned HTTP ' + response.statusCode, 'REMOTE_HTTP_ERROR', { peer, statusCode: response.statusCode });
          }

          const headerLatencyMs = performance.now() - started;
          this._concurrencyFeedback(headerLatencyMs, false);
          clearTimeout(timer);
          let finalized = false;
          const finalize = (outcome: 'success' | 'failure' | 'cancelled', error?: unknown): void => {
            if (finalized) return;
            finalized = true;
            const latencyMs = performance.now() - started;

            if (outcome === 'success') {
              this._success(state, latencyMs);
              this._emit({
                type: 'peer.success',
                at: Date.now(),
                peer: { ...peer },
                method,
                path,
                attempt,
                statusCode: response.statusCode,
                latencyMs
              });
            } else if (outcome === 'cancelled') {
              this._cancel(state);
              this._emit({ type: 'peer.cancelled', at: Date.now(), peer: { ...peer }, method, path, attempt });
            } else {
              this._failure(state, latencyMs);
              const peerError = error instanceof PeerError ? error : null;
              this._emit({
                type: 'peer.failure',
                at: Date.now(),
                peer: { ...peer },
                method,
                path,
                attempt,
                latencyMs,
                ...(peerError?.code ? { code: peerError.code } : {}),
                ...(peerError?.statusCode ? { statusCode: peerError.statusCode } : {})
              });
            }

            releaseAdmission?.();
            releaseAdmission = null;
            this._active.delete(controller);
          };

          response.body.once('end', () => finalize('success'));
          response.body.once('error', error => {
            finalize(options.signal?.aborted || this._closed ? 'cancelled' : 'failure', error);
          });
          response.body.once('close', () => {
            if (!response.body.readableEnded) finalize('cancelled');
          });

          if (response.body.errored) {
            finalize(options.signal?.aborted || this._closed ? 'cancelled' : 'failure', response.body.errored);
          } else if (response.body.readableEnded) {
            finalize('success');
          } else if (response.body.destroyed) {
            finalize('cancelled');
          }

          handedOff = true;
          if (signal.aborted) {
            response.body.destroy(signal.reason instanceof Error ? signal.reason : undefined);
          }
          return new PeerStreamResponse(peer, response);
        } catch (error) {
          if (options.signal?.aborted || this._closed) {
            this._cancel(state);
            this._emit({ type: 'peer.cancelled', at: Date.now(), peer: { ...peer }, method, path, attempt });
            throw signal.reason || error;
          }

          const latencyMs = performance.now() - started;
          this._failure(state, latencyMs);
          this._concurrencyFeedback(latencyMs, true);
          const peerError = error instanceof PeerError ? error : null;
          this._emit({
            type: 'peer.failure',
            at: Date.now(),
            peer: { ...peer },
            method,
            path,
            attempt,
            latencyMs,
            ...(peerError?.code ? { code: peerError.code } : {}),
            ...(peerError?.statusCode ? { statusCode: peerError.statusCode } : {})
          });
          lastError = error;
          if (signal.aborted) throw signal.reason;
          if (count >= attempts) break;
        }
      }

      throw lastError || new PeerError('All peer circuits are open', 'NO_HEALTHY_PEERS');
    } finally {
      if (!handedOff) {
        releaseAdmission?.();
        clearTimeout(timer);
        this._active.delete(controller);
      }
    }
  }

  async json(path: string, options?: PeerOptions): Promise<unknown> {
    return (await this.request(path, options)).json();
  }

  async broadcast(path: string, options: PeerOptions & { concurrency?: number } = {}): Promise<Array<
    { peer: Peer; status: 'fulfilled'; value: PeerResponse } |
    { peer: Peer; status: 'rejected'; reason: unknown }
  >> {
    const peers = this.peers;
    const concurrency = options.concurrency ?? 8;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new TypeError('Broadcast concurrency must be 1..64');
    }
    const results = new Array<{ peer: Peer; status: 'fulfilled'; value: PeerResponse } | { peer: Peer; status: 'rejected'; reason: unknown }>(peers.length);
    let index = 0;

    await Promise.all(Array.from({ length: Math.min(concurrency, peers.length) }, async () => {
      while (index < peers.length) {
        const slot = index++;
        const peer = peers[slot]!;
        try {
          results[slot] = { peer, status: 'fulfilled', value: await this._request(path, { ...options, retries: 0 }, peer) };
        } catch (reason) {
          results[slot] = { peer, status: 'rejected', reason };
        }
      }
    }));
    return results;
  }

  async discover(provider: () => Peer[] | Promise<Peer[]>): Promise<Peer[]> {
    if (typeof provider !== 'function') throw new TypeError('Discovery provider must be a function');
    const peers = await provider();
    this.updatePeers(peers);
    return this.peers;
  }

  watch(provider: () => Peer[] | Promise<Peer[]>, { interval = 10000, onError = () => {} }: {
    interval?: number;
    onError?: (error: unknown) => void;
  } = {}): this {
    if (this._closed) throw new PeerError('Peer pool is closed', 'POOL_CLOSED');
    if (typeof provider !== 'function' || typeof onError !== 'function' || !Number.isSafeInteger(interval) || interval <= 0) {
      throw new TypeError('Invalid discovery watcher');
    }

    this.stopDiscovery();
    const watcher: DiscoveryWatcher = { timer: null, stopped: false };
    this._watch = watcher;
    const refresh = async (): Promise<void> => {
      if (watcher.stopped || this._closed) return;
      try {
        const peers = await provider();
        if (!watcher.stopped && !this._closed) this.updatePeers(peers);
      } catch (error) {
        try { onError(error); } catch {}
      }
      if (!watcher.stopped && !this._closed) {
        watcher.timer = setTimeout(refresh, interval);
        watcher.timer.unref();
      }
    };
    void refresh();
    return this;
  }

  stopDiscovery(): this {
    if (this._watch) {
      this._watch.stopped = true;
      if (this._watch.timer) clearTimeout(this._watch.timer);
      this._watch = null;
    }
    return this;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.stopDiscovery();
    for (const controller of this._active) controller.abort(new PeerError('Peer pool is closed', 'POOL_CLOSED'));
    this._http.destroy();
    this._https.destroy();
    for (const [agent, timer] of this._retiredHttpsAgents) {
      clearTimeout(timer);
      agent.destroy();
    }
    this._retiredHttpsAgents.clear();
  }
}
