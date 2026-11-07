---
"@thomasfosterau/effect-drizzle-ext": minor
---

Pointer and keyed-fact levels for a tree (effect-drizzle-ext#116):

- **Keyed fact level.** A leaf entry in `defineTree` / `defineResourceTree` can declare `keyed: { name, columns }`: columns held once per `(id, version, key)`, such as a localised leaf's translated columns keyed by locale. `makeTreeTables` derives a `${leaf}_${name}` table keyed `(id, version, name)`, foreign-keyed to the leaf's version table, and `makeTreeViews` derives `${leaf}_${name}_view`: one row per key the head carries, and one row with a `NULL` key for a head that carries none. The shared leaf view stays one row per node. Throws `DerivationError` at module load for a keyed level on a marker, an empty name, a reserved or colliding key or column, or no columns.
- **Named pointers.** `makeTreeTables(tree, { root: { pointers: ["live"] } })` derives an append-only `${name}_pointer` log per name: `seq`, `id`, a nullable `version` foreign-keyed to the root version table, `at`, the actor, and `recorded_at`. Writing a pointer never appends a version. `makeTreeViews(..., { pointers: { live: ["book"] } })` derives `${leaf}_${name}_view` (plus `${leaf}_${keyed}_${name}_view` for a keyed leaf). It resolves the leaf view at the version named by the node's effective fact (the latest by `seq` whose `at` has arrived), fails closed there, reads `action` off the head, and projects the fact's `at` as `${name}At`. A cleared or absent pointer has no row.

`TreeTables` gains `keyed` and `pointers` members, and `AnyTreeTables` requires them. A hand-written `AnyTreeTables` value needs both, so the change is minor rather than patch.
