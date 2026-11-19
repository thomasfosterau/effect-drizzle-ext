/**
 * @copyright Thomas Foster
 *
 * The `@effect/sql-pg` binding of the driver-agnostic service factory: one
 * call to {@link makePgDatabase} gives an application the `Database` and
 * `CurrentTransaction` services, the `transact` write boundary and the
 * `readHandle` resolver, all typed over its own `relations` graph, plus the
 * `Effect` and `Layer` that build the Drizzle client itself and the
 * context-bound `queries` (`select`, `insert`, `query`, …) that find the
 * client in the Effect context.
 *
 * `drizzle-orm/effect-postgres` already ships the Effect-native Drizzle
 * driver; nothing here re-implements it. What this module adds is the two
 * pieces every consuming application was spelling out by hand:
 *
 * - the `Layer.effect(Database, PgDrizzle.make({ relations }).pipe(provide(
 *   DefaultServices)))` stanza, which appeared four times per application
 *   (request path, event path, test harness, proxied test harness), and
 * - the choice of `PgClient` construction, which is a real decision rather
 *   than a detail — see {@link pgClientFromUrl} and {@link pgClientFromPool}.
 *
 * Deployment topology stays with the consuming application: resolving a
 * connection string from a platform binding, degrading a failed binding to a
 * chainable proxy client, and any proxy wrapper around the concrete client
 * are all things only the application knows about.
 *
 * @module index
 */

import * as PgClient from "@effect/sql-pg/PgClient";
import type * as PgTypes from "@effect/sql-pg/PgTypes";
import {
  type DatabaseServices,
  makeDatabaseServices,
} from "@thomasfosterau/effect-drizzle-ext/database";
import { type ClassifiedError, classifyErrors } from "@thomasfosterau/effect-drizzle-ext/errors";
import { makeQueryFunctions } from "@thomasfosterau/effect-drizzle-ext/query-functions";
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type {
  EffectPgDatabase,
  EffectPgQueryEffectHKT,
  EffectPgQueryResultHKT,
  EffectPgTransaction,
} from "drizzle-orm/effect-postgres";
import type { PgEffectDatabase } from "drizzle-orm/pg-core/effect";
import type { AnyRelations } from "drizzle-orm/relations";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The Effect-native Drizzle client an application's `Database` service holds,
 * typed over its relations graph.
 *
 * `$client` is the `PgClient` the driver was built against; it is part of the
 * value `drizzle-orm/effect-postgres`'s `make` returns, and is named here so
 * the service payload type is self-contained rather than
 * `Effect.Success<typeof make>` of a local binding.
 */
export type PgDatabaseClient<Relations extends AnyRelations> = EffectPgDatabase<Relations> & {
  readonly $client: PgClient.PgClient;
};

/**
 * The transaction handle the driver passes to a `db.transaction(...)`
 * callback — the payload of the `CurrentTransaction` service.
 *
 * The query-result HKT is pinned to `EffectPgQueryResultHKT` (the `@effect/
 * sql-pg` one) because that is what `EffectPgDatabase` opens its transactions
 * with; a consumer never writes the parameter.
 */
export type PgTransaction<Relations extends AnyRelations> = EffectPgTransaction<
  EffectPgQueryResultHKT,
  Relations
>;

/**
 * The query-effect kind of a context-bound query: the driver's own error
 * widened by the classified Postgres errors, and the database key added to
 * its requirement channel.
 *
 * Drizzle types every Effect-native builder over one of these kinds, so
 * swapping it is what turns the client's whole query surface (every builder,
 * every chained method, every relational query) into one that requires `Key`,
 * with each result type still inferred by Drizzle from the schema. The
 * driver's own context (`EffectPgQueryEffectHKT["context"]`) is `never`, so
 * the key is the whole requirement; `tests/query-functions.test.ts` pins it.
 *
 * The error is `EffectDrizzleQueryError | ClassifiedError`: a failure whose
 * SQLSTATE core's `./errors` classifies (`UniqueViolation`,
 * `ForeignKeyViolation`, `NotNullViolation`, `CheckViolation`,
 * `ExclusionViolation`, `SerializationFailure`, `DeadlockDetected`) arrives as
 * that tagged class, ready for `Effect.catchTag`; every other failure is the
 * driver's `EffectDrizzleQueryError`, unchanged.
 */
export interface PgContextQueryEffectHKT<Key extends string> extends QueryEffectHKTBase {
  readonly error: EffectPgQueryEffectHKT["error"] | ClassifiedError;
  readonly context: Key;
}

