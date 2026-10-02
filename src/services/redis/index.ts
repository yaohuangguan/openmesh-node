import { randomUUID } from 'node:crypto';
import { HttpError } from '../../core/context.js';
import type {
  ConfigAdapterLike,
  RegistryAdapterLike
} from '../index.js';
import {
  freeze,
  name,
  type ConfigSnapshot,
  type Instance,
  type Lease,
  type MaybePromise,
  type RegistrationInput,
  type ServiceSnapshot
} from '../store.js';

export interface RedisClientLike {
  sendCommand(args: readonly string[]): Promise<unknown>;
  duplicate?(): RedisClientLike;
  connect?(): Promise<unknown>;
  subscribe?(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe?(channel: string, listener?: (message: string) => void): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): MaybePromise<void>;
}

export interface RedisAdapterOptions {
  client: RedisClientLike;
  prefix?: string;
}

export interface RedisRegistryAdapterOptions extends RedisAdapterOptions {
  watchInterval?: number;
}

export interface RedisConfigAdapterOptions extends RedisAdapterOptions {
  maxBytes?: number;
}

const REGISTRY_REGISTER = `-- openmesh:registry:register
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.error_reply('OPENMESH_CONFLICT')
end
local ttl = tonumber(ARGV[4])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local record = {
  service = ARGV[1],
  id = ARGV[2],
  url = ARGV[3],
  ttl = ttl,
  expiresAt = now + ttl,
  metadata = cjson.decode(ARGV[5]),
  leaseId = ARGV[6]
}
local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded, 'PX', ttl)
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('INCR', KEYS[3])
redis.call('PUBLISH', KEYS[4], 'changed')
return encoded
`;

const REGISTRY_RENEW = `-- openmesh:registry:renew
local encoded = redis.call('GET', KEYS[1])
if not encoded then
  return redis.error_reply('OPENMESH_NOT_FOUND')
end
local record = cjson.decode(encoded)
if record.leaseId ~= ARGV[1] then
  return redis.error_reply('OPENMESH_OWNERSHIP')
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
record.expiresAt = now + tonumber(record.ttl)
local updated = cjson.encode(record)
redis.call('SET', KEYS[1], updated, 'PX', tonumber(record.ttl))
return updated
`;

const REGISTRY_DEREGISTER = `-- openmesh:registry:deregister
local encoded = redis.call('GET', KEYS[1])
if not encoded then
  return redis.error_reply('OPENMESH_NOT_FOUND')
end
local record = cjson.decode(encoded)
if record.leaseId ~= ARGV[1] then
  return redis.error_reply('OPENMESH_OWNERSHIP')
end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
redis.call('INCR', KEYS[3])
redis.call('PUBLISH', KEYS[4], 'changed')
return 1
`;

const CONFIG_REPLACE = `-- openmesh:config:replace
local epoch = redis.call('GET', KEYS[2])
if not epoch or epoch ~= ARGV[3] then
  return redis.error_reply('OPENMESH_CONFLICT')
end
local encoded = redis.call('GET', KEYS[1])
local revision = 0
if encoded then
  local current = cjson.decode(encoded)
  revision = tonumber(current.revision)
end
if revision ~= tonumber(ARGV[2]) then
  return redis.error_reply('OPENMESH_CONFLICT')
end
local snapshot = {
  namespace = ARGV[1],
  epoch = epoch,
  revision = revision + 1,
  values = cjson.decode(ARGV[4])
}
local updated = cjson.encode(snapshot)
redis.call('SET', KEYS[1], updated)
redis.call('PUBLISH', KEYS[3], updated)
return updated
`;

function validateClient(client: RedisClientLike): RedisClientLike {
  if (!client || typeof client.sendCommand !== 'function') {
    throw new TypeError('Redis adapter requires a client with sendCommand()');
  }
  return client;
}

function validatePrefix(prefix: unknown): string {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(prefix)) {
    throw new TypeError('Redis adapter prefix must be a bounded key prefix');
  }
  return prefix;
}

function integer(value: unknown, label: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new TypeError(label + ' must be an integer >= ' + min);
  }
  return value as number;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Unexpected Redis array response');
  return value.map(item => {
    const text = stringValue(item);
    if (text === null) throw new TypeError('Unexpected null Redis array item');
    return text;
  });
}

