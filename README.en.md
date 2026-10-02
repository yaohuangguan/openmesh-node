# OpenMesh for Node.js

**Fast HTTP. Small core. Connected nodes.**

[![CI](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml/badge.svg)](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml)

[中文](README.md) · [API](docs/api.md) · [Plugins](docs/plugins.md) · [Distributed services](docs/distributed.md) · [Benchmarks](docs/performance.md)

A small Node.js HTTP framework for microservices and HTTP peer networks. The native server has zero runtime dependencies, onion middleware, scoped plugins, and an optional peer client. This project is independent of Openmesh Network; its package and repository name is `openmesh-node`.

## Start a service

Requires Node.js 22+. Install from GitHub; the package is not yet published on npm.

```sh
npm install github:yaohuangguan/openmesh-node
```

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

Save as `server.mjs` and run `node server.mjs`. CommonJS: `const openmesh = require('openmesh-node');`. The default bind address is `127.0.0.1`; set `host: '0.0.0.0'` explicitly for containers.

## Connect services

```js
import { PeerPool } from 'openmesh-node/mesh';
import { requestContext } from 'openmesh-node/plugins';

const pool = new PeerPool({
  peers: [
    { id: 'users-a', url: 'http://127.0.0.1:4001' },
    { id: 'users-b', url: 'http://127.0.0.1:4002' }
  ], timeout: 1500, retries: 1
});
app.use(requestContext({ service: 'gateway' }));
app.get('/profile/:id', async ctx => {
  const response = await pool.request(`/users/${encodeURIComponent(ctx.params.id)}`, {
    key: ctx.params.id, headers: ctx.state.outboundHeaders
  });
  ctx.status = response.statusCode;
  return response.json();
});
app.onClose(() => pool.close());
```

Configure routes and plugins before `ready()` or `listen()`. Keyed rendezvous routing gives stable node preference, with failover, bounded retries, one overall deadline, per-peer circuits, and bounded broadcasts. Discovery callbacks and a custom transport interface support external registries and future transports. Request ID and `traceparent` propagation are opt-in.

POST is not retried by default. Explicit unsafe retries require an idempotency key and server-side deduplication. [Read the distributed semantics](docs/distributed.md).

Run the complete three-node failover demonstration:

```sh
git clone https://github.com/yaohuangguan/openmesh-node.git
cd openmesh-node
npm ci --ignore-scripts
npm run demo:cluster
```

It starts three HTTP listeners and a gateway, stops the selected node, verifies failover, and prints broadcast results. `npm run example:cluster` leaves the cluster running.

## Use existing ecosystems

Node/Express middleware uses `app.useExpress(fn)`. Entire Express apps use `app.mount('/legacy', expressApp)`. Fastify plugins use `app.fastify('/api', plugin)` inside a real, optionally installed Fastify 5 instance, preserving its schema, hooks and plugin lifecycle. Native OpenMesh plugins use `app.register(plugin, { prefix })` with scoped middleware and decorations. [Plugin guide](docs/plugins.md).

Native HTTP routes remain independent of the bridged engines. The optional peer client is imported from `openmesh-node/mesh`.

## Status and performance

Version 0.1.0 is experimental. HTTP communication between known peers is implemented. NAT traversal, DHT, gossip, consensus, and built-in libp2p are future work. Trace headers are provided; a full OpenTelemetry exporter is not included.

The Fastify-level throughput target is evaluated with checked-in [raw benchmark data and methodology](docs/performance.md), covering plaintext, JSON, parameters, body parsing, and middleware. Results apply to those workloads on the recorded machine.

```sh
npm test
npm run test:types
npm run demo:cluster
npm run bench
```

Contributions are welcome: real plugin recipes, discovery adapters, and independently reproduced benchmarks. [Contributing](CONTRIBUTING.md). MIT License.
