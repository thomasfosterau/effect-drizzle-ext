# `./versioned-chain`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

The opt-in interpreter for "a tree of levels, each a stable + version table pair, joined up a composite `(id, version)` FK chain to a root, with fail-closed current-version views" — the shape a temporal-versioned node hierarchy takes. `./versioned-chain` carries no application ontology; both factories are parameterised over the bits one hierarchy pins.

### The whole tree: `makeTreeTables` and `makeTreeViews`

`makeTreeTables(tree, { schema, builders, root?, levels? })` derives every table and constraint of a `defineTree` tree in one call. Column types still come from your builder registry:

- **The root:** the identity table (`id`, `type`, `root.identityColumns`; `UNIQUE (id, type)`, then `root.identityConstraints`) and the root version table, keyed `(id, version)`. The root version table carries `action` (CHECKed to `create` / `update` / `delete`, the single home of currency and tombstone state), `timestamp`, the actor and `root.versionColumns`.
- **Per level:** a stable table (`id` → parent, the `type` discriminator arced down the tree and CHECKed to the level's subtree leaves) and a version table (`(id, version)` → the parent's, cascading on delete) carrying its level and leaf columns and `levels[name].columns` hooks. A fact-scoped level gets its fact tables, a keyed leaf its `${leaf}_${name}` table, and each name in `root.pointers` an append-only `${name}_pointer` log.

Constraint names are canonical, and the same tree always generates the same migration.

**Stable columns** hold what a node keeps for life, such as an external key that must be unique across a leaf's nodes. A version table can't constrain that, because every version repeats it. `levels[name].stableColumns` appends columns to the level's stable table after `id` and `type`, and `levels[name].stableConstraints` appends constraints after the discriminator's. The constraint names are whatever your hook passes:

```ts
const tables = makeTreeTables(tree, {
  schema,
  builders,
  levels: {
    person: {
      stableColumns: { wikidataId: text("wikidata_id") },
      stableConstraints: (table) => [unique("person_wikidata_id_unique").on(table.wikidataId)],
    },
  },
});
```

The chain writes stable columns once, at `create`; no later write touches them. Every view whose path reaches the level projects them (INNER JOINed on `id`). A `stableColumns` key that the stable table (`id`, `type`) or the level's version table already has is a thrown `DerivationError`. So is a key another of a view's sources shares, which `makeTreeViews` reports. A tree with no stable hooks emits exactly the DDL and view SQL it did before.

`makeTreeViews(tree, tables, { schema, branches?, pointers? })` derives the read views:

