# Advanced HTTP Contracts — 0.5 preview

> **Optional advanced API: routes are values.**

The default OpenMesh 0.5 API is intentionally simpler:

```ts
app.post('/users/:id', {
  body: NewUser,
  response: {
    201: User,
    409: Problem
  }
}, async ({ body, params }) => {
  return created(await users.create({
    id: params.id,
    ...body
  }));
});
```

For most API and CRUD work, start there.

The `openmesh-node/http` functional layer is an **advanced contract API** for teams that want route contracts as first-class immutable values for tooling, client generation, testing, or policy inspection.

It is not the primary learning path and it is not required to use `app.mesh()`.

## The advanced idea

A route contract can be separated from its implementation.

```ts
import {
  POST,
  pipe,
  input,
  returns,
  implement,
  created,
  api
} from 'openmesh-node/http';

const CreateUser = pipe(
  POST('/users'),
  input({
    body: NewUser
  }),
  returns({
    201: User,
    409: Problem
  })
);

const createUser = implement(CreateUser, async ({ body }) => {
  const user = await users.create(body);
  return created(user);
});

app.register(api('/v1', createUser));
```

No controller class is required. No decorators are required. The handler does not mutate a response context to describe success.

The contract is a value. The implementation is a function.

## Types stay local

OpenMesh does not require every route to accumulate into one growing application generic.

Each route contract owns its own type boundary:

```ts
const GetUser = pipe(
  GET('/users/:id'),
  input({
    params: UserParams,
    query: UserQuery
  }),
  returns({
    200: User,
    404: Problem
  })
);
```

The implementation receives only the types produced by that contract:

```ts
const getUser = implement(GetUser, async ({ params, query }) => {
  const user = await users.find(params.id, query.include);

  return user
    ? ok(user)
    : reply(404, { code: 'USER_NOT_FOUND' });
});
```

Returning a status not declared by the contract is a TypeScript error. Returning a body that does not satisfy the declared response type is also a TypeScript error.

Runtime response validation remains active when a response schema is present, so untyped JavaScript and implementation bugs cannot silently bypass the contract.

## Standard Schema, not a schema vendor

`input()` and `returns()` accept Standard Schema v1.

That means the OpenMesh HTTP contract does not need a Zod-specific, Valibot-specific, ArkType-specific, or Joi-specific adapter layer.

Compatible schema libraries can provide both:

- runtime validation / transformation;
- TypeScript input/output inference.

OpenMesh depends on the interface, not the schema library.

## Typed derivation

Business handlers often need more than request input. Authentication, tenancy, feature flags, request-scoped services, and authorization decisions are derived values.

`implement()` can derive those dependencies while keeping the type chain intact:

```ts
const createUser = implement(CreateUser, {
  provide: {
    actor: async ({ headers }) => authenticate(headers),
    tenant: async ({ headers }) => resolveTenant(headers)
  },

  run: async ({ body, actor, tenant }) => {
    const user = await users.create({
      ...body,
      tenantId: tenant.id,
      createdBy: actor.id
    });

    return created(user);
  }
});
```

The return type of each provider becomes part of the input type of `run`.

No `ctx.state as MyState` cast is required.

## Replies are values

The functional API represents HTTP results as values:

```ts
ok(body)                 // 200
created(body)            // 201
accepted(body)           // 202
noContent()              // 204
reply(409, problem)      // any explicit status
```

This makes status codes part of TypeScript's route contract instead of mutable handler state.

## Complete HTTP lifecycle hooks

The low-level runtime exposes explicit request lifecycle hooks:

```ts
app.addHook('onRequest', hook);
app.addHook('preParsing', hook);
app.addHook('preValidation', hook);
app.addHook('preHandler', hook);
app.addHook('postHandler', hook);
app.addHook('preSerialization', hook);
app.addHook('preSend', hook);
app.addHook('onResponse', hook);
app.addHook('onError', hook);
```

Hooks inherit through plugin scopes and can also be attached to an individual route.

The ordering is intentional:

```text
onRequest
  ↓
preParsing
  ↓
middleware / body parsing
  ↓
preValidation
  ↓
schema validation
  ↓
preHandler
  ↓
handler
  ↓
postHandler
  ↓
preSerialization       (semantic body)
  ↓
serialize / set headers
  ↓
preSend                (final string/bytes/stream)
  ↓
write response
  ↓
onResponse

error ────────────────▶ onError
```

Middleware remains the general onion-composition primitive. Hooks exist for code that needs a precise HTTP lifecycle phase.

## Body parsing

Body parsing remains optional and lives under `openmesh-node/plugins`.

For normal APIs:

```ts
import { bodyParser } from 'openmesh-node/plugins';

app.use(bodyParser());
```

The universal parser handles:

- `application/json` and `application/*+json`;
- `application/x-www-form-urlencoded`;
- `multipart/form-data`;
- text payloads;
- raw/binary payloads.

The same parsers can be installed explicitly:

```ts
jsonBody();
formBody();
textBody();
rawBody();
multipartBody();
```

All parsers are bounded by size limits. JSON keeps prototype-key protection. URL-encoded and multipart objects use safe own-property handling.

The 0.5 preview multipart parser is buffered and intended for ordinary API forms. A future streaming multipart plugin should handle large file uploads without changing the base parser contract.

## A CRUD API without controller classes

```ts
const ListUsers = pipe(
  GET('/users'),
  input({ query: ListUsersQuery }),
  returns({ 200: UserList })
);

const GetUser = pipe(
  GET('/users/:id'),
  input({ params: UserParams }),
  returns({ 200: User, 404: Problem })
);

const CreateUser = pipe(
  POST('/users'),
  input({ body: NewUser }),
  returns({ 201: User, 409: Problem })
);

const UpdateUser = pipe(
  PATCH('/users/:id'),
  input({
    params: UserParams,
    body: UpdateUser
  }),
  returns({ 200: User, 404: Problem })
);

const DeleteUser = pipe(
  DELETE('/users/:id'),
  input({ params: UserParams }),
  returns({ 204: null, 404: Problem })
);

const usersApi = api(
  '/v1',
  implement(ListUsers, listUsers),
  implement(GetUser, getUser),
  implement(CreateUser, createUser),
  implement(UpdateUser, updateUser),
  implement(DeleteUser, deleteUser)
);

app.register(usersApi);
```

The route values are still available on `usersApi.routes`. This is intentional: later tooling can consume the contracts without asking TypeScript to infer a giant application type.

## Where this leads

The same contract values can become the source for:

- OpenAPI generation;
- typed clients without whole-app generic accumulation;
- test clients;
- mocks;
- API inventory;
- policy inspection;
- client/server compatibility checks.

The runtime then adds the distributed layer when the application grows:

- service registration and discovery;
- ServicePool isolation;
- backpressure and adaptive concurrency;
- deadlines, retries, and circuits;
- live configuration;
- durable Redis control-plane state;
- streaming;
- observability.

That is the larger OpenMesh story:

> **From CRUD to distributed, without changing the programming model.**

## Preview status

The functional HTTP API is being developed for OpenMesh 0.5 and is not part of the published 0.4.0 API.

The preview currently includes:

- immutable route contracts;
- Standard Schema input/output inference;
- compile-time response status/body checking;
- runtime input/output validation;
- typed provider derivation;
- functional reply values;
- local route tuple preservation through `api()`;
- complete low-level HTTP lifecycle hooks;
- JSON, text, raw, URL-encoded, multipart, and universal body parsers.

The syntax may still change before 0.5.0.
