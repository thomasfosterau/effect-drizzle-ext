# @thomasfosterau/effect-drizzle-ext-pg

## 0.8.0

### Minor Changes

- [#248](https://github.com/thomasfosterau/effect-drizzle-ext/pull/248) [`85396a0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/85396a0c6dd292ba72bffa0230359d4e0b35e8e9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Chain writes shaped for aggregate repositories: `LeafChain.load` reads the head's state and version together, `LeafChain.setPointer` moves a named pointer (publish, schedule, clear) as a write of its own, and the new `./VersionedRow` entry gives a flat table optimistic concurrency (`versionColumn`, `makeVersionedRow`).

- [#246](https://github.com/thomasfosterau/effect-drizzle-ext/pull/246) [`2bbc15f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2bbc15ff073d5847cc67c90765cecbaa1619ecd6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - **Breaking:** adopt Effect v4's export layout. Every module is a PascalCase subpath, and each package root re-exports modules as namespaces instead of flat names. Function and type names are unchanged; only their import paths move.
  
  Upgrade by renaming subpaths:
  
  | Package | Old subpath | New subpath |
  | --- | --- | --- |
  | core | `.` (flat `dbColumn`, `dbTable`, `defineTree`, `DerivationError`, `VersionChainEntry`, …) | `./Annotation`, or the root's `Annotation` namespace |
  | core | `./derive`, `./references`, `./constraints`, `./columns`, `./query`, `./sort`, `./update`, `./errors`, `./database` | `./Derive`, `./References`, `./Constraints`, `./Columns`, `./Query`, `./Sort`, `./Update`, `./Errors`, `./Database` |
  | core | `./query-functions`, `./versioned-chain`, `./postgis` | `./QueryFunctions`, `./VersionedChain`, `./PostGis` |
  | core | `./jsonapi`, `./jsonapi/derive` | `./JsonApi`, `./JsonApiDerive` |
  | pg | `.` (flat `makePgDatabase`, `pgClientFromUrl`, `pgClientFromPool`, `PgDatabase*` types) | `./PgDatabase`, or the root's `PgDatabase` namespace |
  | pg | `./chain`, `./migrations`, `./testing`, `./tooling` | `./Chain`, `./Migrations`, `./Testing`, `./Tooling` |
  
  ```ts
  // before
  import { dbColumnFor } from "@thomasfosterau/effect-drizzle-ext";
  import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/derive";
  import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
  
  // after
  import { dbColumnFor } from "@thomasfosterau/effect-drizzle-ext/Annotation";
  import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/Derive";
  import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
  ```
  
  The core root stays Drizzle-free: it re-exports `Annotation`, `Errors`, `Predicate` and `Update`, plus the `PostGis` namespace as before. Modules that import Drizzle are subpaths only. The pg root re-exports every module except `Tooling`, which needs the optional `drizzle-kit` peer. `./Predicate`, `./Where`, `./Search`, `./Tin`, `./Outbox`, `./Documents` and `./ExternalIds` keep their paths.

- [#252](https://github.com/thomasfosterau/effect-drizzle-ext/pull/252) [`1a3475d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1a3475d89d41f8554396e8d54752b38ebeae7f22) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The extras generator migrates functions (`fn`) and triggers (`trigger`), and splits its output into two custom migrations around drizzle-kit's own: extensions, domains and composite types (and dropped triggers and functions) before it, functions and triggers (and dropped types, domains and extensions) after it. `generateMigrations` runs the whole sequence, including `drizzle-kit generate`; `generateExtrasMigration` now takes a `phase`, and `ExtrasPlan` has `before` and `after` in place of `statements`. `extras.json` is version 2; version 1 files still read. Rename hints and `recordOnly` apply to the before migration. `effect-drizzle-kit generate` now runs instead of `drizzle-kit generate`, and its `--name` is drizzle-kit's slug.

- [#247](https://github.com/thomasfosterau/effect-drizzle-ext/pull/247) [`b887899`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b88789921ab5ec10767e23a4d00af956de72be44) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The extras generator takes rename hints and a record-only mode. `generateExtrasMigration({ renames })` (and `planExtras`'s third argument) turns a renamed domain, composite type or attribute into `ALTER … RENAME` instead of a drop plus a create; `recordOnly: true` writes the declared state into a custom migration whose SQL you write by hand, for a change the generator refuses. `effect-drizzle-kit generate` gains `--rename` and `--record-only`.

- [#253](https://github.com/thomasfosterau/effect-drizzle-ext/pull/253) [`1471ece`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1471ece0f3ad12df7ec7c0237a049f23ed1a8138) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - A leaf level may now have children. `defineTree` no longer throws for a leaf with children: its name joins its own subtree leaves (so its discriminator CHECK), it gets a leaf view like any leaf, and the branch views above it gain its `CASE` arm. A tree with no such leaf derives exactly the DDL and view SQL it did before. `LeafName` no longer counts a bare `{}` marker as a leaf, so such a marker drops out of `views.leaves` and the chain's types, where it never had a runtime value.
  
  `-pg/chain` adds `LeafChain.refine({ id, from, patch, actor, keyed?, stable?, expectedVersion? })`: on the target leaf, it refines a node of `from` (a leaf above it on its path) to the target in one write. It reads `from`'s head and checks the precondition there, sets the identity row's `type` (the refinable arcs cascade it), inserts the stable rows of the levels the target adds, and appends an `update` at every level carrying `from`'s state with `patch` applied. Earlier versions have no row at the added levels, so the target reads none of them. A non-refinable arc makes the identity update fail with the driver's foreign-key violation.

- [#254](https://github.com/thomasfosterau/effect-drizzle-ext/pull/254) [`ba20b3e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/ba20b3ec09e13e2ef0e60070944c3984920d1ad6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./testing`: `makeTestTransaction` also returns `inTestTransaction(effect)`, the always-rollback runner as an Effect for `@effect/vitest`'s `it.effect` inside a `layer(...)` block. It re-raises the spec's own failure in the error channel and makes a harness-transaction failure a defect. `runInTestTransaction` now runs through it, with the same rejections.

### Patch Changes

- [#251](https://github.com/thomasfosterau/effect-drizzle-ext/pull/251) [`8051a2d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/8051a2d7a456a9df240acae339178c418ccc8f9b) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./chain` writes no longer turn a unique violation of a constraint other than the chain's own (a consumer's unique external key on a stable table, say) into a defect: it stays the driver's error in the typed channel, as `create`'s documentation already said, so `classifyErrors` and `catchUniqueViolation` can recover it. Code that caught it as a defect (`Effect.catchDefect`, `Cause.hasDies`) should catch the failure instead.
  
  The provisioning, migration and `./tooling` entry points, and kit's commands, are now `Effect.fn` functions, so each run is a tracing span (`Testing.*`, `Migrations.*`, `Tooling.*`, `Commands.*`). The test database name is hashed through `effect/crypto`'s `Digest`; the name is unchanged.

- [#244](https://github.com/thomasfosterau/effect-drizzle-ext/pull/244) [`5c40f4e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/5c40f4e56b390a681e2b2032be66fee3aa6e9020) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./tooling`'s base-migration reads and `effect-drizzle-kit`'s repository lookup clear `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_WORK_TREE` before running `git`, so the checkout named by `cwd` is the one read even when called from a git hook in a linked worktree.
- Updated dependencies [[`8051a2d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/8051a2d7a456a9df240acae339178c418ccc8f9b), [`2bbc15f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2bbc15ff073d5847cc67c90765cecbaa1619ecd6), [`1471ece`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1471ece0f3ad12df7ec7c0237a049f23ed1a8138)]:
  - @thomasfosterau/effect-drizzle-ext@0.8.0

## 0.7.0

### Minor Changes

- [#243](https://github.com/thomasfosterau/effect-drizzle-ext/pull/243) [`aeecce2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/aeecce239c6f902d9f7ba183cc80975813ce1b71) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add `./Documents`, a content-addressed document store keyed by Postgres's own digest of the canonical `jsonb` (`documentColumns`, `makeDocumentStore` with `put`, `get` and `getMany`), and `./ExternalIds`, a node's ids at outside authorities (`makeExternalIdTable`, `makeExternalIdStore` with `lookup`, `linksOf` and `link`).

- [#237](https://github.com/thomasfosterau/effect-drizzle-ext/pull/237) [`20cf6a0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/20cf6a0be085382d836ff73a9895afa780adb426) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add `./Outbox`, a transactional outbox: `outboxColumns()` and `outboxConstraints(name)` build the table in your own schema, and `makeOutbox({ table, CurrentTransaction })` returns `append` (inside the caller's transaction), `drain` (one drain per table at a time, in `seq` order, at least once) and `pending`.

### Patch Changes

- Updated dependencies [[`aeecce2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/aeecce239c6f902d9f7ba183cc80975813ce1b71)]:
  - @thomasfosterau/effect-drizzle-ext@0.7.0

## 0.6.0

### Minor Changes

- [#224](https://github.com/thomasfosterau/effect-drizzle-ext/pull/224) [`2a12e8c`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2a12e8c058feedee5b37278eed2590099acdd4f4) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Context-bound query functions. `makePgDatabase` now returns `queries`: the client's `select`, `insert`, `update`, `delete`, `query`, `$count`, `execute` and the rest as free functions that find the client in the Effect context, so a caller writes `yield* select().from(users)` instead of yielding the client first. Every builder keeps Drizzle's own types, inferred from the schema, with the database key in its requirement channel (`PgQueryFunctions`, `PgContextQueryEffectHKT`). Each query runs on the open `CurrentTransaction` when there is one, so a write inside `transact` lands in that transaction, and on the `Database` client otherwise. The driver-agnostic factory behind it is core's new `./query-functions` entry (`makeQueryFunctions`, `DeferredQueryError`).

- [#229](https://github.com/thomasfosterau/effect-drizzle-ext/pull/229) [`202a16d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/202a16d3fddce7a88614a507b78f2fe69894b681) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `makePgDatabase` returns `locate`, which resolves the table and columns a Postgres error names to the Drizzle table and columns the database's `relations` declare: `Option.some({ key, table, columns })`, a union discriminated by the relations key (`PgErrorLocation`, `PgErrorTableLocation`, `ColumnOf`). A constraint is matched by its explicit name or the default drizzle-kit or Postgres gives an unnamed one, with a unique violation's `DETAIL` key as the fallback. Core's `findPgError` now searches 12 levels deep (was 8), so it reaches the driver error behind a classified error inside an `Exit`'s `Cause`.

- [#223](https://github.com/thomasfosterau/effect-drizzle-ext/pull/223) [`555f97e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/555f97e0c88314bb25442f27e0aa3db88a963a2b) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - A new `./Tin` entry, also exported from the root as the `Tin` namespace: typed Drizzle helpers for PlanetScale's TIN full-text search extension, to use beside `eq` and `ilike`. `matches` and `matchesAny` build the `==>` operator, `score`, `fullScore` and `maxScore` the BM25 functions (named, typed arguments; the ctid qualified with the table or its alias), `highlight` and `highlightAnsi` the highlighters, and `tinIndex` a `USING tin` index with its `WITH` options typed and rendered for drizzle-kit. `phrase` quotes user input as a TINQL phrase so its operators and quotes are searched as words.

- [#219](https://github.com/thomasfosterau/effect-drizzle-ext/pull/219) [`7ef6279`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7ef62795d5747cb68a09dd3faef6df271395a484) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./tooling` gains migrations for the Postgres objects drizzle-kit doesn't manage: extensions, domains and composite types (effect-drizzle-ext#212). Declare them with `extension`, `domain` and `compositeType`. `generateExtrasMigration` diffs the declarations against the state recorded in the migrations directory, then writes the SQL into a `drizzle-kit generate --custom` migration, with an `extras.json` recording the new state beside it. `checkExtrasDrift` fails when a declaration changed without a migration. The pure `planExtras` is exported for a caller composing its own report.

- [#226](https://github.com/thomasfosterau/effect-drizzle-ext/pull/226) [`47ffbce`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/47ffbce833f5f8a2575dad9aaecce54066895533) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Typed Postgres errors in the error channel. `makePgDatabase`'s context-bound `queries` now fail with core's tagged classes (`UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation`, `CheckViolation`, `ExclusionViolation`, `SerializationFailure`, `DeadlockDetected`, each carrying its `constraint` / `table` / `column` / `detail`) when the SQLSTATE is one of those, so a caller can `Effect.catchTag("UniqueViolation", …)` on the query itself; every other failure is still the driver's `EffectDrizzleQueryError`. Core's `./errors` gains `classifyErrors`, the combinator that does this for any Effect (a `transact`, or a query run on a handle), and `isClassifiedError`; `classifyError` now returns an already-classified error as it is. `./query-functions`' `makeQueryFunctions` takes an optional `mapQuery` that wraps every query before it runs.

### Patch Changes

- [#231](https://github.com/thomasfosterau/effect-drizzle-ext/pull/231) [`88acad6`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/88acad6f4177d898bfb9cae0f3cd0158f1578cc4) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Doc comments are shorter and no longer cite issues; module overviews link to the guides.
- Updated dependencies [[`2a12e8c`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2a12e8c058feedee5b37278eed2590099acdd4f4), [`91f3e7a`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/91f3e7a50329369cfc48a4d0ef5da4bddbcf3bdf), [`88acad6`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/88acad6f4177d898bfb9cae0f3cd0158f1578cc4), [`202a16d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/202a16d3fddce7a88614a507b78f2fe69894b681), [`47ffbce`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/47ffbce833f5f8a2575dad9aaecce54066895533)]:
  - @thomasfosterau/effect-drizzle-ext@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`14c1d79`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/14c1d79613c80230a226215871130bfb2b36a951)]:
  - @thomasfosterau/effect-drizzle-ext@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`9e2f3b2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/9e2f3b2a8acfdacd4c7198f59561ab08f7e70be2), [`5adffde`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/5adffde351b5a54625447a23f05ccb965be88c53), [`a7bd413`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/a7bd4139c3d9539ddba9b9aa9c48237784e8fc92), [`bbd0957`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/bbd0957a7956551b656d929b33153ae83eb9738b), [`0ddb37a`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/0ddb37a04e9513b0a4f4159d80e9381fc2cb8bab)]:
  - @thomasfosterau/effect-drizzle-ext@0.4.0

## 0.3.0

### Minor Changes

- [#175](https://github.com/thomasfosterau/effect-drizzle-ext/pull/175) [`7709bde`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7709bdeb2a4972eac54cdc81db4be46d94be7d2c) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Options bags the library reads itself now spell optional members `readonly x?: T` instead of `?: T | undefined` (effect-drizzle-ext#105):
  
  - core: `SortableColumnsOptions`, `ResolveSortOrderOptions`, `ChronologicalOrderOptions`, `NumericBounds`, `DiscriminatorNames` and `typeConstraints`' `refinable`, and `defineTree`'s `LevelSpec`.
  - -pg: `DatabaseSourceOptions.probe`, `ProvisionOptions.applyMigrations`, and `MigrationDriftOptions.base` (now `base?: Option.Option<GitBase>`).
  
  `ResolutionEnvironment` and `BaseRefEnvironment` are now `Readonly<NodeJS.ProcessEnv>`, so `process.env` passes as before.
  
  Config handed to Drizzle (`DbColumn`, `DeriveOptions`, `./versioned-chain`'s builder config) and to `PgPoolConfig` (`pgClientFromUrl` / `pgClientFromPool` / `testDatabaseLayer`) keeps `?: T | undefined`.
  
  **Migration:** under `exactOptionalPropertyTypes`, omit an absent member instead of passing `undefined`. For example, `resolveSortOrder({ view, sort: query.sort })` with a possibly-undefined `query.sort` becomes `resolveSortOrder(query.sort === undefined ? { view } : { view, sort: query.sort })`. Where a caller holds a whole options object, forward it with a rest spread (`const { direction, ...rest } = options`), which keeps an absent key absent.

- [#189](https://github.com/thomasfosterau/effect-drizzle-ext/pull/189) [`7993e67`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7993e67ecd487a5d84a4cea9bdc4a20eecd7784e) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Per-level stable-table columns and constraints (effect-drizzle-ext#188). They hold an external key that must be unique across a leaf's nodes, which a version table can't constrain because every version repeats it.
  
  - `makeTreeTables`: a level's `stableColumns` hook appends columns to its stable table after `id` / `type`, and `stableConstraints` appends constraints after the discriminator's. `root.identityConstraints` does the same for the identity table, after `UNIQUE (id, type)`. `makeSubtypeTables` takes `stableColumns` / `stableConstraints` too, and `SubtypeTables` gains a defaulted `TStable` parameter. A `stableColumns` key the stable table (`id`, `type`) or the level's version table already has throws `DerivationError` at module load.
  - `makeTreeViews`: every view whose path reaches the level projects its stable columns, before its version columns, INNER JOINed on `id`. They're typed through `TreeLeafSelection` / `TreeBranchSelection` and handed to a branch's `project`. A key another of the view's sources shares throws `DerivationError`.
  - `./chain`: `create` takes `stable` (`ChainStableExtras`), keyed by field across the leaf's path. No other write touches a stable row.
  
  The change is additive: a tree without these hooks emits the same DDL and view SQL as before.

- [#173](https://github.com/thomasfosterau/effect-drizzle-ext/pull/173) [`472337a`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/472337afa3fb5bf4d954ac8f966607020d35c3ff) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./testing`'s runner states its contract in its types:
  
  - `runInTestTransaction` / `withTestTransaction` take a `ManagedRuntime<R | Key, SqlError>`, so a runtime that doesn't provide the `Database` key is a type error instead of a runtime failure.
  - `makeTestTransaction` accepts any `DatabaseServices` (a `PgDatabase` as before, or core's `makeDatabaseServices` output).
  - `testDatabaseLayer` reads only the `layer` member.
  
  **Migration:** none for a runtime built from `testDatabaseLayer`, which already provides the key.

### Patch Changes

- [#176](https://github.com/thomasfosterau/effect-drizzle-ext/pull/176) [`1ea0789`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1ea07899dccdea4f850d5240a76a373bfdef5bc9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `findPgError`, `classifyError`, `isUniqueViolation`, `isConstraintViolation`, `isRetryableTransactionFailure` (`./errors`) and `isRetryableConnectFailure` (`-pg/testing`) name their parameter `cause`: any caught failure value, walked as an error graph. The type (`unknown`) and behaviour are unchanged.

- [#170](https://github.com/thomasfosterau/effect-drizzle-ext/pull/170) [`c14dd55`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/c14dd554d9421f411853d2768dccc45dbf1d2774) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./chain` now treats an id that isn't a UUID as an unknown node, without querying. `head` returns `Option.none()`. `update`, `restore`, `delete` and `history` fail `NodeNotFound`, and `getVersion` and `restoreVersion` fail `VersionNotFound`. Previously PostgreSQL rejected the id (`22P02`), which surfaced as a `SqlError` (a 500) and aborted the caller's transaction. Any spelling PostgreSQL's `uuid` input accepts (upper case, braces, no hyphens) still finds the node.

- [#171](https://github.com/thomasfosterau/effect-drizzle-ext/pull/171) [`bb5fb9d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/bb5fb9d00d59610be823118a3a5a6c2d108996ae) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./tooling` exports `SchemaModule`, the schema-module type drizzle-kit's `generateDrizzleJson` takes. `MigrationDriftOptions.schema` and `checkViewDependencies`' `schema` are now typed with it, which is the same `Record<string, unknown>` as before.
- Updated dependencies [[`ccb81e7`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/ccb81e74e2bdc32c32fa0050db69c948eea3df2c), [`1ea0789`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1ea07899dccdea4f850d5240a76a373bfdef5bc9), [`95c24f8`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/95c24f8eaea88dd2239f33f0823f98a1d9afed2e), [`472337a`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/472337afa3fb5bf4d954ac8f966607020d35c3ff), [`7709bde`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7709bdeb2a4972eac54cdc81db4be46d94be7d2c), [`763b059`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/763b0592321e77afa9149ed718e5077837744689), [`87f1085`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/87f1085f9bbfa5f9f32875d020ab99a0972d9d9e), [`f004f7e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/f004f7e379a37bc4f76b07b70df3d8c5df10c223), [`7993e67`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7993e67ecd487a5d84a4cea9bdc4a20eecd7784e), [`db03da2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/db03da202fa7cccd1d708ae57fbf205baa880783), [`2a050ae`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2a050ae87d12bd41b7cc83efd4b9e6b55d4a14d6)]:
  - @thomasfosterau/effect-drizzle-ext@0.3.0

## 0.2.0

### Minor Changes

- [#154](https://github.com/thomasfosterau/effect-drizzle-ext/pull/154) [`0ab65df`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/0ab65dfcdeb22ce25c2fae5a5c940bf7ffa9e3fd) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./chain`'s `LeafChain` exposes `head(id)`: the node's head entry (`version`, `action`, `timestamp`), or `Option.none()` for an id with no versions of this leaf. A caller can read it to pin a write's `expectedVersion` (effect-drizzle-ext#153).

- [#151](https://github.com/thomasfosterau/effect-drizzle-ext/pull/151) [`572ac13`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/572ac13b5bc6558f699aae9add571445dcc3d611) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./chain` writes and reads a keyed leaf's keyed level, such as a localised leaf's locales (effect-drizzle-ext#149). `create` takes `keyed`, the whole level at version 0. `update` / `restore` take `keyed`, a per-key tri-state patch: a patch updates that key (starting from none for a new key), `null` drops it, and an absent key carries it forward. Every write appends one version of the whole node. `delete` carries every key through the tombstone, and `restoreVersion` restores them with the shared columns. `getVersion` returns them as `keyed`, keyed by key, with `{}` for a version that carries none. This matches pulpit's `LocaleStates` / `LocalePatch`. `ChainTables` now requires `keyed`, which every `makeTreeTables` result has.

- [#146](https://github.com/thomasfosterau/effect-drizzle-ext/pull/146) [`7b9309b`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7b9309bf4a9f3ba79559f10f92adb557206512fa) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - New subpath `./chain`: the version-chain discipline, written directly over the tables `makeTreeTables` derives (effect-drizzle-ext#117). `makeVersionChain({ tree, tables, CurrentTransaction })` returns a `LeafChain` per leaf with seven operations:
  
  - `create`: never an upsert. A taken id fails `NodeAlreadyExists`.
  - `update`: a tri-state carry-forward patch, written at `N_max + 1` on every level.
  - `delete`: a tombstone that carries the state forward. Idempotent.
  - `restore`: the only plain write over a tombstone.
  - `restoreVersion`: reads every level first, and fails `VersionNotFound` before writing.
  - `getVersion`
  - `history`: bounded by `MAX_HISTORY_LIMIT`.
  
  Every write to an existing node takes an `expectedVersion` precondition. A moved head fails `StaleVersion`. A writer that races between the read and the append loses the root `(id, version)` key and fails `VersionConflict`. The actor is a required `string | undefined`, and the root tables' injected columns ride along. Every operation requires the application's `CurrentTransaction`; the chain never opens a transaction itself. The error names and fields match pulpit's `version-chain`.

### Patch Changes

- [#143](https://github.com/thomasfosterau/effect-drizzle-ext/pull/143) [`5176714`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/517671487e285b77d6fc436f029b82e3a18131a9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The published tarballs now include `CHANGELOG.md`, so the release notes can be read from `node_modules` (effect-drizzle-ext#142). npm adds only `package.json`, the README and the licence on its own, and each package's `files` list didn't name the changelog Changesets writes.

- [#141](https://github.com/thomasfosterau/effect-drizzle-ext/pull/141) [`daa16d2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/daa16d2ad6532d93d4f2ca4d6b1054c2e8a987c2) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `engines.node` is now `>=22.18`, the floor of the `@thomasfosterau/effect-ext` dependency core gained in effect-drizzle-ext#136 (pg reaches it through core). Before this, both packages declared `>=22` while depending on a package that declares `>=22.18`, so Node 22.0–22.17 installs warned (`EBADENGINE`) or, under `engine-strict`, failed inside the dependency (effect-drizzle-ext#140).
- Updated dependencies [[`54ba05f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/54ba05f526f5f0c852c15d2ee9ff3d6677c78b09), [`5176714`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/517671487e285b77d6fc436f029b82e3a18131a9), [`e8696df`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/e8696df5ad51b60e3c50168251344122150e9ec1), [`daa16d2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/daa16d2ad6532d93d4f2ca4d6b1054c2e8a987c2), [`9b9db79`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/9b9db7967a1d773173b9ba83d693134ac648e702), [`6a1c5ee`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/6a1c5ee91a9275672d6c56c1471aca68a24ad436), [`6b9f155`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/6b9f15562eb57f078241bf221a0f8c57c2e8c664)]:
  - @thomasfosterau/effect-drizzle-ext@0.2.0

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

- [#94](https://github.com/thomasfosterau/effect-drizzle-ext/pull/94) [`9a49f8f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/9a49f8fb847426b468b704f320b4f13a0144cb45) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `dist/` is now built with `vp pack` (tsdown) instead of a per-module `tsc` emit. Every `exports` subpath and its `.js` / `.d.ts` path are unchanged. Code shared between subpaths is now bundled into the subpath files or into content-hashed declaration chunks, so `dist/` no longer has one file per source module: deep imports of files outside the exports map (for example `dist/provisioning.js` in the pg package) no longer resolve. The source maps omit `sourcesContent` and point at the `src/` files that ship beside `dist/`.

### Patch Changes

- [#31](https://github.com/thomasfosterau/effect-drizzle-ext/pull/31) [`b49a446`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b49a44690fb61360ea766f3559ff24705ca47887) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Documentation: every `./tooling` export, `resolveBaseRef` included, carries hover documentation; the `./errors` and `./columns` docs describe `@effect/sql-pg`'s Postgres error and `bytea` codec; the README quick-start samples compile.

- [#120](https://github.com/thomasfosterau/effect-drizzle-ext/pull/120) [`aa75d57`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/aa75d579a35c5c16bbe28e2c81bd19db37c72dbc) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `checkMigrationDrift` (`./tooling`) reads the snapshot chains drizzle-kit 1.0.0-rc.5 writes. Its snapshots are version `"9"`: a `base` and then `diff`s over it, with no full `ddl`. The guard used to reject every one as "doesn't match the drizzle-kit snapshot contract", so any migration generated with the pinned drizzle-kit failed the zero-drift check. It now rebuilds the latest state with drizzle-kit's own `reconstruct` over the whole chain, and still reads a full version `"8"` snapshot as-is.

- [#33](https://github.com/thomasfosterau/effect-drizzle-ext/pull/33) [`b2f839e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b2f839ec2cda2cadf3705e2bde562fccf57f66bd) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tested against effect 4.0.0 (with `@effect/sql-pg` and `@effect/platform-node` 4.0.0); peer floor unchanged (`effect` and `@effect/sql-pg` stay `>=4.0.0-rc.118`).

- [#89](https://github.com/thomasfosterau/effect-drizzle-ext/pull/89) [`50cb4bd`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/50cb4bd02e07a5ba76c6e61029b318b1ed8644ea) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Internal refactor to the idiomatic Effect shapes `@mpsuesser/oxlint-plugin-effect` asks for. No exported signature changes. `runInTestTransaction`'s own failures ("outer transaction failed", "inner Exit was never captured", "unexpected outer failure") now reject with a tagged `TestTransactionError` (still an `Error`, same message) instead of a plain `Error`. The `./tooling` doc examples name `origin/trunk` as the base ref.

- [#129](https://github.com/thomasfosterau/effect-drizzle-ext/pull/129) [`22c3004`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/22c3004922a0ca864d5b9276cc69983d1ba53af9) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The `effect` peer range is now `^4.0.0` (was `>=4.0.0-rc.118`), and so is effect-drizzle-ext-pg's `@effect/sql-pg` peer, per the peer-range policy: every 4.x release from 4.0.0 is supported, and the floor is raised only when a dependency requires it. Only the form of the range changes; Effect 4 release candidates are no longer in range.

- [#53](https://github.com/thomasfosterau/effect-drizzle-ext/pull/53) [`f7177a0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/f7177a04e8fc0bd35dfab7774eb274c311cf7a65) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `DatabaseSourceOptions.probe`, `ProvisionOptions.applyMigrations` (`./testing`) and `MigrationDriftOptions.base` (`./tooling`) are now spelled `?: T | undefined`, so a caller under `exactOptionalPropertyTypes` can forward its own optional value; an explicit `undefined` behaves as an absent key.

- [#31](https://github.com/thomasfosterau/effect-drizzle-ext/pull/31) [`e790fc0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/e790fc04cee8f985f83a61915fe6352534b62630) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tarballs ship `dist`, `src`, `README.md` and `LICENSE` only; the maintainer `CLAUDE.md` is not published. The consumer-facing conventions are in each package's README.
- Updated dependencies [[`c31da24`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/c31da241f8c486d372198318d6d357cabb7dd7c8), [`b49a446`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b49a44690fb61360ea766f3559ff24705ca47887), [`6c4a055`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/6c4a055c77f631eb3afa798dc32bbcc4ed195b1b), [`b2f839e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b2f839ec2cda2cadf3705e2bde562fccf57f66bd), [`8d5512c`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/8d5512cd23eee40766c80309dbcbc68dc3c491ac), [`22c3004`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/22c3004922a0ca864d5b9276cc69983d1ba53af9), [`afc4834`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/afc48343d450e2605f7b9b15318ce6fa70bd1b10), [`1e93cb1`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1e93cb15b97249cfccfc09187603435f82903bfa), [`c2c03ef`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/c2c03efcf4951eca44845a85f78a5e5932470429), [`5838886`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/5838886dd50ed395b11b3ddd5c39dab21a667339), [`e790fc0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/e790fc04cee8f985f83a61915fe6352534b62630), [`9a49f8f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/9a49f8fb847426b468b704f320b4f13a0144cb45)]:
  - @thomasfosterau/effect-drizzle-ext@0.1.0
