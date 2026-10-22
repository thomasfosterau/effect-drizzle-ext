/**
 * @copyright Thomas Foster
 *
 * **Effect Schema → Drizzle derivation: the derivation entry (Drizzle).**
 *
 * Reads the {@link DbColumn} metadata a schema declaration carries (via
 * {@link fieldColumns} from the {@link ./index.ts} annotation entry, or via any
 * other projection that yields a `Record<string, DbColumn>`) and emits the
 * matching Drizzle column builders. Depends on Drizzle, so a model / client
 * layer importing only the annotation entry never pulls the ORM.
 *
 * **Extensible column kinds.** The kind → builder mapping is *injected*, not
 * baked in: a consumer passes a builder registry (a record from its own kind
 * union to a Drizzle column builder) to {@link makeDeriveColumns}, and the
 * derivation preserves each column's precise builder type — so the derived
 * column map keeps `$inferSelect` typed — by reading the type-level phantom
 * `dbColumn` stamps alongside the runtime annotation.
 *
 * **Two entry shapes, one interpreter.** {@link makeDeriveColumns} returns both
 * `fromFields` (a `Schema.Struct`'s fields, the generic source) and `fromMeta`
 * (an already-projected metadata map, the seam the `./jsonapi/derive` entry and
 * any other projection build on). They share one builder loop.
 *
 * **Failures here are THROWN, not Effect failures.** Everything in this module
 * runs at *module load*, while a consumer's table modules are being evaluated —
 * before any Effect runtime exists to run a failure in, and before any query
 * can be issued. A misdeclared table must fail at `import`, not at first
 * insert, so a missing builder / a missing reference hook / bounds on a column
 * the table does not carry throw {@link DerivationError}. Runtime query
 * failures are the opposite and are never thrown: they travel in the Effect
 * error channel as the tagged errors of the `./errors` entry.
 *
 * @module derive
 */

import { sql, type ColumnBuilderBase, type SQL } from "drizzle-orm";
import {
  check,
  type AnyPgColumn,
  type ExtraConfigColumn,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  fieldColumnBounds,
  fieldColumns,
  type ColumnBounds,
  type DbColumn,
  type DbColumnReference,
  type FieldColumnsMetaOf,
} from "./index.ts";

/**
 * A construction-time derivation failure: a table could not be built from its
 * declarations (no builder registered for a column kind, a `references`
 * annotation with no resolver, numeric bounds on a column the table has no
 * column for, an unresolvable FK target).
 *
 * **Thrown, never failed.** See this module's header: derivation runs at module
 * load, before an Effect runtime exists, so the only way to stop a misdeclared
 * table from reaching production is to make its `import` fail. It is a tagged
 * error all the same, so a consumer that does catch one (a registry loader, a
 * codegen script) can match it structurally.
 */
export class DerivationError extends Schema.TaggedError<DerivationError>()("DerivationError", {
  message: Schema.String,
}) {}

/**
 * A registry mapping column kinds to Drizzle column builders — one builder per
 * kind, taking the column name and returning a fresh (nullable) builder. The
 * consumer supplies this; the package provides no fixed set.
 */
export type ColumnBuilders<Kind extends string = string> = Record<
  Kind,
  (column: string) => ColumnBuilderBase
>;

/** The (nullable) builder a kind produces in registry `B`. */
type Builder<B extends ColumnBuilders, P extends keyof B> = ReturnType<B[P]>;

/** The `.notNull()` form of a builder. */
type NotNull<X> = X extends { notNull(): infer R } ? R : X;

/**
 * The Drizzle column builder a single db-column annotation produces against
 * registry `B`. Total over any `M` (a widened `unknown` metadata falls back to
 * the base builder type), computing the precise builder type for a concrete
 * `{ pg, notNull }` metadata.
 *
 * Exported so a projection-specific derivation (the `./jsonapi/derive` entry)
 * can name this type without restating it.
 */
export type BuilderFor<M, B extends ColumnBuilders> = M extends {
  readonly pg: infer P;
  readonly notNull: infer N;
}
  ? P extends keyof B
    ? N extends true
      ? NotNull<Builder<B, P>>
      : Builder<B, P>
    : ColumnBuilderBase
  : ColumnBuilderBase;

/**
 * The Drizzle column builders a db-column metadata map produces against
 * registry `B`, keyed and typed per entry — the type-level counterpart of the
 * builder loop {@link makeDeriveColumns} returns.
 */
export type DerivedColumns<Meta, B extends ColumnBuilders> = {
  readonly [K in keyof Meta]: BuilderFor<Meta[K], B>;
};

/*
 * **The one statement of the `?: T | undefined` rule.** Every optional member
 * of a config type this library hands to Drizzle — `resolveReference` below,
 * `DiscriminatorNames`' templates in ./constraints.ts, the annotation entry's
 * `DbColumn.default` / `.references` / `.checkName` — is spelled
 * `?: T | undefined`, never `Option`. Drizzle reads `undefined` as "not
 * supplied"; handed an `Option` it would emit the wrapper object as a literal
 * value (a DEFAULT of `{_tag: "None"}`, a referential action of `[Object]`) —
 * wrong DDL that no type error and no unit test catches, because Drizzle's
 * config members are typed loosely enough to accept it. Readers this library
 * owns (`readDbColumn`, `readDbTable`, `findPgError`, …) return `Option`; the
 * conversion happens at their boundary, not in Drizzle-facing config.
 */
