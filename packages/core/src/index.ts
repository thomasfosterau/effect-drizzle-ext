/**
 * @copyright Thomas Foster
 *
 * **Effect Schema → Drizzle derivation: the annotation entry (no Drizzle).**
 *
 * A model attribute's base schema carries a {@link dbColumn} annotation
 * describing the database column it backs; a downstream derivation (the
 * {@link ./derive.ts} entry) reads that annotation and emits the matching
 * Drizzle column builder. One declaration — the annotated field — is the single
 * source for both the model projection and the column.
 *
 * This entry point has **no Drizzle dependency**: it is the half a client- /
 * model-layer package can import without pulling the ORM into its bundle. The
 * Drizzle-emitting half lives behind the {@link ./derive.ts} and
 * {@link ./versioned-chain.ts} subpaths.
 *
 * **Why a phantom rides alongside the annotation.** Effect Schema annotations
 * are erased from the static type (`schema.annotate(...)` returns the *same*
 * type, and `resolveAnnotations` widens every read to the augmented
 * `Annotations` interface). So a purely-annotation-driven derivation cannot stay
 * type-safe — it can neither tell *which* fields are columns nor recover their
 * precise column type at the type level. {@link dbColumn} therefore does two
 * things: it attaches a real runtime annotation (the source of truth the runtime
 * reads) **and** carries the metadata literally in a type-level phantom (so the
 * column map stays precisely typed, preserving `$inferSelect`). Annotations
 * alone are runtime-only; type safety needs the phantom.
 *
 * **Extensible column kinds.** The `pg` kind is an open `string` at this layer —
 * the package bakes in no fixed set of kinds. A consumer pins its own kind union
 * (e.g. `text | integer | boolean | timestamp | …custom`) via {@link dbColumnFor}
 * and supplies the matching Drizzle builders to the derivation. So a repo can
 * inject bespoke column kinds (a block-document store, a JSON codec, …) without
 * the package knowing about them.
 *
 * **Why the readers take `Schema.Constraint`, not `Schema.Top`.** Every reader
 * here only *reads* a schema (`resolveAnnotations`, `.ast`, the structural
 * wrapper members); none of them calls `annotate` / `check` / `rebuild`. That is
 * exactly effect's `Schema.Constraint` surface, and it is also the element type
 * of `Schema.Struct.Fields` — so the field readers below can hand a struct's own
 * field straight to a reader with no cast. `Schema.Top` is strictly narrower, so
 * this widening accepts everything a `Schema.Top` parameter would.
 *
 * @module .
 */

import * as Arr from "effect/Array";
import type * as JsonSchema from "effect/JsonSchema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaRepresentation from "effect/SchemaRepresentation";

/**
 * A referential action for a derived foreign-key column — the Drizzle
 * `onDelete` / `onUpdate` vocabulary, restated as plain data so the annotation
 * layer stays Drizzle-free.
 */
export type ReferentialAction = "cascade" | "restrict" | "no action" | "set null" | "set default";

/*
 * The optional members of the three metadata interfaces below are spelled
 * `?: T | undefined`, not `Option`, because they are **Drizzle-facing config**:
 * the derivation hands them to a Drizzle column builder, which reads `undefined`
 * as "not supplied" and would emit an `Option` object as a literal DEFAULT —
 * wrong DDL that no type error and no unit test catches. The boundary is stated
 * once in ./derive.ts; the readers this module owns return `Option`.
 */
/* oxlint-disable effect/prefer-option-over-null -- Drizzle-facing config: Drizzle reads `undefined` as "not supplied" */

/**
 * Reference / foreign-key metadata a column annotation may carry: the target
 * relation + column the derived column foreign-keys to, plus its referential
 * actions. Expressed as **names** (not Drizzle column thunks) so it survives in
 * the Drizzle-free annotation layer; the derivation resolves the names to real
 * columns via its own `resolveReference` hook (see the {@link ./derive.ts}
 * entry).
 *
 * This is the metadata that lets an FK-backed attribute be derived rather than
 * hand-authored as a table-only `references()` column and re-stated in the
 * consuming application's operation value map.
 */
