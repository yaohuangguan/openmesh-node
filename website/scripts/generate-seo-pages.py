from __future__ import annotations

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://openmesh-node.vercel.app"
OG = f"{BASE}/og/openmesh-node.png"
DATE = "2026-10-04"

PAGES = {
    "nodejs-service-runtime": {
        "title": "Node.js Service Runtime in TypeScript | OpenMesh",
        "h1": "A Node.js service runtime that starts as an API.",
        "eyebrow": "Node.js service runtime",
        "description": "How OpenMesh combines native Node.js HTTP, TypeScript contracts, application lifecycle, database resources and an incremental path to distributed services.",
        "intro": "An HTTP framework answers how a request reaches a handler. A service runtime also answers what happens when the application gains databases, downstream services, topology changes, overload, identity and telemetry. OpenMesh keeps those concerns in one TypeScript runtime without forcing them into the first hello-world service.",
        "sections": [
            {
                "id": "runtime-not-framework",
                "kicker": "01 · boundary",
                "title": "The useful boundary is larger than the router.",
                "body": """
<p>Most Node.js applications begin with a small set of routes and middleware. That is a good default. Problems appear later, when the same application has to register itself, discover another service, survive a slow dependency, propagate trace context and shut down without advertising a half-dead instance.</p>
<p>OpenMesh treats the <strong>application lifecycle</strong> as the integration boundary. The HTTP server, service registration, database resources, managed peer pools, telemetry adapters and workload certificates can all participate in startup and shutdown. You can still use only the HTTP layer; the other layers are opt-in.</p>
<div class="callout"><strong>Core idea</strong><p>Start with an ordinary API. Add runtime capabilities when the system creates the problem that needs them.</p></div>
"""
            },
            {
                "id": "http",
                "kicker": "02 · native HTTP",
                "title": "Keep the request path inside Node.js.",
                "body": """
<p>OpenMesh owns a normal Node.js HTTP server. Application traffic is not proxied through a second runtime. Routing, middleware, Standard Schema-compatible validation, response contracts and graceful lifecycle hooks execute in-process.</p>
<div class="code-card"><pre><code>import openmesh from 'openmesh-node';
import { bodyParser } from 'openmesh-node/plugins';

const app = openmesh();
app.use(bodyParser());

app.get('/users/:id', ({ params }) =&gt; ({
  id: params.id
}));

await app.listen({ port: 3000 });</code></pre></div>
<p>The package ships ESM, CommonJS and generated TypeScript declarations. The native HTTP core has zero runtime dependencies; integrations such as Redis and OpenTelemetry remain optional boundaries.</p>
"""
            },
            {
                "id": "database",
                "kicker": "03 · resources",
                "title": "Your database client remains your database client.",
                "body": """
<p>A service runtime does not need to invent a query language. <code>openmesh-node/db</code> wraps the lifecycle of the client you already chose and preserves its type. Prisma, Drizzle, Kysely, TypeORM, MikroORM, Sequelize and lower-level clients can keep their native APIs.</p>
<div class="code-card"><pre><code>import { database } from 'openmesh-node/db';

const db = database(prisma, {
  connect: client =&gt; client.$connect(),
  disconnect: client =&gt; client.$disconnect(),
  transaction: (client, work) =&gt; client.$transaction(work)
});

app.register(db);
app.get('/users', () =&gt; db.client.user.findMany());</code></pre></div>
<p>This keeps connection setup, health, transactions and shutdown explicit without turning the runtime into an ORM.</p>
"""
            },
            {
                "id": "grow",
                "kicker": "04 · distribution",
                "title": "When the application splits, the programming model grows.",
                "body": """
<p>The preferred service-to-service surface in OpenMesh 0.5 is <code>app.mesh(name)</code>. A handle is lazy. The first real call creates one managed service relationship and reuses its discovery watch, pressure budget, circuit state, traffic policy and transport resources.</p>
<div class="code-card"><pre><code>const payments = app.mesh('payments');

const charge = await payments.post('/charges', {
  key: user.id,
  body: {
    userId: user.id,
    amount: order.total
  }
});</code></pre></div>
<p>The point is not to hide the network. The point is to stop every caller from re-implementing the same discovery, deadline, retry and observability glue with slightly different failure semantics.</p>
"""
            },
            {
                "id": "adoption",
                "kicker": "05 · adoption",
                "title": "Use the layer that matches the system you actually have.",
                "body": """
<div class="matrix"><table><thead><tr><th>Stage</th><th>OpenMesh surface</th><th>What stays optional</th></tr></thead><tbody>
<tr><td>Single API</td><td>HTTP runtime + plugins</td><td>control plane, mesh, Redis, telemetry</td></tr>
<tr><td>API + database</td><td><code>openmesh-node/db</code></td><td>mesh and discovery</td></tr>
<tr><td>Several services</td><td><code>app.mesh()</code> + control plane</td><td>mTLS, Redis, advanced policy</td></tr>
<tr><td>Production mesh</td><td>traffic policy, backpressure, identity, observability</td><td>components you do not need</td></tr>
</tbody></table></div>
<p>OpenMesh is intentionally not a hidden cluster platform. Certificate issuance, orchestration, DNS, infrastructure provisioning and Kubernetes networking remain external responsibilities. That boundary makes the runtime easier to reason about and keeps adoption incremental.</p>
<p>Read the <a href="/docs/">OpenMesh 0.5 documentation</a> or the <a href="https://github.com/yaohuangguan/openmesh-node/blob/master/docs/architecture-0.5.md">full 0.5 architecture</a> for exact APIs and limits.</p>
"""
            },
        ],
        "next": [
            ("application-native-service-mesh", "Application-native service mesh", "How discovery, policy, retries and identity live in the Node.js runtime."),
            ("service-discovery", "Node.js service discovery", "Leases, revisions and push watches for changing service topology."),
        ],
    },
    "application-native-service-mesh": {
        "title": "Application-Native Service Mesh for Node.js | OpenMesh",
        "h1": "A service mesh inside the Node.js application boundary.",
        "eyebrow": "Application-native service mesh",
        "description": "OpenMesh application-native service mesh for Node.js: live discovery, traffic policy, backpressure, retries, circuits, mTLS and observability without a sidecar hop.",
        "intro": "A traditional service mesh usually places a proxy beside each workload. OpenMesh takes a different path for Node.js: the application owns the service relationship directly, so discovery, routing policy, backpressure, retries, circuits, identity and telemetry share the same runtime state as the caller.",
        "sections": [
            {
                "id": "meaning",
                "kicker": "01 · model",
                "title": "Application-native means the caller owns the relationship.",
                "body": """
<p>With OpenMesh, <code>app.mesh('payments')</code> returns a lazy service handle. The first request creates a managed pool for that relationship; repeated calls reuse it. The pool retains live topology, admission state, circuit history, latency statistics, traffic targeting and transport resources.</p>
<p>This is materially different from sprinkling <code>fetch()</code> calls through handlers. The caller still sees HTTP semantics, but the operational behavior of a downstream relationship is centralized and inspectable.</p>
<div class="callout"><strong>No sidecar hop</strong><p>OpenMesh does not proxy application requests through a separate Go or Envoy process. The Node.js runtime remains in the data path.</p></div>
"""
            },
            {
                "id": "two-stage-routing",
                "kicker": "02 · traffic",
                "title": "First choose the subset. Then choose the peer.",
                "body": """
<p>OpenMesh 0.5 separates <strong>traffic targeting</strong> from <strong>peer selection</strong>. A request can first be narrowed to an eligible subset by metadata, ordered header rules, weighted splits or locality preference. Only then does the peer selector choose an instance inside that subset.</p>
<div class="code-card"><pre><code>mesh: {
  services: {
    payments: {
      traffic: {
        split: [
          { match: { version: 'v1' }, weight: 90 },
          { match: { version: 'v2' }, weight: 10 }
        ]
      }
    }
  }
}</code></pre></div>
<p>A stable request key can keep weighted selection sticky. Explicit targets fail closed when no matching peer exists. Retries remain inside the selected traffic subset instead of silently escaping a canary or locality rule.</p>
"""
            },
            {
                "id": "failure",
                "kicker": "03 · failure semantics",
                "title": "Backpressure and retries are bounded together.",
                "body": """
<p>A distributed call has more states than success and error. It can wait in a queue, consume an in-flight slot, time out before transport starts, fail after headers have been committed, or reach a peer whose circuit is already open.</p>
<p>OpenMesh can bound those states with per-service admission, <code>maxInflight</code>, bounded FIFO queues, one total deadline across queueing and attempts, per-peer circuits and optional adaptive concurrency. Unsafe methods are not retried implicitly; callers can opt in when they have an idempotency key or equivalent guarantee.</p>
<p>Streaming responses have explicit semantics too: once successful non-5xx headers are handed to the caller, a later body failure is surfaced to the consumer and is never replayed against another peer.</p>
"""
            },
            {
                "id": "identity",
                "kicker": "04 · trust",
                "title": "Service identity can travel with the same relationship.",
                "body": """
<p>OpenMesh supports SPIFFE-style workload identities and mutual TLS. The local runtime validates its certificate before serving traffic; inbound callers can be restricted by service identity, and outbound mesh calls verify that the destination certificate identifies the expected service.</p>
<p>Certificate material can be rotated for new inbound and outbound connections without restarting the application. Issuance, revocation distribution and trust-domain governance are intentionally external.</p>
"""
            },
            {
                "id": "not-istio",
                "kicker": "05 · boundary",
                "title": "It is not a drop-in replacement for an infrastructure mesh.",
                "body": """
<p>OpenMesh does not provide transparent interception, Kubernetes CNI behavior, certificate authority automation, cross-language proxies or cluster-level policy enforcement. Those are different product boundaries.</p>
<p>The application-native model is strongest when a Node.js team wants explicit service-to-service behavior in code and runtime state, wants to avoid a sidecar hop, and is comfortable keeping infrastructure responsibilities outside the package.</p>
<div class="matrix"><table><thead><tr><th>Concern</th><th>OpenMesh</th><th>External</th></tr></thead><tbody>
<tr><td>Discovery + routing</td><td>yes</td><td>optional external adapters</td></tr>
<tr><td>Retries + circuits + pressure</td><td>yes</td><td>—</td></tr>
<tr><td>mTLS verification</td><td>yes</td><td>certificate issuance</td></tr>
<tr><td>Telemetry events</td><td>yes</td><td>collector/backend</td></tr>
<tr><td>Kubernetes networking</td><td>no</td><td>platform/CNI</td></tr>
</tbody></table></div>
<p>See the <a href="https://github.com/yaohuangguan/openmesh-node/blob/master/docs/mesh-runtime.md">application-native mesh deep dive</a> for the exact current contract.</p>
"""
            },
        ],
        "next": [
            ("peer-routing", "Peer routing and resilience", "Rendezvous hashing, P2C, deadlines, circuits, backpressure and streams."),
            ("workload-identity-mtls", "mTLS workload identity", "How service identity and certificate rotation are enforced."),
        ],
    },
    "service-discovery": {
        "title": "Node.js Service Discovery with Leases & SSE | OpenMesh",
        "h1": "Service discovery should be versioned runtime state.",
        "eyebrow": "Node.js service discovery",
        "description": "A practical model for Node.js service registration and discovery using expiring leases, monotonic revisions, resumable SSE watches and pluggable durable adapters.",
        "intro": "A list of service URLs is only correct at one instant. OpenMesh models discovery as changing state: instances own expiring leases, membership snapshots carry revisions, and consumers receive push-first updates that can resume after reconnects.",
        "sections": [
            {
                "id": "leases",
                "kicker": "01 · registration",
                "title": "Registration is a lease, not a permanent row.",
                "body": """
<p>An instance that crashes cannot reliably run a cleanup callback. That is why OpenMesh registrations expire unless the owner renews them. A healthy service heartbeats its lease; graceful shutdown removes the lease before request draining so new callers stop selecting the instance while in-flight work can finish.</p>
<p>This model makes liveness an explicit property of the registry rather than an assumption hidden inside a deployment script.</p>
"""
            },
            {
                "id": "snapshots",
                "kicker": "02 · consistency",
                "title": "Discovery returns snapshots with monotonic revisions.",
                "body": """
<p>Membership can change while a caller is reading it. OpenMesh associates each service membership snapshot with a monotonic revision. Pagination can restart when the revision changes instead of returning a mixed view assembled from two different topologies.</p>
<div class="code-card"><pre><code>{
  "service": "users",
  "revision": 18,
  "instances": [
    { "id": "users-a", "url": "http://10.0.0.12:3000" },
    { "id": "users-b", "url": "http://10.0.0.13:3000" }
  ]
}</code></pre></div>
<p>The revision is also useful to downstream routing logic: it can tell whether an update is newer without diffing arbitrary arrays.</p>
"""
            },
            {
                "id": "watches",
                "kicker": "03 · push delivery",
                "title": "Steady-state topology updates are push-first.",
                "body": """
<p>OpenMesh uses authenticated Server-Sent Events for service and configuration watches. A watcher receives an initial full snapshot and later snapshots when state changes. Heartbeat comments keep idle streams alive.</p>
<p>SSE events carry IDs. On reconnect the client sends <code>Last-Event-ID</code>; if state has not advanced, the control plane can avoid a duplicate snapshot. If state did advance, the client receives the complete current snapshot rather than depending on a potentially lossy delta history.</p>
<div class="callout"><strong>Why full snapshots?</strong><p>For service membership, a complete versioned state is often easier to recover and validate than an unbounded log of add/remove deltas.</p></div>
"""
            },
            {
                "id": "durability",
                "kicker": "04 · storage",
                "title": "The protocol is separate from the storage adapter.",
                "body": """
<p>The bundled in-memory registry is useful for local clusters and tests. Production systems that need shared durable state can use the Redis adapters or implement the public registry/config contracts against another store.</p>
<p>That separation matters for portability: the application-facing discovery semantics stay the same while durability, replication and infrastructure ownership can change underneath.</p>
"""
            },
            {
                "id": "safety",
                "kicker": "05 · failure handling",
                "title": "A broken update should not erase the last good topology.",
                "body": """
<p>Discovery, configuration and traffic policy updates are validated before they replace runtime state. Invalid or unavailable updates preserve the last accepted snapshot. The service relationship therefore degrades from known-good state rather than immediately adopting malformed control-plane data.</p>
<p>Discovery is only one part of safe distributed calls. The resulting peer set feeds traffic targeting, peer selection, admission, deadlines, retries and circuits. Continue with the <a href="/guides/peer-routing/">peer routing guide</a>, or read the <a href="https://github.com/yaohuangguan/openmesh-node/blob/master/docs/services.md">control-plane protocol documentation</a>.</p>
"""
            },
        ],
        "next": [
            ("peer-routing", "Peer routing and resilience", "What happens after discovery supplies a changing set of eligible peers."),
            ("application-native-service-mesh", "Application-native service mesh", "How discovery becomes one part of a managed service relationship."),
        ],
    },
    "peer-routing": {
        "title": "Node.js Peer Routing, Retries & Circuit Breaking | OpenMesh",
        "h1": "Peer routing needs policy, not just a random URL.",
        "eyebrow": "Node.js peer routing",
        "description": "Node.js peer routing with OpenMesh: traffic subsets, rendezvous hashing, power-of-two choices, deadlines, safe retries, circuits, backpressure and streaming.",
        "intro": "Once discovery returns several healthy instances, the caller still has to choose one, enforce capacity, handle timeouts and decide whether a failed attempt is safe to replay. OpenMesh keeps those choices in one peer data plane.",
        "sections": [
            {
                "id": "selection",
                "kicker": "01 · selection",
                "title": "Keyed and unkeyed traffic need different selectors.",
                "body": """
<p>Keyed traffic often wants affinity. OpenMesh uses rendezvous hashing so the same key tends to select the same peer while minimizing remapping when membership changes. That works well for cache affinity, user/session locality and other stable-key workloads.</p>
<p>Unkeyed traffic defaults to power-of-two choices using available peer health/load state. Sampling two candidates and choosing the better one avoids the blind spots of pure round-robin while staying inexpensive.</p>
<p>Selection happens <em>after</em> traffic policy narrows the eligible subset, so a peer algorithm cannot accidentally escape a canary, metadata or locality rule.</p>
"""
            },
            {
                "id": "deadline",
                "kicker": "02 · deadline",
                "title": "One deadline covers queueing, transport and retries.",
                "body": """
<p>A timeout applied only to the socket does not bound total caller latency. A request may spend time waiting for an admission slot and then consume several attempts. OpenMesh treats the deadline as a budget for the complete call path.</p>
<p>If the budget expires in the queue, no network request should be started. If the budget is nearly exhausted after an attempt, a retry should not begin just because its individual socket timeout would fit.</p>
"""
            },
            {
                "id": "retry",
                "kicker": "03 · retry safety",
                "title": "Retry policy is constrained by method semantics.",
                "body": """
<p>Retries can turn a transient transport failure into a duplicated side effect. OpenMesh therefore does not implicitly retry unsafe methods such as POST or PATCH. A caller can opt in when it has an idempotency key or an application guarantee that makes replay safe.</p>
<p>Retries stay inside the traffic subset selected for the request. Circuit state is per peer, so a failing instance can be bypassed without treating the whole service as unhealthy.</p>
"""
            },
            {
                "id": "pressure",
                "kicker": "04 · pressure",
                "title": "Overload should create a bounded queue, not infinite work.",
                "body": """
<p>A managed service pool can set an in-flight limit and a bounded FIFO queue. Requests beyond those limits fail predictably rather than accumulating unbounded promises and memory. Optional adaptive concurrency can adjust admission from observed success and latency signals.</p>
<div class="matrix"><table><thead><tr><th>Primitive</th><th>Purpose</th></tr></thead><tbody>
<tr><td><code>maxInflight</code></td><td>hard cap on concurrent admitted work</td></tr>
<tr><td><code>maxQueue</code></td><td>bound waiting work and memory</td></tr>
<tr><td>circuit state</td><td>isolate repeatedly failing peers</td></tr>
<tr><td>adaptive concurrency</td><td>change admission based on observed runtime signals</td></tr>
<tr><td>deadline</td><td>bound total end-to-end waiting and attempts</td></tr>
</tbody></table></div>
"""
            },
            {
                "id": "streaming",
                "kicker": "05 · streaming",
                "title": "A stream cannot be safely replayed after it is committed.",
                "body": """
<p>Buffered requests and long-lived streams have different failure semantics. For SSE, LLM streams and other streaming bodies, OpenMesh commits the response once successful non-5xx headers are handed to the caller. If the body later fails, the error is surfaced to the consumer and is not replayed against another peer.</p>
<p>This explicit no-replay rule prevents duplicated or interleaved stream output. Read the <a href="https://github.com/yaohuangguan/openmesh-node/blob/master/docs/distributed.md">distributed peer documentation</a> for the lower-level options and telemetry fields.</p>
"""
            },
        ],
        "next": [
            ("service-discovery", "Node.js service discovery", "How the peer set stays current before selection begins."),
            ("application-native-service-mesh", "Application-native service mesh", "How peer routing becomes a reusable application service relationship."),
        ],
    },
    "workload-identity-mtls": {
        "title": "Node.js mTLS Workload Identity with SPIFFE-Style IDs | OpenMesh",
        "h1": "Bind Node.js services to workload identity and mTLS.",
        "eyebrow": "mTLS workload identity",
        "description": "How OpenMesh uses SPIFFE-style service identities, mutual TLS, inbound service authorization, outbound identity verification and certificate rotation in Node.js.",
        "intro": "Encryption answers who can read the transport. Workload identity answers which service is on the other end. OpenMesh 0.5 can bind a Node.js service to a SPIFFE-style identity and use the same identity model for inbound HTTPS and outbound mesh calls.",
        "sections": [
            {
                "id": "identity",
                "kicker": "01 · identity",
                "title": "The certificate identifies the service, not just a hostname.",
                "body": """
<p>OpenMesh expects a workload certificate to carry a URI SAN such as <code>spiffe://mesh.example.internal/service/payments</code>. The configured local service name and trust domain are validated against that identity before the runtime begins serving protected traffic.</p>
<div class="code-card"><pre><code>const payments = openmesh({
  service: 'payments',
  identity: {
    trustDomain: 'mesh.example.internal',
    ca,
    cert,
    key,
    allow: ['gateway']
  }
});</code></pre></div>
<p>The identity is an application boundary: the Node.js runtime knows which service it claims to be and can reject certificate material that does not match that claim.</p>
"""
            },
            {
                "id": "inbound",
                "kicker": "02 · inbound",
                "title": "Inbound connections must authenticate as trusted workloads.",
                "body": """
<p>When workload identity is enabled, the server requires a trusted client certificate. OpenMesh extracts the caller's SPIFFE-style service identity into request state. An optional allow-list can restrict inbound calls to named services such as <code>gateway</code> or <code>billing-worker</code>.</p>
<p>This is service authentication and authorization at the runtime layer. It does not replace business-level user authorization inside the route.</p>
"""
            },
            {
                "id": "outbound",
                "kicker": "03 · outbound",
                "title": "Outbound mesh calls verify the expected destination service.",
                "body": """
<p>An outbound <code>app.mesh('payments')</code> call automatically presents the caller's workload certificate when identity is configured. The TLS connection verifies both the trust chain and that the destination certificate identifies the expected service.</p>
<p>That closes an important gap in generic HTTPS: a certificate signed by the right CA is not enough if the connection reached the wrong workload.</p>
"""
            },
            {
                "id": "rotation",
                "kicker": "04 · rotation",
                "title": "Rotate certificate material without restarting the process.",
                "body": """
<p><code>app.workload.rotate(...)</code> can replace already-issued workload certificate material. New inbound connections use the replaced server secure context; outbound service pools rotate their TLS agents and can drain old agents with a grace period.</p>
<p>Rotation is deliberately separate from issuance. OpenMesh consumes certificate material; it does not run a certificate authority or decide how revocation is distributed.</p>
"""
            },
            {
                "id": "boundary",
                "kicker": "05 · boundary",
                "title": "Know what the runtime does not claim.",
                "body": """
<ul>
<li>It does not issue workload certificates.</li>
<li>It does not distribute certificate revocation state.</li>
<li>It does not govern a trust domain for you.</li>
<li>It does not transparently intercept arbitrary process traffic.</li>
<li>It does not replace Kubernetes network policy or a CNI.</li>
</ul>
<p>The model is useful when Node.js applications want explicit service identities and mTLS inside the same runtime that owns service-to-service calls. See the <a href="https://github.com/yaohuangguan/openmesh-node/blob/master/docs/mesh-runtime.md#workload-identity-and-mtls">workload identity reference</a> for the exact supported configuration.</p>
"""
            },
        ],
        "next": [
            ("application-native-service-mesh", "Application-native service mesh", "See where identity fits beside discovery, traffic policy and resilience."),
            ("peer-routing", "Peer routing and resilience", "Understand the service call path that the authenticated transport protects."),
        ],
    },
}


