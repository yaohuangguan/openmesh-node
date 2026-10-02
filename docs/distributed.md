# Distributed services and HTTP peers

`openmesh-node/mesh` is an independent peer client for known HTTP/HTTPS nodes and service gateways. The HTTP server does not load it unless requested.

## Selection and failure behavior

```js
import { PeerPool } from 'openmesh-node/mesh';
const pool = new PeerPool({
  peers: [{ id: 'a', url: 'https://users-a.example.com' }],
  timeout: 2000, retries: 1, failureThreshold: 3, cooldown: 10000,
  maxResponseBytes: 1024 * 1024, maxSockets: 32,
  maxInflight: 256, maxQueue: 1024,
  selection: 'p2c'
});
const result = await pool.request('/users/42', { key: '42' });

// Optional zero-dependency telemetry hook:
// new PeerPool({ onEvent: event => metrics.enqueue(event) })
console.log(result.peer.id, result.statusCode, result.json());
pool.close();
```

| Behavior | Exact scope |
| --- | --- |
| Keyed routing | SHA-256 rendezvous ranking of key + stable peer ID; independent of list order |
| Membership change | Removed-owner keys move; unchanged peer IDs retain preference |
| No supplied key | Default `p2c` selection compares the first two rendezvous candidates and prefers the healthier, less-loaded peer |
| Compatibility mode | `selection: 'rendezvous'` keeps generated per-call rendezvous ranking without load-aware reordering |
| Retry | Distinct available peers; at most `retries + 1` attempts |
| Retriable failure | Transport error, oversized/aborted response, or HTTP 5xx |
| HTTP 4xx | Returned as a response; not retried |
| Admission | At most `maxInflight` requests execute; up to `maxQueue` wait FIFO; a full queue fails with `POOL_OVERLOADED` |
| Deadline | One total time budget across admission queueing, connection, response, and retries |
| Circuit | Consecutive failures open one peer; cooldown allows a single half-open probe |
| Caller cancellation | Propagates through `AbortSignal`; does not count as peer failure |
| Transport | Keep-alive HTTP/HTTPS; 32 sockets per origin by default, 256 total per protocol agent |
| Response | `request()` buffers up to `maxResponseBytes`; `requestStream()` exposes a bounded Node readable stream |

`pool.rank(key)` always returns the raw rendezvous order and is unaffected by adaptive selection. `pool.stats()` returns per-peer failures, attempts, successes, in-flight requests, latency telemetry, circuit state and probe status. `pool.poolStats()` returns pool-wide admitted/queued counts, the current concurrency limit, hard limits, adaptive-mode status, and overload rejections. Circuit state is local to this process; it is not cluster-wide health consensus. An expired request deadline during an actual peer attempt counts as a failed peer attempt; timing out while still waiting for admission does not touch peer circuit state. The deadline does not encompass asynchronous service discovery, which is run separately.

The buffered client returns `PeerResponse` with `peer`, `statusCode`, `headers`, `body`, `.text()` and `.json()`. `pool.json()` is a convenience; use `request()` when application handling depends on the HTTP status. `requestStream()` returns `PeerStreamResponse`; its `body` is a Node readable stream and its async `.text()` / `.json()` helpers consume that stream once. `PeerError.code` identifies errors such as `NO_PEERS`, `NO_HEALTHY_PEERS`, `POOL_OVERLOADED`, `REMOTE_HTTP_ERROR`, `DEADLINE_EXCEEDED`, `RESPONSE_TOO_LARGE`, and `POOL_CLOSED`. Native socket errors retain their Node codes.

## Retry semantics

GET, HEAD, OPTIONS, PUT and DELETE can retry. Your endpoints must actually implement HTTP idempotency semantics; a framework cannot enforce that on another service. POST/PATCH default to a single attempt.

```js
await pool.request('/jobs', {
  method: 'POST', body: { job: 'render' },
  retryUnsafe: true, idempotencyKey: 'stable-operation-id', retries: 1
});
```

Only enable this when the server persistently deduplicates the operation across all eligible peers. The client adds `idempotency-key`; it provides no deduplication store and no exactly-once guarantee. A failed network response can occur after a remote operation succeeds.

