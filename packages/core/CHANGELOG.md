# @thomasfosterau/effect-drizzle-ext

## 0.3.0

### Minor Changes

- [#173](https://github.com/thomasfosterau/effect-drizzle-ext/pull/173) [`472337a`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/472337afa3fb5bf4d954ac8f966607020d35c3ff) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `executeRows` (`./query`) now decodes the rows with a Schema instead of trusting a caller-asserted row type. Its error channel gains `Schema.SchemaError`, which it fails with when a row doesn't match, or when the result is neither a rows array nor a result object (several statements' results, for one).
  
  **Migration:** replace the type argument with a schema argument.
  
  ```ts
  // before
  executeRows<{ n: number }>(db, sql`SELECT n FROM t`);
  // after
  executeRows(db, sql`SELECT n FROM t`, Schema.Struct({ n: Schema.Finite }));
  ```
  
  Also new: `isDbColumn`, the guard `readDbColumn` and `resourceColumns` now read an annotation through. A value under the annotation key that isn't db-column metadata reads as no column.

- [#175](https://github.com/thomasfosterau/effect-drizzle-ext/pull/175) [`7709bde`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7709bdeb2a4972eac54cdc81db4be46d94be7d2c) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Options bags the library reads itself now spell optional members `readonly x?: T` instead of `?: T | undefined` (effect-drizzle-ext#105):
  
  - core: `SortableColumnsOptions`, `ResolveSortOrderOptions`, `ChronologicalOrderOptions`, `NumericBounds`, `DiscriminatorNames` and `typeConstraints`' `refinable`, and `defineTree`'s `LevelSpec`.
  - -pg: `DatabaseSourceOptions.probe`, `ProvisionOptions.applyMigrations`, and `MigrationDriftOptions.base` (now `base?: Option.Option<GitBase>`).
  
  `ResolutionEnvironment` and `BaseRefEnvironment` are now `Readonly<NodeJS.ProcessEnv>`, so `process.env` passes as before.
  
  Config handed to Drizzle (`DbColumn`, `DeriveOptions`, `./versioned-chain`'s builder config) and to `PgPoolConfig` (`pgClientFromUrl` / `pgClientFromPool` / `testDatabaseLayer`) keeps `?: T | undefined`.
  
  **Migration:** under `exactOptionalPropertyTypes`, omit an absent member instead of passing `undefined`. For example, `resolveSortOrder({ view, sort: query.sort })` with a possibly-undefined `query.sort` becomes `resolveSortOrder(query.sort === undefined ? { view } : { view, sort: query.sort })`. Where a caller holds a whole options object, forward it with a rest spread (`const { direction, ...rest } = options`), which keeps an absent key absent.

- [#186](https://github.com/thomasfosterau/effect-drizzle-ext/pull/186) [`763b059`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/763b0592321e77afa9149ed718e5077837744689) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Three plain factories drop their `make*` prefix, which in Effect names service constructors; these build no service:
  
  | Before                         | After                         | Entry              |
  | ------------------------------ | ----------------------------- | ------------------ |
  | `makeDeriveColumns`            | `deriveColumnsWith`           | `./derive`         |
  | `makeDeriveResourceColumns`    | `deriveResourceColumnsWith`   | `./jsonapi/derive` |
  | `makeDiscriminatorConstraints` | `discriminatorConstraintsFor` | `./constraints`    |
  
  Their signatures and behaviour are unchanged.
  
  **Migration:** rename the imports and calls, for example `const { fromFields } = deriveColumnsWith(builders, { resolveReference })`.

- [#193](https://github.com/thomasfosterau/effect-drizzle-ext/pull/193) [`87f1085`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/87f1085f9bbfa5f9f32875d020ab99a0972d9d9e) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The root entry (`@thomasfosterau/effect-drizzle-ext`) now exports the version-chain read shapes `VersionAction`, `VersionChainEntry` and `VersionSnapshot`, so a client-bundled package can name them without pulling `drizzle-orm` into its module graph (effect-drizzle-ext#191). They are the same types `./versioned-chain` exports, and that import path keeps working: nothing needs migrating. `VersionSnapshot["columns"]` is spelled without Drizzle, as the decoded type of `Schema.Record(Schema.String, Schema.Unknown)`: exactly the type `Readonly<InferSelectModel<PgTable>>` resolved to (and `Readonly<Record<string, unknown>>`), so no caller changes.

- [#189](https://github.com/thomasfosterau/effect-drizzle-ext/pull/189) [`7993e67`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7993e67ecd487a5d84a4cea9bdc4a20eecd7784e) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Per-level stable-table columns and constraints (effect-drizzle-ext#188). They hold an external key that must be unique across a leaf's nodes, which a version table can't constrain because every version repeats it.
  
  - `makeTreeTables`: a level's `stableColumns` hook appends columns to its stable table after `id` / `type`, and `stableConstraints` appends constraints after the discriminator's. `root.identityConstraints` does the same for the identity table, after `UNIQUE (id, type)`. `makeSubtypeTables` takes `stableColumns` / `stableConstraints` too, and `SubtypeTables` gains a defaulted `TStable` parameter. A `stableColumns` key the stable table (`id`, `type`) or the level's version table already has throws `DerivationError` at module load.
  - `makeTreeViews`: every view whose path reaches the level projects its stable columns, before its version columns, INNER JOINed on `id`. They're typed through `TreeLeafSelection` / `TreeBranchSelection` and handed to a branch's `project`. A key another of the view's sources shares throws `DerivationError`.
  - `./chain`: `create` takes `stable` (`ChainStableExtras`), keyed by field across the leaf's path. No other write touches a stable row.
  
  The change is additive: a tree without these hooks emits the same DDL and view SQL as before.

- [#183](https://github.com/thomasfosterau/effect-drizzle-ext/pull/183) [`db03da2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/db03da202fa7cccd1d708ae57fbf205baa880783) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `makeTreeTables` now throws `DerivationError` at module load when an injected column shares a key with one its table already has, naming the key and both sources. Previously the injected column silently replaced the other. The check covers:
  
  - `root.identityColumns` against `id` / `type`;
  - `root.versionColumns` against `id` / `version` / `action` / `timestamp` / `actor`;
  - a level's `columns` hook against that level's tree columns and `id` / `version`.
  
  Trees without a clash emit the same DDL.
  
  **Migration:** rename the injected key.

- [#168](https://github.com/thomasfosterau/effect-drizzle-ext/pull/168) [`2a050ae`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2a050ae87d12bd41b7cc83efd4b9e6b55d4a14d6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `makeTreeViews` now throws `DerivationError` at module load when two of a view's sources share a column key, naming the key and both sources. Previously the later source silently won. This covers a level column named like a `root.identityColumns` extra (the `slug` trap), a level column named `timestamp` or `createdAt`, and a branch `project` key the view already selects. The emitted SQL of every view without a clash is unchanged.
  
  **Migration:** if a tree now throws, rename one of the two columns' keys. For a branch view, return the projected column from `project` under a key the view doesn't already select. The view that loaded before was missing one of the two columns.

### Patch Changes

- [#167](https://github.com/thomasfosterau/effect-drizzle-ext/pull/167) [`ccb81e7`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/ccb81e74e2bdc32c32fa0050db69c948eea3df2c) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `BuilderFor` (and with it `DerivedColumns` / `DerivedResourceColumns`) now applies Drizzle's `HasDefault` when a `dbColumn` annotation declares a `default`, matching the `.default(value)` the derivation applies at runtime. A defaulted column is optional on the table's `$inferInsert`. An app carrying a local `WithDefaults` workaround can drop it.

- [#176](https://github.com/thomasfosterau/effect-drizzle-ext/pull/176) [`1ea0789`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1ea07899dccdea4f850d5240a76a373bfdef5bc9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `findPgError`, `classifyError`, `isUniqueViolation`, `isConstraintViolation`, `isRetryableTransactionFailure` (`./errors`) and `isRetryableConnectFailure` (`-pg/testing`) name their parameter `cause`: any caught failure value, walked as an error graph. The type (`unknown`) and behaviour are unchanged.

- [#166](https://github.com/thomasfosterau/effect-drizzle-ext/pull/166) [`95c24f8`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/95c24f8eaea88dd2239f33f0823f98a1d9afed2e) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Accept `@thomasfosterau/effect-ext` `^0.1.0 || ^0.2.0`, so an app on effect-ext 0.2 installs one copy instead of a nested 0.1.0. Nothing this package uses (`./Ast`, `./LiteralExact`) changed between the two releases.

- [#192](https://github.com/thomasfosterau/effect-drizzle-ext/pull/192) [`f004f7e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/f004f7e379a37bc4f76b07b70df3d8c5df10c223) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `resolveSortOrder` (`./sort`) keeps only the first occurrence of a field repeated in the caller's sort, and the closing `id` tiebreak follows the de-duplicated list (effect-drizzle-ext#190). `[name asc, name desc]` now resolves to `name asc, id asc`, the same order as `[name asc]`, instead of `name asc, name desc, id desc`. `resourceAttributeProjections`' doc comment now says `column` is an `Option` by design.

## 0.2.0

### Minor Changes

- [#148](https://github.com/thomasfosterau/effect-drizzle-ext/pull/148) [`9b9db79`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/9b9db7967a1d773173b9ba83d693134ac648e702) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Pointer and keyed-fact levels for a tree (effect-drizzle-ext#116):
  
  - **Keyed fact level.** A leaf entry in `defineTree` / `defineResourceTree` can declare `keyed: { name, columns }`: columns held once per `(id, version, key)`, such as a localised leaf's translated columns keyed by locale. `makeTreeTables` derives a `${leaf}_${name}` table keyed `(id, version, name)`, foreign-keyed to the leaf's version table, and `makeTreeViews` derives `${leaf}_${name}_view`: one row per key the head carries, and one row with a `NULL` key for a head that carries none. The shared leaf view stays one row per node. Throws `DerivationError` at module load for a keyed level on a marker, an empty name, a reserved or colliding key or column, or no columns.
  - **Named pointers.** `makeTreeTables(tree, { root: { pointers: ["live"] } })` derives an append-only `${name}_pointer` log per name: `seq`, `id`, a nullable `version` foreign-keyed to the root version table, `at`, the actor, and `recorded_at`. Writing a pointer never appends a version. `makeTreeViews(..., { pointers: { live: ["book"] } })` derives `${leaf}_${name}_view` (plus `${leaf}_${keyed}_${name}_view` for a keyed leaf). It resolves the leaf view at the version named by the node's effective fact (the latest by `seq` whose `at` has arrived), fails closed there, reads `action` off the head, and projects the fact's `at` as `${name}At`. A cleared or absent pointer has no row.
  
  `TreeTables` gains `keyed` and `pointers` members, and `AnyTreeTables` requires them. A hand-written `AnyTreeTables` value needs both, so the change is minor rather than patch.

- [#144](https://github.com/thomasfosterau/effect-drizzle-ext/pull/144) [`6a1c5ee`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/6a1c5ee91a9275672d6c56c1471aca68a24ad436) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./versioned-chain` gains `makeTreeViews(tree, tables, { schema, branches })`, which derives a tree's read views from its `makeTreeTables` output (effect-drizzle-ext#115):
  
  - **A fail-closed current-version view per leaf** (`${leaf}_view`). It resolves the head from the root version table, then INNER JOINs every level's version table from the branch root down to the leaf at that `(id, version)`, so ancestor level columns appear with no per-anchor factory. It projects `id`, `version`, `action`, the identity extras, each level's columns root-most first (a fact-scoped level's facts LEFT JOINed and nullable), `timestamp` and `createdAt` (the version-0 timestamp). A node whose head advanced past any level yields no row.
  - **Branch views** (`${level}_view`) for the marker levels named in `branches`. Each is a `UNION ALL` over the marker's subtree leaves that projects `type` and the marker's own and inherited columns. An optional per-leaf `project` adds columns to every arm, for a search union.
  - **`asOf(leaf, { version } | { at })`**: the leaf view resolved at the latest version at or below `version`, or written at or before `at`, as a subquery to select from. It fails closed in the same way.
  
  Every derived view reads base tables only, never another view. Each view's row type is derived from the tree.

### Patch Changes

- [#136](https://github.com/thomasfosterau/effect-drizzle-ext/pull/136) [`54ba05f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/54ba05f526f5f0c852c15d2ee9ff3d6677c78b09) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Depend on `@thomasfosterau/effect-ext` for the pure Schema helpers instead of keeping local copies (effect-drizzle-ext#135). `resourceAttributeProjections` (`./jsonapi`) reads each attribute's `optional` / `nullable` / `array` / `date` traits with effect-ext's `Ast` predicates, the same JSON-codec decode probes as before, and the version table's `action` values are a `LiteralExact.tuple` checked against `VersionAction`. No behaviour or type changes. `@thomasfosterau/effect-ext` (`^0.1.0`) is a regular dependency; its one required peer, `effect ^4.0.0`, is already a peer of this package.

- [#143](https://github.com/thomasfosterau/effect-drizzle-ext/pull/143) [`5176714`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/517671487e285b77d6fc436f029b82e3a18131a9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The published tarballs now include `CHANGELOG.md`, so the release notes can be read from `node_modules` (effect-drizzle-ext#142). npm adds only `package.json`, the README and the licence on its own, and each package's `files` list didn't name the changelog Changesets writes.

- [#139](https://github.com/thomasfosterau/effect-drizzle-ext/pull/139) [`e8696df`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/e8696df5ad51b60e3c50168251344122150e9ec1) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `numericBounds` (and the CHECK constraints derived from it) no longer reads `Schema.isInt()`'s safe-integer range as a declared bound (effect-drizzle-ext#138). Since effect 4.0.5 that check's JSON Schema carries `minimum: Number.MIN_SAFE_INTEGER` / `maximum: Number.MAX_SAFE_INTEGER`. That turned every `Schema.Int` column's `_non_negative` / `_min` / `_max` CHECK into a `BETWEEN … _range`, gave an unbounded `Schema.Int` a CHECK it never declared, and dropped the `> 0` of an `Int.check(isGreaterThan(0), isLessThanOrEqualTo(n))`. A user-declared bound still applies, including the range of `Schema.isInt32()` / `isUint32()`.

- [#141](https://github.com/thomasfosterau/effect-drizzle-ext/pull/141) [`daa16d2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/daa16d2ad6532d93d4f2ca4d6b1054c2e8a987c2) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `engines.node` is now `>=22.18`, the floor of the `@thomasfosterau/effect-ext` dependency core gained in effect-drizzle-ext#136 (pg reaches it through core). Before this, both packages declared `>=22` while depending on a package that declares `>=22.18`, so Node 22.0–22.17 installs warned (`EBADENGINE`) or, under `engine-strict`, failed inside the dependency (effect-drizzle-ext#140).

- [#147](https://github.com/thomasfosterau/effect-drizzle-ext/pull/147) [`6b9f155`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/6b9f15562eb57f078241bf221a0f8c57c2e8c664) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `makeSubtypeTables` (and so `makeTreeTables`) now gives each version table's `(id, version)` → parent-version foreign key `ON DELETE CASCADE` (effect-drizzle-ext#145). Before this, deleting a node whose leaf sits two or more levels deep failed on that FK, because its NO ACTION check ran before the stable-table cascade reached the level's version rows. So erasing a node's whole chain (`DELETE` of its identity row) only worked for a leaf directly under the root. Regenerating a consumer's migrations emits one `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT … ON DELETE CASCADE` per level version table.

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
