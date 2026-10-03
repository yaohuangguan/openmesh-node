# Launch material and adoption plan

## One-line positioning

**OpenMesh is a TypeScript-first Node.js service runtime for discovery, routing, streaming, backpressure, live configuration, and observability.**

It is not positioned as another web framework. The HTTP server is the entry point; the differentiator is what happens between services once the application grows beyond one process.

Repository: https://github.com/yaohuangguan/openmesh-node

npm: https://www.npmjs.com/package/openmesh-node

Current release: **0.4.0**

## Short introduction

OpenMesh gives Node.js services an application-level runtime for service-to-service communication.

The native request path has zero runtime dependencies. Optional modules add discovery-backed service pools, bounded queues, per-service bulkheads, adaptive concurrency, deadlines, retries, circuit breaking, true streaming, scoped control-plane credentials, durable Redis registry/config adapters, live configuration, and OpenTelemetry-compatible metrics.

The package ships ESM, CommonJS, and generated TypeScript declarations.

## What to lead with

When presenting OpenMesh, lead with these ideas in order:

1. **Service runtime, not another router.**
   The interesting part begins after one HTTP service needs to reliably call another.

2. **Failure semantics are explicit.**
   Admission, queueing, deadlines, retries, circuits, stream commitment, and shutdown behavior are part of the API rather than hidden defaults.

3. **Small native core, optional integrations.**
   Redis, OpenTelemetry, Express, and Fastify sit behind explicit boundaries instead of becoming core dependencies.

4. **Real control-plane behavior.**
   Registration leases, membership watches, live config CAS, least-privilege credentials, and Redis-backed persistence are working features, not roadmap bullets.

5. **Measured rather than marketed performance.**
   Benchmarks are reproducible regression evidence, not “fastest framework” advertising.

## 15-second pitch

> OpenMesh is a Node.js service runtime for applications that have outgrown “just call another URL.” It adds discovery-backed routing, overload protection, streaming semantics, live configuration, durable Redis control-plane adapters, and observability while keeping the native HTTP core dependency-free.

## 60-second pitch

> Node has many good HTTP frameworks. OpenMesh focuses on the layer after that: how services find each other, route requests, fail over, handle overload, stream safely, change configuration, and expose telemetry.
>
> A managed ServicePool follows discovery and owns isolated queue, concurrency, circuit, and adaptive state. Streaming responses have explicit commit semantics so post-header failures are never silently replayed. The control plane supports registration leases, scoped credentials, live config CAS, and durable Redis adapters. The native request path stays dependency-light and the package ships as TypeScript-first ESM/CommonJS.
>
> OpenMesh 0.4 is available on npm and CI validates Linux/Windows, Node 22/24, real Redis integration, packed-package imports, demos, and normalized performance regression.

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

> Node.js service runtime for discovery, routing, backpressure, streaming, live config, Redis control plane, and observability.

Recommended GitHub topics:

```text
nodejs
typescript
microservices
distributed-systems
service-discovery
backpressure
streaming
redis
opentelemetry
http
service-runtime
```

The README first screen should communicate, in this order:

1. service runtime positioning;
2. install command;
3. release/CI status;
4. why it is different;
5. architecture;
6. runnable code.

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

The project remains pre-1.0. Compatibility may evolve between minor releases.
