import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  ConfigAdapterLike,
  RegistryAdapterLike
} from '../index.js';
import type { ConfigSnapshot, Lease, MaybePromise } from '../store.js';

export interface AdapterConformanceReport {
  adapter: 'registry' | 'config';
  checks: string[];
  supportsSnapshot?: boolean;
  supportsSubscribe: boolean;
  durabilityChecked: boolean;
}

export interface RegistryConformanceOptions {
  create: () => MaybePromise<RegistryAdapterLike>;
  reopen?: () => MaybePromise<RegistryAdapterLike>;
  url?: string;
  ttl?: number;
  timeout?: number;
}

export interface ConfigConformanceOptions {
  create: () => MaybePromise<ConfigAdapterLike>;
  reopen?: () => MaybePromise<ConfigAdapterLike>;
  timeout?: number;
}

function unique(prefix: string): string {
  return prefix + '-' + randomUUID().slice(0, 8);
}

async function expectRejection(action: () => MaybePromise<unknown>, label: string): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, label + ' must reject');
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? 1000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('Conformance timeout must be a positive integer');
  return timeout;
}

async function waitFor(signal: Promise<void>, timeout: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), timeout);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateLease(lease: Lease, service: string, id: string, url: string): void {
  assert.equal(lease.service, service);
  assert.equal(lease.id, id);
  assert.equal(lease.url, url);
  assert.equal(typeof lease.leaseId, 'string');
  assert.ok(lease.leaseId.length > 0);
  assert.ok(Number.isFinite(lease.expiresAt));
  assert.ok(Number.isSafeInteger(lease.ttl));
}

function validateConfigSnapshot(snapshot: ConfigSnapshot, namespace: string): void {
  assert.equal(snapshot.namespace, namespace);
  assert.equal(typeof snapshot.epoch, 'string');
  assert.ok(snapshot.epoch.length > 0);
  assert.ok(Number.isSafeInteger(snapshot.revision));
  assert.ok(snapshot.revision >= 0);
  assert.ok(snapshot.values && typeof snapshot.values === 'object' && !Array.isArray(snapshot.values));
}

export async function runRegistryAdapterConformance({
  create,
  reopen,
  url = 'http://127.0.0.1:3000',
  ttl = 60000,
  timeout: timeoutValue
}: RegistryConformanceOptions): Promise<AdapterConformanceReport> {
  if (typeof create !== 'function') throw new TypeError('Registry conformance requires create()');
  if (reopen !== undefined && typeof reopen !== 'function') throw new TypeError('reopen must be a function');
  if (!Number.isSafeInteger(ttl) || ttl < 1000) throw new TypeError('Registry conformance ttl must be at least 1000ms');
  const timeout = validateTimeout(timeoutValue);
  const service = unique('svc');
  const id = unique('node');
  const secondId = unique('node');
  const metadata = { conformance: true, generation: 1 };
  const checks: string[] = [];
  let adapter = await create();
  let unsubscribe: (() => void) | null = null;

  try {
    for (const method of ['register', 'renew', 'deregister', 'list'] as const) {
      assert.equal(typeof adapter[method], 'function', 'registry adapter missing ' + method);
    }

    const lease = await adapter.register(service, id, { url, ttl, metadata });
    validateLease(lease, service, id, url);
    assert.deepEqual(lease.metadata, metadata);
    checks.push('register');

    const listed = await adapter.list(service);
    const instance = listed.find(value => value.id === id);
    assert.ok(instance, 'registered instance must be discoverable');
    assert.equal(Object.prototype.hasOwnProperty.call(instance, 'leaseId'), false, 'list() must not expose leaseId');
    assert.deepEqual(instance.metadata, metadata);
    checks.push('list-without-lease-secret');

    await expectRejection(
      () => adapter.register(service, id, { url, ttl, metadata }),
      'duplicate active registration'
    );
    await expectRejection(
      () => adapter.renew(service, id, 'wrong-' + randomUUID()),
      'renew with a foreign lease'
    );
    checks.push('ownership-conflict');

    const renewed = await adapter.renew(service, id, lease.leaseId);
    validateLease(renewed, service, id, url);
    assert.equal(renewed.leaseId, lease.leaseId);
    assert.ok(renewed.expiresAt >= lease.expiresAt);
    checks.push('renew');

    const supportsSnapshot = typeof adapter.snapshot === 'function';
    if (supportsSnapshot) {
      const snapshot = await adapter.snapshot!(service);
      assert.equal(snapshot.service, service);
      assert.ok(snapshot.instances.some(value => value.id === id));
      if (snapshot.revision !== undefined) {
        assert.ok(Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0);
      }
      checks.push('snapshot');
    }

    const supportsSubscribe = typeof adapter.subscribe === 'function';
    if (supportsSubscribe) {
      let changed!: () => void;
      const notification = new Promise<void>(resolve => { changed = resolve; });
      unsubscribe = await adapter.subscribe!(service, changed);
      assert.equal(typeof unsubscribe, 'function', 'registry subscribe() must return unsubscribe');
      const second = await adapter.register(service, secondId, { url, ttl, metadata: { conformance: true, generation: 2 } });
      await waitFor(notification, timeout, 'registry subscription');
      await adapter.deregister(service, secondId, second.leaseId);
      checks.push('subscribe');
    }

    if (reopen) {
      await adapter.close?.();
      unsubscribe?.();
      unsubscribe = null;
      adapter = await reopen();
      const afterReopen = await adapter.list(service);
      assert.ok(afterReopen.some(value => value.id === id), 'durable registry must preserve an unexpired lease across reopen');
      checks.push('durability-reopen');
    }

    await expectRejection(
      () => adapter.deregister(service, id, 'wrong-' + randomUUID()),
      'deregister with a foreign lease'
    );
    await adapter.deregister(service, id, lease.leaseId);
    assert.equal((await adapter.list(service)).some(value => value.id === id), false);
    checks.push('deregister');

    return {
      adapter: 'registry',
      checks,
      supportsSnapshot,
      supportsSubscribe,
      durabilityChecked: !!reopen
    };
  } finally {
    unsubscribe?.();
    await adapter.close?.();
  }
}