- **Per leaf, a fail-closed current-version view** (`${leaf}_view`). It drives from the leaf's version table, keeps the head row (see [Head resolution](#head-resolution)) and INNER JOINs every other level's version table at it, so ancestor level columns appear with no per-anchor factory. Each level's stable columns come before its version columns. A node whose head advanced past any level yields **no row**.
- **Per marker named in `branches`, a branch view** (`${level}_view`): one row per node of the marker's subtree leaves, with the marker's path and the leaf `type` (see [Branch views](#branch-views)). An optional per-leaf `project` adds columns such as a search text.
- **Per keyed leaf, a keyed view** (one row per key, and one `NULL`-key row for a head with none).
- **Per pointer and leaf named in `pointers`, the leaf view at the pointer's effective fact.** It projects the head's `action` and `${pointer}At`, and composes with the keyed view.
- **`asOf(leaf, { version } | { at })`:** the leaf view at an older point, as a subquery.

Every derived view reads base tables only, never another view. Each view's row type is derived from the tree. The write side is [`@thomasfosterau/effect-drizzle-ext-pg/chain`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/chain.md).

#### Head resolution

A view keeps a leaf version row only when it is the node's head: no root version of the same node is newer. That is an anti-join on the root version table's `(id, version)` primary key (effect-drizzle-ext#199):

```sql
FROM <leaf>_version
JOIN <root>_version ON (id, version) match
-- identity, every other level, stable tables, facts, keyed, version_zero: at the same (id, version)
WHERE NOT EXISTS (
  SELECT 1 FROM <root>_version newer
  WHERE newer.id = <leaf>_version.id AND newer.version > <leaf>_version.version
)
```

The anti-join probes the primary key once per candidate row, so a paged list (`ORDER BY title, id LIMIT 20` with an index on the leaf's ordering column) reads a page's worth of rows. Before 0.4 every view drove from a grouped `SELECT id, max(version) … GROUP BY id` head instead. PostgreSQL cannot push a filter or a `LIMIT` into a grouped subquery, so every read not filtered by `id` aggregated the whole root version table first. On the fixture chain with 150,000 root version rows, `book_view ORDER BY title, id LIMIT 20` went from 531 ms (551,771 buffers) to 2.7 ms (628 buffers).

The set of rows is the same as the `max` head's: a row exists when every joined level has a row at the node's maximum root version. A head that moved to another leaf, or advanced past a level, has a newer root version, so the old leaf's view yields no row. A tombstone is the head, so it shows with `action = 'delete'`. A branch view drives from the branch level's own version table with the same anti-join (see [Branch views](#branch-views)). `asOf` bounds both sides, the joined root row and the `newer` one (`version <= v`, or `timestamp <= at`), so it resolves the latest version within the bound. A pointer view still drives from the effective pointer fact; the head row it reads `action` from is found by the same anti-join.

**Upgrading.** Every derived view's SQL changed, `makeCurrentVersionView`'s included. A consumer's next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each derived view, with no table or data change. Regenerate and apply that migration. drizzle-kit does not order view drops by dependency, so an application view that selects from a derived view must be dropped before that migration and recreated after it: hand-edit the generated migration, or better, remove the edge. `checkViewDependencies` in [`@thomasfosterau/effect-drizzle-ext-pg/tooling`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/tooling.md) fails on any such edge before a migration is generated.

#### Branch views

A branch view is one SELECT driven from the branch level's own version table (effect-drizzle-ext#200), not a `UNION ALL` of one arm per subtree leaf, and it joins nothing below the branch that it doesn't project (effect-drizzle-ext#204):

```sql
FROM <branch>_version
JOIN <root>_version, <root> (identity), version_zero, every level above the branch  -- INNER, at (id, version)
LEFT JOIN <level below the branch>  -- only a marker, leaf, stable or fact table `project` reads
WHERE NOT EXISTS (a newer <root>_version of the node)
  AND CASE <root>.type
        WHEN '<leaf 1>' THEN EXISTS (<its marker>_version at (id, version) OFFSET 0)
                         AND EXISTS (<leaf 1>_version at (id, version) OFFSET 0)
        WHEN '<leaf 2>' THEN ...
        ELSE false
      END
```

The `CASE` keeps the view fail-closed: a row needs every level on the path to the leaf its `type` names, at the head, so a head that skipped the leaf or a marker below the branch yields no row, as a leaf view's would. A `type` that names no subtree leaf, or is `NULL`, reaches `ELSE false` and yields no row. A node whose `type` names a leaf with no row at the head, while another leaf's row is there (old leaf rows kept past a move), yields no row either; the `UNION ALL` form showed that other leaf's row under the stale `type`. A level below the branch with `stableColumns` adds an `EXISTS` on its stable row to its leaves' arms. Columns, their order and the row type are unchanged. A `project` key becomes `CASE <root>.type WHEN '<leaf>' THEN <that leaf's value> … END`, named and decoded as the first leaf's value (a column every leaf returns as itself is selected bare); the tables it reads are LEFT JOINed, in declaration order, and nothing else below the branch is.

**Projected types.** Leaves whose values name columns of different SQL types are a thrown `DerivationError` at module load; a computed value that names no column is left to PostgreSQL's `CASE` type resolution. That includes pairs a `UNION ALL` used to unify (`varchar` and `text`, `integer` and `bigint`): cast or alias in `project` so every leaf names the same type, for example ``sql`${columns.key}::text`.as("key")``.

**Indexing.** Index the branch-level column a branch view is sorted by, through `levels.<branch>.extraConstraints` (`index("work_version_title_idx").on(table.title, table.id)`). Then `work_view ORDER BY title, id LIMIT 20` walks that index and stops after a page: the union sorted every branch row, since PostgreSQL plans each `UNION ALL` arm with joins as its own subquery. Sorting a branch view by a leaf-only (or `project`ed) column can't be served by an index: the value comes through a LEFT JOIN or a `CASE`, so it sorts.

Each `EXISTS` probe ends `OFFSET 0`, which keeps it a per-row index probe. Without that fence the planner costs the probe against the whole driver rather than a `LIMIT`'s share and hashes the subquery, which seq-scans every leaf table to serve one page: on a 200,000-node synthetic branch, a page executed in 104 ms at 20 leaves and 49–60 ms at 40 unfenced, against 1.9 ms and 2.4–2.6 ms fenced. The cost is `count(*)`, which visits every row and loses the hashed form: 1,218 ms unfenced against 1,601 ms fenced at 40 leaves, still below the old `UNION ALL` shape's 2,257 ms. On small tables, or a very wide branch with few rows, the planner may still choose a full scan plus a Sort for a paged list, because it costs the `CASE` inside a hash join as nearly free; on large tables it walks the branch index.

On the fixture chain (PostgreSQL 16.15, two leaves, 50,000 books and 50,000 essays at two versions each, a `work_version (title, id)` index, `EXPLAIN (ANALYZE, BUFFERS)`), `work_view ORDER BY title, id LIMIT 20` executes in 0.37 ms (2.1 ms planning), walking the index with no Sort; the `UNION ALL` form took 391 ms, a Sort over every row. The planner can still prefer a full scan and a Sort for a wide branch over few rows: it costs the `CASE` in a hash join as near free (seen with 30 leaves and 40,000 nodes). The plan spec pins the index walk for twelve leaves at 40,000 nodes; the synthetic numbers in the changelog are 200,000 nodes.

**Planning.** Each nullable LEFT JOIN multiplies the planner's join search, so the effect-drizzle-ext#200 form, which LEFT JOINed every marker and leaf, planned a 40-leaf page in about 1.5 s; the `CASE` form plans it in a few milliseconds, since it joins only the spine. That matters because a paged list re-plans: with `@effect/sql-pg`'s default named prepared statements and `plan_cache_mode = auto`, a `LIMIT $n` read stays on custom plans (PostgreSQL re-plans every call), while a by-id read switches to a generic plan after five executions.

**Page, then fetch.** A list that needs leaf columns is two reads: page the branch view's ids (`SELECT id FROM work_view ORDER BY title, id LIMIT 20`), then read each leaf's view by those ids (`book_view WHERE id = ANY($1)`). The page walks the branch index and the fetch probes primary keys, where projecting every leaf's columns through the branch view LEFT JOINs each of those leaves.

**Upgrading.** Only branch views' SQL changed (in effect-drizzle-ext#200 and again in effect-drizzle-ext#204): a consumer's next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each branch view, with no table or data change, and leaves every other view alone. The [head-resolution upgrade note](#head-resolution) on dependent application views applies the same way.

### Per-leaf builders

`makeSubtypeTables(applyDiscriminator)(schema, config)` builds one leaf's `{ stable, version }` pair: the stable identity row (`id` primary key referencing the parent branch's stable `id`, plus a denormalised `type` discriminator), and the version row (`(id, version)` primary key, `(id, version)` foreign-keyed to the parent branch's version table). Domain columns are authored per leaf and merged in via `config.columns`, and `config.stableColumns` / `config.stableConstraints` extend the stable row after `id` / `type` and after the discriminator constraints; `discriminator`, when present, makes `type` `NOT NULL` and appends the constraints `applyDiscriminator` returns (a `./constraints` `DiscriminatorToolkit` is the intended hook). Its return type, `SubtypeTables<TColumns, TStable>`, is written out as an explicit annotation rather than inferred — the declaration printer cannot reduce the homomorphic `PgBuildColumns` mapped type while `TColumns` is still generic, and would otherwise emit an unbound `TTableName` reference that `skipLibCheck` hides.

`makeCurrentVersionView(deps)(schema, name, config)` builds the uniform fail-closed current-version view: currency resolves from `deps.rootVersion` (its row with no newer version of the same node drives the FROM, the same anti-join as [head resolution](#head-resolution)), and `config.leaf` / `config.through` INNER JOIN at exactly that `(id, version)` — a node whose root version advanced past its leaf (a partial-chain tombstone) yields **no row**, rather than surfacing a stale older leaf row. `config.optional` LEFT JOINs 6NF satellite fact tables instead, where row-absence at a version encodes NULL. `deps.merge` can be a plain object (columns merged from `deps.identity`, no extra join, the emitted view definition unchanged) or a function (additionally INNER JOINs a `version = 0` alias of `rootVersion` and hands it to the callback, so a hierarchy can merge in a true `createdAt` sourced from the node's birth row, distinct from the current version's timestamp) — the object form matters for a root version table whose view is itself joined by another hand-written view, since drizzle-kit does not topologically order view-on-view DROPs.

**No view built by `makeCurrentVersionView` may select from another view built by `makeCurrentVersionView`** — a library-level rule, not just an observation about the DROP-ordering hazard above.

The read shapes of a chain are structural types, so a history listing and the page that renders it can share them without depending on an operations module. `VersionChainEntry<Action>` is one `{ version, action, timestamp }` row. `VersionSnapshot<Action, Extra>` is one version's reconstructed state: the entry plus `columns` (every leaf-chain domain column at that version) and whatever branch-level facts `Extra` names. `Action` defaults to `"create" | "update" | "delete"`. `versionTimestamps(row)` reads a current-version row's `createdAt` / `updatedAt` pair: `updatedAt` is the current `timestamp`, and `createdAt` comes from the birth-row merge, falling back to `updatedAt` for a view that has none.

The three read-shape types (`VersionAction`, `VersionChainEntry`, `VersionSnapshot`) are also exported from the Drizzle-free root entry, `@thomasfosterau/effect-drizzle-ext`, as the same types: a client-bundled package that only names them imports them from there and keeps `drizzle-orm` out of its module graph (effect-drizzle-ext#191).

```ts
export const makeSubtypeTables: <TDiscriminator>(
  applyDiscriminator: (
    level: string,
    stable: DiscriminatorColumns,
    discriminator: TDiscriminator,
  ) => PgTableExtraConfigValue[],
) => <
  TColumns extends Record<string, ColumnBuilderBase>,
  TStable extends Record<string, ColumnBuilderBase> = {},
>(
  schema: PgSchema,
  config: SubtypeTablesConfig<TColumns, TDiscriminator, TStable>,
) => SubtypeTables<TColumns, TStable>;
export const makeCurrentVersionView: <
  TRoot extends PgTable & VersionTable,
  TMerge extends ViewColumns,
>(
  deps: CurrentVersionViewDeps<TRoot, TMerge>,
) => <TColumns extends ViewColumns>(
  schema: PgSchema,
  name: string,
  config: CurrentVersionViewConfig<TColumns>,
) => CurrentVersionViewResult<TColumns, TMerge>;
export type VersionAction = "create" | "update" | "delete";
export interface VersionChainEntry<Action extends string = VersionAction> {
  readonly version: bigint;
  readonly action: Action;
  readonly timestamp: Date;
}
export type VersionSnapshot<
  Action extends string = VersionAction,
  Extra extends object = {},
> = VersionChainEntry<Action> & Extra & { readonly columns: Readonly<Record<string, unknown>> };
export const versionTimestamps: (row: {
  readonly timestamp: Date;
  readonly createdAt?: Date | null | undefined;
}) => { readonly createdAt: Date; readonly updatedAt: Date };
```
