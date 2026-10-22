# `@thomasfosterau/effect-drizzle-ext-pg`

The `@effect/sql-pg` binding for `@thomasfosterau/effect-drizzle-ext`: `Database` / `CurrentTransaction` services over `drizzle-orm/effect-postgres`, `PgClient` layers, a sentinel-rollback test runner with test-database provisioning, a fresh-database migration runner, and migration-drift / view-dependency guards.

[![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-drizzle-ext-pg.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-drizzle-ext-pg)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
npm install @thomasfosterau/effect-drizzle-ext-pg @thomasfosterau/effect-drizzle-ext effect drizzle-orm @effect/sql-pg
# optional: ./tooling's schema guards, ./testing's container fallback
npm install --save-dev drizzle-kit @testcontainers/postgresql
```

`effect` (`>=4.0.0-rc.118`), `drizzle-orm` (`>=1.0.0-rc.5`) and `@effect/sql-pg` (`>=4.0.0-rc.118`) are peer dependencies, built against `effect@4.0.0-rc.118`, `drizzle-orm@1.0.0-rc.5-ab785fc` and `@effect/sql-pg@4.0.0-rc.118`. Both floors are rc.118 because that release moved `effect/unstable/*` to `effect/*`; the client constructors below are written against `@effect/sql-pg`'s own wire protocol, and `pg` is no longer a peer. `drizzle-kit` (`>=1.0.0-rc.5`, for `./tooling`) and `@testcontainers/postgresql` (`>=12`, for `./testing`'s container fallback) are **optional** peers. `@thomasfosterau/effect-drizzle-ext` is a regular dependency, not a peer — it supplies the driver-agnostic `makeDatabaseServices` factory this package specialises. Node.js 22 or newer is required.

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

`Database`/`CurrentTransaction`/`transact`/`readHandle` are otherwise identical to the driver-agnostic surface documented in [the core package's `./database`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/core/README.md#database) — this package adds nothing to their semantics, only the driver behind them.

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

`@effect/sql-pg` rc.113 and later talks to PostgreSQL in the **binary** protocol only, and decodes each column by OID. Drizzle's `effect-postgres` driver was written for the text protocol, so under it some column types break or are silently corrupted: user enums and enum arrays, `vector`, `interval`, `tsvector`, `time`, `macaddr`, and `bigint({ mode: "string" })` (the driver hands back a JS `bigint` where Drizzle's type says `string`). `timestamptz` and the other columns Drizzle casts to text itself are fine. The measured table and a tested codec shim are in [website#2027](https://github.com/thomasfosterau/website/issues/2027).

The fix is a per-client codec registry. Both helpers forward two optional `@effect/sql-pg` options for it:

- `types` — a `PgTypes.Registry` (`PgTypes.makeRegistry()` plus `register(oid, codec, { arrayOid })` calls), for example an `int8` codec that returns a decimal string.
- `prepare` — `false` to use unnamed statements. Set it behind a pooler that cannot keep named prepared statements across queries, such as Cloudflare Hyperdrive.

```ts
const types = PgTypes.makeRegistry();
types.register(20, int8StringCodec, { arrayOid: 1016 });
const client = pgClientFromUrl({ url, types, prepare: false });
```

`tests/integration/round-trip.test.ts` pins an enum, a string-mode `bigint` and a `timestamptz` through Drizzle against a live server, with and without the registry. This package ships no codecs of its own: which types need one depends on the application's schema.

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

## `./migrations`

The ordered runner for a **brand-new** database. It reads a drizzle-kit `migrations/` directory (one `<digits>_<slug>/` per migration, each holding a `migration.sql`) and applies every migration in directory-name order, each in its own transaction, with no ledger. It mirrors the apply order and transaction shape of alchemy's deploy-time runner, minus the bookkeeping table: the database is always fresh, so every migration applies unconditionally. A directory without a `migration.sql` is skipped. The first failure stops the run with a `MigrationError` naming the migration directory; that migration's transaction rolls back and the ones before it stay applied.

`@effect/sql-pg` speaks the extended query protocol, which refuses more than one statement per query. So each `migration.sql` is split on drizzle-kit's `--> statement-breakpoint` marker, exactly as drizzle's own migrator does, and the statements run in order inside the migration's transaction. A hand-written migration must keep that marker between its statements.

The directory is read through the `FileSystem` / `Path` services (a Node program provides `@effect/platform-node`'s `NodeServices.layer`), and the statements run on the ambient `SqlClient`.

```ts
export class MigrationError /* Schema.TaggedError: migration, cause */ {}
export interface Migration {
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}
export const STATEMENT_BREAKPOINT: "--> statement-breakpoint";
export const splitStatements: (sql: string) => ReadonlyArray<string>;
export const readMigrations: (
  dir: string,
) => Effect.Effect<ReadonlyArray<Migration>, PlatformError, FileSystem | Path>;
export const applyMigrationList: (
  migrations: ReadonlyArray<Migration>,
) => Effect.Effect<number, MigrationError, SqlClient>;
export const applyMigrations: (
  dir: string,
) => Effect.Effect<number, MigrationError | PlatformError, SqlClient | FileSystem | Path>;
```

```ts
const applied = applyMigrations(MIGRATIONS_DIR).pipe(
  Effect.provide(PgClient.layer({ url, maxConnections: 1 })),
  Effect.provide(NodeServices.layer),
);
```

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

### Provisioning the test database

`provisionTestDatabase(options)` is the half of an integration suite's global setup that every application carried as its own `local-database.ts`; preferenceflow's copy is the reference. It resolves where the run's database comes from, then provisions it:

0. **An explicit `DATABASE_URL_TEST` / `DATABASE_URL`** wins and is used as-is. It must already be migrated; nothing is provisioned or torn down.
1. **A reachable local server.** This is whatever the standard `PG*` variables point at, defaulting to a trust-auth `postgres@127.0.0.1:5432`. This checkout's database is dropped, recreated and migrated on it.
2. **A Testcontainers container** when nothing answers and no `PG*` variable is set. It needs a Docker daemon and the optional peer `@testcontainers/postgresql`, which is imported only on this path. The container stops when the provisioning scope closes.

An explicit `PG*` target that does not answer fails with `DatabaseUnreachable`; the run never falls back silently. The database name is `<dbNamePrefix>_test_<sha256(migrationsDir)[:8]>`, so parallel worktrees sharing one server never drop each other's database; pass `migrationsDir` as an absolute path. The container `image` and `dbNamePrefix` are parameters: `pgvector/pgvector:pg17` in website and gardeneria, `postgres:17` in preferenceflow. By default the database is migrated with `./migrations`' `applyMigrations` over `migrationsDir`; a harness whose migrations are not a drizzle-kit directory passes its own `applyMigrations: (url) => Effect<number, …>`.

The resolution order is `resolveDatabaseSource(options)`. It is pure apart from one server probe, and the probe is injectable, so the order is unit-testable without a server. Fixture users and seed data stay with the application: the harness → database edge runs one way.

```ts
export const provisionTestDatabase: <E, R>(
  options: ProvisionOptions<E, R>, // { env, migrationsDir, dbNamePrefix, image, probe?, applyMigrations? }
) => Effect.Effect<
  ProvisionedDatabase, // { url: Redacted<string>, source: DatabaseSource }
  | E
  | DatabaseUnreachable
  | InvalidDatabasePrefix
  | ContainerStartFailed
  | SqlError
  | MigrationError
  | PlatformError,
  R | FileSystem | Path | Scope
>;
export const resolveDatabaseSource: (
  options: DatabaseSourceOptions,
) => Effect.Effect<DatabaseSource, DatabaseUnreachable | InvalidDatabasePrefix>;
export type DatabaseSource =
  | { readonly _tag: "Explicit"; readonly url: Redacted<string> }
  | {
      readonly _tag: "LocalServer";
      readonly adminUrl: Redacted<string>;
      readonly database: string;
      readonly url: Redacted<string>;
    }
  | { readonly _tag: "Container"; readonly image: string };
export type ServerProbe = (adminUrl: Redacted<string>) => Effect.Effect<void, ServerUnreachable>;
export const probeServer: ServerProbe;
export const testDatabaseName: (options: {
  readonly prefix: string;
  readonly migrationsDir: string;
}) => Effect.Effect<string, InvalidDatabasePrefix>;
export const connectionUrl: (env: ResolutionEnvironment, database: string) => Redacted<string>;
```

A vitest global setup holds a `Scope` across the run and closes it in the teardown it returns. This is this repository's own `packages/pg/tests/integration/global-setup.ts`:

```ts
export default async function setup() {
  const scope = Effect.runSync(Scope.make());
  const database = await Effect.runPromise(
    provisionTestDatabase({
      env: process.env,
      migrationsDir: MIGRATIONS_DIR,
      dbNamePrefix: "effect_drizzle_ext",
      image: "pgvector/pgvector:pg17",
    }).pipe(Scope.provide(scope), Effect.provide(NodeServices.layer)),
  );
  process.env.DATABASE_URL_TEST = Redacted.value(database.url);
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
}
```

### Retries

`isRetryableConnectFailure` decides what the runner retries: a `SqlError` that failed at the connect/acquire seam (`operation` of `"connect"` / `"acquireConnection"`), whether or not the driver itself flagged it retryable — this catches a pool-acquisition timeout or an `ECONNRESET` under fork-startup contention, neither of which carries the SQLSTATE `@effect/sql-pg` requires to flag `isRetryable`. It never retries a failure raised by the test's own query (constraint violations, syntax errors), and never retries once the test body has run — only the _open_ of the outer transaction is retried, never test logic.

Failures surface through `Cause.squash`, so the underlying error — not an opaque `Cause` — reaches the rejected `Promise`, and `.rejects.toThrow(/…/)` matches it directly:

```ts
await expect(runInTestTransaction(runtime, Effect.fail(new Error("boom")))).rejects.toThrow(/boom/);
```

## Errors against a live database

`classifyError` from [`@thomasfosterau/effect-drizzle-ext/errors`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/core/README.md#errors) recovers a tagged, fact-carrying error from the drizzle / `@effect/sql-pg` error graph a real query raises — `constraint`, `table` and `column` are populated the same way against this driver as they are documented in the core package. `catchUniqueViolation` is the combinator most operations reach for, typically wrapping a `transact`ed write:

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

## `./tooling`

Two schema guards for a drizzle-kit `migrations/` directory. Neither needs a database. Both are **bin-less** Effects: an application's own `db:migration-drift` / `db:view-dependencies` task runs them with its schema module and reports the typed error. They are ported from the applications' `packages/database/scripts/check-*.ts` (website #1200, #1471, #1228). `drizzle-kit` is an optional peer that only this subpath imports, through `drizzle-kit/api-postgres`.

**`checkMigrationDrift({ schema, migrationsDir, base? })`** runs three checks, each guarding "snapshot history is a DAG, not a chain" from a different side. All three problems are reported together as one `MigrationDriftError { issues }`.

1. **DAG integrity** (`checkDagIntegrity`, pure):
   - every snapshot id is unique;
   - every `prevIds` entry resolves, or is drizzle-kit's all-zero root sentinel;
   - there is exactly one head, and everything is reachable from it;
   - there is no cycle.
2. **Zero drift.** The schema is diffed against the **lexicographically-latest** snapshot with `generateDrizzleJson` / `generateMigration`: the same "latest by directory name" pick alchemy's `Drizzle.Schema.regenerate` makes at deploy time, not a DAG-aware one. The result must be zero statements. A diff drizzle-kit could only resolve interactively (rename or recreate) counts as drift too. This check runs only on a structurally sound DAG.
3. **Base ancestry**, when `base` is `Some`. Every migration the branch adds must descend from the base branch's current head. `readBaseMigrations` reads the base through `git ls-tree` / `git show` (fetching it into a shallow checkout if needed). `resolveBaseRef(env)` takes the ref from `MIGRATION_BASE_REF`, else from `origin/$GITHUB_BASE_REF`, which GitHub Actions sets only on pull requests.

**`checkViewDependencies({ schema })`** fails with `ViewDependencyError { edges }` when any view selects from another view (`DB-VIEW-001`). drizzle-kit emits `DROP VIEW` / `CREATE VIEW` with no topological order and no cascade, so a migration touching either end of such an edge is one PostgreSQL rejects. It reads the graph out of drizzle-kit's own `CREATE VIEW` DDL.

```ts
export const checkMigrationDrift: (options: {
  readonly schema: Record<string, unknown>;
  readonly migrationsDir: string;
  readonly base?: Option.Option<GitBase> | undefined; // { ref, migrationsPath, cwd }
}) => Effect.Effect<
  MigrationDriftReport, // { snapshots, baseRef }
  MigrationDriftError | MalformedSnapshot | SchemaDiffError | PlatformError,
  FileSystem | Path | ChildProcessSpawner
>;
export const checkViewDependencies: (options: {
  readonly schema: Record<string, unknown>;
}) => Effect.Effect<{ readonly viewCount: number }, ViewDependencyError | SchemaDiffError>;
// Pure pieces, for a caller composing its own report:
export const checkDagIntegrity: (entries: ReadonlyArray<SnapshotEntry>) => ReadonlyArray<string>;
export const checkBaseAncestry: (
  entries: ReadonlyArray<SnapshotEntry>,
  base: BaseMigrations,
) => ReadonlyArray<string>;
export const findViewEdges: (views: ReadonlyArray<ViewDefinition>) => ReadonlyArray<ViewEdge>;
```

An application's script:

```ts
// packages/database/scripts/check-migration-drift.ts — run by the `db:migration-drift` task
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { checkMigrationDrift, resolveBaseRef } from "@thomasfosterau/effect-drizzle-ext-pg/tooling";
import * as schema from "../src/schema.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
checkMigrationDrift({
  schema,
  migrationsDir: path.join(repoRoot, "packages/database/migrations"),
  base: Option.map(resolveBaseRef(process.env), (ref) => ({
    ref,
    migrationsPath: "packages/database/migrations",
    cwd: repoRoot,
  })),
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
```

This repository proves both guards against a committed fixture chain, `packages/pg/tests/fixtures/` (a schema module plus the drizzle-kit migrations generated from it), in the unit suite CI runs. The integration suite provisions its database from the same chain.

## Limitations

- **No Hyperdrive / Cloudflare layer.** Resolving a connection string from a platform binding, and degrading a failed binding to a proxy client, are deployment-topology decisions that stay in the consuming application.
- **No migrator for a live database.** `./migrations` applies everything to a database that is always brand new; it keeps no ledger, so it is not a deploy-time migrator.
- **Single driver.** This package binds `@effect/sql-pg` only; a different Postgres driver, or a different database entirely, needs its own binding package built the same way against the core package's `makeDatabaseServices`.

## License

MIT © Thomas Foster. Repository: [github.com/thomasfosterau/effect-drizzle-ext](https://github.com/thomasfosterau/effect-drizzle-ext), package directory `packages/pg`. Extracted from the `thomasfosterau/website`, `thomasfosterau/gardeneria` and `thomasfosterau/preferenceflow` applications. See [`@thomasfosterau/effect-drizzle-ext`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/core/README.md) for the driver-agnostic half.
