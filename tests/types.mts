import openmesh, { definePlugin, HttpError, type AppEvent, type Context } from 'openmesh-node';
import { jsonBody, requestContext, health } from 'openmesh-node/plugins';
import { PeerPool, type PeerPoolEvent, type PeerPoolStats, type PeerSelectionStrategy } from 'openmesh-node/mesh';
import { ControlClient, controlPlane, serviceRegistration, ConfigStore, ServiceRegistry, type ControlPlaneInfo } from 'openmesh-node/services';
const app = openmesh({ onEvent: (event: AppEvent) => { void event.type; } });
app.use(jsonBody()).use(requestContext()).register(health());
app.get('/users/:id', (ctx: Context) => ({ id: ctx.params.id }));
app.register(definePlugin(async scope => { scope.get('/status', () => 'ok'); }, { name: 'example' }));
app.setErrorHandler((error, ctx) => { ctx.status = error instanceof HttpError ? error.statusCode : 500; return { error: 'handled' }; });
const selection: PeerSelectionStrategy = 'p2c';
const peers = new PeerPool({
  peers: [{ id: 'local', url: 'http://127.0.0.1:3000' }],
  selection,
  maxInflight: 64,
  maxQueue: 128,
  onEvent: (event: PeerPoolEvent) => { void event.type; },
  adaptiveConcurrency: { min: 4, initial: 8, max: 32, targetLatencyMs: 100 }
});
const peerPoolStats: PeerPoolStats = peers.poolStats();
void peerPoolStats.overloadRejections;
await peers.json('/users/42', { key: '42', timeout: 1000 });
const streamed = await peers.requestStream('/users/42');
const streamedText: string = await streamed.text();
void streamedText;
peers.close();
const control = new ControlClient({ url: 'http://127.0.0.1:4000/_mesh', token: 'example-token-value' });
const controlInfo: Readonly<ControlPlaneInfo> = await control.info();
const servicePool = await control.service('users', { maxInflight: 32, maxQueue: 64 });
void servicePool.poolStats().maxInflight;
servicePool.close();
void controlInfo.capabilities.serviceWatch;
app.register(controlPlane({ token: 'example-token-value' }));
app.register(serviceRegistration({ client: control, service: 'users', id: 'users-a', url: address => typeof address === 'object' && address ? 'http://127.0.0.1:' + address.port : 'http://127.0.0.1:3000' }));
app.onListen(async scope => { const healthy: boolean | undefined = scope.registration?.healthy; void healthy; });
app.onShutdown(async () => {});
const snapshot = await control.getConfig('users');
await control.setConfig('users', { greeting: 'Hello' }, { expectedRevision: snapshot.revision, expectedEpoch: snapshot.epoch });
const config = await control.watchConfig('users', { validate: values => { if (typeof values.greeting !== 'string') throw new Error('invalid greeting'); } });
config.stop();
const membership = await control.watchService('users', { onUpdate: instances => { const first = instances[0]?.id; void first; } });
membership.stop(); await control.close();
const registry = new ServiceRegistry(); registry.subscribe('users', () => {})(); registry.close();
const store = new ConfigStore(); const unsubscribe = store.subscribe('users', () => {}); const initial = store.snapshot('users'); store.replace('users', {}, initial.revision, initial.epoch); unsubscribe(); store.close();

const schemaApp = openmesh({ serverLimits: { requestTimeout: 120000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeadersCount: 100 } });
schemaApp
  .setValidatorCompiler(({ schema }) => value => typeof value === 'object' && value !== null && typeof schema === 'object')
  .setSerializerCompiler(() => body => JSON.stringify(body))
  .use(jsonBody({ prototypeAction: 'remove' }))
  .post('/schema', { schema: { body: { type: 'object' }, response: { '2xx': { type: 'object' } } } }, ctx => ctx.requestBody);
