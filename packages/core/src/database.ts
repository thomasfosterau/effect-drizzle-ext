/**
 * @copyright Thomas Foster
 *
 * The Effect-native Drizzle transaction boundary, as a per-application
 * service factory: the `Database` and `CurrentTransaction` service keys, the
 * `transact` helper that opens a transaction and discharges its handle into
 * the context, and the `readHandle` resolver that prefers an ambient
 * transaction over the client.
 *
 * The transaction value is whatever `db.transaction((tx) => Effect.gen(…))`
 * passes its callback against the Effect-native Drizzle database. Its query
 * methods (`select`, `insert`, `update`, `delete`, `transaction`) return
 * Effects instead of Promises, so callers `yield*` them directly inside the
 * transactional `Effect.gen`.
 *
 * Nothing here names a driver. The module is generic over the database and
 * transaction types, so `drizzle-orm/effect-postgres` (and any other
 * Effect-native Drizzle driver) binds them from outside;
 * `@thomasfosterau/effect-drizzle-ext-pg` is the binding this repository
 * ships. The only Drizzle type that reaches this file is
 * {@link PgTransactionConfig}, a plain options record.
 *
 * Operations that predate the services took the transaction as an explicit
 * `tx` parameter rather than a `Client | Transaction` union. The pair
 * {@link DatabaseServices.CurrentTransaction} + {@link
 * DatabaseServices.transact} replaces that threading (website #1883); the
 * handle type stays visible because it is still the service's payload and the
 * driver's callback parameter type.
 *
 * @module database
 */

import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * The five read-side members {@link ReadHandle} narrows a handle to, as a
 * constraint.
 *
 * `Pick<T, K>` requires `K extends keyof T`, which an unconstrained type
 * parameter cannot satisfy; this interface is what lets {@link ReadHandle}
 * name the five keys structurally instead. Members are typed `unknown` on
 * purpose — the constraint asserts only that a handle HAS a read surface,
 * never what it looks like, so the driver keeps full control of the
 * signatures a consumer sees.
 */
export interface ReadSurface {
  readonly select: unknown;
  readonly selectDistinct: unknown;
  readonly selectDistinctOn: unknown;
  readonly with: unknown;
  readonly $count: unknown;
}

/**
 * The read surface shared by an Effect-native Drizzle database and its
 * transaction: every way of starting a SELECT, and nothing that writes.
 *
 * A read may run either side of a transaction boundary, so the value
 * {@link DatabaseServices.readHandle} yields has to be the part both handles
 * agree on. Narrowing to it is a `Pick`, never a cast: both handles satisfy
 * it structurally, and the driver's own signatures survive the narrowing.
 */
export type ReadHandle<Db extends ReadSurface> = Pick<
  Db,
  "select" | "selectDistinct" | "selectDistinctOn" | "with" | "$count"
>;

/**
 * The one method {@link DatabaseServices.transact} needs from a handle: open
 * a transaction, run an Effect against it, commit on success and roll back on
 * failure.
 *
 * Both the database and the transaction satisfy this — a transaction's own
 * `transaction` opens a SAVEPOINT — which is what makes nesting expressible
 * without a second type.
 *
 * `config` is optional here and absent from a transaction handle's own
 * signature; a method that ignores it stays assignable, so one interface
 * covers both.
 */
export interface TransactionalDatabase<Tx> {
  readonly transaction: <A, E, R>(
    f: (tx: Tx) => Effect.Effect<A, E, R>,
    config?: PgTransactionConfig,
  ) => Effect.Effect<A, E | SqlError, R>;
}

/**
 * The services one application's database handles are reached through: the
 * two service keys, the write boundary, and the read-side resolver.
 *
 * The identifier of each key is the **key string itself**, deliberately: an
 * application writes `type Database = typeof services.Database.Identifier`
 * and gets a requirement it can name in its own signatures, the way a
 * class-style `Context.Service` gives the class. Two factories called with
 * different keys therefore produce services that are distinct to the type
 * checker as well as at runtime.
 */
export interface DatabaseServices<Db, Tx extends ReadSurface, Key extends string> {
  /**
   * The canonical database service: the Effect-native Drizzle client, keyed
   * by the string the factory was given. Queries yielded from it are Effects
   * executed against whatever pool the layer providing it holds open.
   */
  readonly Database: Context.Service<Key, Db>;

  /**
   * The ambient transaction handle for the unit of work in flight.
   *
   * Providing it is {@link transact}'s job; an operation that needs the
   * handle yields this key instead of taking a `tx` parameter, so "must run
   * inside a transaction" lands in the `R` channel where the compiler checks
   * it rather than in a parameter a caller can satisfy with the wrong handle.
   *
   * The payload is NOT interchangeable with {@link Database}. A transaction
   * handle is the CONCRETE transaction the driver passed to the callback,
   * whereas the `Database` payload can be a proxy the consuming application
   * wrapped around its client (website #593 depends on that difference for
   * subquery recursion). Read this key as "the open transaction", not as
   * "permission to write".
   *
   * The key string is the `Database` key plus `/CurrentTransaction`, so the
   * pair is legible in a context dump and two applications composed into one
   * process never collide.
   */
  readonly CurrentTransaction: Context.Service<`${Key}/CurrentTransaction`, Tx>;

