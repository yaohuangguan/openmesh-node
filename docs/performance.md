# Performance reports

## OpenMesh 0.5 mesh data-plane benchmark

OpenMesh 0.5 is primarily a service runtime, so the primary benchmark now measures a complete application-to-application call instead of treating native HTTP router throughput as the product benchmark.

Measured on 2026-10-04 with Node v24.21.0 on macOS 24.6.0, Intel Core i5-8279U (8 logical CPUs). Each path uses the **same bare Node caller and bare Node target**. Only the service-to-service data plane changes.

Every result below is the median of five 5-second measured rounds after a 2-second warmup, with 32 keep-alive connections and pipelining 1. All measured rounds completed with zero request errors, timeouts, and non-2xx responses.

| Path | Topology | Median req/s | vs direct | p50 | p99 | CPU sum | RSS sum |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct baseline | caller → target | 2,987 | 100.0% | 9 ms | 30 ms | 106.5% | 133.5 MiB |
| **OpenMesh 0.5.0** | caller → `app.mesh()` → target | **1,807** | **60.5%** | **15 ms** | **53 ms** | **104.8%** | **176.8 MiB** |
| Envoy 1.37.2 | caller → outbound Envoy → inbound Envoy → target | 1,281 | 42.9% | 23 ms | 58 ms | 183.8% | 192.9 MiB |
| Dapr 1.18.4 | caller → caller daprd → target daprd → target | 1,243 | 41.6% | 23 ms | 63 ms | 197.5% | 336.5 MiB |

On this topology OpenMesh delivered about **41% more median throughput than the two-proxy Envoy path** and about **45% more than the two-sidecar Dapr path**. The important architectural result is not that JavaScript executes proxy logic faster than C++ or Go. It is that the application-native path avoids two extra proxy/sidecar hops and their process-level CPU and memory cost.

CPU and RSS are the sums of the processes that participate in the measured request path. Envoy was pinned to one worker per proxy (`--concurrency 1`). Dapr sidecars used `GOMAXPROCS=1`. OpenMesh and the shared Node applications each use one Node event loop.

### What this benchmark does and does not prove

This is a **steady-state plaintext HTTP service-invocation baseline**. It deliberately does not mix TLS/mTLS setup, certificate authorities, Kubernetes networking, telemetry exporters, or control-plane provisioning into one number. Those features have materially different architectures and should be measured as separate scenarios.

The comparison is topology-aware rather than feature-equivalence marketing:

- OpenMesh is application-native and adds no sidecar process.
- Envoy is measured as a conventional outbound + inbound proxy path.
- Dapr is measured as its caller + target sidecar service-invocation path.
- Discovery/control-plane state is warm before measured traffic begins.
- The caller and target application implementations are identical.
- Envoy 1.37.2 is deliberately pinned in this preserved release artifact; it is not presented as the newest Envoy release. Results from different platforms or Envoy versions are reported separately rather than mixed.
- Linkerd's Rust data plane is intentionally not represented by an extracted standalone proxy. A Linkerd result belongs in a separate Kubernetes + workload-identity/mTLS suite where its normal control-plane and identity path can be measured under equivalent conditions.

Raw rounds and full environment metadata are preserved in [`benchmarks/mesh/results/release-0.5.0-macos.json`](../benchmarks/mesh/results/release-0.5.0-macos.json).

Reproduce the native-process run:

```sh
node benchmarks/mesh/run.cjs \
  --duration=5 --rounds=5 --connections=32 \
  --modes=direct,openmesh,envoy,dapr
```

The native-process runner is intentionally small: provide Envoy and daprd binaries through `PATH` or the documented environment variables, then run the same caller/target topology on the host you want to measure. Do not mix results across hosts or platforms.

## Native HTTP regression benchmark — preserved 0.4.0 release baseline

The native OpenMesh/Fastify microbenchmark remains useful as a **regression guard for the HTTP request path**, not as the primary product comparison.


Measured on 2026-10-03 with Node v24.18.0 on macOS 24.6.0 (Intel Core i5-8279U, 8 logical CPUs). Each workload uses three 3-second measured rounds, a 1-second warmup, 32 connections, pipelining 1, one load-generator worker, and separate server processes. OpenMesh 0.4.0 is compared with Fastify 5.12.5 on the same machine.

