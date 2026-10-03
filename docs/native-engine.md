# Native engine investigation: Go

> **Historical experiment from the 0.2 era.** OpenMesh 0.5 remains a Node.js application-native runtime. This document is retained as measurement evidence for why a Go sidecar/proxy was not adopted into the request path.

## Decision for 0.2.0

Keep the released engine on Node HTTP. Include an independent Go experiment and raw measurements, but do not ship an unproven Go-to-JavaScript transport as the default runtime.

Go can own HTTP parsing, routing, serialization, proxying and concurrent native handlers. A Go listener that calls JavaScript for each request still has to cross an execution boundary. Go-only HTTP performance does not predict the performance of a Node-compatible framework.

## Measured experiment — 2026-10-02

Three rounds, 3 seconds per run after 1-second warmup, 64 connections, HTTP/1.1 pipelining 1, two load-generator workers. Same Windows i7-10700K machine as the baseline; Node 24.11.1, Fastify 5.12.5, Go 1.25.5. Go servers use `GOMAXPROCS=1`. Every timed run returned 200 with zero errors/timeouts.

| Engine | Plaintext median req/s | JSON median req/s |
| --- | ---: | ---: |
| Minimal Node HTTP | 13,935 | 13,681 |
| OpenMesh | 13,617 | 13,401 |
| Fastify | 13,641 | 13,423 |
| Minimal Go HTTP | 16,989 | 16,669 |
| Go HTTP reverse proxy → OpenMesh JavaScript | 5,893 | 5,878 |

Standalone Go was about **24% ahead of Fastify** on these workloads; the HTTP proxy bridge achieved about **43% of Fastify throughput**. Go-only p99 was 7–8 ms versus Fastify's 5 ms; the bridge was about 20 ms. The target of a substantial framework-level lead remains unproven.

The Go implementation is a tiny transport control, not a feature-equivalent OpenMesh server. It has no JavaScript plugin execution. The reverse-proxy variant adds another HTTP hop and runs both Go and Node server processes, so it is specifically evidence about a sidecar HTTP bridge. It does **not** measure a direct native addon, shared memory, or an optimized IPC implementation. Those architectures may have different results.

An earlier high-pipelining exploratory run exposed inadequate upstream connection reuse. The final proxy uses a bounded keep-alive pool. The report above comes from a fresh complete run with corrected pooling; incomplete exploratory values are not used.

## Reproduce

From the repository, with Go installed:

```sh
go build -o ./go-bench benchmarks/go/main.go
node benchmarks/run.cjs --duration=3 --rounds=3 --connections=64 --pipelining=1 --workers=2 --frameworks=node,openmesh,fastify,go,go-proxy --scenarios=plaintext,json --go-binary=./go-bench --output=results/my-go-experiment.json
```

On Windows, build `./go-bench.exe` and pass that filename instead. Keep compiled experiment binaries outside the npm package. Source: [`main.go`](../benchmarks/go/main.go), raw report: [`go-experiment.json`](../benchmarks/results/go-experiment.json).

## Architectures worth testing next

1. **Go owns native routes and proxying.** JavaScript configures the graph at startup; native data-plane requests avoid a per-request JS callback. This can preserve Node as a management API, but Express/Fastify hooks cannot transparently run on native-owned requests.
2. **A direct native addon.** Avoid the extra HTTP hop, then measure crossing cost, backpressure, cancellations, streams and plugin semantics. Go/cgo needs a C interface and careful ownership; C++/Rust integrations are alternative experiments.
3. **Keep CPU-heavy tasks native.** Batch serialization, compression, hashing or application computation, while leaving small request dispatch on Node. Verify improvements using realistic payloads, not only `hello`.

Node-API documents that JavaScript invocation from native-created threads must be delivered through the JavaScript thread, typically by queued thread-safe calls. Go's cgo documentation also imposes pointer ownership and pinning rules. These are integration constraints, not numerical predictions of performance. [Node-API](https://nodejs.org/api/n-api.html#asynchronous-thread-safe-function-calls), [cgo](https://go.dev/cmd/cgo/).

## Performance acceptance target

Aim for at least **1.5× Fastify's geometric-mean throughput** across representative plaintext, JSON, parameters, body and middleware workloads, with no request errors, no material p99 regression, equivalent core budgets and required semantics. Independently reproduce on Linux with a separate load generator before making a broad performance claim.

The 0.2 release does not satisfy that target. Adding a native language is an experiment until the complete framework, with its compatibility costs, passes those checks.
