/**
 * FK-reference resolution for annotation-driven columns: a `resolveReference`
 * hook that maps a `{ table, column }` name pair to the Drizzle column thunk.
 * See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/references.md).
 *
 * @module References
 */

import { getColumns, getTableName, is } from "drizzle-orm";
import { PgColumn, type AnyPgColumn, type PgTable } from "drizzle-orm/pg-core";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import { DerivationError } from "./Derive.ts";
import type { DbColumnReference } from "./Annotation.ts";

/**
 * A name-keyed registry of FK-reference targets, plus the lazy resolver the
 * derivation's `resolveReference` hook expects.
 *
 * The invariant is the laziness: `resolve` never touches the registry, so a
 * reference may be resolved before its target table module has loaded;
 * **forcing** the returned thunk is what reads the registry, and that happens
 * only when Drizzle materialises the foreign key.
 */
export interface ReferenceRegistry {
  /**
   * Register a table as a possible FK-reference target, keyed by its SQL table
   * name (matching a `references.table` annotation). Idempotent; call it once,
   * right after the target table is defined, in the table module that owns it.
   */
  readonly register: (table: PgTable) => void;
  /**
   * Resolve a `dbColumn` `references` annotation to the target Drizzle column,
   * as the lazy thunk `.references()` consumes. Wire it into the derivation's
   * {@link DeriveOptions.resolveReference}; it is invoked only when a derived
   * column declares a reference, so leaves with no FK annotations never touch
   * the registry.
   *
   * Forcing the thunk against an unregistered table, or against a table with
   * no such column, throws {@link DerivationError} — a schema-definition
   * programmer error surfaced the first time Drizzle forces the thunk, not a
   * runtime condition.
   */
  readonly resolve: (reference: DbColumnReference) => () => AnyPgColumn;
}

/** Whether a column-map entry is a Drizzle PostgreSQL column. */
const isPgColumn = (value: unknown): value is AnyPgColumn => is(value, PgColumn);

/**
 * Build a fresh {@link ReferenceRegistry}. Each call owns its own name → table
 * map, so independent schemas never resolve into each other.
 */
export const makeReferenceRegistry = (): ReferenceRegistry => {
  /** Name → table registry of FK-reference targets, populated at module load. */
  const targets = MutableHashMap.empty<string, PgTable>();

  return {
    register: (table: PgTable): void => {
      MutableHashMap.set(targets, getTableName(table), table);
    },
    resolve: (reference: DbColumnReference) => (): AnyPgColumn => {
      const table = MutableHashMap.get(targets, reference.table);
      if (Option.isNone(table)) {
        throw new DerivationError({
          message:
            `no FK-reference target registered for table '${reference.table}' ` +
            `— call register(${reference.table}) in its table module`,
        });
      }
      return Option.getOrElse(
        Option.filter(R.get(getColumns(table.value), reference.column), isPgColumn),
        () => {
          throw new DerivationError({
            message: `table '${reference.table}' has no column '${reference.column}'`,
          });
        },
      );
    },
  };
};
