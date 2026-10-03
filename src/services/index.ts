import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import { definePlugin } from '../core/app.js';
import type { OpenMesh } from '../core/app.js';
import type { Context } from '../core/context.js';
import { HttpError } from '../core/context.js';
import { jsonBody, currentRequestContext } from '../plugins/index.js';
import { PeerPool, PeerError, PeerResponse } from '../mesh/index.js';
import type { Peer, PeerOptions, PeerPoolOptions, PeerPoolStats, PeerStats, PeerStreamOptions, PeerStreamResponse } from '../mesh/index.js';
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

export type MeshMetadataValue = string | number | boolean;
export type MeshMetadataMatch = Readonly<Record<string, MeshMetadataValue>>;

export interface MeshTrafficTarget {
  name?: string;
  match: MeshMetadataMatch;
  weight: number;
}

export interface MeshTrafficWhen {
  headers?: Readonly<Record<string, string>>;
}

export interface MeshTrafficRoute {
  name?: string;
  when: MeshTrafficWhen;
  target: MeshMetadataMatch;
}

export interface MeshTrafficPreference {
  name?: string;
  match: MeshMetadataMatch;
}

export interface MeshTrafficPolicy {
  routes?: readonly MeshTrafficRoute[];
  split?: readonly MeshTrafficTarget[];
  prefer?: readonly MeshTrafficPreference[];
  fallback?: 'all' | 'error';
}

export interface MeshTrafficConfigOptions {
  namespace: string;
  key?: string;
  required?: boolean;
  watch?: Omit<WatchOptions, 'validate' | 'onUpdate'>;
}

export type MeshServiceOptions = ServicePoolOptions & {
  traffic?: MeshTrafficPolicy;
  trafficConfig?: MeshTrafficConfigOptions;
};

export type MeshRawRequestOptions = PeerOptions & {
  target?: MeshMetadataMatch;
};

export type MeshStreamRequestOptions = PeerStreamOptions & {
  target?: MeshMetadataMatch;
};

export type MeshRequestOptions = Omit<MeshRawRequestOptions, 'method'>;
export type MeshWriteOptions = MeshRequestOptions;

export interface MeshRuntimeOptions {
  control: ControlClient | {
    url: string;
    token: string;
    timeout?: number;
  };
  defaults?: MeshServiceOptions;
  services?: Readonly<Record<string, MeshServiceOptions>>;
  closeControl?: boolean;
}

export class MeshHttpError extends Error {
  readonly service: string;
  readonly statusCode: number;
  readonly peer: Peer;
  readonly response: PeerResponse;
  readonly data: unknown;

  constructor(service: string, response: PeerResponse, data: unknown) {
    super('Mesh request to ' + service + ' failed with HTTP ' + response.statusCode);
    this.name = 'MeshHttpError';
    this.service = service;
    this.statusCode = response.statusCode;
    this.peer = response.peer;
    this.response = response;
    this.data = data;
  }
}

function validateMetadataMatch(match: MeshMetadataMatch, label: string): void {
  if (!match || typeof match !== 'object' || Array.isArray(match)) {
    throw new TypeError(label + ' must be an object');
  }
  if (!Object.keys(match).length) throw new TypeError(label + ' must contain at least one metadata key');
  for (const [key, value] of Object.entries(match)) {
    if (!key || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new TypeError(label + ' values must be string, number or boolean');
    }
  }
}

function metadataMatches(metadata: Readonly<Record<string, unknown>>, match: MeshMetadataMatch): boolean {
  for (const [key, value] of Object.entries(match)) {
    if (metadata[key] !== value) return false;
  }
  return true;
}

