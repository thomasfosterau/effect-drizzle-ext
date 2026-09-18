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
 * @module effect-drizzle-ext/versioned-chain
 */

import { and, eq, getTableName, max } from "drizzle-orm";
import type { ColumnBuilderBase, GetColumnData, SQL } from "drizzle-orm";
import {
  alias,
  bigint,
  foreignKey,
  primaryKey,
  text,
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
  type PgUUIDBuilder,
  type PgViewWithSelection,
  type SetIsPrimaryKey,
  type SetNotNull,
} from "drizzle-orm/pg-core";

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
 *    (`bigint().default(versionDefault)`, `primaryKey({ name: constraintNames.pk })`,
 *    `uuid(versionIdColumn)`, …). Drizzle reads plain `undefined` as "not
 *    supplied"; an `Option` would be an object it would try to emit as a value,
 *    producing wrong DDL that no type error and no unit test would catch.
 *
 * The explicit `| undefined` on each is likewise deliberate — see the note on
 * `parentUpdateCascade` about `exactOptionalPropertyTypes`.
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
   * Cascade updates of the parent stable id into the leaf's stable row (the
   * stable → parent FK gains `onUpdate: "cascade"` alongside the cascade
   * delete). Defaults to delete-only.
   *
   * The optional members here and below admit explicit `undefined` so a
   * configuring layer can thread its own optional overrides through without
   * per-property conditional spreads (`exactOptionalPropertyTypes`).
   */
  parentUpdateCascade?: boolean | undefined;
  /**
   * Default for the `version` column — e.g. `0n` for branch-extending leaves
   * whose first version row is written with an explicit `0`. Omitted leaves get
   * a plain `NOT NULL` version.
   */
  versionDefault?: bigint | undefined;
  /**
   * Constraint-name overrides for the version table's primary key and its
   * `(id, version)` → parent-version foreign key. Each defaults to the canonical
   * `${name}_version_pkey` / `${name}_version_${parentVersion}_fk`.
   */
  constraintNames?: { pk?: string; parentFk?: string } | undefined;
  /**
   * Physical name for the version table's id column, when a historical table
   * diverges from the canonical `id` (e.g. `organisation_version.organisation_id`).
   * The TypeScript key stays `id`; only the emitted column name changes.
   */
  versionIdColumn?: string | undefined;
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
  }>;
  version: PgTableWithColumns<{
    name: `${string}_version`;
    schema: string;
    columns: PgBuildColumns<`${string}_version`, SubtypeVersionColumnBuilders<TColumns>>;
    dialect: "pg";
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
      parentUpdateCascade,
      versionDefault,
      constraintNames,
      versionIdColumn,
      extraConstraints,
      discriminator,
    }: SubtypeTablesConfig<TColumns, TDiscriminator>,
  ): SubtypeTables<TColumns> => {
    const stableColumns = {
      id: uuid("id")
        .primaryKey()
        .references(
          (): AnyPgColumn => parentId,
          parentUpdateCascade
            ? { onUpdate: "cascade", onDelete: "cascade" }
            : { onDelete: "cascade" },
        ),
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
        id: uuid(versionIdColumn ?? "id")
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
            name: constraintNames?.pk ?? `${name}_version_pkey`,
            columns: [table.id, table.version],
          }),
          foreignKey({
            name: constraintNames?.parentFk ?? `${name}_version_${getTableName(parentVersion)}_fk`,
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
  PgViewWithSelection<string, false, TColumns & TMerge>,
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
    const view = schema.view(name).as((qb) => {
      // Current version per node, resolved from the root version table — the
      // single home of currency. This sub-select drives the FROM so the leaf
      // join below fails closed on a partial chain.
      const current = qb
        .select({ id: rootVersion.id, version: max(rootVersion.version).as("current_version") })
        .from(rootVersion as unknown as PgTable)
        .groupBy(rootVersion.id)
        .as("current_version");
      // A function `merge` additionally resolves the node's birth row (`version
      // = 0`) via an aliased join, so it can merge in a true `createdAt`. A
      // plain-object `merge` skips this entirely — no extra join, no change to
      // the emitted SQL beyond what `columns` already determines (see the
      // `CurrentVersionViewDeps.merge` doc for why that matters).
      const versionZero =
        typeof merge === "function" ? alias(rootVersion, "version_zero") : undefined;
      const mergeColumns =
        typeof merge === "function" ? merge(versionZero as unknown as TRoot) : merge;
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
      for (const t of through) {
        q = q.innerJoin(t, and(eq(current.id, t.id), eq(current.version, t.version)));
      }
      for (const t of optional) {
        q = q.leftJoin(t, and(eq(current.id, t.id), eq(current.version, t.version)));
      }
      for (const t of on) {
        q = q.innerJoin(t, eq(current.id, t.id));
      }
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
      return q as typeof select;
    });
    return view as unknown as CurrentVersionViewResult<TColumns, TMerge>;
  };
