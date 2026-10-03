const test = require('node:test');
const assert = require('node:assert/strict');
const openmesh = require('openmesh-node');
const { created, reply } = openmesh;
const { bodyParser } = require('openmesh-node/plugins');
const { serve, request } = require('./helpers.cjs');

function schema(name, validate) {
  return {
    '~standard': {
      version: 1,
      vendor: 'openmesh-test',
      validate(value) {
        const result = validate(value);
        return result && result.ok
          ? { value: result.value }
          : { issues: [{ message: 'invalid ' + name }] };
      }
    }
  };
}

const NewUser = schema('NewUser', value => (
  value && typeof value === 'object' && typeof value.name === 'string'
    ? { ok: true, value: { name: value.name.trim() } }
    : { ok: false }
));

const UserParams = schema('UserParams', value => (
  value && typeof value === 'object' && typeof value.id === 'string'
    ? { ok: true, value: { id: value.id } }
    : { ok: false }
));

const User = schema('User', value => (
  value && typeof value === 'object' && typeof value.id === 'string' && typeof value.name === 'string'
    ? { ok: true, value }
    : { ok: false }
));

const Problem = schema('Problem', value => (
  value && typeof value === 'object' && typeof value.code === 'string'
    ? { ok: true, value }
    : { ok: false }
));

test('simple typed CRUD shorthand validates and transforms without a compiler', async t => {
  const phases = [];
  const app = openmesh().use(bodyParser());

  app.post('/users/:id', {
    body: NewUser,
    params: UserParams,
    response: {
      201: User,
      409: Problem
    },
    hooks: {
      preValidation(ctx) {
        phases.push('preValidation');
        assert.equal(typeof ctx.requestBody, 'object');
      },
      preHandler() {
        phases.push('preHandler');
      }
    }
  }, async ({ body, params, method, route }) => {
    phases.push('handler');
    assert.equal(method, 'POST');
    assert.equal(route, '/users/:id');
    assert.deepEqual(body, { name: 'Sam' });
    assert.deepEqual(params, { id: 'u-1' });
    return created({ id: params.id, name: body.name });
  });

  app.post('/users/conflict', {
    body: NewUser,
    response: {
      201: User,
      409: Problem
    }
  }, async ({ body }) => {
    return reply(409, { code: 'NAME_TAKEN', name: body.name });
  });

  const url = await serve(t, app);

  const ok = await request(url, '/users/u-1', {
    method: 'POST',
    body: { name: '  Sam  ' }
  });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json(), { id: 'u-1', name: 'Sam' });
  assert.deepEqual(phases, ['preValidation', 'preHandler', 'handler']);

  const invalid = await request(url, '/users/u-2', {
    method: 'POST',
    body: { name: 42 }
  });
  assert.equal(invalid.status, 400);

  const conflict = await request(url, '/users/conflict', {
    method: 'POST',
    body: { name: 'Sam' }
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json(), { code: 'NAME_TAKEN', name: 'Sam' });
});

test('simple typed CRUD shorthand rejects undeclared or invalid responses', async t => {
  const app = openmesh();

  app.get('/bad-status', {
    response: {
      200: User
    }
  }, async () => created({ id: 'u-1', name: 'Sam' }));

  app.get('/bad-body', {
    response: User
  }, async () => ({ id: 42, name: 'Sam' }));

  const url = await serve(t, app);
  assert.equal((await request(url, '/bad-status')).status, 500);
  assert.equal((await request(url, '/bad-body')).status, 500);
});
