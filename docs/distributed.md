# Distributed services and HTTP peers

`openmesh-node/mesh` is an independent peer client for known HTTP/HTTPS nodes and service gateways. The HTTP server does not load it unless requested.

## Selection and failure behavior

```js
import { PeerPool } from 'openmesh-node/mesh';
const pool = new PeerPool({
  peers: [{ id: 'a', url: 'https://users-a.example.com' }],
  timeout: 2000, retries: 1, failureThreshold: 3, cooldown: 10000,
  maxResponseBytes: 1024 * 1024, maxSockets: 32
});
const result = await pool.request('/users/42', { key: '42' });
console.log(result.peer.id, result.statusCode, result.json());
pool.close();
```

| Behavior | Exact scope |
| --- | --- |
| Routing | SHA-256 rendezvous ranking of key + stable peer ID; independent of list order |
| Membership change | Removed-owner keys move; unchanged peer IDs retain preference |
| No supplied key | Generated per-call keys distribute preference; not strict round-robin |
| Retry | Distinct available peers; at most `retries + 1` attempts |
| Retriable failure | Transport error, oversized/aborted response, or HTTP 5xx |
| HTTP 4xx | Returned as a response; not retried |
| Deadline | One total time budget across connection, queuing, response, and retries |
| Circuit | Consecutive failures open one peer; cooldown allows a single half-open probe |
| Caller cancellation | Propagates through `AbortSignal`; does not count as peer failure |
| Transport | Keep-alive HTTP/HTTPS; 32 sockets per origin by default, 256 total per protocol agent |
| Response | Buffered, bounded bytes; no streaming client API in 0.1 |

`pool.rank(key)` returns ordered peers. `pool.stats()` returns failures, attempts, circuit state and probe status. Circuit state is local to this process; it is not cluster-wide health consensus. An expired request deadline counts as a failed peer attempt. The deadline does not encompass asynchronous service discovery, which is run separately.

The built-in client returns `PeerResponse` with `peer`, `statusCode`, `headers`, `body`, `.text()` and `.json()`. `pool.json()` is a convenience; use `request()` when application handling depends on the HTTP status. `PeerError.code` identifies errors such as `NO_PEERS`, `NO_HEALTHY_PEERS`, `REMOTE_HTTP_ERROR`, `DEADLINE_EXCEEDED`, `RESPONSE_TOO_LARGE`, and `POOL_CLOSED`. Native socket errors retain their Node codes.

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
