/**
 * @copyright Thomas Foster
 *
 * **The `?sort=` resolution seam: which fields a list may be sorted by, and
 * the `ORDER BY` terms a decoded sort list becomes.**
 *
 * The wire grammar (`?sort=-publishedAt,name`) and its bounds are the
 * request decoder's: by the time anything here runs, a malformed or
 * over-wide `?sort=` has already been refused, and what arrives is a list of
 * {@link SortKey}s. What this module owns is the half that needs to know
 * about columns — **which** fields a view may be sorted by, and what SQL each
 * one becomes.
 *
 * ## The allow-list is derived, not hand-listed
 *
 * {@link sortableColumnsFor} derives a view's sortable set from the view
 * itself, filtered to columns of a scalar, orderable type and published under
 * stable public names:
 *
 * - every column whose Drizzle `dataType` is a string / number / bigint /
 *   boolean / timestamp, under the column's own key;
 * - the {@link SortableColumnsOptions.aliased | aliased} expressions it is
 *   told to admit by name (a `SQL.Aliased` carries no `dataType`) —
 *   by default `createdAt`, the birth-row timestamp a function `merge` of
 *   `./versioned-chain`'s `makeCurrentVersionView` merges in;
 * - the {@link SortableColumnsOptions.renamed | renamed} columns under their
 *   public names — by default the current version's `timestamp` as
 *   `updatedAt`.
 *
 * Everything else is refused with {@link UnsupportedSortError}: a field that
 * does not exist, a column whose type has no useful order (a document
 * column, an embedding), and the version-chain internals
 * ({@link SortableColumnsOptions.internal}, by default `action` and the raw
 * `timestamp` key) that are not part of any resource's vocabulary. Deriving
 * is what makes the surface uniform: a resource gains its sort surface by
 * existing, and a new attribute is sortable the moment its column lands in
 * the view. A resource whose sortable set the view cannot express passes an
 * explicit `sortable` map instead.
 *
 * ## Cost
 *
 * Sorting here is bounded but not necessarily index-backed: a current-version
 * view is a projection over an append-only chain, so the database
 * materialises the current set and sorts it whatever the `ORDER BY` is. A
 * client `?sort=` changes *which* column is sorted, not the cost class of the
 * query, and the page stays `LIMIT`-bounded exactly as before. If a view
 * grows past the point where sorting its whole current set is cheap, the fix
 * is an indexed ordering column, not a narrower allow-list.
 *
 * ## Total order (website #972, #1231)
 *
 * `LIMIT` / `OFFSET` over a non-total order lets a row repeat across pages or
 * fall through the gap between them. Every order {@link resolveSortOrder}
 * returns therefore ends in the view's `id`, mirroring the direction of the
 * last sort key, unless the caller already sorted by `id`.
 *
 * Ported from the website and gardeneria applications'
 * `apps/api/src/operations/sort.ts`.
 *
 * @module sort
 */

import { asc, desc, getColumns, SQL } from "drizzle-orm";
import type { Table, View } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Predicate from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

/**
 * One decoded `?sort=` key: a public field name and its direction. The
 * structural shape every JSON:API sort decoder produces (`-name` →
 * `{ field: "name", direction: "desc" }`); nothing here depends on which
 * decoder that is.
 */