export interface DbColumnReference {
  /** The referenced relation (table) name. */
  readonly table: string;
  /** The referenced column name. */
  readonly column: string;
  /** Referential action on delete of the referenced row. */
  readonly onDelete?: ReferentialAction | undefined;
  /** Referential action on update of the referenced row. */
  readonly onUpdate?: ReferentialAction | undefined;
}

/**
 * Column metadata a model attribute declares about the column it backs. Generic
 * over the column-kind union `Kind` (open `string` by default) — a consumer pins
 * it to its own kinds via {@link dbColumnFor}.
 */
export interface DbColumn<Kind extends string = string> {
  /** The snake_case column name (e.g. `published_at`). */
  readonly column: string;
  /** The column kind (selects the Drizzle builder in the derivation). */
  readonly pg: Kind;
  /** Whether the column is `NOT NULL`. */
  readonly notNull: boolean;
  /** Optional SQL `DEFAULT`. */
  readonly default?: boolean | number | string | undefined;
  /** Optional foreign-key metadata (see {@link DbColumnReference}). */
  readonly references?: DbColumnReference | undefined;
  /**
   * Optional explicit name for the CHECK constraint the column's numeric
   * bounds derive — a migration-compat escape hatch for keeping a historical
   * constraint name where the canonical `${table}_${column}_${suffix}` would
   * rename it. Omit for new columns.
   */
  readonly checkName?: string | undefined;
}

/* oxlint-enable effect/prefer-option-over-null */

/**
 * The annotation key under which {@link dbColumn} stores its metadata.
 * {@link dbColumn} writes it; {@link readDbColumn} and {@link fieldColumns}
 * read it. Namespaced to the package so a consumer's own annotations never
 * collide.
 */
export const DB_COLUMN_KEY = "effect-drizzle-ext/dbColumn";

declare const DbColumnTypeId: unique symbol;

/**
 * A schema carrying db-column metadata `M` in a type-level phantom (the
 * annotation value itself is erased from the type, so the phantom is what keeps
 * the derived column map precise). The phantom property is **required for type
 * matching** — a non-annotated schema must yield `never`, not `unknown`, so the
 * column derivation can tell columns from plain / computed fields — but it is
 * never present at runtime (the runtime reads the real annotation instead).
 */
export type Annotated<S extends Schema.Top, M extends DbColumn> = S & {
  readonly [DbColumnTypeId]: M;
};

/** Recovers the db-column metadata phantom from a schema, or `never`. */
export type DbColumnOf<S> = S extends { readonly [DbColumnTypeId]: infer M extends DbColumn }
  ? M
  : never;

/**
 * Annotate a base schema with the database column it backs. Attaches a genuine
 * Effect annotation (the runtime reads it via {@link readDbColumn}) and carries
 * the metadata literally in the type (so the column derivation stays precisely
 * typed). Wrap the result in a model helper as usual — the helper's projection
 * carries the annotation through to the table factory.
 *
 * Accepts any `pg` string; pin the kind union with {@link dbColumnFor} to catch
 * unknown-kind typos at the annotation site.
 */
export const dbColumn = <S extends Schema.Top, const M extends DbColumn>(
  schema: S,
  meta: M,
): Annotated<S, M> =>
  // SAFETY: the phantom is type-only (never present at runtime), and the
  // annotation just attached under DB_COLUMN_KEY is exactly `meta`.
  schema.annotate({ [DB_COLUMN_KEY]: meta }) as Annotated<S, M>;

/**
 * A {@link dbColumn} constrained to a specific column-kind union `Kind`. A
 * consumer pins its own kinds once — `const dbColumn = dbColumnFor<PgKind>()` —
 * so an annotation naming a kind the derivation can't build is a type error at
 * the annotation site rather than a runtime surprise.
 */
export const dbColumnFor =
  <Kind extends string>() =>
  <S extends Schema.Top, const M extends DbColumn<Kind>>(schema: S, meta: M): Annotated<S, M> =>
    // SAFETY: as in `dbColumn` — the phantom is type-only and the annotation
    // just attached under DB_COLUMN_KEY is exactly `meta`.
    schema.annotate({ [DB_COLUMN_KEY]: meta }) as Annotated<S, M>;

