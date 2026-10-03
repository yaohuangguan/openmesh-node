# Application-native Mesh — 0.5

> **Start as an API. Grow into a mesh.**

For the full system-level view, see [OpenMesh 0.5 architecture](architecture-0.5.md).

OpenMesh 0.5 moves the mesh into the Node.js application runtime.

Traditional service meshes commonly put a network proxy beside every workload. OpenMesh takes a different path for Node.js services: the application runtime itself understands service discovery, peer selection, deadlines, retries, circuits, pressure, streaming, traffic policy, and trace propagation.

There is no sidecar hop in the OpenMesh data path.

This is **not** a claim that OpenMesh 0.5 replaces Istio or Linkerd. The preview now includes SPIFFE-style workload identity, service-to-service mTLS, and zero-restart certificate hot rotation. Certificate issuance, revocation distribution, transparent traffic interception, and Kubernetes networking integration remain outside the runtime.

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

## Workload identity and mTLS

OpenMesh 0.5 can bind a Node.js service to a SPIFFE-style workload identity.

Configure the identity once at the application boundary:

```ts
import { readFileSync } from 'node:fs';
import openmesh from 'openmesh-node';

const payments = openmesh({
  service: 'payments',

  identity: {
    trustDomain: 'mesh.example.internal',
    ca: readFileSync('./pki/ca.pem'),
    cert: readFileSync('./pki/payments-cert.pem'),
    key: readFileSync('./pki/payments-key.pem'),

    allow: ['gateway']
  }
});
```

The configured certificate must contain this URI SAN:

```text
spiffe://mesh.example.internal/service/payments
```

OpenMesh validates that match before the application starts serving traffic. A workload certificate must contain exactly one SPIFFE URI SAN, preventing one certificate from ambiguously representing multiple mesh services.

With `identity` enabled, the owned server becomes HTTPS with:

- the configured workload certificate and key;
- the configured CA as the client trust anchor;
- `requestCert: true`;
- `rejectUnauthorized: true`;
- TLS 1.3 by default unless `minVersion` is explicitly supplied.

After the TLS chain is verified, OpenMesh performs application-level workload authorization.

For the example above, a valid certificate signed by the same CA is **not enough**. Its URI SAN must identify a workload in the configured trust domain, and its service name must be in `allow`.

The authenticated caller is available to normal and typed handlers:

```ts
app.get('/internal', {}, async ({ state }) => {
  return {
    caller: state.peerIdentity,
    service: state.peerService
  };
});
```

When `allow` is omitted, any correctly authenticated `/service/<name>` workload in the same trust domain is accepted. An empty allow-list accepts none.

### The same identity protects outbound mesh calls

If the application also has a mesh runtime:

```ts
const gateway = openmesh({
  service: 'gateway',

  identity: {
    trustDomain: 'mesh.example.internal',
    ca: readFileSync('./pki/ca.pem'),
    cert: readFileSync('./pki/gateway-cert.pem'),
    key: readFileSync('./pki/gateway-key.pem')
  },

  mesh: {
    control: {
      url: process.env.OPENMESH_CONTROL_URL!,
      token: process.env.OPENMESH_TOKEN!
    }
  }
});

const payments = gateway.mesh('payments');
```

OpenMesh automatically uses the gateway certificate as the TLS client identity and expects the discovered payments peer to present:

```text
spiffe://mesh.example.internal/service/payments
```

The expected remote identity is derived from the service handle name. A discovered `http://` peer is rejected before a request is attempted, and an HTTPS peer signed by the trusted CA but carrying the wrong workload URI fails with `IDENTITY_MISMATCH`.

In identity mode, URI SAN identity replaces DNS/IP hostname matching while the certificate chain still must validate to the configured CA. This allows discovered private IPs to change without weakening workload identity.

### Service registration must advertise HTTPS

An mTLS service should register its secure address:

```ts
app.register(serviceRegistration({
  client,
  service: 'payments',
  id: 'payments-a',

  url: address =>
    'https://127.0.0.1:' + address.port
}));
```

OpenMesh does not silently rewrite an advertised HTTP endpoint to HTTPS.