def metadata(title: str, description: str, canonical: str, h1: str, crumbs: list[tuple[str, str]]) -> str:
    items = [
        {
            "@type": "ListItem",
            "position": i + 1,
            "name": name,
            "item": url,
        }
        for i, (name, url) in enumerate(crumbs)
    ]
    structured = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebPage",
                "@id": canonical + "#webpage",
                "url": canonical,
                "name": title,
                "description": description,
                "headline": h1,
                "datePublished": DATE,
                "dateModified": DATE,
                "isPartOf": {"@id": f"{BASE}/#website"},
                "about": {"@id": f"{BASE}/#software"},
                "inLanguage": "en",
                "primaryImageOfPage": {"@type": "ImageObject", "url": OG, "width": 1200, "height": 630},
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": items,
            },
        ],
    }
    structured_json = json.dumps(structured, separators=(",", ":")).replace("<", "\\u003c")
    return f"""    <title>{html.escape(title)}</title>
    <meta name="description" content="{html.escape(description, quote=True)}" />
    <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
    <meta name="theme-color" content="#05070a" />
    <link rel="canonical" href="{canonical}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="OpenMesh for Node.js" />
    <meta property="og:url" content="{canonical}" />
    <meta property="og:title" content="{html.escape(title, quote=True)}" />
    <meta property="og:description" content="{html.escape(description, quote=True)}" />
    <meta property="og:image" content="{OG}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="{html.escape(title, quote=True)}" />
    <meta name="twitter:description" content="{html.escape(description, quote=True)}" />
    <meta name="twitter:image" content="{OG}" />
    <script type="application/ld+json">{structured_json}</script>
    <link rel="stylesheet" href="/src/guide.css" />"""


