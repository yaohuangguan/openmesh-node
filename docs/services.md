# Microservice registration, discovery, and configuration

Import these optional APIs from `openmesh-node/services`. They use only Node built-ins and the existing peer client. They stay outside the native HTTP request path.

## Control plane

```js
import openmesh from 'openmesh-node';
import { controlPlane } from 'openmesh-node/services';
const app = openmesh();
app.register(controlPlane({ token: process.env.OPENMESH_TOKEN }));
await app.listen({ port: 4000 });
```

Set `OPENMESH_TOKEN` to 16..1024 printable ASCII characters without spaces. Clients include it as a Bearer token. The legacy `token` option remains an unrestricted credential for simple deployments. For least privilege, use `credentials` instead; each credential declares action scopes and can optionally restrict service or configuration namespace names. The default prefix is `/_mesh`; registration, discovery, and configuration APIs all require authentication. Place a remotely accessible control plane behind HTTPS and use an explicitly advertised address. Tokens are hashed for comparison and are not included in discovery responses or logs.

| Method | Path below `/_mesh` | Payload / result |
| --- | --- | --- |
| GET | `/meta` | control protocol version and optional capabilities |
| POST | `/services/:service/instances/:id` | `{ url, ttl, metadata }` → lease, 201 |
| PUT | `/services/:service/instances/:id/lease` | `{ leaseId }` → renewed lease |
| DELETE | `/services/:service/instances/:id` | `{ leaseId }` → 204 |
| GET | `/services/:service?cursor=last-id` | `{ instances, nextCursor }`, up to 100 records, without lease secrets |
| GET | `/watch/services/:service` | authenticated SSE membership snapshots |
| GET | `/config/:namespace` | `{ namespace, epoch, revision, values }` |
| PUT | `/config/:namespace` | `{ values, expectedEpoch, expectedRevision }` → snapshot |
| GET | `/watch/config/:namespace` | authenticated SSE configuration snapshots |

The control protocol uses the name `openmesh-control` and major version `1`. `await client.info()` validates that protocol version and returns capability flags for service/config streaming watches, membership revisions, configuration CAS, and scoped credentials. The handshake is explicit rather than automatic, so ordinary calls do not pay an extra network round trip.

Scoped credentials use these permissions: `meta:read`, `services:read`, `services:write`, `config:read`, and `config:write`. Omitting `services` or `namespaces` means all resources in that category; supplying a list restricts access to those exact names.

```js
app.register(controlPlane({
  credentials: [
    {
      token: process.env.OPENMESH_DISCOVERY_TOKEN,
      scopes: ['meta:read', 'services:read'],
      services: ['users', 'payments']
    },
    {
      token: process.env.OPENMESH_CONFIG_TOKEN,
      scopes: ['config:read', 'config:write'],
      namespaces: ['users']
    }
  ]
}));
```

A valid token without the required action scope or resource grant receives 403; an unknown token receives 401. A `ControlClient` does not need a new API for scoped credentials: pass its assigned token normally, and the server enforces the grant.

Names must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. Instance URLs require HTTP(S), with no embedded credentials, query, or fragment. TTL is 1 second to 1 hour, default 30 seconds. Metadata is limited to 8 KiB. Configuration values must be JSON objects and are limited to 256 KiB per namespace. Defaults allow 10,000 instances and 1,000 namespaces. For alternate limits pass `registry: new ServiceRegistry(options)` and `config: new ConfigStore(options)`.

Registrations expire according to the registry's clock and are swept periodically and on access. Duplicate active instance IDs return 409. Renew/remove operations require the current lease ID: an old process cannot remove a replacement registration. Discovery includes unexpired registrations; a valid lease does not establish that every application route is healthy.

## Client and automatic registration

```js
import { ControlClient, serviceRegistration } from 'openmesh-node/services';
const client = new ControlClient({
  url: 'http://127.0.0.1:4000/_mesh', token: process.env.OPENMESH_TOKEN,
  timeout: 2000
});
app.onClose(() => client.close());
app.register(serviceRegistration({
  client, service: 'users', id: 'users-a', ttl: 30000,
  url: address => 'http://127.0.0.1:' + address.port,
  onError: error => console.error('Registration:', error.message)
}));
```

