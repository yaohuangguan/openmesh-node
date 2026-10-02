import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import { definePlugin } from '../core/app.js';
import type { Context } from '../core/context.js';
import { HttpError } from '../core/context.js';
import { jsonBody } from '../plugins/index.js';
import { PeerPool } from '../mesh/index.js';
import type { Peer, PeerOptions, PeerPoolOptions, PeerPoolStats, PeerResponse, PeerStats, PeerStreamOptions, PeerStreamResponse } from '../mesh/index.js';
import {
  RegistryAdapter,
  ConfigAdapter,
  ServiceRegistry,
  ConfigStore,
  name,
  freeze,
  type MaybePromise,
  type Instance,
  type Lease,
  type ServiceSnapshot,
  type ConfigSnapshot,
  type RegistrationInput
} from './store.js';

export {
  RegistryAdapter,
  ConfigAdapter,
  ServiceRegistry,
  ConfigStore
};
export type {
  MaybePromise,
  Instance,
  Lease,
  ServiceSnapshot,
  ConfigSnapshot
};

export const CONTROL_PROTOCOL = 'openmesh-control' as const;
export const CONTROL_PROTOCOL_VERSION = 1;

export type ControlScope =
  | 'meta:read'
  | 'services:read'
  | 'services:write'
  | 'config:read'
  | 'config:write';

export interface ControlCredential {
  token: string;
  scopes: readonly ControlScope[];
  services?: readonly string[];
  namespaces?: readonly string[];
}

interface ResolvedControlCredential {
  digest: Buffer;
  scopes: ReadonlySet<ControlScope>;
  services: ReadonlySet<string> | null;
  namespaces: ReadonlySet<string> | null;
}

export interface ControlPlaneInfo {
  protocol: typeof CONTROL_PROTOCOL;
  version: number;
  capabilities: {
    serviceWatch: boolean;
    configWatch: boolean;
    membershipRevision: boolean;
    configCAS: boolean;
    scopedCredentials?: boolean;
  };
}

export interface RegistryAdapterLike {
  register(service: string, id: string, options: RegistrationInput): MaybePromise<Lease>;
  renew(service: string, id: string, leaseId: string): MaybePromise<Lease>;
  deregister(service: string, id: string, leaseId: string): MaybePromise<void>;
  list(service: string): MaybePromise<Instance[]>;
  snapshot?(service: string): MaybePromise<ServiceSnapshot>;
  subscribe?(service: string, listener: () => void): MaybePromise<() => void>;
  close?(): MaybePromise<void>;
}

export interface ConfigAdapterLike {
  snapshot(namespace: string): MaybePromise<ConfigSnapshot>;
  replace(namespace: string, values: Record<string, unknown>, expectedRevision: number, expectedEpoch: string): MaybePromise<ConfigSnapshot>;
  subscribe?(namespace: string, listener: (snapshot?: ConfigSnapshot) => void): MaybePromise<() => void>;
  close?(): MaybePromise<void>;
}

export interface RegistrationOptions {
  id: string;
  url: string;
  ttl?: number;
  metadata?: Record<string, unknown>;
  onError?: (error: Error) => void;
}

export interface WatchOptions {
  interval?: number;
  reconnectDelay?: number;
  transport?: 'stream' | 'poll';
  validate?: (values: Readonly<Record<string, unknown>>) => unknown;
  onUpdate?: (current: ConfigSnapshot, previous: ConfigSnapshot) => void;
  onError?: (error: Error) => void;
}

export interface ServiceWatchOptions {
  interval?: number;
  reconnectDelay?: number;
  transport?: 'stream' | 'poll';
  onUpdate?: (current: readonly Instance[], previous: readonly Instance[]) => void;
  onError?: (error: Error) => void;
}

export type ServicePoolOptions = Omit<PeerPoolOptions, 'peers'> & {
  watch?: ServiceWatchOptions;
};

function validateToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{16,1024}$/.test(token)) {
    throw new TypeError('Control-plane token must contain 16..1024 printable ASCII characters');
  }
}

const CONTROL_CREDENTIAL = Symbol('openmesh.controlCredential');

const CONTROL_SCOPES = new Set<ControlScope>([
  'meta:read',
  'services:read',
  'services:write',
  'config:read',
  'config:write'
]);

function controlResourceSet(values: readonly string[] | undefined, label: string): ReadonlySet<string> | null {
  if (values === undefined) return null;
  if (!Array.isArray(values)) throw new TypeError(label + ' must be an array');
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
      throw new TypeError('Invalid ' + label + ' entry');
    }
    result.add(value);
  }
  return result;
}

