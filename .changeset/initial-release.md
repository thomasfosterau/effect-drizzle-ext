---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Initial release: the Effect ↔ Drizzle bridge extracted from the website, gardeneria and preferenceflow applications.

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
