/**
 * What the table-bound modules (`./Outbox`, `./Documents`, `./ExternalIds`)
 * share: the driver's query failure, and a column looked up by key at
 * module load.
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/Derive";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";

/** The query failure a Drizzle `CurrentTransaction` reports. */
export type QueryError<Tx> = Tx extends {
  readonly select: () => { readonly from: (table: never) => infer Q };
}
  ? Q extends Effect.Effect<unknown, infer E, unknown>
    ? E
    : never
  : never;

/**
 * Column `key` of `table`, or a thrown `DerivationError` naming the
 * constructor and the column builder the table should have come from.
 */
export const columnOf =
  (constructor: string, builder: string) =>
  (table: PgTable, key: string): AnyPgColumn =>
    Option.getOrElse(R.get(getTableColumns(table), key), () => {
      throw new DerivationError({
        message: `${constructor}: table "${getTableName(table)}" has no "${key}" column; was it built from ${builder}()?`,
      });
    });
