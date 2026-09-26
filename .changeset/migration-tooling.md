---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Migration and test-database tooling, moved here from the applications (reversing #2's "migrations tooling" / "test-db provisioning" non-goals for these items only):

- `./migrations` — `applyMigrations(dir)`: apply every drizzle-kit migration under `dir` to a brand-new database in directory-name order, one transaction each, no ledger, statements split on `--> statement-breakpoint`; `readMigrations`, `applyMigrationList`, `splitStatements`, and `MigrationError` naming the failing migration.
- `./testing` — `provisionTestDatabase({ env, migrationsDir, dbNamePrefix, image, applyMigrations? })` (scoped: explicit `DATABASE_URL_TEST` / `DATABASE_URL` → a reachable local server, dropped / created / migrated as `<prefix>_test_<sha256(migrationsDir)[:8]>` → a Testcontainers container stopped with the scope), `resolveDatabaseSource` with an injectable server probe, `testDatabaseName`, and tagged `DatabaseUnreachable` / `ContainerStartFailed` / `InvalidDatabasePrefix` errors.
- `./tooling` — `checkMigrationDrift` (snapshot-DAG integrity, zero drift against the latest-by-name snapshot, base-branch ancestry via `git`) and `checkViewDependencies` (no view selects from another view), as bin-less Effects over `drizzle-kit/api-postgres`.
- Optional peers: `drizzle-kit` (`./tooling`), `@testcontainers/postgresql` (the container fallback).
