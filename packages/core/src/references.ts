/**
 * @copyright Thomas Foster
 *
 * **FK-reference resolution for annotation-driven columns.**
 *
 * The derivation ({@link ./derive.ts}) reads a column's `references`
 * annotation ({@link DbColumnReference}) as a Drizzle-free **name** pair
 * (`{ table, column }`) and hands it to a `resolveReference` hook that returns
 * the Drizzle column thunk `.references()` needs. This module is one
 * implementation of that hook.
 *
 * Resolution is by **table name**, against a small registry FK-target tables
 * opt into via {@link ReferenceRegistry.register}. Only a table that is
 * actually pointed at by a derived FK column need register. The registry
 * sidesteps the import cycle a static `import { targetTable }` would create
 * (the deriver is imported *by* the table modules): {@link
 * ReferenceRegistry.resolve} returns a **lazy** thunk, and `.references()`
 * invokes it only when the FK is materialised (migration generation / query
 * build) — long after every table module, and its `register` call, has loaded.
 * A reference to an unregistered table fails loudly at that point rather than
 * silently emitting no constraint.
 *
 * **A factory, not a singleton.** The consuming applications each carried one
 * module-scope registry. A library cannot: two independent schemas in one
 * process (an app and its test fixtures, two tenants' table sets) would share
 * one name space and resolve each other's tables. {@link makeReferenceRegistry}
 * hands each derivation its own; a consumer that wants exactly one exports the
 * instance it made.
 *
 * @module references
 */

import { getColumns, getTableName } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import { DerivationError } from "./derive.ts";
import type { DbColumnReference } from "./index.ts";

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
      const column = (getColumns(table.value) as Record<string, AnyPgColumn>)[reference.column];
      if (column === undefined) {
        throw new DerivationError({
          message: `table '${reference.table}' has no column '${reference.column}'`,
        });
      }
      return column;
    },
  };
};