| Workload | OpenMesh req/s | Fastify req/s | Ratio | OpenMesh / Fastify p99 ms |
| --- | ---: | ---: | ---: | ---: |
| Plain text | 23,011 | 23,293 | 98.8% | 2 / 2 |
| JSON object | 22,845 | 23,800 | 96.0% | 2 / 2 |
| Route parameter | 23,821 | 24,333 | 97.9% | 2 / 2 |
| JSON POST body | 20,221 | 20,952 | 96.5% | 3 / 3 |
| One middleware | 22,712 | 22,515 | 100.9% | 2 / 2 |

The geometric-mean OpenMesh/Fastify throughput ratio is **98.0%**. All 30 recorded runs had zero request errors, timeouts, and non-2xx responses. The normalized regression guard passes all current budgets. Raw per-round measurements and environment metadata are preserved in [`release-0.4.0.json`](../benchmarks/results/release-0.4.0.json).

The recorded report was assembled from one complete three-round harness invocation per scenario because the remote execution layer limits long-lived terminal calls. The harness, workload definitions, warmups, process isolation, and summary calculations are unchanged; the JSON contains every recorded round. A normal local shell can reproduce the same parameters with one command:

```sh
node benchmarks/run.cjs --duration=3 --rounds=3 --connections=32 \
  --frameworks=openmesh,fastify \
  --scenarios=plaintext,json,params,body,middleware \
  --output=results/release-0.4.0.json
```

These results establish near-parity on these small loopback workloads, not a universal performance advantage. The CI benchmark exists to catch regressions; production decisions should use representative payloads, TLS, route counts, concurrency, and deployment topology.

## Historical release — 0.2.0

Measured on 2026-10-02, on the machine described below, with three rounds per workload, 3-second measurements, 1-second warmups, 32 connections, pipelining 1, and one load-generator worker. Versions: OpenMesh 0.2.0 and Fastify 5.12.5. Native Node HTTP paths only; registration, discovery, tracing and bridges are disabled in both baselines.

| Workload | OpenMesh req/s | Fastify req/s | Ratio | OpenMesh / Fastify p99 ms |
| --- | ---: | ---: | ---: | ---: |
| Plain text | 14,724 | 15,076 | 97.7% | 2 / 2 |
| JSON object | 14,566 | 14,561 | 100.0% | 2 / 2 |
| Route parameter | 13,426 | 14,244 | 94.3% | 3 / 2 |
| JSON POST body | 12,000 | 12,191 | 98.4% | 3 / 3 |
| One middleware | 14,102 | 14,271 | 98.8% | 2 / 2 |

