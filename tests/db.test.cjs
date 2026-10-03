const test = require('node:test');
const assert = require('node:assert/strict');

const openmesh = require('openmesh-node');
const { database } = require('openmesh-node/db');

test('database resource manages lifecycle, health and transaction without wrapping the client API', async () => {
  const events = [];
  const client = {
    connected: false,
    users: {
      findMany() {
        return [{ id: 1, name: 'Sam' }];
      }
    }
  };

  const db = database(client, {
    name: 'primary',
    async connect(current) {
      events.push('connect');
      current.connected = true;
    },
    async disconnect(current) {
      events.push('disconnect');
      current.connected = false;
    },
    ping(current) {
      events.push('ping');
      return current.connected;
    },
    async transaction(current, work) {
      events.push('transaction');
      return work({
        ...current,
        transaction: true
      });
    }
  });

  const app = openmesh().register(db);

  assert.equal(db.client, client);
  assert.equal(db.name, 'primary');
  assert.equal(db.state, 'idle');
  assert.equal(db.ready, false);
  assert.equal(db.supportsTransactions, true);
  assert.deepEqual(db.client.users.findMany(), [{ id: 1, name: 'Sam' }]);

  await app.ready();

  assert.equal(db.state, 'ready');
  assert.equal(db.ready, true);
  assert.equal(await db.healthy(), true);

  const result = await db.transaction(async tx => {
    assert.equal(tx.transaction, true);
    assert.equal(tx.connected, true);
    return tx.users.findMany()[0];
  });
  assert.deepEqual(result, { id: 1, name: 'Sam' });

  await app.close();
  await app.close();

  assert.equal(db.state, 'closed');
  assert.equal(db.ready, false);
  assert.deepEqual(events, ['connect', 'ping', 'transaction', 'disconnect']);
});

test('database resource supports connectionless clients and multiple named databases', async () => {
  const primaryClient = { dialect: 'drizzle' };
  const analyticsClient = { dialect: 'kysely', destroyed: false };

  const primary = database(primaryClient, { name: 'primary' });
  const analytics = database(analyticsClient, {
    name: 'analytics',
    disconnect(client) {
      client.destroyed = true;
    }
  });

  const app = openmesh()
    .register(primary)
    .register(analytics);

  await app.ready();

  assert.equal(primary.client, primaryClient);
  assert.equal(analytics.client, analyticsClient);
  assert.equal(primary.ready, true);
  assert.equal(analytics.ready, true);
  assert.equal(await primary.healthy(), true);
  assert.equal(primary.supportsTransactions, false);

  await assert.rejects(
    primary.transaction(async tx => tx),
    /has no transaction adapter/
  );

  await app.close();
  assert.equal(analyticsClient.destroyed, true);
});

test('database resource fails startup closed and runs cleanup after connect failure', async () => {
  const client = { opened: false, closed: false };
  const db = database(client, {
    name: 'broken',
    async connect(current) {
      current.opened = true;
      throw new Error('database unavailable');
    },
    async disconnect(current) {
      current.closed = true;
    }
  });

  const app = openmesh().register(db);

  await assert.rejects(app.ready(), /database unavailable/);
  assert.equal(client.opened, true);
  assert.equal(client.closed, true);
  assert.equal(db.state, 'closed');
  assert.equal(await db.healthy(), false);
});

test('database health checks fail closed without throwing into readiness probes', async () => {
  const falseHealth = database({}, {
    name: 'false-health',
    ping: () => false
  });
  const throwingHealth = database({}, {
    name: 'throwing-health',
    ping: () => {
      throw new Error('lost connection');
    }
  });

  const app = openmesh()
    .register(falseHealth)
    .register(throwingHealth);

  await app.ready();

  assert.equal(await falseHealth.healthy(), false);
  assert.equal(await throwingHealth.healthy(), false);

  await app.close();
});

test('database validates resource names and lifecycle callbacks', () => {
  assert.throws(() => database(null), /client must be an object/);
  assert.throws(() => database({}, { name: 'bad name' }), /database name/);
  assert.throws(() => database({}, { connect: true }), /connect must be a function/);
  assert.throws(() => database({}, { transaction: 'yes' }), /transaction must be a function/);
});
