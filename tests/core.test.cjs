const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const http = require('node:http');
const openmesh = require('../index.cjs');
const { definePlugin } = openmesh;
const { jsonBody, requestContext, health } = require('../plugins/index.cjs');
const { serve, request } = require('./helpers.cjs');

test('sync/async handlers, JSON, bytes, streams and empty replies', async t => {
  const app = openmesh().get('/', () => ({ hello: 'world' })).get('/async', async () => 'async').get('/bytes', () => Buffer.from('bytes')).get('/stream', () => Readable.from(['a', 'b'])).get('/empty', () => {});
  const url = await serve(t, app);
  assert.deepEqual((await request(url)).json(), { hello: 'world' }); assert.equal((await request(url, '/async')).text, 'async');
  assert.equal((await request(url, '/bytes')).text, 'bytes'); assert.equal((await request(url, '/stream')).text, 'ab'); assert.equal((await request(url, '/empty')).status, 204);
});
test('static, parameters, wildcard, backtracking and strict trailing slashes', async t => {
  const app = openmesh().get('/users/me', () => 'static').get('/users/:id', ctx => ctx.params.id).get('/users/new/other', () => 'other').get('/users/:id/profile', ctx => ctx.params.id).get('/files/*', ctx => ctx.params['*']);
  const url = await serve(t, app);
  assert.equal((await request(url, '/users/me')).text, 'static'); assert.equal((await request(url, '/users/new/profile')).text, 'new');
  assert.equal((await request(url, '/users/%F0%9F%8C%90')).text, '🌐'); assert.equal((await request(url, '/users/%ZZ')).status, 400);
  assert.equal((await request(url, '/files/a/b')).text, 'a/b'); assert.equal((await request(url, '/users/me/')).status, 404);
});
test('HEAD fallback, 404, 405 and bodyless statuses', async t => {
  const app = openmesh().get('/', () => 'hello').get('/empty', ctx => { ctx.status = 204; return 'discarded'; });
  const url = await serve(t, app), head = await request(url, '/', { method: 'HEAD' }), missing = await request(url, '/missing'), wrong = await request(url, '/', { method: 'POST' });
  assert.equal(head.text, ''); assert.equal(head.headers['content-length'], '5'); assert.equal(missing.status, 404); assert.equal(wrong.status, 405); assert.match(wrong.headers.allow, /GET/); assert.match(wrong.headers.allow, /HEAD/);
  const empty = await request(url, '/empty'); assert.equal(empty.text, ''); assert.equal(empty.headers['content-length'], undefined);
});
test('onion order, late middleware and route middleware', async t => {
  const order = [], app = openmesh();
  app.get('/', { middleware: async (ctx, next) => { order.push('route-in'); await next(); order.push('route-out'); } }, () => { order.push('handler'); return 'ok'; });
  app.use(async (ctx, next) => { order.push('root-in'); await next(); ctx.set('x-after', 'yes'); order.push('root-out'); });
  const url = await serve(t, app); assert.equal((await request(url)).headers['x-after'], 'yes');
  assert.deepEqual(order, ['root-in', 'route-in', 'handler', 'route-out', 'root-out']);
});
test('double next and rejected handlers reach error handler once', async t => {
  const app = openmesh(), errors = [];
  app.use(async (ctx, next) => { await next(); await next(); }); app.get('/', () => 'ok');
  app.setErrorHandler((error, ctx) => { errors.push(error.message); ctx.status = 500; return { handled: true }; });
  const url = await serve(t, app); assert.deepEqual((await request(url)).json(), { handled: true }); assert.equal(errors.length, 1); assert.match(errors[0], /more than once/);
});
test('plugin scopes, prefixes, decorators and callback startup order', async t => {
  const app = openmesh();
  app.register(definePlugin((scope, options, done) => { scope.decorate('shared', 42); done(); }, { name: 'shared', global: true }));
  app.register(async scope => { scope.decorate('onlyHere', 'private'); scope.use(async (ctx, next) => { ctx.set('x-scope', 'yes'); await next(); }); scope.get('/value', ctx => ({ value: ctx.app.shared, private: ctx.app.onlyHere })); scope.register(child => { child.get('/nested', () => 'nested'); }, { prefix: '/sub' }); }, { prefix: '/api' });
  app.get('/outside', ctx => ({ visible: ctx.app.onlyHere === undefined }));
  const url = await serve(t, app);
  assert.deepEqual((await request(url, '/api/value')).json(), { value: 42, private: 'private' }); assert.equal((await request(url, '/api/sub/nested')).text, 'nested');
  const outside = await request(url, '/outside'); assert.equal(outside.headers['x-scope'], undefined); assert.deepEqual(outside.json(), { visible: true }); assert.equal(app.hasPlugin('shared'), true);
});
test('startup failures close resources and missing dependencies are explicit', async () => {
  const events = [], app = openmesh();
  app.register(definePlugin(scope => { scope.onClose(() => events.push('closed')); }, { name: 'resource', global: true }));
  app.register(definePlugin(() => {}, { dependencies: ['missing'] }));
  await assert.rejects(app.ready(), /Missing plugin dependency/); assert.deepEqual(events, ['closed']);
  await app.close(); assert.deepEqual(events, ['closed']);
});
test('callback works without plugins and configuration freezes', async t => {
  const app = openmesh().get('/', () => 'ok'), server = http.createServer(app.callback());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await request('http://127.0.0.1:' + server.address().port)).text, 'ok'); assert.throws(() => app.get('/late', () => ''), /before ready/);
  assert.throws(() => openmesh().register(() => {}).callback(), /await app.ready/);
});
test('query duplication and prototype-like keys stay local', async t => {
  const app = openmesh().get('/', ctx => ({ values: ctx.query.a, proto: ctx.query.__proto__, clean: Object.getPrototypeOf(ctx.query) === null }));
  const url = await serve(t, app);
  assert.deepEqual((await request(url, '/?a=1&a=2&__proto__=safe')).json(), { values: ['1', '2'], proto: 'safe', clean: true });
});
test('JSON parser handles malformed and oversized bodies without crashing', async t => {
  const app = openmesh().use(jsonBody({ limit: 64 })).post('/', ctx => ctx.requestBody); const url = await serve(t, app);
  assert.deepEqual((await request(url, '/', { method: 'POST', body: { a: 1 } })).json(), { a: 1 });
  assert.equal((await request(url, '/', { method: 'POST', body: '{broken', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await request(url, '/', { method: 'POST', body: 'x'.repeat(100), headers: { 'content-type': 'application/json' } })).status, 413);
  assert.equal((await request(url, '/', { method: 'POST', body: { alive: true } })).status, 200);
});
test('5xx errors do not expose secrets and serializer failures are caught', async t => {
  const app = openmesh().get('/secret', () => { throw new Error('SECRET'); }).get('/cycle', () => { const a = {}; a.a = a; return a; }).get('/bad-serializer', { serializer: () => undefined }, () => ({}));
  const url = await serve(t, app);
  for (const path of ['/secret', '/cycle', '/bad-serializer']) { const res = await request(url, path); assert.equal(res.status, 500); assert.equal(res.text.includes('SECRET'), false); }
});
test('trace context preserves trace id, changes span, and validates request id', async t => {
  const trace = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
  const app = openmesh().use(requestContext({ service: 'test' })).get('/', ctx => ctx.state.outboundHeaders); const url = await serve(t, app);
  const res = await request(url, '/', { headers: { traceparent: trace, 'x-request-id': 'valid-42' } });
  assert.equal(res.headers['x-request-id'], 'valid-42'); assert.equal(res.json().traceparent.slice(3, 35), trace.slice(3, 35)); assert.notEqual(res.json().traceparent, trace);
  const invalid = await request(url, '/', { headers: { traceparent: 'broken', 'x-request-id': 'bad id' } }); assert.notEqual(invalid.headers['x-request-id'], 'bad id'); assert.match(invalid.json().traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
});
test('health endpoints reflect readiness', async t => {
  let ready = false; const app = openmesh().register(health({ ready: () => ready })); const url = await serve(t, app);
  assert.equal((await request(url, '/health/live')).status, 200); assert.equal((await request(url, '/health/ready')).status, 503); ready = true; assert.equal((await request(url, '/health/ready')).status, 200);
});
test('shutdown drains in-flight responses and runs reverse close hooks', async () => {
  let entered; const started = new Promise(resolve => { entered = resolve; }), events = [];
  const app = openmesh().get('/', async () => { entered(); await new Promise(resolve => setTimeout(resolve, 40)); return 'complete'; });
  app.onClose(() => events.push('first')).onClose(() => events.push('second')); const address = await app.listen({ port: 0 });
  const pending = request('http://127.0.0.1:' + address.port); await started; const closing = app.close(); assert.equal((await pending).text, 'complete'); await closing;
  assert.deepEqual(events, ['second', 'first']); assert.equal(app.phase, 'closed'); await app.close();
});
test('invalid routes, plugin timeout and mixed async/callback are rejected', async () => {
  const app = openmesh(); assert.throws(() => app.get(42, () => ''), /Route path/); assert.throws(() => app.get('/a/:id/:id', () => ''), /duplicate parameter/); assert.throws(() => app.get('/a/*/b', () => ''), /final/);
  app.get('/a/:id', () => ''); assert.throws(() => app.get('/a/:name', () => ''), /Duplicate route/); assert.throws(() => app.decorate('_root', {}), /reserved/);
  await assert.rejects(openmesh({ pluginTimeout: 10 }).register((scope, options, done) => {}).ready(), /timed out/);
  await assert.rejects(openmesh().register(async (scope, options, done) => {}).ready(), /mix a Promise/);
});

test('arbitrary thrown values and error-handler rejections return 500 without crashing', async t => {
  const app = openmesh().get('/null', () => { throw null; }).get('/undefined', async () => { throw undefined; }).get('/object', () => { throw { secret: 'hidden' }; }).get('/healthy', () => 'ok');
  const url = await serve(t, app);
  for (const path of ['/null', '/undefined', '/object']) assert.deepEqual((await request(url, path)).json(), { error: 'Internal Server Error' });
  assert.equal((await request(url, '/healthy')).status, 200);
  const custom = openmesh().get('/', () => { throw new Error('first'); }).setErrorHandler(async () => { throw null; });
  assert.equal((await request(await serve(t, custom))).status, 500);
});

test('shutdown timeout destroys an unresponsive connection and still cleans resources', async () => {
  let entered; const started = new Promise(resolve => { entered = resolve; }); let closed = false;
  const app = openmesh({ shutdownTimeout: 20 }).get('/', () => { entered(); return new Promise(() => {}); });
  app.onClose(() => { closed = true; });
  const address = await app.listen({ port: 0 });
  const pending = request('http://127.0.0.1:' + address.port).then(() => false, () => true);
  await started; await app.close();
  assert.equal(await pending, true); assert.equal(closed, true); assert.equal(app.phase, 'closed');
});
