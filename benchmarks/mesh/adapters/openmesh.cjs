'use strict';

const openmesh = require('openmesh-node');
const { PeerPool } = require('openmesh-node/mesh');
const { controlPlane, ControlClient, serviceRegistration } = require('openmesh-node/services');
const { createPki } = require('../pki.cjs');

const TOKEN = 'mesh-benchmark-token-0123456789';
const BACKENDS = 3;

async function listen(app, scheme = 'http') {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return { url: scheme + '://127.0.0.1:' + address.port, port: address.port };
}

function workloadIdentity(pki, service, allow) {
  const workload = pki.workloads[service];
  return {
    trustDomain: pki.trustDomain,
    ca: pki.ca,
    cert: workload.cert,
    key: workload.key,
    ...(allow ? { allow } : {})
  };
}

async function main() {
  const pki = await createPki(['bench-gateway-secure', 'bench-secure']);
  const control = openmesh().register(controlPlane({ token: TOKEN }));
  const controlAddress = await listen(control);
  const client = new ControlClient({
    url: controlAddress.url + '/_mesh',
    token: TOKEN,
    timeout: 5000
  });

  const plainApps = [];
  const policyApps = [];
  const secureApps = [];
  const directTargets = [];

  for (let index = 0; index < BACKENDS; index += 1) {
    const instance = 'backend-' + String.fromCharCode(97 + index);
    const metadata = {
      version: index === BACKENDS - 1 ? 'canary' : 'stable',
      region: index === 1 ? 'secondary' : 'primary'
    };

    const plain = openmesh()
      .register(serviceRegistration({
        client,
        service: 'bench-worker',
        id: 'plain-' + instance,
        ttl: 3000,
        metadata,
        url: address => 'http://127.0.0.1:' + address.port
      }))
      .get('/work', () => ({ ok: true, instance }));

    const policy = openmesh()
      .register(serviceRegistration({
        client,
        service: 'bench-policy',
        id: 'policy-' + instance,
        ttl: 3000,
        metadata,
        url: address => 'http://127.0.0.1:' + address.port
      }))
      .get('/work', () => ({ ok: true, instance }));

    const secure = openmesh({
      service: 'bench-secure',
      identity: workloadIdentity(pki, 'bench-secure', ['bench-gateway-secure'])
    })
      .register(serviceRegistration({
        client,
        service: 'bench-secure',
        id: 'secure-' + instance,
        ttl: 3000,
        metadata,
        url: address => 'https://127.0.0.1:' + address.port
      }))
      .get('/work', () => ({ ok: true, instance }));

    const plainAddress = await listen(plain);
    await listen(policy);
    await listen(secure, 'https');
    plainApps.push({ id: instance, app: plain, closed: false });
    policyApps.push(policy);
    secureApps.push(secure);
    directTargets.push(plainAddress.url);
  }

  const meshControl = {
    url: controlAddress.url + '/_mesh',
    token: TOKEN,
    timeout: 5000
  };
  const defaults = {
    timeout: 3000,
    retries: 0,
    maxInflight: 2048,
    maxQueue: 2048
  };

  const gateway = openmesh({
    service: 'bench-gateway',
    mesh: {
      control: meshControl,
      defaults,
      services: {
        'bench-policy': {
          traffic: {
            split: [
              { name: 'stable', match: { version: 'stable' }, weight: 90 },
              { name: 'canary', match: { version: 'canary' }, weight: 10 }
            ],
            prefer: [
              { name: 'primary', match: { region: 'primary' } },
              { name: 'secondary', match: { region: 'secondary' } }
            ],
            fallback: 'error'
          }
        }
      }
    }
  });

  const secureGateway = openmesh({
    service: 'bench-gateway-secure',
    identity: workloadIdentity(pki, 'bench-gateway-secure'),
    mesh: {
      control: meshControl,
      defaults
    }
  });

  const worker = gateway.mesh('bench-worker');
  const policyWorker = gateway.mesh('bench-policy');
  const secureWorker = secureGateway.mesh('bench-secure');
  const directPool = new PeerPool({
    peers: [{ id: 'direct-backend', url: directTargets[0] }],
    timeout: 3000,
    retries: 0,
    maxInflight: 2048,
    maxQueue: 2048,
    maxSockets: 4096
  });

  gateway.get('/health', () => ({ ok: true }));
  gateway.get('/direct', async () => (await directPool.request('/work')).json());
  gateway.get('/mesh', async () => worker.get('/work'));
  gateway.get('/policy', async ctx => policyWorker.get('/work', {
    key: String(ctx.get('x-bench-key') || 'bench-user')
  }));
  gateway.get('/mtls', async () => secureWorker.get('/work'));

  const gatewayAddress = await listen(gateway);

  // Force all discovery pools and TLS handshakes to warm before measurement.
  await worker.get('/work');
  await policyWorker.get('/work', { key: 'warmup' });
  await secureWorker.get('/work');

  const ready = {
    system: 'openmesh',
    version: require('../../../package.json').version,
    language: 'node-application-native',
    pid: process.pid,
    capabilities: {
      direct: true,
      mesh: true,
      policy: true,
      mtls: true,
      mtlsIncludedInMesh: false,
      failover: true
    },
    endpoints: {
      direct: gatewayAddress.url + '/direct',
      mesh: gatewayAddress.url + '/mesh',
      policy: gatewayAddress.url + '/policy',
      mtls: gatewayAddress.url + '/mtls',
      health: gatewayAddress.url + '/health'
    },
    topology: {
      backends: BACKENDS,
      controlPlane: 'in-process HTTP control plane',
      meshHops: 0
    },
    rssBytes: process.memoryUsage().rss
  };

  if (process.send) process.send(ready);
  else process.stdout.write(JSON.stringify(ready) + '\n');

  let failoverTriggered = false;

  const close = async () => {
    directPool.close();
    await gateway.close().catch(() => {});
    await secureGateway.close().catch(() => {});
    for (const entry of [...plainApps].reverse()) {
      if (!entry.closed) await entry.app.close().catch(() => {});
    }
    for (const app of [...policyApps].reverse()) await app.close().catch(() => {});
    for (const app of [...secureApps].reverse()) await app.close().catch(() => {});
    await control.close().catch(() => {});
    await client.close().catch(() => {});
  };

  process.on('message', async message => {
    if (message === 'stats' && process.send) {
      process.send({ type: 'stats', rssBytes: process.memoryUsage().rss });
      return;
    }

    if (message?.type === 'failover' && process.send) {
      if (!failoverTriggered) {
        failoverTriggered = true;
        const target = plainApps[0];
        target.closed = true;
        await target.app.close();
        process.send({ type: 'failover', target: target.id });
      } else {
        process.send({ type: 'failover', target: plainApps[0].id });
      }
      return;
    }

    if (message === 'close') {
      await close();
      process.disconnect?.();
    }
  });

  process.once('SIGTERM', async () => {
    await close();
    process.exit(0);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
