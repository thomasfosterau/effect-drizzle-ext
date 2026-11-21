/**
 * Optimistic concurrency over a flat table: one mutable row per id and a
 * `version` column the writes bump, for an aggregate that needs no history.
 * See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/versioned-row.md).
 *
 * @module VersionedRow
 */

import {
  and,
  eq,
  getTableName,
  sql,
  type AnyRelations,
  type InferInsertModel,
  type InferSelectModel,
} from "drizzle-orm";
import { bigint, type PgTable } from "drizzle-orm/pg-core";
import {
  catchUniqueViolation,
  type UniqueViolation,
} from "@thomasfosterau/effect-drizzle-ext/errors";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { NodeAlreadyExists, NodeNotFound, StaleVersion } from "./chain.ts";
import type { PgTransaction } from "./index.ts";
import { columnOf as tableColumnOf, type QueryError } from "./internal/table.ts";

/**
 * The `version` column: `0` on insert, bumped by every write through
 * {@link makeVersionedRow}. Spread it beside the table's own columns.
 *
 * @example
 * ```ts
 * import { versionColumn } from "@thomasfosterau/effect-drizzle-ext-pg/VersionedRow";
 * import { pgTable, text, uuid } from "drizzle-orm/pg-core";
 *
 * export const account = pgTable("account", {
 *   id: uuid("id").primaryKey(),
 *   name: text("name").notNull(),
 *   ...versionColumn(),
 * });
 * console.log(Object.keys(account)); // includes "version"
 * ```
 */
export const versionColumn = () => ({
  version: bigint("version", { mode: "bigint" }).notNull().default(0n),
});

/** The writable columns of `T`, past `id` and `version`. */
export type VersionedRowValues<T extends PgTable> = Omit<InferInsertModel<T>, "id" | "version">;

/** A row of `T` as {@link VersionedRows.load} reads it. */
export type VersionedRowOf<T extends PgTable> = InferSelectModel<T>;

/** The operations over one versioned table. `E` is the driver's query failure; `I` the `CurrentTransaction` key. */
export interface VersionedRows<T extends PgTable, E, I> {
  /** The row and its version, read together. `Option.none()` for an unknown id. */
  readonly load: (id: string) => Effect.Effect<Option.Option<VersionedRowOf<T>>, E, I>;
  /**
   * Insert the row at version `0`. Fails {@link NodeAlreadyExists} on a taken
   * id (never an upsert), and `UniqueViolation` on any other unique key.
   */
  readonly insert: (
    id: string,
    values: VersionedRowValues<T>,
  ) => Effect.Effect<
    { readonly id: string; readonly version: bigint },
    E | NodeAlreadyExists | UniqueViolation,
    I
  >;
  /**
   * Set `patch` and bump the version in one `UPDATE`. With `expectedVersion`,
   * the row must still be at it: otherwise nothing is written and the write
   * fails {@link StaleVersion}. Fails {@link NodeNotFound} for an unknown id.
   */
  readonly update: (input: {
    readonly id: string;
    readonly patch: Partial<VersionedRowValues<T>>;
    readonly expectedVersion?: bigint;
  }) => Effect.Effect<
    { readonly id: string; readonly version: bigint },
    E | NodeNotFound | StaleVersion,
    I
  >;
  /** Delete the row, under the same precondition as {@link update}. Returns the version it had. */
  readonly delete: (
    id: string,
    options?: { readonly expectedVersion?: bigint },
  ) => Effect.Effect<
    { readonly id: string; readonly version: bigint },
    E | NodeNotFound | StaleVersion,
    I
  >;
}

const Written = Schema.Array(Schema.Struct({ version: Schema.BigInt }));
const decodeWritten = Schema.decodeUnknownEffect(Written);

const columnOf = tableColumnOf("makeVersionedRow", "versionColumn");

