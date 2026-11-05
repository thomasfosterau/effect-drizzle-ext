/**
 * @copyright Thomas Foster
 *
 * **Effect Schema → Drizzle derivation: the opt-in versioned-chain interpreter
 * (Drizzle).**
 *
 * The generic "tree of levels, each a stable + version table pair, joined up a
 * composite `(id, version)` FK chain to a root, with fail-closed current-version
 * views" structure — the shape a temporal-versioned node hierarchy takes. Two
 * factories, each parameterised over the bits a specific hierarchy pins:
 *
 * - {@link makeSubtypeTables} — the stable + version table-pair builder. Emits
 *   the structural plumbing (stable `id` → parent FK, version `id` / `version`
 *   columns, the `(id, version)` primary key, and the `(id, version)` →
 *   parent-version FK) while the domain columns stay authored per leaf. The
 *   discriminator constraints (a `type` column arced up the tree) are injected,
 *   so a hierarchy without a discriminator, or with different discriminator
 *   semantics, configures its own.
 *
 * - {@link makeCurrentVersionView} — the uniform fail-closed current-version
 *   view. Resolves each node's current version from a **root version table**,
 *   then INNER JOINs the leaf (and any intermediate version tables) at exactly
 *   that `(id, version)`; a node whose root version advanced past its leaf (a
 *   partial-chain tombstone) yields **no row** — the view fails closed rather
 *   than surfacing a stale older leaf row. The root version table and the
 *   always-joined identity row (plus the columns it merges into every view) are
 *   injected.
 *
 * Depends on Drizzle. The annotation layer ({@link .}) stays free of any
 * versioning opinion — this interpreter is opt-in.
 *
 * @module versioned-chain
 */

