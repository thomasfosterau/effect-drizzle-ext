---
"@thomasfosterau/effect-drizzle-ext": minor
---

Query-side helpers the applications duplicate:

- `./sort` — `sortableColumnsFor` (the sortable allow-list derived from a view's columns, memoised), `resolveSortOrder` / `chronologicalOrder` (the caller's `?sort=` or the resource's fallback, always closed with an `id` tiebreak), and `UnsupportedSortError` (a `Schema.TaggedError` carrying `field` and the `allowed` set).
- `./update` — `updateSetMap` / `insertValues`: the update tri-state (value sets, `null` clears, absent carries forward) as a typed `SET` / `VALUES` map.
- `./jsonapi` — `resourceAttributeProjections`: each resource attribute's `optional` / `nullable` / `array` / `date` shape and `dbColumn` column as plain data.
- `./versioned-chain` — the `VersionChainEntry` / `VersionSnapshot` read shapes (generic over the action vocabulary and a hierarchy's extra snapshot facts) and `versionTimestamps`.
