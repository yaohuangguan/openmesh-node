const test = require('node:test');
const assert = require('node:assert/strict');
const openmesh = require('../index.cjs');
const { ServiceRegistry, ConfigStore, controlPlane, ControlClient, serviceRegistration } = require('../services/index.cjs');
const { PeerPool } = require('../mesh/index.cjs');
const { serve, request } = require('./helpers.cjs');
const token = 'test-control-plane-token-123456';

test('registration leases expire; stale owners cannot remove a replacement', () => {
  let now = 10000; const registry = new ServiceRegistry({ now: () => now, sweepInterval: 0 });
  const first = registry.register('users', 'a', { url: 'http://localhost:4001', ttl: 1000 });
  assert.throws(() => registry.register('users', 'a', { url: 'http://localhost:4002' }), error => error.statusCode === 409);
  assert.equal(registry.list('users')[0].leaseId, undefined);
  now += 1001; assert.deepEqual(registry.list('users'), []);
  const second = registry.register('users', 'a', { url: 'http://localhost:4002', ttl: 1000 });
  assert.throws(() => registry.deregister('users', 'a', first.leaseId), error => error.statusCode === 409);
  now += 500; registry.renew('users', 'a', second.leaseId); now += 501;
  assert.equal(registry.list('users').length, 1); registry.deregister('users', 'a', second.leaseId); assert.deepEqual(registry.list('users'), []);
});

test('configuration updates use CAS and immutable bounded snapshots', () => {
  const config = new ConfigStore({ maxBytes: 100 });
  assert.equal(config.snapshot('users').revision, 0);
  const epoch = config.snapshot('users').epoch;
  const value = { nested: { enabled: true } }, first = config.replace('users', value, 0, epoch);
  value.nested.enabled = false; assert.equal(first.values.nested.enabled, true); assert.equal(Object.isFrozen(first.values.nested), true);
  assert.throws(() => config.replace('users', {}, 0, epoch), error => error.statusCode === 409);
  assert.throws(() => config.replace('users', {}, 1, 'old-server-epoch'), error => error.statusCode === 409);
  assert.throws(() => config.replace('users', { huge: 'x'.repeat(101) }, 1, epoch), error => error.statusCode === 413);
  assert.equal(config.snapshot('users').revision, 1);
  assert.equal(config.replace('users', { enabled: false }, 1, epoch).revision, 2);
});

test('real control-plane HTTP requires authentication and supports registration/discovery/configuration', async t => {
  const app = openmesh().register(controlPlane({ token })); const url = await serve(t, app);
  assert.equal((await request(url, '/_mesh/services/users')).status, 401);
  const client = new ControlClient({ url: url + '/_mesh', token }); t.after(() => client.close());
  const registration = await client.register('users', { id: 'a', url: url, ttl: 1000 });
  assert.equal(registration.healthy, true); assert.equal((await client.discover('users'))[0].id, 'a');
  const snapshot = await client.getConfig('users');
  await client.setConfig('users', { feature: true }, { expectedRevision: 0, expectedEpoch: snapshot.epoch });
  await assert.rejects(client.setConfig('users', {}, { expectedRevision: 0, expectedEpoch: snapshot.epoch }), error => error.statusCode === 409);
  assert.equal((await client.getConfig('users')).values.feature, true);
  await registration.stop(); assert.deepEqual(await client.discover('users'), []); assert.equal(registration.healthy, false);
});

test('server registers its actual listening address and deregisters on shutdown', async t => {
  const control = await serve(t, openmesh().register(controlPlane({ token })));
  const client = new ControlClient({ url: control + '/_mesh', token });
  const app = openmesh().register(serviceRegistration({ client, service: 'users', id: 'a', ttl: 1000, url: address => 'http://127.0.0.1:' + address.port })).get('/', () => ({ alive: true }));
  try {
    const address = await app.listen({ port: 0 }); const instances = await client.discover('users');
    assert.equal(instances[0].url, 'http://127.0.0.1:' + address.port);
    const pool = new PeerPool({ peers: instances }); try { assert.deepEqual(await pool.json('/'), { alive: true }); } finally { pool.close(); }
    await app.close(); assert.deepEqual(await client.discover('users'), []);
  } finally { await app.close(); await client.close(); }
});

