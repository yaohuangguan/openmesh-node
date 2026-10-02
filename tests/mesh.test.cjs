const test = require('node:test');
const assert = require('node:assert/strict');
const openmesh = require('../index.cjs');
const { requestContext } = require('../plugins/index.cjs');
const { PeerPool, PeerError } = require('../mesh/index.cjs');
const { serve } = require('./helpers.cjs');
const ok = data => ({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(data)) });
const peers = [{ id: 'a', url: 'http://127.0.0.1:1' }, { id: 'b', url: 'http://127.0.0.1:2' }];

test('real multi-node HTTP calls propagate trace context and return selected peer', async t => {
  const nodeA = openmesh().use(requestContext({ service: 'a' })).get('/status', ctx => ({ node: 'a', requestId: ctx.state.requestId, traceId: ctx.state.traceparent.slice(3, 35) }));
  const nodeB = openmesh().use(requestContext({ service: 'b' })).get('/status', ctx => ({ node: 'b', requestId: ctx.state.requestId, traceId: ctx.state.traceparent.slice(3, 35) }));
  const a = await serve(t, nodeA), b = await serve(t, nodeB), pool = new PeerPool({ peers: [{ id: 'a', url: a }, { id: 'b', url: b }] }); t.after(() => pool.close());
  const trace = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
  const response = await pool.request('/status', { key: 'user:42', headers: { 'x-request-id': 'call-42', traceparent: trace } });
  assert.equal(response.json().node, response.peer.id); assert.equal(response.json().requestId, 'call-42'); assert.equal(response.json().traceId, trace.slice(3, 35));
  const broadcast = await pool.broadcast('/status', { concurrency: 1 }); assert.equal(broadcast.length, 2); assert.ok(broadcast.every(x => x.status === 'fulfilled'));
});
test('real failed node is bypassed on retry and its circuit opens', async t => {
  const bad = await serve(t, openmesh().get('/', ctx => { ctx.status = 503; return { unavailable: true }; }));
  const good = await serve(t, openmesh().get('/', () => ({ healthy: true })));
  const pool = new PeerPool({ peers: [{ id: 'bad', url: bad }, { id: 'good', url: good }], failureThreshold: 1, retries: 1 }); t.after(() => pool.close());
  let key = '0'; while (pool.rank(key)[0].id !== 'bad') key = String(Number(key) + 1);
  const res = await pool.request('/', { key }); assert.equal(res.peer.id, 'good'); assert.deepEqual(res.json(), { healthy: true }); assert.equal(pool.stats().find(p => p.id === 'bad').circuit, 'open');
});
test('rendezvous selection is stable across order and only moves removed-owner keys', () => {
  const pool = new PeerPool({ peers: [...peers, { id: 'c', url: 'http://127.0.0.1:3' }] });
  const keys = Array.from({ length: 100 }, (_, i) => 'user:' + i), before = keys.map(k => pool.rank(k)[0].id);
  pool.updatePeers(pool.peers.reverse()); assert.deepEqual(keys.map(k => pool.rank(k)[0].id), before);
  pool.updatePeers(peers); keys.forEach((key, i) => { if (before[i] !== 'c') assert.equal(pool.rank(key)[0].id, before[i]); }); pool.close();
});
test('POST is not retried implicitly; explicit unsafe retry requires idempotency key', async () => {
  let calls = 0; const pool = new PeerPool({ peers, transport: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(pool.request('/', { method: 'POST', body: { job: 1 } })); assert.equal(calls, 1);
  await assert.rejects(pool.request('/', { method: 'POST', retryUnsafe: true }), /requires an idempotencyKey/);
  calls = 0; await assert.rejects(pool.request('/', { method: 'POST', retryUnsafe: true, idempotencyKey: 'job-42' })); assert.equal(calls, 2); pool.close();
});
test('deadline covers all retries and cancels a non-cooperative transport', async () => {
  let calls = 0; const pool = new PeerPool({ peers, timeout: 20, transport: async () => { if (++calls === 1) throw new Error('first failed'); return new Promise(() => {}); } });
  await assert.rejects(pool.request('/'), error => error instanceof PeerError && error.code === 'DEADLINE_EXCEEDED'); assert.equal(calls, 2); pool.close();
});
test('caller abort does not poison peer circuit', async () => {
  const pool = new PeerPool({ peers: [peers[0]], transport: () => new Promise(() => {}) }), controller = new AbortController();
  const request = pool.request('/', { signal: controller.signal }); controller.abort(new Error('caller canceled'));
  await assert.rejects(request, /caller canceled/); assert.equal(pool.stats()[0].failures, 0); assert.equal(pool.stats()[0].probing, false); pool.close();
});
test('half-open circuit allows only one recovery probe at a time', async () => {
  let fail = true, active = 0, max = 0;
  const pool = new PeerPool({ peers: [peers[0]], failureThreshold: 1, cooldown: 10, transport: async () => { if (fail) throw new Error('down'); active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return ok({ recovered: true }); } });
  await assert.rejects(pool.request('/')); fail = false; await new Promise(resolve => setTimeout(resolve, 15));
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => pool.request('/'))); assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(max, 1); assert.equal(pool.stats()[0].circuit, 'closed'); pool.close();
});
test('discovery updates are atomic and invalid members do not erase current peers', async () => {
  const pool = new PeerPool({ peers });
  await assert.rejects(pool.discover(async () => [{ id: 'duplicate', url: peers[0].url }, { id: 'duplicate', url: peers[1].url }])); assert.deepEqual(pool.peers, peers);
  await pool.discover(async () => [peers[0]]); assert.equal(pool.peers.length, 1); pool.close();
});
test('responses have a byte limit and outbound paths cannot change authority', async t => {
  const address = await serve(t, openmesh().get('/', () => 'x'.repeat(100))); const pool = new PeerPool({ peers: [{ id: 'a', url: address }], maxResponseBytes: 32, retries: 0 }); t.after(() => pool.close());
  await assert.rejects(pool.request('/'), error => error.code === 'RESPONSE_TOO_LARGE');
  await assert.rejects(pool.request('//evil.example/x'), /not a URL/); await assert.rejects(pool.request('https://evil.example'), /not a URL/);
  assert.throws(() => pool.updatePeers([{ id: 'a', url: 'file:///etc/passwd' }]), /trusted HTTP/);
});
test('broadcast bounds concurrency and reports failures separately', async () => {
  let active = 0, max = 0;
  const pool = new PeerPool({ peers: Array.from({ length: 6 }, (_, i) => ({ id: String(i), url: 'http://127.0.0.1:' + (i + 1) })), transport: async ({ peer }) => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 3)); active--; if (peer.id === '2') throw new Error('failed'); return ok(peer.id); } });
  const results = await pool.broadcast('/', { concurrency: 2 }); assert.equal(max, 2); assert.equal(results.filter(x => x.status === 'rejected').length, 1); pool.close();
});
test('closing pool cancels requests and rejects new calls', async () => {
  const pool = new PeerPool({ peers: [peers[0]], transport: () => new Promise(() => {}) }), pending = pool.request('/'); pool.close();
  await assert.rejects(pending, error => error.code === 'POOL_CLOSED'); await assert.rejects(pool.request('/'), error => error.code === 'POOL_CLOSED'); pool.close();
});

test('stopping discovery ignores a pending provider result', async () => {
  const pool = new PeerPool({ peers }); let finish;
  pool.watch(() => new Promise(resolve => { finish = resolve; }), { interval: 10 });
  pool.stopDiscovery(); finish([peers[0]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pool.peers, peers); pool.close();
});
