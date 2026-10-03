# Application-native Mesh — 0.5 preview

> **Start as an API. Grow into a mesh.**

OpenMesh 0.5 moves the mesh into the Node.js application runtime.

Traditional service meshes commonly put a network proxy beside every workload. OpenMesh takes a different path for Node.js services: the application runtime itself understands service discovery, peer selection, deadlines, retries, circuits, pressure, streaming, traffic policy, and trace propagation.

There is no sidecar hop in the OpenMesh data path.

This is **not** a claim that OpenMesh 0.5 replaces Istio or Linkerd. Workload identity and automatic service-to-service mTLS are not part of this preview yet.

## Start with a normal API

Ordinary HTTP development stays ordinary:

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
  const user = await users.create({
    id: params.id,
    name: body.name
  });

  return created(user);
});

await app.listen({ port: 3000 });
```

`body`, `params`, `query`, and `headers` are inferred from Standard Schema-compatible contracts. Response statuses and bodies are checked by TypeScript and validated again at runtime.

No controller class, decorator system, or functional DSL is required for the normal path.

## Then the application grows

A gateway now needs users, payments, and inventory:

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

const users = app.mesh('users');
const payments = app.mesh('payments');
const inventory = app.mesh('inventory');
```

`app.mesh(name)` returns a lazy service handle immediately. It does not perform discovery until the first real call.

Use it like an RPC-oriented HTTP client:

```ts
const payment = await payments.post<Payment>('/charges', {
  key: user.id,
  body: {
    userId: user.id,
    amount: order.total
  }
});
```

That call is not a naked `fetch()`.

Behind it, the existing OpenMesh service runtime owns:

```text
service discovery
      ↓
traffic target
      ↓
peer selection
      ↓
per-service admission / bulkhead
      ↓
deadline
      ↓
retry policy
      ↓
circuit breaker
      ↓
HTTP transport
      ↓
peer metrics / tracing
```

## Service handles are lazy and stateful

Repeated calls to:

```ts
app.mesh('payments')
```

return the same logical service handle.

The first request creates one managed `ServicePool`. That pool keeps:

- a live discovery watch;
- peer circuit state;
- per-service in-flight and queue limits;
- adaptive concurrency state;
- peer latency/failure statistics.

The expensive state belongs to the service relationship, not to each request.

## Request API

The high-level methods parse successful responses:

```ts
await service.get<T>(path, options);
await service.post<T>(path, options);
await service.put<T>(path, options);
await service.patch<T>(path, options);
await service.delete<T>(path, options);
```

JSON responses become objects. Empty `204` responses become `undefined`. Other payloads become text.

Non-2xx responses throw `MeshHttpError` after OpenMesh has applied its configured peer/retry semantics:

```ts
try {
  await payments.post('/charges', { body });
} catch (error) {
  if (error instanceof MeshHttpError) {
    console.log(error.statusCode);
    console.log(error.peer.id);
    console.log(error.data);
  }
}
```

For lower-level control:

```ts
const response = await payments.request('/health');
const stream = await payments.stream('/events', {
  idleTimeout: 30_000
});
```

Raw and streaming calls still use the same discovery and traffic-target selection.

## Trace propagation is automatic

Give the application a service name:

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
```

OpenMesh installs its request context at application creation time.

An incoming request gets or preserves:

- `x-request-id`;
- W3C `traceparent`.

Calls made through `app.mesh(...)` automatically carry the current outbound request context.

Business handlers do not need to copy tracing headers manually.

## Traffic policy

Service registrations already carry metadata:

```ts
app.register(serviceRegistration({
  client,
  service: 'payments',
  id: 'payments-v2-a',
  metadata: {
    version: 'v2',
    region: 'nz'
  },
  url: address => 'http://127.0.0.1:' + address.port
}));
```

OpenMesh 0.5 can route a service across metadata subsets:

```ts
const app = openmesh({
  service: 'gateway',

  mesh: {
    control: {
      url: process.env.OPENMESH_CONTROL_URL!,
      token: process.env.OPENMESH_TOKEN!
    },

    services: {
      payments: {
        traffic: {
          routes: [
            {
              name: 'beta-users',
              when: {
                headers: {
                  'x-beta-user': 'true'
                }
              },
              target: {
                version: 'v2'
              }
            }
          ],

          split: [
            {
              name: 'stable',
              match: { version: 'v1' },
              weight: 90
            },
            {
              name: 'canary',
              match: { version: 'v2' },
              weight: 10
            }
          ],

          fallback: 'error'
        }
      }
    }
  }
});
```

Traffic `routes` are evaluated in order. A matching rule wins before the weighted split.

When a mesh call happens inside an OpenMesh request context, header rules can inspect the original inbound request headers without automatically forwarding those headers to the downstream service. Only request-id/trace context and headers explicitly supplied on the mesh call are propagated by default.

That makes a beta route possible without business-handler branching:

```text
incoming x-beta-user: true
          ↓