  /**
   * Runs `body` inside a database transaction, providing the handle as
   * {@link CurrentTransaction}.
   *
   * Replaces the hand-rolled `db.transaction((tx) => …)` boundary at every
   * call site: the handle is yielded here, the driver's callback parameter is
   * discharged into the context, and `CurrentTransaction` leaves the
   * requirement channel while everything else in it is preserved.
   *
   * **Always-open, never join-if-present.** Calling `transact` while a
   * transaction is already open deliberately opens a NESTED one (a SAVEPOINT
   * on the same connection), exactly as the hand-rolled `db.transaction` it
   * replaces did. A "join the ambient transaction if there is one" variant is
   * easy to write and is the wrong call here: it would silently delete every
   * SAVEPOINT the calling code currently takes, changing rollback granularity
   * without changing a line of that code. If you want to reuse the open
   * transaction, yield {@link CurrentTransaction} directly and do not open
   * another. Adjudicated on website #1883 (owner, 2026-09-07, condition 3) —
   * please do not "improve" this into a join-if-present helper.
   *
   * The nested boundary is opened on the ambient handle
   * (`tx.transaction(…)`), not on the client. Some drivers pin the open
   * connection to the fiber and would nest either way; a driver that does not
   * would hand `db.transaction` a SECOND pooled connection, making the
   * "nested" transaction an independent one that cannot see its parent's
   * uncommitted writes and does not roll back with it. Going through the
   * ambient handle is a SAVEPOINT on every driver.
   */
  readonly transact: <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, Exclude<R, `${Key}/CurrentTransaction`> | Key>;

  /**
   * The handle a **read** should use: the ambient {@link CurrentTransaction}
   * when one is open, the {@link Database} client otherwise.
   *
   * Reads sit either side of a boundary. A snapshot reconstruction runs with
   * no transaction in sight and also runs inside a restore's; a
   * carry-forward read happens once on a plain GET and again inside the
   * update. Threading a handle through those is what keeps a
   * `Pick<Tx, "select">` parameter alive after the services have removed
   * every other one — functions carrying a parameter purely because they are
   * honest about being callable from both sides.
   *
   * Preferring the transaction is also the safer default, not merely the
   * convenient one. A read issued against `Database` from inside an open
   * transaction takes its own pooled connection, so it is not guaranteed to
   * see that transaction's uncommitted writes — a carry-forward read that
   * missed the row the same unit of work had just written would be a silent
   * wrong-answer bug. Reading through the open transaction removes the
   * question. (A test harness that pins the pool to one connection cannot
   * demonstrate the difference; the reasoning is about the pooled production
   * path.)
   *
   * This is deliberately **not** what {@link transact} does for writes.
   * There, joining an ambient transaction would delete a SAVEPOINT and change
   * rollback granularity, which is why it is always-open (website #1883,
   * owner, 2026-09-07). A read opens nothing, so there is no boundary to lose
   * — the asymmetry is the point, not an inconsistency.
   *
   * Not for a caller that needs a handle which is concretely NOT the
   * consuming application's proxy (website #593). This falls back to exactly
   * that proxy when no transaction is open, so such a caller must keep
   * opening one of its own.
   *
   * The requirement channel says {@link Database} either way:
   * `Effect.serviceOption` does not surface `CurrentTransaction` in `R`, so
   * the preference is invisible to the type checker and is pinned by a test
   * instead.
   */
  readonly readHandle: Effect.Effect<ReadHandle<Tx>, never, Key>;
}

/**
 * Builds one application's {@link DatabaseServices} around its own database
 * and transaction types.
 *
 * Curried in two stages because TypeScript has no partial type-argument
 * inference: the first call fixes the driver's handle types (which a consumer
 * always writes out — they carry its relations graph), the second infers the
 * key string literal from the argument. Call it once per database, at module
 * scope, and export what it returns; calling it twice with the same key
 * produces services that share a runtime slot.
 *
 * @example
 * ```ts
 * const services = makeDatabaseServices<AppDatabase, AppTransaction>()({
 *   key: "Database",
 * });
 * export const { Database, CurrentTransaction, transact, readHandle } = services;
 * export type Database = typeof services.Database.Identifier; // "Database"
 * ```
 */
export const makeDatabaseServices =
  <
    Db extends TransactionalDatabase<Tx> & ReadHandle<Tx>,
    Tx extends ReadSurface & TransactionalDatabase<Tx>,
  >() =>
  <const Key extends string>(options: { readonly key: Key }): DatabaseServices<Db, Tx, Key> => {
    const Database = Context.Service<Key, Db>(options.key);
    const CurrentTransaction = Context.Service<`${Key}/CurrentTransaction`, Tx>(
      `${options.key}/CurrentTransaction`,
    );

    /** Widens either handle to the read surface without a cast — both satisfy it structurally. */
    const asReadHandle = (handle: ReadHandle<Tx>): ReadHandle<Tx> => handle;

    /** Opens the body's boundary on `handle`, discharging the new transaction into the context. */
    const openOn = <A, E, R>(
      handle: TransactionalDatabase<Tx>,
      body: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, Exclude<R, `${Key}/CurrentTransaction`>> =>
      handle.transaction((tx) => Effect.provideService(body, CurrentTransaction, tx));

    return {
      Database,
      CurrentTransaction,
      transact: <A, E, R>(
        body: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | SqlError, Exclude<R, `${Key}/CurrentTransaction`> | Key> =>
        Effect.flatMap(Effect.serviceOption(CurrentTransaction), (open) =>
          Option.isSome(open)
            ? openOn(open.value, body)
            : Effect.flatMap(Database, (db) => openOn(db, body)),
        ),
      readHandle: Effect.flatMap(Effect.serviceOption(CurrentTransaction), (open) =>
        Option.isSome(open)
          ? Effect.succeed(asReadHandle(open.value))
          : Effect.map(Database, asReadHandle),
      ),
    };
  };
