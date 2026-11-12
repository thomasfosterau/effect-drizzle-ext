# How it fits together

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

`drizzle-orm/effect-postgres` already ships the Effect-native Drizzle driver for Postgres; this package binds it to `@thomasfosterau/effect-drizzle-ext`'s driver-agnostic `makeDatabaseServices` so an application writes the wiring once. `makePgDatabase({ relations, key })` returns:

- **`Database`** / **`CurrentTransaction`** — the two `Context.Service` keys, typed over the caller's own `relations` graph.
- **`transact`** — the write boundary: always-open, never join-if-present (see below).
- **`readHandle`** — the read resolver: the ambient `CurrentTransaction` when one is open, `Database` otherwise.
- **`make`** — the `Effect` that builds the Drizzle client (`drizzle-orm/effect-postgres`'s `make` plus its `DefaultServices`) over an ambient `PgClient`.
- **`layer`** — `make` installed under the `Database` key, requiring only `PgClient`.

Call it once, at module scope, and export what it returns:

```ts
const database = makePgDatabase({ relations, key: "Database" });
export const { Database, CurrentTransaction, transact, readHandle } = database;
export type Database = typeof database.Database.Identifier; // "Database"
```

`Database`/`CurrentTransaction`/`transact`/`readHandle` are otherwise identical to the driver-agnostic surface documented in [the core package's `./database`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/database.md) — this package adds nothing to their semantics, only the driver behind them.

Both `make` and `layer` carry `PgClient` in their requirement channel and nothing else: **where the pool comes from is the consuming application's decision**, made by providing one of:

- **`pgClientFromUrl`** — `@effect/sql-pg`'s `PgClient.make` plus one `SELECT 1`. **Pings the database at layer build**, failing the build loudly with a `SqlError` if the ping doesn't answer within `connectTimeout`. Right for a long-lived process: a misconfigured URL fails once, at startup, instead of on the first query.
- **`pgClientFromPool`** — `@effect/sql-pg`'s own `PgClient.layer`, whose pool opens connections on first use. **Never connects at layer build**; the pool is shut down with the layer's own scope, so a runtime built per request disposes of its pool with that request, and a connection failure surfaces on the first query instead. Use this wherever a runtime is built per request or per event — `pgClientFromUrl` there would open a connection on every build, including ones that never touch the database. A pool built this way **must never outlive the scope that created it**.
- a client layer of the caller's own (any `Layer<PgClient>`).

```ts
export const pgClientFromUrl: (config: {
  readonly url: Redacted.Redacted<string>;
  readonly maxConnections?: number | undefined;
  readonly connectTimeout?: Duration.Input | undefined;
  readonly types?: PgTypes.Registry | undefined;
  readonly prepare?: boolean | undefined;
}) => Layer.Layer<PgClient.PgClient | SqlClient, SqlError>;

export const pgClientFromPool: (options: {
  readonly connectionString: Redacted.Redacted<string>;
  readonly maxConnections?: number | undefined;
  readonly connectTimeout?: Duration.Input | undefined;
  readonly types?: PgTypes.Registry | undefined;
  readonly prepare?: boolean | undefined;
}) => Layer.Layer<PgClient.PgClient | SqlClient, SqlError>;
```

Both output `PgClient | SqlClient` — that is what `@effect/sql-pg`'s own `PgClient.layer` / `PgClient.layerFrom` provide, and `Layer`'s output is covariant, so either satisfies a `PgClient`-only requirement (`testDatabaseLayer` below is built from one).

### Binary codecs and Drizzle (read this before upgrading the driver)

`@effect/sql-pg` rc.113 and later talks to PostgreSQL in the **binary** protocol only, and decodes each column by OID. Drizzle's `effect-postgres` driver was written for the text protocol, so under the `1.0.0-rc.5-ab785fc` commit build some column types broke or were silently corrupted: user enums and enum arrays, `vector`, `interval`, `tsvector`, `time`, `macaddr`, and `bigint({ mode: "string" })` (the driver handed back a JS `bigint` where Drizzle's type says `string`). The measured table and a tested codec shim are in [website#2027](https://github.com/thomasfosterau/website/issues/2027). The published `drizzle-orm@1.0.0-rc.5`, which this package is built against, reads most of them itself: it selects enums and their arrays, `vector`, `interval`, `tsvector` and `regconfig` as `::text`, and returns a string-mode `bigint` as a string.

For a column type it still doesn't cover, use a per-client codec registry. Both helpers forward two optional `@effect/sql-pg` options for it:

- `types` — a `PgTypes.Registry` (`PgTypes.makeRegistry()` plus `register(oid, codec, { arrayOid })` calls), for example an `int8` codec that returns a decimal string.
- `prepare` — `false` to use unnamed statements. Set it behind a pooler that cannot keep named prepared statements across queries, such as Cloudflare Hyperdrive.

```ts
const types = PgTypes.makeRegistry();
types.register(20, int8StringCodec, { arrayOid: 1016 });
const client = pgClientFromUrl({ url, types, prepare: false });
```

`tests/integration/round-trip.test.ts` pins an enum, a string-mode `bigint` and a `timestamptz` through Drizzle against a live server, with and without the registry, and checks both read back the same row. This package ships no codecs of its own: which types need one depends on the application's schema.

Deployment topology stays with the consuming application: resolving a connection string from a platform binding (a Cloudflare Hyperdrive binding, an environment variable), degrading a failed binding to a proxy client, and any wrapper around the concrete client are all things only the application knows about. This package has no Hyperdrive binding and no Cloudflare/Alchemy integration.

## Limitations

- **No Hyperdrive / Cloudflare layer.** Resolving a connection string from a platform binding, and degrading a failed binding to a proxy client, are deployment-topology decisions that stay in the consuming application.
- **No migrator for a live database.** `./migrations` applies everything to a database that is always brand new; it keeps no ledger, so it is not a deploy-time migrator.
- **Single driver.** This package binds `@effect/sql-pg` only; a different Postgres driver, or a different database entirely, needs its own binding package built the same way against the core package's `makeDatabaseServices`.

## Walk-through

```ts
import { makePgDatabase, pgClientFromPool } from "@thomasfosterau/effect-drizzle-ext-pg";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { relations } from "./relations.ts"; // this application's drizzle relations graph

const database = makePgDatabase({ relations, key: "Database" });
export const { Database, CurrentTransaction, transact, readHandle } = database;

// Wire the client: a pool that lives and dies with the runtime that built it.
const DatabaseLive = database.layer.pipe(
  Layer.provide(pgClientFromPool({ connectionString: Redacted.make(process.env.DATABASE_URL!) })),
);
```

An operation opens its own write boundary with `transact`, yielding `CurrentTransaction` for every statement inside it:

```ts
const createWidget = (name: string) =>
  transact(
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction;
      return yield* tx.insert(widgets).values({ name }).returning();
    }),
  );
```

A read prefers whichever transaction is already open, so a helper called from inside a handler's `transact` sees its uncommitted writes without being told about the transaction at all:

```ts
const findWidget = (name: string) =>
  Effect.gen(function* () {
    const handle = yield* readHandle;
    return yield* handle.select().from(widgets).where(eq(widgets.name, name));
  });
```

A handler wires the two together — a request path that reads what it just wrote, in one boundary:

```ts
const program = transact(
  Effect.gen(function* () {
    yield* createWidget("cog");
    return yield* findWidget("cog"); // sees the insert above; nothing has committed yet
  }),
);
```

**`transact` is always-open, never join-if-present.** Calling it while a transaction is already open deliberately opens a _nested_ one — a SAVEPOINT on the same connection (`tx.transaction(...)`, not `db.transaction(...)`), never a silent join of the ambient one. A join-if-present variant is easy to write and is the wrong call: it would delete every SAVEPOINT the calling code currently takes, changing rollback granularity without changing a line of that code. To reuse the open transaction instead of nesting, yield `CurrentTransaction` directly and don't call `transact` again. This is adjudicated (website #1883), not something to "improve" into join-if-present.

Reads prefer the ambient transaction for the same reason nesting is deliberate: a read issued against `Database` from inside an open transaction takes its own pooled connection and is not guaranteed to see that transaction's uncommitted writes, so `readHandle` joins the open `CurrentTransaction` whenever there is one and falls back to `Database` — the client — only when there isn't.
