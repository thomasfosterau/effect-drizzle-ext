# packages/pg — `@thomasfosterau/effect-drizzle-ext-pg`

The `@effect/sql-pg` binding of the bridge. Peers: `effect`, `drizzle-orm`, `@effect/sql-pg`, `pg`. Depends on `@thomasfosterau/effect-drizzle-ext` for the driver-agnostic service factory it specialises.

## Terms

- **Database services** — the `{ Database, CurrentTransaction, transact, readHandle, make, layer }` record `makePgDatabase` returns, typed over one application's `relations` graph. An application calls it once.
- **Always-open** — `transact` never joins an ambient transaction; nested calls are SAVEPOINTs. Adjudicated on website #1883; the rationale travels verbatim in `src/index.ts`.
- **Sentinel rollback** — the `./testing` runner wraps a spec in an outer transaction it always fails with a sentinel so nothing the spec wrote survives.
- **Connect seam** — a `SqlError` raised while opening or acquiring a connection (`operation` of `connect` / `acquireConnection`), the only failure class the test runner retries.

## Local invariants

- `pgClientFromPool` never pings at layer build (an application that builds a runtime per request must not open a connection per request).
- The test runner pins `maxConnections: 1` so an operation-opened transaction nests as a SAVEPOINT on the same connection and sees the outer transaction's uncommitted writes.
- Provisioning under `tests/integration/` is repository test infrastructure; it is not exported and not published.

## Boundary

May import from `packages/core` only (`.fallowrc.json` zone `pg`).
