import openmesh = require('openmesh-node');
import plugins = require('openmesh-node/plugins');
import mesh = require('openmesh-node/mesh');
import services = require('openmesh-node/services');
import otel = require('openmesh-node/otel');
const app = openmesh();
app.use(plugins.jsonBody());
app.get('/', (ctx: openmesh.Context) => ({ method: ctx.method }));
const pool = new mesh.PeerPool({ selection: 'p2c', maxInflight: 64, maxQueue: 128, onEvent: event => { const kind: mesh.PeerPoolEvent['type'] = event.type; void kind; } });
const poolLoad: mesh.PeerPoolStats = pool.poolStats();
void poolLoad.queued;
pool.close();
const credential: services.ControlCredential = { token: 'scoped-token-value-1234', scopes: ['services:read'], services: ['users'] };
app.register(services.controlPlane({ credentials: [credential] }));
const client = new services.ControlClient({ url: 'http://127.0.0.1:4000/_mesh', token: 'example-token-value' });
void client.info().then(info => { const version: number = info.version; void version; });
void client.service('users', { maxInflight: 8, maxQueue: 16 }).then(service => { void service.stats(); service.close(); });
app.register(services.serviceRegistration({ client, service: 'users', id: 'users-a', url: 'http://127.0.0.1:3000' }));
app.onListen(scope => { const healthy: boolean | undefined = scope.registration?.healthy; void healthy; });
app.onShutdown(() => {});
void client.watchService('users').then(watcher => watcher.stop());
void client.close();

const schemaApp = openmesh({ serverLimits: { maxHeadersCount: 100 } });
schemaApp.setValidatorCompiler(() => () => true).setSerializerCompiler(() => body => JSON.stringify(body));
schemaApp.use(plugins.jsonBody({ prototypeAction: 'error' }));
schemaApp.post('/schema', { schema: { body: {}, response: { 200: {} } } }, ctx => ctx.requestBody);

const telemetry = otel.createOpenTelemetryObservers({
  meter: {
    createCounter: () => ({ add: () => {} }),
    createHistogram: () => ({ record: () => {} })
  }
});
telemetry.onAppEvent({ type: 'server.closed', at: Date.now() });
