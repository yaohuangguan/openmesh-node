# Launch material and adoption plan

## One-line positioning

**OpenMesh is an application-native service mesh and typed HTTP runtime for Node.js: start as an API, grow into a mesh.**

It is not positioned as another web framework or as a drop-in Istio/Linkerd replacement. Normal HTTP development is the entry point; the differentiator is that the same runtime grows into service discovery, traffic policy, pressure control, retries, circuits, streaming, and observability without adding a sidecar hop.

Repository: https://github.com/yaohuangguan/openmesh-node

npm: https://www.npmjs.com/package/openmesh-node

Current release: **0.4.0**

## Short introduction

OpenMesh lets a Node.js application begin as an ordinary typed HTTP API and grow into multiple cooperating services without switching to a separate service-communication programming model.

The 0.5 preview adds `app.mesh('service')` as a small developer facade over the existing discovery-backed `ServicePool` and `PeerPool` runtime. The native request path remains dependency-light, while mesh calls reuse bounded queues, per-service bulkheads, adaptive concurrency, deadlines, retries, circuit breaking, streaming, tracing, traffic subsets, and existing control-plane adapters.

The package ships ESM, CommonJS, and generated TypeScript declarations. The 0.5 preview also includes SPIFFE-style workload identity and service-to-service mTLS with CA verification, URI SAN matching, and inbound service allow-lists. Certificate issuance and rotation remain external responsibilities.

## What to lead with

When presenting OpenMesh, lead with these ideas in order:

1. **Start as an API. Grow into a mesh.**
   A developer can begin with normal typed `app.get/post` routes and only learn `app.mesh('service')` when the application splits into services.

2. **Application-native mesh, no sidecar hop.**
   Discovery, traffic targeting, peer selection, deadlines, retries, circuits, pressure, tracing, and streaming live in the Node.js runtime.

3. **Failure semantics are explicit.**
   Admission, queueing, deadlines, retries, circuits, stream commitment, and shutdown behavior are defined rather than hidden.

4. **Real control-plane behavior.**
   Registration leases, membership watches, live config CAS, least-privilege credentials, and Redis-backed persistence are working features.

5. **Identity is real, PKI automation is not.**
   OpenMesh 0.5 authenticates workloads with SPIFFE-style URI identities and mutual TLS. It does not yet issue, rotate, or distribute certificates, so do not market it as a transparent Istio/Linkerd replacement.

6. **Measured rather than marketed performance.**
   Benchmarks are reproducible regression evidence, not “fastest framework” advertising.

## 15-second pitch

> OpenMesh lets a Node.js app start as a normal typed API and grow into an application-native service mesh. When services split, `app.mesh('payments')` adds discovery-backed routing, traffic policy, overload protection, retries, circuits, tracing, and streaming without putting a sidecar proxy in the request path.

## 60-second pitch

> OpenMesh starts where ordinary API frameworks usually stop. You can write a normal typed Node.js API, then use `app.mesh('payments')` when that application grows into multiple services.
>
> The service handle is backed by the existing OpenMesh runtime: discovery watches, metadata traffic subsets, P2C/rendezvous routing, per-service admission, adaptive concurrency, deadlines, retry rules, circuits, streaming semantics, trace propagation, and peer metrics. The control plane adds registration leases, scoped credentials, live config CAS, and durable Redis adapters.
>
> The key implementation choice is application-native rather than sidecar-native: there is no extra proxy hop in the OpenMesh request path. The 0.5 preview now authenticates service calls with SPIFFE-style workload identity and mutual TLS, while certificate issuance/rotation stays outside the runtime. OpenMesh 0.4 remains the current npm release; the smaller `app.mesh()` developer surface is the 0.5 preview.

## Demonstrations

### Complete service flow

```sh
npm run demo:services
```

Shows:

- control plane startup;
- two service instances registering with leases;
- discovery-backed routing;
- live configuration update;
- graceful instance removal;
- routing to the remaining service.

