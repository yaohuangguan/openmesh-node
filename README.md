# OpenMesh for Node.js

**Start as an API. Grow into a mesh.**

OpenMesh is a TypeScript-first Node.js runtime for building ordinary HTTP APIs that can grow into an **application-native service mesh**: discovery, routing, backpressure, retries, circuits, streaming, traffic policy, live configuration, and observability stay inside the runtime instead of requiring a sidecar on every service.

[![npm](https://img.shields.io/npm/v/openmesh-node?label=npm)](https://www.npmjs.com/package/openmesh-node)
[![CI](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml/badge.svg)](https://github.com/yaohuangguan/openmesh-node/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A522-43853d)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```sh
npm install openmesh-node
```

**v0.4.0 is live on npm.** It ships ESM + CommonJS + declarations and keeps the native HTTP core at **zero runtime dependencies**.

**v0.5 is currently a preview branch.** The new developer surface is intentionally smaller: typed `app.get/post/...` for normal APIs, then `app.mesh('service')` when the application grows. See [Application-native Mesh](docs/mesh-runtime.md) and [Advanced HTTP Contracts](docs/functional-http.md).

[Get started](#start-in-30-seconds) · [Why OpenMesh](#why-openmesh) · [Architecture](#architecture) · [Microservices](docs/services.md) · [Peer routing](docs/distributed.md) · [Observability](docs/observability.md) · [Performance](docs/performance.md) · [API](docs/api.md)

---

## 0.5 preview: from API to mesh

Normal API development stays small:

```ts
import openmesh, { created } from 'openmesh-node';
import { bodyParser } from 'openmesh-node/plugins';

const app = openmesh();
app.use(bodyParser());

app.post('/users/:id', {
  body: NewUser,
  response: {
    201: User,
    409: Problem
  }
}, async ({ body, params }) => {
  return created(await users.create({
    id: params.id,
    ...body
  }));
});
```

When that application splits into services, the programming model grows instead of changing:

```ts
const app = openmesh({
  service: 'gateway',

  mesh: {
    control: {
      url: process.env.OPENMESH_CONTROL_URL,
      token: process.env.OPENMESH_TOKEN
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

const payments = app.mesh('payments');

const charge = await payments.post('/charges', {
  key: user.id,
  body: {
    userId: user.id,
    amount: order.total
  }
});
```

That call reuses OpenMesh's existing discovery watch, per-service bulkhead, deadlines, retry policy, circuit state, peer routing, tracing, and metrics. There is no sidecar hop.

The 0.5 preview does **not** yet provide workload identity or automatic service-to-service mTLS, so it should not be described as a drop-in Istio/Linkerd replacement.

## Why OpenMesh

Most Node.js HTTP libraries stop at the server boundary. OpenMesh keeps going.

| Problem | OpenMesh primitive |
| --- | --- |
| How do I call healthy service instances? | Discovery-backed `ServicePool` |
| What happens when downstream is overloaded? | Bounded admission, queues, bulkheads, adaptive concurrency |
| How do I fail over without replaying unsafe work? | Deadlines, retry policy, circuit breaking, idempotency-aware rules |
| How do long-lived responses behave? | True streaming with explicit post-header no-replay semantics |
| How does topology update without restarts? | Registration leases + push watches |
| How do I change config safely at runtime? | Immutable snapshots + revision/epoch CAS |
| How do I persist the control plane? | Durable Redis adapters |
| How do I limit control-plane access? | Scoped credentials + service/namespace boundaries |
| How do I export telemetry? | Request/server/peer lifecycle events + OpenTelemetry-compatible metrics bridge |

The goal is a small runtime with clear failure semantics—not a hidden cluster platform.

## Architecture

```text
                         ┌──────────────────────────┐
                         │      Control Plane       │
                         │ registration • config    │
                         │ scopes • watches • CAS   │
                         └────────────┬─────────────┘
                                      │
                               in-memory / Redis
                                      │
                                      ▼
┌──────────────┐      ┌───────────────────────────────┐
│ Your service │ ───▶ │       OpenMesh runtime        │
│ routes/hooks │      │                               │
└──────────────┘      │ ServicePool                   │
                      │   └─ discovery watch          │
                      │   └─ per-service bulkhead     │
                      │   └─ adaptive concurrency     │
                      │                               │
                      │ PeerPool                      │
                      │   └─ P2C / rendezvous         │
                      │   └─ queue / deadline         │
                      │   └─ retry / circuit          │
                      │   └─ buffered / streaming     │
                      └───────────────┬───────────────┘
                                      │ HTTP
                        ┌─────────────┼─────────────┐
                        ▼             ▼             ▼
                     service-a     service-b     service-c
```

No sidecar is required. No Go process sits in the request path. Redis, OpenTelemetry, Express, and Fastify integrations are optional boundaries, not core runtime dependencies.

## Start in 30 seconds

Requires Node.js 22+.

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

Run:

```sh
node server.mjs
```

CommonJS is supported too:

```js
const openmesh = require('openmesh-node');
```

## Connect services

OpenMesh can own service registration, discovery, routing, and per-service pressure isolation.

Start a control plane:

```js
import openmesh from 'openmesh-node';
import { controlPlane } from 'openmesh-node/services';

const control = openmesh();

control.register(controlPlane({
  token: process.env.OPENMESH_TOKEN
}));

await control.listen({ port: 4000 });
```

Register a service:

```js
import {
  ControlClient,
  serviceRegistration
} from 'openmesh-node/services';

const client = new ControlClient({
  url: 'http://127.0.0.1:4000/_mesh',
  token: process.env.OPENMESH_TOKEN
});

app.onClose(() => client.close());

app.register(serviceRegistration({
  client,
  service: 'users',
  id: 'users-a',
  ttl: 30_000,
  url: address => 'http://127.0.0.1:' + address.port
}));
```

Then call the service through a managed pool:

```js
const users = await client.service('users', {
  maxInflight: 64,
  maxQueue: 128,
  adaptiveConcurrency: true
});

const response = await users.request('/users/42', {
  key: '42'
});

console.log(response.peer.id, response.json());
```

Membership changes are followed automatically. Each service gets isolated queue, concurrency, circuit, and adaptive state.

## Streaming that knows when a response is committed

```js
const stream = await users.requestStream('/events', {
  timeout: 5_000,
  idleTimeout: 30_000
});

stream.body.pipe(process.stdout);
```

For streaming calls, the normal timeout covers admission + response headers. After non-5xx headers are handed to the caller, OpenMesh treats the response as committed and will **not replay it on another peer** if the body later fails.

That behavior matters for SSE, LLM responses, large downloads, and any operation where invisible retries would be dangerous.

## Durable Redis control plane

The default registry/config stores are in-memory. For durable deployments, use the Redis adapters:

```js
import { createClient } from 'redis';
import {
  RedisRegistryAdapter,
  RedisConfigAdapter
} from 'openmesh-node/services/redis';

const redis = createClient({
  url: process.env.REDIS_URL
});

await redis.connect();

control.register(controlPlane({
  credentials,
  registry: new RedisRegistryAdapter({
    client: redis,
    prefix: 'openmesh-prod'
  }),
  config: new RedisConfigAdapter({
    client: redis,
    prefix: 'openmesh-prod'
  })
}));
```

Lease ownership, renewal, deregistration, configuration CAS, and revision updates use Redis-side atomic transitions. Registry watches combine Pub/Sub with TTL-expiry detection, so Redis keyspace notifications are not required.

[Redis adapter details](docs/services.md#redis-durable-adapters)

## Least-privilege control plane

Simple deployments can use one token. Larger deployments can scope credentials by action and resource.

```js
control.register(controlPlane({
  credentials: [
    {
      token: process.env.DISCOVERY_TOKEN,
      scopes: ['meta:read', 'services:read'],
      services: ['users', 'payments']
    },
    {
      token: process.env.CONFIG_TOKEN,
      scopes: ['config:read', 'config:write'],
      namespaces: ['users']
    }
  ]
}));
```

A valid credential without the required scope or resource grant receives `403`; an unknown credential receives `401`.

## Live configuration

```js
const current = await client.getConfig('users');

await client.setConfig(
  'users',
  { greeting: 'Hello' },
  {
    expectedRevision: current.revision,
    expectedEpoch: current.epoch
  }
);

const config = await client.watchConfig('users', {
  validate(values) {
    if (typeof values.greeting !== 'string') {
      throw new Error('greeting must be a string');
    }
  }
});
```

Updates replace the whole namespace and reject stale writes. Invalid or unavailable updates preserve the last accepted snapshot.

## Observability without coupling the core to an SDK

OpenMesh emits exporter-neutral lifecycle events only when observers are enabled.

```js
import { metrics } from '@opentelemetry/api';
import { createOpenTelemetryObservers } from 'openmesh-node/otel';

const telemetry = createOpenTelemetryObservers({
  meter: metrics.getMeter('users-service'),
  attributes: {
    service: 'users',
    region: 'nz'
  }
});

const app = openmesh({
  onEvent: telemetry.onAppEvent
});
```

The bridge records bounded, low-cardinality request/peer/admission/concurrency metrics and does not emit raw request paths, peer URLs, bodies, headers, config values, or tokens.

[Observability details](docs/observability.md)

## Use the ecosystem you already have

OpenMesh can host existing Express/Fastify components without pretending they are native OpenMesh middleware.

```js
app.useExpress(cors());

app.mount('/legacy', expressApp);

app.fastify('/validated', async host => {
  host.get('/hello', async () => ({
    engine: 'fastify'
  }));
});
```

Those integrations are optional. The native request path does not require them.

[Compatibility guide](docs/plugins.md)

## Public package surface

| Import | Purpose |
| --- | --- |
| `openmesh-node` | Typed HTTP runtime + `app.mesh()` facade |
| `openmesh-node/plugins` | Native plugins and body parsers |
| `openmesh-node/http` | Advanced functional contract API (0.5 preview) |
| `openmesh-node/mesh` | Low-level peer routing / client data plane |
| `openmesh-node/services` | Registration, discovery, config, control plane |
| `openmesh-node/services/redis` | Durable Redis adapters |
| `openmesh-node/services/testing` | Adapter conformance harness |
| `openmesh-node/otel` | OpenTelemetry-compatible metrics bridge |

Every published subpath is exercised through real packed-tarball CJS + ESM smoke tests in CI.

## Performance discipline

OpenMesh does not market itself as “the fastest Node.js framework.”

The recorded 0.4.0 release benchmark uses the same machine, workload, warmup, process isolation, and load generator for both OpenMesh and the comparison baseline. Across five small loopback workloads, the geometric-mean normalized throughput ratio was **98.0%**, with **0 request errors, timeouts, or non-2xx responses across 30 recorded runs**.

The benchmark exists to answer a more useful question:

> Did the runtime features make the native request path materially worse?

CI enforces normalized regression budgets on every change.

[Method, raw rounds, limits, and reproducibility](docs/performance.md)

## Run the complete microservice demo

```sh
git clone https://github.com/yaohuangguan/openmesh-node.git
cd openmesh-node
npm ci --ignore-scripts
npm run demo:services
```

The demo starts:

```text
control plane
    │
    ├── users-a
    ├── users-b
    │
    └── gateway
```

It then changes configuration live, routes through discovery, shuts down the selected instance, and verifies traffic moves to the remaining service.

## What OpenMesh is — and is not

OpenMesh **is**:

- a Node.js service runtime;
- an application-level data plane for known HTTP services;
- a discovery/configuration control plane with pluggable storage;
- a place to make retry, overload, streaming, and shutdown semantics explicit.

OpenMesh **is not**:

- a Kubernetes replacement;
- a distributed consensus system;
- a NAT traversal layer or DHT;
- a hidden sidecar mesh;
- a claim that every application should stop using Express or Fastify.

The project is pre-1.0. Public APIs are usable, but minor versions can still evolve compatibility.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:types
npm run test:package
npm run demo:services
npm run bench
```

CI covers Node 22/24 on Linux and Windows, real Redis integration, packed-package imports, examples, and normalized benchmark regression.

## Documentation

[Application-native Mesh](docs/mesh-runtime.md) · [API](docs/api.md) · [Advanced HTTP Contracts](docs/functional-http.md) · [Services & control plane](docs/services.md) · [Peer routing](docs/distributed.md) · [0.4 architecture](docs/architecture-0.4.md) · [Observability](docs/observability.md) · [Plugins](docs/plugins.md) · [Performance](docs/performance.md) · [Releasing](docs/releasing.md) · [Changelog](CHANGELOG.md)

## Contributing

Bug reports, production edge cases, benchmark reproductions, adapter implementations, and focused PRs are welcome.

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

**OpenMesh 0.4.0** · MIT licensed · [npm](https://www.npmjs.com/package/openmesh-node) · [source](https://github.com/yaohuangguan/openmesh-node) · [changelog](CHANGELOG.md)