function validateTrafficPolicy(policy: MeshTrafficPolicy | undefined): void {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object') {
    throw new TypeError('Mesh traffic policy must be an object');
  }
  if (policy.fallback !== undefined && !['all', 'error'].includes(policy.fallback)) {
    throw new TypeError('Mesh traffic fallback must be all or error');
  }

  const hasRoutes = Array.isArray(policy.routes) && policy.routes.length > 0;
  const hasSplit = Array.isArray(policy.split) && policy.split.length > 0;
  const hasPreference = Array.isArray(policy.prefer) && policy.prefer.length > 0;
  if (!hasRoutes && !hasSplit && !hasPreference) {
    throw new TypeError('Mesh traffic policy needs routes, split, prefer, or a combination');
  }

  if (policy.routes !== undefined) {
    if (!Array.isArray(policy.routes) || !policy.routes.length) {
      throw new TypeError('Mesh traffic routes must be a nonempty array');
    }
    for (const route of policy.routes) {
      if (!route || typeof route !== 'object') throw new TypeError('Invalid mesh traffic route');
      if (!route.when || typeof route.when !== 'object' || Array.isArray(route.when)) {
        throw new TypeError('Mesh traffic route when must be an object');
      }
      const headers = route.when.headers;
      if (!headers || typeof headers !== 'object' || Array.isArray(headers) || !Object.keys(headers).length) {
        throw new TypeError('Mesh traffic route needs at least one header match');
      }
      for (const [header, value] of Object.entries(headers)) {
        if (!header || typeof value !== 'string' || !value) {
          throw new TypeError('Mesh traffic route headers need nonempty string names and values');
        }
      }
      validateMetadataMatch(route.target, 'Mesh traffic route target');
      if (route.name !== undefined && (typeof route.name !== 'string' || !route.name)) {
        throw new TypeError('Mesh traffic route name must be nonempty');
      }
    }
  }

  if (policy.split !== undefined) {
    if (!Array.isArray(policy.split) || !policy.split.length) {
      throw new TypeError('Mesh traffic split must be a nonempty array');
    }
    for (const target of policy.split) {
      if (!target || typeof target !== 'object') throw new TypeError('Invalid mesh traffic target');
      validateMetadataMatch(target.match, 'Mesh traffic target match');
      if (!Number.isFinite(target.weight) || target.weight <= 0) {
        throw new TypeError('Mesh traffic target weight must be positive');
      }
      if (target.name !== undefined && (typeof target.name !== 'string' || !target.name)) {
        throw new TypeError('Mesh traffic target name must be nonempty');
      }
    }
  }

  if (policy.prefer !== undefined) {
    if (!Array.isArray(policy.prefer) || !policy.prefer.length) {
      throw new TypeError('Mesh traffic prefer must be a nonempty array');
    }
    for (const preference of policy.prefer) {
      if (!preference || typeof preference !== 'object') throw new TypeError('Invalid mesh traffic preference');
      validateMetadataMatch(preference.match, 'Mesh traffic preference match');
      if (preference.name !== undefined && (typeof preference.name !== 'string' || !preference.name)) {
        throw new TypeError('Mesh traffic preference name must be nonempty');
      }
    }
  }
}

function validateTrafficConfig(config: MeshTrafficConfigOptions | undefined): void {
  if (config === undefined) return;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Mesh trafficConfig must be an object');
  }
  if (typeof config.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.namespace)) {
    throw new TypeError('Mesh trafficConfig namespace must be a valid OpenMesh name');
  }
  if (
    config.key !== undefined &&
    (typeof config.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.key))
  ) {
    throw new TypeError('Mesh trafficConfig key must be a valid OpenMesh name');
  }
  if (config.required !== undefined && typeof config.required !== 'boolean') {
    throw new TypeError('Mesh trafficConfig required must be boolean');
  }
  if (config.watch !== undefined && (!config.watch || typeof config.watch !== 'object' || Array.isArray(config.watch))) {
    throw new TypeError('Mesh trafficConfig watch must be an object');
  }
}

function mergeMeshServiceOptions(
  defaults: MeshServiceOptions | undefined,
  configured: MeshServiceOptions | undefined,
  local: MeshServiceOptions | undefined
): MeshServiceOptions {
  const merged: MeshServiceOptions = {
    ...(defaults || {}),
    ...(configured || {}),
    ...(local || {})
  };
  if (defaults?.watch || configured?.watch || local?.watch) {
    merged.watch = {
      ...(defaults?.watch || {}),
      ...(configured?.watch || {}),
      ...(local?.watch || {})
    };
  }
  validateTrafficPolicy(merged.traffic);
  validateTrafficConfig(merged.trafficConfig);
  return merged;
}

function parseMeshResponse(response: PeerResponse): unknown {
  if (response.statusCode === 204 || response.body.length === 0) return undefined;
  const type = String(response.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/json') || type.includes('+json')) {
    try { return response.json(); } catch {}
  }
  return response.text();
}

