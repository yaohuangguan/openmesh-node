# Performance reports

> **Current package: OpenMesh 0.5.0.** Public performance work now focuses on cross-runtime **mesh overhead**, not a Node HTTP-framework shootout. The older Fastify comparisons below are preserved as historical evidence and the same harness remains useful as an internal HTTP hot-path regression guard.

## Current benchmark strategy — cross-runtime mesh cost

OpenMesh 0.5 is primarily a service runtime, so the useful question is no longer “can a trivial route beat another Node framework?” It is:

> How much throughput, tail latency, memory and failover cost does each runtime add when service discovery, load balancing, traffic policy, resiliency and mTLS are enabled?

The new suite normalizes each implementation against its own direct service-call baseline. That makes comparisons across Node.js, Java, Go and Rust substantially more meaningful than comparing absolute language throughput.

Primary proxyless/application-aware comparison:

- OpenMesh 0.5 — Node.js;
- Apache Dubbo 3.3.x — Java.

Secondary sidecar cost envelope:

- Dapr 1.18 — Go sidecar runtime;
- Linkerd 2.20 — Rust sidecar proxy.

Headline metrics are mesh RPS retention, p99 latency tax, traffic-policy tax, warm memory, CPU and failure-convergence time. Absolute requests/second remains in the raw report but is not the ranking metric.

See [Cross-runtime mesh benchmark methodology](mesh-benchmark.md).

Local OpenMesh harness:

```sh
npm run bench:mesh -- --duration=5 --rounds=5 --connections=32   --adapter=openmesh --output=results/openmesh-mesh-local.json
```

The one-second `bench:mesh:smoke` command only validates the adapter/harness contract and must not be used as performance evidence.

No cross-runtime 0.5 release table is published yet. Results will be added only after all compared adapters run on the same pinned Linux runner class with preserved raw artifacts.

## Latest preserved release benchmark — 0.4.0

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

## Limits

Loopback results may be constrained by the load generator, OS networking and shared CPU. Three-second rounds are short and background load adds noise. This report measures a small route set with tiny payloads. It does not measure TLS, many-route lookup, memory under sustained load, production payloads, Fastify schema-optimized serialization, Express/Fastify bridges, or distributed client overhead.

Zero native runtime dependencies describes packaging; it is not a measured guarantee of Koa-equivalent memory consumption. Measure your own process RSS and latency under a representative workload. The peer client, tracing and compatibility engines are optional and disabled in the native baseline.

Source: [`benchmarks/server.cjs`](../benchmarks/server.cjs), [`benchmarks/run.cjs`](../benchmarks/run.cjs). Load generator: [autocannon](https://github.com/mcollina/autocannon).