### Peer failure flow

```sh
npm run demo:cluster
```

Shows peer routing, shutdown, failover, and bounded broadcast behavior.

### Ecosystem bridge

```sh
npm run example:ecosystem
```

Shows native OpenMesh routes alongside real Express/Fastify integrations.

### Release benchmark

```sh
node benchmarks/run.cjs --duration=3 --rounds=3 --connections=32 \
  --frameworks=openmesh,fastify \
  --scenarios=plaintext,json,params,body,middleware
```

Always share the environment, raw rounds, limitations, and same-run comparison methodology with benchmark numbers.

## GitHub positioning

Recommended repository description:

> Application-native service mesh and typed HTTP runtime for Node.js — start as an API, grow into a mesh.

Recommended GitHub topics:

```text
nodejs
typescript
service-mesh
mtls
spiffe
workload-identity
microservices
distributed-systems
service-discovery
traffic-management
backpressure
streaming
redis
opentelemetry
http
service-runtime
```

The README first screen should communicate, in this order:

1. “Start as an API. Grow into a mesh.”;
2. one normal typed API example;
3. one `app.mesh('payments')` example;
4. no-sidecar architecture, workload identity, and the honest certificate-lifecycle boundary;
5. release/CI status;
6. deeper runtime architecture and evidence.

Do not lead the repository with benchmark competitor names. Performance belongs in the evidence section.

## Good launch surfaces

Prioritize developer audiences where the architecture itself is relevant:

- Node.js / TypeScript communities;
- distributed systems and backend engineering discussions;
- Redis and OpenTelemetry integration communities when sharing those specific adapters;
- Hacker News / Show HN when the repository has a concise runnable demo and honest technical positioning;
- Reddit communities where self-promotion rules permit technical project posts;
- local developer meetups and architecture discussions;
- GitHub Discussions on related projects only when the contribution is genuinely relevant.

Avoid generic “we are faster” posts. A better hook is a concrete engineering problem:

- retries after streaming headers;
- per-service bulkheads in Node;
- discovery leases without a service-mesh sidecar;
- durable Redis CAS for live config;
- dependency-free lifecycle observability.

## Adoption plan

1. Keep the 30-second example working on every release.
2. Treat packed npm installation as a first-class CI target.
3. Ask early users for concrete failure cases rather than generic feedback.
4. Add durable adapters only when they can pass the published conformance harness.
5. Preserve reproducible performance reports instead of cherry-picking runs.
6. Turn real integration pain into small issues with testable acceptance criteria.
7. Keep the README focused; move deep operational semantics into docs.

Track:

- successful installs;
- repeat usage;
- real integration issues;
- external bug reports;
- community PRs;
- adapter implementations;
- dependent projects.

Stars and download counts are useful signals, but they are not substitutes for real usage.

## Current release status

OpenMesh **0.4.0 is published on npm**.

The release includes:

- request/server/peer lifecycle observability;
- streaming peer responses and idle timeout policy;
- per-service bulkheads;
- adaptive concurrency;
- scoped control-plane credentials;
- durable Redis adapters;
- OpenTelemetry-compatible metrics bridge;
- adapter conformance tooling;
- benchmark regression CI;
- Linux/Windows package verification.

The **0.5 preview branch** adds the smaller developer path described above: simple Standard Schema typed routes, `app.mesh('service')`, automatic request-context propagation, metadata traffic targeting/weighted subsets, locality failover, live traffic policy, complete HTTP lifecycle hooks, expanded body-parser plugins, and SPIFFE-style workload identity with service-to-service mTLS.

The identity layer verifies CA chains and exact workload URI SANs and supports inbound service allow-lists. Certificate issuance, renewal/rotation, and revocation distribution are **not** automated by OpenMesh yet. Keep that boundary visible in launch material rather than implying transparent Istio/Linkerd parity.

The project remains pre-1.0. Compatibility may evolve between minor releases.
