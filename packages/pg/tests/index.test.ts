/**
 * Unit coverage for `@thomasfosterau/effect-drizzle-ext-pg` (`src/index.ts`).
 *
 * Nothing here touches a database: the service keys, the shape of `make` /
 * `layer`, and the one difference between the two client constructors that
 * is observable without a server — {@link pgClientFromPool} never connects at
 * layer build, {@link pgClientFromUrl} pings and so fails its build against
 * an address with nothing listening.
 *
 * The live-database half is `tests/integration/database.test.ts`.
 *
 * @module packages/pg/tests/index
 */

import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import {
  makePgDatabase,
  type PgDatabaseClient,
  pgClientFromPool,
  pgClientFromUrl,
} from "../src/index.ts";

/** The library is relations-agnostic; an empty graph is enough for the unit gate. */
const relations = {};
type TestRelations = typeof relations;

/**
 * A URL that resolves but has nothing listening: proof that
 * {@link pgClientFromPool} builds without a server. Port 1 is never a
 * PostgreSQL server.
 */
const UNREACHABLE = Redacted.make("postgresql://postgres@127.0.0.1:1/nothing");

describe("makePgDatabase", () => {
  it("derives both service keys from the key it is given", () => {
    const database = makePgDatabase({ relations, key: "UnitDb" });
    expect(database.Database.key).toBe("UnitDb");
    expect(database.CurrentTransaction.key).toBe("UnitDb/CurrentTransaction");
  });

  it("gives each call its own keys", () => {
    const primary = makePgDatabase({ relations, key: "Primary" });
    const replica = makePgDatabase({ relations, key: "Replica" });
    expect(primary.Database.key).not.toBe(replica.Database.key);
    expect(primary.CurrentTransaction.key).toBe("Primary/CurrentTransaction");
    expect(replica.CurrentTransaction.key).toBe("Replica/CurrentTransaction");
  });

  it("carries the driver-agnostic surface through unchanged", () => {
    const database = makePgDatabase({ relations, key: "UnitDb" });
    expect(typeof database.transact).toBe("function");
    expect(Effect.isEffect(database.readHandle)).toBe(true);
  });

  it("types `make` as an Effect requiring only PgClient", () => {
    const database = makePgDatabase({ relations, key: "UnitDb" });
    // The annotation is the assertion: `DefaultServices` must already be
    // provided, so nothing but `PgClient` is left in the requirement channel.
    const make: Effect.Effect<
      PgDatabaseClient<TestRelations>,
      never,
      PgClient.PgClient
    > = database.make;
    expect(Effect.isEffect(make)).toBe(true);
  });

  it("types `layer` as installing the key and requiring only PgClient", () => {
    const database = makePgDatabase({ relations, key: "UnitDb" });
    // The annotation is the assertion: the output is the key literal, the
    // error channel is `never`, and the input is `PgClient` alone.
    const layer: Layer.Layer<"UnitDb", never, PgClient.PgClient> = database.layer;
    expect(Layer.isLayer(layer)).toBe(true);
  });
});

describe("pgClientFromUrl", () => {
  it("pings at build, so an unreachable server fails the build", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.asVoid(
          Layer.build(
            pgClientFromUrl({ url: UNREACHABLE, maxConnections: 1, connectTimeout: "2 seconds" }),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("pgClientFromPool", () => {
  it("builds without connecting, and closes cleanly with its scope", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const context = yield* Layer.build(pgClientFromPool({ connectionString: UNREACHABLE }));
        // The client is in the context and nothing has talked to a server:
        // port 1 refuses every connection, so a ping would have failed the
        // build already.
        expect(Context.get(context, PgClient.PgClient)).toBeDefined();
      }).pipe(Effect.scoped),
    );
    expect(exit._tag).toBe("Success");
  });

  it("surfaces the connection failure on the first query instead", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          pgClientFromPool({ connectionString: UNREACHABLE, connectTimeout: "2 seconds" }),
        );
        const client = Context.get(context, PgClient.PgClient);
        return yield* client`SELECT 1`;
      }).pipe(Effect.scoped),
    );
    expect(exit._tag).toBe("Failure");
  });
});
