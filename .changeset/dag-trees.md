---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

A tree level may name several parents, so a type with several supertypes has a table layout: `defineTree({ …, ebook: { parent: ["printed", "digital"], leaf: { … } } })`.

- `defineTree` / `defineResourceTree` take `parent` as a name or a non-empty list of names. A level's `ancestors` are every parent's, a shared one listed once before every level below it, and `TreeLevel.parents` lists its parents (`parent` stays the first). Several parents must share one branch root, and none may be an ancestor of another; either fault throws `DerivationError`, as does a parent named twice.
- `makeTreeTables` gives such a level a row at every level of each parent's path: its stable and version tables arc to every parent, the first under the single-parent constraint names and each further one through `${level}_id_${parent}_id_fkey`, `${level}_id_type_${parent}_fk` (cascading when refinable) and `${level}_version_${parent}_version_fk`. Each parent's leaf and branch views list it, and its own views join both parents' levels and fail closed on either.
- `TreePathOf` follows every parent.
- pg's `LeafChain.refine` refines from any leaf on the target's path, adding every level the source's path lacks (the other parent's included), and `ChainRefinement` types the added levels the same way.

Single-parent trees emit exactly the DDL and view SQL they did, so no migration is generated for existing trees.
