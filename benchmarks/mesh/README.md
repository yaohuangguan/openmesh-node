# Mesh data-plane benchmark

This benchmark measures end-to-end service invocation rather than framework-only HTTP routing.

## Paths under test

Every measured request follows the same outer shape:

```text
autocannon -> Node caller -> data plane -> Node target -> response
```

The caller and target application code are shared across all paths.

| Mode | Data path |
| --- | --- |
| `direct` | caller -> target |
| `openmesh` | caller -> OpenMesh `app.mesh()` -> target |
| `envoy` | caller -> outbound Envoy -> inbound Envoy -> target |
| `dapr` | caller -> caller daprd -> target daprd -> target |

Envoy runs with one worker per proxy. Dapr runs with `GOMAXPROCS=1` per sidecar. OpenMesh and each Node application use one Node.js event loop.

The report records throughput, p50/p99 latency, and summed CPU/RSS for every process in the measured path. A raw req/s win is not treated as a complete efficiency result.

## Recorded OpenMesh 0.5 result

The checked-in release report was measured with native macOS processes on an Intel x86_64 machine:

- Node.js 24.21.0
- OpenMesh 0.5.0
- Envoy 1.37.2
- Dapr 1.18.4
- five measured rounds
- five seconds per round
- two-second warmup
- 32 keep-alive connections
- pipelining 1

Envoy 1.37.2 is deliberately pinned in this preserved release artifact. It is not presented as the newest Envoy release. Results from a different Envoy version or platform must be reported as a separate run rather than merged into the release table.

The raw report is [`results/release-0.5.0-macos.json`](results/release-0.5.0-macos.json).

## Reproduce

Install Envoy and daprd, or point the runner at explicit binaries:

```sh
OPENMESH_BENCH_ENVOY=/path/to/envoy \
OPENMESH_BENCH_DAPRD=/path/to/daprd \
npm run bench:mesh -- \
  --duration=5 --rounds=5 --connections=32 \
  --modes=direct,openmesh,envoy,dapr
```

If both binaries are already on `PATH`:

```sh
npm run bench:mesh -- \
  --duration=5 --rounds=5 --connections=32
```

The runner writes `benchmarks/mesh/results/host-macos.json`. Rename a result only when intentionally preserving it as a release artifact.

The runner uses native processes rather than a container VM so the application and all compared data planes share the same host networking and scheduler. Run all modes on the same host; do not compare numbers copied from different machines or operating systems.

## Why Linkerd is not in this local baseline

Linkerd is a valid service-mesh comparison, but its normal data plane is coupled to its control-plane and workload-identity environment. Running only an extracted proxy locally would not represent the normal Linkerd service path, while standing up Kubernetes just for one competitor would make this same-host baseline structurally different.

A Linkerd comparison belongs in a separate Kubernetes + mTLS suite where OpenMesh, Linkerd, and the other systems can all be measured with equivalent identity and networking conditions. It is intentionally not replaced here with a partial or misleading standalone-proxy number.

## Interpretation

This is an architectural data-path comparison, not a claim that the products have identical feature sets.

- OpenMesh is application-native and does not add sidecar processes.
- Envoy is measured as a conventional two-proxy path.
- Dapr is measured as its caller + target sidecar service-invocation path.
- Discovery/control-plane state is warm before measured traffic begins.
- The caller and target application implementations are identical.
- TLS/mTLS is not enabled in this baseline. Security-specific results must be reported separately rather than mixed into the plaintext baseline.
