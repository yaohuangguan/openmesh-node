const test = require('node:test');
const assert = require('node:assert/strict');

const openmesh = require('openmesh-node');
const { created, noContent, reply } = openmesh;
const { bodyParser } = require('openmesh-node/plugins');
const { database } = require('openmesh-node/db');
const { serve, request } = require('./helpers.cjs');

function schema(name, validate) {
  return {
    '~standard': {
      version: 1,
      vendor: 'openmesh-crud-test',
      validate(value) {
        const result = validate(value);
        return result && result.ok
          ? { value: result.value }
          : { issues: [{ message: 'invalid ' + name }] };
      }
    }
  };
}

const User = schema('User', value => (
  value && typeof value === 'object' &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.email === 'string'
    ? { ok: true, value }
    : { ok: false }
));

const Users = schema('Users', value => (
  Array.isArray(value) && value.every(user => (
    user && typeof user.id === 'string' &&
    typeof user.name === 'string' &&
    typeof user.email === 'string'
  ))
    ? { ok: true, value }
    : { ok: false }
));

const UserParams = schema('UserParams', value => (
  value && typeof value === 'object' && typeof value.id === 'string'
    ? { ok: true, value: { id: value.id } }
    : { ok: false }
));

const CreateUser = schema('CreateUser', value => (
  value && typeof value === 'object' &&
  typeof value.name === 'string' &&
  typeof value.email === 'string'
    ? {
        ok: true,
        value: {
          name: value.name.trim(),
          email: value.email.trim().toLowerCase()
        }
      }
    : { ok: false }
));

const ReplaceUser = CreateUser;

const PatchUser = schema('PatchUser', value => {
  if (!value || typeof value !== 'object') return { ok: false };
  const result = {};
  if ('name' in value) {
    if (typeof value.name !== 'string') return { ok: false };
    result.name = value.name.trim();
  }
  if ('email' in value) {
    if (typeof value.email !== 'string') return { ok: false };
    result.email = value.email.trim().toLowerCase();
  }
  return Object.keys(result).length
    ? { ok: true, value: result }
    : { ok: false };
});

const UserQuery = schema('UserQuery', value => (
  value && typeof value === 'object'
    ? {
        ok: true,
        value: {
          q: typeof value.q === 'string' ? value.q.trim().toLowerCase() : ''
        }
      }
    : { ok: false }
));

const Problem = schema('Problem', value => (
  value && typeof value === 'object' && typeof value.code === 'string'
    ? { ok: true, value }
    : { ok: false }
));

function createRepository() {
  const rows = new Map();
  let connected = false;
  let transactionCount = 0;

  return {
    get connected() {
      return connected;
    },
    get transactionCount() {
      return transactionCount;
    },
    connect() {
      connected = true;
    },
    disconnect() {
      connected = false;
    },
    ping() {
      return connected;
    },
    list(q = '') {
      return Array.from(rows.values())
        .filter(user => !q || user.name.toLowerCase().includes(q) || user.email.includes(q));
    },
    get(id) {
      return rows.get(id) || null;
    },
    create(user) {
      if (rows.has(user.id)) return null;
      rows.set(user.id, { ...user });
      return rows.get(user.id);
    },
    replace(id, value) {
      if (!rows.has(id)) return null;
      rows.set(id, { id, ...value });
      return rows.get(id);
    },
    patch(id, value) {
      const current = rows.get(id);
      if (!current) return null;
      const next = { ...current, ...value };
      rows.set(id, next);
      return next;
    },
    delete(id) {
      return rows.delete(id);
    },
    async transaction(work) {
      transactionCount++;
      return work(this);
    }
  };
}

test('typed CRUD and database resource form a complete application path', async t => {
  const repository = createRepository();

  const db = database(repository, {
    name: 'primary',
    connect: client => client.connect(),
    disconnect: client => client.disconnect(),
    ping: client => client.ping(),
    transaction: (client, work) => client.transaction(work)
  });

  const app = openmesh()
    .use(bodyParser())
    .register(db);

  app.get('/users', {
    query: UserQuery,
    response: Users
  }, async ({ query }) => db.client.list(query.q));

  app.post('/users/:id', {
    params: UserParams,
    body: CreateUser,
    response: {
      201: User,
      409: Problem
    }
  }, async ({ params, body }) => db.transaction(async tx => {
    const user = tx.create({ id: params.id, ...body });
    return user
      ? created(user)
      : reply(409, { code: 'USER_EXISTS' });
  }));

  app.get('/users/:id', {
    params: UserParams,
    response: {
      200: User,
      404: Problem
    }
  }, async ({ params }) => {
    const user = db.client.get(params.id);
    return user || reply(404, { code: 'USER_NOT_FOUND' });
  });

  app.put('/users/:id', {
    params: UserParams,
    body: ReplaceUser,
    response: {
      200: User,
      404: Problem
    }
  }, async ({ params, body }) => {
    const user = db.client.replace(params.id, body);
    return user || reply(404, { code: 'USER_NOT_FOUND' });
  });

  app.patch('/users/:id', {
    params: UserParams,
    body: PatchUser,
    response: {
      200: User,
      404: Problem
    }
  }, async ({ params, body }) => {
    const user = db.client.patch(params.id, body);
    return user || reply(404, { code: 'USER_NOT_FOUND' });
  });

  app.delete('/users/:id', {
    params: UserParams,
    response: {
      204: null,
      404: Problem
    }
  }, async ({ params }) => (
    db.client.delete(params.id)
      ? noContent()
      : reply(404, { code: 'USER_NOT_FOUND' })
  ));

  const url = await serve(t, app);
  assert.equal(db.ready, true);
  assert.equal(db.client.connected, true);
  assert.equal(await db.healthy(), true);

  const createdUser = await request(url, '/users/u-1', {
    method: 'POST',
    body: { name: '  Sam  ', email: ' SAM@EXAMPLE.COM ' }
  });
  assert.equal(createdUser.status, 201);
  assert.deepEqual(createdUser.json(), {
    id: 'u-1',
    name: 'Sam',
    email: 'sam@example.com'
  });
  assert.equal(db.client.transactionCount, 1);

  const duplicate = await request(url, '/users/u-1', {
    method: 'POST',
    body: { name: 'Sam', email: 'sam@example.com' }
  });
  assert.equal(duplicate.status, 409);

  const single = await request(url, '/users/u-1');
  assert.equal(single.status, 200);
  assert.equal(single.json().name, 'Sam');

  const list = await request(url, '/users?q=sam');
  assert.equal(list.status, 200);
  assert.equal(list.json().length, 1);

  const replaced = await request(url, '/users/u-1', {
    method: 'PUT',
    body: { name: 'Samuel', email: 'samuel@example.com' }
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.json().name, 'Samuel');

  const patched = await request(url, '/users/u-1', {
    method: 'PATCH',
    body: { name: 'Sam Yao' }
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.json(), {
    id: 'u-1',
    name: 'Sam Yao',
    email: 'samuel@example.com'
  });

  const removed = await request(url, '/users/u-1', { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(removed.text, '');

  const missing = await request(url, '/users/u-1');
  assert.equal(missing.status, 404);

  await app.close();
  assert.equal(db.ready, false);
  assert.equal(db.client.connected, false);
});