### Current PKI boundary

OpenMesh currently handles:

- local certificate/identity consistency checks;
- mutual TLS transport;
- CA chain verification;
- exact SPIFFE URI SAN verification;
- inbound service allow-lists;
- automatic outbound identity selection by mesh service name;
- authenticated caller identity in request state.

It does not yet operate a certificate authority or certificate distribution system.

Certificate issuance and revocation distribution remain external responsibilities in this preview. Once new cert/key material is available, `app.workload.rotate(...)` updates the owned HTTPS server and existing mesh service pools without restarting the application.

```ts
await app.workload.rotate(
  {
    ca: readFileSync('./pki/ca.pem'),
    cert: readFileSync('./pki/gateway-next.pem'),
    key: readFileSync('./pki/gateway-next-key.pem')
  },
  {
    graceMs: 30_000
  }
);
```

The replacement certificate must keep the application's configured SPIFFE identity. Invalid or mismatched material is rejected before activation.

The owned HTTPS server swaps its secure context for new connections. Existing outbound mesh pools switch to new TLS agents while the previous agents may drain for `graceMs`; set `graceMs: 0` for an immediate cutover.

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

          prefer: [
            {
              name: 'local',
              match: { region: 'nz' }
            },
            {
              name: 'regional-failover',
              match: { region: 'au' }
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

After a route/weighted target is selected, `prefer` applies ordered soft locality preferences **inside that target**.

For example, if the selected target is `version=v1`:

```text
version=v1
    ↓
prefer region=nz
    ↓ unavailable
prefer region=au
    ↓
v1 in Australia
```

The version decision does not change during regional failover. If none of the preferred metadata subsets has members, OpenMesh falls back to the already-selected target's remaining instances. This makes `prefer` suitable for locality/zone affinity rather than hard authorization boundaries.

## Live traffic policy

Traffic policy does not have to be compiled into the application.

A service can use a static policy as its startup fallback and watch a control-plane config namespace for live replacements:

```ts
services: {
  payments: {
    trafficConfig: {
      namespace: 'mesh-payments',
      key: 'traffic'
    },

    traffic: {
      split: [
        { match: { version: 'v1' }, weight: 90 },
        { match: { version: 'v2' }, weight: 10 }
      ]
    }
  }
}
```

An operator can then update the existing OpenMesh config store:

```ts
const snapshot = await control.getConfig('mesh-payments');

await control.setConfig(
  'mesh-payments',
  {
    traffic: {
      split: [
        { match: { version: 'v2' }, weight: 100 }
      ],
      prefer: [
        { match: { region: 'nz' } },
        { match: { region: 'au' } }
      ]
    }
  },
  {
    expectedRevision: snapshot.revision,
    expectedEpoch: snapshot.epoch
  }
);
```

The gateway does not restart and its service pool is not rebuilt. New requests immediately use the new policy while discovery, circuits, admission state, and peer statistics stay warm.

`service.trafficRevision` exposes the last applied control-plane revision. `service.trafficPolicy` exposes the current last-good policy.

Live policies are validated before activation. If a pushed policy is invalid, the config watcher records `service.trafficLastError`, keeps the previous traffic revision, and continues routing with the last-good policy.

Set `required: true` on `trafficConfig` when a missing policy should make the service handle fail to initialize rather than fall back to the static policy.

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

OpenMesh 0.5 covers application-level service communication:

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
- SPIFFE-style workload identity;
- service-to-service mutual TLS with CA and URI SAN verification;
- inbound workload allow-lists;
- lifecycle metrics and OpenTelemetry bridge;
- in-memory or Redis-backed control-plane state.

It does **not** yet provide:

- automatic certificate issuance or a built-in CA;
- automatic certificate issuance/renewal;
- revocation distribution;
- transparent interception of arbitrary process traffic;
- Kubernetes CNI integration;
- ingress/gateway replacement;
- L4 proxying for arbitrary non-HTTP protocols.

The next mesh-security milestone is automated identity lifecycle around the existing hot-rotation primitive: certificate issuance/integration, renewal triggers, and revocation distribution.

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