function resolveControlCredentials(
  token: string | undefined,
  credentials: readonly ControlCredential[] | undefined
): ResolvedControlCredential[] {
  if ((token === undefined) === (credentials === undefined)) {
    throw new TypeError('Control plane requires exactly one of token or credentials');
  }

  if (token !== undefined) {
    validateToken(token);
    return [{
      digest: createHash('sha256').update(token).digest(),
      scopes: CONTROL_SCOPES,
      services: null,
      namespaces: null
    }];
  }

  if (!Array.isArray(credentials) || !credentials.length) {
    throw new TypeError('Control-plane credentials must be a nonempty array');
  }

  const seen = new Set<string>();
  return credentials.map((credential, index) => {
    if (!credential || typeof credential !== 'object') throw new TypeError('Invalid control-plane credential at index ' + index);
    validateToken(credential.token);
    if (!Array.isArray(credential.scopes) || !credential.scopes.length) {
      throw new TypeError('Control-plane credential scopes must be a nonempty array');
    }
    const scopes = new Set<ControlScope>();
    for (const scope of credential.scopes) {
      if (!CONTROL_SCOPES.has(scope)) throw new TypeError('Unknown control-plane scope: ' + scope);
      scopes.add(scope);
    }
    const digest = createHash('sha256').update(credential.token).digest();
    const key = digest.toString('hex');
    if (seen.has(key)) throw new TypeError('Duplicate control-plane credential token');
    seen.add(key);
    return {
      digest,
      scopes,
      services: controlResourceSet(credential.services, 'services'),
      namespaces: controlResourceSet(credential.namespaces, 'namespaces')
    };
  });
}

function authenticateControlCredential(
  supplied: unknown,
  credentials: readonly ResolvedControlCredential[]
): ResolvedControlCredential | null {
  const value = typeof supplied === 'string' && supplied.length <= 4096 && supplied.startsWith('Bearer ')
    ? supplied.slice(7)
    : '';
  const digest = createHash('sha256').update(value).digest();
  let matched: ResolvedControlCredential | null = null;
  for (const credential of credentials) {
    if (timingSafeEqual(digest, credential.digest)) matched = credential;
  }
  return matched;
}

function requireControlScope(
  ctx: Context,
  scope: ControlScope,
  resourceType?: 'service' | 'namespace',
  resource?: string
): void {
  const credential = (ctx.state as Record<PropertyKey, unknown>)[CONTROL_CREDENTIAL] as ResolvedControlCredential | undefined;
  if (!credential) ctx.throw(401, 'Unauthorized');
  if (!credential.scopes.has(scope)) ctx.throw(403, 'Forbidden');
  if (resourceType === 'service' && resource && credential.services && !credential.services.has(resource)) ctx.throw(403, 'Forbidden');
  if (resourceType === 'namespace' && resource && credential.namespaces && !credential.namespaces.has(resource)) ctx.throw(403, 'Forbidden');
}

function validateAdapter<T extends object>(value: T, label: string, methods: string[]): T {
  if (!value || methods.some(method => typeof (value as Record<string, unknown>)[method] !== 'function')) {
    throw new TypeError(label + ' must implement ' + methods.join(', '));
  }
  return value;
}

function closeAdapter(adapter: { close?: () => MaybePromise<void> }): MaybePromise<void> | undefined {
  return adapter.close?.();
}

async function serviceSnapshot(adapter: RegistryAdapterLike, service: string): Promise<ServiceSnapshot> {
  const value = typeof adapter.snapshot === 'function'
    ? await adapter.snapshot(service)
    : { service, instances: await adapter.list(service) };
  if (!value || !Array.isArray(value.instances)) throw new TypeError('Registry snapshot must contain an instances array');
  return value;
}

function watchEventId(eventName: 'services' | 'config', value: unknown): string | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (eventName === 'services' && Number.isSafeInteger(record?.revision) && (record!.revision as number) >= 0) {
    return String(record!.revision);
  }
  if (
    eventName === 'config' &&
    typeof record?.epoch === 'string' &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) >= 0
  ) {
    return record.epoch + ':' + record.revision;
  }
  return null;
}