test('failed registration startup closes the bound server and cleanup hooks', async () => {
  let server; let cleaned = false;
  const app = openmesh(); app.onClose(() => { cleaned = true; });
  app.onListen(scope => { server = scope.server; throw new Error('registration unavailable'); });
  await assert.rejects(app.listen({ port: 0 }), /registration unavailable/);
  assert.equal(server.listening, false); assert.equal(cleaned, true); assert.equal(app.phase, 'closed');
});

test('shutdown waits for registration hooks and then cleans their resources', async () => {
  let started; const entering = new Promise(resolve => { started = resolve; });
  let complete; const gate = new Promise(resolve => { complete = resolve; }); let registered = false;
  const app = openmesh();
  app.onListen(async () => { started(); await gate; registered = true; });
  app.onClose(() => { assert.equal(registered, true); registered = false; });
  const listening = app.listen({ port: 0 }); await entering;
  const closing = app.close(); complete(); await listening; await closing;
  assert.equal(registered, false); assert.equal(app.server.listening, false);
});

test('configuration watcher applies updates atomically and preserves last good state on failure', async t => {
  const app = openmesh().register(controlPlane({ token })); const url = await serve(t, app);
  const client = new ControlClient({ url: url + '/_mesh', token, timeout: 100 });
  let notify; const changed = new Promise(resolve => { notify = resolve; });
  const watcher = await client.watchConfig('users', { interval: 50, onUpdate: snapshot => notify(snapshot), validate: values => {
    if (values.feature !== undefined && typeof values.feature !== 'boolean') throw new Error('feature must be boolean');
  } });
  try {
    assert.equal(watcher.get('feature', false), false);
    await client.setConfig('users', { feature: true }, { expectedRevision: 0, expectedEpoch: watcher.snapshot.epoch });
    let timer;
    const updated = await Promise.race([changed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Watcher did not refresh')), 2000); })]).finally(() => clearTimeout(timer));
    assert.equal(updated.revision, 1); assert.equal(watcher.get('feature'), true);
    await client.setConfig('users', { feature: 'invalid' }, { expectedRevision: 1, expectedEpoch: watcher.snapshot.epoch });
    await watcher._refresh(); assert.match(watcher.lastError.message, /must be boolean/); assert.equal(watcher.snapshot.revision, 1); assert.equal(watcher.get('feature'), true);
    await app.close(); await watcher._refresh(); assert.ok(watcher.lastError); assert.equal(watcher.get('feature'), true);
    watcher.stop(); assert.equal(client._watchers.size, 0);
  } finally { watcher.stop(); await client.close(); }
});

test('automatic heartbeat renews a real lease and recovers after registry expiry', async t => {
  let now = Date.now(); const registry = new ServiceRegistry({ now: () => now, sweepInterval: 0 });
  const url = await serve(t, openmesh().register(controlPlane({ token, registry })));
  const client = new ControlClient({ url: url + '/_mesh', token });
  const registration = await client.register('users', { id: 'a', url, ttl: 1000 });
  try {
    const first = registration.record.leaseId;
    now += 1001; assert.equal(registry.list('users').length, 0);
    await registration._renew(); assert.notEqual(registration.record.leaseId, first); assert.equal(registry.list('users').length, 1);
    const renewedExpiry = registration.record.expiresAt; now += 600;
    const deadline = Date.now() + 2500;
    while (registration.record.expiresAt <= renewedExpiry) {
      if (Date.now() >= deadline) throw new Error('Automatic heartbeat did not renew');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    now += 600;
    assert.equal(registry.list('users').length, 1);
  } finally { await registration.stop(); await client.close(); registry.close(); }
});

test('discovery follows bounded pages without losing instance IDs', async t => {
  const registry = new ServiceRegistry({ sweepInterval: 0 });
  for (let index = 0; index < 205; index++) registry.register('users', 'node-' + String(index).padStart(3, '0'), { url: 'http://127.0.0.1:3000', metadata: { index } });
  for (const id of ['A', 'a', 'Z', 'z', 'a_', 'a-', 'a.']) registry.register('users', id, { url: 'http://127.0.0.1:3000' });
  let calls = 0; const app = openmesh().use(async (ctx, next) => { if (ctx.path === '/_mesh/services/users') calls++; await next(); }).register(controlPlane({ token, registry }));
  const url = await serve(t, app), client = new ControlClient({ url: url + '/_mesh', token });
  try { const members = await client.discover('users'); assert.equal(members.length, 212); assert.deepEqual(members.map(member => member.id), registry.list('users').map(member => member.id)); assert.equal(new Set(members.map(member => member.id)).size, 212); assert.equal(calls, 3); }
  finally { await client.close(); registry.close(); }
});


test('control plane accepts asynchronous registry and config adapters', async t => {
  const memoryRegistry = new ServiceRegistry({ sweepInterval: 0 }), memoryConfig = new ConfigStore();
  const registry = {
    register: async (...args) => memoryRegistry.register(...args),
    renew: async (...args) => memoryRegistry.renew(...args),
    deregister: async (...args) => memoryRegistry.deregister(...args),
    list: async (...args) => memoryRegistry.list(...args),
    subscribe: (...args) => memoryRegistry.subscribe(...args)
  };
  const config = {
    snapshot: async (...args) => memoryConfig.snapshot(...args),
    replace: async (...args) => memoryConfig.replace(...args),
    subscribe: (...args) => memoryConfig.subscribe(...args)
  };
  const url = await serve(t, openmesh().register(controlPlane({ token, registry, config })));
  const client = new ControlClient({ url: url + '/_mesh', token });
  try {
    const registration = await client.register('users', { id: 'async-a', url, ttl: 1000 });
    assert.equal((await client.discover('users'))[0].id, 'async-a');
    const snapshot = await client.getConfig('users');
    const updated = await client.setConfig('users', { adapter: 'async' }, { expectedRevision: snapshot.revision, expectedEpoch: snapshot.epoch });
    assert.equal(updated.values.adapter, 'async');
    await registration.stop();
  } finally {
    await client.close();
    memoryRegistry.close();
    memoryConfig.close();
  }
});

test('streaming config watch pushes updates without waiting for polling interval', async t => {
  const app = openmesh().register(controlPlane({ token })), url = await serve(t, app);
  const client = new ControlClient({ url: url + '/_mesh', token, timeout: 500 });
  let resolveUpdate;
  const update = new Promise(resolve => { resolveUpdate = resolve; });
  const watcher = await client.watchConfig('users', { interval: 10000, reconnectDelay: 50, onUpdate: resolveUpdate });
  try {
    const started = Date.now();
    await client.setConfig('users', { pushed: true }, { expectedRevision: watcher.snapshot.revision, expectedEpoch: watcher.snapshot.epoch });
    const snapshot = await Promise.race([update, new Promise((_, reject) => setTimeout(() => reject(new Error('stream update timed out')), 1000))]);
    assert.equal(snapshot.values.pushed, true);
    assert.ok(Date.now() - started < 1000);
  } finally {
    watcher.stop();
    await client.close();
  }
});

test('service watch pushes membership changes and control-plane shutdown closes streams promptly', async t => {
  const app = openmesh({ shutdownTimeout: 5000 }).register(controlPlane({ token }));
  const url = await serve(t, app);
  const client = new ControlClient({ url: url + '/_mesh', token, timeout: 500 });
  let resolveUpdate;
  const update = new Promise(resolve => { resolveUpdate = resolve; });
  const watcher = await client.watchService('users', { reconnectDelay: 50, onUpdate: resolveUpdate });
  const registration = await client.register('users', { id: 'stream-a', url, ttl: 1000 });
  try {
    const instances = await Promise.race([update, new Promise((_, reject) => setTimeout(() => reject(new Error('service stream update timed out')), 1000))]);
    assert.deepEqual(instances.map(instance => instance.id), ['stream-a']);
    const started = Date.now();
    await app.close();
    assert.ok(Date.now() - started < 1500, 'shutdown should close watch streams before the 5s force timeout');
  } finally {
    watcher.stop();
    await registration.stop().catch(() => {});
    await client.close().catch(() => {});
  }
});


test('service watch falls back to polling when an adapter has no subscriptions', async t => {
  const memory = new ServiceRegistry({ sweepInterval: 0 });
  const registry = {
    register: async (...args) => memory.register(...args),
    renew: async (...args) => memory.renew(...args),
    deregister: async (...args) => memory.deregister(...args),
    list: async (...args) => memory.list(...args)
  };
  const app = openmesh().register(controlPlane({ token, registry })), url = await serve(t, app);
  const client = new ControlClient({ url: url + '/_mesh', token, timeout: 500 });
  let resolveUpdate;
  const updated = new Promise(resolve => { resolveUpdate = resolve; });
  const watcher = await client.watchService('users', { interval: 50, reconnectDelay: 50, onUpdate: resolveUpdate });
  const registration = await client.register('users', { id: 'poll-a', url, ttl: 1000 });
  try {
    const instances = await Promise.race([updated, new Promise((_, reject) => setTimeout(() => reject(new Error('poll fallback timed out')), 1000))]);
    assert.deepEqual(instances.map(instance => instance.id), ['poll-a']);
    assert.equal(watcher._transport, 'poll');
  } finally {
    watcher.stop();
    await registration.stop();
    await client.close();
    memory.close();
  }
});


test('service snapshots carry monotonic revisions for membership changes', () => {
  let now = Date.now();
  const registry = new ServiceRegistry({ now: () => now, sweepInterval: 0 });
  try {
    assert.equal(registry.snapshot('users').revision, 0);
    const a = registry.register('users', 'a', { url: 'http://127.0.0.1:3000', ttl: 1000 });
    assert.equal(registry.snapshot('users').revision, 1);
    registry.register('users', 'b', { url: 'http://127.0.0.1:3001', ttl: 1000 });
    assert.equal(registry.snapshot('users').revision, 2);
    registry.deregister('users', 'a', a.leaseId);
    assert.equal(registry.snapshot('users').revision, 3);
    now += 1001;
    const expired = registry.snapshot('users');
    assert.equal(expired.revision, 4);
    assert.deepEqual(expired.instances, []);
  } finally { registry.close(); }
});

test('discovery restarts when membership revision changes between pages', async t => {
  let calls = 0;
  const instances = Array.from({ length: 101 }, (_, index) => ({
    service: 'users', id: 'node-' + String(index).padStart(3, '0'), url: 'http://127.0.0.1:3000',
    ttl: 30000, expiresAt: Date.now() + 30000, metadata: {}
  }));
  const registry = {
    register() { throw new Error('unused'); }, renew() { throw new Error('unused'); }, deregister() { throw new Error('unused'); },
    list() { return instances; },
    snapshot() {
      calls++;
      const revision = calls === 2 ? 2 : 1;
      return { service: 'users', revision, instances };
    }
  };
  const url = await serve(t, openmesh().register(controlPlane({ token, registry })));
  const client = new ControlClient({ url: url + '/_mesh', token, timeout: 1000 });
  try {
    const found = await client.discover('users');
    assert.equal(found.length, 101);
    assert.ok(calls >= 4, 'client should restart pagination after a revision mismatch');
  } finally { await client.close(); }
});