gateway handler
          ↓
payments.post(...)
          ↓
traffic route → version=v2
```

If no route matches, the weighted `split` is used.

With a request key:

```ts
await payments.post('/charges', {
  key: user.id,
  body
});
```

the weighted subset choice is deterministic for that key. A user can remain on the same release subset while peers inside that subset are still selected by the normal pool strategy.

Without a key, OpenMesh distributes requests across the weighted subsets.

## Explicit targeting

A call can target metadata directly:

```ts
await payments.get('/health', {
  target: {
    version: 'v2',
    region: 'nz'
  }
});
```

This is useful for:

- smoke tests;
- admin tools;
- canary verification;
- regional routing controlled by application policy.

Explicit targeting does not silently fall back to another subset.

## Fallback behavior

Weighted policies may opt into fallback:

```ts
traffic: {
  split: [
    { match: { region: 'nz' }, weight: 100 }
  ],
  fallback: 'all'
}
```

If the selected policy subset has no members, `fallback: 'all'` uses the full discovered service.

With `fallback: 'error'`, OpenMesh fails with `NO_TRAFFIC_TARGET`.

An explicit per-request `target` always fails closed when no instance matches.

## Pressure isolation

Mesh services inherit the existing `ServicePool` options:

```ts
mesh: {
  control: { ... },

  defaults: {
    timeout: 2_000,
    retries: 1,
    maxInflight: 64,
    maxQueue: 128,
    adaptiveConcurrency: true
  }
}
```

Per-service overrides are supported:

```ts
services: {
  payments: {
    maxInflight: 32,
    maxQueue: 32
  },

  search: {
    maxInflight: 128,
    adaptiveConcurrency: {
      min: 8,
      initial: 32,
      max: 128,
      targetLatencyMs: 100
    }
  }
}
```

A slow payments service therefore does not consume the search service's admission budget.

## What remains low-level

The lower-level APIs are not removed:

```ts
new ControlClient(...)
client.service(...)
new PeerPool(...)
```

They remain useful for:

- infrastructure integrations;
- custom runtimes;
- advanced tests;
- adapter authors;
- code that wants raw lifecycle control.

`app.mesh()` is a developer facade over those primitives, not a second implementation.

## Current boundaries

The 0.5 preview covers application-level service communication:

- service registration and discovery;
- live membership watches;
- metadata traffic subsets;
- weighted canary splits;
- sticky subset selection with request keys;
- P2C/rendezvous peer selection;
- per-service bulkheads and queues;
- adaptive concurrency;
- deadlines and retry rules;
- circuit breakers;
- buffered and streaming requests;
- trace/request-id propagation;
- lifecycle metrics and OpenTelemetry bridge;
- in-memory or Redis-backed control-plane state.

It does **not** yet provide:

- workload identity;
- automatic service-to-service mTLS;
- transparent interception of arbitrary process traffic;
- Kubernetes CNI integration;
- ingress/gateway replacement;
- L4 proxying for arbitrary non-HTTP protocols.

The next major mesh security milestone should be workload identity + mTLS.

## Product direction

The intended OpenMesh learning curve is:

```text
openmesh()
  ↓
app.get() / app.post()
  ↓
app.mesh('service')
  ↓
traffic policy / pressure / observability
  ↓
advanced control-plane and adapter APIs
```

The application can start as one ordinary Node.js API and grow into multiple services without changing to a different programming model.

> **Start as an API. Grow into a mesh.**
