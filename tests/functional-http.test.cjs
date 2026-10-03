const test = require('node:test');
const assert = require('node:assert/strict');
const openmesh = require('openmesh-node');
const { bodyParser } = require('openmesh-node/plugins');
const {
  POST,
  GET,
  pipe,
  input,
  returns,
  implement,
  api,
  created,
  ok,
  tap
} = require('openmesh-node/http');
const { serve, request } = require('./helpers.cjs');

function schema(name, check) {
  return {
    '~standard': {
      version: 1,
      vendor: 'openmesh-test',
      validate(value) {
        return check(value)
          ? { value }
          : { issues: [{ message: 'invalid ' + name }] };
      }
    }
  };
}

const NewUser = schema('NewUser', value => !!value && typeof value === 'object' && typeof value.name === 'string');
const User = schema('User', value => !!value && typeof value === 'object' && typeof value.id === 'string' && typeof value.name === 'string');
const UserParams = schema('UserParams', value => !!value && typeof value === 'object' && typeof value.id === 'string');

test('functional HTTP contracts compile to typed-style CRUD routes', async t => {
  const events = [];
  const createContract = pipe(
    POST('/users'),
    input({ body: NewUser }),
    returns({ 201: User }),
    tap('validated', ({ phase }) => events.push(phase)),
    tap('beforeHandler', ({ phase }) => events.push(phase)),
    tap('afterHandler', ({ phase }) => events.push(phase)),
    tap('beforeSend', ({ phase }) => events.push(phase)),
    tap('onResponse', ({ phase }) => events.push(phase))
  );

  const createUser = implement(createContract, async ({ body }) => {
    return created({ id: 'u-1', name: body.name });
  });

  const getUser = implement(
    pipe(
      GET('/users/:id'),
      input({ params: UserParams }),
      returns({ 200: User })
    ),
    async ({ params }) => ok({ id: params.id, name: 'Sam' })
  );

  const app = openmesh()
    .use(bodyParser())
    .register(api('/v1', createUser, getUser));

  const url = await serve(t, app);

  const createdResponse = await request(url, '/v1/users', {
    method: 'POST',
    body: { name: 'Sam' }
  });
  assert.equal(createdResponse.status, 201);
  assert.deepEqual(createdResponse.json(), { id: 'u-1', name: 'Sam' });

  const found = await request(url, '/v1/users/u-42');
  assert.equal(found.status, 200);
  assert.deepEqual(found.json(), { id: 'u-42', name: 'Sam' });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['validated', 'beforeHandler', 'afterHandler', 'beforeSend', 'onResponse']);
});

test('functional contracts reject invalid input and undeclared or invalid responses', async t => {
  const invalidInput = implement(
    pipe(
      POST('/users'),
      input({ body: NewUser }),
      returns({ 201: User })
    ),
    async ({ body }) => created({ id: 'u-1', name: body.name })
  );

  const badOutput = implement(
    pipe(GET('/bad-output'), returns({ 200: User })),
    async () => ok({ nope: true })
  );

  const badStatus = implement(
    pipe(GET('/bad-status'), returns({ 200: User })),
    async () => created({ id: 'u-1', name: 'Sam' })
  );

  const app = openmesh()
    .use(bodyParser())
    .register(api(invalidInput, badOutput, badStatus));

  const url = await serve(t, app);
  assert.equal((await request(url, '/users', { method: 'POST', body: { name: 42 } })).status, 400);
  assert.equal((await request(url, '/bad-output')).status, 500);
  assert.equal((await request(url, '/bad-status')).status, 500);
});

test('bodyParser handles json, urlencoded, text, raw and multipart bodies', async t => {
  const app = openmesh().use(bodyParser({ limit: 1024 * 1024, multipartLimit: 2 * 1024 * 1024 }));

  app.post('/echo', ctx => {
    const body = ctx.requestBody;
    if (Buffer.isBuffer(body)) return { kind: 'raw', text: body.toString('utf8') };
    if (typeof body === 'string') return { kind: 'text', value: body };
    if (body && typeof body === 'object' && body.file instanceof File) {
      return {
        kind: 'multipart',
        name: body.name,
        tags: body.tag,
        file: { name: body.file.name, size: body.file.size, type: body.file.type }
      };
    }
    return { kind: 'object', value: body };
  });

  const url = await serve(t, app);

  const json = await request(url, '/echo', { method: 'POST', body: { hello: 'world' } });
  assert.deepEqual(json.json(), { kind: 'object', value: { hello: 'world' } });

  const form = await request(url, '/echo', {
    method: 'POST',
    body: 'a=1&a=2&__proto__=safe',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  const formBodyValue = form.json();
  assert.equal(formBodyValue.kind, 'object');
  assert.deepEqual(formBodyValue.value.a, ['1', '2']);
  assert.equal(formBodyValue.value.__proto__, 'safe');

  const text = await request(url, '/echo', {
    method: 'POST',
    body: 'hello text',
    headers: { 'content-type': 'text/plain' }
  });
  assert.deepEqual(text.json(), { kind: 'text', value: 'hello text' });

  const raw = await request(url, '/echo', {
    method: 'POST',
    body: Buffer.from([1, 2, 3]),
    headers: { 'content-type': 'application/octet-stream' }
  });
  assert.deepEqual(raw.json(), { kind: 'raw', text: '\u0001\u0002\u0003' });

  const multipart = new FormData();
  multipart.append('name', 'Sam');
  multipart.append('tag', 'runtime');
  multipart.append('tag', 'typed');
  multipart.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');

  const multipartResponse = await fetch(url + '/echo', {
    method: 'POST',
    body: multipart
  });
  assert.equal(multipartResponse.status, 200);
  assert.deepEqual(await multipartResponse.json(), {
    kind: 'multipart',
    name: 'Sam',
    tags: ['runtime', 'typed'],
    file: { name: 'hello.txt', size: 5, type: 'text/plain' }
  });
});
