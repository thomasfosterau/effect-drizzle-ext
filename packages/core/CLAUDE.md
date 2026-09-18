# packages/core — `@thomasfosterau/effect-drizzle-ext`

The driver-free half of the bridge. Peers: `effect`, `drizzle-orm`; `@thomasfosterau/effect-jsonapi` is an **optional** peer that only the `./jsonapi*` subpaths import.

## Terms

- **Annotation entry** (`.`) — the `dbColumn` / `dbTable` vocabulary. Drizzle-free, so a client-bundled models package can import it.
- **Phantom** — the type-level metadata `dbColumn` / `dbTable` carry alongside the runtime annotation. Effect Schema erases annotation values from the static type; the phantom is what keeps a derived column map precise.
- **Builder registry** — a consumer's `Record<Kind, (column) => ColumnBuilderBase>`; the library ships no fixed set of column kinds.
- **Derivation error** — `DerivationError`, the one tagged error thrown at module load when a table cannot be built (missing builder, unresolved reference, bounds without a column). Never an Effect failure: no runtime exists yet.
- **Chain** — a stable + version table pair; `./versioned-chain` knows only that shape, never an application's level ontology.
- **Classified error** — a tagged Postgres failure (`UniqueViolation` …) recovered from a drizzle / `@effect/sql` error graph by `./errors`.

## Local invariants

- **The derivation decides column _types_, never column _order_ or _names_.** Both are what `db:generate` emits into a migration.
- **Drizzle-facing config members are `?: T | undefined`, never `Option`.** Drizzle reads `undefined` as "not supplied" and would emit an `Option` as a value — wrong DDL no test catches. Readers the library owns return `Option`.
- **Explicit return annotations wherever the inferred type mentions `PgBuildColumns` / `PgTableWithColumns` / `PgViewWithSelection`.** The declaration printer emits an unbound `TTableName` otherwise, and `skipLibCheck` hides it; `tests/dist-consumer` is the gate.
- **No application vocabulary**: no `owner_id`, no role ladders, no `node` / `node_version`, no id brands.

## Boundary

Imports nothing from this workspace (`.fallowrc.json` zone `core`, no outbound rule).
