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