function stableBucket(value: string, modulo: number): number {
  const digest = createHash('sha256').update(value).digest();
  const high = digest.readUInt32BE(0);
  return high % modulo;
}

function normalizedHeaderValue(
  headers: Readonly<Record<string, string | string[] | number | undefined>>,
  name: string
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }
  return undefined;
}

function trafficRouteMatches(
  route: MeshTrafficRoute,
  options: MeshRawRequestOptions,
  state: ReturnType<typeof currentRequestContext>
): boolean {
  const headers = route.when.headers;
  if (!headers) return false;

  for (const [name, expected] of Object.entries(headers)) {
    const explicit = normalizedHeaderValue(options.headers || {}, name);
    const actual = explicit ?? normalizedHeaderValue(state?.inboundHeaders || {}, name);
    if (actual !== expected) return false;
  }
  return true;
}

export class MeshService {
  readonly runtime: MeshRuntime;
  readonly service: string;
  readonly options: Readonly<MeshServiceOptions>;
  private _poolPromise: Promise<ServicePool> | null = null;
  private _trafficInitPromise: Promise<void> | null = null;
  private _trafficWatcher: ConfigWatcher | null = null;
  private _traffic: MeshTrafficPolicy | undefined;
  private _trafficRevision: number | null = null;
  private _closed = false;
  private _counter = 0;

  constructor(runtime: MeshRuntime, service: string, options: MeshServiceOptions = {}) {
    this.runtime = runtime;
    this.service = name(service);
    validateTrafficPolicy(options.traffic);
    validateTrafficConfig(options.trafficConfig);
    this.options = Object.freeze({ ...options });
    this._traffic = options.traffic;
  }

  get trafficPolicy(): Readonly<MeshTrafficPolicy> | undefined {
    return this._traffic;
  }

  get trafficRevision(): number | null {
    return this._trafficRevision;
  }

  get trafficLastError(): Error | null {
    return this._trafficWatcher?.lastError || null;
  }

  private _trafficConfigValue(values: Readonly<Record<string, unknown>>): MeshTrafficPolicy | undefined {
    const config = this.options.trafficConfig;
    if (!config) return this.options.traffic;

    const key = config.key || 'traffic';
    const value = values[key];
    if (value === undefined) {
      if (config.required) {
        throw new TypeError('Missing required mesh traffic policy at ' + config.namespace + '.' + key);
      }
      return this.options.traffic;
    }

    validateTrafficPolicy(value as MeshTrafficPolicy);
    return value as MeshTrafficPolicy;
  }

  private _applyTrafficSnapshot(snapshot: ConfigSnapshot): void {
    this._traffic = this._trafficConfigValue(snapshot.values);
    this._trafficRevision = snapshot.revision;
  }

  private _initTrafficConfig(): Promise<void> {
    const config = this.options.trafficConfig;
    if (!config) return Promise.resolve();
    if (this._trafficInitPromise) return this._trafficInitPromise;

    const key = config.key || 'traffic';
    this._trafficInitPromise = this.runtime.client.watchConfig(config.namespace, {
      ...(config.watch || {}),
      validate: values => {
        const value = values[key];
        if (value === undefined) {
          if (config.required) {
            throw new TypeError('Missing required mesh traffic policy at ' + config.namespace + '.' + key);
          }
          return;
        }
        validateTrafficPolicy(value as MeshTrafficPolicy);
      },
      onUpdate: current => {
        this._applyTrafficSnapshot(current);
      }
    }).then(watcher => {
      if (this._closed) {
        watcher.stop();
        throw new PeerError('Mesh service is closed', 'POOL_CLOSED');
      }
      this._trafficWatcher = watcher;
      this._applyTrafficSnapshot(watcher.snapshot);
    }).catch(error => {
      this._trafficInitPromise = null;
      throw error;
    });

    return this._trafficInitPromise;
  }

  private _pool(): Promise<ServicePool> {
    if (this._closed) return Promise.reject(new PeerError('Mesh service is closed', 'POOL_CLOSED'));
    if (!this._poolPromise) {
      const { traffic: _traffic, trafficConfig: _trafficConfig, ...poolOptions } = this.options;
      this._poolPromise = this._initTrafficConfig()
        .then(() => this.runtime.client.service(this.service, poolOptions))
        .catch(error => {
          this._poolPromise = null;
          throw error;
        });
    }
    return this._poolPromise;
  }

