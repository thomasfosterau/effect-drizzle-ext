# `./sort`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

The `?sort=` **resolution** seam: which fields a list may be sorted by, and the `ORDER BY` terms a decoded sort list becomes. The wire grammar (`?sort=-publishedAt,name`) is the request decoder's; what arrives here is a list of `SortKey`s (`{ field, direction }`).

`sortableColumnsFor(view, options?)` **derives** the allow-list from the view itself, rather than a hand-kept list: every column whose Drizzle `dataType` orders usefully (string, number, bigint, boolean, timestamp) under its own key, plus the version-chain names `options` configures. Its defaults match `./versioned-chain`'s conventions: `action` and the raw `timestamp` are internal; the aliased birth-row `createdAt` is admitted by name; `timestamp` is published as `updatedAt`. A document column, an embedding, and anything not in the view are refused. The derivation is memoised per view.

`resolveSortOrder({ view, sort, fallback?, tiebreak?, sortable? })` returns the caller's order when `sort` is non-empty, the resource's `fallback` otherwise, and **always closes with the view's `id`** so `LIMIT` / `OFFSET` paging is total-ordered. The tiebreak mirrors the last key's direction, and is left off when the caller already sorted by `id`. An unknown field fails the whole request with `UnsupportedSortError`, before any key is mapped. That is a `Schema.TaggedError` carrying `field`, the sorted `allowed` list (so the error document can say what the caller could have asked for) and `code: "unsupported.sort-field"`. A JSON:API boundary maps it to a 400 with `source: { parameter: "sort" }`. `chronologicalOrder({ view, sort, direction? })` is the commonest fallback spelled once: newest-first by `timestamp`, with a mirrored tiebreak.

Sorting a current-version view is bounded (the page keeps its `LIMIT`) but not index-backed; a client `?sort=` changes which column is sorted, not the cost class of the query.

```ts
export interface SortKey {
  readonly field: string;
  readonly direction: "asc" | "desc";
}
export type OrderTerm = PgColumn | SQL | SQL.Aliased;
export type SortableColumns = Readonly<Record<string, OrderTerm>>;
export class UnsupportedSortError /* Schema.TaggedError: field, allowed; code, message */ {}
export const sortableColumnsFor: (
  relation: Table | View,
  options?: SortableColumnsOptions, // { internal?, aliased?, renamed? }
) => SortableColumns;
export const resolveSortOrder: (
  options: ResolveSortOrderOptions,
) => Effect.Effect<ReadonlyArray<OrderTerm>, UnsupportedSortError>;
export const chronologicalOrder: (
  options: ChronologicalOrderOptions,
) => Effect.Effect<ReadonlyArray<OrderTerm>, UnsupportedSortError>;
```

```ts
const list = Effect.gen(function* () {
  const order = yield* resolveSortOrder({
    view: postView,
    sort: query.sort,
    fallback: [desc(postView.timestamp)],
    tiebreak: "desc",
  });
  return yield* db
    .select()
    .from(postView)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);
});
```
