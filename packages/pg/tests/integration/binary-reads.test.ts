/**
 * The column types drizzle-orm 1.0.0-rc.6's `effect-postgres` driver can't
 * read over `@effect/sql-pg`'s binary protocol, each read instead through the
 * cast the overview guide documents.
 *
 * @module packages/pg/tests/integration/binary-reads
 */

import { layer } from "@effect/vitest";
import * as Search from "@thomasfosterau/effect-drizzle-ext/Search";
import { sql } from "drizzle-orm";
import { integer, interval, macaddr, pgEnum, pgTable, vector } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";
import { makePgDatabase, pgClientFromUrl } from "../../src/PgDatabase.ts";
import { makeTestTransaction } from "../../src/Testing.ts";
import { testDatabaseUrl } from "./database-url.ts";

const mood = pgEnum("br_mood", ["sad", "ok", "happy"]);
const probe = pgTable("br_probe", {
  id: integer("id").primaryKey(),
  moods: mood("moods").array().notNull(),
  embedding: vector("embedding", { dimensions: 2 }).notNull(),
  span: interval("span").notNull(),
  mac: macaddr("mac").notNull(),
  config: Search.regconfig("config").notNull(),
});

const database = makePgDatabase({ relations: {}, key: "Database" });
const { Database } = database;
const { inTestTransaction } = makeTestTransaction(database);

const databaseLayer = database.layer.pipe(
  Layer.provide(
    Layer.unwrap(Effect.map(testDatabaseUrl, (url) => pgClientFromUrl({ url, maxConnections: 1 }))),
  ),
);

const seed = Effect.fn("seed")(function* () {
  const db = yield* Database;
  yield* db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  yield* db.execute(sql`CREATE TYPE br_mood AS ENUM ('sad', 'ok', 'happy')`);
  yield* db.execute(
    sql`CREATE TEMPORARY TABLE br_probe (id integer PRIMARY KEY, moods br_mood[] NOT NULL, embedding vector(2) NOT NULL, span interval NOT NULL, mac macaddr NOT NULL, config regconfig NOT NULL)`,
  );
  yield* db.execute(
    sql`INSERT INTO br_probe VALUES (1, '{ok,happy}', '[1.5,-2]', '1 day 02:00:00', '08:00:2b:01:02:03', 'english')`,
  );
  return db;
});

describe("binary-protocol reads drizzle-orm rc.6 leaves to the driver", () => {
  layer(databaseLayer, { excludeTestServices: true })((it) => {
    it.effect("reads each one through its documented cast", () =>
      Effect.gen(function* () {
        const rows = yield* inTestTransaction(
          Effect.gen(function* () {
            const db = yield* seed();
            return yield* db
              .select({
                moods: sql<ReadonlyArray<string>>`${probe.moods}::text[]`,
                embedding: sql<ReadonlyArray<number>>`${probe.embedding}::real[]`,
                span: sql<string>`${probe.span}::text`,
                mac: sql<string>`${probe.mac}::text`,
                config: Search.configName(probe.config),
              })
              .from(probe);
          }),
        );
        expect(rows).toEqual([
          {
            moods: ["ok", "happy"],
            embedding: [1.5, -2],
            span: "1 day 02:00:00",
            mac: "08:00:2b:01:02:03",
            config: "english",
          },
        ]);
      }),
    );

    // A failed statement aborts its transaction, so each bare select gets its own.
    it.effect("still fails a bare select of each column", () =>
      Effect.gen(function* () {
        const failures = yield* Effect.forEach(
          [probe.moods, probe.embedding, probe.mac, probe.config] as const,
          (column) =>
            inTestTransaction(
              Effect.gen(function* () {
                const db = yield* seed();
                return yield* db.select({ value: column }).from(probe);
              }),
            ).pipe(Effect.isFailure),
          { concurrency: 1 },
        );
        expect(failures).toEqual([true, true, true, true]);
      }),
    );
  });
});