  private _selectTrafficMatch(options: MeshRawRequestOptions): MeshMetadataMatch | null {
    if (options.target) {
      validateMetadataMatch(options.target, 'Mesh request target');
      return options.target;
    }

    const policy = this._traffic;
    if (!policy) return null;

    const state = currentRequestContext();
    for (const route of policy.routes || []) {
      if (trafficRouteMatches(route, options, state)) return route.target;
    }

    if (!policy.split?.length) return null;

    const total = policy.split.reduce((sum, target) => sum + target.weight, 0);
    const scale = 1_000_000;
    const normalizedWeights = policy.split.map(target => Math.max(1, Math.round(target.weight / total * scale)));
    const normalizedTotal = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
    const bucket = options.key !== undefined
      ? stableBucket(this.service + '\0' + options.key, normalizedTotal)
      : stableBucket(this.service + '\0request\0' + this._counter++, normalizedTotal);

    let cursor = 0;
    for (let index = 0; index < policy.split.length; index++) {
      cursor += normalizedWeights[index]!;
      if (bucket < cursor) return policy.split[index]!.match;
    }
    return policy.split[policy.split.length - 1]!.match;
  }

  private _candidatePeerIds(pool: ServicePool, options: MeshRawRequestOptions): readonly string[] | undefined {
    const policy = this._traffic;
    const match = this._selectTrafficMatch(options);
    const allowed = options.peerIds ? new Set(options.peerIds) : null;

    let instances = pool.watcher.instances.filter(instance => !allowed || allowed.has(instance.id));
    let narrowed = !!allowed;

    if (match) {
      const targeted = instances.filter(instance => metadataMatches(instance.metadata, match));
      if (targeted.length) {
        instances = targeted;
        narrowed = true;
      } else if (policy?.fallback === 'all' && !options.target) {
        // Keep the caller-authorized base set and continue with soft preferences.
      } else {
        throw new PeerError(
          'No instances of ' + this.service + ' match the requested traffic target',
          'NO_TRAFFIC_TARGET'
        );
      }
    }

    if (policy?.prefer?.length) {
      for (const preference of policy.prefer) {
        const preferred = instances.filter(instance => metadataMatches(instance.metadata, preference.match));
        if (preferred.length) {
          instances = preferred;
          narrowed = true;
          break;
        }
      }
    }

    if (!instances.length) {
      throw new PeerError('No peers available for ' + this.service, 'NO_PEERS');
    }

    return narrowed ? instances.map(instance => instance.id) : undefined;
  }

  private _requestOptions(pool: ServicePool, options: MeshRawRequestOptions, method: string): PeerOptions {
    const state = currentRequestContext();
    const headers = {
      ...(state?.outboundHeaders || {}),
      ...(options.headers || {})
    };

    const { target: _target, ...peerOptions } = options;
    const peerIds = this._candidatePeerIds(pool, options);
    return {
      ...peerOptions,
      method,
      headers,
      ...(peerIds ? { peerIds } : {})
    };
  }

  async request(path: string, options: MeshRawRequestOptions = {}): Promise<PeerResponse> {
    const pool = await this._pool();
    return pool.request(path, this._requestOptions(pool, options, options.method || 'GET'));
  }

  async stream(path: string, options: MeshStreamRequestOptions = {}): Promise<PeerStreamResponse> {
    const pool = await this._pool();
    return pool.requestStream(
      path,
      this._requestOptions(pool, options, options.method || 'GET') as PeerStreamOptions
    );
  }

  private async _data<T>(method: string, path: string, options: MeshRequestOptions = {}): Promise<T> {
    const pool = await this._pool();
    let response: PeerResponse;

    try {
      response = await pool.request(path, this._requestOptions(pool, options, method));
    } catch (error) {
      if (
        error instanceof PeerError &&
        error.code === 'REMOTE_HTTP_ERROR' &&
        error.peer &&
        error.response
      ) {
        const remote = new PeerResponse(error.peer, error.response);
        throw new MeshHttpError(this.service, remote, parseMeshResponse(remote));
      }
      throw error;
    }

    const data = parseMeshResponse(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new MeshHttpError(this.service, response, data);
    }
    return data as T;
  }

  get<T = unknown>(path: string, options: MeshRequestOptions = {}): Promise<T> {
    return this._data<T>('GET', path, options);
  }

