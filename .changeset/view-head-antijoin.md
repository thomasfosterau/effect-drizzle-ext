---
"@thomasfosterau/effect-drizzle-ext": minor
---

Resolve every derived view's head with an anti-join on the root version table's primary key instead of a grouped `max(version)` (effect-drizzle-ext#199). `makeTreeViews`' leaf, branch, keyed and as-of views now drive from the leaf's own version table and keep a row only when no newer root version of the node exists (`asOf` bounds both sides). Pointer views still drive from the effective pointer fact, and find the head row they read `action` from the same way. `makeCurrentVersionView` drives from the root version row with the same anti-join.

PostgreSQL cannot push a filter or a `LIMIT` into a grouped subquery, so any read not filtered by `id` used to aggregate the whole root version table first. On the fixture chain with 150,000 root version rows (PostgreSQL 16, warm, `EXPLAIN (ANALYZE, BUFFERS)`, second run), with an index on `work_version (title, id)`:

| read | before | after |
| --- | --- | --- |
| `book_view ORDER BY title, id LIMIT 20` | 531 ms, 551,771 buffers, an aggregate over `node_version` | 2.7 ms, 628 buffers, the index, no aggregate |
| `book_view WHERE id = $1` | 0.29 ms, 28 buffers | 0.27 ms, 28 buffers |
| `count(*) FROM book_view` | 353 ms, 601,731 buffers | 162 ms, 6,650 buffers |
| `work_view ORDER BY title, id LIMIT 20` (branch) | 373 ms, 751,735 buffers | 241 ms, 308,006 buffers |

The rows are the same: a view has a row exactly when every level has one at the node's maximum (bounded, for `asOf`) root version. A head that moved to another leaf or advanced past a level still yields no row, and a tombstone still shows with `action = 'delete'`. Row types and column order are unchanged.

**Upgrading.** Every derived view's SQL changes, so your next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each view `makeTreeViews` or `makeCurrentVersionView` builds, with no table or data change. Regenerate and apply that migration. drizzle-kit does not order view drops by dependency: if one of your own views selects from a derived view, that view is not in the diff and the derived view's `DROP VIEW` fails. Drop your view before the generated statements and recreate it after them (hand-edit the migration), or remove the edge. `checkViewDependencies` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` reports every such edge.
