---
"@thomasfosterau/effect-drizzle-ext": minor
---

Fail a `makeTreeViews` branch view closed with a `CASE` on `type` instead of a LEFT JOIN per leaf (effect-drizzle-ext#204). The single-driver branch view (effect-drizzle-ext#200) LEFT JOINed every marker below the branch and every subtree leaf, and its planning time grew with those nullable joins: a paged list planned in 143 ms at 8 leaves and 1,523 ms at 40, and a `LIMIT $n` read re-plans on every call. The driver, the anti-join head and the INNER spine are unchanged; the `WHERE` is now `CASE type WHEN '<leaf>' THEN EXISTS (<each marker between the branch and the leaf>) AND EXISTS (<the leaf's row>) [AND EXISTS (<a lower stable row>)] … ELSE false END`, each probe at the driver's `(id, version)` and ending `OFFSET 0`, so PostgreSQL keeps it a per-row index probe rather than hashing it (hashed, a 20-leaf page seq-scanned every leaf table: 47–104 ms). A level below the branch is LEFT JOINed only when `project` reads one of its columns; a branch with no per-leaf projection joins no leaf. A `type` naming no subtree leaf, or `NULL`, yields no row.

Plan / execution ms, PostgreSQL 16, synthetic branch of 200,000 nodes at two versions under two marker levels, `ORDER BY title, id LIMIT 20` for the page. "CASE (unfenced prototype)" is the `CASE` without `OFFSET 0`; "shipped (fenced)" is the `CASE` with it. "not re-measured" marks a cell never measured fenced; "-" a plan time not recorded:

| leaves | read       | effect-drizzle-ext#200 | CASE (unfenced prototype) | shipped (fenced)  |
| ------ | ---------- | ---------------------- | ------------------------- | ----------------- |
| 8      | page       | 143 / 3.4              | 4.4 / 1.8                 | not re-measured   |
| 8      | by id      | 4.7 / 0.6              | 2.0 / 0.4                 | not re-measured   |
| 8      | `count(*)` | 17 / 1,407             | 2.3 / 1,005               | not re-measured   |
| 20     | page       | 489 / 4.8              | 4.0 / 104                 | 4.4 / 1.9         |
| 20     | by id      | 8.8 / 1.0              | 3.1 / 0.7                 | not re-measured   |
| 20     | `count(*)` | 35 / 2,061             | 3.3 / 1,245               | not re-measured   |
| 40     | page       | 1,523 / 7.7            | 5.5-6.0 / 49-60           | 5.3-5.4 / 2.4-2.6 |
| 40     | by id      | 26.8 / 2.6             | 4.2 / 1.1                 | - / 1.3           |
| 40     | `count(*)` | 52 / 3,380             | 5.6 / 1,176               | - / 1,601         |

The fenced cells are the shipped `OFFSET 0` form; the page rows were measured twice each (20 leaves: 4.4 / 1.9 and 3.7 / 1.9; 40 leaves: 5.4 / 2.6 and 5.3 / 2.4). The unfenced prototype planned a hashed probe per leaf and executed the 20-leaf page in 104 ms and the 40-leaf page in 60 ms and 49 ms. The other prototype rows were never re-measured with `OFFSET 0`; at 40 leaves, a separate unfenced run gave by id 1.6 ms and `count(*)` 1,218 ms (execution), against 1.3 ms and 1,601 ms fenced. On the fixture chain (two leaves, 50,000 books and 50,000 essays at two versions each, a `work_version (title, id)` index), `work_view ORDER BY title, id LIMIT 20` executes in 0.37 ms.

The rows, columns, column order and row types are the same as effect-drizzle-ext#200's, checked with `EXCEPT ALL` against the earlier `UNION ALL` definitions for the fixture branches and for generated branches of 12 and 30 leaves, including that release's tightening: a node whose `type` names a leaf with no row at the head (or names no subtree leaf) yields no row. Leaf, keyed, pointer and as-of views, and `makeCurrentVersionView`, are byte-identical.

**Upgrading.** Only branch views' SQL changes. Your next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each branch view, with no table or data change. drizzle-kit does not order view drops by dependency: if one of your own views selects from a branch view, drop it before the generated statements and recreate it after them (hand-edit the migration), or remove the edge. `checkViewDependencies` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` reports every such edge. Since effect-drizzle-ext#200, leaves that `project` one key from columns of different SQL types throw `DerivationError` at module load, including pairs a `UNION ALL` used to unify (`varchar` and `text`, `integer` and `bigint`); cast or alias in `project` so every leaf names one type, for example ``sql`${columns.key}::text`.as("key")``.
