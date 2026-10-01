---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Initial release: the Effect ↔ Drizzle bridge extracted from the website, gardeneria and preferenceflow applications.

`@thomasfosterau/effect-drizzle-ext` (peers: `effect`, `drizzle-orm`; optional `@thomasfosterau/effect-jsonapi`):

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

`@thomasfosterau/effect-drizzle-ext-pg` (peers: `effect`, `drizzle-orm`, `@effect/sql-pg`):

- `.` — `makePgDatabase` over `drizzle-orm/effect-postgres`, `pgClientFromUrl`, `pgClientFromPool`.
- `./testing` — `makeTestTransaction` (sentinel-rollback runner, `attemptInSavepoint`), `isRetryableConnectFailure`, `testDatabaseLayer`.
