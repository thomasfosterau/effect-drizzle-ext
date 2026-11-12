# @thomasfosterau/effect-drizzle-ext

The driver-free half of the bridge. `@thomasfosterau/effect-jsonapi` (an optional peer) is imported only by the `./jsonapi*` subpaths.

## Boundary

Imports nothing from this workspace (`.fallowrc.json` zone `core`, no outbound rule).

## Invariants

- **Optional config members follow the root rule** ([AGENTS.md → Conventions](../../AGENTS.md#conventions)): Drizzle-facing config is `?: T | undefined`, never `Option`; the boundary is stated once in `src/derive.ts`.
- **The derivation decides column _types_, never column _order_ or _names_.** Both are what a consumer's `db:generate` emits into a migration; a reorder here rewrites their schema.
- **Explicit return annotations wherever the inferred type mentions `PgBuildColumns` / `PgTableWithColumns` / `PgViewWithSelection`.** This package emits declarations and the applications never did: the declaration printer emits an unbound `TTableName` otherwise, and `skipLibCheck` hides it. `tests/dist-consumer` is the gate — its `Equals<…>` assertions fail against the resulting `any`; `vp run check` includes it.
- **`transact` is always-open, never join-if-present** (website #1883): a nested call opens a SAVEPOINT. Do not "improve" it into a join; the rationale travels verbatim in `src/database.ts`.
- **The root version table is the single home of `action`** (currency and tombstone state); `makeTreeTables` puts it nowhere else, and no level version table carries it.
- **Derived views fail closed**: every leaf, keyed, pointer and as-of view INNER JOINs every level's version table at the version it resolves, so a node whose head (or pointed version) advanced past a level yields no row, never a stale older one. A branch view is one SELECT driven from the branch level's version table (effect-drizzle-ext#200): it INNER JOINs its spine, LEFT JOINs the markers and leaves below it, and its `WHERE` requires, for the leaf the row's `type` names, every level below the branch on that leaf's path, so it fails closed at the same points (and drops a `type` naming a leaf with no row at the head). A pointer view reads `action` off the head, so a tombstone shows.
- **The head is an anti-join, never a grouped `max`**: a view keeps a row only when `NOT EXISTS` a newer root version of the node (bounded the same way for `asOf`), a probe of the root version's `(id, version)` primary key. A grouped `max(version)` head aggregates the whole root version table before any filter or `LIMIT` applies (effect-drizzle-ext#199).
- **Derived views read base tables only**, never another view (drizzle-kit doesn't order view-on-view DROPs; website #1228); the anti-join's `newer` reads the base root version table. A change to the arm builder must leave the existing views' emitted SQL byte-identical, or every consumer's next migration recreates them. The deliberate exceptions so far are effect-drizzle-ext#199 (the `max` head became the anti-join, for `makeCurrentVersionView` too) and effect-drizzle-ext#200 (branch views became one driver instead of a `UNION ALL` of leaf arms; leaf, keyed, pointer and as-of SQL unchanged), each shipped as a `minor` with an upgrade note; any further one needs the same: its own issue, a `minor` changeset that says so, and a regenerated fixture migration that is views only.
- **A pointer write never appends a version**: a pointer is an append-only log of facts naming a version (`NULL` clears it), never a column on the chain.
- **Derived DDL is canonical and deterministic**: constraint names follow one template (`${table}_pkey`, `${table}_${parent}_fk`, `${level}_id_type_unique` / `_fk` / `_type_valid`), with no per-table overrides (effect-drizzle-ext#112, decision 4), and the same tree always generates the same migration.
- **A refinable level cascades its whole subtree**: every `(id, type)` arc at or below it gets `ON UPDATE CASCADE`, or a flipped root `type` stops at the first non-cascading arc.
- **A tree keeps declaration order** wherever it becomes SQL order: level lists, subtree-leaf (CHECK value) lists and column order. A level name that is an array index is rejected because a JS object would reorder it.
- **No application vocabulary** (see the root rule): the version-chain column names `./sort` defaults to (`action`, `timestamp`, `createdAt`) and `versionTimestamps` reads are `./versioned-chain`'s conventions; `./sort` takes them as overridable options.
- **Every resolved sort order ends in the view's `id`** (website #972, #1231); matched by column _name_, since Drizzle hands back a fresh proxy per view-column access.

## Terms

- **Annotation entry** (`.`) — the `dbColumn` / `dbTable` vocabulary. Drizzle-free, so a client-bundled models package can import it.
- **Phantom** — the type-level metadata `dbColumn` / `dbTable` carry alongside the runtime annotation. Effect Schema erases annotation values from the static type; the phantom is what keeps a derived column map precise.
- **Builder registry** — a consumer's `Record<Kind, (column) => ColumnBuilderBase>`; the library ships no fixed set of column kinds.
- **Derivation error** — `DerivationError`, the one tagged error thrown at module load when a table or tree cannot be built (missing builder, unresolved reference, bounds without a column, a misdeclared tree level). Never an Effect failure: no runtime exists yet.
- **Tree** — `defineTree` (`.`) / `defineResourceTree` (`./jsonapi`): one Drizzle-free declaration of an ontology's levels. A **marker** level has no `leaf`; a **leaf** level carries its domain fields (or a resource whose `type` is its name), and its name is its discriminator value. A level's **level columns** reach every descendant's view; its **subtree leaves** are its discriminator CHECK value set. Built and checked at module load by the internal `src/tree.ts`; faults are thrown `DerivationError`. The tree decides structure, never column types (the builder registry does).
- **Chain** — a stable + version table pair; `./versioned-chain` knows only that shape, never an application's own level names.
- **Keyed fact level** — a leaf's `keyed: { name, columns }`: columns held once per `(id, version, key)` (a locale's translated columns), in a `${leaf}_${name}` table, read through `${leaf}_${name}_view` (one row per key, one `NULL`-key row for none).
- **Pointer** — a named, append-only `${name}_pointer` log (`root.pointers`); its **effective fact** per node is the latest by `seq` whose `at` has arrived, and a pointer view resolves the leaf at that fact's version. Publication semantics (draft, schedule, preview) stay in pulpit.
- **Sort seam** — `./sort`: a view's sortable allow-list is _derived_ from its columns (`sortableColumnsFor`), and every resolved order closes on `id` so paging is total. `UnsupportedSortError` is an Effect failure, not a throw.
- **Update tri-state** — `./update`: a value sets, a present `null` clears, an absent key / `undefined` carries forward; `updateSetMap` keeps the first two rows apart by dropping `undefined`.
- **Classified error** — a tagged Postgres failure (`UniqueViolation` …) recovered from a drizzle / `@effect/sql` error graph by `./errors`.
