# OpenMesh documentation

OpenMesh **0.5.0** is an application-native service mesh and typed HTTP runtime for Node.js.

Start with the website documentation for the shortest path, then use the deep technical references here when you need exact runtime or protocol behavior.

- [Website documentation](https://openmesh-node.vercel.app/docs/)
- [0.5 architecture](architecture-0.5.md)
- [Application-native mesh](mesh-runtime.md)
- [Native API](api.md)

## Application development

| Document | Use it for |
| --- | --- |
| [Advanced HTTP contracts](functional-http.md) | immutable route contracts, Standard Schema, lifecycle hooks, body parsing |
| [Databases and ORMs](database.md) | Prisma, Drizzle, Kysely, TypeORM, MikroORM, Sequelize and lifecycle |
| [Plugins and ecosystem bridges](plugins.md) | native plugins plus real Express/Fastify integration |
| [Application-native mesh](mesh-runtime.md) | `app.mesh()`, traffic targeting, workload identity and certificate rotation |

## Distributed runtime

| Document | Use it for |
| --- | --- |
| [Distributed services and HTTP peers](distributed.md) | peer selection, admission, deadlines, retries, circuits and streaming |
| [Services and control plane](services.md) | registration, discovery, SSE watches, configuration CAS, scoped credentials and Redis |
| [Observability](observability.md) | lifecycle events, OpenTelemetry-compatible metrics and trace propagation |
| [Performance](performance.md) | preserved benchmark reports, methodology and CI regression budgets |

## Operations and project

- [Launch and adoption](launch.md)
- [Releasing](releasing.md)
- [Changelog](../CHANGELOG.md)
- [Contributing](../CONTRIBUTING.md)

## Historical architecture

These are preserved design snapshots, not the primary documentation for current applications:

- [0.4 architecture](architecture-0.4.md)
- [0.3 architecture](architecture-0.3.md)
- [Go native-engine experiment](native-engine.md)

For current design decisions, prefer [OpenMesh 0.5 architecture](architecture-0.5.md).
