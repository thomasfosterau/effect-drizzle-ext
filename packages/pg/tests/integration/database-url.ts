/**
 * The integration specs' one read of the database URL the global setup
 * provisioned (`DATABASE_URL_TEST`, else an explicit `DATABASE_URL`), through
 * Effect `Config` rather than `process.env`, and the `@effect/vitest` block
 * every spec's `it.effect` runs in.
 *
 * @module packages/pg/tests/integration/database-url
 */

import { layer } from "@effect/vitest";
import type { AnyRelations } from "drizzle-orm/relations";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type { SqlError } from "effect/sql/SqlError";
import type { PgDatabase } from "../../src/index.ts";
import { testDatabaseLayer } from "../../src/testing.ts";

/**
 * The provisioned database's URL. The global setup always sets
 * `DATABASE_URL_TEST`, so a missing one is a broken harness: a defect, not a
 * failure a spec handles.
 */
export const testDatabaseUrl: Effect.Effect<Redacted.Redacted<string>> = Effect.orDie(
  Config.Redacted("DATABASE_URL_TEST").pipe(Config.orElse(() => Config.Redacted("DATABASE_URL"))),
);

/** {@link testDatabaseLayer} over the provisioned database's URL. */
export const integrationDatabaseLayer = <Relations extends AnyRelations, Key extends string>(
  database: Pick<PgDatabase<Relations, Key>, "layer">,
): Layer.Layer<Key, SqlError> =>
  Layer.unwrap(Effect.map(testDatabaseUrl, (url) => testDatabaseLayer(database, { url })));

/**
 * An `@effect/vitest` `layer` block over {@link integrationDatabaseLayer}: one
 * pool for the block's specs, built before the first and closed after the
 * last, with `setup` (committed DDL a block needs before its first spec, or
 * services its specs read) built once against it. A live database runs on the
 * live clock, so the test services are left out.
 */
export const integrationLayerWith = <Relations extends AnyRelations, Key extends string, ROut, E>(
  database: Pick<PgDatabase<Relations, Key>, "layer">,
  setup: Layer.Layer<ROut, E, Key>,
) =>
  layer(Layer.provideMerge(setup, integrationDatabaseLayer(database)), {
    excludeTestServices: true,
  });

/** {@link integrationLayerWith} with nothing to set up. */
export const integrationLayer = <Relations extends AnyRelations, Key extends string>(
  database: Pick<PgDatabase<Relations, Key>, "layer">,
) => integrationLayerWith(database, Layer.empty);

/**
 * A second pool on the provisioned database, open for the spec's scope: a
 * connection of its own, for specs that race two committing transactions.
 * Built in a fresh memo map, since a block's would hand back its own pool.
 */
export const separateDatabase = <Relations extends AnyRelations, Key extends string>(
  database: Pick<PgDatabase<Relations, Key>, "layer">,
) =>
  Effect.gen(function* () {
    const memoMap = yield* Layer.makeMemoMap;
    return yield* Layer.buildWithMemoMap(
      integrationDatabaseLayer(database),
      memoMap,
      yield* Effect.scope,
    );
  });
