---
"@thomasfosterau/effect-drizzle-ext": minor
---

`defineTree` (`.`) and `defineResourceTree` (`./jsonapi`) declare an ontology's level tree once, Drizzle-free: marker and leaf levels, each naming its `parent`, with optional level `columns` (contributed to every descendant's view) and a level `kind` (`"plain"` or `"fact-scoped"`). The returned `Tree` gives every level's ancestors, children, descendants, subtree leaves (the discriminator CHECK value set) and branch in declaration order. A parent naming no level is a type error; every other structural fault (a cycle, a leaf with children, a marker with no leaf, an unannotated level column, a reserved column name, a column clash on a root-to-leaf path, a resource whose `type` isn't its level's name) throws `DerivationError` at module load. `defineTreeFor<Ext>()` / `defineResourceTreeFor<Ext>()` add a consumer extension record to every entry. `DerivationError` is now also exported from `.`; it is the same class `./derive` exports.
