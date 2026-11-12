# `./testing`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

An always-rollback test transaction runner: every spec runs inside a real database transaction that is rolled back once it completes, so a suite needs no truncation, no fixture reset and no ordering discipline. The library owns no schema, so a spec creates whatever `TEMPORARY` tables it needs inside that transaction — DDL is transactional in PostgreSQL, so the always-rollback disposes of them with everything else.

```ts
export const isRetryableConnectFailure: (cause: unknown) => boolean;

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
