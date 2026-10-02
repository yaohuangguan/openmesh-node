import { randomBytes } from 'node:crypto';
import openmesh from '../index.mjs';
import { PeerPool } from '../mesh/index.mjs';
import { controlPlane, ControlClient, serviceRegistration } from '../services/index.mjs';
import { health, requestContext } from '../plugins/index.mjs';

const token = process.env.OPENMESH_TOKEN || randomBytes(32).toString('hex');
const control = openmesh().register(controlPlane({ token }));
const nodes = [];
const gateway = openmesh();
let admin;
let gatewayControl;
let pool;
async function shutdown() {
  await gateway.close();
  pool?.close();
  await Promise.all(nodes.map(node => node.app.close()));
  await gatewayControl?.close();
  await admin?.close();
  await control.close();
}
try {
  const address = await control.listen({ port: 0 });
  const controlURL = `http://127.0.0.1:${address.port}/_mesh`;
  admin = new ControlClient({ url: controlURL, token });
  const initial = await admin.getConfig('users');
  await admin.setConfig('users', { message: 'Hello' }, { expectedRevision: initial.revision, expectedEpoch: initial.epoch });

  for (const id of ['users-a', 'users-b']) {
    const app = openmesh();
    const client = new ControlClient({ url: controlURL, token });
    app.onClose(() => client.close());
    const config = await client.watchConfig('users', {
      interval: 100,
      validate: values => { if (typeof values.message !== 'string') throw new Error('message must be a string'); }
    });
    app.use(requestContext({ service: 'users' }));
    app.register(serviceRegistration({ client, service: 'users', id, ttl: 3000, url: bound => `http://127.0.0.1:${bound.port}` }));
    app.register(health({ ready: () => app.registration?.healthy === true }));
    app.get('/users/:id', ctx => ({ id: ctx.params.id, servedBy: id, message: config.get('message'), configRevision: config.snapshot.revision }));
    nodes.push({ id, app, config });
    await app.listen({ port: 0 });
  }

  gatewayControl = new ControlClient({ url: controlURL, token });
  pool = new PeerPool({ peers: await gatewayControl.discover('users'), retries: 1, timeout: 1500 });
  pool.watch(() => gatewayControl.discover('users'), { interval: 100, onError: error => console.error('Discovery:', error.message) });
  gateway.use(requestContext({ service: 'gateway' }));
  gateway.onClose(() => gatewayControl.close());
  gateway.onClose(() => pool.close());
  gateway.get('/users/:id', async ctx => {
    const response = await pool.request(`/users/${encodeURIComponent(ctx.params.id)}`, { key: ctx.params.id, headers: ctx.state.outboundHeaders });
    ctx.set('x-mesh-peer', response.peer.id); return response.json();
  });
  const demo = process.argv.includes('--demo');
  const bound = await gateway.listen({ port: demo ? 0 : Number(process.env.PORT || 3000) });
  const url = `http://127.0.0.1:${bound.port}/users/42`;
  console.log('Control plane:', controlURL);
  console.log('Gateway:', url);
  console.log('Registered instances:', (await admin.discover('users')).map(instance => instance.id));

  if (demo) {
    const before = await (await fetch(url)).json(); console.log('Before configuration update:', before);
    const current = await admin.getConfig('users');
    const updated = await admin.setConfig('users', { message: 'Welcome' }, { expectedRevision: current.revision, expectedEpoch: current.epoch });
    const deadline = Date.now() + 3000;
    while (nodes.some(node => node.config.snapshot.revision !== updated.revision)) {
      if (Date.now() >= deadline) throw new Error('Configuration refresh timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const configured = await (await fetch(url)).json();
    if (configured.message !== 'Welcome') throw new Error('Configuration update was not applied');
    console.log('After configuration update:', configured);
    await nodes.find(node => node.id === before.servedBy).app.close();
    pool.updatePeers(await admin.discover('users'));
    const after = await (await fetch(url)).json();
    if (after.servedBy === before.servedBy) throw new Error('Stopped instance remained selected');
    console.log('After instance shutdown:', after);
    console.log('Remaining registrations:', (await admin.discover('users')).map(instance => instance.id));
    await shutdown();
  } else {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown().catch(error => { console.error(error); process.exitCode = 1; }));
  }
} catch (error) {
  await shutdown(); console.error(error); process.exitCode = 1;
}
