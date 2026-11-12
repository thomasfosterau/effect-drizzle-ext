---
"@thomasfosterau/effect-drizzle-ext": minor
---

Fence the levels a `makeTreeViews` leaf, keyed, pointer and as-of view only needs to exist into one `CROSS JOIN LATERAL (… OFFSET 0) "tail"` keyed on the driver (effect-drizzle-ext#207). These views joined every level's version table, every stable row they project and every fact table as plain joins. PostgreSQL searched every join order on every plan, and a `LIMIT $n` read is re-planned on every call (always, with `prepare: false` behind a pooler). At three marker levels a paged list took 84 ms to plan and 2 ms to execute.

**The rule.** A level with columns of its own stays a plain join, so an index on them can still drive a filter or a sort; a level with no columns of its own (a pure marker, whose row only has to exist) and every level's stable row go in the tail, and the fact tables join it when there is one (LEFT JOINs inside it; a view with nothing to fence keeps them as plain LEFT JOINs). The tail is an inner join, so a head missing a level row still yields no row; it never NULLs one. The driver, the root version row, the identity row, the version-0 row (`createdAt`), a keyed row and a pointer's fact and head row stay plain joins. An upgrade never moves a column a consumer could sort or filter on out of reach of its index, except stable-row (`stableColumns`) and fact columns, which are now read per row from the tail.

**The new option, `fenced`.** `makeTreeViews(tree, tables, { …, fenced: ["series"] })` also moves a marker level with columns into the tail. Use it for a deep tree whose column-bearing levels are never filtered or sorted on. A fenced level's columns are read once per row: a sort on one runs the tail for every row and then sorts (0.8 s at 50,000 rows), and a filter on one can't use an index. A name that is not a marker level throws `DerivationError` at module load.

**What planning costs.** The planner's join search grows steeply with the relations outside the fence. On a synthetic leaf at three marker levels (50,000 leaf nodes at two versions plus 50,000 other nodes), planning ms for `ORDER BY title, id LIMIT 20`:

| plain marker levels | relations outside the fence | planning |
| ------------------- | --------------------------- | -------- |
| 0                   | 5                           | 3.6      |
| 1                   | 6                           | 11.2     |
| 2                   | 7                           | 41.2     |
| 3 (0.4.0's shape)   | 8                           | 74.9     |

The five are the driver, the root version row, the identity row, the version-0 row and the head anti-join's `newer`; a keyed table or a pointer's head row adds one. Each plain column-bearing level costs from about 8 ms (the sixth relation) to 30 ms or more (the seventh and later).

Plan / execution ms, the synthetic leaf at K pure marker levels, with indexes on the leaf's `(title, id)`, the root version's `timestamp` and an identity column:

| K   | read                                    | 0.4.0                 | this change |
| --- | --------------------------------------- | --------------------- | ----------- |
| 1   | page, `ORDER BY title, id LIMIT 20`     | 7.4 / 2.3             | 3.3 / 2.0   |
| 1   | by id                                   | 1.2 / 0.2             | 0.8 / 0.1   |
| 1   | `count(*)`                              | 2.9 / 194             | 1.7 / 336   |
| 3   | page, `ORDER BY title, id LIMIT 20`     | 83.6 / 2.3            | 3.4 / 2.0   |
| 3   | `ORDER BY created_at DESC, id LIMIT 20` | 84.9 / 3.1            | 5.3 / 5.0   |
| 3   | identity column `= $1`, page            | 63.4 / 32 (seq scan)  | 3.0 / 12    |
| 3   | join from 20 parent rows on `id`        | 22.2 / 426 (seq scan) | 3.1 / 0.8   |
| 3   | by id                                   | 5.4 / 0.3             | 1.1 / 0.2   |
| 3   | `count(*)`                              | 20.9 / 341            | 1.9 / 740   |

A column-bearing tree gains less. The fixture's deepest leaf, `volume`, sits under `collection` (`name`) and `series` (`cadence`, and a `code` stable column), with 50,000 volumes at two versions. Its view plans in 45 ms (page by `label`) and 41 ms (page by `name`), against 124 and 96 ms in 0.4.0. With `fenced: ["series"]` it plans in 13 and 18 ms. With `fenced: ["collection", "series"]` it plans in 6 and 3 ms, but the page by `name` then executes in 825 ms instead of 6. The trade-off everywhere is `count(*)`, which runs the tail once per row: 1.4–2.2× slower across runs (241 vs 413 ms for `volume`). `SET join_collapse_limit = 1` also flattened planning, but froze the written join order: 282 ms for the `created_at` sort and 360 ms for the parent join, so it is not a substitute.

Rows, columns, column order and column types are unchanged. This was checked with `EXCEPT ALL` both ways and against `information_schema.columns`:

- every fixture leaf, keyed and pointer view, against its 0.4.0 definition;
- `asOf` at several versions and times;
- generated trees of one and three pure markers;
- a three-level tree with columns and `fenced`.

The checks include heads that skipped a marker, the leaf's spine row or a required stable row. Branch views and `makeCurrentVersionView` are byte-identical, and so is every leaf, keyed and pointer view whose path has only column-bearing levels with no `stableColumns` and no facts.

**Upgrading.** Only leaf, keyed and pointer views that gain a tail change their SQL: those with a pure marker on their path (or, for a pointer view, a leaf with no columns of its own), a `stableColumns` level, a fact-scoped level, or a level you name in `fenced`. `asOf` is a query, not a view. Your next `drizzle-kit generate` emits a `DROP VIEW` and a `CREATE VIEW` for each changed view, with no table or data change. drizzle-kit does not order view drops by dependency. If one of your own views selects from a changed view, drop it before the generated statements and recreate it after them (hand-edit the migration), or remove the edge. `checkViewDependencies` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` reports every such edge. A root identity or version table named `tail` (`root.identity` / `root.version`) would share its name with the fence's alias, so `makeTreeViews` now throws `DerivationError` for one at module load.
