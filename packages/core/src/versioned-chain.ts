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
 *   view. Resolves each node's current version from a **root version table**
 *   (the row no newer version supersedes), then INNER JOINs the leaf (and
 *   any intermediate version tables) at exactly
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

import {
  and,
  desc,
  eq,
  getTableColumns,
  getTableName,
  gt,
  lte,
  notExists,
  sql,
  type Subquery,
} from "drizzle-orm";
import type { ColumnBuilderBase, GetColumnData, SQL } from "drizzle-orm";
import {
  alias,
  bigint,
  foreignKey,
  primaryKey,
  QueryBuilder,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
  type ExtraConfigColumn,
  type HasIdentity,
  index,
  type PgBigInt64Builder,
  type PgBuildColumns,
  type PgSchema,
  type PgTable,
  type PgTableExtraConfigValue,
  type PgTableWithColumns,
  type PgTextBuilder,
  type PgTimestampBuilder,
  type PgUUIDBuilder,
  type PgView,
  type PgViewWithSelection,
  type SubqueryWithSelection,
  type SetHasDefault,
  type SetIsPrimaryKey,
  type SetNotNull,
} from "drizzle-orm/pg-core";
import * as LiteralExact from "@thomasfosterau/effect-ext/LiteralExact";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import { enumCheck, discriminatorConstraintsFor, type TypedStable } from "./constraints.ts";
import {
  deriveColumnsWith,
  type ColumnBuilders,
  type DerivedColumns,
  type DeriveOptions,
} from "./derive.ts";
import type { DbColumn } from "./index.ts";
import { treeError, type LeafName, type MarkerName, type Tree } from "./tree.ts";
import type { VersionAction } from "./version-chain-types.ts";

// ── Subtype table pair ────────────────────────────────────────────────

/** A parent version table contributes its `(id, version)` key as the FK target. */
type ParentVersionTable = PgTable & { id: AnyPgColumn; version: AnyPgColumn };

/** The stable row's `id` + `type` columns a discriminator hook constrains. */
export interface DiscriminatorColumns {
  id: AnyPgColumn;
  type: AnyPgColumn;
}

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
  TStable extends Record<string, ColumnBuilderBase> = Record<never, never>,
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
  /**
   * Extra stable-table columns, appended after the generated `id` and `type`:
   * immutable identity facts written once per node (an external key, say),
   * never versioned. Absent: the stable table is `id` and `type` alone.
   */
  stableColumns?: TStable | undefined;
  /**
   * Extra stable-table constraints and indexes, appended after the
   * discriminator hook's. The callback receives the stable table's columns
   * (`stableColumns` included), so a key unique across a level's nodes is a
   * `unique(…).on(table.key)` here, which a version table, repeating the key
   * per version, can't hold.
   */
  stableConstraints?:
    | ((table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[])
    | undefined;
}

/**
 * The stable identity row's column builders — `id` (the primary key that
 * references the parent branch's stable `id`), the denormalised leaf `type`
 * discriminator, then the injected `TStable` columns.
 *
 * `type` is a plain {@link PgTextBuilder} rather than a union with its
 * `.notNull()` form because the two reduce: `SetNotNull<T>` is `T & …`, so
 * `SetNotNull<T> | T` collapses to `T` under union subtype reduction. This
 * restates what the compiler already infers for the ternary in the body, it does
 * not widen it — the `NOT NULL` a discriminator adds was never in the inferred
 * type either.
 */
type SubtypeStableColumnBuilders<TStable extends Record<string, ColumnBuilderBase>> = {
  id: SetIsPrimaryKey<PgUUIDBuilder>;
  type: PgTextBuilder<[string, ...string[]]>;
} & TStable;

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
export interface SubtypeTables<
  TColumns extends Record<string, ColumnBuilderBase>,
  TStable extends Record<string, ColumnBuilderBase> = Record<never, never>,
