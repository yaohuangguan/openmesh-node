import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export interface Peer { id: string; url: string; }

export type PeerSelectionStrategy = 'rendezvous' | 'p2c';

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
}

export interface TransportRequest {
  peer: Peer;
  url: URL;
  method: string;
  headers: Record<string, string | number>;
  body?: string | Buffer | Uint8Array;
  signal: AbortSignal;
  maxResponseBytes: number;
}

export interface TransportResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
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

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export class PeerError extends Error {
  code: string;
  peer?: Peer;
  statusCode?: number;

  constructor(message: string, code: string, options: ErrorOptions & { peer?: Peer; statusCode?: number } = {}) {
    super(message, options);
    this.name = 'PeerError';
    this.code = code;
    if (options.peer) this.peer = options.peer;
    if (options.statusCode) this.statusCode = options.statusCode;
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

function validatePeers(peers: Peer[]): Readonly<Peer>[] {
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

export class PeerPool {
  timeout: number;
  retries: number;
  failureThreshold: number;
  cooldown: number;
  maxResponseBytes: number;
  selection: PeerSelectionStrategy;
  private _http: http.Agent;
  private _https: https.Agent;
  private _transport: Transport;
  private _states = new Map<string, PeerState>();
  private _peers: Readonly<Peer>[] = [];
  private _cache = new Map<string, Readonly<Peer>[]>();
  private _active = new Set<AbortController>();
  private _counter = 0;
  private _closed = false;
  private _watch: DiscoveryWatcher | null = null;

  constructor(options: {
    peers?: Peer[];
    timeout?: number;
    retries?: number;
    failureThreshold?: number;
    cooldown?: number;
    maxResponseBytes?: number;
    maxSockets?: number;
    selection?: PeerSelectionStrategy;
    transport?: Transport;
  } = {}) {
    this.timeout = options.timeout ?? 2000;
    this.retries = options.retries ?? 1;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldown = options.cooldown ?? 10000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.selection = options.selection ?? 'p2c';

    for (const name of ['timeout', 'failureThreshold', 'cooldown', 'maxResponseBytes'] as const) {
      if (!Number.isSafeInteger(this[name]) || this[name] <= 0) throw new TypeError(name + ' must be a positive integer');
    }
    if (!Number.isSafeInteger(this.retries) || this.retries < 0) throw new TypeError('Retries must be a nonnegative integer');
    if (!['rendezvous', 'p2c'].includes(this.selection)) throw new TypeError('selection must be rendezvous or p2c');

    const maxSockets = options.maxSockets ?? 32;
    if (!Number.isSafeInteger(maxSockets) || maxSockets <= 0) throw new TypeError('maxSockets must be a positive integer');
    if (options.transport !== undefined && typeof options.transport !== 'function') throw new TypeError('Transport must be a function');

    this._http = new http.Agent({ keepAlive: true, maxSockets, maxTotalSockets: 256 });
    this._https = new https.Agent({ keepAlive: true, maxSockets, maxTotalSockets: 256 });
    this._transport = options.transport || (request => this._send(request));
    this.updatePeers(options.peers || []);
  }

  updatePeers(peers: Peer[]): this {
    if (this._closed) throw new PeerError('Peer pool is closed', 'POOL_CLOSED');
    const next = validatePeers(peers);
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

  private _candidates(key?: string): Peer[] {
    const ranked = this.rank(key ?? String(this._counter++));
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

  request(path: string, options: PeerOptions = {}): Promise<PeerResponse> {
    return this._request(path, options);
  }

  private async _request(path: string, options: PeerOptions = {}, onlyPeer: Peer | null = null): Promise<PeerResponse> {
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
    const candidates = onlyPeer ? [onlyPeer] : this._candidates(options.key);
    if (!candidates.length) throw new PeerError('No peers available', 'NO_PEERS');
    for (const peer of candidates) targetURL(peer, path);

    const controller = new AbortController();
    this._active.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new PeerError('Peer request deadline exceeded', 'DEADLINE_EXCEEDED')), timeout);
    let count = 0;
    let lastError: unknown;

    try {
      if (signal.aborted) throw signal.reason;
      for (const peer of candidates) {
        const state = this._claim(peer);
        if (!state) continue;
        count++;
        const started = performance.now();
        try {
          const response = await raceAbort(
            this._transport({ peer, url: targetURL(peer, path), method, headers, body, signal, maxResponseBytes: this.maxResponseBytes }),
            signal
          );
          if (response.statusCode >= 500) {
            throw new PeerError('Peer returned HTTP ' + response.statusCode, 'REMOTE_HTTP_ERROR', { peer, statusCode: response.statusCode });
          }
          this._success(state, performance.now() - started);
          return new PeerResponse(peer, response);
        } catch (error) {
          if (options.signal?.aborted || this._closed) {
            this._cancel(state);
            throw signal.reason || error;
          }
          this._failure(state, performance.now() - started);
          lastError = error;
          if (signal.aborted) throw signal.reason;
          if (count >= attempts) break;
        }
      }
      throw lastError || new PeerError('All peer circuits are open', 'NO_HEALTHY_PEERS');
    } finally {
      clearTimeout(timer);
      this._active.delete(controller);
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
  }
}
