const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const openmesh = require('openmesh-node');
const { requestContext } = require('openmesh-node/plugins');
const { PeerPool, PeerError } = require('openmesh-node/mesh');
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
test('unkeyed p2c avoids a busy peer while keyed routing stays rendezvous-stable', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pool = new PeerPool({
    peers,
    transport: async ({ peer, url }) => {
      if (url.pathname === '/hold') await gate;
      return ok({ peer: peer.id });
    }
  });

  let key = '0';
  while (pool.rank(key)[0].id !== 'a') key = String(Number(key) + 1);
  const held = pool.request('/hold', { key });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pool.stats().find(peer => peer.id === 'a').inflight, 1);

  const adaptive = await pool.request('/fast');
  assert.equal(adaptive.peer.id, 'b');

  const sticky = await pool.request('/fast', { key });
  assert.equal(sticky.peer.id, 'a');

  release();
  await held;
  pool.close();
  assert.throws(() => new PeerPool({ peers, selection: 'invalid' }), /selection/);
});

test('bounded admission queues FIFO and rejects overload without starting transport', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const pool = new PeerPool({
    peers: [peers[0]],
    maxInflight: 1,
    maxQueue: 1,
    retries: 0,
    transport: async ({ url }) => {
      started.push(url.pathname);
      if (url.pathname === '/first') await gate;
      return ok({ path: url.pathname });
    }
  });

  const first = pool.request('/first');
  await new Promise(resolve => setImmediate(resolve));
  const second = pool.request('/second');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(pool.poolStats(), {
    inflight: 1,
    queued: 1,
    overloadRejections: 0,
    maxInflight: 1,
    maxQueue: 1,
    concurrencyLimit: 1,
    adaptive: false
  });
  await assert.rejects(pool.request('/third'), error => error instanceof PeerError && error.code === 'POOL_OVERLOADED');
  assert.deepEqual(started, ['/first']);
  assert.equal(pool.poolStats().overloadRejections, 1);

  release();
  await first;
  await second;
  assert.deepEqual(started, ['/first', '/second']);
  assert.equal(pool.poolStats().inflight, 0);
  assert.equal(pool.poolStats().queued, 0);
  pool.close();

  assert.throws(() => new PeerPool({ maxInflight: 0 }), /maxInflight/);
  assert.throws(() => new PeerPool({ maxQueue: -1 }), /maxQueue/);
});

