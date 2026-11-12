# `./query`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

`totalCountColumn` spreads `(count(*) over ())::int` into a `.select({ … })` map; `pageOf` / `pageWithTotal` read it back off the first row into a `Page<T>`. `COUNT(*) OVER ()` is evaluated after `WHERE` and before `LIMIT`/`OFFSET`, so the unpaged total rides back on every row of the page a list read is already fetching — one round trip instead of a second sequential `count(*)` query.

A window function over zero rows returns nothing, so **an empty page reports `totalCount: 0`** — exact when nothing matches, and wrong only when a caller paged past the end of a non-empty collection. That case is self-describing (`items: []` says it) and self-correcting (paging back gives the true total); the alternative is a second query on every list read.

`combineFilters(...filters)` `AND`-joins the defined ones and returns `undefined` with none defined, so a caller omits `.where(...)` entirely rather than applying a vacuous `WHERE true`. `boundedPagination({ maxLimit, defaultLimit })` builds a `limit` / `offset` input schema bounded to `(0, maxLimit]` / `>= 0`, decoding absent keys to `defaultLimit` / `0`.

`executeRows` is a rows-normalising wrapper for raw-SQL reads (`db.execute<T>`): drizzle's effect-postgres driver types `db.execute<T>` as `readonly T[]`, but depending on the SQL client bound underneath, the query can resolve in "raw" mode with no row mapper and hand back the full driver result object (`{ rows, rowCount, … }`) instead — so `.map` on the yielded value throws. Every raw-SQL read that needs its rows should go through `executeRows` instead of `db.execute` directly; write-only executes (INSERT/DDL) that never read rows can keep calling `db.execute`. It decodes each row with the Schema you pass, so the rows are typed by what was checked, and a mismatch fails with `Schema.SchemaError`: ``executeRows(db, sql`SELECT n FROM t`, Schema.Struct({ n: Schema.Finite }))``.

```ts
export const totalCountColumn: { readonly __totalCount: SQL<number> };
export interface Page<T> {
  readonly items: readonly T[];
  readonly totalCount: number;
}
export const pageOf: <TRow, TResource>(
  rows: readonly TRow[],
  toResource: (row: TRow) => TResource,
) => Page<TResource>;
export const pageWithTotal: <TResource>(
  items: readonly TResource[],
  rows: readonly unknown[],
) => Page<TResource>;
export const combineFilters: (...filters: ReadonlyArray<SQL | undefined>) => SQL | undefined;
export const boundedPagination: (options: {
  readonly maxLimit: number;
  readonly defaultLimit: number;
}) => BoundedPagination;
export const executeRows: <S extends Schema.Decoder<unknown>>(
  db: {
    readonly execute: (
      query: SQLWrapper | string,
    ) => Effect.Effect<unknown, EffectDrizzleQueryError>;
  },
  query: SQLWrapper | string,
  row: S,
) => Effect.Effect<ReadonlyArray<S["Type"]>, EffectDrizzleQueryError | Schema.SchemaError>;
```
