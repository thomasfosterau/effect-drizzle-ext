/**
 * Drizzle round trip over `@effect/sql-pg` rc.118's binary-only driver: an
 * enum, a `bigint({ mode: "string" })` and a `timestamptz`, written and read
 * back through Drizzle's `effect-postgres` driver on a real PostgreSQL
 * server. Two runtimes: the plain `pgClientFromUrl` layer, and one that
 * forwards a `types` registry (an int8 -> decimal-string codec) through the
 * helper, the documented fix for `bigint({ mode: "string" })` (website#2027).
 *
 * Both tables live in a rolled-back transaction, so nothing is left behind.
 *
 * @module packages/pg/tests/integration/round-trip
 */

import * as PgTypes from "@effect/sql-pg/PgTypes";
import { sql } from "drizzle-orm";
import { bigint, integer, pgEnum, pgTable, timestamp } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { makePgDatabase, pgClientFromUrl } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";

const url = Redacted.make(process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? "");

const mood = pgEnum("rt_mood", ["sad", "ok", "happy"]);
const probe = pgTable("rt_probe", {
  id: integer("id").primaryKey(),
  mood: mood("mood").notNull(),
  big: bigint("big", { mode: "string" }).notNull(),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
});

/** Beyond 2^53, so a lossy `number` round trip would be caught too. */
const BIG = "9007199254740993";
const AT = DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-30T12:34:56.789Z"));

/** `int8` as a decimal string: what drizzle's `bigint` string mode expects. */
const int8String: PgTypes.Codec<string> = {
  decode: (bytes) =>
    Result.succeed(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(0).toString(),
    ),
  encode: (value) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, BigInt(value));
    return Result.succeed(out);
  },
};

const withTypes = () => {
  const types = PgTypes.makeRegistry();
  types.register(20, int8String, { arrayOid: 1016 });
  return types;
};

const database = makePgDatabase({ relations: {}, key: "Database" });
const { Database } = database;

const roundTrip = Effect.fn("roundTrip")(function* () {
  const db = yield* Database;
  yield* db.execute(sql`CREATE TYPE rt_mood AS ENUM ('sad', 'ok', 'happy')`);
  yield* db.execute(
    sql`CREATE TEMPORARY TABLE rt_probe (id integer PRIMARY KEY, mood rt_mood NOT NULL, big bigint NOT NULL, at timestamptz NOT NULL)`,
  );
  yield* db.insert(probe).values({ id: 1, mood: "happy", big: BIG, at: AT });
  return yield* db.select().from(probe);
});

const makeRuntime = (types?: PgTypes.Registry) =>
  ManagedRuntime.make(
    database.layer.pipe(
      Layer.provide(pgClientFromUrl({ url, maxConnections: 1, types, prepare: false })),
    ),
  );

describe("Drizzle round trip over the binary driver", () => {
  it("round-trips an enum, a string-mode bigint and a timestamptz with a forwarded types registry", async () => {
    const runtime = makeRuntime(withTypes());
    onTestFinished(() => runtime.dispose());
    const { runInTestTransaction } = makeTestTransaction(database);
    const rows = await runInTestTransaction(runtime, roundTrip());
    expect(rows).toEqual([{ id: 1, mood: "happy", big: BIG, at: AT }]);
  });

  it("reads a plain bigint column back as a bigint without the registry (the mismatch the README documents)", async () => {
    const runtime = makeRuntime();
    onTestFinished(() => runtime.dispose());
    const { runInTestTransaction } = makeTestTransaction(database);
    const rows = await runInTestTransaction(runtime, roundTrip());
    expect(rows[0]?.mood).toBe("happy");
    expect(rows[0]?.at).toEqual(AT);
    // Typed `string` by drizzle, delivered as a JS bigint by the driver.
    expect(rows[0]?.big).toBeTypeOf("bigint");
  });
});
