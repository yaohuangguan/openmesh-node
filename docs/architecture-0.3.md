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

## Push watches

0.3 adds authenticated Server-Sent Events endpoints:

- `GET /_mesh/watch/services/:service`
- `GET /_mesh/watch/config/:namespace`

The server sends an initial atomic snapshot and then new snapshots when membership or configuration changes. Heartbeat comments keep idle connections alive.

`ControlClient.watchConfig()` uses streaming watches by default and falls back to the existing polling mode when a control plane reports that streaming is unavailable. `ControlClient.watchService()` exposes the same push model for service membership.

This removes steady-state one-request-per-interval polling from normal 0.3 deployments.

## Lifecycle

`app.onShutdown()` runs before the HTTP listener begins draining. It is intended for long-lived connections such as watch streams.

`app.onClose()` remains the final cleanup phase after request draining. A control plane therefore closes SSE watches during shutdown instead of waiting for the force-close timeout.

Not-found handlers now preserve plugin prefix/scope encapsulation, matching the rest of the plugin model.

## Go boundary

Go is not on the per-request JavaScript path in 0.3.

The intended future Go role is a standalone control-plane implementation that speaks the same HTTP/watch protocol and implements the same storage semantics:

```text
Node OpenMesh service ----+
Node OpenMesh service ----+---- Go control plane ---- durable store
Node OpenMesh service ----+       registry/config/watch
```

This avoids a Go -> JavaScript boundary for every application request. Native data-plane routes remain a separate experiment and require independent evidence before becoming part of the runtime.

## Next slices

The next 0.3 work should build on these boundaries rather than enlarge the core class:

1. production adapters and adapter conformance tests;
2. durable production adapters and adapter conformance suites;
3. OpenTelemetry context and exporter integration;
4. streaming peer responses and richer transport metrics;
5. optional load-aware peer selection for unkeyed traffic;
6. hardened server timeout/header/body defaults;
7. an optional standalone Go control plane implementing the same protocol.

Performance changes must be compared against the same commit/environment baseline. One-second smoke benchmarks are only harness checks and are not release evidence.


## Revisioned membership and resumable watches

Built-in service membership now has a monotonic per-service revision. Discovery pages include that revision; clients restart pagination when membership changes between pages instead of returning a mixed snapshot.

SSE watch events carry `id` values. Config events use `<epoch>:<revision>` and service events use the service membership revision. Reconnecting clients send `Last-Event-ID`; the control plane suppresses a duplicate initial snapshot when the revision is unchanged, while still sending the complete current snapshot when state advanced. Watches therefore resume from state rather than relying on a lossy delta stream.

## Peer transport telemetry

`PeerPool.stats()` now reports successes, in-flight requests, last/EWMA latency and last success/failure timestamps in addition to attempts and circuit state. Caller cancellation releases in-flight accounting without incrementing peer failures. These metrics are deliberately transport-local and are suitable inputs for future load-aware selection and OpenTelemetry export.
