---
"@thomasfosterau/effect-drizzle-ext": patch
---

A branch view's `project` now LEFT JOINs the leaf tables read through any `SQLWrapper` embedded in its output (effect-drizzle-ext#204), not only through columns, tables and `sql` chunks; before, such a value created a view that failed with a missing FROM-clause entry.
