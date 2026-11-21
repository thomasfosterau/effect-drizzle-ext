/**
 * The derivation entry's JSON:API projection (imports Drizzle): resource-shaped
 * wrappers over `./Derive` for `Resource.make` definitions. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/jsonapi.md).
 *
 * @module JsonApiDerive
 */

import type { ExtraConfigColumn, PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import {
  deriveCheckConstraintsFrom,
  deriveColumnsWith,
  type ColumnBuilders,
  type DerivedColumns,
  type DeriveOptions,
} from "./Derive.ts";
import {
  resourceColumnBounds,
  resourceColumns,
  type AnyResource,
  type ResourceColumnsMetaOf,
} from "./JsonApi.ts";

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
export const deriveResourceColumnsWith = <B extends ColumnBuilders>(
  builders: B,
  options: DeriveOptions = {},
): (<R extends AnyResource>(resource: R) => DerivedResourceColumns<R, B>) => {
  const derive = deriveColumnsWith(builders, options);
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
