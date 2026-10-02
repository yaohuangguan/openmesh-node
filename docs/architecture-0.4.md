# OpenMesh 0.4 architecture

OpenMesh 0.4 evolves the 0.3 service runtime into a production-tunable data plane without adding framework dependencies to the hot path.

## Design goals

1. keep keyed affinity deterministic;
2. make unkeyed traffic load-aware;
3. bound concurrency and queue growth before the transport layer;
4. expose structured runtime events without coupling OpenMesh to one telemetry vendor;
5. preserve one total request deadline across queueing, retries and transport work.

## Data-plane flow

```text
request
  |
  v
bounded admission
  |
  +--> FIFO wait --------> overload rejection
  |
  v
candidate selection
  |
  +--> keyed: rendezvous
  +--> unkeyed: p2c using circuit/failure/inflight/EWMA state
  |
  v
attempt -> retry -> circuit -> transport
  |
  +--> structured PeerPool events
```

## Zero-dependency observability boundary

`PeerPool({ onEvent })` receives structured lifecycle events for admission pressure and transport attempts. The observer is deliberately synchronous and isolated: observer failures are swallowed so telemetry cannot break application traffic.

Events currently cover:

- `admission.queued`
- `admission.rejected`
- `peer.attempt`
- `peer.success`
- `peer.failure`
- `peer.cancelled`

This is the stable boundary for future OpenTelemetry, Prometheus or custom exporters. Exporters should batch or enqueue their own work rather than doing blocking I/O in the observer callback.

## Why not embed OpenTelemetry directly

The request runtime should not require an SDK, exporter, global provider, or semantic-convention package. A small event contract keeps OpenMesh usable in minimal services and allows applications to choose their own telemetry stack.

A future `@openmesh/otel` package can translate these events into counters, histograms and spans without changing the core runtime.

## Next technical slices

- request/server lifecycle events matching the peer event model;
- streaming peer responses with post-header failure semantics;
- per-service bulkheads and adaptive concurrency experiments;
- benchmark regression budgets in CI;
- durable registry/config adapters;
- optional standalone control plane implementations behind the versioned protocol boundary.