  head<T = unknown>(path: string, options: MeshRequestOptions = {}): Promise<T> {
    return this._data<T>('HEAD', path, options);
  }

  post<T = unknown>(path: string, options: MeshWriteOptions = {}): Promise<T> {
    return this._data<T>('POST', path, options);
  }

  put<T = unknown>(path: string, options: MeshWriteOptions = {}): Promise<T> {
    return this._data<T>('PUT', path, options);
  }

  patch<T = unknown>(path: string, options: MeshWriteOptions = {}): Promise<T> {
    return this._data<T>('PATCH', path, options);
  }

  delete<T = unknown>(path: string, options: MeshWriteOptions = {}): Promise<T> {
    return this._data<T>('DELETE', path, options);
  }

  async stats(): Promise<PeerStats[]> {
    return (await this._pool()).stats();
  }

  async poolStats(): Promise<PeerPoolStats> {
    return (await this._pool()).poolStats();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._trafficWatcher?.stop();
    this._trafficWatcher = null;
    const pending = this._poolPromise;
    this._poolPromise = null;
    if (pending) void pending.then(pool => pool.close(), () => {});
  }
}

export class MeshRuntime {
  readonly client: ControlClient;
  private readonly _ownsClient: boolean;
  private readonly _closeControl: boolean;
  private readonly _defaults: MeshServiceOptions | undefined;
  private readonly _configured: Readonly<Record<string, MeshServiceOptions>>;
  private readonly _services = new Map<string, MeshService>();
  private _closed = false;

  constructor(options: MeshRuntimeOptions) {
    if (!options || typeof options !== 'object' || !options.control) {
      throw new TypeError('Mesh runtime needs a control plane');
    }

    if (options.control instanceof ControlClient) {
      this.client = options.control;
      this._ownsClient = false;
    } else {
      this.client = new ControlClient(options.control);
      this._ownsClient = true;
    }

    this._closeControl = options.closeControl ?? this._ownsClient;
    this._defaults = options.defaults;
    this._configured = Object.freeze({ ...(options.services || {}) });

    validateTrafficPolicy(this._defaults?.traffic);
    validateTrafficConfig(this._defaults?.trafficConfig);
    for (const serviceOptions of Object.values(this._configured)) {
      validateTrafficPolicy(serviceOptions.traffic);
      validateTrafficConfig(serviceOptions.trafficConfig);
    }
  }

  service(service: string, options?: MeshServiceOptions): MeshService {
    if (this._closed) throw new Error('Mesh runtime is closed');
    const serviceName = name(service);
    const existing = this._services.get(serviceName);
    if (existing) {
      if (options && Object.keys(options).length) {
        throw new Error('Mesh service ' + serviceName + ' is already configured');
      }
      return existing;
    }

    const resolved = mergeMeshServiceOptions(
      this._defaults,
      this._configured[serviceName],
      options
    );
    const serviceClient = new MeshService(this, serviceName, resolved);
    this._services.set(serviceName, serviceClient);
    return serviceClient;
  }

  close(): Promise<void> {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    for (const service of this._services.values()) service.close();
    this._services.clear();
    return this._closeControl ? this.client.close() : Promise.resolve();
  }
}

export type MeshAccessor = ((service: string, options?: MeshServiceOptions) => MeshService) & {
  readonly runtime: MeshRuntime;
  close(): Promise<void>;
};

export function createMeshRuntime(options: MeshRuntimeOptions): MeshRuntime {
  return new MeshRuntime(options);
}

export function attachMeshRuntime(app: OpenMesh, options: MeshRuntimeOptions): MeshAccessor {
  const runtime = new MeshRuntime(options);
  const accessor = ((service: string, serviceOptions?: MeshServiceOptions) =>
    runtime.service(service, serviceOptions)) as MeshAccessor;

  Object.defineProperties(accessor, {
    runtime: { value: runtime, enumerable: true },
    close: { value: () => runtime.close(), enumerable: true }
  });

  app.decorate('mesh', accessor);
  app.onClose(() => runtime.close());
  return accessor;
}

export function meshRuntime(options: MeshRuntimeOptions): ReturnType<typeof definePlugin> {
  return definePlugin(app => {
    attachMeshRuntime(app, options);
  }, { name: 'mesh-runtime', global: true });
}

declare module '../core/app.js' {
  interface OpenMesh {
    mesh?: MeshAccessor;
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
