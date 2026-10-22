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
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
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
export const resourceColumns = (resource: AnyResource): Record<string, DbColumn> =>
  // `Resource.attributeAnnotations` (an optional peer, outside this workspace)
  // reports an attribute with no annotations as a literal `undefined` entry;
  // the foreign `undefined` becomes an `Option` on the same expression.
  R.getSomes(
    R.map(Resource.attributeAnnotations(resource), (annotations) =>
      Option.map(
        Option.fromUndefinedOr(annotations?.[DB_COLUMN_KEY]),
        // SAFETY: DB_COLUMN_KEY is namespaced to this package and only
        // `dbColumn` / `dbColumnFor` write it, always with a `DbColumn` value.
        (meta) => meta as DbColumn,
      ),
    ),
  );

/**
 * Project a resource definition's per-attribute numeric bounds into plain data
 * a `CHECK`-constraint derivation consumes: for each `dbColumn`-annotated
 * attribute whose schema carries numeric-bound checks, the bounds paired with
 * the column metadata. Attributes without a column, or without bounds, drop.
 * The Drizzle-emitting counterpart is the `./jsonapi/derive` entry's
 * `deriveCheckConstraints`.
 */
export const resourceColumnBounds = (resource: AnyResource): Record<string, ColumnBounds> => {
  // SAFETY: `Resource.attributes` returns the resource object's
  // `Schema.Struct.Fields`; every value is a schema.
  const fields = Resource.attributes(resource) as Record<string, Schema.Constraint>;
  return R.getSomes(
    R.map(resourceColumns(resource), (column, name) =>
      Option.map(numericBounds(fields[name]), (bounds): ColumnBounds => ({ column, ...bounds })),
    ),
  );
};

// ── Resource projection shapes ────────────────────────────────────────

/**
 * The resource-projection shape of one `Resource.make` attribute, as plain
 * data — what an operation factory needs to derive a row → resource mapper
 * and a version-table column map from the model alone:
 *
 * - `date` (a `createdAt` / `updatedAt` / `deletedAt`-style `Date`) → a
 *   timestamp axis the mapper reads from the chain rather than a column,
 * - `array` (a materialised-list attribute a flat view does not carry) → a
 *   placeholder the mapper fills from a join,
 * - `optional` (an `optionalKey` resource projection) → the value drops when
 *   the column is absent rather than surfacing as a present `undefined`,
 * - everything else (including a `NullOr` column read straight off a view) →
 *   passthrough.
 *
 * `column` is the column the attribute's `dbColumn` annotation names, `none`
 * for an attribute that declares none.
 */
export interface ResourceAttributeProjection {
  readonly key: string;
  /** The resource projection is an `optionalKey` (drops when absent). */
  readonly optional: boolean;
  /** The attribute schema accepts `null` (a `Schema.NullOr`). */
  readonly nullable: boolean;
  /** The attribute schema is an array (a materialised-list attribute). */
  readonly array: boolean;
  /** The attribute schema decodes an ISO string to a `Date` (a timestamp axis). */
  readonly date: boolean;
  /** The column the attribute backs, if it declares one. */
  readonly column: Option.Option<string>;
}

/** An ISO timestamp a `Date`-decoding attribute schema accepts. */
const ISO_PROBE = "2024-01-02T03:04:05.000Z";

/**
 * What a schema's **JSON codec** decodes `input` to — the wire reading, so an
 * ISO string decodes to a `Date` for `Schema.Date` (whose own decoder accepts
 * only a `Date` instance). A decoder is built per call: this is start-up
 * introspection over a model, not a hot path.
 */
const decodesFromJson = (schema: Schema.Top, input: Schema.Json): Option.Option<unknown> =>
  // SAFETY: an attribute schema's decoding needs no services (a resource's
  // attributes are plain codecs), which `Schema.Top` cannot express.
  Schema.decodeUnknownOption(Schema.toCodecJson(schema as Schema.Codec<unknown>))(input);

/**
 * Project a `Resource.make` definition's resource-object attributes into
 * ordered plain-data {@link ResourceAttributeProjection}s (declaration
 * order). Optionality is read off each field's AST (`optionalKey` marks the
 * property optional); nullability, array-ness and date-ness are recovered by
 * behavioural decode probes through each schema's JSON codec (the wire
 * reading), so the read stays robust across schema-AST shapes (a `NullOr` of
 * a transformation, a branded array, …).
 *
 * Input-only attributes (`resource: false`) are not on the resource object,
 * and so not here. The `column` read is {@link resourceColumns}'.
 */
export const resourceAttributeProjections = (
  resource: AnyResource,
): ReadonlyArray<ResourceAttributeProjection> => {
  // SAFETY: `Resource.attributes` returns the resource object's
  // `Schema.Struct.Fields`; every value is a schema.
  const fields = Resource.attributes(resource) as Record<string, Schema.Top>;
  const columns = resourceColumns(resource);
  return Arr.map(R.toEntries(fields), ([key, schema]) => ({
    key,
    optional: SchemaAST.isOptional(schema.ast),
    nullable: Option.isSome(decodesFromJson(schema, null)),
    array: Option.isSome(decodesFromJson(schema, [])),
    date: Option.exists(decodesFromJson(schema, ISO_PROBE), Predicate.isDate),
    column: Option.fromNullishOr(columns[key]?.column),
  }));
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
