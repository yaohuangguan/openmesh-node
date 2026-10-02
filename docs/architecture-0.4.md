# OpenMesh 0.4 architecture

OpenMesh 0.4 evolves the 0.3 service runtime into a production-tunable data plane without adding framework dependencies to the hot path.

## Runtime goals

1. keep keyed affinity deterministic while making ordinary traffic load-aware;
2. bound work before sockets and downstream services become saturated;
3. make streaming a first-class peer transport rather than buffering every response;
4. isolate service failures with independent pools and concurrency budgets;
5. expose lifecycle data without forcing one telemetry SDK into the runtime;
6. detect request-path regressions automatically in CI.

## Request and server observability

`openmesh({ onEvent })` emits structured lifecycle events:

- `request.start`
- `request.finish`
- `request.error`
- `server.listening`
- `server.closing`
- `server.closed`

Request completion is measured from the real Node `ServerResponse` `finish` / `close` lifecycle, not from the handler return. A streamed response therefore remains in-flight until bytes actually finish or the connection closes. Observer exceptions are isolated from application traffic. When `onEvent` is not configured, OpenMesh does not install per-request observability listeners or take timing samples on the hot path; instrumentation is pay-for-what-you-enable.

This boundary is intentionally exporter-neutral. Applications can enqueue these events into OpenTelemetry, Prometheus, logs, or another telemetry system without making those packages runtime dependencies.

## Peer data plane

```text
request
  |
  v
bounded admission
  |
  +--> FIFO wait --------> POOL_OVERLOADED
  |
  v
candidate selection
  |
  +--> keyed: rendezvous affinity
  +--> unkeyed: P2C using circuit/failure/inflight/EWMA state
  |
  v
attempt -> retry -> circuit -> HTTP transport
  |
  +--> buffered response: request()
  |
  +--> streaming response: requestStream()
  |
  +--> PeerPool lifecycle events
```

`PeerPool({ onEvent })` emits admission pressure, peer attempt/success/failure/cancellation, and adaptive concurrency changes. The observer is synchronous and isolated; exporters should enqueue work rather than perform blocking I/O inside the callback.

## Streaming peer responses

`requestStream()` returns after successful response headers are available. The returned `PeerStreamResponse.body` is a real Node readable stream.

The retry boundary is explicit:

- connection/transport failure before headers: eligible for the ordinary retry policy;
- HTTP 5xx before handing the response to the caller: eligible for retry;
- once non-5xx headers are handed to the caller: the response is committed and is never replayed on another peer;
- body-stream failure after that point is surfaced to the consumer and recorded against that peer.

Admission and peer in-flight counters remain held until the stream ends, fails, is destroyed by the consumer, or the pool closes. The ordinary request timeout is a header deadline for streaming calls; long-lived bodies are controlled by the caller's `AbortSignal` or pool shutdown. Response bytes remain bounded by `maxResponseBytes`.

## Per-service bulkheads

The control client can create a managed service pool:

```js
const users = await control.service('users', {
  maxInflight: 64,
  maxQueue: 128
});
```

A `ServicePool` owns one `PeerPool` and one service discovery watcher. Membership updates atomically replace its peers. Because each service owns independent admission, queue, circuit and adaptive-concurrency state, saturation in one service does not consume another service's budget.

This is the preferred service-to-service model instead of multiplexing unrelated services through one shared peer pool.

## Adaptive concurrency

Adaptive concurrency is opt-in. `maxInflight` remains a hard ceiling.

```js
const users = await control.service('users', {
  maxInflight: 128,
  adaptiveConcurrency: {
    min: 8,
    initial: 32,
    max: 96,
    targetLatencyMs: 100,
    sampleSize: 20
  }
});
```

Successful buffered requests contribute latency samples. A p90 sample window below the target increases the limit additively; sustained high latency decreases it multiplicatively. Pre-header failures trigger an immediate multiplicative decrease. Streaming requests contribute time-to-headers to the adaptive controller rather than total stream lifetime.

The controller never exceeds its configured adaptive maximum or the pool's hard `maxInflight`. Limit changes emit `concurrency.changed`.

## Benchmark regression budgets

CI runs OpenMesh and Fastify on the same Ubuntu/Node 24 runner and compares normalized ratios instead of absolute requests/second. This avoids treating differences between a local workstation and a shared CI runner as framework regressions.

The guard checks:

- per-scenario OpenMesh/Fastify median throughput ratio;
- geometric-mean throughput ratio across scenarios;
- p99 latency ratio;
- the benchmark harness's existing zero-error/zero-timeout requirement.

The raw benchmark report is uploaded as a CI artifact for failed and successful runs.

## Why exporter and control-plane implementations remain separate

The request runtime should not require an OpenTelemetry SDK, durable registry database, or another language runtime. Those integrations sit behind small boundaries: lifecycle events for telemetry and the versioned control protocol for registry/configuration implementations.

A future `@openmesh/otel` adapter or standalone Go control plane can therefore evolve without changing the Node request path.

## Next slices

- durable Redis/etcd/SQL registry and configuration adapter conformance suites;
- exporter packages built on the stable event contracts;
- streaming idle/deadline policy for very long SSE/LLM connections;
- protocol-level scoped credentials/RBAC beyond one shared bearer token;
- HTTP/2 or alternative transport experiments only when profiling justifies them.