export async function runConfigAdapterConformance({
  create,
  reopen,
  timeout: timeoutValue
}: ConfigConformanceOptions): Promise<AdapterConformanceReport> {
  if (typeof create !== 'function') throw new TypeError('Config conformance requires create()');
  if (reopen !== undefined && typeof reopen !== 'function') throw new TypeError('reopen must be a function');
  const timeout = validateTimeout(timeoutValue);
  const namespace = unique('cfg');
  const checks: string[] = [];
  let adapter = await create();
  let unsubscribe: (() => void) | null = null;

  try {
    for (const method of ['snapshot', 'replace'] as const) {
      assert.equal(typeof adapter[method], 'function', 'config adapter missing ' + method);
    }

    const initial = await adapter.snapshot(namespace);
    validateConfigSnapshot(initial, namespace);
    checks.push('snapshot');

    const supportsSubscribe = typeof adapter.subscribe === 'function';
    let notification: Promise<void> | null = null;
    if (supportsSubscribe) {
      let changed!: () => void;
      notification = new Promise<void>(resolve => { changed = resolve; });
      unsubscribe = await adapter.subscribe!(namespace, changed);
      assert.equal(typeof unsubscribe, 'function', 'config subscribe() must return unsubscribe');
    }

    const values = { enabled: true, nested: { generation: 1 } };
    const updated = await adapter.replace(namespace, values, initial.revision, initial.epoch);
    validateConfigSnapshot(updated, namespace);
    assert.ok(updated.revision > initial.revision);
    assert.deepEqual(updated.values, values);
    checks.push('replace-cas');

    if (notification) {
      await waitFor(notification, timeout, 'config subscription');
      checks.push('subscribe');
    }

    await expectRejection(
      () => adapter.replace(namespace, { stale: true }, initial.revision, initial.epoch),
      'stale configuration write'
    );
    checks.push('stale-write-rejected');

    const current = await adapter.snapshot(namespace);
    assert.equal(current.revision, updated.revision);
    assert.deepEqual(current.values, values);

    if (reopen) {
      await adapter.close?.();
      unsubscribe?.();
      unsubscribe = null;
      adapter = await reopen();
      const afterReopen = await adapter.snapshot(namespace);
      validateConfigSnapshot(afterReopen, namespace);
      assert.ok(afterReopen.revision >= updated.revision, 'durable config revision must not move backwards');
      assert.deepEqual(afterReopen.values, values, 'durable config values must survive reopen');
      checks.push('durability-reopen');
    }

    return {
      adapter: 'config',
      checks,
      supportsSubscribe,
      durabilityChecked: !!reopen
    };
  } finally {
    unsubscribe?.();
    await adapter.close?.();
  }
}
