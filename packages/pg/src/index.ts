/**
 * @copyright Thomas Foster
 *
 * The `@effect/sql-pg` binding of the driver-agnostic service factory: one
 * call to {@link makePgDatabase} gives an application the `Database` and
 * `CurrentTransaction` services, the `transact` write boundary and the
 * `readHandle` resolver, all typed over its own `relations` graph, plus the
 * `Effect` and `Layer` that build the Drizzle client itself.
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
import {
  type DatabaseServices,
  makeDatabaseServices,
} from "@thomasfosterau/effect-drizzle-ext/database";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type {
  EffectPgDatabase,
  EffectPgQueryResultHKT,
  EffectPgTransaction,
} from "drizzle-orm/effect-postgres";
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
 * const database = makePgDatabase({ relations, key: "Database" });
 * export const { Database, CurrentTransaction, transact, readHandle } = database;
 * export type Database = typeof database.Database.Identifier; // "Database"
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

  return { ...services, make, layer: Layer.effect(services.Database, make) };
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
/* oxlint-disable effect/prefer-option-over-null -- `config` is handed STRAIGHT to `@effect/sql-pg`'s `PgPoolConfig`, whose optional members are `?: T | undefined`: the driver reads `undefined` as "not supplied" and would treat an `Option` object as a value. Same boundary rule as the Drizzle-facing config in packages/core/src/derive.ts. */
export const pgClientFromUrl = (config: {
  readonly url: Redacted.Redacted<string>;
  readonly maxConnections?: number | undefined;
  readonly connectTimeout?: Duration.Input | undefined;
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
/* oxlint-disable effect/prefer-option-over-null -- driver-facing config: every optional member is forwarded to `@effect/sql-pg`'s `PgPoolConfig`, which reads `undefined` as "not supplied". See `pgClientFromUrl`'s block. */
export const pgClientFromPool = (options: {
  readonly connectionString: Redacted.Redacted<string>;
  readonly maxConnections?: number | undefined;
  readonly connectTimeout?: Duration.Input | undefined;
}): Layer.Layer<PgClient.PgClient | SqlClient, SqlError> =>
  PgClient.layer({
    url: options.connectionString,
    maxConnections: options.maxConnections,
    connectTimeout: options.connectTimeout,
  });
/* oxlint-enable effect/prefer-option-over-null */