The plugin uses `onListen` to register the bound address, then awaits acknowledgement before `listen()` resolves. A failed initial registration closes the bound listener and runs cleanup hooks. During graceful shutdown it removes the lease in the pre-drain `onShutdown` phase, so new discovery traffic stops selecting the instance while requests already in flight can finish. If deregistration fails, listener draining still proceeds and the lease expires by TTL. The server is already bound while listen hooks run: use readiness checks to gate traffic until `app.registration?.healthy` is true. This lifecycle works with `app.listen()`; an externally owned `callback()` server must register itself manually after binding.

Choose a URL reachable by peers, especially in containers. The framework does not infer external proxy ports, container IPs or public addresses. Register shutdown cleanup before startup. The plugin creates `app.registration` and removes its own lease during shutdown; close the provided client separately as shown.

Manual registration:

```js
const lease = await client.register('users', {
  id: 'users-a', url: 'http://127.0.0.1:3000', ttl: 30000
});
console.log(lease.healthy, lease.record);
await lease.stop();
```

Heartbeats run about once per TTL/3, never overlap in normal operation, and have an HTTP deadline. An expired/not-found lease is registered again with a new lease ID. An ownership conflict stops automatic renewal, leaves `healthy` false, and reports the error. Transport errors keep retrying on subsequent heartbeat ticks with the client's circuit cooldown. `lastError` records the latest failure.

Local readiness uses a conservative local TTL deadline, avoiding reliance on synchronized server timestamps. `record.expiresAt` remains the registry's timestamp for inspection. During a control-plane outage, a lease may expire even when the service itself is healthy. If a registration acknowledgement is lost, its orphaned lease disappears by TTL; there is no exactly-once registration guarantee.

`stop()` aborts pending renewal and attempts ownership-safe removal. `client.close()` stops config watchers, removes owned registrations, and destroys transport resources. If removal cannot be completed, it reports an AggregateError and the leases expire normally.

## Discovery and routing

```js
import { PeerPool } from 'openmesh-node/mesh';
const pool = new PeerPool({ peers: await client.discover('users') });
pool.watch(() => client.discover('users'), {
  interval: 1000,
  onError: error => console.error('Discovery:', error.message)
});
const response = await pool.request('/users/42', { key: '42' });
```

Discovery feeds the existing routing/retry/circuit logic. `discover()` follows up to 100 pages (10,000 instances) within one client timeout budget; each response is bounded to 2 MiB. Page reads are not an atomic membership snapshot.

For service-to-service callers, 0.4 adds a managed per-service pool that combines discovery watching with an isolated `PeerPool`:

```js
const users = await client.service('users', {
  maxInflight: 64,
  maxQueue: 128,
  adaptiveConcurrency: {
    min: 8,
    initial: 16,
    max: 64,
    targetLatencyMs: 100
  }
});

const response = await users.request('/users/42', { key: '42' });
console.log(response.json(), users.poolStats());
app.onClose(() => users.close());
```

Each `ServicePool` owns separate admission, queue, peer circuit, load-selection and adaptive-concurrency state. A saturated `users` pool therefore does not consume the `payments` pool's concurrency budget. Membership changes from the service watcher update the pool automatically. Closing a service pool stops its watcher and aborts its peer requests; it does not close the shared `ControlClient`. Closing the `ControlClient` automatically closes any managed service pools it created.

For steady-state discovery without a managed service pool, use the push watcher directly:

```js
const service = await client.watchService('users', {
  onUpdate(instances) {
    pool.updatePeers(instances);
  },
  onError(error) {
    console.error('Service watch:', error.message);
  }
});
pool.updatePeers(service.instances);
```

The watcher receives an initial full membership snapshot and subsequent snapshots over authenticated SSE. This removes normal interval polling. Instance URLs are limited to 2048 characters. If a watch reconnects, the next initial snapshot converges membership again. Close the service watcher/pool before closing the control client.

## Live configuration

```js
const current = await client.getConfig('users');
await client.setConfig('users', { greeting: 'Hello', cacheSize: 100 }, {
  expectedEpoch: current.epoch, expectedRevision: current.revision
});
const config = await client.watchConfig('users', {
  reconnectDelay: 250,
  validate(values) {
    if (typeof values.greeting !== 'string') throw new Error('Invalid greeting');
    if (!Number.isInteger(values.cacheSize) || values.cacheSize < 0) throw new Error('Invalid cache size');
  },
  onUpdate(current, previous) { console.log(previous.revision, current.revision); },
  onError(error) { console.error('Configuration:', error.message); }
});
app.get('/greeting', () => ({ greeting: config.get('greeting') }));
```

