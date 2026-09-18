/**
 * @copyright Thomas Foster
 *
 * **Table-level CHECK / UNIQUE / composite-FK helpers.**
 *
 * Two independent families, both emitting values for a table factory's
 * `extraConstraints` seam:
 *
 * - {@link enumCheck} — the `CHECK (col IN (…))` behind an enum-valued `text`
 *   column, so a vocabulary declared once in a model constrains the database
 *   too.
 * - {@link makeDiscriminatorConstraints} — the three constraints that thread a
 *   `type` discriminator up a hierarchy of stable tables, parameterised over
 *   the hierarchy (the library knows no level ontology; the consumer supplies
 *   the leaf set per level).
 *
 * @module constraints
 */

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  unique,
  type AnyPgColumn,
  type ExtraConfigColumn,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import * as Array from "effect/Array";

// ── Enum-valued text columns ──────────────────────────────────────────

/**
 * `CHECK (column IN ('a', 'b', …))`, named `name`.
 *
 * The models declare each vocabulary once as an exported `as const` array and
 * validate the wire against `Schema.Literals` over it; the database restates
 * the same array as an `IN (...)` CHECK so a row written by any path — a
 * batched ingestion upsert included — cannot carry a value the API would refuse
 * to serve. There is no Postgres enum type: a `text` column plus a CHECK is
 * what lets a vocabulary grow with one migration (`ALTER … DROP/ADD
 * CONSTRAINT`) instead of an `ALTER TYPE … ADD VALUE` that cannot run inside a
 * transaction.
 *
 * A `NULL` in the column **passes** — `NULL IN (...)` is unknown, which CHECK
 * accepts — so the same constraint serves nullable vocabularies without an
 * `IS NULL OR` guard. Nullability is the column's own `NOT NULL` to declare.
 *
 * The values are rendered as literal SQL text, not bind parameters: a CHECK
 * expression lives in the migration file, where a `$1` placeholder has nothing
 * to bind to. They come straight from the models' `as const` arrays, so the two
 * vocabularies cannot drift — a model change shows up as schema drift in the
 * consumer's migration-drift check until the migration is regenerated.
 */
