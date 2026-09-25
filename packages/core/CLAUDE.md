# packages/core — `@thomasfosterau/effect-drizzle-ext`

The driver-free half of the bridge. Peers: `effect`, `drizzle-orm`; `@thomasfosterau/effect-jsonapi` is an **optional** peer that only the `./jsonapi*` subpaths import.

## Terms

- **Annotation entry** (`.`) — the `dbColumn` / `dbTable` vocabulary. Drizzle-free, so a client-bundled models package can import it.
- **Phantom** — the type-level metadata `dbColumn` / `dbTable` carry alongside the runtime annotation. Effect Schema erases annotation values from the static type; the phantom is what keeps a derived column map precise.
- **Builder registry** — a consumer's `Record<Kind, (column) => ColumnBuilderBase>`; the library ships no fixed set of column kinds.
- **Derivation error** — `DerivationError`, the one tagged error thrown at module load when a table cannot be built (missing builder, unresolved reference, bounds without a column). Never an Effect failure: no runtime exists yet.
- **Chain** — a stable + version table pair; `./versioned-chain` knows only that shape, never an application's level ontology.
- **Sort seam** — `./sort`: a view's sortable allow-list is _derived_ from its columns (`sortableColumnsFor`), and every resolved order closes on `id` so paging is total. `UnsupportedSortError` is an Effect failure, not a throw.
- **Update tri-state** — `./update`: a value sets, a present `null` clears, an absent key / `undefined` carries forward; `updateSetMap` keeps the first two rows apart by dropping `undefined`.
- **Classified error** — a tagged Postgres failure (`UniqueViolation` …) recovered from a drizzle / `@effect/sql` error graph by `./errors`.

## Local invariants

- **The derivation decides column _types_, never column _order_ or _names_.** Both are what `db:generate` emits into a migration.
- **Drizzle-facing config members are `?: T | undefined`, never `Option`.** Drizzle reads `undefined` as "not supplied" and would emit an `Option` as a value — wrong DDL no test catches. Readers the library owns return `Option`.
- **Explicit return annotations wherever the inferred type mentions `PgBuildColumns` / `PgTableWithColumns` / `PgViewWithSelection`.** The declaration printer emits an unbound `TTableName` otherwise, and `skipLibCheck` hides it; `tests/dist-consumer` is the gate — its `Equals<…>` assertions fail against the resulting `any`.
- **No application vocabulary**: no `owner_id`, no role ladders, no `node` / `node_version`, no id brands. The version-chain column names `./sort` defaults to (`action`, `timestamp`, `createdAt`) and `versionTimestamps` reads are `./versioned-chain`'s conventions; `./sort` takes them as overridable options.
- **Every resolved sort order ends in the view's `id`** (website #972, #1231); matched by column _name_, since Drizzle hands back a fresh proxy per view-column access.

## Boundary

Imports nothing from this workspace (`.fallowrc.json` zone `core`, no outbound rule).