/**
 * The context-bound query functions of one application's database: the
 * client's query surface as free functions whose queries require the `Key`
 * service instead of a handle.
 *
 * Each is the matching `EffectPgDatabase` member, typed by Drizzle over
 * {@link PgContextQueryEffectHKT}: `select`, `selectDistinct`,
 * `selectDistinctOn`, `with`, `$count`, `insert`, `update`, `delete`,
 * `execute`, `refreshMaterializedView`, and the relational `query`.
 * `transaction` is left out on purpose: the boundary is
 * {@link DatabaseServices.transact}. So is `$with`, which builds a CTE from a
 * real builder; use Drizzle's `QueryBuilder` for CTEs and subqueries.
 */
export type PgQueryFunctions<Relations extends AnyRelations, Key extends string> = Pick<
  PgEffectDatabase<PgContextQueryEffectHKT<Key>, EffectPgQueryResultHKT, Relations>,
  | "select"
  | "selectDistinct"
  | "selectDistinctOn"
  | "with"
  | "$count"
  | "insert"
  | "update"
  | "delete"
  | "execute"
  | "refreshMaterializedView"
  | "query"
>;

/**
 * One application's database services: the driver-agnostic
 * {@link DatabaseServices} surface, plus the two things that are specific to
 * having chosen a driver — the `Effect` that builds the client and the
 * `Layer` that installs it under the `Database` key.
 *
 * Both carry `PgClient` in their requirement channel and nothing else: WHERE
 * the pool comes from is the consuming application's decision, made by
 * providing {@link pgClientFromUrl}, {@link pgClientFromPool}, or a client
 * layer of its own.
 */
export interface PgDatabase<
  Relations extends AnyRelations,
  Key extends string,
> extends DatabaseServices<PgDatabaseClient<Relations>, PgTransaction<Relations>, Key> {
  /**
   * Builds the Drizzle client over an ambient `PgClient`.
   *
   * `DefaultServices` supplies the no-op logger and cache the driver
   * requires; an application that wants real ones builds its own client and
   * provides it under {@link DatabaseServices.Database} instead of using
   * {@link layer}.
   */
  readonly make: Effect.Effect<PgDatabaseClient<Relations>, never, PgClient.PgClient>;

  /**
   * {@link make} installed under the `Database` key — the stanza every
   * consuming application was repeating once per runtime graph.
   *
   * Requires a `PgClient`, which is the seam the deployment topology plugs
   * into: a request-scoped pool over a platform binding in production, a
   * URL-configured pool in a harness.
   */
  readonly layer: Layer.Layer<Key, never, PgClient.PgClient>;

  /**
   * The context-bound query functions: `select`, `insert`, `update`,
   * `delete`, `query` and the rest of the client's query surface, each
   * finding its handle in the Effect context, so a caller writes
   * `yield* select().from(users)` with no client in sight.
   *
   * Every query requires `Key` and runs on the open
   * {@link DatabaseServices.CurrentTransaction} when there is one (inside
   * {@link DatabaseServices.transact}, a write lands in that transaction),
   * or on the {@link DatabaseServices.Database} client otherwise. A deferred
   * query is only for running: it can't render SQL or become a subquery
   * (both throw a `DeferredQueryError`); see core's `./query-functions`.
   *
   * A query's failure is classified on the way out (core's `./errors`
   * `classifyErrors`): a unique, foreign key, NOT NULL, CHECK or EXCLUDE
   * violation, a serialization failure or a deadlock fails with its tagged
   * class, so `Effect.catchTag("UniqueViolation", …)` works on the query
   * itself; see {@link PgContextQueryEffectHKT}.
   */
  readonly queries: PgQueryFunctions<Relations, Key>;
}

/**
 * Builds one application's {@link PgDatabase} from its relations graph and a
 * service key.
 *
 * Call it once, at module scope, and export what it returns; the keys are
 * derived from `key`, so calling it twice with the same key produces services
 * that share a runtime slot.
 *
 * @example
 * ```ts
 * import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
 *
 * const relations = {}; // the application's drizzle relations graph
 * const database = makePgDatabase({ relations, key: "Database" });
 * export const { Database, CurrentTransaction, transact, readHandle } = database;
 * export type Database = typeof database.Database.Identifier; // "Database"
 * // `delete` is a reserved word, so it takes another name when destructured.
 * export const { select, insert, update, delete: deleteFrom, query } = database.queries;
 *
 * console.log(Database.key); // "Database"
 * ```
 */