All 30 final measured runs had zero request errors, timeouts and non-2xx responses. The final run was isolated from other project tests and packaging. Raw rounds and ranges: [`release-0.2.0.json`](https://github.com/yaohuangguan/openmesh-node/blob/master/benchmarks/results/release-0.2.0.json).

```sh
node benchmarks/run.cjs --duration=3 --rounds=3 --connections=32 --frameworks=openmesh,fastify --output=results/release-0.2.0.json
```

These results establish proximity on these workloads, **not a substantial lead**. The [native-engine investigation](native-engine.md) records a separate Go experiment and the 1.5x target. The Go report uses different connection/worker settings and must not be compared directly to this table.

## Historical baseline — 0.1.0

Historical 0.1.0 baseline, measured on 2026-10-02 with three rounds per workload: OpenMesh throughput was **97.2%–104.1%** of Fastify. This established parity on those workloads, not a substantial lead. The current target and [Go experiment](native-engine.md) are separate from this baseline.

## Median requests/second

| Workload | OpenMesh | Fastify | Koa | Express | OpenMesh / Fastify |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain text | 14,465 | 14,767 | 12,878 | 11,974 | 98.0% |
| JSON object | 14,556 | 14,209 | 12,420 | 11,680 | 102.4% |
| Route parameter | 13,806 | 14,177 | 11,962 | 11,118 | 97.4% |
| JSON POST body | 11,950 | 12,295 | 10,536 | 9,726 | 97.2% |
| One middleware | 14,182 | 13,623 | 12,532 | 11,404 | 104.1% |

Median p99 latency across these rounds was 2–3 ms for OpenMesh and Fastify. All 60 measured runs had zero errors, timeouts and non-2xx responses. Raw per-round values and ranges are preserved in [`benchmarks/results/local.json`](../benchmarks/results/local.json).

## Environment and method

- Windows 10.0.26200; Intel Core i7-10700K @ 3.80GHz, 16 logical CPUs.
- Node v24.11.1; OpenMesh 0.1.0, Fastify 5.12.5, Koa 3.2.1, Express 5.2.1, autocannon 8.0.0.
- HTTP/1.1 on loopback, 32 keep-alive connections, pipelining 1, one server process per run.
- Each run starts a fresh server, checks exact response body/status (and the middleware header), warms up for 1 second, then measures for 3 seconds.
- Three rounds per scenario/framework. Framework order rotates between rounds. The table reports median RPS, not the fastest round.
- Client and server run as separate processes on the same machine. No other project tests or benchmark processes ran concurrently with measurement.

Workload equivalence is checked before timing: plaintext `hello`, JSON `{"hello":"world"}`, `/users/42` returning `{"id":"42"}`, JSON POST echo of `{"value":"payload"}`, and one middleware adding `x-bench: 1` before the JSON response.

Fastify uses native routes and JSON parsing with no schema-generated response serializer. OpenMesh uses its native JSON parser and router. Express disables ETag and X-Powered-By and uses a 1 MiB JSON parser limit; Fastify/OpenMesh/Koa use the same limit for this small body. Koa uses minimal manual parameter extraction and a small manual JSON body reader, with no extra router/parser package. Middleware uses each engine's normal hook/middleware model; these APIs do not perform identical internal work.

## Reproduce

```sh
npm ci --ignore-scripts
npm run bench -- --duration=3 --rounds=3 --connections=32
```

For a longer independent run without overwriting the recorded result:

```sh
npm run bench -- --duration=10 --rounds=5 --connections=64 --output=results/my-machine.json
```

`npm run bench:smoke` only checks that the harness runs and writes `results/smoke.json`. Its one-second values are unsuitable for performance claims. The full benchmark defaults to `results/local.json`; pass an explicit output to preserve the baseline.

## CI regression budget

The current CI pipeline includes a dedicated Ubuntu / Node 24 benchmark-regression job. It does **not** compare GitHub-hosted runner throughput with the checked-in Windows workstation numbers above. Instead it runs OpenMesh and Fastify in the same job and evaluates normalized ratios from the same machine.

The guard currently checks:

- minimum per-scenario OpenMesh / Fastify median throughput ratio: 0.82;
- minimum geometric-mean throughput ratio across the benchmark scenarios: 0.88;
- maximum OpenMesh / Fastify median p99 ratio: 3.0;
- zero benchmark request errors, timeouts and non-2xx responses through the benchmark harness.

```sh
node benchmarks/run.cjs \
  --duration=2 --rounds=3 --connections=32 \
  --frameworks=openmesh,fastify \
  --scenarios=plaintext,json,params,body,middleware \
  --output=results/ci.json

npm run bench:guard -- \
  --report=benchmarks/results/ci.json \
  --min-ratio=0.82 --min-geomean=0.88 --max-p99-ratio=3
```

The job uploads the raw JSON report even when the guard fails. These thresholds are regression budgets, not performance claims: passing means the current request path stayed inside an intentionally broad normalized envelope on that runner. Release claims still require longer dedicated measurements and preserved raw results.

## Native HTTP regression limits

The limits below apply to the preserved native HTTP microbenchmark, not to the mesh data-plane benchmark above.

Loopback results may be constrained by the load generator, OS networking and shared CPU. Three-second rounds are short and background load adds noise. This report measures a small route set with tiny payloads. It does not measure TLS, many-route lookup, memory under sustained load, production payloads, Fastify schema-optimized serialization, Express/Fastify bridges, or distributed client overhead.

Zero native runtime dependencies describes packaging; it is not a measured guarantee of Koa-equivalent memory consumption. Measure your own process RSS and latency under a representative workload. The peer client, tracing and compatibility engines are optional and disabled in the native baseline.

Source: [`benchmarks/server.cjs`](../benchmarks/server.cjs), [`benchmarks/run.cjs`](../benchmarks/run.cjs). Load generator: [autocannon](https://github.com/mcollina/autocannon).
