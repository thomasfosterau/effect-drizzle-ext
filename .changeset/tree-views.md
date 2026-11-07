---
"@thomasfosterau/effect-drizzle-ext": minor
---

`./versioned-chain` gains `makeTreeViews(tree, tables, { schema, branches })`, which derives a tree's read views from its `makeTreeTables` output (effect-drizzle-ext#115):

- **A fail-closed current-version view per leaf** (`${leaf}_view`). It resolves the head from the root version table, then INNER JOINs every level's version table from the branch root down to the leaf at that `(id, version)`, so ancestor level columns appear with no per-anchor factory. It projects `id`, `version`, `action`, the identity extras, each level's columns root-most first (a fact-scoped level's facts LEFT JOINed and nullable), `timestamp` and `createdAt` (the version-0 timestamp). A node whose head advanced past any level yields no row.
- **Branch views** (`${level}_view`) for the marker levels named in `branches`. Each is a `UNION ALL` over the marker's subtree leaves that projects `type` and the marker's own and inherited columns. An optional per-leaf `project` adds columns to every arm, for a search union.
- **`asOf(leaf, { version } | { at })`**: the leaf view resolved at the latest version at or below `version`, or written at or before `at`, as a subquery to select from. It fails closed in the same way.

Every derived view reads base tables only, never another view. Each view's row type is derived from the tree.