/**
 * The {@link VersionedRows} over `table`, which needs an `id` key and a
 * {@link versionColumn}. `type` names the table in `NodeNotFound`,
 * `NodeAlreadyExists` and `StaleVersion` (default: the table name). Throws
 * `DerivationError` at module load when a column is missing. A concurrent
 * write waits on the row lock and then finds the version moved, so it fails
 * `StaleVersion` rather than overwriting.
 */
export const makeVersionedRow = <T extends PgTable, I, Relations extends AnyRelations>(config: {
  readonly table: T;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
  readonly type?: string;
}): VersionedRows<T, QueryError<PgTransaction<Relations>>, I> => {
  const { CurrentTransaction } = config;
  // The writes run over the erased table: Drizzle's builders can't resolve
  // `T`'s columns generically. `load` restores `T`'s row type.
  const table: PgTable = config.table;
  const type = config.type ?? getTableName(table);
  const id = columnOf(table, "id");
  const version = columnOf(table, "version");
  const primaryKey = `${getTableName(table)}_pkey`;

  const load = Effect.fn(`${type}.load`)(function* (key: string) {
    const tx = yield* CurrentTransaction;
    const rows: ReadonlyArray<VersionedRowOf<T>> = yield* tx
      .select()
      .from(config.table)
      .where(eq(id, key))
      .limit(1);
    return Arr.head(rows);
  });

  /** Why a guarded write matched no row: an unknown id, or a moved version. */
  const missed = Effect.fn(`${type}.missed`)(function* (key: string, expected: bigint) {
    const tx = yield* CurrentTransaction;
    const rows = yield* tx.select({ version }).from(table).where(eq(id, key)).limit(1);
    const found = yield* Effect.orDie(decodeWritten(rows));
    return yield* Option.match(Arr.head(found), {
      onNone: () => Effect.fail(new NodeNotFound({ type, id: key })),
      onSome: (row) =>
        Effect.fail(new StaleVersion({ type, id: key, expected, current: row.version })),
    });
  });

  const guard = (key: string, expected: Option.Option<bigint>) =>
    Option.match(expected, {
      onNone: () => eq(id, key),
      onSome: (at) => and(eq(id, key), eq(version, at)),
    });

  /** The one row a guarded write returned, or why there was none. */
  const written = (
    key: string,
    expected: Option.Option<bigint>,
    found: ReadonlyArray<{ readonly version: bigint }>,
  ) =>
    Option.match(Arr.head(found), {
      onNone: () =>
        Option.match(expected, {
          onNone: () => Effect.fail(new NodeNotFound({ type, id: key })),
          onSome: (at) => missed(key, at),
        }),
      onSome: (row) => Effect.succeed({ id: key, version: row.version }),
    });

  return {
    load,
    insert: Effect.fn(`${type}.insert`)(function* (key, values) {
      const tx = yield* CurrentTransaction;
      yield* tx
        .insert(table)
        .values({ ...values, id: key, version: 0n })
        .pipe(
          catchUniqueViolation(
            (violation): Effect.Effect<never, NodeAlreadyExists | UniqueViolation> =>
              Option.contains(violation.constraint, primaryKey)
                ? Effect.fail(new NodeAlreadyExists({ type, id: key }))
                : Effect.fail(violation),
          ),
        );
      return { id: key, version: 0n };
    }),
    update: Effect.fn(`${type}.update`)(function* (input) {
      const tx = yield* CurrentTransaction;
      const expected = Option.fromUndefinedOr(input.expectedVersion);
      const rows = yield* tx
        .update(table)
        .set({ ...input.patch, version: sql`${version} + 1` })
        .where(guard(input.id, expected))
        .returning({ version });
      return yield* written(input.id, expected, yield* Effect.orDie(decodeWritten(rows)));
    }),
    delete: Effect.fn(`${type}.delete`)(function* (key, options) {
      const tx = yield* CurrentTransaction;
      const expected = Option.fromUndefinedOr(options?.expectedVersion);
      const rows = yield* tx.delete(table).where(guard(key, expected)).returning({ version });
      return yield* written(key, expected, yield* Effect.orDie(decodeWritten(rows)));
    }),
  };
};
