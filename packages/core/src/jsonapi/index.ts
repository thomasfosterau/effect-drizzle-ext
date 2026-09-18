/**
 * @copyright Thomas Foster
 *
 * **The JSON:API resource projection of the annotation entry (no Drizzle).**
 *
 * The {@link ../index.ts} entry reads `dbColumn` annotations off a
 * `Schema.Struct`'s fields. A consumer whose models are
 * `@thomasfosterau/effect-jsonapi` `Resource.make` definitions declares the
 * same annotations on its **attributes**, which sit behind an extra layer:
 * `Resource.attribute` descriptors, and the `optionalKey` wrapper a
 * `resource: "optional"` attribute takes. This entry is the reader for that
 * shape — the resource-shaped counterpart of `fieldColumns` /
 * `fieldColumnBounds`.
 *
 * **No Drizzle, and an optional peer.** `@thomasfosterau/effect-jsonapi` is an
 * *optional* peer dependency: only this subpath and `./derive` import it, so a
 * consumer with plain `Schema.Struct` models never installs it. The
 * Drizzle-emitting half is `./jsonapi/derive`.
 *
 * The table-level annotation helpers are re-exported here with an
 * `R extends AnyResource` bound. They are the same functions — the narrower
 * bound exists so a consumer's resource-facing `db-annotation.ts` can import
 * every name it needs from one place, and so a non-resource object cannot be
 * annotated through the resource-shaped API by accident.
 *
 * @module jsonapi
 */

import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import {
  dbTable as coreDbTable,
  readDbTable as coreReadDbTable,
  numericBounds,
  DB_COLUMN_KEY,
  type ColumnBounds,
  type DbColumn,
  type TableAnnotated as CoreTableAnnotated,
  type DbTableOf as CoreDbTableOf,
  type DbTable,
  type TableMeta,
  type UnwrapColumn,
} from "../index.ts";

export type { DbTable, TableMeta };

/**
 * Any `Resource.make` resource definition. Re-exported so a derivation layer
 * can name the constraint of {@link ResourceColumnsMetaOf} without importing
 * `@thomasfosterau/effect-jsonapi` directly.
 */
export type AnyResource = Resource.Any;

/**
 * The underlying schema of an attribute field. A `Resource.attribute`
 * descriptor carries the schema `S` in its config (recoverable through the
 * `Resource.Attribute` type), peeling the `resource: "optional"` `optionalKey`
 * wrapper that would otherwise bury the `dbColumn` phantom; a plain annotated
 * attribute (e.g. `dbColumn(schema, …)` passed directly) is its own schema.
 */
type UnderlyingSchema<A> =
  A extends Resource.Attribute<infer S, infer _R, infer _C, infer _U, infer _Cl> ? S : A;

/**
 * The db-column metadata map a resource definition projects to, keyed by the
 * attributes that declare a `dbColumn` (others drop out of the map entirely).
 * Recovers each attribute's underlying schema (peeling the descriptor + any
 * `optionalKey` resource wrapper) and reads its phantom via
 * {@link UnwrapColumn}. The resource-shaped counterpart of
 * `FieldColumnsMetaOf`.
 */
export type ResourceColumnsMetaOf<R extends AnyResource> = {
  readonly [
    K in keyof Resource.AttributesOf<R> as [
      UnwrapColumn<UnderlyingSchema<Resource.AttributesOf<R>[K]>>,
    ] extends [never]
      ? never
      : K
  ]: UnwrapColumn<UnderlyingSchema<Resource.AttributesOf<R>[K]>>;
};

/**
 * Project a resource definition's per-attribute {@link DbColumn} metadata into
 * plain data the derivation consumes, dropping attributes that declare no
 * column. Reads the annotation via `Resource.attributeAnnotations`, which
 * resolves each attribute schema's annotations — including through the
 * `optionalKey` wrapper a `resource: "optional"` attribute carries, whose AST
 * is the inner schema's. The type-level counterpart is
 * {@link ResourceColumnsMetaOf}.
 */