/**
 * Read the db-column annotation off a schema at runtime. `Option.none()` when
 * the schema declares none.
 *
 * Reads the schema's **own** annotations only: `Schema.resolveAnnotations` on a
 * `Schema.optional(...)` / `Schema.NullOr(...)` wrapper does not see the inner
 * schema's annotation. Use {@link fieldColumns} for a struct's fields, which
 * peels those wrappers structurally.
 */
/*
 * NOT migrated to `Option`: this union is not a modelling choice, it names the
 * runtime shape effect's own `Schema.resolveAnnotations` returns — an absent
 * annotation record, and an absent key inside it, are both a literal
 * `undefined`. The foreign `undefined` is converted to `Option` on the very
 * next expression, which is where the boundary is.
 */
/* oxlint-disable effect/prefer-option-over-null -- names effect's own runtime shape at a cast, converted on the same line */
// SAFETY: DB_COLUMN_KEY is namespaced to this package and only `dbColumn` /
// `dbColumnFor` write it, always with a `DbColumn` value.
export const readDbColumn = (schema: Schema.Constraint): Option.Option<DbColumn> =>
  Option.fromNullishOr(Schema.resolveAnnotations(schema)?.[DB_COLUMN_KEY] as DbColumn | undefined);
/* oxlint-enable effect/prefer-option-over-null */

// ── Table-level annotation ────────────────────────────────────────────

/**
 * The base table metadata {@link dbTable} attaches: the SQL leaf name the
 * annotated target backs (a versioned consumer's version table is
 * `${name}_version`).
 *
 * `TableMeta` is the floor, not the whole vocabulary: {@link dbTable} accepts
 * any `TableMeta`, so a **flat** consumer — one whose tables anchor at no
 * hierarchy at all — annotates with `{ name }` and nothing else, instead of
 * re-implementing `dbTable` locally just to drop a field it has no use for.
 * A level-dispatching consumer pins {@link DbTable} via {@link dbTableFor}.
 */
export interface TableMeta {
  /** The snake_case leaf table name (e.g. `podcast_series`). */
  readonly name: string;
}

/**
 * Table metadata that additionally names the hierarchy level the leaf anchors
 * at (selecting the parent table pair in a level-dispatching consumer). Generic
 * over the level union `Level` (open `string` by default) — a consumer pins it
 * to its own levels via {@link dbTableFor}, so a leaf naming an unknown level is
 * a type error at the annotation site.
 */
export interface DbTable<Level extends string = string> extends TableMeta {
  /** The hierarchy level the leaf anchors at (selects the parent table pair). */
  readonly level: Level;
}

declare const DbTableTypeId: unique symbol;

/**
 * A target object carrying db-table metadata `M` in a type-level phantom — the
 * table-level counterpart of {@link Annotated}. The phantom keeps a consumer's
 * level dispatch precise (a `"work"`-anchored leaf cannot be passed to a
 * `"manifestation"` table factory); the runtime reads the real attached
 * metadata via {@link readDbTable}.
 */
export type TableAnnotated<T extends object, M extends TableMeta> = T & {
  readonly [DbTableTypeId]: M;
};

/** Recovers the db-table metadata phantom from a target, or `never`. */
export type DbTableOf<T> = T extends { readonly [DbTableTypeId]: infer M extends TableMeta }
  ? M
  : never;

/**
 * The runtime key under which {@link dbTable} attaches its metadata. A symbol
 * **property on the target object**, not an Effect Schema annotation — and that
 * is the reason {@link dbTable} is generic over any `T extends object` rather
 * than over `Schema.Top`.
 *
 * `annotate` does not annotate in place: it **rebuilds** the schema. For a
 * target assembled as `Object.assign(struct, { … })` — the shape a resource /
 * model definition in the consuming applications takes — a rebuild drops every
 * assigned property, and it breaks the referential identity that family
 * membership and registry lockstep checks compare by. A non-enumerable own
 * symbol property annotates in place, preserving both, and works on a plain
 * object just as well as on a schema.
 */
const DB_TABLE_KEY: unique symbol = Symbol.for("effect-drizzle-ext/dbTable");

