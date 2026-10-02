# Launch material and adoption plan

## Short introduction

OpenMesh is a small Node.js HTTP framework for connected services. Its zero-dependency native core supports onion middleware and real Express/Fastify bridges. Optional modules add keyed peer routing, deadlines, failover, lease-based registration, discovery, and live configuration. Try the complete microservice demo and reproduce the benchmark reports.

Repository: https://github.com/yaohuangguan/openmesh-node

## Demonstrations

1. Run `npm run demo:services`: services register, a gateway discovers them, configuration changes live, and shutdown removes an instance.
2. Run `npm run demo:cluster`: stop the selected HTTP peer and verify failover.
3. Run `npm run example:ecosystem`: native, Express, and Fastify routes behind one entry point.
4. Share benchmark commands and raw results with the recorded environment and limitations.

## Adoption plan

1. Ask developers operating Node.js microservices to reproduce the examples and report concrete integration problems.
2. Share a short demo through the maintainer's own developer communities, respecting each community's posting rules.
3. Collect independent Linux measurements, representative payloads, and practical discovery/plugin integrations.
4. Publish the initial npm version, then establish compatibility and maintenance policies before claiming production readiness.

Track successful installations, working integrations, useful issues, repeat usage, and external contributions. Stars are a secondary signal. Adoption requires real user feedback; benchmark results and launch copy do not guarantee growth.

No community messages have been sent automatically. Initial npm publication is pending maintainer authentication.