Reads start at revision 0 for an empty namespace. Every write replaces the whole JSON object and increments the revision. Epoch + revision compare-and-swap rejects concurrent stale writes and stale writes across a store restart. The store's epoch changes on restart; it is not an authorization token.

Configuration watches use authenticated SSE by default. They validate the initial snapshot and every changed snapshot before switching a deeply frozen reference. A failed stream, fetch, or validation leaves the last accepted state intact and records `lastError`; stream failures reconnect after `reconnectDelay`. If the server reports streaming as unavailable, the client can fall back to the compatibility polling mode. Set `transport: 'poll'` and `interval` explicitly when polling is required.

New store epochs are recognized even when revision numbers match. Validation must be synchronous; `onUpdate` should finish synchronously or manage its own asynchronous side effects. Notification errors do not roll back a snapshot already accepted. `get(key, fallback)` looks up a literal top-level key, not a dotted path.

The initial fetch must succeed. Watchers do not persist a local cache through process restarts. `config.stop()` stops the stream/poll loop; closing the client stops configuration and service watchers.

## Redis durable adapters

`openmesh-node/services/redis` provides durable registry and configuration adapters without coupling the runtime to a particular Redis SDK. Pass any connected client that exposes the standard `sendCommand()` API; Node Redis works directly.

```js
import { createClient } from 'redis';
import {
  RedisRegistryAdapter,
  RedisConfigAdapter
} from 'openmesh-node/services/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

app.register(controlPlane({
  credentials,
  registry: new RedisRegistryAdapter({
    client: redis,
    prefix: 'openmesh-prod',
    watchInterval: 1000
  }),
  config: new RedisConfigAdapter({
    client: redis,
    prefix: 'openmesh-prod'
  })
}));

app.onClose(() => redis.quit());
```

Registry lease creation, renewal, ownership-safe removal, revision updates, and configuration CAS writes use Redis-side Lua scripts so competing control-plane processes cannot interleave those transitions. Lease TTL is enforced by Redis itself. Registry subscriptions combine Pub/Sub for explicit membership changes with a lightweight interval check for TTL expiry, so Redis keyspace notifications are not required. Configuration watches use Pub/Sub and the configuration epoch is persisted in Redis.

Adapters do not close the command client supplied by the application. Subscription connections are created with `client.duplicate()` and are owned and closed by the adapter. Use a distinct `prefix` for independent environments or test runs.

## Adapter conformance

Adapter authors can validate Redis, etcd, SQL, or other implementations with the published `openmesh-node/services/testing` harness.

```js
import {
  runRegistryAdapterConformance,
  runConfigAdapterConformance
} from 'openmesh-node/services/testing';

await runRegistryAdapterConformance({
  create: () => new RedisRegistryAdapter(redis)
});

await runConfigAdapterConformance({
  create: () => new PostgresConfigAdapter(db)
});
```

The registry profile checks registration, duplicate ownership rejection, lease renewal, discovery without lease-secret exposure, ownership-safe deregistration, snapshots when present, and subscriptions when present. The configuration profile checks snapshots, compare-and-swap replacement, stale-write rejection, and subscriptions.

For a durable implementation, pass `reopen` as a factory that creates a new adapter instance connected to the same backing store. The harness then verifies that an unexpired registry lease or the latest configuration survives the reopen. This is deliberately separate from the basic adapter contract so process-local development adapters can still be tested honestly.

## Operational scope

The bundled registry and configuration store are **in-memory, single-process** components. Registrations/configuration are lost on restart. They do not provide replication, leader election, durable transactions, audit history, secret encryption, or multi-writer distributed consensus. The control plane supports scoped Bearer credentials for action/resource authorization, but credential issuance, rotation, revocation distribution, and external identity integration remain deployment responsibilities.

0.3 exposes `RegistryAdapter` and `ConfigAdapter` contracts. Custom implementations may be synchronous or asynchronous. Ordinary control-plane APIs require registration/list or snapshot/replace methods; SSE watch endpoints additionally require `subscribe()` returning an unsubscribe function. This allows Redis, etcd, Consul, SQL, or a standalone Go control plane to preserve the public protocol without coupling storage to the Node request runtime.

Do not run independent in-memory replicas behind a load balancer and assume they share state. External adapters must define their own consistency and watch semantics. Nothing here replaces your deployment platform's health checks or traffic policy. See [0.3 architecture](architecture-0.3.md).

Run `npm run demo:services` for a complete local flow, including live configuration and removing a stopped service from discovery.
