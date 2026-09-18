# `@thomasfosterau/effect-drizzle-ext-pg`

The `@effect/sql-pg` binding of the Effect ↔ Drizzle bridge: one `makePgDatabase` call gives an application its `Database` / `CurrentTransaction` services, the `transact` write boundary and the `readHandle` resolver, all wired to `drizzle-orm/effect-postgres` over a real Postgres connection — plus the `PgClient` layer choice and a sentinel-rollback test transaction runner.

[![CI](https://github.com/thomasfosterau/effect-drizzle-ext/actions/workflows/ci.yml/badge.svg)](https://github.com/thomasfosterau/effect-drizzle-ext/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-drizzle-ext-pg.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-drizzle-ext-pg) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Installation

```bash
npm install @thomasfosterau/effect-drizzle-ext-pg @thomasfosterau/effect-drizzle-ext effect drizzle-orm @effect/sql-pg pg
```

`effect` (`>=4.0.0-rc.112`), `drizzle-orm` (`>=1.0.0-rc.5`), `@effect/sql-pg` (`>=4.0.0-rc.112`) and `pg` (`>=8`) are peer dependencies, built against `effect@4.0.0-rc.112`, `drizzle-orm@1.0.0-rc.5-ab785fc`, `@effect/sql-pg@4.0.0-rc.112` and `pg@^8.20.0`. `@thomasfosterau/effect-drizzle-ext` is a regular dependency, not a peer — it supplies the driver-agnostic `makeDatabaseServices` factory this package specialises. Node.js 22 or newer is required.

## Overview

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

`Database`/`CurrentTransaction`/`transact`/`readHandle` are otherwise identical to the driver-agnostic surface documented in [the core package's `./database`](../core/README.md#database) — this package adds nothing to their semantics, only the driver behind them.

Both `make` and `layer` carry `PgClient` in their requirement channel and nothing else: **where the pool comes from is the consuming application's decision**, made by providing one of:

- **`pgClientFromUrl`** — `@effect/sql-pg`'s own `PgClient.layer`. **Pings the database (`SELECT 1`) at layer build**, failing the build loudly with a `SqlError` if the ping doesn't answer within `connectTimeout`. Right for a long-lived process: a misconfigured URL fails once, at startup, instead of on the first query.
- **`pgClientFromPool`** — a bare `pg.Pool` via `PgClient.fromPool`. **Never connects at layer build**; the pool is acquired and released with the layer's own scope, so a runtime built per request disposes of its pool with that request, and a connection failure surfaces on the first query instead. Use this wherever a runtime is built per request or per event — `pgClientFromUrl` there would open a connection on every build, including ones that never touch the database. A pool built this way **must never outlive the scope that created it**.
- a client layer of the caller's own (any `Layer<PgClient>`).

```ts
export const pgClientFromUrl: (config: {
  readonly url: Redacted.Redacted<string>;
  readonly maxConnections?: number | undefined;
  readonly connectTimeout?: Duration.Input | undefined;
}) => Layer.Layer<PgClient.PgClient | SqlClient, SqlError>;

export const pgClientFromPool: (options: {
  readonly connectionString: Redacted.Redacted<string>;
  readonly endTimeout?: Duration.Input | undefined;
}) => Layer.Layer<PgClient.PgClient | SqlClient, SqlError>;
```

Both output `PgClient | SqlClient` — that is what `@effect/sql-pg`'s own `PgClient.layer` / `PgClient.layerFrom` provide, and `Layer`'s output is covariant, so either satisfies a `PgClient`-only requirement (`testDatabaseLayer` below is built from one). `pgClientFromPool`'s `endTimeout` (default 1 second) bounds how long `pool.end()` waits on scope close — a pool that will not drain must not wedge a request's teardown.

Deployment topology stays with the consuming application: resolving a connection string from a platform binding (a Cloudflare Hyperdrive binding, an environment variable), degrading a failed binding to a proxy client, and any wrapper around the concrete client are all things only the application knows about. This package has no Hyperdrive binding and no Cloudflare/Alchemy integration.

## Quick start

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
const findWidget = (id: string) =>
  Effect.gen(function* () {
    const handle = yield* readHandle;
    return yield* handle.select().from(widgets).where(eq(widgets.id, id));
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

## `./testing`

An always-rollback test transaction runner: every spec runs inside a real database transaction that is rolled back once it completes, so a suite needs no truncation, no fixture reset and no ordering discipline. The library owns no schema, so a spec creates whatever `TEMPORARY` tables it needs inside that transaction — DDL is transactional in PostgreSQL, so the always-rollback disposes of them with everything else.

```ts
export const isRetryableConnectFailure: (error: unknown) => boolean;

export interface TestTransaction<Key extends string> {
  readonly runInTestTransaction: <R, A, E>(
    runtime: ManagedRuntime.ManagedRuntime<R, SqlError>,
    effect: Effect.Effect<A, E, R | `${Key}/CurrentTransaction`>,
  ) => Promise<A>;
  readonly withTestTransaction: <R>(
    runtime: ManagedRuntime.ManagedRuntime<R, SqlError>,
  ) => <A, E>(effect: Effect.Effect<A, E, R | `${Key}/CurrentTransaction`>) => Promise<A>;
  readonly attemptInSavepoint: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Exit.Exit<A, E | SqlError>, never, R | `${Key}/CurrentTransaction`>;
}

export const makeTestTransaction: <Relations extends AnyRelations, Key extends string>(
  database: PgDatabase<Relations, Key>,
) => TestTransaction<Key>;

export const testDatabaseLayer: <Relations extends AnyRelations, Key extends string>(
  database: PgDatabase<Relations, Key>,
  options: {
    readonly url: Redacted.Redacted<string>;
    readonly connectTimeout?: Duration.Input | undefined;
  },
) => Layer.Layer<Key, SqlError>;
```

`testDatabaseLayer(database, { url })` is the suite's `Database` layer: the application's own `database.layer` over a `PgClient` built from `url`, with `maxConnections` **pinned to 1**. That pin is load-bearing, not a default to override: a fork runs its tests strictly sequentially and the runner holds exactly one transaction-bound connection at a time, so 1 is the real per-fork demand — and it's what forces an operation-opened `transact` to nest as a SAVEPOINT on that same connection (and so see the outer test transaction's uncommitted writes) rather than silently acquiring a second connection that cannot. Unlike production, `testDatabaseLayer` uses the pinging `pgClientFromUrl` on purpose: a suite that cannot reach its database should fail once at layer build with one legible `SqlError`, not once per spec on the first query.

`makeTestTransaction(database)` builds the runner for one application's `PgDatabase`. A full spec:

```ts
import { pgTable, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { database } from "./database.ts"; // this application's makePgDatabase() result
import {
  makeTestTransaction,
  testDatabaseLayer,
} from "@thomasfosterau/effect-drizzle-ext-pg/testing";

const url = Redacted.make(process.env.DATABASE_URL_TEST!);
const runtime = ManagedRuntime.make(testDatabaseLayer(database, { url }));
const { runInTestTransaction } = makeTestTransaction(database);

const { Database, CurrentTransaction, transact } = database;

describe("widgets", () => {
  it("creates a widget", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.execute(sql`CREATE TEMPORARY TABLE widget (id integer PRIMARY KEY)`);
        yield* transact(
          Effect.flatMap(CurrentTransaction, (tx) =>
            tx.execute(sql`INSERT INTO widget (id) VALUES (1)`),
          ),
        );
        // …assert against it here…
      }),
    );
  });

  it("sees nothing from the spec above", async () => {
    await runInTestTransaction(
      runtime,
      // `widget` doesn't exist here: the previous spec's transaction, table included, rolled back.
      Effect.void,
    );
  });
});
```

`withTestTransaction(runtime)` is `runInTestTransaction` with the runtime bound once — the form a suite exports as its own helper. Both wrap the spec's effect in the application's own `transact`, so the spec opens its write boundary exactly as a request handler does in production; binding `CurrentTransaction` straight from the harness instead would make specs the one place in the system where a write runs without anything having called `transact`.

**A constraint-rejection assertion needs `attemptInSavepoint`, not a bare `Effect.exit`.** A statement that raises aborts the _whole_ PostgreSQL transaction, so `Effect.exit(tx.insert(...))` alone captures the expected failure but then poisons every later statement in the test with `current transaction is aborted, commands ignored until end of transaction block` — surfacing several assertions away from the real cause, on whatever query runs next. `attemptInSavepoint` nests the attempt in a SAVEPOINT on the same pinned connection, so the driver rolls back to it on failure and the enclosing transaction — and every fixture the test already wrote — carries on:

```ts
it("rejects a duplicate slug without poisoning the rest of the test", async () => {
  await runInTestTransaction(
    runtime,
    Effect.gen(function* () {
      yield* transact(insertWidget({ slug: "cog" }));

      const rejected = yield* attemptInSavepoint(transact(insertWidget({ slug: "cog" })));
      expect(rejected._tag).toBe("Failure");

      // Without the savepoint, this next statement would fail with
      // "current transaction is aborted" instead of running.
      yield* transact(insertWidget({ slug: "sprocket" }));
    }),
  );
});
```

`isRetryableConnectFailure` decides what the runner retries: a `SqlError` that failed at the connect/acquire seam (`operation` of `"connect"` / `"acquireConnection"`), whether or not the driver itself flagged it retryable — this catches a pool-acquisition timeout or an `ECONNRESET` under fork-startup contention, neither of which carries the SQLSTATE `@effect/sql-pg` requires to flag `isRetryable`. It never retries a failure raised by the test's own query (constraint violations, syntax errors), and never retries once the test body has run — only the _open_ of the outer transaction is retried, never test logic.

Failures surface through `Cause.squash`, so the underlying error — not an opaque `Cause` — reaches the rejected `Promise`, and `.rejects.toThrow(/…/)` matches it directly:

```ts
await expect(runInTestTransaction(runtime, Effect.fail(new Error("boom")))).rejects.toThrow(/boom/);
```

## Errors against a live database

`classifyError` from [`@thomasfosterau/effect-drizzle-ext/errors`](../core/README.md#errors) recovers a tagged, fact-carrying error from the drizzle / `@effect/sql-pg` error graph a real query raises — `constraint`, `table` and `column` are populated the same way against this driver as they are documented in the core package. `catchUniqueViolation` is the combinator most operations reach for, typically wrapping a `transact`ed write:

```ts
import { catchUniqueViolation } from "@thomasfosterau/effect-drizzle-ext/errors";

const createWidget = (slug: string) =>
  transact(
    Effect.flatMap(CurrentTransaction, (tx) => tx.insert(widgets).values({ slug }).returning()),
  ).pipe(
    catchUniqueViolation((violation) =>
      violation.constraint._tag === "Some" && violation.constraint.value === "widget_slug_key"
        ? Effect.fail(new SlugTaken({ slug }))
        : Effect.die(violation),
    ),
  );
```

`violation.constraint` / `.table` / `.column` / `.detail` are `Option`s, populated per-SQLSTATE as documented in the core README; for a violation raised against a `TEMPORARY` table, `schema` is the session's temporary schema (`pg_temp_N`), not `public`.

## Limitations

- **No provisioning.** This package ships only the transaction-rollback test harness (`./testing`), not a way to stand up a test database. `packages/pg/tests/integration/local-database.ts` in this repository is the recipe it uses internally — resolve a reachable local PostgreSQL server first, falling back to a Testcontainers-launched one — and is a reasonable starting point to copy, but it is not exported or published.
- **No Hyperdrive / Cloudflare layer.** Resolving a connection string from a platform binding, and degrading a failed binding to a proxy client, are deployment-topology decisions that stay in the consuming application.
- **Single driver.** This package binds `@effect/sql-pg` (node-`pg`) only; a different Postgres driver, or a different database entirely, needs its own binding package built the same way against the core package's `makeDatabaseServices`.

## Metadata

MIT © Thomas Foster. Repository: [github.com/thomasfosterau/effect-drizzle-ext](https://github.com/thomasfosterau/effect-drizzle-ext), package directory `packages/pg`. Extracted from the `thomasfosterau/website`, `thomasfosterau/gardeneria` and `thomasfosterau/preferenceflow` applications. See [`@thomasfosterau/effect-drizzle-ext`](../core/README.md) for the driver-agnostic half.