async function streamWatch(
  ctx: Context,
  eventName: 'services' | 'config',
  snapshot: () => MaybePromise<unknown>,
  subscribe: ((listener: () => void) => MaybePromise<() => void>) | null,
  streams: Set<ServerResponse>
): Promise<void> {
  if (typeof subscribe !== 'function') {
    throw new HttpError(501, 'This control-plane adapter does not support streaming watches');
  }

  const res = ctx.res;
  streams.add(res);
  ctx.status = 200;
  ctx.set({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.flushHeaders?.();

  let active = true;
  let ready = false;
  let pending = false;
  let queue: Promise<void> = Promise.resolve();
  const suppliedLastId = ctx.get('last-event-id');
  let lastSentId = typeof suppliedLastId === 'string' ? suppliedLastId : '';

  const send = (): Promise<void> => {
    queue = queue.then(async () => {
      if (!active || res.destroyed || res.writableEnded) return;
      const value = await snapshot();
      const eventId = watchEventId(eventName, value);
      if (eventId && eventId === lastSentId) return;
      res.write('event: ' + eventName + '\n');
      if (eventId) res.write('id: ' + eventId + '\n');
      res.write('data: ' + JSON.stringify(value) + '\n\n');
      if (eventId) lastSentId = eventId;
    }).catch(error => {
      if (active && !res.destroyed) res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    return queue;
  };

  const changed = (): void => {
    if (!ready) { pending = true; return; }
    void send();
  };

  const unsubscribe = await subscribe(changed);
  if (typeof unsubscribe !== 'function') throw new TypeError('Adapter subscribe() must return an unsubscribe function');

  await send();
  ready = true;
  if (pending) void send();

  const heartbeat = setInterval(() => {
    if (active && !res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 15000);
  heartbeat.unref();

  await new Promise<void>(resolve => {
    const finish = (): void => {
      if (!active) return;
      active = false;
      clearInterval(heartbeat);
      try { unsubscribe(); } catch {}
      streams.delete(res);
      resolve();
    };
    ctx.req.once('aborted', finish);
    res.once('close', finish);
  });
}

export function controlPlane({ token, credentials, registry, config, prefix = '/_mesh' }: {
  token?: string;
  credentials?: readonly ControlCredential[];
  registry?: RegistryAdapterLike;
  config?: ConfigAdapterLike;
  prefix?: string;
}): ReturnType<typeof definePlugin> {
  const access = resolveControlCredentials(token, credentials);
  const ownsRegistry = registry === undefined;
  const ownsConfig = config === undefined;
  const activeRegistry = validateAdapter<RegistryAdapterLike>(
    registry || new ServiceRegistry(),
    'registry adapter',
    ['register', 'renew', 'deregister', 'list']
  );
  const activeConfig = validateAdapter<ConfigAdapterLike>(
    config || new ConfigStore(),
    'config adapter',
    ['snapshot', 'replace']
  );
  const streams = new Set<ServerResponse>();

  return definePlugin(async app => {
    app.onShutdown(() => {
      for (const res of [...streams]) if (!res.writableEnded && !res.destroyed) res.end();
    });
    if (ownsRegistry) app.onClose(() => closeAdapter(activeRegistry));
    if (ownsConfig) app.onClose(() => closeAdapter(activeConfig));

    app.register(async scope => {
      scope.use(async (ctx, next) => {
        const credential = authenticateControlCredential(ctx.get('authorization'), access);
        if (!credential) ctx.throw(401, 'Unauthorized');
        (ctx.state as Record<PropertyKey, unknown>)[CONTROL_CREDENTIAL] = credential;
        return next();
      });
      scope.use(jsonBody({ limit: 300000 }));

      scope.get('/meta', ctx => {
        requireControlScope(ctx, 'meta:read');
        return ({
        protocol: CONTROL_PROTOCOL,
        version: CONTROL_PROTOCOL_VERSION,
        capabilities: {
          serviceWatch: typeof activeRegistry.subscribe === 'function',
          configWatch: typeof activeConfig.subscribe === 'function',
          membershipRevision: typeof activeRegistry.snapshot === 'function',
          configCAS: true,
          scopedCredentials: true
        }
      } satisfies ControlPlaneInfo);
      });

      const path = '/services/:service/instances/:id';
      scope.post(path, async ctx => {
        requireControlScope(ctx, 'services:write', 'service', ctx.params.service!);
        ctx.status = 201;
        return activeRegistry.register(
          ctx.params.service!,
          ctx.params.id!,
          (ctx.requestBody || {}) as RegistrationInput
        );
      });
      scope.put(path + '/lease', ctx => {
        requireControlScope(ctx, 'services:write', 'service', ctx.params.service!);
        const body = (ctx.requestBody || {}) as Record<string, unknown>;
        return activeRegistry.renew(ctx.params.service!, ctx.params.id!, String(body.leaseId || ''));
      });
      scope.delete(path, async ctx => {
        requireControlScope(ctx, 'services:write', 'service', ctx.params.service!);
        const body = (ctx.requestBody || {}) as Record<string, unknown>;
        await activeRegistry.deregister(ctx.params.service!, ctx.params.id!, String(body.leaseId || ''));
        ctx.status = 204;
      });

      scope.get('/services/:service', async ctx => {
        requireControlScope(ctx, 'services:read', 'service', ctx.params.service!);
        const cursorValue = ctx.query.cursor;
        const cursor = Array.isArray(cursorValue) ? cursorValue[0] : cursorValue;
        if (cursor !== undefined) name(cursor);
        const snapshot = await serviceSnapshot(activeRegistry, ctx.params.service!);
        const filtered = snapshot.instances.filter(instance => !cursor || instance.id > cursor);
        const instances = filtered.slice(0, 100);
        return {
          service: ctx.params.service,
          revision: Number.isSafeInteger(snapshot.revision) ? snapshot.revision : undefined,
          instances,
          nextCursor: filtered.length > 100 ? instances.at(-1)!.id : null
        };
      });

      scope.get('/watch/services/:service', ctx => {
        name(ctx.params.service!);
        requireControlScope(ctx, 'services:read', 'service', ctx.params.service!);
        return streamWatch(
          ctx,
          'services',
          () => serviceSnapshot(activeRegistry, ctx.params.service!),
          typeof activeRegistry.subscribe === 'function'
            ? listener => activeRegistry.subscribe!(ctx.params.service!, listener)
            : null,
          streams
        );
      });

      scope.get('/config/:namespace', ctx => {
        requireControlScope(ctx, 'config:read', 'namespace', ctx.params.namespace!);
        return activeConfig.snapshot(ctx.params.namespace!);
      });
      scope.put('/config/:namespace', ctx => {
        requireControlScope(ctx, 'config:write', 'namespace', ctx.params.namespace!);
        const body = (ctx.requestBody || {}) as Record<string, unknown>;
        return activeConfig.replace(
          ctx.params.namespace!,
          (body.values || {}) as Record<string, unknown>,
          body.expectedRevision as number,
          body.expectedEpoch as string
        );
      });
      scope.get('/watch/config/:namespace', ctx => {
        name(ctx.params.namespace!);
        requireControlScope(ctx, 'config:read', 'namespace', ctx.params.namespace!);
        return streamWatch(
          ctx,
          'config',
          () => activeConfig.snapshot(ctx.params.namespace!),
          typeof activeConfig.subscribe === 'function'
            ? listener => activeConfig.subscribe!(ctx.params.namespace!, listener)
            : null,
          streams
        );
      });
    }, { prefix });
  });
}

interface InternalRegistrationOptions extends RegistrationInput {
  onError?: (error: Error) => void;
}

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ? (error as { statusCode: number }).statusCode
    : undefined;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class Registration {
  client: ControlClient;
  record: Lease;
  options: InternalRegistrationOptions;
  lastError: Error | null = null;
  private _validUntil: number;
  private _stopped = false;
  private _lost = false;
  private _timer: NodeJS.Timeout | null = null;
  private _pending: Promise<void> | null = null;
  private _abort = new AbortController();
  private _stopPromise: Promise<void> | null = null;

  constructor(client: ControlClient, record: Lease, options: InternalRegistrationOptions, requestedAt = performance.now()) {
    this.client = client;
    this.record = freeze(record);
    this.options = options;
    this._validUntil = requestedAt + record.ttl;
    this._schedule();
  }

  get healthy(): boolean {
    return !this._stopped && !this._lost && this._validUntil > performance.now();
  }

  private _schedule(): void {
    if (this._timer) clearTimeout(this._timer);
    if (!this._stopped && !this._lost) {
      this._timer = setTimeout(() => { this._pending = this._renew(); }, Math.max(100, Math.floor(this.record.ttl / 3)));
      this._timer.unref();
    }
  }

  async _renew(): Promise<void> {
    const requestedAt = performance.now();
    try {
      let record: Lease;
      try {
        record = await this.client._call<Lease>(
          'PUT',
          this.client._instancePath(this.record.service, this.record.id) + '/lease',
          { leaseId: this.record.leaseId },
          this._abort.signal
        );
      } catch (error) {
        if (httpStatus(error) !== 404 || this._stopped) throw error;
        record = await this.client._call<Lease>(
          'POST',
          this.client._instancePath(this.record.service, this.record.id),
          this.options,
          this._abort.signal
        );
      }
      if (!this._stopped) {
        this.record = freeze(record);
        this._validUntil = requestedAt + record.ttl;
        this.lastError = null;
      }
    } catch (error) {
      if (!this._stopped) {
        const normalized = normalizeError(error);
        this.lastError = normalized;
        if (httpStatus(error) === 409) this._lost = true;
        try { this.options.onError?.(normalized); } catch {}
      }
    } finally {
      this._schedule();
    }
  }

  async stop(): Promise<void> {
    if (this._stopPromise) return this._stopPromise;
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._abort.abort();

    this._stopPromise = (async () => {
      await this._pending;
      try {
        await this.client._call(
          'DELETE',
          this.client._instancePath(this.record.service, this.record.id),
          { leaseId: this.record.leaseId }
        );
      } catch (error) {
        if (![404, 409].includes(httpStatus(error) || 0)) throw error;
      } finally {
        this.client._registrations.delete(this);
      }
    })();
    return this._stopPromise;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, ms);
    timer.unref();
    function done(): void {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function parseSSE(
  response: Response,
  onData: (value: unknown, eventId: string | null) => void | Promise<void>
): Promise<void> {
  if (!response.ok) {
    let message = 'Control-plane watch failed';
    try {
      const data = await response.json() as Record<string, unknown>;
      if (typeof data?.error === 'string') message = data.error;
    } catch {}
    throw new HttpError(response.status, message);
  }
  if (!response.body) throw new Error('Control-plane watch returned no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = block.split('\n');
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      const idLine = lines.find(line => line.startsWith('id:'));
      const eventId = idLine ? idLine.slice(3).trimStart() : null;
      if (data) await onData(JSON.parse(data) as unknown, eventId);
    }
  }
}

export class ConfigWatcher {
  client: ControlClient;
  snapshot: ConfigSnapshot;
  lastError: Error | null = null;
  private _interval: number;
  private _reconnectDelay: number;
  private _transport: 'stream' | 'poll';
  private _onUpdate: (current: ConfigSnapshot, previous: ConfigSnapshot) => void;
  private _onError: (error: Error) => void;
  private _validate: (values: Readonly<Record<string, unknown>>) => unknown;
  private _stopped = false;
  private _abort = new AbortController();
  private _timer: NodeJS.Timeout | null = null;
  private _lastEventId: string;
  private _task?: Promise<void>;

  constructor(client: ControlClient, snapshot: ConfigSnapshot, {
    interval = 1000,
    reconnectDelay = 250,
    transport = 'stream',
    onUpdate = () => {},
    onError = () => {},
    validate = () => {}
  }: WatchOptions = {}) {
    if (
      !Number.isSafeInteger(interval) || interval < 50 ||
      !Number.isSafeInteger(reconnectDelay) || reconnectDelay < 50 ||
      !['stream', 'poll'].includes(transport) ||
      typeof onUpdate !== 'function' || typeof onError !== 'function' || typeof validate !== 'function'
    ) throw new TypeError('Invalid configuration watcher');

    this.client = client;
    this.snapshot = freeze(snapshot);
    this._interval = interval;
    this._reconnectDelay = reconnectDelay;
    this._transport = transport;
    this._onUpdate = onUpdate;
    this._onError = onError;
    this._validate = validate;
    this._lastEventId = snapshot.epoch + ':' + snapshot.revision;
    this._check(snapshot.values);
    if (transport === 'stream') this._task = this._stream();
    else this._schedule();
  }

  private _check(values: Readonly<Record<string, unknown>>): void {
    const result = this._validate(values);
    if (result && typeof (result as PromiseLike<void>).then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new TypeError('Configuration validation must be synchronous');
    }
  }

  get(key: string, fallback?: unknown): unknown {
    return Object.hasOwn(this.snapshot.values, key) ? this.snapshot.values[key] : fallback;
  }

  private _apply(next: ConfigSnapshot): void {
    if (this._stopped || (next.revision === this.snapshot.revision && next.epoch === this.snapshot.epoch)) return;
    this._check(next.values);
    const previous = this.snapshot;
    this.snapshot = freeze(next);
    this.lastError = null;
    this._onUpdate(this.snapshot, previous);
  }

  private _report(error: unknown): void {
    if (this._stopped) return;
    const normalized = normalizeError(error);
    this.lastError = normalized;
    try { this._onError(normalized); } catch {}
  }

  private _schedule(): void {
    if (this._timer) clearTimeout(this._timer);
    if (!this._stopped) {
      this._timer = setTimeout(() => void this._refresh(), this._interval);
      this._timer.unref();
    }
  }

  async _refresh(): Promise<void> {
    try {
      this._apply(await this.client.getConfig(this.snapshot.namespace, { signal: this._abort.signal }));
    } catch (error) {
      this._report(error);
    } finally {
      if (this._transport === 'poll') this._schedule();
    }
  }

  private async _stream(): Promise<void> {
    while (!this._stopped) {
      try {
        await this.client._watch(
          '/watch/config/' + name(this.snapshot.namespace),
          this._abort.signal,
          (value, eventId) => {
            if (eventId) this._lastEventId = eventId;
            this._apply(value as ConfigSnapshot);
          },
          this._lastEventId
        );
        if (!this._stopped) throw new Error('Control-plane config watch ended');
      } catch (error) {
        if (this._stopped || this._abort.signal.aborted) return;
        this._report(error);
        if ([404, 501].includes(httpStatus(error) || 0)) {
          this._transport = 'poll';
          this._schedule();
          return;
        }
        try { await delay(this._reconnectDelay, this._abort.signal); } catch { return; }
      }
    }
  }

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._abort.abort();
    this.client._watchers.delete(this);
  }
}

function sameInstances(a: readonly Instance[], b: readonly Instance[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i]!.id !== b[i]!.id ||
      a[i]!.url !== b[i]!.url ||
      a[i]!.ttl !== b[i]!.ttl ||
      JSON.stringify(a[i]!.metadata) !== JSON.stringify(b[i]!.metadata)
    ) return false;
  }
  return true;
}

export class ServiceWatcher {
  client: ControlClient;
  service: string;
  instances: readonly Instance[];
  lastError: Error | null = null;
  private _interval: number;
  private _reconnectDelay: number;
  private _transport: 'stream' | 'poll';
  private _onUpdate: (current: readonly Instance[], previous: readonly Instance[]) => void;
  private _onError: (error: Error) => void;
  private _stopped = false;
  private _abort = new AbortController();
  private _timer: NodeJS.Timeout | null = null;
  private _lastEventId: string | null = null;
  private _task?: Promise<void>;

  constructor(client: ControlClient, service: string, instances: Instance[], {
    interval = 1000,
    reconnectDelay = 250,
    transport = 'stream',
    onUpdate = () => {},
    onError = () => {}
  }: ServiceWatchOptions = {}) {
    if (
      !Number.isSafeInteger(interval) || interval < 50 ||
      !Number.isSafeInteger(reconnectDelay) || reconnectDelay < 50 ||
      !['stream', 'poll'].includes(transport) ||
      typeof onUpdate !== 'function' || typeof onError !== 'function'
    ) throw new TypeError('Invalid service watcher');

    this.client = client;
    this.service = name(service);
    this.instances = freeze(instances.map(instance => ({ ...instance })));
    this._interval = interval;
    this._reconnectDelay = reconnectDelay;
    this._transport = transport;
    this._onUpdate = onUpdate;
    this._onError = onError;
    if (transport === 'stream') this._task = this._stream();
    else this._schedule();
  }

  private _apply(value: unknown): void {
    const next = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && 'instances' in value
        ? (value as { instances?: unknown }).instances
        : undefined;
    if (!Array.isArray(next)) throw new TypeError('Service watch payload must contain instances');

    const frozen = freeze((next as Instance[]).map(instance => ({ ...instance })));
    if (this._stopped || sameInstances(this.instances, frozen)) return;
    const previous = this.instances;
    this.instances = frozen;
    this.lastError = null;
    this._onUpdate(this.instances, previous);
  }

  private _report(error: unknown): void {
    if (this._stopped) return;
    const normalized = normalizeError(error);
    this.lastError = normalized;
    try { this._onError(normalized); } catch {}
  }

  private _schedule(): void {
    if (this._timer) clearTimeout(this._timer);
    if (!this._stopped) {
      this._timer = setTimeout(() => void this._refresh(), this._interval);
      this._timer.unref();
    }
  }

  async _refresh(): Promise<void> {
    try { this._apply(await this.client.discover(this.service, { signal: this._abort.signal })); }
    catch (error) { this._report(error); }
    finally { if (this._transport === 'poll') this._schedule(); }
  }

  private async _stream(): Promise<void> {
    while (!this._stopped) {
      try {
        await this.client._watch(
          '/watch/services/' + this.service,
          this._abort.signal,
          (value, eventId) => {
            if (eventId) this._lastEventId = eventId;
            this._apply(value);
          },
          this._lastEventId
        );
        if (!this._stopped) throw new Error('Control-plane service watch ended');
      } catch (error) {
        if (this._stopped || this._abort.signal.aborted) return;
        this._report(error);
        if ([404, 501].includes(httpStatus(error) || 0)) {
          this._transport = 'poll';
          this._schedule();
          return;
        }
        try { await delay(this._reconnectDelay, this._abort.signal); } catch { return; }
      }
    }
  }

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._abort.abort();
    this.client._serviceWatchers.delete(this);
  }
}

export class ControlClient {
  _pool: PeerPool;
  private _url: string;
  private _token: string;
  _registrations = new Set<Registration>();
  _watchers = new Set<ConfigWatcher>();
  _serviceWatchers = new Set<ServiceWatcher>();
  _servicePools = new Set<ServicePool>();
  private _info: Readonly<ControlPlaneInfo> | null = null;
  private _closing = false;
  private _closePromise: Promise<void> | null = null;

  constructor({ url, token, timeout = 2000 }: { url: string; token: string; timeout?: number }) {
    validateToken(token);
    this._pool = new PeerPool({
      peers: [{ id: 'control-plane', url }],
      timeout,
      retries: 0,
      cooldown: 1000,
      maxResponseBytes: 2 * 1024 * 1024
    });
    this._url = url.replace(/\/$/, '');
    this._token = token;
  }

  async info({ refresh = false, signal }: {
    refresh?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<Readonly<ControlPlaneInfo>> {
    if (this._closing) throw new Error('Control client is closing');
    if (this._info && !refresh) return this._info;

    const info = await this._call<ControlPlaneInfo>('GET', '/meta', undefined, signal);
    if (
      !info ||
      info.protocol !== CONTROL_PROTOCOL ||
      info.version !== CONTROL_PROTOCOL_VERSION ||
      !info.capabilities ||
      typeof info.capabilities.serviceWatch !== 'boolean' ||
      typeof info.capabilities.configWatch !== 'boolean' ||
      typeof info.capabilities.membershipRevision !== 'boolean' ||
      typeof info.capabilities.configCAS !== 'boolean'
    ) {
      throw new Error('Unsupported OpenMesh control-plane protocol');
    }

    this._info = Object.freeze({
      protocol: info.protocol,
      version: info.version,
      capabilities: Object.freeze({ ...info.capabilities })
    });
    return this._info;
  }

  _instancePath(service: string, id: string): string {
    return '/services/' + name(service) + '/instances/' + name(id);
  }

  async _call<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this._pool.request(path, {
      method,
      body,
      signal,
      headers: { authorization: 'Bearer ' + this._token }
    });
    if (response.statusCode >= 400) {
      const data = response.json() as Record<string, unknown>;
      throw new HttpError(response.statusCode, typeof data.error === 'string' ? data.error : 'Control-plane request failed');
    }
    return (response.statusCode === 204 ? undefined : response.json()) as T;
  }

  async _watch(
    path: string,
    signal: AbortSignal,
    onData: (value: unknown, eventId: string | null) => void | Promise<void>,
    lastEventId?: string | null
  ): Promise<void> {
    const headers: Record<string, string> = {
      authorization: 'Bearer ' + this._token,
      accept: 'text/event-stream'
    };
    if (lastEventId) headers['last-event-id'] = lastEventId;
    const response = await fetch(this._url + path, { headers, signal, redirect: 'error' });
    return parseSSE(response, onData);
  }

  async register(service: string, { id, url, ttl = 30000, metadata = {}, onError }: RegistrationOptions): Promise<Registration> {
    if (this._closing) throw new Error('Control client is closing');
    if (onError !== undefined && typeof onError !== 'function') throw new TypeError('onError must be a function');

    const options: InternalRegistrationOptions = { url, ttl, metadata, onError };
    const requestedAt = performance.now();
    const record = await this._call<Lease>('POST', this._instancePath(service, id), options);
    if (this._closing) {
      await this._call('DELETE', this._instancePath(service, id), { leaseId: record.leaseId });
      throw new Error('Control client is closing');
    }

    const registration = new Registration(this, record, { ...options, metadata: record.metadata }, requestedAt);
    this._registrations.add(registration);
    return registration;
  }

  async discover(service: string, { signal }: { signal?: AbortSignal } = {}): Promise<Instance[]> {
    service = name(service);
    const deadline = AbortSignal.timeout(this._pool.timeout);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

    for (let attempt = 0; attempt < 3; attempt++) {
      const instances = new Map<string, Instance>();
      let cursor: string | null = null;
      let revision: number | undefined;
      let changed = false;

      for (let page = 0; page < 100; page++) {
        type DiscoveryPage = { instances: Instance[]; nextCursor: string | null; revision?: number };
        const result: DiscoveryPage = await this._call<DiscoveryPage>(
          'GET',
          '/services/' + service + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
          undefined,
          bounded
        );

        if (Number.isSafeInteger(result.revision)) {
          if (revision === undefined) revision = result.revision;
          else if (revision !== result.revision) { changed = true; break; }
        }

        for (const instance of result.instances) instances.set(instance.id, instance);
        if (!result.nextCursor) return [...instances.values()];
        if (cursor && result.nextCursor <= cursor) throw new Error('Discovery cursor did not advance');
        cursor = result.nextCursor;
      }

      if (!changed) throw new Error('Discovery exceeded 100 pages; narrow the service membership');
    }

    throw new Error('Service membership changed repeatedly during discovery');
  }

  getConfig(namespace: string, { signal }: { signal?: AbortSignal } = {}): Promise<ConfigSnapshot> {
    return this._call('GET', '/config/' + name(namespace), undefined, signal);
  }

  setConfig(namespace: string, values: Record<string, unknown>, {
    expectedRevision,
    expectedEpoch,
    signal
  }: {
    expectedRevision: number;
    expectedEpoch: string;
    signal?: AbortSignal;
  }): Promise<ConfigSnapshot> {
    return this._call(
      'PUT',
      '/config/' + name(namespace),
      { values, expectedRevision, expectedEpoch },
      signal
    );
  }

  async watchConfig(namespace: string, options: WatchOptions = {}): Promise<ConfigWatcher> {
    if (this._closing) throw new Error('Control client is closing');
    const snapshot = await this.getConfig(namespace);
    if (this._closing) throw new Error('Control client is closing');
    const watcher = new ConfigWatcher(this, snapshot, options);
    this._watchers.add(watcher);
    return watcher;
  }

  async watchService(service: string, options: ServiceWatchOptions = {}): Promise<ServiceWatcher> {
    if (this._closing) throw new Error('Control client is closing');
    const instances = await this.discover(service);
    if (this._closing) throw new Error('Control client is closing');
    const watcher = new ServiceWatcher(this, service, instances, options);
    this._serviceWatchers.add(watcher);
    return watcher;
  }

  async service(service: string, options: ServicePoolOptions = {}): Promise<ServicePool> {
    if (this._closing) throw new Error('Control client is closing');
    const pool = await ServicePool.create(this, service, options);
    if (this._closing) {
      pool.close();
      throw new Error('Control client is closing');
    }
    this._servicePools.add(pool);
    return pool;
  }

  close(): Promise<void> {
    if (!this._closePromise) {
      this._closing = true;
      for (const watcher of this._watchers) watcher.stop();
      for (const service of [...this._servicePools]) service.close();
      for (const watcher of this._serviceWatchers) watcher.stop();
      this._closePromise = Promise.allSettled([...this._registrations].map(registration => registration.stop())).then(results => {
        this._pool.close();
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Some registrations could not be removed; their leases will expire');
      });
    }
    return this._closePromise;
  }
}

export class ServicePool {
  readonly client: ControlClient;
  readonly service: string;
  readonly pool: PeerPool;
  readonly watcher: ServiceWatcher;
  private _closed = false;

  private constructor(client: ControlClient, service: string, pool: PeerPool, watcher: ServiceWatcher) {
    this.client = client;
    this.service = service;
    this.pool = pool;
    this.watcher = watcher;
  }

  static async create(client: ControlClient, service: string, options: ServicePoolOptions = {}): Promise<ServicePool> {
    if (!(client instanceof ControlClient)) throw new TypeError('ServicePool needs a ControlClient');
    const serviceName = name(service);
    const { watch = {}, ...poolOptions } = options;
    const userUpdate = watch.onUpdate;
    let pool: PeerPool | null = null;

    const watcher = await client.watchService(serviceName, {
      ...watch,
      onUpdate(current, previous) {
        pool?.updatePeers(current.map(instance => ({ id: instance.id, url: instance.url })));
        if (userUpdate) userUpdate(current, previous);
      }
    });

    try {
      pool = new PeerPool({
        ...poolOptions,
        peers: watcher.instances.map(instance => ({ id: instance.id, url: instance.url }))
      });
      return new ServicePool(client, serviceName, pool, watcher);
    } catch (error) {
      watcher.stop();
      throw error;
    }
  }

  get peers(): Peer[] {
    return this.pool.peers;
  }

  request(path: string, options?: PeerOptions): Promise<PeerResponse> {
    return this.pool.request(path, options);
  }

  requestStream(path: string, options?: PeerStreamOptions): Promise<PeerStreamResponse> {
    return this.pool.requestStream(path, options);
  }

  json(path: string, options?: PeerOptions): Promise<unknown> {
    return this.pool.json(path, options);
  }

  stats(): PeerStats[] {
    return this.pool.stats();
  }

  poolStats(): PeerPoolStats {
    return this.pool.poolStats();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.client._servicePools.delete(this);
    this.watcher.stop();
    this.pool.close();
  }
}

export function serviceRegistration({ client, service, id, url, ttl = 30000, metadata = {}, onError }: Omit<RegistrationOptions, 'url'> & {
  client: ControlClient;
  service: string;
  url: string | ((address: AddressInfo | string | null) => string);
}): ReturnType<typeof definePlugin> {
  if (!(client instanceof ControlClient) || (typeof url !== 'string' && typeof url !== 'function')) {
    throw new TypeError('Service registration needs a ControlClient and an advertised URL or address callback');
  }
  name(service);
  name(id);

  return definePlugin(app => {
    app.decorate('registration', null);
    app.onListen(async (scope, address) => {
      scope.registration = await client.register(service, {
        id,
        url: typeof url === 'function' ? url(address) : url,
        ttl,
        metadata,
        onError
      });
    });
    app.onShutdown(() => app.registration?.stop());
  }, { name: 'service-registration', global: true });
}

declare module '../core/app.js' {
  interface OpenMesh {
    registration?: Registration | null;
  }
}