test('admission queue time counts against the request deadline', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const pool = new PeerPool({
    peers: [peers[0]],
    maxInflight: 1,
    maxQueue: 1,
    retries: 0,
    transport: async ({ url }) => {
      started.push(url.pathname);
      if (url.pathname === '/hold') await gate;
      return ok({ path: url.pathname });
    }
  });

  const held = pool.request('/hold', { timeout: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    pool.request('/queued', { timeout: 20 }),
    error => error instanceof PeerError && error.code === 'DEADLINE_EXCEEDED'
  );
  assert.deepEqual(started, ['/hold']);
  assert.equal(pool.poolStats().queued, 0);

  release();
  await held;
  pool.close();
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
test('closing pool cancels admitted and queued requests and rejects new calls', async () => {
  const pool = new PeerPool({
    peers: [peers[0]],
    maxInflight: 1,
    maxQueue: 1,
    transport: () => new Promise(() => {})
  });
  const admitted = pool.request('/admitted');
  await new Promise(resolve => setImmediate(resolve));
  const queued = pool.request('/queued');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pool.poolStats().inflight, 1);
  assert.equal(pool.poolStats().queued, 1);

  pool.close();
  await assert.rejects(admitted, error => error.code === 'POOL_CLOSED');
  await assert.rejects(queued, error => error.code === 'POOL_CLOSED');
  await assert.rejects(pool.request('/new'), error => error.code === 'POOL_CLOSED');
  assert.equal(pool.poolStats().inflight, 0);
  assert.equal(pool.poolStats().queued, 0);
  pool.close();
});

test('stopping discovery ignores a pending provider result', async () => {
  const pool = new PeerPool({ peers }); let finish;
  pool.watch(() => new Promise(resolve => { finish = resolve; }), { interval: 10 });
  pool.stopDiscovery(); finish([peers[0]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pool.peers, peers); pool.close();
});


test('peer stats expose inflight, success and latency telemetry without poisoning cancellation', async () => {
  let release;
  const pool = new PeerPool({
    peers: [peers[0]],
    transport: () => new Promise(resolve => { release = () => resolve(ok({ ok: true })); })
  });
  const pending = pool.request('/');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pool.stats()[0].inflight, 1);
  release();
  await pending;
  const success = pool.stats()[0];
  assert.equal(success.inflight, 0);
  assert.equal(success.successes, 1);
  assert.equal(success.attempts, 1);
  assert.equal(typeof success.lastLatencyMs, 'number');
  assert.equal(typeof success.ewmaLatencyMs, 'number');
  assert.equal(typeof success.lastSuccessAt, 'number');

  const controller = new AbortController();
  const canceled = new PeerPool({ peers: [peers[0]], transport: () => new Promise(() => {}) });
  const request = canceled.request('/', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canceled.stats()[0].inflight, 1);
  controller.abort(new Error('stop'));
  await assert.rejects(request, /stop/);
  assert.equal(canceled.stats()[0].inflight, 0);
  assert.equal(canceled.stats()[0].failures, 0);
  canceled.close(); pool.close();
});


test('peer pool observer receives safe lifecycle and pressure events', async () => {
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pool = new PeerPool({
    peers: [peers[0]],
    maxInflight: 1,
    maxQueue: 1,
    retries: 0,
    onEvent: event => {
      events.push(event);
      if (event.type === 'peer.success') throw new Error('observer failures must not break transport');
    },
    transport: async ({ url }) => {
      if (url.pathname === '/hold') await gate;
      if (url.pathname === '/fail') throw new PeerError('nope', 'TEST_FAILURE');
      return ok({ path: url.pathname });
    }
  });

  const held = pool.request('/hold');
  await new Promise(resolve => setImmediate(resolve));
  const queued = pool.request('/queued');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(pool.request('/overflow'), error => error.code === 'POOL_OVERLOADED');

  release();
  await held;
  await queued;
  await assert.rejects(pool.request('/fail'), /nope/);

  assert.ok(events.some(event => event.type === 'admission.queued' && event.queued === 1));
  assert.ok(events.some(event => event.type === 'admission.rejected'));
  assert.ok(events.some(event => event.type === 'peer.attempt' && event.path === '/hold' && event.attempt === 1));
  assert.ok(events.some(event => event.type === 'peer.success' && event.path === '/queued' && event.statusCode === 200));
  assert.ok(events.some(event => event.type === 'peer.failure' && event.path === '/fail' && event.code === 'TEST_FAILURE'));
  assert.ok(events.every(event => typeof event.at === 'number'));

  pool.close();
  assert.throws(() => new PeerPool({ onEvent: 'invalid' }), /onEvent/);
});


test('streaming peer response returns after headers and holds admission until body completion', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const node = openmesh().get('/stream', () => Readable.from((async function* () {
    yield 'a';
    await gate;
    yield 'b';
  })()));
  const url = await serve(t, node);
  const pool = new PeerPool({ peers: [{ id: 'stream', url }], maxInflight: 1, maxQueue: 0 });
  t.after(() => pool.close());

  const response = await pool.requestStream('/stream');
  assert.equal(response.statusCode, 200);
  assert.equal(pool.poolStats().inflight, 1);
  assert.equal(pool.stats()[0].inflight, 1);

  release();
  assert.equal(await response.text(), 'ab');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pool.poolStats().inflight, 0);
  assert.equal(pool.stats()[0].inflight, 0);
  assert.equal(pool.stats()[0].successes, 1);
});

test('streaming retries only before headers are committed', async () => {
  let calls = 0;
  const pool = new PeerPool({
    peers,
    retries: 1,
    streamTransport: async () => {
      calls++;
      if (calls === 1) return { statusCode: 503, headers: {}, body: Readable.from('unavailable') };
      return { statusCode: 200, headers: {}, body: Readable.from('ok') };
    }
  });

  const response = await pool.requestStream('/');
  assert.equal(await response.text(), 'ok');
  assert.equal(calls, 2);
  pool.close();
});

test('post-header stream failure is surfaced without replaying the request', async () => {
  let calls = 0;
  const pool = new PeerPool({
    peers: [peers[0]],
    failureThreshold: 1,
    retries: 3,
    streamTransport: async () => {
      calls++;
      const body = new Readable({ read() {} });
      setImmediate(() => {
        body.push('partial');
        body.destroy(new PeerError('stream failed', 'STREAM_FAILED'));
      });
      return { statusCode: 200, headers: {}, body };
    }
  });

  const response = await pool.requestStream('/');
  await assert.rejects(response.text(), error => error.code === 'STREAM_FAILED');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(pool.stats()[0].failures, 1);
  assert.equal(pool.stats()[0].circuit, 'open');
  pool.close();
});


