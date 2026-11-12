/**
 * The integration specs' one read of the database URL the global setup
 * provisioned (`DATABASE_URL_TEST`, else an explicit `DATABASE_URL`), through
 * Effect `Config` rather than `process.env`, so the specs' runtimes own it.
 *
 * @module packages/pg/tests/integration/database-url
 */

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
