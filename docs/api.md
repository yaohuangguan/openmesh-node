# Native API

The core uses Node built-ins. Configure routes and plugins before startup; `ready()` boots plugins and `listen()` binds the HTTP listener.

## Application

```js
import openmesh, { definePlugin, HttpError } from 'openmesh-node';
const app = openmesh({
  pluginTimeout: 10000,
  shutdownTimeout: 5000,
  serverLimits: {
    requestTimeout: 120000,
    headersTimeout: 10000,
    keepAliveTimeout: 5000,
    maxHeadersCount: 100
  },
  onEvent(event) {
    telemetryQueue.push(event);
  }
});
```

| API | Behavior |
| --- | --- |
| `get/head/post/put/patch/delete/options/trace(path, [options], handler)` | Register one HTTP method |
| `all(path, [options], handler)` | Register a wildcard method |
| `route(method, path, [options], handler)` | Custom uppercase method |
| `use(async (ctx, next) => …)` | Scoped onion middleware |
| `register(plugin, { prefix, …options })` | Scoped startup plugin |
| `setValidatorCompiler(fn)` | Scoped route-schema validator compiler |
| `setSerializerCompiler(fn)` | Scoped response-schema serializer compiler |
| `decorate(name, value)` | Add a property visible to the scope and descendants |
| `hasPlugin(name)` | Check named plugins visible in this scope |
| `onListen((app, address) => …)` | Await startup work after binding; failure closes the listener |
| `onShutdown(fn)` | Pre-drain cleanup for long-lived resources |
| `onClose(fn)` | Final cleanup hook; reverse registration order |
| `setErrorHandler((error, ctx) => …)` | Scoped error handler |
| `setNotFoundHandler(ctx => …)` | Scoped/prefixed 404 handler |
| `ready()` | Boot once; return a Promise |
| `callback()` | Return the native Node request listener |
| `listen({ port, host, … })` | Boot and bind; default loopback, ephemeral port |
| `close({ timeout })` | Stop accepts, drain requests, then destroy stalled sockets and run hooks |

`app.server` exposes the owned Node HTTP server after `listen()`. `callback()` is usable with an externally owned server after `await app.ready()`; the external owner must close that server itself. Configuration freezes when boot completes. The `server` factory option supplies Node `http.createServer()` options; listen options are passed to `server.listen()`. OpenMesh also applies explicit `serverLimits` defaults: 120 s request timeout, 10 s headers timeout, 5 s keep-alive timeout and 100 request headers. Override them when a workload has different requirements.

`onEvent` is an optional zero-dependency observability hook. It receives request start/finish/error and server listening/closing/closed events. Request finish timing follows the real Node response `finish` / `close` lifecycle, so streamed responses are measured until bytes actually complete. Observer exceptions are isolated from request processing; enqueue telemetry work instead of doing blocking I/O in the callback. With no observer configured, OpenMesh skips per-request timing and response lifecycle listeners so the default request path does not pay observability overhead.

Routes are case-sensitive and trailing slashes are significant. Static routes take precedence over parameters, then wildcards. Parameter values decode when accessed. A terminal wildcard, `/files/*`, captures the remainder in `ctx.params['*']`. Regex routes and optional parameters are not supported. Duplicate method/path registrations fail at configuration time.

HEAD falls back to GET with its body suppressed. A matching path with another method returns 405 and `Allow`; unmatched paths return 404. Native routes take precedence over mounted engines. Mounts use the longest matching literal prefix.


## Route schemas

OpenMesh 0.3 exposes compiler contracts without bundling a schema library. A scope can provide validator and serializer compilers, then routes can declare body/query/params/header and response schemas.

```js
app.setValidatorCompiler(({ schema, httpPart }) => {
  // Example only: plug in Ajv, TypeBox, Zod adapters, or another compiler here.
  return value => validateWithYourLibrary(schema, value, httpPart);
});
app.setSerializerCompiler(({ schema, httpStatus }) => {
  return value => serializeWithYourLibrary(schema, value, httpStatus);
});

app.post('/users', {
  schema: {
    body: userInputSchema,
    response: { '2xx': publicUserSchema }
  }
}, ctx => createUser(ctx.requestBody));
```

