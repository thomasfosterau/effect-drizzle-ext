/**
 * @copyright Thomas Foster
 *
 * **The JSON:API resource projection of the derivation entry (Drizzle).**
 *
 * `./jsonapi` reads a `Resource.make` definition's `dbColumn` annotations;
 * `./derive` turns db-column metadata into Drizzle column builders. This entry
 * is the join: the resource-shaped signatures the consuming applications'
 * table factories call, implemented by handing `resourceColumns` /
 * `resourceColumnBounds` to the generic interpreter. No semantics of its own —
 * failure modes, CHECK naming and the `resolveReference` seam are all
 * `./derive`'s, and its {@link DerivationError} is what a misdeclared resource
 * throws at module load.
 *
 * @module jsonapi/derive
 */

import type { ExtraConfigColumn, PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import {
  deriveCheckConstraintsFrom,
  // oxlint-disable-next-line effect/no-service-constructor-imports -- `makeDeriveColumns` is a plain factory over a builder registry, not an Effect service constructor; the rule keys on the `make*` name.
  makeDeriveColumns,
  type ColumnBuilders,
  type DerivedColumns,
  type DeriveOptions,
} from "../derive.ts";
import {
  resourceColumnBounds,
  resourceColumns,
  type AnyResource,
  type ResourceColumnsMetaOf,
} from "./index.ts";

/**
 * The Drizzle column builders a `Resource.make` definition's annotated
 * attributes produce against registry `B`, keyed and typed per attribute.
 */
export type DerivedResourceColumns<
  R extends AnyResource,
  B extends ColumnBuilders,
> = DerivedColumns<ResourceColumnsMetaOf<R>, B>;

/**
 * Build a `deriveResourceColumns` bound to a specific builder registry. The
 * returned function interprets a `Resource.make` definition's per-attribute
 * `dbColumn` annotations into the Drizzle column builders a table factory's
 * `columns` expects.
 */
export const makeDeriveResourceColumns = <B extends ColumnBuilders>(
  builders: B,
  options: DeriveOptions = {},
): (<R extends AnyResource>(resource: R) => DerivedResourceColumns<R, B>) => {
  const derive = makeDeriveColumns(builders, options);
  return <R extends AnyResource>(resource: R): DerivedResourceColumns<R, B> =>
    // SAFETY: `resourceColumns` projects exactly the annotated attributes
    // `ResourceColumnsMetaOf` keys, so the derived map is the one it describes.
    derive.fromMeta(resourceColumns(resource)) as DerivedResourceColumns<R, B>;
};

/**
 * Derive the SQL `CHECK` constraints a resource definition's numeric-bound
 * checks imply, named `${tableName}_${column}_${suffix}` unless the annotation
 * pins a `checkName`, and guarded with `col IS NULL OR …` for a nullable
 * column. Returns a callback shaped for a table factory's `extraConstraints`
 * seam; a bounded attribute whose column is absent from the table throws
 * {@link DerivationError}.
 *
 * The projection is deferred to the returned callback, so this composes inside
 * a `pgTable(...)` call whose columns are still being assembled.
 */
export const deriveCheckConstraints =
  (resource: AnyResource, tableName: string) =>
  (table: Record<string, ExtraConfigColumn>): PgTableExtraConfigValue[] =>
    deriveCheckConstraintsFrom(resourceColumnBounds(resource), tableName)(table);
