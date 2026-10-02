# OpenMesh 0.3 architecture

OpenMesh 0.3 separates the Node request runtime from control-plane state and change delivery. The goal is to keep the native Node request path small while making registration, discovery and configuration replaceable and event-driven.

## Runtime boundaries

```text
Application handlers
       |
       v
Node HTTP runtime
router -> middleware -> handler -> response
       |
       +---- Express / Fastify bridges
       |
       v
Mesh client
selection -> deadline -> retry -> circuit -> transport

ControlClient
       |
       +---- protocol metadata / capability check
       |
       v
Control plane API
       |
       +---- RegistryAdapter
       |        +---- ServiceRegistry (memory default)
       |        +---- Redis / etcd / Consul / SQL adapter
       |
       +---- ConfigAdapter
                +---- ConfigStore (memory default)
                +---- external durable adapter
```

The Node HTTP runtime does not depend on the control plane. Applications can use the router without registration, discovery or live configuration.

## Storage adapter contracts

`RegistryAdapter` defines registration, lease renewal, deregistration and service listing. `ConfigAdapter` defines snapshot and compare-and-swap replacement.

Both contracts accept synchronous or asynchronous implementations. This keeps the current in-memory stores simple while allowing network-backed storage without changing the HTTP API.

Adapters may implement `subscribe(...)`. Streaming watch endpoints require subscriptions; adapters without them can still serve the ordinary registration, discovery and configuration APIs.

The built-in `ServiceRegistry` and `ConfigStore` remain process-local development defaults. They are not durable consensus stores.

## Versioned control protocol

The control-plane HTTP boundary now exposes authenticated `GET /_mesh/meta`. It identifies the `openmesh-control` protocol major version and advertises optional capabilities such as service/config streaming watches and revisioned membership.

`ControlClient.info()` performs an explicit compatibility check. Normal registration, discovery, and configuration calls do not run the handshake automatically, avoiding an extra RTT on existing deployments. A future standalone Go control plane can therefore target the protocol contract instead of reproducing Node implementation details.

## Push watches

0.3 adds authenticated Server-Sent Events endpoints:

- `GET /_mesh/watch/services/:service`
- `GET /_mesh/watch/config/:namespace`

The server sends an initial atomic snapshot and then new snapshots when membership or configuration changes. Heartbeat comments keep idle connections alive.

`ControlClient.watchConfig()` uses streaming watches by default and falls back to the existing polling mode when a control plane reports that streaming is unavailable. `ControlClient.watchService()` exposes the same push model for service membership.

This removes steady-state one-request-per-interval polling from normal 0.3 deployments.

## Lifecycle

`app.onShutdown()` runs before the HTTP listener begins draining. It is intended for long-lived connections such as watch streams and for removing a service registration before the node stops accepting new work through discovery.

`app.onClose()` remains the final cleanup phase after request draining. A control plane therefore closes SSE watches during shutdown instead of waiting for the force-close timeout.

Not-found handlers now preserve plugin prefix/scope encapsulation, matching the rest of the plugin model.

## TypeScript source and package boundary

The repository has one runtime source of truth under `src/**/*.ts`. Strict TypeScript checks run before runtime tests. The build emits CommonJS, ESM, and declarations into `dist/`; generated artifacts are not committed.

```text
src/**/*.ts
   |
   +--> dist/cjs
   +--> dist/esm
   +--> dist/types
```

Tests and benchmarks import the package through its public exports rather than reaching into source files. This makes package-format failures visible before publication and prevents the source implementation and published declarations from drifting apart.

## Runtime language boundary

OpenMesh 0.3 does not require Go or any other native runtime. The production architecture is protocol- and adapter-driven: the Node/TypeScript runtime owns application requests, while a control plane may be implemented independently as long as it preserves the registry, configuration, lease, revision, and watch semantics.

A standalone Go control plane remains an optional experiment because it can be operationally attractive as a small binary with many concurrent watch connections. It is not part of the JavaScript request path, and it will only become a supported implementation if measurements and operational simplicity justify the added language.

```text
Node OpenMesh service ----+
Node OpenMesh service ----+---- control plane ---- durable adapter
Node OpenMesh service ----+       registry/config/watch
```

Native data-plane routes remain a separate experiment and require independent evidence before becoming part of the runtime.

## Next slices

The next 0.3 work should build on these boundaries rather than enlarge the core class:

1. durable production adapters and adapter conformance suites;
2. OpenTelemetry context and exporter integration;
3. request-path profiling and regression budgets;
4. streaming peer responses and richer transport metrics;
5. per-service bulkheads and adaptive concurrency experiments;
6. protocol-level authentication/authorization beyond one shared bearer token;
7. an optional standalone Go control plane implementing the same protocol.

Performance changes must be compared against the same commit/environment baseline. One-second smoke benchmarks are only harness checks and are not release evidence.


## Revisioned membership and resumable watches

Built-in service membership now has a monotonic per-service revision. Discovery pages include that revision; clients restart pagination when membership changes between pages instead of returning a mixed snapshot.

SSE watch events carry `id` values. Config events use `<epoch>:<revision>` and service events use the service membership revision. Reconnecting clients send `Last-Event-ID`; the control plane suppresses a duplicate initial snapshot when the revision is unchanged, while still sending the complete current snapshot when state advanced. Watches therefore resume from state rather than relying on a lossy delta stream.

## Peer transport telemetry

`PeerPool.stats()` now reports successes, in-flight requests, last/EWMA latency and last success/failure timestamps in addition to attempts and circuit state. Caller cancellation releases in-flight accounting without incrementing peer failures. Unkeyed traffic uses a power-of-two-choice (`p2c`) decision over the first two rendezvous candidates, preferring a candidate with a healthier circuit, fewer recent failures, less in-flight work, and then lower EWMA latency. Requests with an explicit key always keep pure rendezvous ordering so affinity remains stable. Pool-wide admission is separately bounded: at most 256 requests are admitted by default, up to 1024 wait FIFO, queue wait consumes the same request deadline, and a full queue fails immediately with `POOL_OVERLOADED`. `PeerPool.poolStats()` exposes this pressure without mixing admission rejection into peer circuit health. These metrics are deliberately transport-local and remain suitable for OpenTelemetry export.
