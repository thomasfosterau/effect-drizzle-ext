---
"@thomasfosterau/effect-drizzle-ext": minor
---

`makeTreeViews` now throws `DerivationError` at module load when two of a view's sources share a column key, naming the key and both sources. Previously the later source silently won. This covers a level column named like a `root.identityColumns` extra (the `slug` trap), a level column named `timestamp` or `createdAt`, and a branch `project` key the view already selects. The emitted SQL of every view without a clash is unchanged.

**Migration:** if a tree now throws, rename one of the two columns' keys. For a branch view, return the projected column from `project` under a key the view doesn't already select. The view that loaded before was missing one of the two columns.
