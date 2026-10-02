# Changelog

## 0.4.0 (unreleased)

- Add request/server lifecycle observability tied to actual response finish/close events, including streaming responses.
- Add true streaming peer responses through `requestStream()`; admission and peer in-flight accounting remain held until the stream completes.
- Define post-header streaming failure semantics: retries are allowed only before response headers are committed.
- Add managed per-service `ServicePool` instances through `ControlClient.service()`, combining discovery watches with isolated admission, queues, circuits, and peer routing.
- Add optional bounded adaptive concurrency with latency sampling, additive increase, multiplicative decrease, and `concurrency.changed` events.
- Add normalized benchmark regression CI against Fastify on the same runner, with throughput and p99 budgets plus uploaded raw reports.
- Add zero-dependency structured `PeerPool` lifecycle events for pressure, attempts, success, failure, cancellation, and concurrency changes.
- Add opt-in post-header `idleTimeout` for SSE/LLM peer streams with explicit `STREAM_IDLE_TIMEOUT` failures and correct admission cleanup.
- Add scoped control-plane credentials with action permissions plus optional service/namespace resource restrictions while preserving the legacy full-access token mode.
- Add `openmesh-node/otel`, a dependency-free OpenTelemetry-compatible metrics bridge for app and peer lifecycle events with bounded default attributes.
- Add `openmesh-node/services/testing` adapter conformance harnesses for lease ownership, discovery secrecy, CAS, watches, and optional reopen durability checks.
- Add `openmesh-node/services/redis` durable registry/configuration adapters with Redis-side atomic lease/CAS transitions, Pub/Sub watches, TTL-expiry detection, and real Redis CI coverage.
- Make benchmark p99 regression checks aware of 1 ms timer quantization so 0 ms vs 1 ms samples do not produce false 10x regressions.

## 0.3.0 (unreleased)

- Add pluggable registry and configuration adapter contracts; control-plane stores may now be asynchronous.
- Add authenticated SSE watches for service membership and configuration.
- Make `ControlClient.watchConfig()` stream by default with polling compatibility, and add `watchService()`.
- Add `app.onShutdown()` for pre-drain cleanup of long-lived resources.
- Make not-found handlers honor plugin prefix/scope encapsulation.
- Add pluggable route validator/serializer compiler contracts without adding runtime dependencies.
- Harden JSON parsing against prototype keys by default and expose explicit server timeout/header limits.
- Document the intended Go boundary: standalone control plane first, not per-request Go-to-JavaScript bridging.
- Add authenticated `/_mesh/meta` protocol/capability discovery and `ControlClient.info()` for explicit control-plane compatibility checks.
- Remove service registrations in the pre-drain shutdown phase so discovery stops sending new work to draining instances.
- Add default power-of-two-choice load-aware selection for unkeyed peer traffic while preserving rendezvous affinity for keyed requests.
- Add bounded peer-pool admission with FIFO queueing, deadline-aware waits, overload rejection, and pool-level pressure telemetry.

## 0.2.0

- Make all documentation, examples, and release material English-first.
- Add authenticated control-plane APIs for lease-based service registration, discovery, and configuration.
- Add automatic heartbeats, expired-lease recovery, ownership-safe deregistration, and lifecycle registration hooks.
- Add immutable configuration snapshots, epoch/revision compare-and-swap, validation, and polling watchers that retain the last valid state.
- Simplify the native synchronous route dispatch path; preserve middleware return semantics.
- Fix outbound body framing for DELETE/GET requests carrying bodies.
- Add runnable microservice demos and an experimental Go/native Node transport comparison.
- Prepare an npm package and a trusted-publishing workflow. Initial publication requires authenticated npm access.

## 0.1.0

- Native HTTP core, scoped plugins, real Express/Fastify bridges, resilient HTTP peer client, tracing headers and health checks.
- ESM/CommonJS types, cross-platform CI, and reproducible benchmarks.