/* oxlint-disable effect/prefer-option-over-null -- Drizzle-facing config: Drizzle reads `undefined` as "not supplied" */

/**
 * Optional hooks for {@link makeDeriveColumns}. `resolveReference` turns a
 * column's {@link DbColumnReference} name pair into the Drizzle column thunk
 * `.references()` needs — the seam that lets FK-backed attributes derive their
 * column instead of being hand-authored. Without it, a `references` annotation
 * is a configuration error (throws), so a consumer only wires it when it
 * declares FK columns. The `./references` entry ships one implementation.
 */
export interface DeriveOptions {
  readonly resolveReference?: ((reference: DbColumnReference) => () => AnyPgColumn) | undefined;
}

/* oxlint-enable effect/prefer-option-over-null */

/**
 * A fluent view of a Drizzle column builder — the chainable `.notNull()` /
 * `.default()` / `.references()` methods the registry's widened
 * `ColumnBuilderBase` return type hides. Runtime-real; used only to type the
 * dynamic build chain. Typed to exactly what the chain passes.
 */
interface FluentColumn extends ColumnBuilderBase {
  notNull(): FluentColumn;
  default(value: NonNullable<DbColumn["default"]>): FluentColumn;
  references(
    ref: () => AnyPgColumn,
    actions: Pick<DbColumnReference, "onDelete" | "onUpdate">,
  ): FluentColumn;
}

/**
 * The derivation pair {@link makeDeriveColumns} returns for builder registry
 * `B`: `fromMeta` over an already-projected metadata map, `fromFields` over a
 * `Schema.Struct`'s fields. Both throw {@link DerivationError} at module load
 * on a misdeclared column.
 */
export interface DeriveColumns<B extends ColumnBuilders> {
  /** Derive the builders an already-projected metadata map declares. */
  readonly fromMeta: <Meta extends Record<string, DbColumn>>(
    metas: Meta,
  ) => DerivedColumns<Meta, B>;
  /** Derive the builders a `Schema.Struct`'s annotated fields declare. */
  readonly fromFields: <F extends Schema.Struct.Fields>(
    fields: F,
  ) => DerivedColumns<FieldColumnsMetaOf<F>, B>;
}

/**
 * Build a derivation bound to a specific builder registry. The returned pair
 * interprets per-column `dbColumn` metadata into the Drizzle column builders a
 * table factory's `columns` expects:
 *
 * - `fromFields` takes a `Schema.Struct`'s fields directly (peeling the
 *   `optional` / `NullOr` wrappers via {@link fieldColumns});
 * - `fromMeta` takes an already-projected metadata map, for a projection this
 *   entry knows nothing about (the `./jsonapi/derive` entry is one).
 */
export const makeDeriveColumns = <B extends ColumnBuilders>(
  builders: B,
  options: DeriveOptions = {},
): DeriveColumns<B> => {
  const buildColumn = (meta: DbColumn): ColumnBuilderBase => {
    const build = builders[meta.pg];
    if (build === undefined) {
      throw new DerivationError({
        message: `no builder registered for column kind '${meta.pg}'`,
      });
    }
    // SAFETY: the registry widens each builder's return to `ColumnBuilderBase`,
    // hiding the fluent `.notNull()` / `.default()` / `.references()` methods;
    // the runtime builders are the real Drizzle ones, which carry them.
    let column = build(meta.column) as FluentColumn;
    if (meta.notNull) column = column.notNull();
    if (meta.default !== undefined) column = column.default(meta.default);
    if (meta.references !== undefined) {
      if (options.resolveReference === undefined) {
        throw new DerivationError({
          message: `column '${meta.column}' declares a reference but no resolveReference hook was provided`,
        });
      }
      const target = options.resolveReference(meta.references);
      column = column.references(target, {
        onDelete: meta.references.onDelete,
        onUpdate: meta.references.onUpdate,
      });
    }
    return column;
  };
  const buildColumns = (metas: Record<string, DbColumn>): Record<string, ColumnBuilderBase> =>
    R.fromEntries(
      Arr.map(R.toEntries(metas), ([name, meta]) => [name, buildColumn(meta)] as const),
    );

  return {
    fromMeta: <Meta extends Record<string, DbColumn>>(metas: Meta): DerivedColumns<Meta, B> =>
      // SAFETY: `buildColumns` maps every key of `metas` to the builder its
      // `pg` kind selects, with `.notNull()` applied exactly when `notNull`
      // is true — the per-entry computation `DerivedColumns` describes.
      buildColumns(metas) as DerivedColumns<Meta, B>,
    fromFields: <F extends Schema.Struct.Fields>(
      fields: F,
    ): DerivedColumns<FieldColumnsMetaOf<F>, B> =>
      // SAFETY: `fieldColumns` projects exactly the annotated fields
      // `FieldColumnsMetaOf` keys, and `buildColumns` maps each as in `fromMeta`.
      buildColumns(fieldColumns(fields)) as DerivedColumns<FieldColumnsMetaOf<F>, B>,
  };
};

