# @thomasfosterau/effect-drizzle-ext

## 0.5.0

### Minor Changes

- [#208](https://github.com/thomasfosterau/effect-drizzle-ext/pull/208) [`14c1d79`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/14c1d79613c80230a226215871130bfb2b36a951) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Fence the levels a `makeTreeViews` leaf, keyed, pointer and as-of view only needs to exist into one `CROSS JOIN LATERAL (… OFFSET 0) "tail"` keyed on the driver (effect-drizzle-ext#207). These views joined every level's version table, every stable row they project and every fact table as plain joins. PostgreSQL searched every join order on every plan, and a `LIMIT $n` read is re-planned on every call (always, with `prepare: false` behind a pooler). At three marker levels a paged list took 84 ms to plan and 2 ms to execute.
  
  **The rule.** A level with columns of its own stays a plain join, so an index on them can still drive a filter or a sort; a level with no columns of its own (a pure marker, whose row only has to exist) and every level's stable row go in the tail, and the fact tables join it when there is one (LEFT JOINs inside it; a view with nothing to fence keeps them as plain LEFT JOINs). The tail is an inner join, so a head missing a level row still yields no row; it never NULLs one. The driver, the root version row, the identity row, the version-0 row (`createdAt`), a keyed row and a pointer's fact and head row stay plain joins. An upgrade never moves a column a consumer could sort or filter on out of reach of its index, except stable-row (`stableColumns`) and fact columns, which are now read per row from the tail.
  
  **The new option, `fenced`.** `makeTreeViews(tree, tables, { …, fenced: ["series"] })` also moves a marker level with columns into the tail. Use it for a deep tree whose column-bearing levels are never filtered or sorted on. A fenced level's columns are read once per row: a sort on one runs the tail for every row and then sorts (0.8 s at 50,000 rows), and a filter on one can't use an index. A name that is not a marker level throws `DerivationError` at module load.
  
  **What planning costs.** The planner's join search grows steeply with the relations outside the fence. On a synthetic leaf at three marker levels (50,000 leaf nodes at two versions plus 50,000 other nodes), planning ms for `ORDER BY title, id LIMIT 20`:
  
  | plain marker levels | relations outside the fence | planning |
  | ------------------- | --------------------------- | -------- |
  | 0                   | 5                           | 3.6      |
  | 1                   | 6                           | 11.2     |
  | 2                   | 7                           | 41.2     |
  | 3 (0.4.0's shape)   | 8                           | 74.9     |
  
  The five are the driver, the root version row, the identity row, the version-0 row and the head anti-join's `newer`; a keyed table or a pointer's head row adds one. Each plain column-bearing level costs from about 8 ms (the sixth relation) to 30 ms or more (the seventh and later).
  
  Plan / execution ms, the synthetic leaf at K pure marker levels, with indexes on the leaf's `(title, id)`, the root version's `timestamp` and an identity column:
  
  | K   | read                                    | 0.4.0                 | this change |
  | --- | --------------------------------------- | --------------------- | ----------- |
  | 1   | page, `ORDER BY title, id LIMIT 20`     | 7.4 / 2.3             | 3.3 / 2.0   |
  | 1   | by id                                   | 1.2 / 0.2             | 0.8 / 0.1   |
  | 1   | `count(*)`                              | 2.9 / 194             | 1.7 / 336   |
  | 3   | page, `ORDER BY title, id LIMIT 20`     | 83.6 / 2.3            | 3.4 / 2.0   |
  | 3   | `ORDER BY created_at DESC, id LIMIT 20` | 84.9 / 3.1            | 5.3 / 5.0   |
  | 3   | identity column `= $1`, page            | 63.4 / 32 (seq scan)  | 3.0 / 12    |
  | 3   | join from 20 parent rows on `id`        | 22.2 / 426 (seq scan) | 3.1 / 0.8   |
  | 3   | by id                                   | 5.4 / 0.3             | 1.1 / 0.2   |
  | 3   | `count(*)`                              | 20.9 / 341            | 1.9 / 740   |
  
  A column-bearing tree gains less. The fixture's deepest leaf, `volume`, sits under `collection` (`name`) and `series` (`cadence`, and a `code` stable column), with 50,000 volumes at two versions. Its view plans in 45 ms (page by `label`) and 41 ms (page by `name`), against 124 and 96 ms in 0.4.0. With `fenced: ["series"]` it plans in 13 and 18 ms. With `fenced: ["collection", "series"]` it plans in 6 and 3 ms, but the page by `name` then executes in 825 ms instead of 6. The trade-off everywhere is `count(*)`, which runs the tail once per row: 1.4–2.2× slower across runs (241 vs 413 ms for `volume`). `SET join_collapse_limit = 1` also flattened planning, but froze the written join order: 282 ms for the `created_at` sort and 360 ms for the parent join, so it is not a substitute.
  
  Rows, columns, column order and column types are unchanged. This was checked with `EXCEPT ALL` both ways and against `information_schema.columns`:
  
  - every fixture leaf, keyed and pointer view, against its 0.4.0 definition;
  - `asOf` at several versions and times;
  - generated trees of one and three pure markers;
  - a three-level tree with columns and `fenced`.
  
  The checks include heads that skipped a marker, the leaf's spine row or a required stable row. Branch views and `makeCurrentVersionView` are byte-identical, and so is every leaf, keyed and pointer view whose path has only column-bearing levels with no `stableColumns` and no facts.
  
  **Upgrading.** Only leaf, keyed and pointer views that gain a tail change their SQL: those with a pure marker on their path (or, for a pointer view, a leaf with no columns of its own), a `stableColumns` level, a fact-scoped level, or a level you name in `fenced`. `asOf` is a query, not a view. Your next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each changed view, with no table or data change. drizzle-kit does not order view drops by dependency. If one of your own views selects from a changed view, drop it before the generated statements and recreate it after them (hand-edit the migration), or remove the edge. `checkViewDependencies` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` reports every such edge. A root identity or version table named `tail` (`root.identity` / `root.version`) would share its name with the fence's alias, so `makeTreeViews` now throws `DerivationError` for one at module load.

## 0.4.0

### Minor Changes

- [#205](https://github.com/thomasfosterau/effect-drizzle-ext/pull/205) [`9e2f3b2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/9e2f3b2a8acfdacd4c7198f59561ab08f7e70be2) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Fail a `makeTreeViews` branch view closed with a `CASE` on `type` instead of a LEFT JOIN per leaf (effect-drizzle-ext#204). The single-driver branch view (effect-drizzle-ext#200) LEFT JOINed every marker below the branch and every subtree leaf, and its planning time grew with those nullable joins: a paged list planned in 143 ms at 8 leaves and 1,523 ms at 40, and a `LIMIT $n` read re-plans on every call. The driver, the anti-join head and the INNER spine are unchanged; the `WHERE` is now `CASE type WHEN '<leaf>' THEN EXISTS (<each marker between the branch and the leaf>) AND EXISTS (<the leaf's row>) [AND EXISTS (<a lower stable row>)] … ELSE false END`, each probe at the driver's `(id, version)` and ending `OFFSET 0`, so PostgreSQL keeps it a per-row index probe rather than hashing it (hashed, a 20-leaf page seq-scanned every leaf table: 47–104 ms). A level below the branch is LEFT JOINed only when `project` reads one of its columns; a branch with no per-leaf projection joins no leaf. A `type` naming no subtree leaf, or `NULL`, yields no row.
  
  Plan / execution ms, PostgreSQL 16, synthetic branch of 200,000 nodes at two versions under two marker levels, `ORDER BY title, id LIMIT 20` for the page. "CASE (unfenced prototype)" is the `CASE` without `OFFSET 0`; "shipped (fenced)" is the `CASE` with it. "not re-measured" marks a cell never measured fenced; "-" a plan time not recorded:
  
  | leaves | read       | effect-drizzle-ext#200 | CASE (unfenced prototype) | shipped (fenced)  |
  | ------ | ---------- | ---------------------- | ------------------------- | ----------------- |
  | 8      | page       | 143 / 3.4              | 4.4 / 1.8                 | not re-measured   |
  | 8      | by id      | 4.7 / 0.6              | 2.0 / 0.4                 | not re-measured   |
  | 8      | `count(*)` | 17 / 1,407             | 2.3 / 1,005               | not re-measured   |
  | 20     | page       | 489 / 4.8              | 4.0 / 104                 | 4.4 / 1.9         |
  | 20     | by id      | 8.8 / 1.0              | 3.1 / 0.7                 | not re-measured   |
  | 20     | `count(*)` | 35 / 2,061             | 3.3 / 1,245               | not re-measured   |
  | 40     | page       | 1,523 / 7.7            | 5.5-6.0 / 49-60           | 5.3-5.4 / 2.4-2.6 |
  | 40     | by id      | 26.8 / 2.6             | 4.2 / 1.1                 | - / 1.3           |
  | 40     | `count(*)` | 52 / 3,380             | 5.6 / 1,176               | - / 1,601         |
  
  The fenced cells are the shipped `OFFSET 0` form; the page rows were measured twice each (20 leaves: 4.4 / 1.9 and 3.7 / 1.9; 40 leaves: 5.4 / 2.6 and 5.3 / 2.4). The unfenced prototype planned a hashed probe per leaf and executed the 20-leaf page in 104 ms and the 40-leaf page in 60 ms and 49 ms. The other prototype rows were never re-measured with `OFFSET 0`; at 40 leaves, a separate unfenced run gave by id 1.6 ms and `count(*)` 1,218 ms (execution), against 1.3 ms and 1,601 ms fenced. On the fixture chain (two leaves, 50,000 books and 50,000 essays at two versions each, a `work_version (title, id)` index), `work_view ORDER BY title, id LIMIT 20` executes in 0.37 ms.
  
  The rows, columns, column order and row types are the same as effect-drizzle-ext#200's, checked with `EXCEPT ALL` against the earlier `UNION ALL` definitions for the fixture branches and for generated branches of 12 and 30 leaves, including that release's tightening: a node whose `type` names a leaf with no row at the head (or names no subtree leaf) yields no row. Leaf, keyed, pointer and as-of views, and `makeCurrentVersionView`, are byte-identical.
  
  **Upgrading.** Only branch views' SQL changes. Your next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each branch view, with no table or data change. drizzle-kit does not order view drops by dependency: if one of your own views selects from a branch view, drop it before the generated statements and recreate it after them (hand-edit the migration), or remove the edge. `checkViewDependencies` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` reports every such edge. Since effect-drizzle-ext#200, leaves that `project` one key from columns of different SQL types throw `DerivationError` at module load, including pairs a `UNION ALL` used to unify (`varchar` and `text`, `integer` and `bigint`); cast or alias in `project` so every leaf names one type, for example ``sql`${columns.key}::text`.as("key")``.

- [#203](https://github.com/thomasfosterau/effect-drizzle-ext/pull/203) [`5adffde`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/5adffde351b5a54625447a23f05ccb965be88c53) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Drive each `makeTreeViews` branch view from the branch level's own version table instead of a `UNION ALL` of one arm per subtree leaf (effect-drizzle-ext#200). PostgreSQL plans each `UNION ALL` arm that has joins as its own subquery, so no index order reached the top and a paged list sorted every branch row. A branch view is now one SELECT with the same anti-join head as the leaf views: it INNER JOINs the root version row, the identity row, the birth row and the levels down to the branch, then LEFT JOINs each marker below the branch and each subtree leaf at the head. A fail-closed `WHERE` keeps a row only when the leaf its `type` names, and every marker on the way to it, has a row at the head. An index on the branch-level column you sort by (`levels.<branch>.extraConstraints`) now serves `ORDER BY … LIMIT`. Sorting by a leaf-only column can't be index-served.
  
  PostgreSQL 16, `EXPLAIN (ANALYZE, BUFFERS)`, second run:
  
  | read | before | after |
  | --- | --- | --- |
  | fixture `work_view ORDER BY title, id LIMIT 20` (100,000 works at two versions, `work_version (title, id)` index) | 391 ms, a Sort over every row | the index, no Sort (0.37 ms with the effect-drizzle-ext#204 shape) |
  | synthetic 20-leaf branch, paged list | 2,385 ms | 4.9 ms |
  | synthetic 20-leaf branch, `WHERE id = $1` | 1.86 ms | 0.88 ms |
  | synthetic 20-leaf branch, `count(*)` | 1,753 ms | 1,911 ms |
  
  The rows, columns, column order and row types are the same as before, checked against the `UNION ALL` definitions with `EXCEPT ALL`. **Behaviour change:** a node whose `type` names one leaf while only another leaf's row exists at the head now yields **no row** in the branch view. The union returned that other leaf's row labelled with the stale `type`, a row that contradicts itself. This shape is only reachable by bypassing the `(id, type)` foreign-key chain (old leaf rows kept past a move). Every other row is unchanged. A per-leaf `project` key becomes one `CASE` on `type`, named and decoded as the first leaf's value. Leaves that project the same key from columns of different SQL types now throw `DerivationError` at module load, and so does an unaliased projected expression.
  
  **Upgrading.** Only branch views' SQL changes. Your next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each branch view, with no table or data change; leaf, keyed, pointer and as-of views are byte-identical. drizzle-kit does not order view drops by dependency: if one of your own views selects from a branch view, drop it before the generated statements and recreate it after them (hand-edit the migration), or remove the edge. `checkViewDependencies` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` reports every such edge.

- [#201](https://github.com/thomasfosterau/effect-drizzle-ext/pull/201) [`0ddb37a`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/0ddb37a04e9513b0a4f4159d80e9381fc2cb8bab) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Resolve every derived view's head with an anti-join on the root version table's primary key instead of a grouped `max(version)` (effect-drizzle-ext#199). `makeTreeViews`' leaf, branch, keyed and as-of views now drive from the leaf's own version table and keep a row only when no newer root version of the node exists (`asOf` bounds both sides). Pointer views still drive from the effective pointer fact, and find the head row they read `action` from the same way. `makeCurrentVersionView` drives from the root version row with the same anti-join.
  
  PostgreSQL cannot push a filter or a `LIMIT` into a grouped subquery, so any read not filtered by `id` used to aggregate the whole root version table first. On the fixture chain with 150,000 root version rows (PostgreSQL 16, warm, `EXPLAIN (ANALYZE, BUFFERS)`, second run), with an index on `work_version (title, id)`:
  
  | read | before | after |
  | --- | --- | --- |
  | `book_view ORDER BY title, id LIMIT 20` | 531 ms, 551,771 buffers, an aggregate over `node_version` | 2.7 ms, 628 buffers, the index, no aggregate |
  | `book_view WHERE id = $1` | 0.29 ms, 28 buffers | 0.27 ms, 28 buffers |
  | `count(*) FROM book_view` | 353 ms, 601,731 buffers | 162 ms, 6,650 buffers |
  | `work_view ORDER BY title, id LIMIT 20` (branch) | 373 ms, 751,735 buffers | 241 ms, 308,006 buffers |
  
  The rows are the same: a view has a row exactly when every level has one at the node's maximum (bounded, for `asOf`) root version. A head that moved to another leaf or advanced past a level still yields no row, and a tombstone still shows with `action = 'delete'`. Row types and column order are unchanged.
  
  **Upgrading.** Every derived view's SQL changes, so your next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each view `makeTreeViews` or `makeCurrentVersionView` builds, with no table or data change. Regenerate and apply that migration. drizzle-kit does not order view drops by dependency: if one of your own views selects from a derived view, that view is not in the diff and the derived view's `DROP VIEW` fails. Drop your view before the generated statements and recreate it after them (hand-edit the migration), or remove the edge. `checkViewDependencies` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` reports every such edge.

### Patch Changes

- [#206](https://github.com/thomasfosterau/effect-drizzle-ext/pull/206) [`a7bd413`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/a7bd4139c3d9539ddba9b9aa9c48237784e8fc92) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - A branch view's `project` now LEFT JOINs the leaf tables read through any `SQLWrapper` embedded in its output (effect-drizzle-ext#204), not only through columns, tables and `sql` chunks; before, such a value created a view that failed with a missing FROM-clause entry.

- [#194](https://github.com/thomasfosterau/effect-drizzle-ext/pull/194) [`bbd0957`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/bbd0957a7956551b656d929b33153ae83eb9738b) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Accept `@thomasfosterau/effect-ext` `^0.2.0 || ^0.3.0`, so an app on effect-ext 0.3 installs one copy instead of a nested 0.2. The `./Ast` predicates and `LiteralExact.tuple` this package uses are unchanged in 0.3.0. (0.3.0 of this package shipped `^0.2.0` alone; its changelog's `^0.1.0 || ^0.2.0` was wrong about the 0.1 line, which isn't accepted.)

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