export const makePgDatabase = <Relations extends AnyRelations, const Key extends string>(options: {
  readonly relations: Relations;
  readonly key: Key;
}): PgDatabase<Relations, Key> => {
  const services = makeDatabaseServices<PgDatabaseClient<Relations>, PgTransaction<Relations>>()({
    key: options.key,
  });

  const make: Effect.Effect<
    PgDatabaseClient<Relations>,
    never,
    PgClient.PgClient
  > = PgDrizzle.make<Relations>({ relations: options.relations }).pipe(
    Effect.provide(PgDrizzle.DefaultServices),
  );

  return {
    ...services,
    make,
    layer: Layer.effect(services.Database, make),
    queries: makeQueryFunctions<PgQueryFunctions<Relations, Key>>()(services, {
      mapQuery: classifyErrors,
    }),
  };
};

/**
 * A `PgClient` layer over a connection URL that **pings the database
 * (`SELECT 1`) at layer BUILD**, failing the build with a `SqlError` if the
 * ping does not answer within `connectTimeout`.
 *
 * That is the right trade for a long-lived process — a misconfigured URL
 * fails once, loudly, at startup rather than on the first query — and the
 * wrong one for a runtime that is built per request, where it opens a
 * connection even for requests that never touch the database. Use
 * {@link pgClientFromPool} there.
 *
 * `@effect/sql-pg` 4.0.0-rc.115 replaced the `pg` driver with its own wire
 * protocol, and its `PgClient.layer` no longer pings on its own: the pool
 * opens connections on first use. The ping is therefore this function's, run
 * once over the freshly built client.
 *
 * The output includes `SqlClient` as well as `PgClient` because that is what
 * `PgClient.layerFrom` provides; a consumer that only needs `PgClient` can
 * ignore the extra service.
 */
export const pgClientFromUrl = (config: {
  readonly url: Redacted.Redacted<string>;
  readonly maxConnections?: number | undefined;
  readonly connectTimeout?: Duration.Input | undefined;
  /**
   * A per-client codec registry (`PgTypes.makeRegistry()` plus your
   * `register` calls), forwarded to `@effect/sql-pg`. See the README's
   * "Binary codecs" section for why Drizzle needs one.
   */
  readonly types?: PgTypes.Registry | undefined;
  /**
   * Named prepared statements (`@effect/sql-pg` defaults this to `true`).
   * Set `false` behind a pooler that cannot keep them across queries, such
   * as Cloudflare Hyperdrive.
   */
  readonly prepare?: boolean | undefined;
}): Layer.Layer<PgClient.PgClient | SqlClient, SqlError> =>
  PgClient.layerFrom(Effect.tap(PgClient.make(config), (client) => client`SELECT 1`));

/**
 * A `PgClient` layer over a connection URL that **does not connect at layer
 * build** — the lazy counterpart to {@link pgClientFromUrl}.
 *
 * The pool is `@effect/sql-pg`'s own: it opens connections on first use (up
 * to `maxConnections`) and is shut down, every session released, when the
 * layer's scope closes. A runtime built per request therefore disposes of its
 * pool with that request, and a connection failure surfaces on the first
 * query as a `SqlError` instead of at build. Platforms that pin I/O to the
 * event that created it require exactly this — a pool must never outlive
 * that event (website #455).
 *
 * Until `@effect/sql-pg` 4.0.0-rc.115 this wrapped a bare `pg.Pool` via
 * `PgClient.fromPool`, because `PgClient.layer` pinged at build; rc.115
 * dropped both the `pg` driver and `fromPool`, and its pool is lazy by
 * construction. The name is kept for the contract, not the mechanism.
 */
export const pgClientFromPool = (options: {
  readonly connectionString: Redacted.Redacted<string>;
  readonly maxConnections?: number | undefined;
  readonly connectTimeout?: Duration.Input | undefined;
  /**
   * A per-client codec registry (`PgTypes.makeRegistry()` plus your
   * `register` calls), forwarded to `@effect/sql-pg`. See the README's
   * "Binary codecs" section for why Drizzle needs one.
   */
  readonly types?: PgTypes.Registry | undefined;
  /**
   * Named prepared statements (`@effect/sql-pg` defaults this to `true`).
   * Set `false` behind a pooler that cannot keep them across queries, such
   * as Cloudflare Hyperdrive.
   */
  readonly prepare?: boolean | undefined;
}): Layer.Layer<PgClient.PgClient | SqlClient, SqlError> =>
  PgClient.layer({
    url: options.connectionString,
    maxConnections: options.maxConnections,
    connectTimeout: options.connectTimeout,
    types: options.types,
    prepare: options.prepare,
  });
