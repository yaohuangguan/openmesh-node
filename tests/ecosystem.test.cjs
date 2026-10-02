const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fastifyCors = require('@fastify/cors');
const fastifyHelmet = require('@fastify/helmet');
const openmesh = require('openmesh-node');
const { serve, request } = require('./helpers.cjs');
test('real Express CORS and Helmet run as native middleware', async t => {
  const app = openmesh().useExpress(cors()).useExpress(helmet()).get('/', () => ({ ok: true })); const url = await serve(t, app);
  const res = await request(url, '/', { headers: { origin: 'https://example.com' } });
  assert.equal(res.headers['access-control-allow-origin'], '*'); assert.equal(res.headers['x-content-type-options'], 'nosniff'); assert.deepEqual(res.json(), { ok: true });
});
test('real Express app preserves router, JSON parser and error middleware', async t => {
  const legacy = express(), router = express.Router();
  legacy.use(express.json()); router.post('/users/:id', (req, res) => res.json({ id: req.params.id, body: req.body, url: req.originalUrl }));
  legacy.use(router); legacy.get('/error', () => { throw new Error('caught'); }); legacy.use((error, req, res, next) => res.status(409).json({ error: error.message }));
  const app = openmesh().mount('/legacy', legacy).get('/native', () => 'native'); const url = await serve(t, app);
  const res = await request(url, '/legacy/users/42', { method: 'POST', body: { value: 1 } });
  assert.deepEqual(res.json(), { id: '42', body: { value: 1 }, url: '/legacy/users/42' }); assert.equal((await request(url, '/legacy/error')).status, 409); assert.equal((await request(url, '/native')).text, 'native'); assert.equal((await request(url, '/legacy-other')).status, 404);
});
test('Fastify bridge runs official CORS, Helmet, schema validation and close hooks', async t => {
  let closed = false;
  const app = openmesh().get('/native', () => ({ native: true }));
  app.fastify('/api', async host => {
    await host.register(fastifyCors, { origin: 'https://allowed.example' }); await host.register(fastifyHelmet);
    host.addHook('onClose', async () => { closed = true; });
    host.post('/users', { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false } } }, req => ({ name: req.body.name }));
  });
  const url = await serve(t, app), res = await request(url, '/api/users', { method: 'POST', body: { name: 'Sam' }, headers: { origin: 'https://allowed.example' } });
  assert.equal(res.status, 200); assert.equal(res.headers['access-control-allow-origin'], 'https://allowed.example'); assert.equal(res.headers['x-content-type-options'], 'nosniff'); assert.deepEqual(res.json(), { name: 'Sam' });
  assert.equal((await request(url, '/api/users', { method: 'POST', body: {} })).status, 400); assert.equal((await request(url, '/api/missing')).status, 404); assert.deepEqual((await request(url, '/native')).json(), { native: true });
  await app.close(); assert.equal(closed, true);
});
test('Express middleware that terminates a response does not fall through', async t => {
  let reached = false; const app = openmesh().useExpress((req, res, next) => { res.end('early'); }).get('/', () => { reached = true; return 'late'; }); const url = await serve(t, app);
  assert.equal((await request(url)).text, 'early'); assert.equal(reached, false);
});
