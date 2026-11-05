---
"@thomasfosterau/effect-drizzle-ext": minor
---

`makeTreeTables` (`./versioned-chain`) derives every table and constraint of a `defineTree` / `defineResourceTree` tree in one call. That is a root identity table and a root version table: `(id, version)` key, `action` checked to `create` / `update` / `delete`, `timestamp`, an actor column, and injected extras. Each level then gets a stable + version pair with the composite `(id, version)` FK chain, and the discriminator trio (`UNIQUE (id, type)`, `(id, type)` → parent, and a CHECK narrowing `type` to the subtree's leaves) at every level. A fact-scoped level gets an `(id, version)` spine plus one fact table per column. Per-level hooks add hand-authored columns and extra constraints, or mark a refinable branch, whose `(id, type)` arcs cascade updates. Every table is typed from the tree, and constraint names are canonical.

Breaking: `SubtypeTablesConfig` loses `constraintNames`, `versionIdColumn` and `parentUpdateCascade`. Derived names are canonical, and the historical overrides go (no consumer schema is deployed yet).