export const enumCheck = (
  name: string,
  column: ExtraConfigColumn,
  values: readonly string[],
): PgTableExtraConfigValue =>
  check(name, sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`);

// ── Threaded `type` discriminator ─────────────────────────────────────

/** A stable table contributes its `id` + `type` columns to the discriminator. */
export interface TypedStable {
  readonly id: AnyPgColumn;
  readonly type: AnyPgColumn;
}

/*
 * Every optional member from here to the end of the file — the name templates,
 * `onUpdate`, the `refinable` option — is `?: T | undefined`, never `Option`,
 * for the reason stated once in ./derive.ts: they are config a consumer hands
 * to a Drizzle-emitting factory, and `undefined` is what "not supplied" means
 * there. `foreignKey(...).onUpdate(Option.none())` would emit `ON UPDATE
 * [object Object]`.
 */
/* oxlint-disable effect/prefer-option-over-null -- config type: `undefined` means "not supplied" (see ./derive.ts) */

/**
 * Constraint-name templates, overriding the defaults
 * `${level}_id_type_unique`, `${level}_id_type_fk` and `${level}_type_valid`.
 * A consumer adopting this helper over hand-written constraints pins whatever
 * names its existing migrations already carry, so the switch renames nothing.
 */
export interface DiscriminatorNames {
  /** Name of the `UNIQUE(id, type)` constraint. */
  readonly unique?: ((level: string) => string) | undefined;
  /** Name of the composite `(id, type)` → parent `(id, type)` foreign key. */
  readonly parentFk?: ((level: string) => string) | undefined;
  /** Name of the per-level `type` CHECK. */
  readonly check?: ((level: string) => string) | undefined;
}

/**
 * The three constraints that enforce a threaded `type` discriminator, bound to
 * one hierarchy. Generic over the hierarchy's level union `Level`, so a level
 * the consumer has no leaf set for is a type error at the call site.
 */
export interface DiscriminatorToolkit<Level extends string> {
  /**
   * `UNIQUE(id, type)` — the target every child's composite `(id, type)` FK
   * needs. `level` is a plain `string`, not `Level`: a root table sitting
   * *above* the ontology's levels (and so not itself a level) can carry it too.
   */
  readonly typeUnique: (level: string, stable: TypedStable) => PgTableExtraConfigValue;
  /**
   * The composite `(id, type)` → parent `(id, type)` foreign key. `onDelete` is
   * left to the plain single-column `id` FK the table already carries
   * (cascade); this arc only enforces the discriminator match.
   *
   * `onUpdate: "cascade"` (via {@link DiscriminatorToolkit.typeConstraints}'
   * `refinable` option) makes a bare parent row **refinable**: an operation
   * that flips the root's `type` from a generic value to a concrete leaf
   * cascades the new `type` down the pre-existing `(id, type)` chain before the
   * concrete rows are inserted — so the flip is a plain ordered transaction, no
   * `DEFERRABLE` constraint needed. Branches that don't refine keep the default
   * (no referential action on this arc).
   */
  readonly typeParentFk: (
    level: Level,
    stable: TypedStable,
    parent: TypedStable,
    onUpdate?: "cascade" | undefined,
  ) => PgTableExtraConfigValue;
  /**
   * The per-level `type` CHECK. A leaf admits only its own type; an
   * intermediate or branch root admits every concrete leaf in its subtree (the
   * `leaves` callback the toolkit was built with). The value list is
   * parameterised, not interpolated.
   *
   * A childless marker — an ontology level with no concrete leaf beneath it yet
   * — has an empty leaf set, so it admits no `type` at all: no leaf names it as
   * an ancestor, so nothing ever materialises a row there and the table stays
   * empty until the ontology grows a leaf under it. Emits `CHECK (false)` for
   * that case — `type IN ()` is a syntax error, and `false` correctly marks the
   * level uninstantiable rather than admitting an arbitrary value.
   */
  readonly typeCheck: (level: Level, stable: TypedStable) => PgTableExtraConfigValue;
  /**
   * All three discriminator constraints for a non-root level:
   * `UNIQUE(id, type)`, the composite `(id, type)` → parent FK, and the
   * per-level CHECK. A branch root passes the table above it as `parent`; the
   * root table itself gets only {@link DiscriminatorToolkit.typeUnique} (no
   * parent, no CHECK — it admits any leaf).
   *
   * `refinable: true` gives the composite FK `ON UPDATE CASCADE` — see
   * {@link DiscriminatorToolkit.typeParentFk}.
   */
  readonly typeConstraints: (
    level: Level,
    stable: TypedStable,
    parent: TypedStable,
    options?: { readonly refinable?: boolean | undefined } | undefined,
  ) => PgTableExtraConfigValue[];
}

/**
 * Build a {@link DiscriminatorToolkit} for one hierarchy.
 *
 * `leaves(level)` is the seam the ontology plugs into: it answers the concrete
 * leaf `type` values admissible at `level` (its subtree's leaves — for a leaf
 * level, itself). The library carries no level ontology of its own, so this
 * callback, and the optional {@link DiscriminatorNames} templates, are the
 * whole configuration.
 *
 * The constraints it emits are what make a sibling-subtype chimera
 * unrepresentable: `UNIQUE(id, type)` gives children a composite key to point
 * at, the composite FK arcs the discriminator up one level (a child can only
 * exist under a parent carrying the SAME `type`), and the CHECK narrows `type`
 * to the level's own subtree.
 */
export const makeDiscriminatorConstraints = <Level extends string>(options: {
  readonly leaves: (level: Level) => ReadonlyArray<string>;
  readonly names?: DiscriminatorNames | undefined;
}): DiscriminatorToolkit<Level> => {
  const uniqueName = options.names?.unique ?? ((level: string) => `${level}_id_type_unique`);
  const parentFkName = options.names?.parentFk ?? ((level: string) => `${level}_id_type_fk`);
  const checkName = options.names?.check ?? ((level: string) => `${level}_type_valid`);

  const typeUnique = (level: string, stable: TypedStable): PgTableExtraConfigValue =>
    unique(uniqueName(level)).on(stable.id, stable.type);

  const typeParentFk = (
    level: Level,
    stable: TypedStable,
    parent: TypedStable,
    onUpdate?: "cascade" | undefined,
  ): PgTableExtraConfigValue => {
    const fk = foreignKey({
      name: parentFkName(level),
      columns: [stable.id, stable.type],
      foreignColumns: [parent.id, parent.type],
    });
    return onUpdate === "cascade" ? fk.onUpdate("cascade") : fk;
  };

  const typeCheck = (level: Level, stable: TypedStable): PgTableExtraConfigValue => {
    const leaves = options.leaves(level);
    if (Array.isReadonlyArrayEmpty(leaves)) return check(checkName(level), sql`false`);
    const list = sql.join(
      leaves.map((leaf) => sql`${leaf}`),
      sql`, `,
    );
    return check(checkName(level), sql`${stable.type} IN (${list})`);
  };

  return {
    typeUnique,
    typeParentFk,
    typeCheck,
    typeConstraints: (
      level: Level,
      stable: TypedStable,
      parent: TypedStable,
      { refinable = false }: { readonly refinable?: boolean | undefined } = {},
    ): PgTableExtraConfigValue[] => [
      typeUnique(level, stable),
      typeParentFk(level, stable, parent, refinable ? "cascade" : undefined),
      typeCheck(level, stable),
    ],
  };
};

/* oxlint-enable effect/prefer-option-over-null */
