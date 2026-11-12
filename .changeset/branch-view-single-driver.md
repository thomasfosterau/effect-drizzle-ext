---
"@thomasfosterau/effect-drizzle-ext": minor
---

Drive each `makeTreeViews` branch view from the branch level's own version table instead of a `UNION ALL` of one arm per subtree leaf (effect-drizzle-ext#200). PostgreSQL plans each `UNION ALL` arm that has joins as its own subquery, so no index order reached the top and a paged list sorted every branch row. A branch view is now one SELECT with the same anti-join head as the leaf views: it INNER JOINs the root version row, the identity row, the birth row and the levels down to the branch, then LEFT JOINs each marker below the branch and each subtree leaf at the head. A fail-closed `WHERE` keeps a row only when the leaf its `type` names, and every marker on the way to it, has a row at the head. An index on the branch-level column you sort by (`levels.<branch>.extraConstraints`) now serves `ORDER BY … LIMIT`. Sorting by a leaf-only column can't be index-served.

PostgreSQL 16, `EXPLAIN (ANALYZE, BUFFERS)`, second run:

| read | before | after |
| --- | --- | --- |
| fixture `work_view ORDER BY title, id LIMIT 20` (100,000 works at two versions, `work_version (title, id)` index) | 391 ms, a Sort over every row | ~2.3 ms, the index, no Sort |
| synthetic 20-leaf branch, paged list | 2,385 ms | 4.9 ms |
| synthetic 20-leaf branch, `WHERE id = $1` | 1.86 ms | 0.88 ms |
| synthetic 20-leaf branch, `count(*)` | 1,753 ms | 1,911 ms |

The rows, columns, column order and row types are the same as before, checked against the `UNION ALL` definitions with `EXCEPT ALL`. **Behaviour change:** a node whose `type` names one leaf while only another leaf's row exists at the head now yields **no row** in the branch view. The union returned that other leaf's row labelled with the stale `type`, a row that contradicts itself. This shape is only reachable by bypassing the `(id, type)` foreign-key chain (old leaf rows kept past a move). Every other row is unchanged. A per-leaf `project` key becomes one `CASE` on `type`, named and decoded as the first leaf's value. Leaves that project the same key from columns of different SQL types now throw `DerivationError` at module load, and so does an unaliased projected expression.

**Upgrading.** Only branch views' SQL changes. Your next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each branch view, with no table or data change; leaf, keyed, pointer and as-of views are byte-identical. drizzle-kit does not order view drops by dependency: if one of your own views selects from a branch view, drop it before the generated statements and recreate it after them (hand-edit the migration), or remove the edge. `checkViewDependencies` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` reports every such edge.