export interface SortKey {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/**
 * An `ORDER BY` term: a column reference or a SQL expression (including a
 * `SQL.Aliased` view column) — exactly what a Postgres select's `.orderBy()`
 * spreads, and what Drizzle's `asc` / `desc` take.
 */
export type OrderTerm = PgColumn | SQL | SQL.Aliased;

/** Public sort-field name → the `ORDER BY` term it resolves to. */
export type SortableColumns = Readonly<Record<string, OrderTerm>>;

/**
 * A relation {@link resolveSortOrder} can sort: a Drizzle table or view whose
 * selection carries the `id` column the total-order tiebreak closes on.
 */
export type SortableRelation = (Table | View) & { readonly id: PgColumn };

/**
 * A caller asked to sort by a field the resource does not expose.
 *
 * `allowed` is carried so the error document can tell the caller what it
 * *could* have asked for — the discovery mechanism for a set that is derived
 * rather than published in the endpoint schema. `code` is the stable
 * machine-readable name (`unsupported.sort-field`, the sort-axis counterpart
 * of an include walk's `unsupported.include-path`); a JSON:API boundary maps
 * the error to a 400 with `source: { parameter: "sort" }`.
 */
export class UnsupportedSortError extends Schema.TaggedError<UnsupportedSortError>()(
  "UnsupportedSortError",
  {
    field: Schema.String,
    allowed: Schema.Array(Schema.String),
  },
) {
  /** The stable machine-readable error code. */
  get code(): "unsupported.sort-field" {
    return "unsupported.sort-field";
  }

  override get message(): string {
    return `unsupported.sort-field: ${this.field}. Sortable fields: ${Arr.match(this.allowed, {
      onEmpty: () => "(none)",
      onNonEmpty: (allowed) => allowed.join(", "),
    })}`;
  }
}

/* oxlint-disable effect/prefer-option-over-null -- an options bag a caller forwards its own optionals into (a decoded `?sort=` is absent when the request carried none); `?: T | undefined` is what lets it pass `{ sort: query.sort }` under `exactOptionalPropertyTypes`, and an `Option` there would only be unwrapped on the next line. Same shape as the applications' signature. */
/**
 * How {@link sortableColumnsFor} names the version-chain columns of a view.
 * Every member defaults to the convention `./versioned-chain`'s
 * `makeCurrentVersionView` documents (an `action` soft-delete gate, the
 * current version's `timestamp`, a birth-row `createdAt`).
 */
export interface SortableColumnsOptions {
  /** Column keys never published as sort fields. Default `["action", "timestamp"]`. */
  readonly internal?: ReadonlyArray<string> | undefined;
  /**
   * Aliased expressions (`SQL.Aliased`, which carry no `dataType`) admitted by
   * name. Default `["createdAt"]`.
   */
  readonly aliased?: ReadonlyArray<string> | undefined;
  /**
   * Public name → the view key it publishes. Applied after `internal`, so an
   * internal key can still be published under its resource-facing name.
   * Default `{ updatedAt: "timestamp" }`.
   */
  readonly renamed?: Readonly<Record<string, string>> | undefined;
}

/* oxlint-enable effect/prefer-option-over-null */

const DEFAULT_INTERNAL: ReadonlyArray<string> = ["action", "timestamp"];
const DEFAULT_ALIASED: ReadonlyArray<string> = ["createdAt"];
const DEFAULT_RENAMED = { updatedAt: "timestamp" } satisfies Readonly<Record<string, string>>;

/**
 * Drizzle `dataType` base tokens that order usefully. The descriptor is
 * space-separated with the base type first (`string`, `string uuid`,
 * `number int32`, `object date`, …); timestamps' base token is the useless
 * `object`, so they are matched in full. What this excludes is the point:
 * `custom` columns and `array vector` embeddings have no meaningful scalar
 * order.
 */
const SORTABLE_BASE_TYPES: HashSet.HashSet<string> = HashSet.make(
  "string",
  "number",
  "bigint",
  "boolean",
);

const isSortableColumn = (term: OrderTerm): boolean => {
  if (!Predicate.hasProperty(term, "dataType") || !Predicate.isString(term.dataType)) return false;
  if (term.dataType === "object date") return true;
  return HashSet.has(SORTABLE_BASE_TYPES, term.dataType.split(" ")[0] ?? "");
};

/**
 * Derived maps, memoised per relation and options object. A view is a
 * module-scope value and the derivation walks every column, so recomputing
 * it per list request would be pure waste. Only the default-options
 * derivation is memoised: an options object is usually a fresh literal, and
 * keying on it would only grow the cache.
 */
const derived = new WeakMap<object, SortableColumns>();

/** {@link SortableColumnsOptions} with every default applied. */
interface ResolvedNames {
  readonly internal: HashSet.HashSet<string>;
  readonly aliased: HashSet.HashSet<string>;
  readonly renamed: Readonly<Record<string, string>>;
}

const resolveNames = (options: SortableColumnsOptions = {}): ResolvedNames => ({
  internal: HashSet.fromIterable(options.internal ?? DEFAULT_INTERNAL),
  aliased: HashSet.fromIterable(options.aliased ?? DEFAULT_ALIASED),
  renamed: options.renamed ?? DEFAULT_RENAMED,
});

/**
 * Whether one view entry is published under its own key. A `SQL.Aliased`
 * view column carries no `dataType`, so it is admitted by name; Drizzle
 * renders it in `ORDER BY` as `"<view>"."<alias>"`, which is exactly right in
 * the outer query.
 */
const admits = (names: ResolvedNames, key: string, term: OrderTerm): boolean => {
  if (HashSet.has(names.internal, key)) return false;
  if (term instanceof SQL.Aliased) return HashSet.has(names.aliased, key);
  return isSortableColumn(term);
};

const deriveSortable = (relation: Table | View, names: ResolvedNames): SortableColumns => {
  // SAFETY: `getColumns` returns the relation's column / selected-field map;
  // its conditional return type does not resolve for the `Table | View`
  // union, but every value is a column or a SQL expression.
  const columns = getColumns(relation) as Record<string, OrderTerm>;
  const published = Arr.filter(R.toEntries(columns), ([key, term]) => admits(names, key, term));
  const renamed = Arr.flatMap(R.toEntries(names.renamed), ([name, key]) => {
    const term = columns[key];
    return term === undefined ? [] : [[name, term] as const];
  });
  return R.fromEntries([...published, ...renamed]);
};

/**
 * The sortable field map for a view (or table) — see the module doc for what
 * lands in it and why.
 */
export const sortableColumnsFor = (
  relation: Table | View,
  options?: SortableColumnsOptions,
): SortableColumns => {
  if (options !== undefined) return deriveSortable(relation, resolveNames(options));
  const cached = derived.get(relation);
  if (cached !== undefined) return cached;
  const map = deriveSortable(relation, resolveNames());
  derived.set(relation, map);
  return map;
};

/** Apply a direction to one `ORDER BY` term. */
const directed = (term: OrderTerm, direction: "asc" | "desc"): SQL =>
  direction === "desc" ? desc(term) : asc(term);

/**
 * Whether an ordering already ends in the relation's bare `id` column, and
 * so needs no tiebreak appended.
 *
 * Compared by **column name**, not by reference: Drizzle hands back a fresh
 * alias proxy on every view-column access, so `view.id === view.id` is
 * `false` and an identity check silently never matches. A directed term
 * (`desc(view.id)`) is a `SQL`, not a column, and is deliberately not
 * matched: appending an ascending `id` after a descending one would fight it,
 * so a caller spelling the tiebreak that way passes `tiebreak` instead.
 */
const endsInIdColumn = (order: ReadonlyArray<OrderTerm>, idColumn: PgColumn): boolean => {
  const last = order.at(-1);
  if (last === undefined || last instanceof SQL || last instanceof SQL.Aliased) return false;
  return last.name === idColumn.name;
};

/* oxlint-disable effect/prefer-option-over-null -- an options bag a caller forwards its own optionals into (a decoded `?sort=` is absent when the request carried none); `?: T | undefined` is what lets it pass `{ sort: query.sort }` under `exactOptionalPropertyTypes`, and an `Option` there would only be unwrapped on the next line. Same shape as the applications' signature. */
/** The options {@link resolveSortOrder} takes. */
export interface ResolveSortOrderOptions {
  /** The relation sorted — the source of both the allow-list and the `id` tiebreak. */
  readonly view: SortableRelation;
  /** The caller's decoded sort keys; absent or empty when they asked for no order. */
  readonly sort?: ReadonlyArray<SortKey> | undefined;
  /**
   * The resource's intrinsic display order, used when the caller supplied no
   * `sort`. Need not be total: the `id` tiebreak is appended unless its last
   * term already *is* the relation's `id` column.
   */
  readonly fallback?: ReadonlyArray<OrderTerm> | undefined;
  /**
   * Direction of the `id` tiebreak appended to a non-total `fallback`.
   * Defaults to the bare (ascending) column. A newest-first fallback passes
   * `"desc"` so the tiebreak mirrors it rather than fighting it.
   */
  readonly tiebreak?: "asc" | "desc" | undefined;
  /** Overrides the derived allow-list for a resource whose sortable set the view can't express. */
  readonly sortable?: SortableColumns | undefined;
}

/* oxlint-enable effect/prefer-option-over-null */

/**
 * Resolve a list request's ordering: the caller's `?sort=` when present, the
 * resource's own `fallback` order otherwise, always closed with an `id`
 * tiebreak so the page window is total-ordered.
 *
 * Fails with {@link UnsupportedSortError} when `sort` names a field outside
 * the allow-list. Every field is checked before any is mapped, so a
 * partially-valid `?sort=` is rejected rather than silently half-applied.
 * The allow-list check is an own-property test, so `constructor` or
 * `toString` are never sort fields.
 */
export const resolveSortOrder = (
  options: ResolveSortOrderOptions,
): Effect.Effect<ReadonlyArray<OrderTerm>, UnsupportedSortError> =>
  Effect.suspend(() => {
    const idColumn = options.view.id;
    return Arr.match(options.sort ?? [], {
      onEmpty: (): Effect.Effect<ReadonlyArray<OrderTerm>, UnsupportedSortError> => {
        const fallback = options.fallback ?? [];
        if (endsInIdColumn(fallback, idColumn)) return Effect.succeed(fallback);
        return Effect.succeed([
          ...fallback,
          options.tiebreak === undefined ? idColumn : directed(idColumn, options.tiebreak),
        ]);
      },
      onNonEmpty: (sort) => {
        const sortable = options.sortable ?? sortableColumnsFor(options.view);
        const unsupported = sort.find(({ field }) => !Object.hasOwn(sortable, field));
        if (unsupported !== undefined) {
          return Effect.fail(
            new UnsupportedSortError({
              field: unsupported.field,
              allowed: R.keys(sortable).toSorted(),
            }),
          );
        }

        // SAFETY: every field was checked as an own key of `sortable` above.
        const terms = sort.map(({ field, direction }) =>
          directed(sortable[field] as OrderTerm, direction),
        );
        // A caller who sorted by `id` has already asked for a total order; a
        // second `id` term would be redundant SQL.
        if (sort.some(({ field }) => field === "id")) return Effect.succeed(terms);
        return Effect.succeed([...terms, directed(idColumn, Arr.lastNonEmpty(sort).direction)]);
      },
    });
  });

/* oxlint-disable effect/prefer-option-over-null -- an options bag a caller forwards its own optionals into (a decoded `?sort=` is absent when the request carried none); `?: T | undefined` is what lets it pass `{ sort: query.sort }` under `exactOptionalPropertyTypes`, and an `Option` there would only be unwrapped on the next line. Same shape as the applications' signature. */
/** The options {@link chronologicalOrder} takes. */
export interface ChronologicalOrderOptions {
  /** The relation sorted; its `timestamp` column is the chronological axis. */
  readonly view: SortableRelation & { readonly timestamp: PgColumn };
  /** The caller's decoded sort keys, as for {@link resolveSortOrder}. */
  readonly sort?: ReadonlyArray<SortKey> | undefined;
  /** Chronological direction of the default order. Defaults to newest first. */
  readonly direction?: "asc" | "desc" | undefined;
  /** As for {@link resolveSortOrder}. */
  readonly sortable?: SortableColumns | undefined;
}

/* oxlint-enable effect/prefer-option-over-null */

/**
 * {@link resolveSortOrder} for the commonest default a list has:
 * chronological by the current version's `timestamp`, newest first unless
 * told otherwise, with a tiebreak that mirrors it — one decision, spelled
 * once, so the tiebreak cannot go missing at a call site.
 */
export const chronologicalOrder = (
  options: ChronologicalOrderOptions,
): Effect.Effect<ReadonlyArray<OrderTerm>, UnsupportedSortError> => {
  const direction = options.direction ?? "desc";
  return resolveSortOrder({
    view: options.view,
    sort: options.sort,
    fallback: [directed(options.view.timestamp, direction)],
    tiebreak: direction,
    sortable: options.sortable,
  });
};
