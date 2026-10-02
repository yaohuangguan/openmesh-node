# Plugins and ecosystem bridges

Native OpenMesh plugins have independent scopes. Express middleware receives raw Node requests/responses; Fastify plugins run inside a real Fastify instance.

## Native plugins

```js
import { definePlugin } from 'openmesh-node';

const users = definePlugin(async (app, options) => {
  app.decorate('repository', options.repository);
  app.use(async (ctx, next) => { ctx.state.area = 'users'; await next(); });
  app.get('/:id', ctx => app.repository.find(ctx.params.id));
  app.onClose(() => app.repository.close());
}, { name: 'users' });

app.register(users, { prefix: '/users', repository });
```

The child scope inherits parent middleware and decorations. Its own middleware and decorations do not escape into siblings. Prefixes compose for nested registrations. Routes and middleware compile after every startup plugin completes, so parent middleware added late is still applied.

Plugins may return a Promise or use `(app, options, done)`. Do not mix these completion styles or call `ready()` from inside a plugin. Startup runs sequentially, follows nested scopes, and times out after `pluginTimeout`. On boot failure, previously registered cleanup hooks run in reverse order.

`definePlugin(fn, { name, dependencies, global: true })` runs a plugin in its parent's scope. Global plugins cannot add a route prefix. Named dependencies must be visible in the current scope; a named encapsulated sibling is not visible. Decoration names may not replace framework members. TypeScript applications can extend the `OpenMesh` interface for their own decorations.

## Express middleware

```sh
npm install cors helmet express
```

```js
import cors from 'cors';
import helmet from 'helmet';
import express from 'express';

app.useExpress(cors({ origin: 'https://example.com' }));
app.useExpress(helmet());

const legacy = express();
legacy.use(express.json());
legacy.post('/echo', (req, res) => res.json(req.body));
legacy.use((error, req, res, next) => res.status(400).json({ error: 'Bad input' }));
app.mount('/legacy', legacy);
```

`useExpress` supports normal `(req, res, next)` middleware, including middleware that completes the response. Express-specific request/response conveniences require a mounted real Express app. Mounting removes the literal mount prefix from `req.url` and preserves `req.originalUrl`. Errors inside a mounted Express app retain its own error-middleware behavior; an unhandled `next(error)` reaches OpenMesh.

Native routes win over mounts; the most-specific mount wins over less-specific mounts. An unmatched mounted application returns its own 404 or an OpenMesh 404 when it falls through. A mount does not automatically continue to another mount.

## Fastify plugins

```sh
npm install fastify@5 @fastify/cors @fastify/helmet
```

```js
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';

app.fastify('/api', async host => {
  await host.register(fastifyCors, { origin: 'https://example.com' });
  await host.register(fastifyHelmet);
  host.get('/users/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }
  }, async request => ({ id: request.params.id }));
}, { server: { logger: false }, plugin: {} });
```

The bridge installs no replacement Fastify API. It creates a real Fastify instance, registers the plugin, awaits `ready()`, and delegates requests using the documented [`fastify.routing(req, res)`](https://fastify.dev/docs/latest/Reference/Server/#routing) entry point. Closing OpenMesh closes that host and its hooks. Fastify remains an optional peer dependency, loaded only when a bridge is configured.

Host decorators, hooks, schemas and plugin metadata belong to that Fastify instance. Native OpenMesh decorations are not automatically copied. A plugin that requires a particular Fastify version or external service keeps those requirements. Configurations relying on ownership of the listening socket, raw upgrades/WebSocket servers, or proxy mount metadata need dedicated integration; broad compatibility with every ecosystem plugin is not claimed.

The tests use real `cors`, `helmet`, Express Router/JSON/error middleware, `@fastify/cors`, `@fastify/helmet`, schema validation and Fastify close hooks. Run `npm run example:ecosystem` for working routes.

References: [Express middleware](https://expressjs.com/en/guide/using-middleware.html), [Fastify plugins](https://fastify.dev/docs/latest/Reference/Plugins/), [Koa onion middleware](https://koajs.com/).