export const resourceColumns = (resource: AnyResource): Record<string, DbColumn> => {
  /*
   * NOT migrated to `Option`: this union is not a modelling choice, it names
   * the runtime shape `Resource.attributeAnnotations` actually returns from
   * `@thomasfosterau/effect-jsonapi` (an optional peer, outside this
   * workspace) — an attribute with no annotations is a literal `undefined`
   * entry. Writing `Option` here would be a false description of the value
   * being cast.
   */
  /* oxlint-disable effect/prefer-option-over-null -- names an external package's runtime shape at a cast */
  const annotations = Resource.attributeAnnotations(resource) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  /* oxlint-enable effect/prefer-option-over-null */
  const out: Record<string, DbColumn> = {};
  for (const name in annotations) {
    const meta = annotations[name]?.[DB_COLUMN_KEY];
    if (meta !== undefined) out[name] = meta as DbColumn;
  }
  return out;
};

/**
 * Project a resource definition's per-attribute numeric bounds into plain data
 * a `CHECK`-constraint derivation consumes: for each `dbColumn`-annotated
 * attribute whose schema carries numeric-bound checks, the bounds paired with
 * the column metadata. Attributes without a column, or without bounds, drop.
 * The Drizzle-emitting counterpart is the `./jsonapi/derive` entry's
 * `deriveCheckConstraints`.
 */
export const resourceColumnBounds = (resource: AnyResource): Record<string, ColumnBounds> => {
  const fields = Resource.attributes(resource) as Record<string, Schema.Constraint>;
  const columns = resourceColumns(resource);
  const out: Record<string, ColumnBounds> = {};
  for (const name in columns) {
    const bounds = numericBounds(fields[name]);
    if (Option.isSome(bounds)) out[name] = { column: columns[name], ...bounds.value };
  }
  return out;
};

// ── Table-level annotation, narrowed to resources ─────────────────────

/**
 * A resource definition carrying db-table metadata `M` in a type-level phantom
 * — `TableAnnotated` from the annotation entry with its target narrowed to a
 * resource.
 */
export type TableAnnotated<R extends AnyResource, M extends TableMeta> = CoreTableAnnotated<R, M>;

/** Recovers the db-table metadata phantom from a resource, or `never`. */
export type DbTableOf<R> = CoreDbTableOf<R>;

/**
 * Annotate a resource definition with the database table it backs. The
 * annotation entry's `dbTable`, narrowed to `R extends AnyResource`: it
 * attaches the metadata as a non-enumerable symbol property and returns the
 * **same** resource object, so `Resource.make`'s assigned properties (`type`,
 * `Id`, `identifier`, …) and the referential identity a registry compares by
 * both survive.
 */
export const dbTable = <R extends AnyResource, const M extends TableMeta>(
  resource: R,
  meta: M,
): TableAnnotated<R, M> => coreDbTable(resource, meta);

/**
 * A {@link dbTable} constrained to a specific level union `Level`, requiring
 * the full {@link DbTable} metadata. A consumer pins its own levels once —
 * `const dbTable = dbTableFor<LeafLevel>()` — so an annotation naming a level
 * the derivation has no parent binding for is a type error at the annotation
 * site.
 */
export const dbTableFor =
  <Level extends string>() =>
  <R extends AnyResource, const M extends DbTable<Level>>(
    resource: R,
    meta: M,
  ): TableAnnotated<R, M> =>
    coreDbTable(resource, meta);

/**
 * Read the db-table metadata off a resource at runtime. `Option.none()` when
 * the resource carries none. Typed to the {@link TableMeta} floor; a consumer
 * that annotated with a {@link DbTable} recovers its `level` through the
 * {@link DbTableOf} phantom.
 */
export const readDbTable = (resource: AnyResource): Option.Option<TableMeta> =>
  coreReadDbTable(resource);
