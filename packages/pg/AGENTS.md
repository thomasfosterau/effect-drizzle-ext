# @thomasfosterau/effect-drizzle-ext-pg

The `@effect/sql-pg` binding of the bridge. `drizzle-kit` (an optional peer) is imported only by `./tooling`; `@testcontainers/postgresql` (an optional peer) only by `./testing`'s container fallback, dynamically.

## Boundary

May import from `packages/core` only (`.fallowrc.json` zone `pg`), for the driver-agnostic service factory it specialises.

## Invariants

- **Driver-facing config is `?: T | undefined`, never `Option`** ([docs/CONTRIBUTING.md → Coding guidelines](../../docs/CONTRIBUTING.md#coding-guidelines)): `pgClientFromUrl` / `pgClientFromPool` / `testDatabaseLayer` forward it to `@effect/sql-pg`'s `PgPoolConfig`, which reads `undefined` as "not supplied".
- `pgClientFromPool` never pings at layer build (an application that builds a runtime per request must not open a connection per request); `pgClientFromUrl` always does. Under `@effect/sql-pg` rc.115+ the pool is lazy on its own, so the ping is `pgClientFromUrl`'s explicit `SELECT 1`.
- The test runner pins `maxConnections: 1` so an operation-opened transaction nests as a SAVEPOINT on the same connection and sees the outer transaction's uncommitted writes.
- `./migrations` applies to a **brand-new** database only (no ledger), one transaction per migration, statements split on `--> statement-breakpoint` because `@effect/sql-pg`'s extended protocol refuses multi-statement queries.
- Provisioning owns drop / create / migrate and the container; fixture users and seed data stay with the application (the harness → database edge is one-way).
- `./tooling` is bin-less: the application's own task supplies the schema module and runs the Effect. The `effect-drizzle-kit` bin over it is the kit package (`packages/kit`).
- **`./tooling`'s extras generator never names or chains a migration directory itself**: it runs `drizzle-kit generate --custom` and fills the folder drizzle-kit made, so folder order and `prevIds` stay drizzle-kit's. The extras state is the whole declared state in the latest-by-name directory's `extras.json`, and a change Postgres can't `ALTER` is an `ExtrasError`, never a silent drop and re-create.
- **`./chain` is append-only and never opens a transaction** (`VERSION-CHAIN-001/002`): every write inserts at `N_max + 1` on the root and every level, never an `UPDATE` or `DELETE` of a version row, and requires `CurrentTransaction`. A plain update never resurrects a tombstone (`VERSION-CHAIN-006`); `restoreVersion` reads every level before writing; `history` is capped (`PERF-DB-001`). The race is closed by the root `(id, version)` key, not by a lock: keep the precondition check and the append on the same head read. **`refine` is the one write that changes a stable row**: it sets the identity row's `type` (guarded on the old one, so a lost race is a `VersionConflict`), lets the refinable arcs cascade it, and only inserts the added levels' stable rows; every other write leaves stable rows alone. Error names and fields stay pulpit's, so `pulpit-drizzle-pg` maps them one to one.
- **`./Outbox` never opens a transaction and drains under one lock per table**: `append` writes in the caller's `CurrentTransaction`; `drain` takes `pg_try_advisory_xact_lock` on the table name before it claims, publishes before it marks published, and returns `0` when another drain holds the lock. Don't swap the lock for `SKIP LOCKED`: concurrent drains would publish one stream's events out of order.
- **`./Documents` never rewrites a row**: `put` is `INSERT … ON CONFLICT DO NOTHING`, and the key is the database's `digest(document::text, 'sha256')`, never a hash computed in JavaScript, whose JSON text would differ from `jsonb`'s canonical form.
- **`./ExternalIds` never moves a link**: `link` inserts or reports `present` / `taken`; re-pointing an id is a delete and a link the application writes on purpose.

## Terms

- **Database services** — the `{ Database, CurrentTransaction, transact, readHandle, make, layer, queries, locate }` record `makePgDatabase` returns, typed over one application's `relations` graph. An application calls it once.
- **Always-open** — `transact` never joins an ambient transaction; nested calls are SAVEPOINTs. The invariant lives in [core's AGENTS.md](../core/AGENTS.md#invariants).
- **Sentinel rollback** — the `./testing` runner wraps a spec in an outer transaction it always fails with a sentinel so nothing the spec wrote survives.
- **Fixture chain** — `tests/fixtures/`: a schema module and the drizzle-kit migrations generated from it (regenerate with `vp exec drizzle-kit generate --config tests/fixtures/drizzle.config.ts --name <slug>` from `packages/pg`; never hand-edit `migrations/`, and `.prettierignore` keeps the formatter off it). The integration suite provisions from it; the `./tooling` guards run against it in the unit suite.
- **Provisioning** — `provisionTestDatabase`: explicit URL → reachable local server (drop / create / migrate) → Testcontainers; an explicit but unreachable `PG*` target is an error, never a fallback. Preferenceflow's `local-database.ts` is the reference.
- **Leaf chain** — one leaf's `./chain` operations (`create` / `update` / `restore` / `delete` / `refine` / `restoreVersion` / `getVersion` / `history`); its state is keyed by field across the leaf's path, and its tri-state patch is core's `./update` rule.
- **Extras** — the Postgres objects drizzle-kit's diff doesn't cover (extensions, domains, composite types), declared in TypeScript and migrated by `./tooling`'s `generateExtrasMigration`.
- **TIN** — PlanetScale's full-text search extension (`CREATE EXTENSION tin`). `./Tin` only builds Drizzle `SQL` fragments for it (the `==>` operator, the `tin.*` functions, the `tin` index method): the query is always a bound parameter, and no TIN behaviour is emulated or checked locally, because the integration image doesn't ship it.
- **Connect seam** — a `SqlError` raised while opening or acquiring a connection (`operation` of `connect` / `acquireConnection`), the only failure class the test runner retries.
