# Performance report — 0.1.0

2026-10-02 本机实测，五个场景每个运行三轮。OpenMesh 吞吐量为 Fastify 的 **97.2%–104.1%**；这为当前场景下“接近 Fastify”的目标提供了证据。其他业务负载需要重新测量。

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

## Limits

Loopback results may be constrained by the load generator, OS networking and shared CPU. Three-second rounds are short and background load adds noise. This report measures a small route set with tiny payloads. It does not measure TLS, many-route lookup, memory under sustained load, production payloads, Fastify schema-optimized serialization, Express/Fastify bridges, or distributed client overhead.

Zero native runtime dependencies describes packaging; it is not a measured guarantee of Koa-equivalent memory consumption. Measure your own process RSS and latency under a representative workload. The peer client, tracing and compatibility engines are optional and disabled in the native baseline.

Source: [`benchmarks/server.cjs`](../benchmarks/server.cjs), [`benchmarks/run.cjs`](../benchmarks/run.cjs). Load generator: [autocannon](https://github.com/mcollina/autocannon).
