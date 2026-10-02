import { randomUUID } from 'node:crypto';
import { HttpError } from '../core/context.js';

export type MaybePromise<T> = T | Promise<T>;

export interface Instance {
  service: string;
  id: string;
  url: string;
  ttl: number;
  expiresAt: number;
  metadata: Readonly<Record<string, unknown>>;
}

export interface Lease extends Instance {
  leaseId: string;
}

export interface ServiceSnapshot {
  service: string;
  revision?: number;
  instances: Instance[];
}

export interface ConfigSnapshot {
  namespace: string;
  epoch: string;
  revision: number;
  values: Readonly<Record<string, unknown>>;
}

export interface RegistrationInput {
  url: string;
  ttl?: number;
  metadata?: Record<string, unknown>;
}

export class RegistryAdapter {
  register(_service: string, _id: string, _options: RegistrationInput): MaybePromise<Lease> {
    throw new Error('RegistryAdapter.register() is not implemented');
  }
  renew(_service: string, _id: string, _leaseId: string): MaybePromise<Lease> {
    throw new Error('RegistryAdapter.renew() is not implemented');
  }
  deregister(_service: string, _id: string, _leaseId: string): MaybePromise<void> {
    throw new Error('RegistryAdapter.deregister() is not implemented');
  }
  list(_service: string): MaybePromise<Instance[]> {
    throw new Error('RegistryAdapter.list() is not implemented');
  }
  snapshot(service: string): MaybePromise<ServiceSnapshot> {
    const instances = this.list(service);
    return instances && typeof (instances as PromiseLike<Instance[]>).then === 'function'
      ? Promise.resolve(instances).then(value => ({ service, instances: value }))
      : { service, instances: instances as Instance[] };
  }
  subscribe(_service: string, _listener: () => void): MaybePromise<() => void> {
    throw new Error('RegistryAdapter.subscribe() is not implemented');
  }
  close(): MaybePromise<void> {}
}

export class ConfigAdapter {
  snapshot(_namespace: string): MaybePromise<ConfigSnapshot> {
    throw new Error('ConfigAdapter.snapshot() is not implemented');
  }
  replace(_namespace: string, _values: Record<string, unknown>, _expectedRevision: number, _expectedEpoch: string): MaybePromise<ConfigSnapshot> {
    throw new Error('ConfigAdapter.replace() is not implemented');
  }
  subscribe(_namespace: string, _listener: (snapshot?: ConfigSnapshot) => void): MaybePromise<() => void> {
    throw new Error('ConfigAdapter.subscribe() is not implemented');
  }
  close(): MaybePromise<void> {}
}

export function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new HttpError(400, 'Invalid service, instance or namespace name');
  }
  return value;
}

function duration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1000 || (value as number) > 3600000) {
    throw new HttpError(400, 'Lease TTL must be 1000..3600000 milliseconds');
  }
  return value as number;
}

function jsonObject(value: unknown, limit: number): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object');
  let text: string;
  try { text = JSON.stringify(value); }
  catch { throw new HttpError(400, 'Invalid JSON object'); }
  if (Buffer.byteLength(text) > limit) throw new HttpError(413, 'Object exceeds size limit');
  return freeze(JSON.parse(text) as Record<string, unknown>);
}

export function freeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current as Record<string, unknown>)) pending.push(child);
      Object.freeze(current);
    }
  }
  return value;
}

function subscribe<T>(map: Map<string, Set<(value: T) => void>>, key: string, listener: (value: T) => void): () => void {
  if (typeof listener !== 'function') throw new TypeError('Subscription listener must be a function');
  let listeners = map.get(key);
  if (!listeners) map.set(key, (listeners = new Set()));
  listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners!.delete(listener);
    if (!listeners!.size) map.delete(key);
  };
}

function notify<T>(map: Map<string, Set<(value: T) => void>>, key: string, value: T): void {
  const listeners = map.get(key);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try { listener(value); } catch {}
  }
}

interface RegistryChange {
  service: string;
  reason: 'registered' | 'deregistered' | 'expired';
  revision: number;
}

export class ServiceRegistry extends RegistryAdapter {
  private _instances = new Map<string, Lease>();
  private _now: () => number;
  private _max: number;
  private _subscriptions = new Map<string, Set<(value: RegistryChange) => void>>();
  private _revisions = new Map<string, number>();
  private _timer: NodeJS.Timeout | null;

  constructor({ maxInstances = 10000, sweepInterval = 1000, now = Date.now }: {
    maxInstances?: number;
    sweepInterval?: number;
    now?: () => number;
  } = {}) {
    super();
    if (!Number.isSafeInteger(maxInstances) || maxInstances < 1 || !Number.isSafeInteger(sweepInterval) || sweepInterval < 0 || typeof now !== 'function') {
      throw new TypeError('Invalid registry options');
    }
    this._now = now;
    this._max = maxInstances;
    this._timer = sweepInterval ? setInterval(() => this.sweep(), sweepInterval) : null;
    this._timer?.unref();
  }

  private _changed(service: string, reason: RegistryChange['reason']): void {
    const revision = (this._revisions.get(service) || 0) + 1;
    this._revisions.set(service, revision);
    notify(this._subscriptions, service, Object.freeze({ service, reason, revision }));
  }