def chrome() -> tuple[str, str]:
    head = """    <header class="guide-topbar">
      <a class="brand" href="/" aria-label="OpenMesh for Node.js home">
        <span class="brand-glyph" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>OpenMesh</span>
      </a>
      <nav aria-label="Guide navigation"><a href="/docs/">Docs</a><a href="/guides/">Guides</a><a href="https://github.com/yaohuangguan/openmesh-node">GitHub ↗</a></nav>
    </header>"""
    foot = """    <footer class="guide-footer">
      <span>OpenMesh for Node.js · <code>openmesh-node</code> · v0.5.0 · MIT</span>
      <div><a href="/">home</a><a href="/docs/">docs</a><a href="https://www.npmjs.com/package/openmesh-node">npm</a><a href="https://github.com/yaohuangguan/openmesh-node">source</a></div>
    </footer>"""
    return head, foot


def render_page(slug: str, page: dict) -> str:
    canonical = f"{BASE}/guides/{slug}/"
    crumbs = [
        ("OpenMesh for Node.js", f"{BASE}/"),
        ("Guides", f"{BASE}/guides/"),
        (page["eyebrow"], canonical),
    ]
    toc = "\n".join(f'          <a href="#{section["id"]}">{html.escape(section["title"])}</a>' for section in page["sections"])
    sections = "\n".join(
        f"""        <section id="{section['id']}">
          <div class="guide-kicker">{section['kicker']}</div>
          <h2>{section['title']}</h2>
          {section['body'].strip()}
        </section>"""
        for section in page["sections"]
    )
    next_links = "\n".join(
        f"""          <a href="/guides/{next_slug}/"><strong>{html.escape(title)}</strong><span>{html.escape(desc)}</span></a>"""
        for next_slug, title, desc in page["next"]
    )
    top, foot = chrome()
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
{metadata(page['title'], page['description'], canonical, page['h1'], crumbs)}
  </head>
  <body>
{top}
    <main class="guide-shell">
      <header class="guide-hero">
        <div class="breadcrumb"><a href="/">OpenMesh</a><span>/</span><a href="/guides/">Guides</a><span>/</span><span>{html.escape(page['eyebrow'])}</span></div>
        <div class="eyebrow">{html.escape(page['eyebrow'])}</div>
        <h1>{html.escape(page['h1'])}</h1>
        <p>{html.escape(page['intro'])}</p>
        <div class="article-meta"><span>OpenMesh 0.5</span><span>Node.js ≥ 22</span><span>Updated {DATE}</span></div>
      </header>

      <div class="guide-layout">
        <aside class="toc" aria-label="On this page">
          <strong>On this page</strong>
{toc}
        </aside>
        <article class="guide-article">
{sections}
          <section>
            <div class="guide-kicker">Continue</div>
            <h2>Related OpenMesh guides.</h2>
            <div class="next-guides">
{next_links}
            </div>
          </section>
        </article>
      </div>
    </main>
{foot}
  </body>
