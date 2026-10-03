import openmesh, { definePlugin, HttpError, created as rootCreated, reply as rootReply, type AppEvent, type Context, type StandardSchemaV1 as RootStandardSchemaV1, type MeshedOpenMesh } from 'openmesh-node';
import { jsonBody, bodyParser, textBody, rawBody, formBody, multipartBody, requestContext, health } from 'openmesh-node/plugins';
import { POST, pipe, input, returns, implement, created, ok, api, type StandardSchemaV1 } from 'openmesh-node/http';
import { PeerPool, type PeerPoolEvent, type PeerPoolStats, type PeerSelectionStrategy } from 'openmesh-node/mesh';
import { ControlClient, controlPlane, serviceRegistration, ConfigStore, ServiceRegistry, type ControlCredential, type ControlPlaneInfo } from 'openmesh-node/services';
import { createOpenTelemetryObservers, type OpenTelemetryMeter } from 'openmesh-node/otel';
import { runRegistryAdapterConformance, runConfigAdapterConformance } from 'openmesh-node/services/testing';
import { RedisRegistryAdapter, RedisConfigAdapter } from 'openmesh-node/services/redis';
import { createClient } from 'redis';
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
const streamed = await peers.requestStream('/users/42', { idleTimeout: 30000 });
const streamedText: string = await streamed.text();
void streamedText;
peers.close();
const control = new ControlClient({ url: 'http://127.0.0.1:4000/_mesh', token: 'example-token-value' });
const controlInfo: Readonly<ControlPlaneInfo> = await control.info();
const servicePool = await control.service('users', { maxInflight: 32, maxQueue: 64 });
void servicePool.poolStats().maxInflight;
servicePool.close();
void controlInfo.capabilities.serviceWatch;
const scopedCredential: ControlCredential = { token: 'scoped-token-value-1234', scopes: ['services:read'], services: ['users'] };
app.register(controlPlane({ credentials: [scopedCredential] }));
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

const telemetryMeter: OpenTelemetryMeter = {
  createCounter: () => ({ add: () => {} }),
  createHistogram: () => ({ record: () => {} })
};
const telemetryObservers = createOpenTelemetryObservers({ meter: telemetryMeter, attributes: { service: 'users' } });
telemetryObservers.onAppEvent({ type: 'server.closing', at: Date.now() });
telemetryObservers.onPeerEvent({ type: 'admission.rejected', at: Date.now(), inflight: 1, queued: 2 });

void runRegistryAdapterConformance({ create: () => new ServiceRegistry({ sweepInterval: 0 }) });
void runConfigAdapterConformance({ create: () => new ConfigStore() });

const typedRedisClient = createClient({ url: 'redis://127.0.0.1:6379' });
const typedRedisRegistry = new RedisRegistryAdapter({ client: typedRedisClient, prefix: 'openmesh-types' });
const typedRedisConfig = new RedisConfigAdapter({ client: typedRedisClient, prefix: 'openmesh-types' });
void typedRedisRegistry;
void typedRedisConfig;


function standard<T>(): StandardSchemaV1<unknown, T> {
  return null as unknown as StandardSchemaV1<unknown, T>;
}

const NewUserContract = standard<{ name: string }>();
const UserContract = standard<{ id: string; name: string }>();

const createUserContract = pipe(
  POST('/users/:id'),
  input({ body: NewUserContract }),
  returns({ 201: UserContract })
);

const createUserFunctional = implement(createUserContract, async ({ body, params }) => {
  const name: string = body.name;
  const id: string = params.id;
  return created({ id, name });
});

openmesh()
  .use(bodyParser())
  .use(textBody({ types: ['text/*'] }))
  .use(rawBody({ types: ['application/octet-stream'] }))
  .use(formBody())
  .use(multipartBody())
  .register(api('/api', createUserFunctional));

// @ts-expect-error response status 200 is not declared by the contract
implement(createUserContract, async ({ body, params }) => ok({ id: params.id, name: body.name }));

// @ts-expect-error response body does not satisfy the declared User contract
implement(createUserContract, async ({ body }) => created({ id: 123, name: body.name }));


const createUserWithProvider = implement(createUserContract, {
  provide: {
    actor: async ({ headers }) => {
      const authorization: string | string[] | undefined = headers.authorization;
      void authorization;
      return { id: 'actor-1', role: 'admin' as const };
    }
  },
  run: async ({ body, params, actor }) => {
    const actorId: string = actor.id;
    const role: 'admin' = actor.role;
    void actorId;
    void role;
    return created({ id: params.id, name: body.name });
  }
});

openmesh().register(api(createUserWithProvider));


openmesh()
  .addHook('onRequest', ctx => { const method: string | undefined = ctx.method; void method; })
  .addHook('preParsing', ctx => { void ctx.requestBody; })
  .addHook('preValidation', ctx => { void ctx.params; })
  .addHook('preHandler', ctx => { void ctx.query; })
  .addHook('postHandler', (ctx, value) => { void ctx.status; void value; })
  .addHook('preSerialization', (ctx, value) => { void ctx.body; void value; })
  .addHook('preSend', (ctx, value) => { void ctx.response; void value; })
  .addHook('onResponse', ctx => { void ctx.status; })
  .addHook('onError', (error, ctx) => { const message: string = error.message; void message; void ctx.path; });


function rootStandard<T>(): RootStandardSchemaV1<unknown, T> {
  return null as unknown as RootStandardSchemaV1<unknown, T>;
}

const SimpleNewUser = rootStandard<{ name: string }>();
const SimpleUser = rootStandard<{ id: string; name: string }>();
const SimpleProblem = rootStandard<{ code: string }>();

openmesh()
  .use(bodyParser())
  .post('/simple-users/:id', {
    body: SimpleNewUser,
    response: {
      201: SimpleUser,
      409: SimpleProblem
    }
  }, async ({ body, params, request, response }) => {
    const name: string = body.name;
    const id: string = params.id;
    void request;
    void response;
    return rootCreated({ id, name });
  });

openmesh().post('/simple-conflict', {
  body: SimpleNewUser,
  response: {
    201: SimpleUser,
    409: SimpleProblem
  }
}, async ({ body }) => rootReply(409, { code: body.name }));

openmesh().post('/simple-default-200', {
  response: SimpleUser
}, async () => ({ id: 'u-1', name: 'Sam' }));

openmesh().post('/simple-wrong-status', {
  // @ts-expect-error status 200 is not declared for this typed route
  response: { 201: SimpleUser }
}, async () => ({ id: 'u-1', name: 'Sam' }));

openmesh().post('/simple-wrong-body', {
  // @ts-expect-error id must be a string in the declared response
  response: { 201: SimpleUser }
}, async () => rootCreated({ id: 42, name: 'Sam' }));

const meshed: MeshedOpenMesh = openmesh({
  mesh: {
    control: {
      url: 'http://127.0.0.1:4000/_mesh',
      token: 'mesh-control-token-value'
    },
    services: {
      payments: {
        traffic: {
          split: [
            { match: { version: 'v1' }, weight: 90 },
            { match: { version: 'v2' }, weight: 10 }
          ]
        }
      }
    }
  }
});

const typedPayments = meshed.mesh('payments');
const paymentData: Promise<{ id: string }> = typedPayments.post<{ id: string }>('/charges', {
  body: { amount: 10 },
  key: 'user-1'
});
void paymentData;
void typedPayments.get('/health', { target: { version: 'v2' } });

// @ts-expect-error mesh is optional when OpenMesh is created without mesh configuration
openmesh().mesh('payments');
