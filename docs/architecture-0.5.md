# OpenMesh 0.5 architecture

OpenMesh 0.5 turns the project from a Node.js HTTP runtime with distributed-service primitives into an **application-native service runtime**.

The design goal is not to hide the network. It is to make the parts that normally become glue code — HTTP contracts, discovery, peer selection, traffic policy, deadlines, retries, circuits, workload identity, lifecycle, and telemetry — explicit parts of one Node.js runtime.

> Start as an API. Grow into a mesh without changing programming models.

## System model

A 0.5 application has four layers that can be adopted independently:

```text
application
    |
    v
HTTP runtime
  routing · middleware · schema contracts · lifecycle hooks · body parsing
    |
    +------------------- database resources
    |
    v
application-native mesh
  app.mesh() · discovery · traffic policy · admission · retries · circuits
    |
    v
control plane
  registration · membership watches · config CAS · traffic config
    |
    v
infrastructure adapters
  in-memory · Redis · external registry/config stores
```

Workload identity and observability cut across these layers without introducing a second request engine.

## 1. Native HTTP remains the data path

OpenMesh still owns a normal Node.js HTTP server. It does not proxy application requests through another runtime.

```text
socket
  -> router
  -> middleware / body parsing
  -> schema validation
  -> handler
  -> response serialization
  -> socket
```

The default API is deliberately ordinary:

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

Standard Schema-compatible inputs provide type inference and runtime validation. Response contracts are checked at compile time and runtime.

The advanced `openmesh-node/http` package keeps route contracts as immutable values for teams that need tooling, code generation, contract inspection, or a functional API. It is optional and is not required for normal CRUD work.

See [Advanced HTTP Contracts](functional-http.md).

## 2. Application lifecycle is the integration boundary

OpenMesh resources participate in application startup and shutdown rather than being recreated per request.

This applies to:

- HTTP listeners;
- service registration;
- control-plane clients;
- database resources;
- managed service pools;
- telemetry adapters;
- workload certificates.

A startup failure fails closed and attempts cleanup. Graceful shutdown removes discoverable service leases before draining in-flight requests so new callers stop selecting the instance while existing work can finish.

## 3. Database integration preserves the client you chose

`openmesh-node/db` adds lifecycle around an existing ORM or SQL client instead of introducing a query abstraction.

```ts
import { database } from 'openmesh-node/db';

const db = database(prisma, {
  connect: client => client.$connect(),
  disconnect: client => client.$disconnect(),
  transaction: (client, work) => client.$transaction(work)
});

app.register(db);
```

The original client type remains available as `db.client`. Connectionless clients can omit startup hooks. Health checks and transactions are explicit adapters because ORMs expose materially different APIs.

See [Databases and ORMs](database.md).

## 4. The mesh lives inside the application

In 0.5 the preferred service-to-service API is `app.mesh(name)`.

```ts
const app = openmesh({
  service: 'gateway',
  mesh: {
    control: {
      url: process.env.OPENMESH_CONTROL_URL!,
      token: process.env.OPENMESH_TOKEN!
    }
  }
});

const payments = app.mesh('payments');

const result = await payments.post('/charges', {
  key: user.id,
  body: {
    userId: user.id,
    amount: order.total
  }
});
```

A service handle is lazy. The first real request creates and warms one managed service relationship.

That relationship owns:

- a live discovery watch;
- one per-service admission budget and queue;
- peer circuit state;
- adaptive concurrency state;
- peer latency and failure statistics;
- traffic targeting policy;
- HTTP/TLS transport resources.

Repeated calls to `app.mesh('payments')` reuse that state.

There is no sidecar hop in the OpenMesh data path.

See [Application-native Mesh](mesh-runtime.md).

## 5. Routing happens in two stages

OpenMesh separates **which subset may receive the request** from **which peer inside that subset should receive it**.

```text
request
  -> traffic policy selects eligible subset
  -> peer selection ranks eligible instances
  -> admission / deadline / retry / circuit policy
  -> transport
```

### Traffic targeting

0.5 supports:

- metadata matching;
- ordered header-routing rules;
- weighted service subsets;
- sticky weighted selection when a request key is supplied;
- ordered locality preference and failover;
- live policy replacement through control-plane configuration.

Explicit traffic targets fail closed when no instance matches. Header values can influence routing without automatically being forwarded downstream.

### Peer selection

Inside the selected subset:

- keyed calls use rendezvous hashing for stable affinity;
- unkeyed calls default to power-of-two-choices using peer health/load state;
- retries stay inside the selected traffic subset;
- unsafe methods are not retried unless the caller explicitly opts in with an idempotency key.

See [Distributed services and HTTP peers](distributed.md).

## 6. Failure handling is bounded

OpenMesh tries to make overload and failure visible instead of allowing unbounded work to accumulate.

A managed peer pool can enforce:

- `maxInflight`;
- bounded FIFO queueing with `maxQueue`;
- one total request deadline across queueing, transport, and retries;
- per-peer circuit breaking;
- optional adaptive concurrency;
- bounded response bytes;
- post-header stream idle timeouts.

Streaming responses commit once successful non-5xx headers are handed to the caller. A later body failure is surfaced to the consumer and is never replayed on another peer.

This matters for SSE, LLM streams, and other long-lived bodies.

## 7. Discovery and configuration are versioned state

The control plane exposes explicit registration, discovery, and configuration protocols.

Membership is represented as snapshots with revisions. Configuration uses epoch + revision compare-and-swap.

Normal steady-state updates are push-first:

- service membership watches use authenticated SSE;
- configuration watches use authenticated SSE;
- polling remains a compatibility fallback.

Invalid discovery/config/traffic updates preserve the last good state instead of replacing it with a broken snapshot.

The protocol remains storage-agnostic. The bundled in-memory control plane is suitable for local or single-process use. Redis adapters provide durable shared state and the public adapter contracts allow external implementations.

See [Services & control plane](services.md).

## 8. Workload identity is part of the runtime

0.5 adds SPIFFE-style service identities and mutual TLS.

```ts
const app = openmesh({
  service: 'payments',
  identity: {
    trustDomain: 'mesh.example.internal',
    ca,
    cert,
    key,
    allow: ['gateway']
  }
});
```

The workload certificate must identify the local service with a URI SAN such as:

```text
spiffe://mesh.example.internal/service/payments
```

OpenMesh validates the local identity before serving traffic.

When identity is enabled:

- inbound HTTPS requires a trusted client certificate;
- the caller's SPIFFE-style service identity is extracted into request state;
- an optional allow-list authorizes inbound service names;
- outbound `app.mesh()` calls automatically present the caller identity;
- outbound TLS verifies that the destination certificate identifies the expected service.

`app.workload.rotate(...)` can replace workload certificate material without restarting the application. New inbound connections use the replaced server secure context and mesh pools rotate outbound TLS agents with an optional drain grace period.

Certificate issuance, revocation distribution, trust-domain governance, transparent interception, and Kubernetes networking remain external responsibilities. OpenMesh should not be described as a drop-in replacement for Istio or Linkerd.

See [Application-native Mesh](mesh-runtime.md#workload-identity-and-mtls).

## 9. Observability stays exporter-neutral

The runtime emits lifecycle events only when observers are configured.

Application events include request and server lifecycle. Peer events include admission, attempts, success/failure/cancellation, and adaptive-concurrency changes.

`openmesh-node/otel` converts those events into an OpenTelemetry-compatible Meter without making the OpenTelemetry SDK a core dependency.

Request IDs and W3C `traceparent` state propagate through `AsyncLocalStorage` and outbound mesh calls automatically.

See [Observability](observability.md).

## 10. Public package boundaries

OpenMesh 0.5 exposes deliberately small entry points:

| Import | Purpose |
| --- | --- |
| `openmesh-node` | application runtime, routing, lifecycle, typed route shorthand |
| `openmesh-node/plugins` | body parsers, health, ecosystem integrations |
| `openmesh-node/http` | advanced immutable HTTP contract API |
| `openmesh-node/db` | lifecycle wrapper for existing ORM / database clients |
| `openmesh-node/mesh` | lower-level peer pool and distributed HTTP primitives |
| `openmesh-node/services` | control plane, registration, discovery, configuration |
| `openmesh-node/services/redis` | durable Redis registry/configuration adapters |
| `openmesh-node/services/testing` | adapter conformance harnesses |
| `openmesh-node/otel` | OpenTelemetry-compatible metrics bridge |

The lower layers remain available even when the high-level application-native mesh facade is used.

## 11. What OpenMesh owns

OpenMesh 0.5 owns application-level runtime semantics:

- request handling;
- route contracts;
- graceful lifecycle;
- service registration and discovery;
- traffic target selection;
- peer load/failure selection;
- bounded admission;
- deadlines and retries;
- circuit state;
- stream commit semantics;
- workload mTLS enforcement;
- request/trace propagation;
- lifecycle metrics boundaries.

It does **not** own:

- certificate issuance or revocation infrastructure;
- cluster scheduling;
- Kubernetes networking;
- NAT traversal;
- DHT/gossip/consensus;
- durable queues;
- database query languages;
- distributed transactions;
- a full tracing backend.

Those boundaries are intentional.

## 12. Upgrade mental model

The version progression is:

```text
0.1  native HTTP + peer client
  |
0.2  registration + discovery + live configuration
  |
0.3  pluggable control state + push watches + bounded peer admission
  |
0.4  production-tunable data plane + streaming + bulkheads + telemetry + Redis
  |
0.5  application-native mesh + traffic policy + workload identity + typed HTTP + database lifecycle
```

For historical design context, see [0.4 architecture](architecture-0.4.md) and [0.3 architecture](architecture-0.3.md). For current application development, use this document and [Application-native Mesh](mesh-runtime.md) as the primary architecture references.