// ── CHECK-constraint derivation ───────────────────────────────────────

/** A number rendered inline into the CHECK expression (never a bind parameter). */
const literal = (value: number): SQL => sql.raw(String(value));

/**
 * The canonical constraint-name suffix a set of bounds earns: `range` when
 * bounded on both sides; `non_negative` for the sole inclusive-minimum-of-`0`
 * case (the established naming for count/duration columns); `min` / `max` for
 * the remaining one-sided bounds.
 */
const boundSuffix = (bounds: ColumnBounds): string => {
  const hasMin = bounds.minimum !== undefined || bounds.exclusiveMinimum !== undefined;
  const hasMax = bounds.maximum !== undefined || bounds.exclusiveMaximum !== undefined;
  if (hasMin && hasMax) return "range";
  if (!hasMin) return "max";
  return bounds.minimum === 0 ? "non_negative" : "min";
};

/** The per-side comparisons for a bound set (exclusive bounds win their side). */
const comparisonParts = (column: ExtraConfigColumn, bounds: ColumnBounds): SQL[] => {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = bounds;
  const parts: SQL[] = [];
  if (exclusiveMinimum !== undefined) parts.push(sql`${column} > ${literal(exclusiveMinimum)}`);
  else if (minimum !== undefined) parts.push(sql`${column} >= ${literal(minimum)}`);
  if (exclusiveMaximum !== undefined) parts.push(sql`${column} < ${literal(exclusiveMaximum)}`);
  else if (maximum !== undefined) parts.push(sql`${column} <= ${literal(maximum)}`);
  return parts;
};

/**
 * The bound expression for one column (without the nullability guard): a
 * both-sides-inclusive bound renders as `col BETWEEN min AND max` — matching
 * the hand-authored year-range constraints in the consuming applications — and
 * anything else as the {@link comparisonParts} joined with `AND`.
 */
const boundExpression = (column: ExtraConfigColumn, bounds: ColumnBounds): SQL =>
  bounds.minimum !== undefined && bounds.maximum !== undefined
    ? sql`${column} BETWEEN ${literal(bounds.minimum)} AND ${literal(bounds.maximum)}`
    : sql.join(comparisonParts(column, bounds), sql` AND `);

/**
 * Derive the SQL `CHECK` constraints an already-projected bounds map implies —
 * the third leg of annotation-driven columns, after the column itself and the
 * read-view selection. Emits one Drizzle `check()` per bounded column, named
 * `${tableName}_${column}_${suffix}` (see {@link boundSuffix} for the canonical
 * suffixes) unless the column annotation pins a `checkName`. A nullable
 * column's expression is guarded with `col IS NULL OR …`, matching the
 * hand-authored precedents.
 *
 * Returns a callback shaped for a table factory's `extraConstraints` seam: it
 * receives the table's columns keyed by **attribute** name (not SQL column
 * name). A bounded attribute whose column is absent from the table is a
 * configuration error ({@link DerivationError}) — bounds on a column the table
 * doesn't carry cannot be enforced.
 */
export const deriveCheckConstraintsFrom =
  (bounds: Record<string, ColumnBounds>, tableName: string) =>
  (table: Record<string, ExtraConfigColumn>): PgTableExtraConfigValue[] =>
    Arr.map(R.toEntries(bounds), ([attribute, columnBounds]) => {
      const column = table[attribute];
      if (column === undefined) {
        throw new DerivationError({
          message:
            `attribute '${attribute}' declares numeric bounds but ` +
            `table '${tableName}' has no column for it`,
        });
      }
      const expression = boundExpression(column, columnBounds);
      const guarded = columnBounds.column.notNull
        ? expression
        : sql`${column} IS NULL OR ${expression}`;
      const name =
        columnBounds.column.checkName ??
        `${tableName}_${columnBounds.column.column}_${boundSuffix(columnBounds)}`;
      return check(name, guarded);
    });

/**
 * {@link deriveCheckConstraintsFrom} over a `Schema.Struct`'s fields: the
 * bounds a model's `Schema.isGreaterThanOrEqualTo` / `isBetween` checks declare
 * ({@link fieldColumnBounds}) become the table's CHECK constraints. One
 * declaration drives wire validation and the database constraint.
 *
 * The projection is deferred to the returned callback, so this composes inside
 * a `pgTable(...)` call whose fields are still being assembled.
 */
export const deriveFieldCheckConstraints =
  (fields: Schema.Struct.Fields, tableName: string) =>
  (table: Record<string, ExtraConfigColumn>): PgTableExtraConfigValue[] =>
    deriveCheckConstraintsFrom(fieldColumnBounds(fields), tableName)(table);