  sweep(): void {
    const now = this._now();
    const changed = new Set<string>();
    for (const [key, record] of this._instances) {
      if (record.expiresAt <= now) {
        this._instances.delete(key);
        changed.add(record.service);
      }
    }
    for (const service of changed) this._changed(service, 'expired');
  }

  register(service: string, id: string, { url, ttl = 30000, metadata = {} }: RegistrationInput): Lease {
    name(service);
    name(id);
    duration(ttl);
    if (typeof url !== 'string' || url.length > 2048) throw new HttpError(400, 'Instance URL must be a string of at most 2048 characters');

    let address: URL;
    try { address = new URL(url); }
    catch { throw new HttpError(400, 'Invalid instance URL'); }

    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.hash || address.search) {
      throw new HttpError(400, 'Instance URL must be HTTP(S) without credentials, query or fragment');
    }

    const safeMetadata = jsonObject(metadata, 8192);
    this.sweep();
    const key = JSON.stringify([service, id]);
    if (this._instances.has(key)) throw new HttpError(409, 'Instance ID already has an active lease');
    if (this._instances.size >= this._max) throw new HttpError(503, 'Registry capacity reached');

    const record: Lease = {
      service,
      id,
      url: address.origin + address.pathname.replace(/\/$/, ''),
      metadata: safeMetadata,
      ttl,
      leaseId: randomUUID(),
      expiresAt: this._now() + ttl
    };
    this._instances.set(key, record);
    this._changed(service, 'registered');
    return { ...record };
  }

  private _owned(service: string, id: string, leaseId: string): Lease {
    name(service);
    name(id);
    this.sweep();
    const record = this._instances.get(JSON.stringify([service, id]));
    if (!record) throw new HttpError(404, 'Lease expired or instance not registered');
    if (typeof leaseId !== 'string' || record.leaseId !== leaseId) throw new HttpError(409, 'Lease belongs to another registration');
    return record;
  }

  renew(service: string, id: string, leaseId: string): Lease {
    const record = this._owned(service, id, leaseId);
    record.expiresAt = this._now() + record.ttl;
    return { ...record };
  }

  deregister(service: string, id: string, leaseId: string): void {
    this._owned(service, id, leaseId);
    this._instances.delete(JSON.stringify([service, id]));
    this._changed(service, 'deregistered');
  }

  list(service: string): Instance[] {
    name(service);
    this.sweep();
    return [...this._instances.values()]
      .filter(record => record.service === service)
      .map(({ leaseId: _leaseId, ...instance }) => ({ ...instance }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  snapshot(service: string): ServiceSnapshot {
    const instances = this.list(service);
    return Object.freeze({
      service,
      revision: this._revisions.get(service) || 0,
      instances: freeze(instances)
    });
  }

  subscribe(service: string, listener: () => void): () => void {
    name(service);
    return subscribe(this._subscriptions, service, listener);
  }

  close(): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._subscriptions.clear();
    this._revisions.clear();
  }
}

export class ConfigStore extends ConfigAdapter {
  private _entries = new Map<string, ConfigSnapshot>();
  private _max: number;
  private _maxBytes: number;
  private _epoch = randomUUID();
  private _subscriptions = new Map<string, Set<(value: ConfigSnapshot) => void>>();

  constructor({ maxNamespaces = 1000, maxBytes = 262144 }: {
    maxNamespaces?: number;
    maxBytes?: number;
  } = {}) {
    super();
    if (!Number.isSafeInteger(maxNamespaces) || maxNamespaces < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError('Invalid configuration limits');
    }
    this._max = maxNamespaces;
    this._maxBytes = maxBytes;
  }

  snapshot(namespace: string): ConfigSnapshot {
    name(namespace);
    return this._entries.get(namespace) || Object.freeze({
      namespace,
      epoch: this._epoch,
      revision: 0,
      values: Object.freeze({})
    });
  }

  replace(namespace: string, values: Record<string, unknown>, expectedRevision: number, expectedEpoch: string): ConfigSnapshot {
    name(namespace);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new HttpError(400, 'An expectedRevision is required');
    if (typeof expectedEpoch !== 'string' || !expectedEpoch) throw new HttpError(400, 'An expectedEpoch is required');

    const current = this.snapshot(namespace);
    if (current.revision !== expectedRevision || current.epoch !== expectedEpoch) {
      throw new HttpError(409, 'Configuration revision or epoch conflict');
    }
    if (!this._entries.has(namespace) && this._entries.size >= this._max) throw new HttpError(503, 'Configuration capacity reached');

    const snapshot = Object.freeze({
      namespace,
      epoch: this._epoch,
      revision: current.revision + 1,
      values: jsonObject(values, this._maxBytes)
    });
    this._entries.set(namespace, snapshot);
    notify(this._subscriptions, namespace, snapshot);
    return snapshot;
  }

  subscribe(namespace: string, listener: (snapshot?: ConfigSnapshot) => void): () => void {
    name(namespace);
    return subscribe(this._subscriptions, namespace, listener);
  }

  close(): void {
    this._subscriptions.clear();
  }
}
