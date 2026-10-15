# @thomasfosterau/effect-drizzle-ext-pg

## 0.1.0

### Minor Changes

- [#1](https://github.com/thomasfosterau/effect-drizzle-ext/pull/1) [`afc4834`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/afc48343d450e2605f7b9b15318ce6fa70bd1b10) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Initial release: the Effect ↔ Drizzle bridge extracted from the website, gardeneria and preferenceflow applications.

  Built against `effect` / `@effect/sql-pg` / `@effect/platform-node` 4.0.0-rc.118, whose entry points are `effect/*` (the published declarations import `effect/sql/SqlClient`, `effect/sql/SqlError` and `effect/process/ChildProcessSpawner`), so the `effect` peer floor is `>=4.0.0-rc.118`.

  `@thomasfosterau/effect-drizzle-ext` (peers: `effect`, `drizzle-orm`; optional `@thomasfosterau/effect-jsonapi` `>=0.16.0`, its rc.118 build):

  - `.` — the `dbColumn` / `dbTable` annotation vocabulary with type-level phantoms, `Option`-returning readers, numeric-bound extraction and `Schema.Struct` field readers.
  - `./derive` — injected builder registry → Drizzle columns, CHECK derivation from schema bounds, `DerivationError`.
  - `./references` — the lazy foreign-key reference registry.
  - `./constraints` — `enumCheck` and the parameterised discriminator constraint toolkit.
  - `./columns` — `bytea`, `tsvector`, `jsonbSchema`, `timestamps`, hex helpers.
  - `./query` — the window-total pagination helpers, `combineFilters`, `boundedPagination`, `executeRows`.
  - `./errors` — Postgres error facts and tagged classification (`UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation`, `CheckViolation`, `ExclusionViolation`, `SerializationFailure`, `DeadlockDetected`) over drizzle's `EffectDrizzleQueryError` and Effect's `SqlError`.
  - `./database` — the driver-agnostic `makeDatabaseServices` factory (`Database`, `CurrentTransaction`, always-open `transact`, `readHandle`).
  - `./versioned-chain` — `makeSubtypeTables` and `makeCurrentVersionView`.
  - `./jsonapi`, `./jsonapi/derive` — the `Resource.*` readers and `makeDeriveResourceColumns` / `deriveCheckConstraints` for `@thomasfosterau/effect-jsonapi` models.

  `@thomasfosterau/effect-drizzle-ext-pg` (peers: `effect`, `drizzle-orm`, `@effect/sql-pg` `>=4.0.0-rc.118`; the client layers run on `@effect/sql-pg`'s own wire protocol, so the `pg` driver is not needed):

  - `.` — `makePgDatabase` over `drizzle-orm/effect-postgres`, `pgClientFromUrl`, `pgClientFromPool`.
    - `pgClientFromPool` is `@effect/sql-pg`'s lazily-connecting pool: it never connects at layer build, is shut down with the layer's scope, and takes `maxConnections` / `connectTimeout`. `pgClientFromUrl` pings at layer build, through an explicit `SELECT 1`.
    - Both forward the optional `@effect/sql-pg` options `types` (a `PgTypes.Registry`) and `prepare`. `@effect/sql-pg` is binary-only, and some column types (enums, `vector`, `interval`, `tsvector`, `time`, `bigint({ mode: "string" })`) need a codec under Drizzle's `effect-postgres` driver; `prepare: false` is what Cloudflare Hyperdrive needs. See the pg README's "Binary codecs and Drizzle" section.
  - `./testing` — `makeTestTransaction` (sentinel-rollback runner, `attemptInSavepoint`), `isRetryableConnectFailure`, `testDatabaseLayer`.

- [#15](https://github.com/thomasfosterau/effect-drizzle-ext/pull/15) [`87f49f2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/87f49f21b3bc242b048f03ec7fc6864162cb0e45) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Migration and test-database tooling, moved here from the applications (reversing [#2](https://github.com/thomasfosterau/effect-drizzle-ext/issues/2)'s "migrations tooling" / "test-db provisioning" non-goals for these items only):

  - `./migrations` — `applyMigrations(dir)`: apply every drizzle-kit migration under `dir` to a brand-new database in directory-name order, one transaction each, no ledger, statements split on `--> statement-breakpoint`; `readMigrations`, `applyMigrationList`, `splitStatements`, and `MigrationError` naming the failing migration.
  - `./testing` — `provisionTestDatabase({ env, migrationsDir, dbNamePrefix, image, applyMigrations? })` (scoped: explicit `DATABASE_URL_TEST` / `DATABASE_URL` → a reachable local server, dropped / created / migrated as `<prefix>_test_<sha256(migrationsDir)[:8]>` → a Testcontainers container stopped with the scope), `resolveDatabaseSource` with an injectable server probe, `testDatabaseName`, and tagged `DatabaseUnreachable` / `ContainerStartFailed` / `InvalidDatabasePrefix` errors.
  - `./tooling` — `checkMigrationDrift` (snapshot-DAG integrity, zero drift against the latest-by-name snapshot, base-branch ancestry via `git`) and `checkViewDependencies` (no view selects from another view), as bin-less Effects over `drizzle-kit/api-postgres`.
  - Optional peers: `drizzle-kit` (`./tooling`), `@testcontainers/postgresql` (the container fallback).

### Patch Changes

- [#31](https://github.com/thomasfosterau/effect-drizzle-ext/pull/31) [`b49a446`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b49a44690fb61360ea766f3559ff24705ca47887) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Documentation: every `./tooling` export, `resolveBaseRef` included, carries hover documentation; the `./errors` and `./columns` docs describe `@effect/sql-pg`'s Postgres error and `bytea` codec; the README quick-start samples compile.

- [#33](https://github.com/thomasfosterau/effect-drizzle-ext/pull/33) [`b2f839e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b2f839ec2cda2cadf3705e2bde562fccf57f66bd) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tested against effect 4.0.0 (with `@effect/sql-pg` and `@effect/platform-node` 4.0.0); peer floor unchanged (`effect` and `@effect/sql-pg` stay `>=4.0.0-rc.118`).

- [#53](https://github.com/thomasfosterau/effect-drizzle-ext/pull/53) [`f7177a0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/f7177a04e8fc0bd35dfab7774eb274c311cf7a65) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `DatabaseSourceOptions.probe`, `ProvisionOptions.applyMigrations` (`./testing`) and `MigrationDriftOptions.base` (`./tooling`) are now spelled `?: T | undefined`, so a caller under `exactOptionalPropertyTypes` can forward its own optional value; an explicit `undefined` behaves as an absent key.

- [#31](https://github.com/thomasfosterau/effect-drizzle-ext/pull/31) [`e790fc0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/e790fc04cee8f985f83a61915fe6352534b62630) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tarballs ship `dist`, `src`, `README.md` and `LICENSE` only; the maintainer `CLAUDE.md` is not published. The consumer-facing conventions are in each package's README.
- Updated dependencies [[`c1cb2c8`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/c1cb2c836fe0d7fffc63c66c8958045f0b669269), [`b49a446`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b49a44690fb61360ea766f3559ff24705ca47887), [`b2f839e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b2f839ec2cda2cadf3705e2bde562fccf57f66bd), [`afc4834`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/afc48343d450e2605f7b9b15318ce6fa70bd1b10), [`1e93cb1`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1e93cb15b97249cfccfc09187603435f82903bfa), [`e790fc0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/e790fc04cee8f985f83a61915fe6352534b62630)]:
  - @thomasfosterau/effect-drizzle-ext@0.1.0
