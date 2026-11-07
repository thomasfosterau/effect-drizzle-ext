# @thomasfosterau/effect-drizzle-ext

## 0.1.0

### Minor Changes

- [#120](https://github.com/thomasfosterau/effect-drizzle-ext/pull/120) [`c31da24`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/c31da241f8c486d372198318d6d357cabb7dd7c8) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `defineTree` (`.`) and `defineResourceTree` (`./jsonapi`) declare an ontology's level tree once, Drizzle-free: marker and leaf levels, each naming its `parent`, with optional level `columns` (contributed to every descendant's view) and a level `kind` (`"plain"` or `"fact-scoped"`). The returned `Tree` gives every level's ancestors, children, descendants, subtree leaves (the discriminator CHECK value set) and branch in declaration order. A parent naming no level is a type error; every other structural fault (a cycle, a leaf with children, a marker with no leaf, an unannotated level column, a reserved column name, a column clash on a root-to-leaf path, a resource whose `type` isn't its level's name) throws `DerivationError` at module load. `defineTreeFor<Ext>()` / `defineResourceTreeFor<Ext>()` add a consumer extension record to every entry. `DerivationError` is now also exported from `.`; it is the same class `./derive` exports.

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

- [#15](https://github.com/thomasfosterau/effect-drizzle-ext/pull/15) [`1e93cb1`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1e93cb15b97249cfccfc09187603435f82903bfa) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Query-side helpers the applications duplicate:

  - `./sort` — `sortableColumnsFor` (the sortable allow-list derived from a view's columns, memoised), `resolveSortOrder` / `chronologicalOrder` (the caller's `?sort=` or the resource's fallback, always closed with an `id` tiebreak), and `UnsupportedSortError` (a `Schema.TaggedError` carrying `field` and the `allowed` set).
  - `./update` — `updateSetMap` / `insertValues`: the update tri-state (value sets, `null` clears, absent carries forward) as a typed `SET` / `VALUES` map.
  - `./jsonapi` — `resourceAttributeProjections`: each resource attribute's `optional` / `nullable` / `array` / `date` shape and `dbColumn` column as plain data.
  - `./versioned-chain` — the `VersionChainEntry` / `VersionSnapshot` read shapes (generic over the action vocabulary and a hierarchy's extra snapshot facts) and `versionTimestamps`.

- [#120](https://github.com/thomasfosterau/effect-drizzle-ext/pull/120) [`c2c03ef`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/c2c03efcf4951eca44845a85f78a5e5932470429) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `makeTreeTables` (`./versioned-chain`) derives every table and constraint of a `defineTree` / `defineResourceTree` tree in one call. That is a root identity table and a root version table: `(id, version)` key, `action` checked to `create` / `update` / `delete`, `timestamp`, an actor column, and injected extras. Each level then gets a stable + version pair with the composite `(id, version)` FK chain, and the discriminator trio (`UNIQUE (id, type)`, `(id, type)` → parent, and a CHECK narrowing `type` to the subtree's leaves) at every level. A fact-scoped level gets an `(id, version)` spine plus one fact table per column. Per-level hooks add hand-authored columns and extra constraints, or mark a refinable branch, whose `(id, type)` arcs cascade updates. Every table is typed from the tree, and constraint names are canonical.

  Breaking: `SubtypeTablesConfig` loses `constraintNames`, `versionIdColumn` and `parentUpdateCascade`. Derived names are canonical, and the historical overrides go (no consumer schema is deployed yet).

- [#94](https://github.com/thomasfosterau/effect-drizzle-ext/pull/94) [`9a49f8f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/9a49f8fb847426b468b704f320b4f13a0144cb45) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `dist/` is now built with `vp pack` (tsdown) instead of a per-module `tsc` emit. Every `exports` subpath and its `.js` / `.d.ts` path are unchanged. Code shared between subpaths is now bundled into the subpath files or into content-hashed declaration chunks, so `dist/` no longer has one file per source module: deep imports of files outside the exports map (for example `dist/provisioning.js` in the pg package) no longer resolve. The source maps omit `sourcesContent` and point at the `src/` files that ship beside `dist/`.

### Patch Changes

- [#31](https://github.com/thomasfosterau/effect-drizzle-ext/pull/31) [`b49a446`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b49a44690fb61360ea766f3559ff24705ca47887) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Documentation: every `./tooling` export, `resolveBaseRef` included, carries hover documentation; the `./errors` and `./columns` docs describe `@effect/sql-pg`'s Postgres error and `bytea` codec; the README quick-start samples compile.

- [#102](https://github.com/thomasfosterau/effect-drizzle-ext/pull/102) [`6c4a055`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/6c4a055c77f631eb3afa798dc32bbcc4ed195b1b) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The versioned-chain declarations now typecheck against the published `drizzle-orm@1.0.0-rc.5`: `SubtypeTables`' table configs carry `isAlias: false`, and `makeCurrentVersionView`'s view type passes `PgViewWithSelection` its single `ViewConfig` object. Types only; no runtime change. The `1.0.0-rc.5-ab785fc` commit build, which has the older shapes, no longer matches these declarations.

- [#33](https://github.com/thomasfosterau/effect-drizzle-ext/pull/33) [`b2f839e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b2f839ec2cda2cadf3705e2bde562fccf57f66bd) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tested against effect 4.0.0 (with `@effect/sql-pg` and `@effect/platform-node` 4.0.0); peer floor unchanged (`effect` and `@effect/sql-pg` stay `>=4.0.0-rc.118`).

- [#89](https://github.com/thomasfosterau/effect-drizzle-ext/pull/89) [`8d5512c`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/8d5512cd23eee40766c80309dbcbc68dc3c491ac) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Internal refactor to the idiomatic Effect shapes `@mpsuesser/oxlint-plugin-effect` asks for, with no behaviour change. The emitted declarations change compatibly: `readDbTable` is generic over its target, and the inline return types of `makeDeriveColumns`, `timestamps()` and `versionTimestamps` are now the named, documented interfaces `DeriveColumns`, `TimestampColumns` and `VersionTimestamps` (same shapes).

- [#129](https://github.com/thomasfosterau/effect-drizzle-ext/pull/129) [`22c3004`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/22c3004922a0ca864d5b9276cc69983d1ba53af9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The `effect` peer range is now `^4.0.0` (was `>=4.0.0-rc.118`), and so is effect-drizzle-ext-pg's `@effect/sql-pg` peer, per the peer-range policy: every 4.x release from 4.0.0 is supported, and the floor is raised only when a dependency requires it. Only the form of the range changes; Effect 4 release candidates are no longer in range.

- [#108](https://github.com/thomasfosterau/effect-drizzle-ext/pull/108) [`5838886`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/5838886dd50ed395b11b3ddd5c39dab21a667339) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Type-aware lint cleanup: the optional last parameters of `DiscriminatorToolkit.typeParentFk` and `DiscriminatorToolkit.typeConstraints` drop a redundant `| undefined` (an optional parameter already admits `undefined`, so the emitted declarations are equivalent).

- [#31](https://github.com/thomasfosterau/effect-drizzle-ext/pull/31) [`e790fc0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/e790fc04cee8f985f83a61915fe6352534b62630) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tarballs ship `dist`, `src`, `README.md` and `LICENSE` only; the maintainer `CLAUDE.md` is not published. The consumer-facing conventions are in each package's README.