Validators may be synchronous or asynchronous and return `true`/`false` (or an object containing `error`). Failed validation returns HTTP 400 with code `VALIDATION_ERROR`. Response serializers are synchronous. Exact statuses, class patterns such as `2xx`, and `default` are supported. Route schemas require the matching compiler; startup fails rather than silently ignoring a schema.

The compiler is inherited by child plugin scopes and can be overridden inside a scope. Routes without schemas keep the direct handler path.

## Context

| Member | Meaning |
| --- | --- |
| `req`, `res` / `request`, `response` | Raw Node request and response |
| `app`, `path`, `method`, `url`, `headers` | Scope and request metadata |
| `params` | Lazily decoded route parameters |
| `query` | Lazy query map; duplicate keys become arrays |
| `state` | Request-local mutable state |
| `requestBody` | `req.body` populated by a parser |
| `status` | HTTP response status, initially 200 |
| `body` | Response value |
| `get(name)` / `set(name, value)` | Request / response headers |
| `set({ name: value })` | Multiple response headers |
| `send(value)` / `json(value)` | Set response body and return context |
| `redirect(location, status = 302)` | Set redirect response |
| `throw(status, message)` | Throw an `HttpError` |

Return an object for JSON, a string for text, a Buffer/Uint8Array for bytes, or a Node readable stream. Set `ctx.body` explicitly to override a handler's return value. An undefined response produces 204. Status 204/304 and HEAD suppress response bodies.

```js
app.use(async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.set('server-timing', `app;dur=${(performance.now() - start).toFixed(1)}`);
});
app.get('/users/:id', {
  middleware: async (ctx, next) => { ctx.state.user = ctx.params.id; await next(); },
  serializer: value => JSON.stringify(value)
}, ctx => ({ id: ctx.state.user }));
```

Middleware must await or return `next()`; invoking it twice raises an error. Native response serialization happens after middleware completes. A bridge can finish the raw response before onion middleware unwinds, so headers for bridged responses should be set before `await next()`.

Without a custom handler, 4xx `HttpError` messages are exposed and 5xx responses use `Internal Server Error`. After headers are sent, errors destroy the response. Stream failures destroy the connection; an already-sent body cannot be replaced with JSON. Low-level handlers that call `res.write()` are responsible for finishing their response.

## Built-in plugins

```js
import { jsonBody, requestContext, health } from 'openmesh-node/plugins';
app.use(jsonBody({ limit: 1024 * 1024, prototypeAction: 'error' }));
app.use(requestContext({ service: 'users', requestIdHeader: 'x-request-id' }));
app.register(health({ ready: async () => database.isConnected() }));
```

`jsonBody` parses JSON/+json POST, PUT, PATCH and DELETE requests. Invalid JSON returns 400; over-limit bodies return 413. By default it rejects `__proto__` and `constructor` keys to reduce prototype-pollution hazards in downstream code. Set `prototypeAction: 'remove'` to strip those keys or `'ignore'` only when the application intentionally accepts them. It does not parse forms, multipart uploads, compressed payloads, or validate application schemas.

`requestContext` validates or generates a request ID, carries a valid version-00 trace ID forward, and generates a new span ID. It sets response headers and `ctx.state.outboundHeaders` for explicit propagation.

The same request state is also stored with Node `AsyncLocalStorage`, so deep async code can call `currentRequestContext()` without receiving `ctx` as an argument. The store is request-scoped and returns `null` outside a request. This remains the context propagation boundary. OpenMesh 0.4 adds exporter-neutral lifecycle events but still does not create/export OpenTelemetry spans itself or carry `tracestate`/baggage.

`health` registers `/health/live` and `/health/ready`; readiness returns 200 or 503 from the supplied callback. It describes the application's readiness policy, rather than actively probing all peers.