import { and, eq, getTableName, max } from "drizzle-orm";
import type { ColumnBuilderBase, GetColumnData, SQL } from "drizzle-orm";
import {
  alias,
  bigint,
  foreignKey,
  primaryKey,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
  type ExtraConfigColumn,
  type PgBigInt64Builder,
  type PgBuildColumns,
  type PgSchema,
  type PgTable,
  type PgTableExtraConfigValue,
  type PgTableWithColumns,
  type PgTextBuilder,
  type PgTimestampBuilder,
  type PgUUIDBuilder,
  type PgViewWithSelection,
  type SetHasDefault,
  type SetIsPrimaryKey,
  type SetNotNull,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as R from "effect/Record";
import {
  enumCheck,
  // oxlint-disable-next-line effect/no-service-constructor-imports -- `makeDiscriminatorConstraints` is a plain DDL factory over a leaf-set callback, not an Effect service constructor; the rule keys on the `make*` name.
  makeDiscriminatorConstraints,
  type TypedStable,
} from "./constraints.ts";
import {
  // oxlint-disable-next-line effect/no-service-constructor-imports -- `makeDeriveColumns` is a plain factory over a builder registry, not an Effect service constructor; the rule keys on the `make*` name.
  makeDeriveColumns,
  type ColumnBuilders,
  type DerivedColumns,
  type DeriveOptions,
} from "./derive.ts";
import type { DbColumn } from "./index.ts";
import { treeError, type Tree } from "./tree.ts";

// ── Subtype table pair ────────────────────────────────────────────────

/** A parent version table contributes its `(id, version)` key as the FK target. */
type ParentVersionTable = PgTable & { id: AnyPgColumn; version: AnyPgColumn };

/** The stable row's `id` + `type` columns a discriminator hook constrains. */
export interface DiscriminatorColumns {
  id: AnyPgColumn;
  type: AnyPgColumn;
}

/* oxlint-disable effect/prefer-option-over-null -- Drizzle builder inputs: this library's rule (packages/core/CLAUDE.md) is that any config threaded straight into a Drizzle builder call stays `?: T | undefined`, never `Option` */
/**
 * Declaration accepted by a {@link makeSubtypeTables} builder.
 *
 * **The optional members below are NOT migrated to `Option`, and must not be.**
 * Two reasons, either sufficient:
 *
 * 1. This is the config a hierarchy hands the Drizzle table builder, and it is
 *    handed on unchanged to a consuming application's database package — a
 *    signature change here is a signature change for every consumer.
 * 2. Every one of them is threaded straight into a Drizzle builder call
 *    (`bigint().default(versionDefault)`, `discriminator`, …). Drizzle reads
 *    plain `undefined` as "not supplied"; an `Option` would be an object it
 *    would try to emit as a value, producing wrong DDL that no type error and
 *    no unit test would catch.
 *
 * The explicit `| undefined` on each is likewise deliberate: a configuring
 * layer can thread its own optional overrides through without per-property
 * conditional spreads (`exactOptionalPropertyTypes`).
 *
 * Constraint and column names are canonical (`${name}_version_pkey`,
 * `${name}_version_${parentVersion}_fk`, an `id` column): no deployed schema
 * needs the historical overrides (effect-drizzle-ext#112, decision 4).
 */
export interface SubtypeTablesConfig<
  TColumns extends Record<string, ColumnBuilderBase>,
  TDiscriminator,
> {
  /** Leaf name; the version table is `${name}_version` (e.g. `video`). */
  name: string;
  /**
   * The parent branch's stable `id` column the leaf's stable row references
   * (cascade delete).
   */
  parentId: AnyPgColumn;
  /**
   * The parent branch's version table; the leaf version's `(id, version)`
   * foreign-keys to its `(id, version)`. Its name seeds the FK constraint name
   * (`${name}_version_${parentVersionName}_fk`).
   */
  parentVersion: ParentVersionTable;
  /** The leaf's own domain columns (beyond the generated id/version). */
  columns: TColumns;
  /**
   * Default for the `version` column — e.g. `0n` for branch-extending leaves
   * whose first version row is written with an explicit `0`. Omitted leaves get
   * a plain `NOT NULL` version.
   */
  versionDefault?: bigint | undefined;
  /**
   * Extra version-table constraints/indexes appended after the generated primary
   * key and parent-version foreign key. The callback receives the version
   * table's columns (including any generated column declared in `columns`).
   */
  extraConstraints?:
    | ((table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[])
    | undefined;
  /**
   * The discriminator declaration for this leaf's stable row. When present, the
   * stable `type` column is made `NOT NULL` and the injected discriminator hook
   * appends its constraints; when absent the stable row keeps a nullable `type`.
   * Its shape is whatever the injected hook consumes.
   */
  discriminator?: TDiscriminator | undefined;
}
/* oxlint-enable effect/prefer-option-over-null */

/**
 * The stable identity row's generated column builders — `id` (the primary key
 * that references the parent branch's stable `id`) and the denormalised leaf
 * `type` discriminator.
 *
 * `type` is a plain {@link PgTextBuilder} rather than a union with its
 * `.notNull()` form because the two reduce: `SetNotNull<T>` is `T & …`, so
 * `SetNotNull<T> | T` collapses to `T` under union subtype reduction. This
 * restates what the compiler already infers for the ternary in the body, it does
 * not widen it — the `NOT NULL` a discriminator adds was never in the inferred
 * type either.
 */
type SubtypeStableColumnBuilders = {
  id: SetIsPrimaryKey<PgUUIDBuilder>;
  type: PgTextBuilder<[string, ...string[]]>;
};

/**
 * The version row's column builders: the generated `(id, version)` key columns
 * plus the leaf's own domain columns. `version` is a plain
 * `SetNotNull<PgBigInt64Builder>` for the same subtype-reduction reason `type`
 * is above — `bigint().notNull().default(…)` is `HasDefault<SetNotNull<…>>`, a
 * subtype of the no-default branch, so the union the ternary produces has
 * already collapsed.
 *
 * This alias is referenced **both** by {@link SubtypeTables} and by the explicit
 * type arguments at the `schema.table` call that builds the table, and it has to
 * be: see the note on that call.
 */
type SubtypeVersionColumnBuilders<TColumns extends Record<string, ColumnBuilderBase>> = {
  id: SetNotNull<PgUUIDBuilder>;
  version: SetNotNull<PgBigInt64Builder>;
} & TColumns;

/**
 * The `{ stable, version }` table pair a {@link makeSubtypeTables} builder
 * returns.
 *
 * **Why this is written out rather than inferred.** Declaration emit cannot
 * name the inferred form. `PgBuildColumns<TTableName, TColumnsMap>` is a
 * homomorphic mapped type; when `TColumnsMap` is generic (it contains this
 * builder's `TColumns`) the compiler cannot reduce it, and the declaration
 * printer expands the mapped type's *body* while printing drizzle's own
 * `TTableName` type parameter by name — a name that is not in scope in the
 * emitted `.d.ts`. The result is an unbound type reference: `tsc` resolves it to
 * the error type, `skipLibCheck: true` hides the `TS2304`, and every consumer
 * reading these tables through the emitted declarations silently gets `any`
 * where it should get the column's real type — a consuming application's
 * database package degrading a table's `$inferSelect["id"]` from `string` to
 * `any` with no type error anywhere in the chain (website #1579). This
 * package's own `tests/dist-consumer` type-checks a consumer fixture against
 * the emitted `dist/`, asserting the chain tables' row types precisely to
 * catch this regression (an unbound name degrades them to `any`, and an
 * `Equals<…>` assertion against `any` is false); it is the gate this module
 * exists chiefly to satisfy.
 *
 * An explicit annotation is emitted verbatim as a type *reference*, so the
 * printer never expands the mapped type and `TTableName` stays bound to
 * drizzle's own declaration. Both `PgBuildColumns` instantiations below restate
 * exactly the arguments the call sites already infer — the tables are still
 * built by `schema.table(…)`, and this only names what it returns.
 *
 * Identical behaviour under TypeScript 6.0.3 and the 7.x tsgo build; this is a
 * printer limitation in both, not a version-specific bug.
 */
export interface SubtypeTables<TColumns extends Record<string, ColumnBuilderBase>> {
  stable: PgTableWithColumns<{
    name: string;
    schema: string;
    columns: PgBuildColumns<string, SubtypeStableColumnBuilders>;
    dialect: "pg";
    isAlias: false;
  }>;
  version: PgTableWithColumns<{
    name: `${string}_version`;
    schema: string;
    columns: PgBuildColumns<`${string}_version`, SubtypeVersionColumnBuilders<TColumns>>;
    dialect: "pg";
    isAlias: false;
  }>;
}

/**
 * Build a `defineSubtypeTables` bound to a discriminator hook. The hook turns a
 * leaf's `discriminator` declaration into the stable-table constraints that
 * enforce it (e.g. a `UNIQUE(id, type)` + composite `(id, type)` → parent FK +
 * per-level CHECK trio); a hierarchy without a discriminator passes a hook that
 * is simply never invoked (its leaves omit `discriminator`).
 *
 * The returned builder emits a regular subtype's `{ stable, version }` table
 * pair with the composite-`(id, version)` FK chain to its parent branch.
 */
export const makeSubtypeTables =
  <TDiscriminator>(
    applyDiscriminator: (
      level: string,
      stable: DiscriminatorColumns,
      discriminator: TDiscriminator,
    ) => PgTableExtraConfigValue[],
  ) =>
  <TColumns extends Record<string, ColumnBuilderBase>>(
    schema: PgSchema,
    {
      name,
      parentId,
      parentVersion,
      columns,
      versionDefault,
      extraConstraints,
      discriminator,
    }: SubtypeTablesConfig<TColumns, TDiscriminator>,
  ): SubtypeTables<TColumns> => {
    const stableColumns = {
      id: uuid("id")
        .primaryKey()
        .references((): AnyPgColumn => parentId, { onDelete: "cascade" }),
      // The threaded leaf-`type` discriminator, denormalised down every stable
      // level. Nullable until a hierarchy applies its discriminator; the
      // injected hook makes it NOT NULL and adds its constraints. `type` lives on
      // the STABLE (identity) row only — never versioned — so the `(id, version)`
      // arc is untouched.
      type: discriminator ? text("type").notNull() : text("type"),
    };
    const stable = discriminator
      ? schema.table(name, stableColumns, (table) =>
          applyDiscriminator(name, { id: table.id, type: table.type }, discriminator),
        )
      : schema.table(name, stableColumns);

    // The type arguments are passed explicitly, and through the same
    // `SubtypeVersionColumnBuilders` alias the `SubtypeTables` return
    // annotation uses, so that both sides are the *identical* instantiation.
    // They are exactly the arguments inference picks on its own — this pins
    // them, it does not change them.
    //
    // It has to be pinned because `PgBuildColumns` bottoms out in key-remapped
    // mapped types (`$inferInsert`'s `RequiredKeyOnly` / `OptionalKeyOnly`),
    // and while `TColumns` is still generic those are related only by
    // reference identity, never structurally. Spell the same type two ways —
    // inferred here, written there — and tsgo rejects the annotation as
    // unrelated to a type printed character-for-character the same (TS2719).
    // Stock tsc 6.0.3 accepts that form; tsgo 7.0.2+effect-tsgo.0.24.3 does
    // not, so the alias is shared rather than repeated.
    const version = schema.table<`${string}_version`, SubtypeVersionColumnBuilders<TColumns>>(
      `${name}_version`,
      {
        id: uuid("id")
          .notNull()
          .references((): AnyPgColumn => stable.id, { onUpdate: "cascade", onDelete: "cascade" }),
        version:
          versionDefault === undefined
            ? bigint("version", { mode: "bigint" }).notNull()
            : bigint("version", { mode: "bigint" }).notNull().default(versionDefault),
        ...columns,
      },
      (table) => {
        const constraints: PgTableExtraConfigValue[] = [
          primaryKey({
            name: `${name}_version_pkey`,
            columns: [table.id, table.version],
          }),
          foreignKey({
            name: `${name}_version_${getTableName(parentVersion)}_fk`,
            columns: [table.id, table.version],
            foreignColumns: [parentVersion.id, parentVersion.version],
          }),
        ];
        return extraConstraints ? [...constraints, ...extraConstraints(table)] : constraints;
      },
    );

    return { stable, version };
  };

// ── Current-version view ──────────────────────────────────────────────

/** A version table participates in the chain via its `(id, version)` key. */
interface VersionTable {
  id: AnyPgColumn;
  version: AnyPgColumn;
}

/** A stable identity table is joined on `id` alone. */
interface StableTable {
  id: AnyPgColumn;
}

/** The explicit, projection-shaped column selection a leaf authors. */
type ViewColumns = Record<string, AnyPgColumn | SQL | SQL.Aliased>;

/** Resolve one selected field to its inferred (nullability-aware) row type. */
type ViewField<TField> = TField extends AnyPgColumn
  ? GetColumnData<TField>
  : TField extends SQL<infer U>
    ? U
    : TField extends SQL.Aliased<infer U>
      ? U
      : never;

/** Inferred `$inferSelect` row for an explicit {@link ViewColumns} map. */
type ViewRow<TColumns extends ViewColumns> = { [K in keyof TColumns]: ViewField<TColumns[K]> };

/**
 * The view type a {@link makeCurrentVersionView} builder returns: a real Drizzle
 * view (usable in `from` / `join` and exposing the column proxies for
 * `eq(view.col, …)`) with `$inferSelect` pinned to the explicit column map plus
 * the injected always-merged columns `TMerge`.
 *
 * The selection is built directly from `columns` + `merge`, so this never
 * depends on the in-body select's nullability/table-name generics — which
 * collapse to `{ [x: string]: never }` because the join chain is assembled
 * untyped.
 */
type CurrentVersionViewResult<TColumns extends ViewColumns, TMerge extends ViewColumns> = Omit<
  PgViewWithSelection<{
    name: string;
    schema: string;
    existing: false;
    selectedFields: TColumns & TMerge;
    isAlias: false;
  }>,
  "$inferSelect"
> & {
  $inferSelect: ViewRow<TColumns & TMerge>;
};

/* oxlint-disable effect/prefer-option-over-null -- Drizzle join inputs: this library's rule (packages/core/CLAUDE.md) is that any config threaded straight into a Drizzle builder call stays `?: T | undefined`, never `Option` */
/**
 * Declaration accepted by a {@link makeCurrentVersionView} builder.
 *
 * **The optional members below are NOT migrated to `Option`, and must not be** —
 * for the same two reasons as {@link SubtypeTablesConfig}: the interface is
 * handed on unchanged to a consuming application's database package, and each
 * member is spread straight into the generated Drizzle join chain
 * (`for (const table of through ?? [])`), where `undefined` means "no such
 * join" and an `Option` would be a truthy object.
 */
export interface CurrentVersionViewConfig<TColumns extends ViewColumns> {
  /** Leaf version table the view resolves to its latest row. */
  leaf: VersionTable;
  /**
   * Intermediate version tables joined on the composite `(id, version)` key,
   * ordered leaf → branch. The root version table is always appended after these
   * by the builder. A **required fact table** (a 6NF satellite keyed
   * `(id, version)` whose row must exist at every version) also joins here —
   * the INNER JOIN doubles as its fail-closed witness.
   */
  through?: VersionTable[] | undefined;
  /**
   * **Optional fact tables** LEFT JOINed at the current `(id, version)`: 6NF
   * satellites whose row-absence at a version encodes NULL (the fact-scoped
   * version storage decision). Selected columns sourced from these must be
   * projected nullability-aware (an `sql<T | null>` aliased expression), since
   * the LEFT JOIN widens a NOT NULL fact column to nullable in the row.
   */
  optional?: VersionTable[] | undefined;
  /** Stable identity tables joined on `id` (explicit `undefined` admitted, as above). */
  on?: StableTable[] | undefined;
  /** Explicit column selection, including `id`, `action`, and `timestamp`. */
  columns: TColumns;
}
/* oxlint-enable effect/prefer-option-over-null */

/** Injected dependencies for a {@link makeCurrentVersionView} builder. */
export interface CurrentVersionViewDeps<
  TRoot extends PgTable & VersionTable,
  TMerge extends ViewColumns,
> {
  /**
   * The root version table currency resolves from — a `MAX(version)` sub-select
   * groups it by `id`, and the leaf / intermediate version tables INNER JOIN at
   * that current `(id, version)`. Also joined for the current row's own columns
   * (e.g. an `action` soft-delete gate and a `timestamp`).
   */
  rootVersion: TRoot;
  /** The always-joined identity row (joined on `id`). */
  identity: StableTable;
  /**
   * Columns merged into every view's selection (sourced from `identity`), so no
   * leaf needs to name them — e.g. a shared `slug`.
   *
   * Passing a **function** instead of a plain object additionally INNER JOINs a
   * `version = 0` alias of `rootVersion` — the node's birth row — and hands it
   * to the callback, so a hierarchy can merge in a true `createdAt` sourced
   * from the first version's own timestamp, distinct from the current
   * version's. The plain-object form skips that join entirely, leaving the
   * emitted view definition byte-identical to before: this matters for a root
   * version table whose current-version view is itself joined **as a view** by
   * another hand-written view, where changing its definition would require
   * drizzle-kit to DROP it — and drizzle-kit doesn't topologically order
   * view-on-view DROPs, so it fails against the still-dependent view.
   *
   * That hazard is confined to a hierarchy's own hand-written views layered on
   * top: the join chain this builder generates only ever reaches version and
   * stable tables (`leaf`, `through`, `optional`, `on`, `identity`,
   * `rootVersion`), never a {@link CurrentVersionViewResult} this module
   * itself returns. No view built by `makeCurrentVersionView` may select from
   * another view built by `makeCurrentVersionView` — that is a library-level
   * rule, not just this comment's observation.
   */
  merge: TMerge | ((versionZero: TRoot) => TMerge);
}

/** Whether a `merge` is the function form, which receives the birth-row alias. */
const isMergeFunction = <TRoot, TMerge>(
  merge: TMerge | ((versionZero: TRoot) => TMerge),
): merge is (versionZero: TRoot) => TMerge => Predicate.isFunction(merge);

/**
 * Build a `currentVersionView` bound to a root version table + identity row.
 * `schema.view(name).as(...)` with the uniform join chain generated from
 * {@link CurrentVersionViewConfig}.
 *
 * The joins only widen the `FROM` clause; they never change the explicit
 * `columns` selection, so the view's `$inferSelect` is derived directly from
 * `columns` + the injected `merge` via {@link CurrentVersionViewResult}. The
 * runtime query is assembled untyped (the chain alternates join shapes), which
 * is why the return type is asserted rather than inferred: letting `.as()` infer
 * the selection through `.from(current)` collapses every column to `never`.
 *
 * Currency is resolved from `rootVersion` (fail-closed): a `MAX(version)`
 * sub-select drives the FROM, and the leaf / intermediate version tables INNER
 * JOIN at that current `(id, version)`. One row per node (the sub-select groups
 * by id) landing on unique `(id, version)` PKs, so no `DISTINCT ON` / `ORDER BY`
 * is needed. A leaf missing at the current version drops out of the INNER JOIN —
 * the view yields no row.
 */
export const makeCurrentVersionView =
  <TRoot extends PgTable & VersionTable, TMerge extends ViewColumns>({
    rootVersion,
    identity,
    merge,
  }: CurrentVersionViewDeps<TRoot, TMerge>) =>
  <TColumns extends ViewColumns>(
    schema: PgSchema,
    name: string,
    { leaf, through = [], optional = [], on = [], columns }: CurrentVersionViewConfig<TColumns>,
  ): CurrentVersionViewResult<TColumns, TMerge> => {
    // `.from()` infers its selection from the table's generic; pinned to the
    // `PgTable` base it is, the sub-select keeps its explicit selection.
    const rootTable: PgTable = rootVersion;
    const view = schema.view(name).as((qb) => {
      // Current version per node, resolved from the root version table — the
      // single home of currency. This sub-select drives the FROM so the leaf
      // join below fails closed on a partial chain.
      const current = qb
        .select({ id: rootVersion.id, version: max(rootVersion.version).as("current_version") })
        .from(rootTable)
        .groupBy(rootVersion.id)
        .as("current_version");
      // A function `merge` additionally resolves the node's birth row (`version
      // = 0`) via an aliased join, so it can merge in a true `createdAt`. A
      // plain-object `merge` skips this entirely — no extra join, no change to
      // the emitted SQL beyond what `columns` already determines (see the
      // `CurrentVersionViewDeps.merge` doc for why that matters).
      const versionZero = isMergeFunction(merge) ? alias(rootVersion, "version_zero") : undefined;
      const mergeColumns =
        // SAFETY: `versionZero` is an alias of `rootVersion` (defined whenever
        // `merge` is a function), exposing the same columns under another name.
        isMergeFunction(merge) ? merge(versionZero as TRoot) : merge;
      // `select(columns)` fixes the selection; the join chain appended below only
      // widens the FROM. The chain is built untyped because its join shapes
      // alternate, and the builder's return type re-pins the selection from
      // `columns` + `merge`. The injected `merge` columns ride along on every
      // view — merged into the fixed selection here, resolved via the identity
      // (and, if present, version-zero) join below.
      const select = qb.select({ ...columns, ...mergeColumns }).from(current);
      // reason: dynamic join chain.
      let q: any = select;
      q = q.innerJoin(leaf, and(eq(current.id, leaf.id), eq(current.version, leaf.version)));
      q = Arr.reduce(through, q, (acc, t) =>
        acc.innerJoin(t, and(eq(current.id, t.id), eq(current.version, t.version))),
      );
      q = Arr.reduce(optional, q, (acc, t) =>
        acc.leftJoin(t, and(eq(current.id, t.id), eq(current.version, t.version))),
      );
      q = Arr.reduce(on, q, (acc, t) => acc.innerJoin(t, eq(current.id, t.id)));
      q = q.innerJoin(identity, eq(current.id, identity.id));
      q = q.innerJoin(
        rootVersion,
        and(eq(current.id, rootVersion.id), eq(current.version, rootVersion.version)),
      );
      if (versionZero) {
        q = q.innerJoin(
          versionZero,
          and(eq(current.id, versionZero.id), eq(versionZero.version, 0n)),
        );
      }
      // SAFETY: the joins only widen the FROM clause; the selection is still
      // exactly `select`'s.
      return q as typeof select;
    });
    // SAFETY: the view selects exactly `columns` + `merge` (see the doc above);
    // `CurrentVersionViewResult` re-pins that selection's `$inferSelect`.
    return view as CurrentVersionViewResult<TColumns, TMerge>;
  };

// ── Version-chain read shapes ─────────────────────────────────────────

/**
 * The actions a version-chain row records by default: a chain appends a
 * `(version, action, timestamp)` row per edit rather than rewriting in place,
 * and a delete is a tombstone version.
 */
export type VersionAction = "create" | "update" | "delete";

/**
 * One entry in a node's append-only version chain — what a version-history
 * listing returns per row. `Action` is the chain's own action vocabulary
 * (default {@link VersionAction}).
 */
export interface VersionChainEntry<Action extends string = VersionAction> {
  /** The version number (0 is the create). */
  readonly version: bigint;
  /** The edit action this version recorded. */
  readonly action: Action;
  /** When the version was written. */
  readonly timestamp: Date;
}

/**
 * One version's reconstructed state — what a browse / compare surface shows,
 * and what a restore re-applies as a new version. Every leaf-chain domain
 * column at `(id, version)`, keyed by column name (leaf-most level wins on a
 * shared name), plus the root chain's `action` / `timestamp`. Generated
 * columns (a search vector) are opaque and belong outside `columns`.
 *
 * `Extra` carries the branch-level facts a hierarchy adds to a snapshot (a
 * content branch's visibility and draft flag, say); the library knows none of
 * them.
 */
export type VersionSnapshot<
  Action extends string = VersionAction,
  Extra extends object = Record<never, never>,
> = VersionChainEntry<Action> &
  Extra & {
    /** Every leaf-chain domain column at this version, keyed by column name. */
    // oxlint-disable-next-line effect/no-unsafe-dictionary-type -- public type: column values are whatever the driver decodes for the consumer's columns; narrowing it would break producers
    readonly columns: Readonly<Record<string, unknown>>;
  };

/** The `createdAt` / `updatedAt` pair {@link versionTimestamps} returns. */
export interface VersionTimestamps {
  /** The birth row's timestamp, or `updatedAt` when the view merges none in. */
  readonly createdAt: Date;
  /** The current version's `timestamp`. */
  readonly updatedAt: Date;
}

/**
 * The `createdAt` / `updatedAt` pair of a current-version row: `updatedAt` is
 * the current version's `timestamp`; `createdAt` is the birth row's own
 * timestamp where the view merges one in (a function `merge` of
 * {@link makeCurrentVersionView}), and falls back to `updatedAt` for a view
 * that carries none (website #1223).
 */
/* oxlint-disable effect/prefer-option-over-null -- a Drizzle row seam: a view row's nullable column is typed `T | null` by Drizzle itself, and a view without the birth-row merge has no `createdAt` key at all */
export const versionTimestamps = (row: {
  readonly timestamp: Date;
  readonly createdAt?: Date | null | undefined;
}): VersionTimestamps => ({
  createdAt: row.createdAt ?? row.timestamp,
  updatedAt: row.timestamp,
});
/* oxlint-enable effect/prefer-option-over-null */

// ── Tree → tables ─────────────────────────────────────────────────────

/** A builder map a table's `columns` takes. */
type ColumnMap = Record<string, ColumnBuilderBase>;

/** `T` as a {@link ColumnMap}, so a mapped column type satisfies the table constraint. */
type AsColumns<T> = T extends ColumnMap ? T : never;

/** The metadata map member `P` of level `K` in tree metadata `M`; `{}` when absent. */
type MetaOf<M, K, P extends "level" | "leaf"> = K extends keyof M
  ? M[K] extends { readonly [Q in P]: infer X }
    ? X
    : Record<never, never>
  : Record<never, never>;

/** The hand-authored columns the hooks `H` give level `K`; `{}` when none. */
type HookColumnsOf<H, K> = K extends keyof H
  ? H[K] extends { readonly columns?: infer C }
    ? Exclude<C, undefined> extends ColumnMap
      ? Exclude<C, undefined>
      : Record<never, never>
    : Record<never, never>
  : Record<never, never>;

/** Whether an entry declares the `"fact-scoped"` level kind. */
type IsFactScoped<E> = E extends { readonly kind?: infer Kind }
  ? [Exclude<Kind, undefined>] extends ["fact-scoped"]
    ? true
    : false
  : false;

/** Level `K`'s own derived columns: its level columns, then its leaf's. */
type OwnColumns<M, K, B extends ColumnBuilders> = DerivedColumns<MetaOf<M, K, "level">, B> &
  DerivedColumns<MetaOf<M, K, "leaf">, B>;

/**
 * The columns level `K`'s version table carries beyond `(id, version)`: its own
 * derived columns (a fact-scoped level keeps them in fact tables instead), then
 * the hand-authored hook columns.
 */
export type TreeVersionColumns<S, M, B extends ColumnBuilders, H, K extends keyof S> = AsColumns<
  (IsFactScoped<S[K]> extends true ? Record<never, never> : OwnColumns<M, K, B>) &
    HookColumnsOf<H, K>
>;

/** A fact table's column builders: the `(id, version)` key plus one fact. */
type FactColumnBuilders<TColumns extends ColumnMap> = {
  id: SetNotNull<PgUUIDBuilder>;
  version: SetNotNull<PgBigInt64Builder>;
} & TColumns;

/**
 * One fact table of a fact-scoped level: `(id, version)` keyed, carrying one
 * column, foreign-keyed to the level's version spine. Written out for the
 * declaration printer, as {@link SubtypeTables} is.
 */
export type FactTable<TColumns extends ColumnMap> = PgTableWithColumns<{
  name: string;
  schema: string;
  columns: PgBuildColumns<string, FactColumnBuilders<TColumns>>;
  dialect: "pg";
  isAlias: false;
}>;

/** Every level's `{ stable, version }` pair, keyed by level name. */
export type TreeLevelTables<S, M, B extends ColumnBuilders, H> = {
  readonly [K in keyof S & string]: SubtypeTables<TreeVersionColumns<S, M, B, H, K>>;
};

/** Every fact-scoped level's fact tables, keyed by level then field; `{}` for a plain level. */
export type TreeFactTables<S, M, B extends ColumnBuilders> = {
  readonly [K in keyof S & string]: IsFactScoped<S[K]> extends true
    ? {
        readonly [F in keyof OwnColumns<M, K, B>]: FactTable<
          AsColumns<Pick<OwnColumns<M, K, B>, F>>
        >;
      }
    : Record<never, never>;
};

/** The root identity table's column builders: `id`, the leaf `type`, then the injected extras. */
type RootIdentityColumnBuilders<IE extends ColumnMap> = {
  id: SetIsPrimaryKey<PgUUIDBuilder>;
  type: SetNotNull<PgTextBuilder<[string, ...string[]]>>;
} & IE;

/**
 * The root version table's column builders: the `(id, version)` key, `action`
 * (the chain's only currency and tombstone state), `timestamp`, the actor,
 * then the injected extras.
 */
type RootVersionColumnBuilders<VE extends ColumnMap> = {
  id: SetNotNull<PgUUIDBuilder>;
  version: SetNotNull<PgBigInt64Builder>;
  action: SetNotNull<PgTextBuilder<[string, ...string[]]>>;
  timestamp: SetHasDefault<SetNotNull<PgTimestampBuilder>>;
  actor: PgTextBuilder<[string, ...string[]]>;
} & VE;

/** The root `{ identity, version }` pair. Written out for the declaration printer. */
export interface TreeRootTables<IE extends ColumnMap, VE extends ColumnMap> {
  identity: PgTableWithColumns<{
    name: string;
    schema: string;
    columns: PgBuildColumns<string, RootIdentityColumnBuilders<IE>>;
    dialect: "pg";
    isAlias: false;
  }>;
  version: PgTableWithColumns<{
    name: string;
    schema: string;
    columns: PgBuildColumns<string, RootVersionColumnBuilders<VE>>;
    dialect: "pg";
    isAlias: false;
  }>;
}

/** Everything {@link makeTreeTables} derives from a tree. */
export interface TreeTables<
  S,
  M,
  B extends ColumnBuilders,
  H,
  IE extends ColumnMap,
  VE extends ColumnMap,
> {
  /** The root identity and version tables. */
  readonly root: TreeRootTables<IE, VE>;
  /** Every level's stable + version pair, keyed by level name. */
  readonly levels: TreeLevelTables<S, M, B, H>;
  /** Every fact-scoped level's fact tables, keyed by level then field. */
  readonly facts: TreeFactTables<S, M, B>;
}

/* oxlint-disable effect/prefer-option-over-null -- Drizzle builder inputs: this library's rule (packages/core/CLAUDE.md) is that any config threaded straight into a Drizzle builder call stays `?: T | undefined`, never `Option` */
/**
 * Per-level hooks for what a model can't carry. Every member is threaded into
 * a Drizzle builder call, so each is `?: T | undefined` (see
 * {@link SubtypeTablesConfig}).
 */
export interface TreeLevelHooks {
  /** Hand-authored version-table columns (an FK backing a relationship, a generated column). */
  readonly columns?: ColumnMap | undefined;
  /** Extra version-table constraints and indexes, after the generated key and FK. */
  readonly extraConstraints?:
    | ((table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[])
    | undefined;
  /**
   * A refinable branch: the `(id, type)` arc of this level and of every level
   * below it gets `ON UPDATE CASCADE`, so flipping the root's `type` from a
   * bare value to a concrete leaf cascades down the existing chain (website's
   * entity refinement).
   */
  readonly refinable?: boolean | undefined;
}

/** The root tables' names and injected columns. */
export interface TreeRootConfig<IE extends ColumnMap, VE extends ColumnMap> {
  /** The identity table's name; `node` when absent. */
  readonly identity?: string | undefined;
  /** The root version table's name; `${identity}_version` when absent. */
  readonly version?: string | undefined;
  /** Extra identity columns (website's `slug`). */
  readonly identityColumns?: IE | undefined;
  /** Extra root-version columns (pulpit's `proposed_by`). */
  readonly versionColumns?: VE | undefined;
  /** The actor column's name; `actor` when absent. */
  readonly actorColumn?: string | undefined;
}

/** The configuration {@link makeTreeTables} takes. */
export interface TreeTablesConfig<
  B extends ColumnBuilders,
  H,
  IE extends ColumnMap,
  VE extends ColumnMap,
> {
  /** The schema every table is created in. */
  readonly schema: PgSchema;
  /** The builder registry the `dbColumn` kinds resolve against. */
  readonly builders: B;
  /** Resolves a `references` annotation to its target column (see `./derive`). */
  readonly resolveReference?: DeriveOptions["resolveReference"];
  /** The root tables' names and injected columns. */
  readonly root?: TreeRootConfig<IE, VE> | undefined;
  /** Per-level hooks, keyed by level name. */
  readonly levels?: H | undefined;
}

/**
 * An injected extras map, or `{}` when the member is absent.
 *
 * SAFETY: `T` is inferred from this very member, so it is a real map when the
 * member is present and defaults to `{}` (the `IE` / `VE` defaults of
 * {@link makeTreeTables}) exactly when it is absent.
 */
const columnsOrEmpty = <T extends ColumnMap>(columns: T | undefined): T => columns ?? ({} as T);
/* oxlint-enable effect/prefer-option-over-null */

/** The `action` values the root version table admits. */
const VERSION_ACTIONS: ReadonlyArray<VersionAction> = ["create", "update", "delete"];

/**
 * Derive every table and constraint of a tree in one call: the root identity
 * table (`id`, `type`, extras; `UNIQUE (id, type)`) and root version table
 * (`(id, version)` key, `action` checked to `create` / `update` / `delete`,
 * `timestamp`, the actor, extras); then per level a stable table (`id` →
 * parent `id`, cascade delete; `type` NOT NULL with `UNIQUE (id, type)`,
 * `(id, type)` → parent `(id, type)`, and a CHECK narrowing `type` to the
 * level's subtree leaves) and a version table (`(id, version)` key and
 * `(id, version)` → parent version FK) carrying the level's level columns,
 * its leaf's columns (both derived through `builders`) and its hook columns.
 * A fact-scoped level's version table is a spine, with one
 * `${level}_${column}` fact table per own column, keyed and foreign-keyed on
 * `(id, version)` (cascade delete).
 *
 * Constraint names are canonical (`${table}_pkey`, `${table}_${parent}_fk`,
 * `${level}_id_type_unique` / `_fk` / `_type_valid`); no version table carries
 * `action`. Column, constraint and CHECK value order follow declaration order,
 * so the same tree always generates the same migration. Throws
 * `DerivationError` at module load for a column kind `builders` lacks or an
 * unresolvable reference.
 *
 * Every table is typed from the tree's column phantom. The one type-erasure
 * seam is inside: the level and fact records are assembled from the runtime
 * tree, then named by {@link TreeTables}.
 *
 * @example
 * ```ts
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { getTableConfig, integer, pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   work: {
 *     columns: { title: dbColumn(Schema.String, { column: "title", pg: "text", notNull: true }) },
 *   },
 *   book: {
 *     parent: "work",
 *     leaf: { pages: dbColumn(Schema.Finite, { column: "pages", pg: "integer", notNull: false }) },
 *   },
 * });
 *
 * const tables = makeTreeTables(tree, {
 *   schema: pgSchema("catalogue"),
 *   builders: { text: (c: string) => text(c), integer: (c: string) => integer(c) },
 * });
 *
 * console.log(getTableConfig(tables.levels.book.version).columns.map((c) => c.name));
 * // ["id", "version", "pages"]
 * ```
 */
export const makeTreeTables = <
  S,
  M,
  B extends ColumnBuilders,
  const H extends { readonly [K in keyof S]?: TreeLevelHooks } = Record<never, never>,
  IE extends ColumnMap = Record<never, never>,
  VE extends ColumnMap = Record<never, never>,
>(
  tree: Tree<S, M>,
  config: TreeTablesConfig<B, H, IE, VE>,
): TreeTables<S, M, B, H, IE, VE> => {
  const { schema } = config;
  const derive = makeDeriveColumns(config.builders, { resolveReference: config.resolveReference });
  const identityName = config.root?.identity ?? "node";
  const versionName = config.root?.version ?? `${identityName}_version`;
  const toolkit = makeDiscriminatorConstraints<string>({
    leaves: (level) =>
      Option.getOrElse(
        Option.map(
          Arr.findFirst(tree.levels, (candidate) => candidate.name === level),
          (found) => found.subtreeLeaves,
        ),
        () => [],
      ),
  });

  const identity = schema.table<string, RootIdentityColumnBuilders<IE>>(
    identityName,
    {
      id: uuid("id").primaryKey(),
      type: text("type").notNull(),
      ...columnsOrEmpty(config.root?.identityColumns),
    },
    (table) => [toolkit.typeUnique(identityName, { id: table.id, type: table.type })],
  );
  const version = schema.table<string, RootVersionColumnBuilders<VE>>(
    versionName,
    {
      id: uuid("id")
        .notNull()
        .references((): AnyPgColumn => identity.id, { onDelete: "cascade" }),
      version: bigint("version", { mode: "bigint" }).notNull(),
      action: text("action").notNull(),
      timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
      actor: text(config.root?.actorColumn ?? "actor"),
      ...columnsOrEmpty(config.root?.versionColumns),
    },
    (table) => [
      primaryKey({ name: `${versionName}_pkey`, columns: [table.id, table.version] }),
      enumCheck(`${versionName}_action_valid`, table.action, VERSION_ACTIONS),
    ],
  );

  const hooksOf = (name: keyof S & string): TreeLevelHooks => config.levels?.[name] ?? {};

  /** One built level: its pair, plus a fact-scoped level's fact tables. */
  interface BuiltLevel {
    readonly tables: SubtypeTables<ColumnMap>;
    readonly facts: Readonly<Record<string, PgTable>>;
  }
  const subtype = makeSubtypeTables(
    (level, stable, parent: { readonly stable: TypedStable; readonly refinable: boolean }) =>
      toolkit.typeConstraints(level, stable, parent.stable, { refinable: parent.refinable }),
  );
  const builtLevel = (built: Readonly<Record<string, BuiltLevel>>, name: string): BuiltLevel =>
    Option.getOrElse(R.get(built, name), () =>
      treeError(`level "${name}" was read before it was built`),
    );
  const buildLevel = (
    built: Readonly<Record<string, BuiltLevel>>,
    level: Tree<S, M>["levels"][number],
  ): BuiltLevel => {
    const parent: { readonly stable: TypedStable; readonly version: ParentVersionTable } =
      Option.match(level.parent, {
        onNone: () => ({ stable: identity, version }),
        onSome: (name) => builtLevel(built, name).tables,
      });
    const hooks = hooksOf(level.name);
    const metas = { ...level.levelColumns, ...level.leafColumns };
    const own: ColumnMap = derive.fromMeta(metas);
    const factScoped = level.kind === "fact-scoped";
    const tables = subtype(schema, {
      name: level.name,
      parentId: parent.stable.id,
      parentVersion: parent.version,
      columns: factScoped ? { ...hooks.columns } : { ...own, ...hooks.columns },
      extraConstraints: hooks.extraConstraints,
      discriminator: {
        stable: parent.stable,
        // A refinable level's whole subtree cascades: a flipped root `type`
        // must travel down every arc below it, not just the first.
        refinable: Arr.some(
          [...level.ancestors, level.name],
          (name) => hooksOf(name).refinable === true,
        ),
      },
    });
    const factOf = ([key, meta]: readonly [string, DbColumn], builder: ColumnBuilderBase) => {
      const name = `${level.name}_${meta.column}`;
      const fact: PgTable = schema.table(
        name,
        {
          id: uuid("id").notNull(),
          version: bigint("version", { mode: "bigint" }).notNull(),
          [key]: builder,
        },
        (table) => [
          primaryKey({ name: `${name}_pkey`, columns: [table.id, table.version] }),
          foreignKey({
            name: `${name}_${getTableName(tables.version)}_fk`,
            columns: [table.id, table.version],
            foreignColumns: [tables.version.id, tables.version.version],
          }).onDelete("cascade"),
        ],
      );
      return [key, fact] as const;
    };
    const facts = factScoped
      ? R.fromEntries(
          Arr.map(Arr.zip(R.toEntries(metas), R.values(own)), ([entry, builder]) =>
            factOf(entry, builder),
          ),
        )
      : {};
    return { tables, facts };
  };

  // Parents first (by depth, declaration order within a depth), so every
  // level's parent tables exist when it is built.
  const built = Arr.reduce(
    Arr.sort(
      tree.levels,
      Order.mapInput(Order.Number, (level: Tree<S, M>["levels"][number]) => level.ancestors.length),
    ),
    R.empty<string, BuiltLevel>(),
    (acc, level) => ({ ...acc, [level.name]: buildLevel(acc, level) }),
  );
  const derived = {
    root: { identity, version },
    levels: R.fromEntries(Arr.map(tree.names, (name) => [name, builtLevel(built, name).tables])),
    facts: R.fromEntries(Arr.map(tree.names, (name) => [name, builtLevel(built, name).facts])),
  };
  // SAFETY: the type-erasure seam. Every level's tables were built above from
  // the same runtime column maps the tree's phantom `M` types (the level's
  // level and leaf `DbColumn` maps through `builders`, plus its hook columns),
  // in the record shape `TreeTables` names; only the per-level precision was
  // erased by assembling them from the runtime tree.
  return derived as TreeTables<S, M, B, H, IE, VE>;
};
