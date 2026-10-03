const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const openmesh = require('openmesh-node');
const { bodyParser } = require('openmesh-node/plugins');
const {
  controlPlane,
  ControlClient,
  serviceRegistration,
  MeshHttpError
} = require('openmesh-node/services');

const token = 'mesh-test-token-123456789';

async function listen(app) {
  const address = await app.listen({ port: 0 });
  return 'http://127.0.0.1:' + address.port;
}

test('app.mesh provides lazy service calls, traffic policy and trace propagation', async () => {
  const controlApp = openmesh().register(controlPlane({ token }));
  const controlURL = await listen(controlApp);
  const registrationClient = new ControlClient({
    url: controlURL + '/_mesh',
    token,
    timeout: 5000
  });

  function paymentApp(id, version) {
    return openmesh()
      .use(bodyParser())
      .register(serviceRegistration({
        client: registrationClient,
        service: 'payments',
        id,
        ttl: 5000,
        metadata: { version, region: 'nz' },
        url: address => 'http://127.0.0.1:' + address.port
      }))
      .get('/version', ctx => ({
        version,
        instance: id,
        requestId: ctx.get('x-request-id') || null,
        traceparent: ctx.get('traceparent') || null
      }))
      .post('/charge', ctx => ({
        version,
        instance: id,
        requestId: ctx.get('x-request-id') || null,
        traceparent: ctx.get('traceparent') || null,
        amount: ctx.requestBody.amount
      }))
      .get('/stream', () => Readable.from([version]))
      .get('/fail', ctx => {
        ctx.status = 503;
        return { code: 'PAYMENTS_UNAVAILABLE', version };
      });
  }

  const v1 = paymentApp('payments-v1', 'v1');
  const v2 = paymentApp('payments-v2', 'v2');
  const gateway = openmesh({
    service: 'gateway',
    mesh: {
      control: {
        url: controlURL + '/_mesh',
        token,
        timeout: 5000
      },
      defaults: {
        timeout: 5000,
        retries: 1,
        maxInflight: 32,
        maxQueue: 64
      },
      services: {
        payments: {
          traffic: {
            split: [
              { name: 'stable', match: { version: 'v1' }, weight: 90 },
              { name: 'canary', match: { version: 'v2' }, weight: 10 }
            ],
            fallback: 'error'
          }
        }
      }
    }
  })
    .use(bodyParser());

  const payments = gateway.mesh('payments');

  gateway.post('/checkout', async ctx => {
    const payment = await payments.post('/charge', {
      key: ctx.requestBody.userId,
      body: { amount: ctx.requestBody.amount }
    });
    return {
      gatewayTrace: ctx.state.traceparent,
      payment
    };
  });

  let gatewayURL;
  try {
    await listen(v1);
    await listen(v2);
    gatewayURL = await listen(gateway);

    const checkout = await fetch(gatewayURL + '/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'checkout-42'
      },
      body: JSON.stringify({ userId: 'u-42', amount: 25 })
    });
    assert.equal(checkout.status, 200);
    const checkoutBody = await checkout.json();
    assert.equal(checkoutBody.payment.requestId, 'checkout-42');
    assert.equal(checkoutBody.payment.traceparent, checkoutBody.gatewayTrace);
    assert.equal(checkoutBody.payment.amount, 25);
    assert.ok(['v1', 'v2'].includes(checkoutBody.payment.version));

    const forcedCanary = await payments.get('/version', {
      target: { version: 'v2' }
    });
    assert.equal(forcedCanary.version, 'v2');

    const rawCanary = await payments.request('/version', {
      target: { version: 'v2' }
    });
    assert.equal(rawCanary.json().version, 'v2');

    const streamedCanary = await payments.stream('/stream', {
      target: { version: 'v2' }
    });
    assert.equal(await streamedCanary.text(), 'v2');

    const sticky = [];
    for (let i = 0; i < 8; i++) {
      sticky.push((await payments.get('/version', { key: 'same-user' })).version);
    }
    assert.equal(new Set(sticky).size, 1);

    const counts = { v1: 0, v2: 0 };
    for (let i = 0; i < 100; i++) {
      const result = await payments.get('/version', { key: 'user-' + i });
      counts[result.version]++;
    }
    assert.ok(counts.v1 > counts.v2, JSON.stringify(counts));
    assert.ok(counts.v2 > 0, JSON.stringify(counts));

    await assert.rejects(
      payments.get('/version', { target: { version: 'v3' } }),
      error => error && error.code === 'NO_TRAFFIC_TARGET'
    );

    await assert.rejects(
      payments.get('/fail', { target: { version: 'v1' } }),
      error => {
        assert.ok(error instanceof MeshHttpError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.data.code, 'PAYMENTS_UNAVAILABLE');
        assert.equal(error.data.version, 'v1');
        return true;
      }
    );

    const stats = await payments.poolStats();
    assert.equal(stats.maxInflight, 32);
    assert.equal(stats.maxQueue, 64);
  } finally {
    await gateway.close().catch(() => {});
    await v2.close().catch(() => {});
    await v1.close().catch(() => {});
    await registrationClient.close().catch(() => {});
    await controlApp.close().catch(() => {});
  }
});