/**
 * Annotate any object with the database table it backs. Attaches the metadata
 * as a non-enumerable symbol property (see {@link DB_TABLE_KEY} for why not
 * `annotate`) and carries it literally in the type, so a level-bound table
 * factory can constrain its input to leaves anchored at its level. Returns the
 * **same** object.
 *
 * Accepts any {@link TableMeta}; pin a level union with {@link dbTableFor}.
 */
export const dbTable = <T extends object, const M extends TableMeta>(
  target: T,
  meta: M,
): TableAnnotated<T, M> => {
  Object.defineProperty(target, DB_TABLE_KEY, { value: meta, enumerable: false });
  // SAFETY: the phantom is type-only; the runtime metadata was just attached
  // under DB_TABLE_KEY on this same object.
  return target as TableAnnotated<T, M>;
};

/**
 * A {@link dbTable} constrained to a specific level union `Level`, requiring the
 * full {@link DbTable} metadata. A consumer pins its own levels once — `const
 * dbTable = dbTableFor<LeafLevel>()` — so an annotation naming a level the
 * derivation has no parent binding for is a type error at the annotation site
 * rather than a runtime surprise.
 */
export const dbTableFor =
  <Level extends string>() =>
  <T extends object, const M extends DbTable<Level>>(target: T, meta: M): TableAnnotated<T, M> =>
    dbTable(target, meta);

/**
 * Read the db-table metadata off a target at runtime. `Option.none()` when the
 * target carries none.
 *
 * Typed to the {@link TableMeta} floor: a consumer that annotated with a
 * {@link DbTable} recovers its `level` through the {@link DbTableOf} phantom,
 * which is where the level is statically known.
 */
export const readDbTable = <T extends object>(target: T): Option.Option<TableMeta> =>
  Option.fromNullishOr(
    // SAFETY: DB_TABLE_KEY is a module-private symbol that only `dbTable`
    // writes, always with a `TableMeta`; an unannotated target lacks it.
    (target as T & Partial<Record<typeof DB_TABLE_KEY, TableMeta>>)[DB_TABLE_KEY],
  );

// ── Numeric bounds (schema checks → CHECK-constraint metadata) ────────

/* oxlint-disable effect/prefer-option-over-null -- Drizzle-facing config: consumed by the CHECK derivation alongside DbColumn */

/**
 * Numeric bounds recovered from a schema's checks — the JSON-Schema bound
 * vocabulary. The source of a derived SQL `CHECK` constraint: one declaration
 * (the model's `Schema.isGreaterThanOrEqualTo(0)` / `isBetween` check) drives
 * wire validation **and** the column's database constraint.
 */
export interface NumericBounds {
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly exclusiveMinimum?: number | undefined;
  readonly exclusiveMaximum?: number | undefined;
}

/* oxlint-enable effect/prefer-option-over-null */

/** The bounds of one column-backed attribute, paired with its column metadata. */
export interface ColumnBounds extends NumericBounds {
  readonly column: DbColumn;
}

const BOUND_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const;

/**
 * The neutral `CheckInput` the walker hands a check's `toJsonSchema`: no outer
 * type, no member schemas, which the bound filters ignore.
 */
const NEUTRAL_CHECK_INPUT: SchemaRepresentation.ToJsonSchema.CheckInput = {
  type: undefined,
  schemas: [],
};

/**
 * Whether a `toJsonSchema` output is a plain fragment. The approximate
 * `[fragment, true]` form is an array, whose bound keys read as absent, so the
 * walker reads no bounds from it.
 */
const isFragment = (
  output: SchemaRepresentation.ToJsonSchema.CheckOutput,
): output is JsonSchema.JsonSchema => Predicate.isObject(output);

/** The JSON-Schema fragment a check's `toJsonSchema` annotation exposes, if any. */
const checkFragment = (check: SchemaAST.Check<never>): Option.Option<JsonSchema.JsonSchema> =>
  Option.flatMap(Option.fromNullishOr(check.annotations?.toJsonSchema), (toJsonSchema) =>
    Option.filter(
      // A filter whose toJsonSchema needs context it wasn't given throws — no bounds.
      Option.flatMap(
        Result.getSuccess(Result.try(() => toJsonSchema(NEUTRAL_CHECK_INPUT))),
        Option.fromNullishOr,
      ),
      isFragment,
    ),
  );

