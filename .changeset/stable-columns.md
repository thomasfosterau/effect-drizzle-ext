---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Per-level stable-table columns and constraints (effect-drizzle-ext#188). They hold an external key that must be unique across a leaf's nodes, which a version table can't constrain because every version repeats it.

- `makeTreeTables`: a level's `stableColumns` hook appends columns to its stable table after `id` / `type`, and `stableConstraints` appends constraints after the discriminator's. `root.identityConstraints` does the same for the identity table, after `UNIQUE (id, type)`. `makeSubtypeTables` takes `stableColumns` / `stableConstraints` too, and `SubtypeTables` gains a defaulted `TStable` parameter. A `stableColumns` key the stable table (`id`, `type`) or the level's version table already has throws `DerivationError` at module load.
- `makeTreeViews`: every view whose path reaches the level projects its stable columns, before its version columns, INNER JOINed on `id`. They're typed through `TreeLeafSelection` / `TreeBranchSelection` and handed to a branch's `project`. A key another of the view's sources shares throws `DerivationError`.
- `./chain`: `create` takes `stable` (`ChainStableExtras`), keyed by field across the leaf's path. No other write touches a stable row.

The change is additive: a tree without these hooks emits the same DDL and view SQL as before.
