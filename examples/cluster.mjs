import openmesh from '../index.mjs';
import { PeerPool } from '../mesh/index.mjs';
import { requestContext, health } from '../plugins/index.mjs';

// Three independent HTTP listeners. No registry is required for this example.
const nodes = [];
const gateway = openmesh();
let pool;
async function shutdown() {
  await gateway.close();
  pool?.close();
  await Promise.all(nodes.map(({ app }) => app.close()));
}

try {
  for (const id of ['node-a', 'node-b', 'node-c']) {
    const app = openmesh();
    app.use(requestContext({ service: id }));
    app.register(health());
    app.get('/users/:id', ctx => ({ id: ctx.params.id, servedBy: id, requestId: ctx.state.requestId }));
    const address = await app.listen({ port: 0 });
    nodes.push({ app, peer: { id, url: `http://127.0.0.1:${address.port}` } });
  }

  pool = new PeerPool({ peers: nodes.map(node => node.peer), timeout: 1500, retries: 2, failureThreshold: 1, cooldown: 5000 });
  gateway.use(requestContext({ service: 'gateway' }));
  gateway.register(health({ ready: () => pool.stats().some(peer => peer.circuit !== 'open') }));
  gateway.get('/users/:id', async ctx => {
    const response = await pool.request(`/users/${encodeURIComponent(ctx.params.id)}`, {
      key: ctx.params.id, headers: ctx.state.outboundHeaders
    });
    ctx.set('x-mesh-peer', response.peer.id);
    ctx.status = response.statusCode;
    return response.json();
  });
  gateway.get('/mesh/peers', () => pool.stats());
  gateway.get('/mesh/broadcast', async ctx => {
    const results = await pool.broadcast('/health/live', { concurrency: 2, headers: ctx.state.outboundHeaders });
    return results.map(result => ({ peer: result.peer.id, status: result.status,
      ...(result.status === 'fulfilled' ? { body: result.value.json() } : { error: result.reason.code || result.reason.message }) }));
  });
  gateway.setErrorHandler((error, ctx) => { ctx.status = 502; return { error: 'Upstream unavailable', code: error.code || 'UPSTREAM_ERROR' }; });
  gateway.onClose(() => pool.close());

  const demo = process.argv.includes('--demo');
  const address = await gateway.listen({ port: demo ? 0 : Number(process.env.PORT || 3000) });
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`Gateway: ${url}/users/42`);
  console.log(`Peers: ${url}/mesh/peers`);
  console.log(`Broadcast: ${url}/mesh/broadcast`);

  if (demo) {
    const before = await fetch(url + '/users/42');
    const selected = before.headers.get('x-mesh-peer');
    console.log('Before:', await before.json());
    await nodes.find(node => node.peer.id === selected).app.close();
    console.log('Stopped:', selected);
    const after = await fetch(url + '/users/42');
    if (after.status !== 200 || after.headers.get('x-mesh-peer') === selected) throw new Error('Failover demonstration failed');
    console.log('After:', await after.json());
    console.log('Broadcast:', await (await fetch(url + '/mesh/broadcast')).json());
    await shutdown();
  } else {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown().catch(error => { console.error(error); process.exitCode = 1; }));
  }
} catch (error) {
  await shutdown();
  console.error(error);
  process.exitCode = 1;
}
