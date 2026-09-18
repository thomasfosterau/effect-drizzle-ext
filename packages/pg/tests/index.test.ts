/**
 * Unit coverage for `@thomasfosterau/effect-drizzle-ext-pg` (`src/index.ts`).
 *
 * Nothing here touches a database: the service keys, the shape of `make` /
 * `layer`, and the one behaviour of {@link pgClientFromPool} that is
 * observable without a server — that it acquires a bare `pg.Pool`, never
 * connects at layer build, and ends the pool when the scope closes.
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
import * as Pg from "pg";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("is a layer over PgClient (which pings at build — see the doc comment)", () => {
    const layer = pgClientFromUrl({ url: UNREACHABLE, maxConnections: 1 });
    expect(Layer.isLayer(layer)).toBe(true);
  });
});

describe("pgClientFromPool", () => {
  it("builds without connecting, and ends the pool when the scope closes", async () => {
    // `end` is inherited from `pg`'s base `Pool`; spying defines an own
    // property on the bound subclass's prototype, which instances find first.
    const end = vi
      .spyOn(Pg.Pool.prototype, "end")
      .mockImplementation(() => Promise.resolve(undefined));
    const connect = vi.spyOn(Pg.Pool.prototype, "connect");
    const query = vi.spyOn(Pg.Pool.prototype, "query");

    await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(pgClientFromPool({ connectionString: UNREACHABLE }));
        // The pool exists and the client is in the context …
        expect(Context.get(context, PgClient.PgClient)).toBeDefined();
        // … and nothing has talked to a server (this is the whole point:
        // `PgClient.layer` would have run a `SELECT 1` by now).
        expect(connect).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
      }).pipe(Effect.scoped),
    );

    expect(end).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit end timeout without failing the release", async () => {
    // A pool that never drains must not wedge teardown: the release is
    // `timeoutOption`-bounded, so the scope closes either way.
    const end = vi.spyOn(Pg.Pool.prototype, "end").mockImplementation(
      () =>
        new Promise<undefined>(() => {
          /* never settles */
        }),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.asVoid(
          Layer.build(pgClientFromPool({ connectionString: UNREACHABLE, endTimeout: "10 millis" })),
        ),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(end).toHaveBeenCalledTimes(1);
  });
});
