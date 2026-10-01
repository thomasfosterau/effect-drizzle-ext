# packages/pg — `@thomasfosterau/effect-drizzle-ext-pg`

The `@effect/sql-pg` binding of the bridge. Peers: `effect`, `drizzle-orm`, `@effect/sql-pg` (`>=4.0.0-rc.118`; rc.115 replaced the `pg` driver with its own protocol); optional `drizzle-kit` (only `./tooling` imports it) and `@testcontainers/postgresql` (only `./testing`'s container fallback, dynamically). Depends on `@thomasfosterau/effect-drizzle-ext` for the driver-agnostic service factory it specialises.

## Terms

- **Database services** — the `{ Database, CurrentTransaction, transact, readHandle, make, layer }` record `makePgDatabase` returns, typed over one application's `relations` graph. An application calls it once.
- **Always-open** — `transact` never joins an ambient transaction; nested calls are SAVEPOINTs. Adjudicated on website #1883; the rationale travels verbatim in `src/index.ts`.
- **Sentinel rollback** — the `./testing` runner wraps a spec in an outer transaction it always fails with a sentinel so nothing the spec wrote survives.
- **Fixture chain** — `tests/fixtures/`: a schema module and the drizzle-kit migrations generated from it (regenerate with `vp exec drizzle-kit generate --config tests/fixtures/drizzle.config.ts --name <slug>` from `packages/pg`; never hand-edit `migrations/`, and `.prettierignore` keeps the formatter off it). The integration suite provisions from it; the `./tooling` guards run against it in the unit suite.
- **Provisioning** — `provisionTestDatabase`: explicit URL → reachable local server (drop / create / migrate) → Testcontainers; an explicit but unreachable `PG*` target is an error, never a fallback. Preferenceflow's `local-database.ts` is the reference.
- **Connect seam** — a `SqlError` raised while opening or acquiring a connection (`operation` of `connect` / `acquireConnection`), the only failure class the test runner retries.

## Local invariants

- `pgClientFromPool` never pings at layer build (an application that builds a runtime per request must not open a connection per request); `pgClientFromUrl` always does. Under `@effect/sql-pg` rc.115 the pool is lazy on its own, so the ping is `pgClientFromUrl`'s explicit `SELECT 1`.
- The test runner pins `maxConnections: 1` so an operation-opened transaction nests as a SAVEPOINT on the same connection and sees the outer transaction's uncommitted writes.
- `./migrations` applies to a **brand-new** database only (no ledger), one transaction per migration, statements split on `--> statement-breakpoint` because `@effect/sql-pg`'s extended protocol refuses multi-statement queries.
- Provisioning owns drop / create / migrate and the container; fixture users and seed data stay with the application (website #1847: the harness → database edge is one-way).
- `./tooling` is bin-less: the application's own task supplies the schema module and runs the Effect.

## Boundary

May import from `packages/core` only (`.fallowrc.json` zone `pg`).
