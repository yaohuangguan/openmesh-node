# Observability

OpenMesh keeps observability exporter-neutral in the runtime. Application and peer lifecycle events are emitted only when an observer is configured.

## OpenTelemetry metrics bridge

`openmesh-node/otel` converts OpenMesh lifecycle events into an OpenTelemetry-compatible Meter without importing or requiring `@opentelemetry/api` itself.

```js
import { metrics } from '@opentelemetry/api';
import openmesh from 'openmesh-node';
import { PeerPool } from 'openmesh-node/mesh';
import { createOpenTelemetryObservers } from 'openmesh-node/otel';

const meter = metrics.getMeter('users-service');
const telemetry = createOpenTelemetryObservers({
  meter,
  attributes: {
    service: 'users',
    deployment: 'production'
  }
});

const app = openmesh({ onEvent: telemetry.onAppEvent });
const peers = new PeerPool({
  peers: [],
  onEvent: telemetry.onPeerEvent
});
```

The bridge uses a small structural Meter contract, so applications can pass a normal OpenTelemetry Meter or a compatible test/facade object.

## Metrics

The bridge records:

- inbound request started/completed/error counters;
- inbound request duration in seconds;
- server lifecycle counters;
- outbound peer attempt/success/failure/cancellation counters;
- outbound peer attempt duration in seconds;
- admission queued/rejected counters;
- adaptive concurrency limit observations.

HTTP route templates are used when available. Raw inbound request paths, peer URLs, request bodies, headers, configuration values, and tokens are not emitted as metric attributes by the bridge. Peer IDs are included because they are already bounded by the current discovery membership.

Static attributes supplied to `createOpenTelemetryObservers()` are merged into every metric. Keep them low-cardinality, for example service, deployment, region, or cluster.

## Tracing

OpenMesh still does not create OpenTelemetry spans in core. `requestContext()` propagates request IDs and W3C `traceparent` state through `AsyncLocalStorage`; the lifecycle event contract is the intended boundary for a future tracing bridge without changing the request hot path.
