# Cross-runtime mesh benchmark

This suite measures the cost and behavior of **service-to-service mesh/runtime features**, not raw HTTP framework speed.

The headline metric is **mesh tax relative to each system's own direct baseline**. Absolute throughput is still preserved in the raw report, but it is not used to claim that one programming language is universally faster than another.

## Comparison groups

### Primary: application-aware / proxyless runtimes

| System | Language | Why it belongs |
| --- | --- | --- |
| OpenMesh 0.5 | TypeScript / Node.js | application-native discovery, load balancing, traffic policy, retries/circuits and workload mTLS |
| Apache Dubbo 3.3.6 | Java | client-side discovery/load balancing plus proxyless mesh/service-governance support |

Apache Dubbo is the primary external comparison because its application process can participate directly in service discovery, load balancing and traffic governance instead of requiring every request to cross a sidecar.

### Secondary: sidecar mesh/runtime cost envelope

| System | Data-plane language | Architecture |
| --- | --- | --- |
| Dapr 1.18.0 | Go | developer-facing service invocation through a sidecar |
| Linkerd 2.20 | Rust | transparent Kubernetes sidecar proxy |

Dapr is intentionally labeled a sidecar distributed-application runtime, not a networking service mesh. Linkerd is an infrastructure service mesh. They are useful for measuring the cost of the sidecar architecture, but their results are not mixed into the proxyless/application-native headline.

### Historical reference only

Service Weaver is conceptually close to OpenMesh, but the project is archived and no longer maintained. It should not be presented as a current competitor.

## Adapter status

| Adapter | Status | Notes |
| --- | --- | --- |
| OpenMesh | implemented | direct / discovery+LB mesh / traffic-policy paths |
| Dapr 1.18.0 | implemented | direct / sidecar service invocation; traffic-policy column is N/A because Dapr does not provide mesh traffic splitting |
| Apache Dubbo 3.3.6 | next | primary Java proxyless comparison |
| Linkerd 2.20 | next | Rust sidecar comparison; requires an isolated Kubernetes benchmark topology |

The cross-runtime GitHub workflow currently runs the implemented OpenMesh and Dapr adapters on Ubuntu. Dubbo and Linkerd are added to the public table only after their adapters satisfy the same contract.

References:

- Apache Dubbo service mesh: https://dubbo.apache.org/en/overview/what/core-features/service-mesh/
- Apache Dubbo load balancing: https://dubbo.apache.org/en/overview/mannual/java-sdk/tasks/service-discovery/loadbalance/
- Dapr service invocation: https://docs.dapr.io/developing-applications/building-blocks/service-invocation/service-invocation-overview/
- Dapr and service meshes: https://docs.dapr.io/concepts/faq/service-mesh/
- Linkerd releases: https://linkerd.io/releases/

## Fairness rules

Every implementation must expose the same benchmark adapter surface:

- `/direct` — one fixed healthy backend, bypassing mesh discovery/governance;
- `/mesh` — normal service discovery + load balancing;
- `/policy` — mesh call with one active traffic-targeting policy;
- `/health` — adapter readiness only.

The load generator uses the same:

- payload;
- number of backends;
- warmup;
- measured duration;
- rounds;
- concurrency;
- host class;
- process/container CPU limits where applicable.

The benchmark records both absolute values and normalized cost.

## Headline metrics

For each system:

1. **Direct throughput** and p50/p99 latency.
2. **Mesh throughput** and p50/p99 latency.
3. **Mesh throughput retention**
   `mesh_rps / direct_rps`.
4. **Mesh latency tax**
   `mesh_p99 - direct_p99`.
5. **Traffic-policy tax**
   `policy_rps / mesh_rps` and p99 delta.
6. **RSS / container memory** after warmup.
7. **CPU time / utilization** during the measured interval.
8. **Failover convergence** after one healthy backend disappears.
9. **mTLS tax** relative to the same mesh path without mTLS.
10. **Error rate**. Any non-2xx, timeout, or benchmark error invalidates a throughput result.

## Scenario v1

The v1 request is deliberately small so the benchmark measures control/data-plane overhead rather than application work.

Response:

```json
{"ok":true,"instance":"backend-a"}
```

Topology:

```text
load generator
      |
      v
benchmark gateway / caller
      |
      +-- direct ------> fixed backend
      |
      +-- mesh --------> discovery + LB ------> backend A/B/C
      |
      +-- policy ------> target policy + LB --> backend A/B/C
```

Three backends are used for discovery/load-balancing runs.

## Reporting

The public table should lead with normalized cost:

| Runtime | Language | Mesh RPS retention | Mesh p99 tax | Policy RPS retention | Failover | Warm RSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| OpenMesh | Node.js | … | … | … | … | … |
| Dubbo | Java | … | … | … | … | … |
| Dapr | Go sidecar | … | … | … | … | … |
| Linkerd | Rust sidecar | … | … | … | … | … |

Absolute requests/second belongs in the detailed report, not the headline.

## Reproducibility

- Pin exact versions in the adapter.
- Save raw rounds and environment metadata.
- Run all compared systems sequentially inside the same Linux workflow job / host.
- The comparison renderer rejects reports whose OS release, CPU identity, CPU count or benchmark configuration differ.
- Run each system in rotating order to reduce thermal/background bias.
- Use medians across at least three measured rounds.
- Public release claims should use longer measurements than CI smoke/regression runs.

The existing OpenMesh/Fastify benchmark remains an internal HTTP hot-path regression guard. It is not the public cross-runtime comparison.