/** Merge a fragment's numeric bound keys over `bounds` (the later check wins a key). */
const mergeBounds = (fragment: JsonSchema.JsonSchema, bounds: NumericBounds): NumericBounds =>
  Arr.reduce(BOUND_KEYS, bounds, (acc, key) => {
    const value = fragment[key];
    return Predicate.isNumber(value) ? { ...acc, [key]: value } : acc;
  });

/**
 * Merge the numeric-bound fragments of a check list over `bounds`.
 *
 * `checks` is an `Option` because effect's own AST leaves the field absent; the
 * callers convert that foreign `undefined` at the boundary with
 * `Option.fromNullishOr`.
 */
const collectCheckBounds = (
  checks: Option.Option<ReadonlyArray<SchemaAST.Check<never>>>,
  bounds: NumericBounds,
): NumericBounds =>
  Arr.reduce(
    Option.getOrElse(checks, () => []),
    bounds,
    (acc, check) => {
      // A FilterGroup nests its members under `checks`; recurse into them.
      const nested = Predicate.isTagged(check, "FilterGroup")
        ? collectCheckBounds(Option.some(check.checks), acc)
        : acc;
      return Option.match(checkFragment(check), {
        onNone: () => nested,
        onSome: (fragment) => mergeBounds(fragment, nested),
      });
    },
  );

/**
 * Recover the {@link NumericBounds} a single attribute schema declares, or
 * `Option.none()` when it declares none. Reads the schema's own checks plus the
 * checks of each union member — the `Schema.NullOr(Schema.Finite.check(...))`
 * shape a nullable numeric attribute takes. Deliberately shallow: bounds
 * buried deeper than one union level are a modelling smell, not a supported
 * shape.
 *
 * Exported because the `./jsonapi` entry's resource-level bounds reader is the
 * same walk over a different field source.
 */
export const numericBounds = (schema: Schema.Constraint): Option.Option<NumericBounds> => {
  const { ast } = schema;
  const bounds = Arr.reduce(
    SchemaAST.isUnion(ast) ? ast.types : [],
    collectCheckBounds(Option.fromNullishOr(ast.checks), {}),
    (acc, member) => collectCheckBounds(Option.fromNullishOr(member.checks), acc),
  );
  return Arr.some(BOUND_KEYS, (key) => bounds[key] !== undefined)
    ? Option.some(bounds)
    : Option.none();
};

// ── Struct-field projection ───────────────────────────────────────────

/**
 * Peels the `Schema.optional(...)` / `Schema.optionalKey(...)` /
 * `Schema.NullOr(...)` / `Schema.UndefinedOr(...)` wrappers a model attribute
 * applies, to reach a {@link dbColumn}-annotated base schema's phantom, or
 * `never`. A required attribute carries the annotation on its base schema
 * directly (no peel); an optional / nullable projection wraps it.
 *
 * The wrapper set mirrors what {@link fieldColumns} peels at runtime — note
 * that `Schema.optional(S)` *is* `optionalKey(UndefinedOr(S))`, so the two pairs
 * are one chain, not four independent cases.
 */
export type UnwrapColumn<S> = [DbColumnOf<S>] extends [never]
  ? [S] extends [Schema.optional<infer Inner>]
    ? UnwrapColumn<Inner>
    : [S] extends [Schema.optionalKey<infer Inner>]
      ? UnwrapColumn<Inner>
      : [S] extends [Schema.NullOr<infer Inner>]
        ? UnwrapColumn<Inner>
        : [S] extends [Schema.UndefinedOr<infer Inner>]
          ? UnwrapColumn<Inner>
          : never
  : DbColumnOf<S>;

/**
 * The db-column metadata map a `Schema.Struct`'s fields project to, keyed by the
 * fields that declare a {@link dbColumn} (others drop out of the map entirely).
 * The type-level counterpart of {@link fieldColumns}.
 */
export type FieldColumnsMetaOf<F extends Schema.Struct.Fields> = {
  readonly [K in keyof F as [UnwrapColumn<F[K]>] extends [never] ? never : K]: UnwrapColumn<F[K]>;
};

