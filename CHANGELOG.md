# Changelog

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
