/**
 * @copyright Thomas Foster
 *
 * List-read helpers: the unpaged-total window column and the {@link Page}
 * shape every list read returns, a variadic AND filter combinator, a bounded
 * limit/offset input schema, and the rows-normalising wrapper over a raw-SQL
 * `execute` that papers over a driver mismatch between typed and runtime
 * `db.execute` shapes.
 *
 * @module query
 */
import { and, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * The alias the unpaged total rides back on. Prefixed so it cannot collide
 * with a projected column, and so a clash surfaces as a visible key rather
 * than silently overwriting an attribute.
 */
export const TOTAL_COUNT_ALIAS = "__totalCount";

/**
 * The selection entry adding the unpaged total to a list query. Spread into
 * a `.select({ … })` map alongside the columns the read already projects:
 *
 * ```ts
 * db.select({ ...columns, ...totalCountColumn }).from(view).where(where)
 * ```
 *
 * `COUNT(*) OVER ()` is evaluated after `WHERE` and before `LIMIT`/`OFFSET`,
 * so it rides back on every row of the page the query was already
 * fetching — one round trip instead of a separate sequential `count(*)`
 * query for data the first one can already carry.
 */
export const totalCountColumn = {
  [TOTAL_COUNT_ALIAS]: sql<number>`(count(*) over ())::int`,
} as const;

/** One page of a list read: the window's rows plus the unpaged total. */
export interface Page<TResource> {
  readonly items: readonly TResource[];
  readonly totalCount: number;
}

/**
 * Reads the total off the first row — every row carries the same value,
 * since the window is evaluated over the whole matching set. Falls back to
 * `0` for an empty page: a window function over zero rows returns nothing,
 * so **an empty page reports `totalCount: 0`** — exact when nothing
 * matches, and wrong only when a caller paged past the end of a non-empty
 * collection. That case is self-describing (`items: []` says it) and
 * self-correcting (paging back gives the true total); the alternative is a
 * second query on every list read. The alias is added by
 * {@link totalCountColumn} outside the row's declared type, so it is
 * recovered by an `in` narrowing rather than a cast.
 */
const totalFrom = (rows: readonly unknown[]): number => {
  const first = rows[0];
  return Predicate.isObjectOrArray(first) && TOTAL_COUNT_ALIAS in first
    ? Number(first[TOTAL_COUNT_ALIAS])
    : 0;
};

/**
 * Build a {@link Page} from rows selected with {@link totalCountColumn},
 * mapping each row to its resource.
 */
export const pageOf = <TRow, TResource>(
  rows: readonly TRow[],
  toResource: (row: TRow) => TResource,
): Page<TResource> => ({
  items: rows.map(toResource),
  totalCount: totalFrom(rows),
});

/**
 * A {@link Page} over resources already mapped — for a list whose rows go
 * through several transformation steps before becoming resources, where
 * {@link pageOf}'s single mapper doesn't fit.
 */
export const pageWithTotal = <TResource>(
  items: readonly TResource[],
  rows: readonly unknown[],
): Page<TResource> => ({
  items,
  totalCount: totalFrom(rows),
});

/**
 * Combines a set of optional SQL filters into one `AND`-joined condition.
 * Filters an operation didn't build (an optional query parameter left
 * unset) are `undefined`; `and()` drops them, so passing every filter
 * unconditionally is safe. With no defined filter at all, the result is
 * `undefined` — the caller omits `.where(...)` entirely rather than
 * applying a vacuous `WHERE true`.
 */
/* oxlint-disable effect/prefer-option-over-null -- Drizzle-facing: mirrors drizzle-orm's own `and()` signature, which callers pass straight into `.where(...)` */
export const combineFilters = (...filters: ReadonlyArray<SQL | undefined>): SQL | undefined =>
  and(...filters);
/* oxlint-enable effect/prefer-option-over-null */

/**
 * Builds a `limit` / `offset` input schema bounded by `options`, plus the
 * two field schemas standalone (for a caller that validates them outside a
 * struct, e.g. against a query-string parameter one at a time).
 *
 * `limit` accepts an integer in `(0, maxLimit]`; `offset` accepts an
 * integer `>= 0`. Both keys are optional on input and decode to
 * `defaultLimit` / `0` respectively when absent, via
 * {@link Schema.withDecodingDefaultKey} — so `Input`'s decoded `Type` always
 * carries both fields, while its `Encoded` (request) side may omit either.
 */
export const boundedPagination = (options: {
  readonly maxLimit: number;
  readonly defaultLimit: number;
}) => {
  const { maxLimit, defaultLimit } = options;
  const Limit = Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: maxLimit, exclusiveMinimum: true })),
  );
  const Offset = Schema.Natural;
  const Input = Schema.Struct({
    limit: Limit.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultLimit))),
    offset: Offset.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  });
  return { Limit, Offset, Input };
};

/** The shape {@link boundedPagination} returns. */
export type BoundedPagination = ReturnType<typeof boundedPagination>;

/**
 * Rows-normalising wrapper for raw-SQL reads (`db.execute<T>`).
 *
 * drizzle-orm's effect-postgres driver types `db.execute<T>` as
 * `readonly T[]`, but depending on the SQL client bound underneath, the
 * query can resolve in "raw" mode with no row mapper, handing back the
 * full driver result object (`{ rows, rowCount, … }`) instead of a bare
 * array — so `.map` on the yielded value throws `rows.map is not a
 * function`. Every raw-SQL read should go through this helper instead of
 * `db.execute` directly: it accepts both shapes — array in → array out —
 * so which shape the underlying driver actually returns changes nothing
 * for call sites. Write-only executes (INSERT/DDL) that never read rows
 * may keep calling `db.execute` directly.
 *
 * `db` is typed to the narrowest shape this needs (`execute` alone),
 * widened so both a real Effect-Drizzle database and a stub client in a
 * test satisfy it without a cast.
 */
export const executeRows = <T extends Record<string, unknown>>(
  db: {
    readonly execute: (
      query: SQLWrapper | string,
    ) => Effect.Effect<unknown, EffectDrizzleQueryError>;
  },
  query: SQLWrapper | string,
): Effect.Effect<readonly T[], EffectDrizzleQueryError> =>
  Effect.map(db.execute(query), (result) =>
    Array.isArray(result)
      ? (result as readonly T[])
      : ((result as { rows?: readonly T[] }).rows ?? []),
  );
