const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('redis');
const { RedisRegistryAdapter, RedisConfigAdapter } = require('openmesh-node/services/redis');
const { runRegistryAdapterConformance, runConfigAdapterConformance } = require('openmesh-node/services/testing');

const redisUrl = process.env.OPENMESH_REDIS_URL;

test('Redis adapters pass real conformance and preserve state across reopen', { skip: !redisUrl }, async t => {
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.quit()));
  });

  async function connectedClient() {
    const client = createClient({ url: redisUrl });
    client.on('error', () => {});
    await client.connect();
    clients.push(client);
    return client;
  }

  const prefix = 'openmesh-test-' + Date.now() + '-' + Math.random().toString(16).slice(2);

  const registryReport = await runRegistryAdapterConformance({
    create: async () => new RedisRegistryAdapter({
      client: await connectedClient(),
      prefix,
      watchInterval: 50
    }),
    reopen: async () => new RedisRegistryAdapter({
      client: await connectedClient(),
      prefix,
      watchInterval: 50
    }),
    ttl: 5000,
    timeout: 2000
  });

  assert.equal(registryReport.supportsSubscribe, true);
  assert.equal(registryReport.durabilityChecked, true);

  const configReport = await runConfigAdapterConformance({
    create: async () => new RedisConfigAdapter({
      client: await connectedClient(),
      prefix
    }),
    reopen: async () => new RedisConfigAdapter({
      client: await connectedClient(),
      prefix
    }),
    timeout: 2000
  });

  assert.equal(configReport.supportsSubscribe, true);
  assert.equal(configReport.durabilityChecked, true);
});

test('Redis registry watch observes lease expiry without Redis keyspace notifications', { skip: !redisUrl }, async t => {
  const client = createClient({ url: redisUrl });
  client.on('error', () => {});
  await client.connect();
  t.after(() => client.quit());

  const adapter = new RedisRegistryAdapter({
    client,
    prefix: 'openmesh-expiry-' + Date.now(),
    watchInterval: 50
  });
  t.after(() => adapter.close());

  const service = 'users';
  let resolveChange;
  const changed = new Promise(resolve => { resolveChange = resolve; });
  const unsubscribe = await adapter.subscribe(service, resolveChange);
  t.after(unsubscribe);

  await adapter.register(service, 'node-a', {
    url: 'http://127.0.0.1:3000',
    ttl: 1000
  });

  await changed;
  let expiredResolve;
  const expired = new Promise(resolve => { expiredResolve = resolve; });
  unsubscribe();

  const unsubscribeExpiry = await adapter.subscribe(service, expiredResolve);
  t.after(unsubscribeExpiry);

  await new Promise(resolve => setTimeout(resolve, 1150));
  await Promise.race([
    expired,
    new Promise((_, reject) => setTimeout(() => reject(new Error('expiry watch did not fire')), 1500))
  ]);

  assert.deepEqual(await adapter.list(service), []);
});
