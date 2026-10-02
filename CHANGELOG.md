# Changelog

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