> {
  stable: PgTableWithColumns<{
    name: string;
    schema: string;
    columns: PgBuildColumns<string, SubtypeStableColumnBuilders<TStable>>;
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
 * An injected extras map, or `{}` when the member is absent.
 *
 * SAFETY: `T` is inferred from this very member, so it is a real map when the
 * member is present and defaults to `{}` (the `Record<never, never>` defaults
 * of {@link makeSubtypeTables} and {@link makeTreeTables}) exactly when it is
 * absent.
 */
const columnsOrEmpty = <T extends Record<string, ColumnBuilderBase>>(columns: T | undefined): T =>
  columns ?? ({} as T);

/**
 * Build a `defineSubtypeTables` bound to a discriminator hook. The hook turns a
 * leaf's `discriminator` declaration into the stable-table constraints that
 * enforce it (e.g. a `UNIQUE(id, type)` + composite `(id, type)` → parent FK +
 * per-level CHECK trio); a hierarchy without a discriminator passes a hook that
 * is simply never invoked (its leaves omit `discriminator`).
 *
 * The returned builder emits a regular subtype's `{ stable, version }` table
 * pair with the composite-`(id, version)` FK chain to its parent branch. The
 * stable table carries `id`, `type`, then any `stableColumns`; its
 * constraints are the discriminator hook's, then any `stableConstraints`.
 */
export const makeSubtypeTables =
  <TDiscriminator>(
    applyDiscriminator: (
      level: string,
      stable: DiscriminatorColumns,
      discriminator: TDiscriminator,
    ) => PgTableExtraConfigValue[],
  ) =>
  <
    TColumns extends Record<string, ColumnBuilderBase>,
    TStable extends Record<string, ColumnBuilderBase> = Record<never, never>,
  >(
    schema: PgSchema,
    {
      name,
      parentId,
      parentVersion,
      columns,
      versionDefault,
      extraConstraints,
      discriminator,
      stableColumns,
      stableConstraints,
    }: SubtypeTablesConfig<TColumns, TDiscriminator, TStable>,
  ): SubtypeTables<TColumns, TStable> => {
    const stableBuilders = {
      id: uuid("id")
        .primaryKey()
        .references((): AnyPgColumn => parentId, { onDelete: "cascade" }),
      // The threaded leaf-`type` discriminator, denormalised down every stable
      // level. Nullable until a hierarchy applies its discriminator; the
      // injected hook makes it NOT NULL and adds its constraints. `type` lives on
      // the STABLE (identity) row only — never versioned — so the `(id, version)`
      // arc is untouched.
      type: discriminator ? text("type").notNull() : text("type"),
      ...columnsOrEmpty(stableColumns),
    };
    // Pinned through the shared alias for the same reason as the version
    // table below. A table with no extra config keeps the callback-free call,
    // so its DDL is exactly what it was before `stableConstraints` existed.
    const stable =
      discriminator === undefined && stableConstraints === undefined
        ? schema.table<string, SubtypeStableColumnBuilders<TStable>>(name, stableBuilders)
        : schema.table<string, SubtypeStableColumnBuilders<TStable>>(
            name,
            stableBuilders,
            (table) => [
              ...(discriminator === undefined
                ? []
                : applyDiscriminator(name, { id: table.id, type: table.type }, discriminator)),
              ...(stableConstraints === undefined ? [] : stableConstraints(table)),
            ],
          );

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
          // Cascade on delete, as the stable `id` FK does: erasing a node
          // deletes its root version rows, and without the cascade this arc's
          // check would refuse it before the stable cascade reached the level
          // version rows (effect-drizzle-ext#145).
          foreignKey({
            name: `${name}_version_${getTableName(parentVersion)}_fk`,
            columns: [table.id, table.version],
            foreignColumns: [parentVersion.id, parentVersion.version],
          }).onDelete("cascade"),
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

/** Injected dependencies for a {@link makeCurrentVersionView} builder. */
export interface CurrentVersionViewDeps<
  TRoot extends PgTable & VersionTable,
  TMerge extends ViewColumns,
> {
  /**
   * The root version table currency resolves from — its row with no newer
   * version of the same node (`NOT EXISTS`) drives the FROM, and the leaf /
   * intermediate version tables INNER JOIN at that current `(id, version)`.
   * It also supplies the current row's own columns (e.g. an `action`
   * soft-delete gate and a `timestamp`).
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
): merge is (versionZero: TRoot) => TMerge => P.isFunction(merge);

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
 * the selection through the untyped join chain collapses every column to `never`.
 *
 * Currency is resolved from `rootVersion` (fail-closed): its rows drive the
 * FROM, kept only where `NOT EXISTS` a newer version of the same node (an
 * anti-join on the root's `(id, version)` key, so a read filtered or paged by
 * a leaf column never aggregates the whole root table first;
 * effect-drizzle-ext#199), and the leaf / intermediate version tables INNER
 * JOIN at that current `(id, version)`. One row per node landing on unique
 * `(id, version)` PKs, so no `DISTINCT ON` / `ORDER BY` is needed. A leaf
 * missing at the current version drops out of the INNER JOIN — the view yields
 * no row.
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
    // `PgTable` base it is, the select keeps its explicit selection.
    const rootTable: PgTable = rootVersion;
    const view = schema.view(name).as((qb) => {
      // The node's current root version row drives the FROM: a root version
      // no newer version of the same node supersedes (an anti-join on the
      // root's `(id, version)` key, not a grouped `max(version)`, which would
      // aggregate the whole table before any filter applies;
      // effect-drizzle-ext#199). The leaf join below fails closed on a partial
      // chain.
      const newer = alias(rootTable, "newer");
      const newerColumns = getTableColumns(newer);
      const current = notExists(
        qb
          .select({ one: sql`1` })
          .from(newer)
          .where(
            and(
              eq(rootColumnOf(newerColumns, "id"), rootVersion.id),
              gt(rootColumnOf(newerColumns, "version"), rootVersion.version),
            ),
          ),
      );
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
      const select = qb.select({ ...columns, ...mergeColumns }).from(rootTable);
      // reason: dynamic join chain.
      let q: any = select;
      const atCurrent = (t: VersionTable) =>
        and(eq(rootVersion.id, t.id), eq(rootVersion.version, t.version));
      q = q.innerJoin(leaf, atCurrent(leaf));
      q = Arr.reduce(through, q, (acc, t) => acc.innerJoin(t, atCurrent(t)));
      q = Arr.reduce(optional, q, (acc, t) => acc.leftJoin(t, atCurrent(t)));
      q = Arr.reduce(on, q, (acc, t) => acc.innerJoin(t, eq(rootVersion.id, t.id)));
      q = q.innerJoin(identity, eq(rootVersion.id, identity.id));
      if (versionZero) {
        q = q.innerJoin(
          versionZero,
          and(eq(rootVersion.id, versionZero.id), eq(versionZero.version, 0n)),
        );
      }
      q = q.where(current);
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
 * The version-chain read shapes: `VersionAction`, `VersionChainEntry` and
 * `VersionSnapshot`. They live in a Drizzle-free module so the root entry
 * (`.`) exports the same types without reaching Drizzle
 * (effect-drizzle-ext#191); this subpath re-exports them unchanged.
 */
export type { VersionAction, VersionChainEntry, VersionSnapshot } from "./version-chain-types.ts";

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
export const versionTimestamps = (row: {
  readonly timestamp: Date;
  readonly createdAt?: Date | null | undefined;
}): VersionTimestamps => ({
  createdAt: row.createdAt ?? row.timestamp,
  updatedAt: row.timestamp,
});

// ── Tree → tables ─────────────────────────────────────────────────────

/** A builder map a table's `columns` takes. */
type ColumnMap = Record<string, ColumnBuilderBase>;

/** `T` as a {@link ColumnMap}, so a mapped column type satisfies the table constraint. */
type AsColumns<T> = T extends ColumnMap ? T : never;

/** The metadata map member `P` of level `K` in tree metadata `M`; `{}` when absent. */
type MetaOf<M, K, P extends "level" | "leaf" | "keyed"> = K extends keyof M
  ? M[K] extends { readonly [Q in P]: infer X }
    ? X
    : Record<never, never>
  : Record<never, never>;

/** The hand-authored column map member `P` the hooks `H` give level `K`; `{}` when none. */
type HookColumnsOf<H, K, P extends "columns" | "stableColumns" = "columns"> = K extends keyof H
  ? H[K] extends { readonly [Q in P]?: infer C }
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

/**
 * The columns level `K`'s stable table carries beyond `id` and `type`: its
 * `stableColumns` hook, `{}` when none.
 */
export type TreeStableColumns<H, K> = AsColumns<HookColumnsOf<H, K, "stableColumns">>;

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
  readonly [K in keyof S & string]: SubtypeTables<
    TreeVersionColumns<S, M, B, H, K>,
    TreeStableColumns<H, K>
  >;
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

/** The key column's name a leaf entry's keyed level declares; `never` when it has none. */
type KeyedNameOf<E> = E extends { readonly keyed?: infer K }
  ? Exclude<K, undefined> extends { readonly name: infer N extends string }
    ? N
    : never
  : never;

/** A keyed table's column builders: the `(id, version)` key, the key column, then the keyed columns. */
type KeyedColumnBuilders<N extends string, TColumns extends ColumnMap> = {
  id: SetNotNull<PgUUIDBuilder>;
  version: SetNotNull<PgBigInt64Builder>;
} & { [P in N]: SetNotNull<PgTextBuilder<[string, ...string[]]>> } & TColumns;

/**
 * A leaf's keyed fact table: one row per `(id, version, key)`, foreign-keyed
 * to the leaf's version table. Written out for the declaration printer, as
 * {@link SubtypeTables} is.
 */
export type KeyedTable<N extends string, TColumns extends ColumnMap> = PgTableWithColumns<{
  name: string;
  schema: string;
  columns: PgBuildColumns<string, KeyedColumnBuilders<N, TColumns>>;
  dialect: "pg";
  isAlias: false;
}>;

/** Every keyed leaf's keyed table, keyed by leaf name; a leaf with no keyed level is absent. */
export type TreeKeyedTables<S, M, B extends ColumnBuilders> = {
  readonly [K in keyof S & string as [KeyedNameOf<S[K]>] extends [never] ? never : K]: KeyedTable<
    KeyedNameOf<S[K]>,
    AsColumns<DerivedColumns<MetaOf<M, K, "keyed">, B>>
  >;
};

/**
 * A pointer log's column builders: the record order `seq`, the node, the
 * version it names (`NULL` clears the pointer), when the fact takes effect
 * (`at`), the actor and when it was recorded.
 */
type PointerColumnBuilders = {
  seq: HasIdentity<SetIsPrimaryKey<PgBigInt64Builder>, "always">;
  id: SetNotNull<PgUUIDBuilder>;
  version: PgBigInt64Builder;
  at: SetHasDefault<SetNotNull<PgTimestampBuilder>>;
  actor: PgTextBuilder<[string, ...string[]]>;
  recordedAt: SetHasDefault<SetNotNull<PgTimestampBuilder>>;
};

/**
 * A named pointer's append-only log (`${name}_pointer`). Its effective fact
 * per node is the latest recorded one (highest `seq`) whose `at` has
 * arrived; the pointer names that fact's version, or nothing when it is
 * `NULL`. Written out for the declaration printer.
 */
export type PointerTable = PgTableWithColumns<{
  name: string;
  schema: string;
  columns: PgBuildColumns<string, PointerColumnBuilders>;
  dialect: "pg";
  isAlias: false;
}>;

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
  P extends string = never,
> {
  /** The root identity and version tables. */
  readonly root: TreeRootTables<IE, VE>;
  /** Every level's stable + version pair, keyed by level name. */
  readonly levels: TreeLevelTables<S, M, B, H>;
  /** Every fact-scoped level's fact tables, keyed by level then field. */
  readonly facts: TreeFactTables<S, M, B>;
  /** Every keyed leaf's keyed table, keyed by leaf name. */
  readonly keyed: TreeKeyedTables<S, M, B>;
  /** Every named pointer's log, keyed by pointer name. */
  readonly pointers: { readonly [N in P]: PointerTable };
}

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
   * Hand-authored stable-table columns, after the generated `id` and `type`:
   * immutable identity facts written once at create (an external key, say),
   * projected into every view whose path reaches the level. `makeTreeTables`
   * throws `DerivationError` at module load for a key the stable table
   * (`id`, `type`) or the level's version table already has.
   */
  readonly stableColumns?: ColumnMap | undefined;
  /**
   * Extra stable-table constraints and indexes, after the generated
   * discriminator constraints: where a key unique across the level's nodes
   * goes (`unique("person_wikidata_id_unique").on(table.wikidataId)`), since
   * every version row repeats a version column.
   */
  readonly stableConstraints?:
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

/** The root tables' names, injected columns and named pointers. */
export interface TreeRootConfig<
  IE extends ColumnMap,
  VE extends ColumnMap,
  P extends string = never,
> {
  /** The identity table's name; `node` when absent. */
  readonly identity?: string | undefined;
  /** The root version table's name; `${identity}_version` when absent. */
  readonly version?: string | undefined;
  /** Extra identity columns (website's `slug`). */
  readonly identityColumns?: IE | undefined;
  /**
   * Extra identity-table constraints and indexes, after the generated
   * `UNIQUE (id, type)`; the callback receives the identity table's columns
   * (`identityColumns` included).
   */
  readonly identityConstraints?:
    | ((table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[])
    | undefined;
  /** Extra root-version columns (pulpit's `proposed_by`). */
  readonly versionColumns?: VE | undefined;
  /** The actor column's name; `actor` when absent. */
  readonly actorColumn?: string | undefined;
  /**
   * Named pointers into each node's chain (`["live"]`, say): one append-only
   * `${name}_pointer` log each, whose effective fact names the version a
   * pointer view resolves at. Writing a pointer never appends a version.
   */
  readonly pointers?: ReadonlyArray<P> | undefined;
}

/** The configuration {@link makeTreeTables} takes. */
export interface TreeTablesConfig<
  B extends ColumnBuilders,
  H,
  IE extends ColumnMap,
  VE extends ColumnMap,
  P extends string = never,
> {
  /** The schema every table is created in. */
  readonly schema: PgSchema;
  /** The builder registry the `dbColumn` kinds resolve against. */
  readonly builders: B;
  /** Resolves a `references` annotation to its target column (see `./derive`). */
  readonly resolveReference?: DeriveOptions["resolveReference"];
  /** The root tables' names, injected columns and named pointers. */
  readonly root?: TreeRootConfig<IE, VE, P> | undefined;
  /** Per-level hooks, keyed by level name. */
  readonly levels?: H | undefined;
}

/**
 * Throws `DerivationError` at module load when an injected column map shares a
 * key with the columns a table already has, naming the key and both sources:
 * spread after them, it would silently replace the earlier column. `target`
 * names what gets both (`table "node"`).
 */
const rejectSharedKeys = (
  target: string,
  existing: { readonly source: string; readonly keys: ReadonlyArray<string> },
  injected: { readonly source: string; readonly columns: ColumnMap | undefined },
): void =>
  Arr.forEach(R.keys(injected.columns ?? {}), (key) => {
    if (Arr.contains(existing.keys, key)) {
      treeError(
        `${target} gets "${key}" from both ${existing.source} and ${injected.source}; rename the ${injected.source} key`,
      );
    }
  });

/**
 * The `action` values the root version table admits, in CHECK order; a
 * compile error if they stop naming every {@link VersionAction} exactly.
 */
const VERSION_ACTIONS = LiteralExact.tuple<VersionAction>()(["create", "update", "delete"]);

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
 * A keyed leaf (`keyed: { name, columns }` on its tree entry) gets a
 * `${leaf}_${name}` table keyed `(id, version, name)`, foreign-keyed to its
 * version table (cascade delete). Each name in `root.pointers` gets an
 * append-only `${name}_pointer` log (`seq`, `id`, a nullable `version`
 * foreign-keyed to the root version table, `at`, the actor, `recorded_at`).
 *
 * A level's `stableColumns` hook lands on its stable table after `id` and
 * `type`, and its `stableConstraints` after the discriminator constraints;
 * `root.identityConstraints` follow the identity table's `UNIQUE (id, type)`.
 *
 * Constraint names are canonical (`${table}_pkey`, `${table}_${parent}_fk`,
 * `${level}_id_type_unique` / `_fk` / `_type_valid`); no version table carries
 * `action`. Column, constraint and CHECK value order follow declaration order,
 * so the same tree always generates the same migration. Throws
 * `DerivationError` at module load for a column kind `builders` lacks, an
 * unresolvable reference, an injected column (`root.identityColumns`,
 * `root.versionColumns`, a level's `columns` or `stableColumns` hook) whose
 * key the table already has, or a `stableColumns` key the level's version
 * table also has, naming the key and both sources.
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
  const P extends string = never,
>(
  tree: Tree<S, M>,
  config: TreeTablesConfig<B, H, IE, VE, P>,
): TreeTables<S, M, B, H, IE, VE, P> => {
  const { schema } = config;
  const derive = deriveColumnsWith(config.builders, { resolveReference: config.resolveReference });
  const identityName = config.root?.identity ?? "node";
  const versionName = config.root?.version ?? `${identityName}_version`;
  const toolkit = discriminatorConstraintsFor<string>({
    leaves: (level) =>
      Option.getOrElse(
        Option.map(
          Arr.findFirst(tree.levels, (candidate) => candidate.name === level),
          (found) => found.subtreeLeaves,
        ),
        () => [],
      ),
  });

  rejectSharedKeys(
    `table "${identityName}"`,
    { source: "the identity table's own columns", keys: ["id", "type"] },
    { source: "root.identityColumns", columns: config.root?.identityColumns },
  );
  rejectSharedKeys(
    `table "${versionName}"`,
    {
      source: "the root version table's own columns",
      keys: ["id", "version", "action", "timestamp", "actor"],
    },
    { source: "root.versionColumns", columns: config.root?.versionColumns },
  );
  const identity = schema.table<string, RootIdentityColumnBuilders<IE>>(
    identityName,
    {
      id: uuid("id").primaryKey(),
      type: text("type").notNull(),
      ...columnsOrEmpty(config.root?.identityColumns),
    },
    (table) => [
      toolkit.typeUnique(identityName, { id: table.id, type: table.type }),
      ...(config.root?.identityConstraints?.(table) ?? []),
    ],
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
    readonly tables: SubtypeTables<ColumnMap, ColumnMap>;
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
    rejectSharedKeys(
      `table "${level.name}"`,
      { source: `level "${level.name}"'s tree columns`, keys: ["id", "version", ...R.keys(own)] },
      { source: `levels.${level.name}.columns`, columns: hooks.columns },
    );
    rejectSharedKeys(
      `table "${level.name}"`,
      { source: "the stable table's own columns", keys: ["id", "type"] },
      { source: `levels.${level.name}.stableColumns`, columns: hooks.stableColumns },
    );
    // Both tables reach every view on the level's path under their keys.
    rejectSharedKeys(
      `level "${level.name}"`,
      {
        source: `level "${level.name}"'s version columns`,
        keys: ["version", ...R.keys(own), ...R.keys(hooks.columns ?? {})],
      },
      { source: `levels.${level.name}.stableColumns`, columns: hooks.stableColumns },
    );
    const tables = subtype(schema, {
      name: level.name,
      parentId: parent.stable.id,
      parentVersion: parent.version,
      columns: factScoped ? { ...hooks.columns } : { ...own, ...hooks.columns },
      extraConstraints: hooks.extraConstraints,
      stableColumns: hooks.stableColumns,
      stableConstraints: hooks.stableConstraints,
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
  // A keyed leaf's `(id, version, key)` table, foreign-keyed to its version table.
  const keyedOf = (level: Tree<S, M>["levels"][number]) =>
    Option.map(level.keyed, (keyed): readonly [string, PgTable] => {
      const leafVersion = builtLevel(built, level.name).tables.version;
      const name = `${level.name}_${keyed.name}`;
      const table: PgTable = schema.table(
        name,
        {
          id: uuid("id").notNull(),
          version: bigint("version", { mode: "bigint" }).notNull(),
          [keyed.name]: text(keyed.name).notNull(),
          ...derive.fromMeta(keyed.columns),
        },
        (columns) => [
          primaryKey({
            name: `${name}_pkey`,
            columns: [columns.id, columns.version, rootColumnOf(columns, keyed.name)],
          }),
          foreignKey({
            name: `${name}_${getTableName(leafVersion)}_fk`,
            columns: [columns.id, columns.version],
            foreignColumns: [leafVersion.id, leafVersion.version],
          }).onDelete("cascade"),
        ],
      );
      return [level.name, table];
    });
  // A named pointer's append-only log.
  const pointerOf = (pointer: string) => {
    const name = `${pointer}_pointer`;
    const table = schema.table<string, PointerColumnBuilders>(
      name,
      {
        seq: bigint("seq", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
        id: uuid("id")
          .notNull()
          .references((): AnyPgColumn => identity.id, { onDelete: "cascade" }),
        version: bigint("version", { mode: "bigint" }),
        at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
        actor: text(config.root?.actorColumn ?? "actor"),
        recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
      },
      (columns) => [
        foreignKey({
          name: `${name}_${versionName}_fk`,
          columns: [columns.id, columns.version],
          foreignColumns: [version.id, version.version],
        }).onDelete("cascade"),
        index(`${name}_id_seq_idx`).on(columns.id, columns.seq),
      ],
    );
    return [pointer, table] as const;
  };
  const derived = {
    root: { identity, version },
    levels: R.fromEntries(Arr.map(tree.names, (name) => [name, builtLevel(built, name).tables])),
    facts: R.fromEntries(Arr.map(tree.names, (name) => [name, builtLevel(built, name).facts])),
  };
  // SAFETY: as the seam below: each keyed table was built from the leaf's
  // keyed `DbColumn` map through `builders`, under its declared key name.
  const keyed = R.fromEntries(
    Arr.flatMap(tree.levels, (level) => Arr.fromOption(keyedOf(level))),
  ) as TreeKeyedTables<S, M, B>;
  // SAFETY: one log per name in `config.root.pointers`, the very names `P`
  // was inferred from.
  const pointers = R.fromEntries(Arr.map(config.root?.pointers ?? [], pointerOf)) as {
    readonly [N in P]: PointerTable;
  };
  // SAFETY: the type-erasure seam. Every level's tables were built above from
  // the same runtime column maps the tree's phantom `M` types (the level's
  // level and leaf `DbColumn` maps through `builders`, plus its hook columns),
  // in the record shape `TreeTables` names; only the per-level precision was
  // erased by assembling them from the runtime tree.
  return {
    ...(derived as Omit<TreeTables<S, M, B, H, IE, VE, P>, "keyed" | "pointers">),
    keyed,
    pointers,
  };
};

// ── Tree → views ──────────────────────────────────────────────────────

/**
 * The shape of {@link makeTreeTables}'s output that {@link makeTreeViews}
 * reads: the root pair, every level's pair and every level's fact tables.
 */
export interface AnyTreeTables {
  readonly root: { readonly identity: PgTable; readonly version: PgTable };
  readonly levels: Readonly<
    Record<string, { readonly stable: PgTable; readonly version: PgTable }>
  >;
  readonly facts: Readonly<Record<string, Readonly<Record<string, PgTable>>>>;
  readonly keyed: Readonly<Record<string, PgTable>>;
  readonly pointers: Readonly<Record<string, PgTable>>;
}

/** Flatten an intersection of selections into one object type, for the hover. */
type Simplify<A> = { [K in keyof A]: A[K] };

/** A table type's built column map. */
type ColumnsOfTable<T> = T extends { readonly _: { readonly columns: infer C } } ? C : never;

/** The data type of column `F` in column map `C`. */
type ColumnDataOf<C, F> = F extends keyof C
  ? C[F] extends AnyPgColumn
    ? GetColumnData<C[F]>
    : never
  : never;

/** Level `K`'s path from its branch root down to itself, as a tuple of names. */
export type TreePathOf<S, K> = K extends keyof S
  ? S[K] extends { readonly parent: infer P }
    ? P extends keyof S
      ? [...TreePathOf<S, P>, K]
      : [K]
    : [K]
  : [];

/**
 * What one level contributes to a view: its stable table's columns past
 * `(id, type)`, its version table's past `(id, version)`, then each fact
 * table's fact, LEFT JOINed and so nullable.
 */
type LevelViewColumns<T extends AnyTreeTables, L> = L extends keyof T["levels"]
  ? Omit<ColumnsOfTable<T["levels"][L]["stable"]>, "id" | "type"> &
      Omit<ColumnsOfTable<T["levels"][L]["version"]>, "id" | "version"> &
      (L extends keyof T["facts"]
        ? {
            readonly [F in keyof T["facts"][L]]: SQL.Aliased<ColumnDataOf<
              ColumnsOfTable<T["facts"][L][F]>,
              F
            > | null>;
          }
        : Record<never, never>)
  : Record<never, never>;

/** Every level on a path's contribution, root-most first. */
type PathViewColumns<T extends AnyTreeTables, P> = P extends readonly [infer H, ...infer Rest]
  ? LevelViewColumns<T, H> & PathViewColumns<T, Rest>
  : Record<never, never>;

/** The root version table's columns. */
type RootVersionColumnsOf<T extends AnyTreeTables> = ColumnsOfTable<T["root"]["version"]>;

/** The columns every tree view opens with: the head's `id`, `version` and `action`. */
type HeadViewColumns<T extends AnyTreeTables> = Pick<
  RootVersionColumnsOf<T>,
  "id" | "version" | "action"
>;

/** The columns every tree view closes with: the head's `timestamp` and the birth row's. */
type TailViewColumns<T extends AnyTreeTables> = Pick<RootVersionColumnsOf<T>, "timestamp"> & {
  readonly createdAt: SQL.Aliased<Date>;
};

/** The root identity table's injected extras (`slug`, say). */
type IdentityViewColumns<T extends AnyTreeTables> = Omit<
  ColumnsOfTable<T["root"]["identity"]>,
  "id" | "type"
>;

/**
 * The selection of leaf `K`'s current-version view: `id`, `version`, `action`,
 * the identity extras, every level's columns from the branch root down to the
 * leaf (each level's `stableColumns`, then its version and fact columns), then
 * `timestamp` and `createdAt` (the version-0 timestamp).
 */
export type TreeLeafSelection<S, T extends AnyTreeTables, K> = Simplify<
  HeadViewColumns<T> &
    IdentityViewColumns<T> &
    PathViewColumns<T, TreePathOf<S, K>> &
    TailViewColumns<T>
>;

/** The columns a branch view's `project` adds, or none. */
type ProjectedColumnsOf<P> = P extends ViewColumns ? P : Record<never, never>;

/**
 * The selection of marker `K`'s branch view: `id`, `version`, `action`, the
 * leaf `type`, the identity extras, the columns of every level from the branch
 * root down to `K`, `timestamp`, `createdAt`, then whatever `project` adds.
 */
export type TreeBranchSelection<S, T extends AnyTreeTables, K, P> = Simplify<
  HeadViewColumns<T> &
    Pick<ColumnsOfTable<T["root"]["identity"]>, "type"> &
    IdentityViewColumns<T> &
    PathViewColumns<T, TreePathOf<S, K>> &
    TailViewColumns<T> &
    ProjectedColumnsOf<P>
>;

/** The key column and keyed columns a keyed view adds for leaf `K`, LEFT JOINed and so nullable. */
type KeyedViewColumns<T extends AnyTreeTables, K> = K extends keyof T["keyed"]
  ? {
      readonly [
        C in keyof Omit<ColumnsOfTable<T["keyed"][K]>, "id" | "version">
      ]: SQL.Aliased<ColumnDataOf<ColumnsOfTable<T["keyed"][K]>, C> | null>;
    }
  : Record<never, never>;

/**
 * The selection of leaf `K`'s keyed view: the leaf view's, then the key
 * column and the keyed columns (`NULL` for a version that carries no key).
 */
export type TreeKeyedSelection<S, T extends AnyTreeTables, K> = Simplify<
  TreeLeafSelection<S, T, K> & KeyedViewColumns<T, K>
>;

/** `X` as a view selection, so a mapped selection satisfies `TreeView`'s constraint. */
type AsViewColumns<X> = X extends ViewColumns ? X : never;

/** The column a pointer view adds: when its effective fact took effect (`${pointer}At`). */
type PointerViewColumns<N> = { readonly [Q in `${N & string}At`]: SQL.Aliased<Date> };

/**
 * The selection of leaf `K`'s view at pointer `N`: the leaf view's, with
 * `version` the pointed one and `action` the head's, then `${N}At`.
 */
export type TreePointerSelection<S, T extends AnyTreeTables, K, N> = Simplify<
  TreeLeafSelection<S, T, K> & PointerViewColumns<N>
>;

/** {@link TreePointerSelection} of a keyed leaf, with the keyed columns. */
export type TreeKeyedPointerSelection<S, T extends AnyTreeTables, K, N> = Simplify<
  TreeLeafSelection<S, T, K> & KeyedViewColumns<T, K> & PointerViewColumns<N>
>;

/**
 * A view {@link makeTreeViews} derives: a real Drizzle view, usable in `from` /
 * `join` and exposing its column proxies, with `$inferSelect` pinned to its
 * selection. Written out for the declaration printer, as
 * {@link SubtypeTables} is.
 */
export type TreeView<TSelection extends ViewColumns> = Omit<
  PgViewWithSelection<{
    name: string;
    schema: string;
    existing: false;
    selectedFields: TSelection;
    isAlias: false;
  }>,
  "$inferSelect"
> & {
  $inferSelect: ViewRow<TSelection>;
};

/**
 * One branch view's options. `project` adds per-leaf columns to every arm of
 * the union (a search vector, a search text): it receives the leaf's name and
 * every column the leaf's chain joins (level, leaf, hook, stable and fact columns,
 * keyed by field), and must return the same keys, in the same order, for
 * every leaf.
 */
export interface TreeBranchViewConfig<P = ViewColumns> {
  readonly project?:
    | ((leaf: string, columns: Readonly<ViewColumns>) => P & ViewColumns)
    | undefined;
}

/**
 * The configuration {@link makeTreeViews} takes. `BR` maps each opted-in
 * marker to the columns its `project` adds (inferred).
 */
export interface TreeViewsConfig<BR, PV = Record<never, never>> {
  /** The schema every view is created in. */
  readonly schema: PgSchema;
  /**
   * Per named pointer (`makeTreeTables`' `root.pointers`), the leaves that
   * get a view resolved at it (`${leaf}_${pointer}_view`, and
   * `${leaf}_${keyed}_${pointer}_view` for a keyed leaf). Absent: none.
   */
  readonly pointers?: PV | undefined;
  /**
   * The marker levels that get a branch view (`${level}_view`), each `true` or
   * its {@link TreeBranchViewConfig}. Absent: no branch views. An entry with a
   * `project` that names a leaf or no level is a type error; any such entry
   * throws `DerivationError` at module load.
   */
  readonly branches?: { readonly [K in keyof BR]: true | TreeBranchViewConfig<BR[K]> } | undefined;
}

/**
 * The point an {@link TreeViews.asOf} read resolves each node at: the latest
 * version at or below `version`, or the latest written at or before `at`.
 */
export type AsOfPoint = { readonly version: bigint } | { readonly at: Date };

/** Everything {@link makeTreeViews} derives from a tree. */
/** The leaves `PV` names for pointer `N`. */
type PointerLeavesOf<PV, N, S> = N extends keyof PV
  ? PV[N] extends ReadonlyArray<infer L>
    ? L & LeafName<S>
    : never
  : never;

export interface TreeViews<S, T extends AnyTreeTables, BR, PV = Record<never, never>> {
  /** Every leaf's current-version view (`${leaf}_view`), keyed by leaf name. */
  readonly leaves: { readonly [K in LeafName<S>]: TreeView<TreeLeafSelection<S, T, K>> };
  /**
   * Every keyed leaf's keyed view (`${leaf}_${keyed}_view`): one row per key
   * the head carries, and one row with a `NULL` key for a head with none.
   */
  readonly keyed: {
    readonly [K in LeafName<S> & keyof T["keyed"]]: TreeView<TreeKeyedSelection<S, T, K>>;
  };
  /**
   * Per pointer, its leaves' views at the pointed version: `leaves` (one row
   * per node) and, for a keyed leaf, `keyed` (one row per key). A node whose
   * effective fact names no version, or that has none, has no row.
   */
  readonly pointers: {
    readonly [N in keyof PV & string]: {
      readonly leaves: {
        readonly [K in PointerLeavesOf<PV, N, S>]: TreeView<
          AsViewColumns<TreePointerSelection<S, T, K, N>>
        >;
      };
      readonly keyed: {
        readonly [K in PointerLeavesOf<PV, N, S> & keyof T["keyed"]]: TreeView<
          AsViewColumns<TreeKeyedPointerSelection<S, T, K, N>>
        >;
      };
    };
  };
  /** Every opted-in marker's branch view (`${level}_view`), keyed by level name. */
  readonly branches: {
    readonly [K in keyof BR & MarkerName<S>]: TreeView<TreeBranchSelection<S, T, K, BR[K]>>;
  };
  /**
   * Leaf `leaf`'s view resolved at `point` instead of the head, as a subquery
   * (`${leaf}_as_of`) to select from: `tx.select().from(views.asOf("book",
   * { version: 2n }))`. A PostgreSQL view takes no parameter, so this is a
   * query builder; it fails closed exactly as the view does, at the resolved
   * version.
   */
  readonly asOf: <K extends LeafName<S>>(
    leaf: K,
    point: AsOfPoint,
  ) => SubqueryWithSelection<TreeLeafSelection<S, T, K>, `${K}_as_of`>;
}

/** A pointer's effective-fact subquery: one `(id, version)` row per node. */
type PointerFact = Subquery & {
  readonly id: AnyPgColumn;
  readonly version: SQL.Aliased<unknown>;
};

/**
 * What an arm drives its FROM from. A head arm drives from the leaf's own
 * version table, keeping only head rows by an anti-join on the root version
 * key (optionally bounded, for `asOf`); a pointer arm drives from the
 * pointer's effective fact and resolves the head separately, for `action`.
 */
type ArmDriver = Data.TaggedEnum<{
  Head: { readonly bound: Option.Option<(table: PgTable) => SQL> };
  Pointer: { readonly fact: PointerFact };
}>;
const ArmDriver = Data.taggedEnum<ArmDriver>();

/**
 * How an arm is assembled from its {@link ArmDriver}: the FROM source, the id
 * and `(id, version)` condition its joins key off, the levels it joins, the
 * head row (a pointer arm's `action` source) and the head the anti-join
 * checks, within `bound`.
 */
interface ArmPlan {
  readonly from: PgTable | Subquery;
  readonly id: AnyPgColumn;
  readonly on: (table: PgTable) => SQL | undefined;
  readonly levels: ReadonlyArray<string>;
  readonly headRow: Option.Option<PgTable>;
  readonly head: { readonly id: AnyPgColumn; readonly version: AnyPgColumn };
  readonly bound: Option.Option<(table: PgTable) => SQL>;
}

/** A head arm, unbounded: the current version of every node. */
const atHead = ArmDriver.Head({ bound: Option.none() });

/** A runtime view selection, assembled from the tree. */
type RuntimeSelection = ViewColumns;

/** Column `key` of a root table, or a thrown `DerivationError` for a table not built by `makeTreeTables`. */
const rootColumnOf = (columns: Readonly<Record<string, AnyPgColumn>>, key: string): AnyPgColumn =>
  Option.getOrElse(R.get(columns, key), () =>
    treeError(`the root tables have no "${key}" column; were they built by makeTreeTables?`),
  );

/** A branch entry as the builder reads it: `project` returns some selection. */
interface RuntimeBranchConfig {
  readonly project?: ((leaf: string, columns: Readonly<ViewColumns>) => ViewColumns) | undefined;
}

/** What an arm adds beyond the leaf chain: a keyed table, trailing columns. */
interface ArmExtras {
  readonly keyed: Option.Option<PgTable>;
  readonly tail: RuntimeSelection;
}

/** A part of a view's selection, named by the source it comes from. */
interface SourcedSelection {
  readonly source: string;
  readonly selection: RuntimeSelection;
}

/** A selection under construction, with the source each of its keys came from. */
interface MergedSelection {
  readonly selection: RuntimeSelection;
  readonly sources: Readonly<Record<string, string>>;
}

/**
 * Merge a view's selection parts in order into one selection. Throws
 * `DerivationError` at module load when two sources share a key, naming the
 * key and both sources: a plain spread would keep the later column and
 * silently drop the earlier one.
 */
const mergeSelections = (
  view: string,
  parts: ReadonlyArray<SourcedSelection>,
): RuntimeSelection => {
  const empty: MergedSelection = { selection: noProjection(), sources: {} };
  return Arr.reduce(parts, empty, (merged, { source, selection }) => {
    Arr.forEach(R.keys(selection), (key) =>
      Option.map(R.get(merged.sources, key), (earlier) =>
        treeError(
          `${view} selects "${key}" from both ${earlier} and ${source}; rename one, or project it under another key`,
        ),
      ),
    );
    return {
      selection: { ...merged.selection, ...selection },
      sources: { ...merged.sources, ...R.map(selection, () => source) },
    };
  }).selection;
};

/** Views keyed by name, the key widened to `string` for the type-erasure seam. */
const byName = (
  entries: ReadonlyArray<readonly [string, PgView]>,
): Readonly<Record<string, PgView>> => R.fromEntries(entries);

/** An arm with nothing beyond the leaf chain. */
const noExtras: ArmExtras = { keyed: Option.none(), tail: {} };

/** The projection of a view with no per-leaf columns. */
const noProjection = (): RuntimeSelection => ({});

/**
 * Derive every read view of a tree from its {@link makeTreeTables} output: per
 * leaf a fail-closed current-version view (`${leaf}_view`), per opted-in
 * marker a branch view (`${level}_view`, a `UNION ALL` over its subtree's
 * leaves), and `asOf`, the leaf view at an older version or time.
 *
 * Every view drives from the leaf's own version table (each arm of a branch
 * view from its leaf's) and keeps only head rows with an anti-join on the
 * root version key: `NOT EXISTS` a root version of the same node newer than
 * the row (bounded the same way for `asOf`). That probes the primary key per
 * row, where a grouped `MAX(version)` head would aggregate the whole root
 * version table before a filter or `LIMIT` could apply
 * (effect-drizzle-ext#199). It then INNER JOINs the root version row, the
 * identity row and **every other level's version table** from the branch
 * root down to the leaf at that `(id, version)`, INNER JOINs on `id` the
 * stable table of every level
 * that has `stableColumns`, LEFT JOINs each fact table, and INNER JOINs the
 * version-0 root row for `createdAt`. A node whose head advanced past any
 * level yields **no row**, never a stale older one; a tombstone yields its row
 * with `action = 'delete'`. Columns follow declaration order: `id`,
 * `version`, `action` (and a branch view's `type`), the identity extras, each
 * level's columns root-most first (its `stableColumns`, then its version and
 * fact columns), `timestamp`, `createdAt`.
 *
 * A keyed leaf also gets `${leaf}_${keyed}_view`: the leaf view LEFT JOINed
 * to its keyed table at the head, one row per key, and one row with a `NULL`
 * key for a head that carries none. Each leaf `pointers[name]` lists gets
 * `${leaf}_${name}_view` (and `${leaf}_${keyed}_${name}_view` when keyed):
 * the leaf view resolved at the version the pointer's effective fact names
 * (the latest by `seq` whose `at` has arrived, which drives its FROM),
 * failing closed there, with `action` read off the head row (found by the
 * same anti-join, so a tombstone shows) and the fact's `at` as
 * `${name}At`. A node whose effective fact names no version, or that has
 * none, has no row.
 *
 * Every view reads base tables only, never another view, so drizzle-kit's
 * view-on-view DROP ordering can't bite (website #1228). Throws
 * `DerivationError` at module load for a `branches` entry naming a leaf or no
 * level, a `project` whose keys differ between leaves, or a column key two of
 * a view's sources share (a level or `stableColumns` column named like a
 * `root.identityColumns` extra, another level's column or `createdAt`, or a
 * `project` key the view already selects), naming
 * the key and both sources: rename one, or project it under another key.
 *
 * @example
 * ```ts
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables, makeTreeViews } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { getViewConfig, integer, pgSchema, text } from "drizzle-orm/pg-core";
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
 * const schema = pgSchema("catalogue");
 * const tables = makeTreeTables(tree, {
 *   schema,
 *   builders: { text: (c: string) => text(c), integer: (c: string) => integer(c) },
 * });
 * const views = makeTreeViews(tree, tables, { schema, branches: { work: true } });
 *
 * console.log(Object.keys(getViewConfig(views.leaves.book).selectedFields));
 * // ["id", "version", "action", "title", "pages", "timestamp", "createdAt"]
 * ```
 */
export const makeTreeViews = <
  S,
  M,
  T extends AnyTreeTables,
  const BR extends { readonly [K in keyof BR]: K extends MarkerName<S> ? unknown : never } = Record<
    never,
    never
  >,
  const PV extends {
    readonly [N in keyof PV]: N extends keyof T["pointers"] ? ReadonlyArray<LeafName<S>> : never;
  } = Record<never, never>,
>(
  tree: Tree<S, M>,
  tables: T,
  config: TreeViewsConfig<BR, PV>,
): TreeViews<S, T, BR, PV> => {
  const { schema } = config;
  const rootVersion = getTableColumns(tables.root.version);
  const identity = getTableColumns(tables.root.identity);
  const columnOf = rootColumnOf;
  const levelOf = (name: string) =>
    Option.getOrElse(
      Arr.findFirst(tree.levels, (level) => level.name === name),
      () => treeError(`"${name}" is not a level of this tree`),
    );
  const rootId = columnOf(rootVersion, "id");
  const rootVersionNumber = columnOf(rootVersion, "version");
  const identityExtras = R.filter(identity, (_, key) => key !== "id" && key !== "type");
  const tablesOf = (name: string) =>
    Option.getOrElse(R.get(tables.levels, name), () =>
      treeError(`level "${name}" has no tables; were they built from this tree?`),
    );
  const factsOf = (name: string) => Option.getOrElse(R.get(tables.facts, name), () => ({}));

  /** One level's stable-table extras (its `stableColumns` hook), past `id` and `type`. */
  const stableSelection = (name: string): RuntimeSelection =>
    R.filter(getTableColumns(tablesOf(name).stable), (_, key) => key !== "id" && key !== "type");

  /** One level's columns in a view: its version columns, then its facts (nullable). */
  const levelSelection = (name: string) => ({
    ...R.filter(
      getTableColumns(tablesOf(name).version),
      (_, key) => key !== "id" && key !== "version",
    ),
    ...R.map(factsOf(name), (fact, key) => {
      const column = columnOf(getTableColumns(fact), key);
      return sql`${column}`.mapWith(column).as(column.name);
    }),
  });

  /**
   * `NOT EXISTS` a root version newer than `version` for node `id` (within
   * `bound`, for `asOf`): the anti-join that keeps only head rows. It probes
   * the root version table's `(id, version)` primary key once per candidate
   * row, where a grouped `max(version)` would aggregate the whole table first
   * (effect-drizzle-ext#199).
   */
  const noNewerVersion = (
    qb: QueryBuilder,
    id: AnyPgColumn,
    version: AnyPgColumn,
    bound: Option.Option<(table: PgTable) => SQL>,
  ): SQL => {
    const newer = alias(tables.root.version, "newer");
    const columns = getTableColumns(newer);
    return notExists(
      qb
        .select({ one: sql`1` })
        .from(newer)
        .where(
          and(
            eq(columnOf(columns, "id"), id),
            gt(columnOf(columns, "version"), version),
            ...Arr.fromOption(Option.map(bound, (within) => within(newer))),
          ),
        ),
    );
  };

  /**
   * One arm. A head arm drives the FROM from the leaf's version table and
   * keeps only rows at the node's head (no newer root version, within the
   * as-of bound); a pointer arm drives it from the pointer's effective fact.
   * The root version row, the identity row and every other level on `leaf`'s
   * path join at the driver's `(id, version)`. `cut` is the deepest level
   * whose columns are projected (the leaf, or a branch's marker); the levels
   * below it still INNER JOIN, so the arm fails closed.
   */
  const armOf = (
    qb: QueryBuilder,
    view: string,
    driver: ArmDriver,
    leaf: string,
    cut: string,
    lead: RuntimeSelection,
    project: (columns: RuntimeSelection) => RuntimeSelection,
    extras: ArmExtras = noExtras,
  ) => {
    const path = [...levelOf(leaf).ancestors, leaf];
    const projected = Arr.take(
      path,
      Arr.findFirstIndex(path, (name) => name === cut).pipe(
        Option.map((i) => i + 1),
        Option.getOrElse(() => path.length),
      ),
    );
    const versionZero = alias(tables.root.version, "version_zero");
    const zeroTimestamp = columnOf(getTableColumns(versionZero), "timestamp");
    const projection = project(
      R.fromEntries(
        Arr.flatMap(path, (name) => [
          ...R.toEntries(stableSelection(name)),
          ...R.toEntries(levelSelection(name)),
        ]),
      ),
    );
    const plan = ArmDriver.$match(driver, {
      // A head arm drives from the leaf's own version table and keys every
      // join off its row; only the levels above the leaf join.
      Head: ({ bound }): ArmPlan => {
        const leafVersion = tablesOf(leaf).version;
        const columns = getTableColumns(leafVersion);
        const id = columnOf(columns, "id");
        const version = columnOf(columns, "version");
        return {
          from: leafVersion,
          id,
          on: (table) => {
            const target = getTableColumns(table);
            return and(eq(id, columnOf(target, "id")), eq(version, columnOf(target, "version")));
          },
          levels: Arr.filter(path, (name) => name !== leaf),
          headRow: Option.none(),
          head: { id, version },
          bound,
        };
      },
      // A pointer arm drives from the effective fact and keys every join off
      // the pointed version; it reads `action` off the real head row, so a
      // tombstone hides the node at every pointed version.
      Pointer: ({ fact }): ArmPlan => {
        const row = alias(tables.root.version, "head_row");
        const columns = getTableColumns(row);
        return {
          from: fact,
          id: fact.id,
          on: (table) => {
            const target = getTableColumns(table);
            return and(
              eq(fact.id, columnOf(target, "id")),
              eq(fact.version, columnOf(target, "version")),
            );
          },
          levels: path,
          headRow: Option.some(row),
          head: { id: columnOf(columns, "id"), version: columnOf(columns, "version") },
          bound: Option.none(),
        };
      },
    });
    const { headRow } = plan;
    const keyedColumns = Option.match(extras.keyed, {
      onNone: () => ({}),
      onSome: (table) =>
        R.map(
          R.filter(getTableColumns(table), (_, key) => key !== "id" && key !== "version"),
          (column) => sql`${column}`.mapWith(column).as(column.name),
        ),
    });
    const selection = mergeSelections(view, [
      // A pointer arm's `action` is the head row's, not the pointed version's;
      // `action` stays third either way.
      {
        source: "the chain's head",
        selection: Option.isSome(headRow) ? R.remove(lead, "action") : lead,
      },
      {
        source: "the head row",
        selection: Option.match(headRow, {
          onNone: noProjection,
          onSome: (row) => ({ action: columnOf(getTableColumns(row), "action") }),
        }),
      },
      { source: "root.identityColumns", selection: identityExtras },
      ...Arr.flatMap(projected, (name) => [
        { source: `levels.${name}.stableColumns`, selection: stableSelection(name) },
        { source: `level "${name}"`, selection: levelSelection(name) },
      ]),
      { source: "the keyed table", selection: keyedColumns },
      {
        source: "the chain's timestamps",
        selection: {
          timestamp: columnOf(rootVersion, "timestamp"),
          createdAt: sql<Date>`${zeroTimestamp}`.mapWith(zeroTimestamp).as("created_at"),
        },
      },
      { source: "the pointer", selection: extras.tail },
      { source: "project", selection: projection },
    ]);
    const atKey = plan.on;
    const joined = Arr.reduce(
      plan.levels,
      qb
        .select(selection)
        .from(plan.from)
        .$dynamic()
        .innerJoin(tables.root.version, atKey(tables.root.version))
        .innerJoin(tables.root.identity, eq(plan.id, columnOf(identity, "id"))),
      (q, name) => q.innerJoin(tablesOf(name).version, atKey(tablesOf(name).version)),
    );
    // A level with stable columns joins its stable row on `id` (one per node,
    // written at create). A level without any joins nothing here, so a tree
    // with no `stableColumns` emits exactly the SQL it did before them.
    const withStable = Arr.reduce(
      Arr.filter(path, (name) => !R.isEmptyRecord(stableSelection(name))),
      joined,
      (q, name) => {
        const stable = tablesOf(name).stable;
        return q.innerJoin(stable, eq(plan.id, columnOf(getTableColumns(stable), "id")));
      },
    );
    const withFacts = Arr.reduce(
      Arr.flatMap(path, (name) => R.values(factsOf(name))),
      withStable,
      (q, fact) => q.leftJoin(fact, atKey(fact)),
    );
    const withKeyed = Option.match(extras.keyed, {
      onNone: () => withFacts,
      onSome: (table) => withFacts.leftJoin(table, atKey(table)),
    });
    const withHead = Option.match(headRow, {
      onNone: () => withKeyed,
      onSome: (row) => withKeyed.innerJoin(row, eq(plan.id, columnOf(getTableColumns(row), "id"))),
    });
    const query = withHead.innerJoin(
      versionZero,
      and(
        eq(plan.id, columnOf(getTableColumns(versionZero), "id")),
        eq(columnOf(getTableColumns(versionZero), "version"), 0n),
      ),
    );
    // The head filter. A head arm keeps the leaf row no newer root version
    // supersedes; an as-of arm bounds both the row and the newer one, so it
    // keeps the latest within the bound. A pointer arm keeps the head row its
    // `action` is read from.
    const { bound, head } = plan;
    const where = and(
      ...Arr.fromOption(Option.map(bound, (within) => within(tables.root.version))),
      noNewerVersion(qb, head.id, head.version, bound),
    );
    return { keys: R.keys(projection), query: query.where(where) };
  };

  const leafLead = {
    id: rootId,
    version: rootVersionNumber,
    action: columnOf(rootVersion, "action"),
  };

  const leafView = (leaf: string): PgView =>
    schema.view(`${leaf}_view`).as((qb) => {
      return armOf(qb, `view "${leaf}_view"`, atHead, leaf, leaf, leafLead, noProjection).query;
    });

  const branchEntries: Readonly<Record<string, RuntimeBranchConfig | true>> = config.branches ?? {};
  const branchConfigs: ReadonlyArray<readonly [string, RuntimeBranchConfig]> = Arr.map(
    R.toEntries(branchEntries),
    ([name, entry]): readonly [string, RuntimeBranchConfig] => {
      if (
        !Option.exists(
          Arr.findFirst(tree.levels, (level) => level.name === name),
          (level) => !level.isLeaf,
        )
      ) {
        treeError(`branches names "${name}", which is not a marker level of this tree`);
      }
      return [name, entry === true || entry === undefined ? {} : entry];
    },
  );

  const branchView = (name: string, entry: RuntimeBranchConfig): PgView => {
    const leaves = levelOf(name).subtreeLeaves;
    const projectFor =
      (leaf: string) =>
      (columns: RuntimeSelection): RuntimeSelection =>
        entry.project === undefined ? {} : entry.project(leaf, columns);
    return schema.view(`${name}_view`).as((qb) => {
      const arms = Arr.map(leaves, (leaf) =>
        armOf(
          qb,
          `view "${name}_view" (arm "${leaf}")`,
          atHead,
          leaf,
          name,
          { ...leafLead, type: columnOf(identity, "type") },
          projectFor(leaf),
        ),
      );
      const [first, ...rest] = arms;
      Arr.forEach(rest, (arm, i) => {
        if (arm.keys.join(",") !== first.keys.join(",")) {
          treeError(
            `branch "${name}"'s project returns columns (${arm.keys.join(", ")}) for "${leaves[i + 1]}" but (${first.keys.join(", ")}) for "${leaves[0]}"`,
          );
        }
      });
      return Arr.reduce(rest, first.query, (union, arm) => union.unionAll(arm.query));
    });
  };

  const asOf = (leaf: string, point: AsOfPoint) => {
    const qb = new QueryBuilder();
    // The bound applies to a root version table or its `newer` alias alike.
    const within = (table: PgTable): SQL => {
      const columns = getTableColumns(table);
      return "version" in point
        ? lte(columnOf(columns, "version"), point.version)
        : lte(columnOf(columns, "timestamp"), point.at);
    };
    const driver = ArmDriver.Head({ bound: Option.some(within) });
    return armOf(qb, `asOf("${leaf}")`, driver, leaf, leaf, leafLead, noProjection).query.as(
      `${leaf}_as_of`,
    );
  };

  /** A keyed leaf's key name and table; none for a leaf with no keyed level. */
  const keyedOf = (leaf: string) =>
    Option.map(levelOf(leaf).keyed, (keyed) => ({
      name: keyed.name,
      table: Option.getOrElse(R.get(tables.keyed, leaf), () =>
        treeError(`leaf "${leaf}" has no keyed table; were the tables built from this tree?`),
      ),
    }));
  const keyedLeaves = Arr.filter(tree.leaves, (leaf) => Option.isSome(levelOf(leaf).keyed));

  const keyedView = (
    leaf: string,
    keyed: { readonly name: string; readonly table: PgTable },
  ): PgView =>
    schema.view(`${leaf}_${keyed.name}_view`).as((qb) => {
      return armOf(
        qb,
        `view "${leaf}_${keyed.name}_view"`,
        atHead,
        leaf,
        leaf,
        leafLead,
        noProjection,
        {
          ...noExtras,
          keyed: Option.some(keyed.table),
        },
      ).query;
    });

  /**
   * The effective fact per node: the latest recorded (`seq`) whose `at` has
   * arrived. A fact naming no version joins no root row, so it hides the node.
   */
  const pointerOf = (qb: QueryBuilder, pointer: string) => {
    const log = Option.getOrElse(R.get(tables.pointers, pointer), () =>
      treeError(`pointer "${pointer}" has no log; name it in makeTreeTables' root.pointers`),
    );
    const columns = getTableColumns(log);
    const id = columnOf(columns, "id");
    return qb
      .selectDistinctOn([id], {
        id,
        version: sql`${columnOf(columns, "version")}`.as("pointer_version"),
        at: columnOf(columns, "at"),
      })
      .from(log)
      .where(lte(columnOf(columns, "at"), sql`now()`))
      .orderBy(id, desc(columnOf(columns, "seq")))
      .as("pointer");
  };

  const pointerView = (
    pointer: string,
    leaf: string,
    keyed: Option.Option<{ readonly name: string; readonly table: PgTable }>,
  ): PgView => {
    const view = Option.match(keyed, {
      onNone: () => `${leaf}_${pointer}_view`,
      onSome: ({ name }) => `${leaf}_${name}_${pointer}_view`,
    });
    return schema.view(view).as((qb) => {
      const point = pointerOf(qb, pointer);
      const driver = ArmDriver.Pointer({ fact: point });
      return armOf(qb, `view "${view}"`, driver, leaf, leaf, leafLead, noProjection, {
        keyed: Option.map(keyed, ({ table }) => table),
        tail: {
          [`${pointer}At`]: sql<Date>`${point.at}`
            .mapWith(columnOf(getTableColumns(tables.root.version), "timestamp"))
            .as(`${pointer}_at`),
        },
      }).query;
    });
  };

  const pointerEntries: Readonly<Record<string, ReadonlyArray<string>>> = config.pointers ?? {};
  const pointerViews = R.map(pointerEntries, (leaves, pointer) => {
    Arr.forEach(leaves, (leaf) => {
      if (!Arr.contains(tree.leaves, leaf)) {
        treeError(`pointers.${pointer} names "${leaf}", which is not a leaf of this tree`);
      }
    });
    return {
      leaves: R.fromEntries(
        Arr.map(leaves, (leaf) => [leaf, pointerView(pointer, leaf, Option.none())]),
      ),
      keyed: R.fromEntries(
        Arr.flatMap(leaves, (leaf) =>
          Arr.fromOption(
            Option.map(
              keyedOf(leaf),
              (keyed) => [leaf, pointerView(pointer, leaf, Option.some(keyed))] as const,
            ),
          ),
        ),
      ),
    };
  });

  const derived = {
    leaves: byName(Arr.map(tree.leaves, (leaf) => [leaf, leafView(leaf)])),
    keyed: byName(
      Arr.flatMap(keyedLeaves, (leaf) =>
        Arr.fromOption(
          Option.map(keyedOf(leaf), (keyed) => [leaf, keyedView(leaf, keyed)] as const),
        ),
      ),
    ),
    branches: byName(Arr.map(branchConfigs, ([name, entry]) => [name, branchView(name, entry)])),
    pointers: pointerViews,
    asOf,
  };
  // SAFETY: the type-erasure seam, as in makeTreeTables. Every view was built
  // above from the same tables `T` types, selecting exactly the columns
  // `TreeLeafSelection` / `TreeBranchSelection` name, in that order; only the
  // per-level precision was erased by assembling them from the runtime tree.
  return derived as TreeViews<S, T, BR, PV>;
};
