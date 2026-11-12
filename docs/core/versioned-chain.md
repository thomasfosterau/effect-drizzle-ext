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

- **Per leaf, a fail-closed current-version view** (`${leaf}_view`). It resolves the head from the root version table and INNER JOINs every level's version table at it, so ancestor level columns appear with no per-anchor factory. Each level's stable columns come before its version columns. A node whose head advanced past any level yields **no row**.
- **Per marker named in `branches`, a `UNION ALL` branch view.** An optional per-leaf `project` builds a search union.
- **Per keyed leaf, a keyed view** (one row per key, and one `NULL`-key row for a head with none).
- **Per pointer and leaf named in `pointers`, the leaf view at the pointer's effective fact.** It projects the head's `action` and `${pointer}At`, and composes with the keyed view.
- **`asOf(leaf, { version } | { at })`:** the leaf view at an older point, as a subquery.

Every derived view reads base tables only, never another view. Each view's row type is derived from the tree. The write side is [`@thomasfosterau/effect-drizzle-ext-pg/chain`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/chain.md).

### Per-leaf builders

`makeSubtypeTables(applyDiscriminator)(schema, config)` builds one leaf's `{ stable, version }` pair: the stable identity row (`id` primary key referencing the parent branch's stable `id`, plus a denormalised `type` discriminator), and the version row (`(id, version)` primary key, `(id, version)` foreign-keyed to the parent branch's version table). Domain columns are authored per leaf and merged in via `config.columns`, and `config.stableColumns` / `config.stableConstraints` extend the stable row after `id` / `type` and after the discriminator constraints; `discriminator`, when present, makes `type` `NOT NULL` and appends the constraints `applyDiscriminator` returns (a `./constraints` `DiscriminatorToolkit` is the intended hook). Its return type, `SubtypeTables<TColumns, TStable>`, is written out as an explicit annotation rather than inferred — the declaration printer cannot reduce the homomorphic `PgBuildColumns` mapped type while `TColumns` is still generic, and would otherwise emit an unbound `TTableName` reference that `skipLibCheck` hides.

`makeCurrentVersionView(deps)(schema, name, config)` builds the uniform fail-closed current-version view: currency resolves from `deps.rootVersion` (a `MAX(version)` sub-select grouped by `id`), and `config.leaf` / `config.through` INNER JOIN at exactly that `(id, version)` — a node whose root version advanced past its leaf (a partial-chain tombstone) yields **no row**, rather than surfacing a stale older leaf row. `config.optional` LEFT JOINs 6NF satellite fact tables instead, where row-absence at a version encodes NULL. `deps.merge` can be a plain object (columns merged from `deps.identity`, no extra join, the emitted view definition unchanged) or a function (additionally INNER JOINs a `version = 0` alias of `rootVersion` and hands it to the callback, so a hierarchy can merge in a true `createdAt` sourced from the node's birth row, distinct from the current version's timestamp) — the object form matters for a root version table whose view is itself joined by another hand-written view, since drizzle-kit does not topologically order view-on-view DROPs.

**No view built by `makeCurrentVersionView` may select from another view built by `makeCurrentVersionView`** — a library-level rule, not just an observation about the DROP-ordering hazard above.

The read shapes of a chain are structural types, so a history listing and the page that renders it can share them without depending on an operations module. `VersionChainEntry<Action>` is one `{ version, action, timestamp }` row. `VersionSnapshot<Action, Extra>` is one version's reconstructed state: the entry plus `columns` (every leaf-chain domain column at that version) and whatever branch-level facts `Extra` names. `Action` defaults to `"create" | "update" | "delete"`. `versionTimestamps(row)` reads a current-version row's `createdAt` / `updatedAt` pair: `updatedAt` is the current `timestamp`, and `createdAt` comes from the birth-row merge, falling back to `updatedAt` for a view that has none.

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
