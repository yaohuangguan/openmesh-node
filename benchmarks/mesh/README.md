# Mesh data-plane benchmark

This benchmark compares OpenMesh with a real cross-language service-mesh data plane instead of treating OpenMesh as only an HTTP framework.

## What is measured

The first reproducible profile compares:

- **OpenMesh 0.5 / Node.js** — application-native managed service pool with live discovery, P2C peer selection, bounded admission, retry and circuit state.
- **Envoy / C++** — two Envoy processes in a sidecar-style caller → outbound proxy → inbound proxy → target path.

Both paths run on the same GitHub Ubuntu runner with:

- the same Node.js load generator;
- the same raw Node.js target servers;
- HTTP/1.1 keep-alive;
- the same concurrency and benchmark duration;
- one retry for safe GET requests;
- a 1 second request deadline;
- multiple measured rounds with alternating framework order.

The benchmark intentionally measures the **end-to-end service call path**, not only a proxy microbenchmark.

## Scenarios

### baseline-1-peer

One healthy target. This answers: what is the steady-state cost of making a service-to-service call through the data plane?

### lb-10-peer

Ten healthy targets. OpenMesh uses its managed P2C pool; Envoy uses `LEAST_REQUEST`.

### mtls-1-peer

One healthy service relationship with mutual TLS enabled. OpenMesh uses its application-native workload identity path with SPIFFE-style URI SANs. Envoy uses the same ephemeral benchmark CA and workload certificates on the outbound-proxy → inbound-proxy hop.

### failure-30pct

Ten targets start healthy. During load, three targets are stopped. The benchmark records:

- successful requests per second;
- p50 / p99 latency;
- errors after failure injection;
- error rate after failure injection;
- time from injection to the final observed failed request.

OpenMesh is configured with a one-failure circuit threshold and one retry. Envoy uses one retry plus outlier detection.

## Run

Docker is required because the Envoy side of the comparison uses the official Envoy container.

```sh
npm run build
node benchmarks/mesh/run.cjs \
  --duration=5 \
  --rounds=3 \
  --connections=32 \
  --output=benchmarks/results/mesh-local.json
```

The CI workflow uploads the raw JSON report as an artifact. Website numbers must come from that artifact; do not hand-edit benchmark claims without preserving the source report.

## Why Linkerd is not in the numeric table yet

Linkerd2-proxy is written in Rust and is an important comparison target, but its proxy is designed to run as part of the Linkerd service mesh and is not designed around a standalone static configuration file. A fair Linkerd run therefore needs a real Linkerd control plane (for example, a disposable k3d/kind cluster) rather than a mocked or partially configured proxy.

Until that reproducible cluster profile is checked in, the website should label Linkerd as **planned / not measured**, not invent a number.

## Interpretation

The benchmark is not intended to prove that one architecture is universally faster. It makes the path explicit:

```text
OpenMesh
Node caller → in-process managed mesh pool → Node target

Envoy
Node caller → outbound Envoy → inbound Envoy → Node target
```

That difference is part of the product architecture and should stay visible beside the results.