test('adaptive concurrency uses bounded AIMD feedback without exceeding the hard limit', async () => {
  let fail = false;
  const events = [];
  const pool = new PeerPool({
    peers: [peers[0]],
    maxInflight: 4,
    maxQueue: 4,
    adaptiveConcurrency: {
      min: 1,
      initial: 1,
      max: 3,
      targetLatencyMs: 20,
      decreaseRatio: 0.5,
      increaseStep: 1,
      sampleSize: 2
    },
    onEvent: event => events.push(event),
    transport: async () => {
      if (fail) throw new PeerError('overloaded', 'REMOTE_OVERLOAD');
      return ok({ ok: true });
    }
  });

  assert.equal(pool.poolStats().concurrencyLimit, 1);
  assert.equal(pool.poolStats().adaptive, true);

  await pool.request('/');
  await pool.request('/');
  assert.equal(pool.poolStats().concurrencyLimit, 2);

  await pool.request('/');
  await pool.request('/');
  assert.equal(pool.poolStats().concurrencyLimit, 3);

  fail = true;
  await assert.rejects(pool.request('/'), /overloaded/);
  assert.equal(pool.poolStats().concurrencyLimit, 1);
  assert.equal(pool.poolStats().maxInflight, 4);
  assert.ok(events.some(event => event.type === 'concurrency.changed' && event.current === 2));
  assert.ok(events.some(event => event.type === 'concurrency.changed' && event.current === 3));
  assert.ok(events.some(event => event.type === 'concurrency.changed' && event.reason === 'failure' && event.current === 1));

  pool.close();
  assert.throws(
    () => new PeerPool({ maxInflight: 2, adaptiveConcurrency: { min: 1, max: 3 } }),
    /adaptiveConcurrency/
  );
});


test('caller abort after streaming headers releases admission without poisoning circuit', async () => {
  const controller = new AbortController();
  let started = false;
  const pool = new PeerPool({
    peers: [peers[0]],
    maxInflight: 1,
    maxQueue: 0,
    streamTransport: async ({ signal }) => {
      const body = new Readable({ read() {} });
      signal.addEventListener('abort', () => body.destroy(signal.reason), { once: true });
      started = true;
      return { statusCode: 200, headers: {}, body };
    }
  });

  const response = await pool.requestStream('/', { signal: controller.signal });
  assert.equal(started, true);
  assert.equal(pool.poolStats().inflight, 1);
  controller.abort(new Error('consumer stopped'));
  await assert.rejects(response.text(), /consumer stopped/);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(pool.poolStats().inflight, 0);
  assert.equal(pool.stats()[0].inflight, 0);
  assert.equal(pool.stats()[0].failures, 0);
  assert.equal(pool.stats()[0].circuit, 'closed');
  pool.close();
});

test('stream byte limit fails the committed stream and releases admission', async () => {
  const pool = new PeerPool({
    peers: [peers[0]],
    maxInflight: 1,
    maxQueue: 0,
    maxResponseBytes: 4
  });
  const node = openmesh().get('/', () => Readable.from(['abc', 'def']));
  const t = { after() {} };
  const url = await serve(t, node);
  pool.updatePeers([{ id: 'a', url }]);

  const response = await pool.requestStream('/');
  await assert.rejects(response.text(), error => error.code === 'RESPONSE_TOO_LARGE');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pool.poolStats().inflight, 0);
  assert.equal(pool.stats()[0].failures, 1);
  pool.close();
  await node.close();
});

test('consumer destroy releases streaming admission as cancellation', async () => {
  const pool = new PeerPool({
    peers: [peers[0]],
    maxInflight: 1,
    maxQueue: 0,
    streamTransport: async () => ({ statusCode: 200, headers: {}, body: new Readable({ read() {} }) })
  });

  const response = await pool.requestStream('/');
  assert.equal(pool.poolStats().inflight, 1);
  response.body.destroy();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(pool.poolStats().inflight, 0);
  assert.equal(pool.stats()[0].failures, 0);
  assert.equal(pool.stats()[0].inflight, 0);
  pool.close();
});
