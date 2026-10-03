# Databases and ORMs

OpenMesh 0.5 treats databases as application resources with lifecycle, readiness and optional transaction adapters. See [OpenMesh 0.5 architecture](architecture-0.5.md) for the wider runtime model.

OpenMesh does not ship an ORM and does not wrap database query APIs.

The database integration is deliberately small:

- keep the original ORM/client type;
- start it with the application when needed;
- close it during graceful shutdown;
- expose an optional readiness probe;
- expose an optional typed transaction boundary.

This keeps Prisma, Drizzle, Kysely, TypeORM, MikroORM, Sequelize, Knex, node-postgres and driver-specific clients usable without an OpenMesh-specific query language.

## Basic resource

```ts
import openmesh from 'openmesh-node';
import { database } from 'openmesh-node/db';

const client = createYourDatabaseClient();

const db = database(client, {
  name: 'primary',

  connect: client => client.connect(),
  disconnect: client => client.close(),

  ping: async client => {
    await client.ping();
  }
});

const app = openmesh()
  .register(db)
  .get('/users', async () => {
    return db.client.users.findMany();
  });
```

The client is not proxied. `db.client` is the exact object passed to `database()`, so its original TypeScript API is preserved.

## Connectionless/lazy clients

Some libraries initialize lazily or are created around an already-managed driver/pool. They do not need a startup hook:

```ts
const db = database(drizzleDb, {
  name: 'primary'
});

app.register(db);
```

A shutdown hook can still be supplied when the underlying client owns resources:

```ts
const db = database(kysely, {
  disconnect: db => db.destroy()
});
```

## Readiness

`healthy()` returns false while the resource is not ready and converts ping failures into a false readiness result rather than throwing through a health endpoint.

```ts
import { health } from 'openmesh-node/plugins';

app.register(db);

app.register(health({
  ready: () => db.healthy()
}));
```

When no `ping` function is configured, a started resource is considered healthy.

## Transactions

Transaction APIs differ between ORMs, so OpenMesh does not guess them.

Provide one adapter and keep the transaction client type:

```ts
const db = database(prisma, {
  transaction: (client, work) =>
    client.$transaction(work)
});

await db.transaction(async tx => {
  const user = await tx.user.create({
    data: { name: 'Sam' }
  });

  await tx.profile.create({
    data: { userId: user.id }
  });

  return user;
});
```

If no transaction adapter is configured, `db.transaction()` fails explicitly instead of pretending the work is transactional.

## Prisma

Prisma Client supports explicit `$connect()`, `$disconnect()`, and interactive `$transaction()`.

```ts
const db = database(prisma, {
  name: 'primary',

  connect: client => client.$connect(),
  disconnect: client => client.$disconnect(),

  transaction: (client, work) =>
    client.$transaction(work)
});
```

Prisma also connects lazily, so `connect` can be omitted when that behavior is preferred.

## Drizzle

Drizzle keeps its own database API. OpenMesh only supplies lifecycle around the object you already created.

```ts
const db = database(drizzleDb, {
  transaction: (client, work) =>
    client.transaction(work)
});

app.get('/users', async () => {
  return db.client.query.users.findMany();
});
```

Driver/pool cleanup belongs in `disconnect` when the Drizzle setup owns a closable pool.

## Kysely

Kysely exposes `destroy()` for shutdown and `transaction().execute(...)` for transactions.

```ts
const db = database(kysely, {
  disconnect: client => client.destroy(),

  transaction: (client, work) =>
    client.transaction().execute(work)
});
```

## TypeORM

A TypeORM `DataSource` initializes and destroys its connection pool explicitly. Its transaction callback receives a transactional `EntityManager`.

```ts
const db = database(dataSource, {
  connect: source => source.initialize(),
  disconnect: source => source.destroy(),

  transaction: (source, work) =>
    source.transaction(work)
});
```

## MikroORM

MikroORM can be created before registration and closed with `orm.close()`. Explicit transaction work normally runs through an EntityManager.

```ts
const db = database(orm, {
  disconnect: orm => orm.close(),

  transaction: (_orm, work) =>
    orm.em.transactional(work)
});
```

For applications using MikroORM's request-scoped identity map, keep using MikroORM's request-context/fork mechanism. OpenMesh does not replace ORM-specific unit-of-work semantics.

## Sequelize

Sequelize can verify the pool with `authenticate()` and closes it with `close()`.

```ts
const db = database(sequelize, {
  connect: client => client.authenticate(),
  disconnect: client => client.close(),

  transaction: (client, work) =>
    client.transaction(transaction => work(transaction))
});
```

## Multiple databases

Resources are named, so a service can own several independent clients:

```ts
const primary = database(primaryDb, {
  name: 'primary',
  disconnect: db => db.destroy()
});

const analytics = database(analyticsDb, {
  name: 'analytics',
  disconnect: db => db.destroy()
});

app
  .register(primary)
  .register(analytics);
```

Duplicate resource names fail application startup rather than silently replacing a connection.

## Failure semantics

Database resources follow application lifecycle rather than request lifecycle.

- A configured `connect` runs during OpenMesh boot.
- A failed connect fails startup.
- Cleanup is still attempted after a partial startup failure.
- `disconnect` runs during graceful close and only once.
- A database is never connected/disconnected per request.
- `healthy()` is false before startup, while closing, after close, or when `ping` fails.
- Transactions are opt-in because different ORMs expose materially different transaction clients.

This is intentionally an integration boundary, not a persistence abstraction.
