# OpenMesh for Node.js

**Small core. Connected services.**

[![CI](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml/badge.svg)](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522-green)
![License](https://img.shields.io/badge/license-MIT-blue)

[API](docs/api.md) · [Microservices](docs/services.md) · [0.3 architecture](docs/architecture-0.3.md) · [Plugins](docs/plugins.md) · [Peer routing](docs/distributed.md) · [Performance](docs/performance.md) · [Go experiment](docs/native-engine.md)

A TypeScript-first Node.js service runtime with onion middleware, real Express/Fastify bridges, peer routing, registration, discovery, and live configuration. The native Node core has **zero runtime dependencies**; the package is built from one strict TypeScript source tree into ESM, CommonJS, and generated declarations.

Version **0.2.0 is experimental**. The performance goal is a substantial, reproducible lead over Fastify; that goal has **not yet been achieved**. Reports distinguish measurements from targets. This project is independent of Openmesh Network; its package name is `openmesh-node`.

## What is included

- Native HTTP routing, async handlers, streams, scoped plugins, route-schema compiler hooks, and graceful shutdown.
- Node/Express middleware and complete Express application mounts.
- Fastify plugins inside an actual, optionally installed Fastify 5 instance.
- HTTP peer routing with rendezvous hashing, deadlines, retries, circuits, and bounded broadcasts.
- Authenticated control-plane API with expiring registration leases and automatic heartbeats.
- Pluggable registry/config adapters with in-memory defaults and async adapter support.
- Push-based SSE watches for service membership and configuration, with polling compatibility.
- Discovery that feeds the peer pool; deregistration when services shut down.
- Immutable live configuration, validation, and epoch/revision compare-and-swap.
- Request IDs, `traceparent` propagation, health endpoints, and AsyncLocalStorage request context.
- TypeScript-first source with generated ESM/CommonJS builds and generated public declarations.

The bundled control plane stores state in one process's memory. Use it for local clusters, integration testing, and early deployments; it does not provide durable or replicated consensus storage. Existing discovery callbacks can integrate an external registry. P2P means known HTTP nodes; NAT traversal and DHT are not implemented.

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

Configure before `app.listen()`. Set a token of at least 16 characters. Advertise an address reachable by callers; a container's loopback is usually only reachable inside that container. Registration is awaited before `listen()` resolves, renews in the background, and is removed on shutdown.

```js
import { PeerPool } from 'openmesh-node/mesh';

const peers = new PeerPool({ peers: await client.discover('users') });
peers.watch(() => client.discover('users'), { interval: 1000 });
const response = await peers.request('/users/42', { key: '42' });
console.log(response.peer.id, response.json());
```

Close the peer pool when the application closes. POST/PATCH do not retry by default. [Exact retry and discovery semantics](docs/distributed.md).

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
