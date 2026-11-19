/**
 * The update tri-state at one seam: a value sets, `null` clears, an absent key
 * or `undefined` carries forward. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/update.md).
 *
 * @module update
 */

import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as R from "effect/Record";

/**
 * The `SET` (or `VALUES`) map {@link updateSetMap} produces from input `I`
 * and writable column keys `K`: every writable key of `I`, optional (it is
 * present only when the input supplied a value), with `undefined` removed
 * from its value type (a present `null` stays).
 */
export type UpdateSet<I, K extends string> = {
  readonly [P in Extract<keyof I, K>]?: Exclude<I[P], undefined>;
};

const toHashSet = <K extends string>(writable: Iterable<K>): HashSet.HashSet<K> =>
  HashSet.isHashSet(writable) ? writable : HashSet.fromIterable(writable);

/**
 * The `SET` map for an update: every key of `input` that names a writable
 * column and carries a **present** value (`null` included), in the input's
 * own key order. Keys outside `writable` — the routing `id`, a
 * server-owned column, a relationship the table does not carry, an unknown
 * key — are dropped; an `undefined`-valued key (an explicit carry-forward)
 * is dropped too, since the tri-state's first two rows must stay apart.
 *
 * `writable` is any iterable of column keys; pass a module-scope `HashSet`
 * to build it once.
 */
export const updateSetMap = <I extends Readonly<Record<string, unknown>>, K extends string>(
  input: I,
  writable: Iterable<K>,
): UpdateSet<I, K> => {
  const columns: HashSet.HashSet<string> = toHashSet(writable);
  // SAFETY: the entries kept are exactly the writable keys of `input` whose
  // value is not `undefined`, which is what `UpdateSet<I, K>` describes.
  return R.fromEntries(
    Arr.filter(
      R.toEntries(input),
      ([key, value]) => value !== undefined && HashSet.has(columns, key),
    ),
  ) as UpdateSet<I, K>;
};

/**
 * The `VALUES` map for a create: every key of `input` naming a writable
 * column with a present value. An absent optional is left to the column
 * default rather than written as `undefined`, and a key the table does not
 * carry is dropped — the same projection as {@link updateSetMap}, without
 * the tri-state reading (a create has nothing to carry forward).
 */
export const insertValues = <I extends Readonly<Record<string, unknown>>, K extends string>(
  input: I,
  writable: Iterable<K>,
): UpdateSet<I, K> => updateSetMap(input, writable);