Object bodies are serialized as JSON with a default JSON content type. Strings/Buffers/Uint8Arrays are sent unchanged. Supply only required outbound headers, for example `ctx.state.outboundHeaders`; avoid copying inbound hop-by-hop headers or unrelated authorization credentials wholesale.

## Streaming responses

Use streaming when buffering the entire peer response would be wasteful or incorrect:

```js
const response = await pool.requestStream('/events', {
  signal: controller.signal,
  timeout: 2000
});

response.body.pipe(destination);
```

For streaming calls, `timeout` covers admission plus the time required to obtain response headers. Once non-5xx headers are returned to the caller, the response is committed and OpenMesh will not retry another peer if the body later fails. The pool continues to hold admission and peer in-flight accounting until the body ends, fails, is destroyed, or the pool closes.

A consumer that no longer needs the body should call `response.destroy()` or abort the supplied signal. Consumer cancellation does not poison the peer circuit. Transport/body failures after headers do count against peer health.

## Adaptive concurrency

Adaptive concurrency is disabled by default. When enabled, `maxInflight` stays the hard ceiling while the effective `concurrencyLimit` moves inside a configured range:

```js
const pool = new PeerPool({
  peers,
  maxInflight: 128,
  adaptiveConcurrency: {
    min: 8,
    initial: 32,
    max: 96,
    targetLatencyMs: 100,
    decreaseRatio: 0.8,
    increaseStep: 1,
    sampleSize: 20
  }
});
```

Successful buffered requests are sampled by latency; streaming calls feed time-to-headers so a healthy long-lived SSE/LLM stream does not look like a multi-minute request latency. Low p90 latency causes additive growth, high latency causes multiplicative reduction, and pre-header failures reduce the limit immediately. `pool.poolStats().concurrencyLimit` exposes the live value and `concurrency.changed` observer events explain changes.

## Discovery and fan-out

```js
await pool.discover(async () => registry.list('users'));
pool.watch(async () => registry.list('users'), {
  interval: 10000,
  onError: error => console.error('discovery', error)
});
const results = await pool.broadcast('/health/live', { concurrency: 4 });
```

Providers return `[{ id, url }]`. Updates validate the whole list before replacing membership; invalid results preserve the old list. Reusing a peer ID with a changed URL resets its circuit. Watch refreshes never overlap, start immediately, and preserve prior membership on failure. The provider owns its own timeout. `stopDiscovery()` stops refreshes and ignores a pending provider's result.

Broadcast returns one fulfilled/rejected result per peer, with bounded concurrency (1..64) and no cross-peer retry. The timeout applies to each dispatched request, rather than one global broadcast deadline. Supply an external AbortSignal for a total fan-out deadline.

`close()` stops discovery, aborts active requests and destroys HTTP agents. Register it through `app.onClose(() => pool.close())`.

## Trust and transport adapters

Peers are explicitly configured trusted addresses, not addresses from an end user's request. The default transport uses Node's normal HTTPS certificate verification. Per-request paths cannot replace the peer's authority, contain credentials, or redirect the client to another origin. HTTP redirect responses are returned without following them.

For externally supplied transport:

```js
const pool = new PeerPool({
  peers,
  transport: async ({ peer, url, method, headers, body, signal, maxResponseBytes }) => {
    // Adapter owns actual I/O, cancellation, and response-size enforcement.
    return { statusCode: 200, headers: {}, body: Buffer.from('{}') };
  }
});
```

The pool enforces selection, retries, circuits and caller-visible deadlines around the adapter. The adapter must respect cancellation to release its resources and enforce `maxResponseBytes`. The bundled [control-plane module](services.md) provides registration and discovery. External registries, DNS-SRV, libp2p and message transports can be implemented behind these interfaces. Peer URLs currently require HTTP(S) identifiers even when using a custom transport.

P2P here means communication between known addressable HTTP nodes. Registry-backed discovery is available in 0.2. The peer transport itself provides no NAT traversal, DHT, gossip, consensus, durable queues, application authentication, or full OpenTelemetry exporter.