function json<T>(value: unknown, label: string): T {
  const text = stringValue(value);
  if (text === null) throw new Error(label + ' was missing');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(label + ' contained invalid JSON');
  }
}

function redisError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('OPENMESH_NOT_FOUND')) throw new HttpError(404, 'Lease expired or instance not registered');
  if (message.includes('OPENMESH_OWNERSHIP')) throw new HttpError(409, 'Lease belongs to another registration');
  if (message.includes('OPENMESH_CONFLICT')) throw new HttpError(409, 'Redis adapter compare-and-swap conflict');
  throw error;
}

async function send(client: RedisClientLike, args: readonly string[]): Promise<unknown> {
  return client.sendCommand(args);
}

async function evalScript(
  client: RedisClientLike,
  script: string,
  keys: readonly string[],
  args: readonly string[]
): Promise<unknown> {
  try {
    return await send(client, ['EVAL', script, String(keys.length), ...keys, ...args]);
  } catch (error) {
    return redisError(error);
  }
}

function validateRegistrationInput({ url, ttl = 30000, metadata = {} }: RegistrationInput): {
  url: string;
  ttl: number;
  metadata: Readonly<Record<string, unknown>>;
} {
  integer(ttl, 'Lease TTL', 1000);
  if (ttl > 3600000) throw new HttpError(400, 'Lease TTL must be 1000..3600000 milliseconds');
  if (typeof url !== 'string' || url.length > 2048) {
    throw new HttpError(400, 'Instance URL must be a string of at most 2048 characters');
  }

  let address: URL;
  try {
    address = new URL(url);
  } catch {
    throw new HttpError(400, 'Invalid instance URL');
  }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
    throw new HttpError(400, 'Instance URL must be HTTP(S) without credentials, query or fragment');
  }

  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new HttpError(400, 'Expected metadata object');
  let metadataText: string;
  try {
    metadataText = JSON.stringify(metadata);
  } catch {
    throw new HttpError(400, 'Invalid metadata');
  }
  if (Buffer.byteLength(metadataText) > 8192) throw new HttpError(413, 'Metadata exceeds size limit');

  return {
    url: address.origin + address.pathname.replace(/\/$/, ''),
    ttl,
    metadata: freeze(JSON.parse(metadataText) as Record<string, unknown>)
  };
}

async function openSubscriber(client: RedisClientLike): Promise<RedisClientLike> {
  if (typeof client.duplicate !== 'function') throw new TypeError('Redis subscriptions require client.duplicate()');
  const subscriber = client.duplicate();
  if (!subscriber || typeof subscriber.subscribe !== 'function') {
    throw new TypeError('Redis subscriptions require duplicate().subscribe()');
  }
  if (typeof subscriber.connect === 'function') await subscriber.connect();
  return subscriber;
}

async function closeSubscriber(client: RedisClientLike): Promise<void> {
  try {
    if (typeof client.quit === 'function') await client.quit();
    else await client.disconnect?.();
  } catch {
    try {
      await client.disconnect?.();
    } catch {}
  }
}

abstract class RedisAdapterBase {
  protected readonly client: RedisClientLike;
  protected readonly prefix: string;
  protected readonly watchers = new Set<() => void>();
  protected closed = false;

  constructor({ client, prefix = 'openmesh' }: RedisAdapterOptions) {
    this.client = validateClient(client);
    this.prefix = validatePrefix(prefix);
  }

  protected assertOpen(): void {
    if (this.closed) throw new Error('Redis adapter is closed');
  }

  protected key(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  protected track(cleanup: () => void): () => void {
    let active = true;
    const tracked = (): void => {
      if (!active) return;
      active = false;
      this.watchers.delete(tracked);
      cleanup();
    };
    this.watchers.add(tracked);
    return tracked;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cleanup of [...this.watchers]) cleanup();
  }
}

export class RedisRegistryAdapter extends RedisAdapterBase implements RegistryAdapterLike {
  private readonly watchInterval: number;

  constructor(options: RedisRegistryAdapterOptions) {
    super(options);
    this.watchInterval = integer(options.watchInterval ?? 1000, 'Redis registry watchInterval', 50);
  }

  private instanceKey(service: string, id: string): string {
    return this.key('registry', service, 'instance', id);
  }