</html>
"""


for slug, page in PAGES.items():
    target = ROOT / "guides" / slug / "index.html"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render_page(slug, page), encoding="utf-8")


guide_cards = "\n".join(
    f"""        <a class="guide-card" href="/guides/{slug}/">
          <span>{i:02d}</span>
          <h2>{html.escape(page['eyebrow'].title())}</h2>
          <p>{html.escape(page['description'])}</p>
        </a>"""
    for i, (slug, page) in enumerate(PAGES.items(), start=1)
)

index_title = "Node.js Microservices & Service Mesh Guides | OpenMesh"
index_description = "Technical guides to Node.js service runtimes, application-native service mesh design, service discovery, peer routing, resilience and mTLS workload identity."
index_canonical = f"{BASE}/guides/"
crumbs = [("OpenMesh for Node.js", f"{BASE}/"), ("Guides", index_canonical)]
top, foot = chrome()
index_html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
{metadata(index_title, index_description, index_canonical, "Node.js runtime and service mesh guides.", crumbs)}
  </head>
  <body class="guides-index">
{top}
    <main class="guide-shell">
      <header class="guide-hero">
        <div class="breadcrumb"><a href="/">OpenMesh</a><span>/</span><span>Guides</span></div>
        <div class="eyebrow">Technical guides</div>
        <h1>Node.js runtime and service mesh guides.</h1>
        <p>Deep, implementation-focused explanations of the distributed-system problems OpenMesh 0.5 solves inside a TypeScript application runtime.</p>
        <div class="article-meta"><span>OpenMesh 0.5.0</span><span>TypeScript</span><span>Node.js ≥ 22</span></div>
      </header>
      <div class="guide-layout">
        <section class="guide-cards" aria-label="OpenMesh technical guides">
{guide_cards}
        </section>
      </div>
    </main>
{foot}
  </body>
</html>
"""
(ROOT / "guides" / "index.html").write_text(index_html, encoding="utf-8")
