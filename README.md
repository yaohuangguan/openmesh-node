# OpenMesh for Node.js

**Small core. Connected services.**

[![CI](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml/badge.svg)](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522-green)
![License](https://img.shields.io/badge/license-MIT-blue)

[API](docs/api.md) · [Microservices](docs/services.md) · [0.4 architecture](docs/architecture-0.4.md) · [0.3 architecture](docs/architecture-0.3.md) · [Plugins](docs/plugins.md) · [Peer routing](docs/distributed.md) · [Performance](docs/performance.md) · [Go experiment](docs/native-engine.md)

A TypeScript-first Node.js service runtime with onion middleware, real Express/Fastify bridges, peer routing, registration, discovery, and live configuration. The native Node core has **zero runtime dependencies**; the package is built from one strict TypeScript source tree into ESM, CommonJS, and generated declarations.

Version **0.4.0 is pre-1.0**: the public API is usable, but compatibility can still evolve between minor releases. Performance is tracked through normalized regression budgets against a same-run baseline rather than unsupported \"fastest framework\" claims. This project is independent of Openmesh Network; its package name is `openmesh-node`.

## What is included

- Native HTTP routing, async handlers, streams, scoped plugins, route-schema compiler hooks, and graceful shutdown.
- Node/Express middleware and complete Express application mounts.
- Fastify plugins inside an actual, optionally installed Fastify 5 instance.
- HTTP peer routing with keyed rendezvous affinity, load-aware P2C selection, bounded admission/backpressure, streaming responses, deadlines, retries, circuits, and bounded broadcasts.
- Authenticated control-plane API with protocol/capability discovery, expiring registration leases, automatic heartbeats, and pre-drain deregistration.
- Pluggable registry/config adapters with in-memory defaults, async adapter support, and durable Redis adapters with atomic lease/CAS transitions.
- Push-based SSE/PubSub watches for service membership and configuration, with polling/TTL-expiry compatibility.
- Managed per-service pools that combine discovery watches with isolated concurrency/queue/circuit state; deregistration when services shut down.
- Immutable live configuration, validation, and epoch/revision compare-and-swap.
- Request IDs, `traceparent` propagation, health endpoints, AsyncLocalStorage request context, exporter-neutral lifecycle events, and an optional OpenTelemetry-compatible metrics bridge.
- Scoped control-plane credentials with action and resource boundaries, optional adaptive concurrency with hard ceilings, plus normalized benchmark-regression budgets in CI.
- TypeScript-first source with generated ESM/CommonJS builds and generated public declarations.

The default control-plane stores are in-memory and are best suited to local clusters, integration testing, and early deployments. For durable single-Redis-backed deployments, use `openmesh-node/services/redis`; the adapter boundary also supports other external stores. OpenMesh does not claim to provide replicated consensus by itself. P2P means known HTTP nodes; NAT traversal and DHT are not implemented.

## Start a service

Requires Node.js 22+. Install from npm:

```sh
npm install openmesh-node
```

Save as `server.mjs`:

```js
import openmesh from 'openmesh-node';
import { jsonBody } from 'openmesh-node/plugins';

const app = openmesh();
app.use(jsonBody());
app.get('/', () => ({ hello: 'OpenMesh' }));
app.get('/users/:id', ctx => ({ id: ctx.params.id }));
app.post('/echo', ctx => ctx.requestBody);

await app.listen({ port: 3000 });
process.once('SIGTERM', () => app.close());
process.once('SIGINT', () => app.close());
```

Run `node server.mjs`. Default bind address: `127.0.0.1`; use an explicit host for containers. CommonJS: `const openmesh = require('openmesh-node');`.

## Registration and discovery

Start a control-plane service:

```js
import openmesh from 'openmesh-node';
import { controlPlane } from 'openmesh-node/services';

const control = openmesh();
control.register(controlPlane({ token: process.env.OPENMESH_TOKEN }));
await control.listen({ port: 4000 });
```

Register a service after its listener binds:

```js
import { ControlClient, serviceRegistration } from 'openmesh-node/services';

const client = new ControlClient({
  url: 'http://127.0.0.1:4000/_mesh',
  token: process.env.OPENMESH_TOKEN
});
app.onClose(() => client.close());
app.register(serviceRegistration({
  client, service: 'users', id: 'users-a', ttl: 30000,
  url: address => 'http://127.0.0.1:' + address.port
}));
```

Configure before `app.listen()`. Set a token of at least 16 characters. For production least privilege, `controlPlane({ credentials: [...] })` can restrict tokens to `meta:read`, service read/write, or config read/write scopes and to exact service/namespace names; the simple `token` option remains full access. Advertise an address reachable by callers; a container's loopback is usually only reachable inside that container. Registration is awaited before `listen()` resolves, renews in the background, and is removed on shutdown.

```js
const users = await client.service('users', {
  maxInflight: 64,
  maxQueue: 128
});
const response = await users.request('/users/42', { key: '42' });
console.log(response.peer.id, response.json());
app.onClose(() => users.close());
```

The managed service pool follows discovery automatically and isolates its concurrency/queue/circuit state from other services. Use `PeerPool` directly when membership comes from another registry or when no control plane is involved. POST/PATCH do not retry by default. [Exact retry and discovery semantics](docs/distributed.md).

## Live configuration

```js
const current = await client.getConfig('users');
await client.setConfig('users', { greeting: 'Hello' }, {
  expectedRevision: current.revision,
  expectedEpoch: current.epoch
});

const config = await client.watchConfig('users', {
  validate(values) {
    if (typeof values.greeting !== 'string') throw new Error('greeting must be a string');
  },
  onUpdate(snapshot) { console.log('Configuration revision:', snapshot.revision); }
});
console.log(config.get('greeting'));
```

Updates replace the whole namespace and reject stale writes. Invalid or unavailable updates preserve the last accepted snapshot. [API and operational limits](docs/services.md).

## Try the complete microservice flow

```sh
git clone https://github.com/yaohuangguan/openmesh-node.git
cd openmesh-node
npm ci --ignore-scripts
npm run demo:services
```

The demo starts a control plane, two registered services, and a gateway. It changes configuration without restarting services, shuts down the selected instance, and verifies discovery routes to the remaining instance. `npm run example:services` leaves the system running.

## Existing ecosystems

```js
app.useExpress(cors());
app.mount('/legacy', expressApp);
app.fastify('/validated', async host => {
  host.get('/hello', async () => ({ engine: 'fastify' }));
});
```

Install the corresponding optional ecosystem packages. Native plugins use `app.register(plugin, { prefix })`; Fastify hooks, schemas, and decorations remain owned by the real Fastify instance. [Compatibility guide](docs/plugins.md).

## Verification and release

```sh
npm test
npm run test:types
npm run demo:services
npm run bench
```

CI covers Node 22/24 on Windows/Linux. Checked-in reports include raw per-round data and workload limits. The Go experiment measures both Go-only HTTP and a Go-to-JavaScript HTTP boundary; it is not a released Go backend.

[Contributing](CONTRIBUTING.md) · [Release instructions](docs/releasing.md) · [Launch material](docs/launch.md) · [Changelog](CHANGELOG.md). MIT License.