  private indexKey(service: string): string {
    return this.key('registry', service, 'ids');
  }

  private revisionKey(service: string): string {
    return this.key('registry', service, 'revision');
  }

  private channel(service: string): string {
    return this.key('registry', service, 'changed');
  }

  async register(service: string, id: string, options: RegistrationInput): Promise<Lease> {
    this.assertOpen();
    name(service);
    name(id);
    const normalized = validateRegistrationInput(options);
    const leaseId = randomUUID();
    const encoded = await evalScript(
      this.client,
      REGISTRY_REGISTER,
      [this.instanceKey(service, id), this.indexKey(service), this.revisionKey(service), this.channel(service)],
      [service, id, normalized.url, String(normalized.ttl), JSON.stringify(normalized.metadata), leaseId]
    );
    return freeze(json<Lease>(encoded, 'Redis registry lease'));
  }

  async renew(service: string, id: string, leaseId: string): Promise<Lease> {
    this.assertOpen();
    name(service);
    name(id);
    const encoded = await evalScript(
      this.client,
      REGISTRY_RENEW,
      [this.instanceKey(service, id)],
      [leaseId]
    );
    return freeze(json<Lease>(encoded, 'Redis registry lease'));
  }

  async deregister(service: string, id: string, leaseId: string): Promise<void> {
    this.assertOpen();
    name(service);
    name(id);
    await evalScript(
      this.client,
      REGISTRY_DEREGISTER,
      [this.instanceKey(service, id), this.indexKey(service), this.revisionKey(service), this.channel(service)],
      [leaseId, id]
    );
  }

  async list(service: string): Promise<Instance[]> {
    this.assertOpen();
    name(service);
    const ids = stringArray(await send(this.client, ['SMEMBERS', this.indexKey(service)]));
    if (!ids.length) return [];

    const keys = ids.map(id => this.instanceKey(service, id));
    const values = await send(this.client, ['MGET', ...keys]);
    if (!Array.isArray(values)) throw new TypeError('Unexpected Redis MGET response');

    const stale: string[] = [];
    const instances: Instance[] = [];
    for (let index = 0; index < ids.length; index++) {
      const value = values[index];
      if (value === null || value === undefined) {
        stale.push(ids[index]!);
        continue;
      }
      const lease = json<Lease>(value, 'Redis registry record');
      const { leaseId: _leaseId, ...instance } = lease;
      instances.push(freeze(instance));
    }

    if (stale.length) {
      await send(this.client, ['SREM', this.indexKey(service), ...stale]);
      await send(this.client, ['INCR', this.revisionKey(service)]);
      await send(this.client, ['PUBLISH', this.channel(service), 'expired']);
    }

    return instances.sort((a, b) => a.id.localeCompare(b.id));
  }

  async snapshot(service: string): Promise<ServiceSnapshot> {
    this.assertOpen();
    name(service);

    for (let attempt = 0; attempt < 3; attempt++) {
      const before = Number(stringValue(await send(this.client, ['GET', this.revisionKey(service)])) || 0);
      const instances = await this.list(service);
      const after = Number(stringValue(await send(this.client, ['GET', this.revisionKey(service)])) || 0);
      if (before === after) return freeze({ service, revision: after, instances: freeze(instances) });
    }

    const instances = await this.list(service);
    const revision = Number(stringValue(await send(this.client, ['GET', this.revisionKey(service)])) || 0);
    return freeze({ service, revision, instances: freeze(instances) });
  }

  async subscribe(service: string, listener: () => void): Promise<() => void> {
    this.assertOpen();
    name(service);
    if (typeof listener !== 'function') throw new TypeError('Registry listener must be a function');
    const subscriber = await openSubscriber(this.client);
    const channel = this.channel(service);
    let stopped = false;
    let signature = JSON.stringify((await this.list(service)).map(instance => [instance.id, instance.url, instance.expiresAt]));
    let refreshing = false;
    let pending = false;

    const refresh = async (force: boolean): Promise<void> => {
      if (stopped) return;
      if (refreshing) {
        pending = pending || force;
        return;
      }
      refreshing = true;
      try {
        const next = JSON.stringify((await this.list(service)).map(instance => [instance.id, instance.url, instance.expiresAt]));
        if (force || next !== signature) {
          signature = next;
          listener();
        }
      } finally {
        refreshing = false;
        if (pending) {
          pending = false;
          void refresh(true);
        }
      }
    };

    const onMessage = (): void => { void refresh(true); };
    await subscriber.subscribe!(channel, onMessage);
    const timer = setInterval(() => { void refresh(false); }, this.watchInterval);
    timer.unref?.();

    return this.track(() => {
      stopped = true;
      clearInterval(timer);
      void Promise.resolve(subscriber.unsubscribe?.(channel, onMessage))
        .catch(() => {})
        .finally(() => closeSubscriber(subscriber));
    });
  }
}