/**
 * One structural peel of a field wrapper: the schema `schema` wraps, or
 * `Option.none()` when it wraps nothing.
 *
 * Structural, not annotation-driven, because `Schema.resolveAnnotations` on a
 * wrapper does not see the inner schema's annotations — the wrapper is a
 * different schema with its own (empty) annotation record. An
 * `optional` / `optionalKey` wrapper exposes its inner schema as `.schema`; a
 * `NullOr` / `UndefinedOr` union exposes its members as `.members`, of which the
 * `null` / `undefined` arms are the ones to skip.
 */
const underlyingSchema = (schema: Schema.Constraint): Option.Option<Schema.Constraint> => {
  /*
   * NOT migrated to `Option`: this structural view is not a modelling choice,
   * it names the runtime shape of effect's own wrapper schemas — a schema that
   * wraps nothing simply has no `schema` / `members` own property, so the
   * absence *is* `undefined`. The function converts it at its return.
   */
  /* oxlint-disable effect/prefer-option-over-null -- names effect's own runtime shape at a cast, converted at the return */
  // SAFETY: both members are optional and checked before use; a schema that
  // is neither wrapper simply lacks both properties.
  const wrapper = schema as {
    readonly schema?: Schema.Constraint | undefined;
    readonly members?: ReadonlyArray<Schema.Constraint> | undefined;
  };
  /* oxlint-enable effect/prefer-option-over-null */
  if (wrapper.schema !== undefined) return Option.some(wrapper.schema);
  return Arr.findFirst(wrapper.members ?? [], (member) => {
    const tag = member.ast._tag;
    return tag !== "Null" && tag !== "Undefined";
  });
};

/**
 * How many wrappers deep the peel walks before giving up. The deepest shape the
 * projection supports is `optional(NullOr(annotated))`, which is three peels
 * (`optionalKey` → `UndefinedOr` → `NullOr`); the cap is slack above that, and
 * it is what keeps a self-referential schema from recursing forever.
 */
const MAX_WRAPPER_DEPTH = 8;

/**
 * The schema that actually carries the {@link dbColumn} annotation for a struct
 * field: the field itself when it is annotated, otherwise the first annotated
 * schema found by peeling its wrappers. `Option.none()` for a field that backs
 * no column.
 *
 * Returning the *schema* rather than the metadata is what lets
 * {@link fieldColumnBounds} read the bounds off the same node the column was
 * declared on — bounds on `dbColumn(NullOr(Number.check(…)), …)` sit one union
 * level below the annotated node, which is exactly what {@link numericBounds}
 * walks.
 */
const columnSchema = (field: Schema.Constraint, depth = 0): Option.Option<Schema.Constraint> => {
  if (depth > MAX_WRAPPER_DEPTH) return Option.none();
  if (Option.isSome(readDbColumn(field))) return Option.some(field);
  return Option.flatMap(underlyingSchema(field), (inner) => columnSchema(inner, depth + 1));
};

/**
 * Project a `Schema.Struct`'s fields to the per-field {@link DbColumn} metadata
 * the derivation consumes, dropping fields that declare no column. Peels the
 * `optional` / `NullOr` wrappers a field may apply. The type-level counterpart
 * is {@link FieldColumnsMetaOf}.
 */
export const fieldColumns = (fields: Schema.Struct.Fields): Record<string, DbColumn> =>
  R.getSomes(R.map(fields, (field) => Option.flatMap(columnSchema(field), readDbColumn)));

/**
 * Project a `Schema.Struct`'s per-field numeric bounds into plain data a
 * `CHECK`-constraint derivation consumes: for each {@link dbColumn}-annotated
 * field whose schema carries numeric-bound checks, the bounds paired with the
 * column metadata. Fields without a column, or without bounds, drop. The
 * Drizzle-emitting counterpart is the `./derive` entry's
 * `deriveFieldCheckConstraints`.
 */
export const fieldColumnBounds = (fields: Schema.Struct.Fields): Record<string, ColumnBounds> =>
  R.getSomes(
    R.map(fields, (field) =>
      Option.flatMap(columnSchema(field), (schema) =>
        Option.zipWith(
          readDbColumn(schema),
          numericBounds(schema),
          (column, bounds): ColumnBounds => ({ column, ...bounds }),
        ),
      ),
    ),
  );