export class RedisConfigAdapter extends RedisAdapterBase implements ConfigAdapterLike {
  private readonly maxBytes: number;
  private readonly epochSeed = randomUUID();

  constructor(options: RedisConfigAdapterOptions) {
    super(options);
    this.maxBytes = integer(options.maxBytes ?? 262144, 'Redis config maxBytes', 1);
  }

  private configKey(namespace: string): string {
    return this.key('config', namespace, 'snapshot');
  }

  private epochKey(): string {
    return this.key('config', 'epoch');
  }

  private channel(namespace: string): string {
    return this.key('config', namespace, 'changed');
  }

  private async epoch(): Promise<string> {
    await send(this.client, ['SET', this.epochKey(), this.epochSeed, 'NX']);
    const epoch = stringValue(await send(this.client, ['GET', this.epochKey()]));
    if (!epoch) throw new Error('Redis config epoch was not initialized');
    return epoch;
  }

  async snapshot(namespace: string): Promise<ConfigSnapshot> {
    this.assertOpen();
    name(namespace);
    const [epoch, encoded] = await Promise.all([
      this.epoch(),
      send(this.client, ['GET', this.configKey(namespace)])
    ]);
    if (encoded === null || encoded === undefined) {
      return freeze({ namespace, epoch, revision: 0, values: freeze({}) });
    }
    const snapshot = json<ConfigSnapshot>(encoded, 'Redis configuration snapshot');
    return freeze({ ...snapshot, values: freeze(snapshot.values) });
  }

  async replace(
    namespace: string,
    values: Record<string, unknown>,
    expectedRevision: number,
    expectedEpoch: string
  ): Promise<ConfigSnapshot> {
    this.assertOpen();
    name(namespace);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new HttpError(400, 'An expectedRevision is required');
    }
    if (typeof expectedEpoch !== 'string' || !expectedEpoch) {
      throw new HttpError(400, 'An expectedEpoch is required');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new HttpError(400, 'Expected a JSON object');

    let valuesText: string;
    try {
      valuesText = JSON.stringify(values);
    } catch {
      throw new HttpError(400, 'Invalid JSON object');
    }
    if (Buffer.byteLength(valuesText) > this.maxBytes) throw new HttpError(413, 'Object exceeds size limit');

    await this.epoch();
    const encoded = await evalScript(
      this.client,
      CONFIG_REPLACE,
      [this.configKey(namespace), this.epochKey(), this.channel(namespace)],
      [namespace, String(expectedRevision), expectedEpoch, valuesText]
    );
    const snapshot = json<ConfigSnapshot>(encoded, 'Redis configuration snapshot');
    return freeze({ ...snapshot, values: freeze(snapshot.values) });
  }

  async subscribe(namespace: string, listener: (snapshot?: ConfigSnapshot) => void): Promise<() => void> {
    this.assertOpen();
    name(namespace);
    if (typeof listener !== 'function') throw new TypeError('Config listener must be a function');
    const subscriber = await openSubscriber(this.client);
    const channel = this.channel(namespace);
    let stopped = false;

    const onMessage = (message: string): void => {
      if (stopped) return;
      try {
        const snapshot = json<ConfigSnapshot>(message, 'Redis configuration notification');
        listener(freeze({ ...snapshot, values: freeze(snapshot.values) }));
      } catch {}
    };

    await subscriber.subscribe!(channel, onMessage);
    return this.track(() => {
      stopped = true;
      void Promise.resolve(subscriber.unsubscribe?.(channel, onMessage))
        .catch(() => {})
        .finally(() => closeSubscriber(subscriber));
    });
  }
}
