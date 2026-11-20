/**
 * Core's `./Where` and `./Search` fragments against PostgreSQL, over a
 * `TEMPORARY` table: each renders SQL the server accepts, and the rows it
 * keeps are the rows `Predicate.evaluate` keeps (three-valued logic, code
 * point order, a missing column failing closed). `pg_trgm` and `vector`
 * ship in CI's `pgvector/pgvector:pg17` image.
 *
 * @module packages/pg/tests/integration/search-where
 */

import { tsvector } from "@thomasfosterau/effect-drizzle-ext/columns";
import * as Predicate from "@thomasfosterau/effect-drizzle-ext/Predicate";
import * as Search from "@thomasfosterau/effect-drizzle-ext/Search";
import * as Where from "@thomasfosterau/effect-drizzle-ext/Where";
import { asc, desc, getColumns, sql, type SQLWrapper } from "drizzle-orm";
import { integer, pgTable, text, vector } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import { integrationLayerWith } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction, Database } = database;
const { inTestTransaction } = makeTestTransaction(database);

/**
 * The extensions, committed once: created inside each spec's rolled-back
 * transaction, `vector` would get a new type OID per spec, which a
 * connection's cached parameter types would still name.
 */
const extensions = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    yield* db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  }),
);

const item = pgTable("search_where_spec", {
  id: integer("id").notNull(),
  name: text("name"),
  lang: text("lang").notNull(),
  config: Search.regconfig("config").notNull(),
  ids: Search.textArray("ids").notNull(),
  search: tsvector("search").notNull(),
  embedding: vector("embedding", { dimensions: 3 }),
});
const columns = getColumns(item);

const rows = [
  { id: 1, name: "apple", lang: "en", ids: ["Q1"], embedding: "[1,0,0]" },
  { id: 2, name: "Banana", lang: "en-AU", ids: [], embedding: "[0,1,0]" },
  { id: 3, name: "éclair", lang: "fr", ids: ["Q3"], embedding: null },
  { id: 4, name: null, lang: "xx", ids: [], embedding: null },
  { id: 5, name: "running shoes", lang: "en", ids: [], embedding: "[0.9,0.1,0]" },
] as const;

const seed = Effect.fn("searchWhere.seed")(function* () {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql`
    CREATE TEMPORARY TABLE search_where_spec (
      id integer NOT NULL,
      name text,
      lang text NOT NULL,
      config regconfig GENERATED ALWAYS AS (${Search.configForLanguage(sql`lang`)}) STORED,
      ids text[] NOT NULL,
      search tsvector GENERATED ALWAYS AS (${Search.weightedTsvector(Search.configForLanguage(sql`lang`), { A: sql`name` })}) STORED,
      embedding vector(3)
    )`);
  yield* Effect.forEach(
    rows,
    (row) =>
      tx.execute(
        sql`INSERT INTO search_where_spec (id, name, lang, ids, embedding) VALUES (${row.id}, ${row.name}, ${row.lang}, ARRAY[${sql.join(
          row.ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[], ${row.embedding}::vector)`,
      ),
    { concurrency: 1, discard: true },
  );
});

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  inTestTransaction(Effect.andThen(seed(), effect));

const idsWhere = Effect.fn("idsWhere")(function* (predicate: Predicate.Predicate<SQLWrapper>) {
  const tx = yield* CurrentTransaction;
  const found = yield* tx
    .select({ id: columns.id })
    .from(item)
    .where(Option.getOrUndefined(Where.render(predicate, columns)))
    .orderBy(asc(columns.id));
  return found.map((r) => r.id);
});

const inMemory = (predicate: Predicate.Predicate<SQLWrapper>) =>
  rows
    .filter((row) =>
      Predicate.evaluate(
        predicate,
        { id: row.id, name: row.name },
        {
          now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z")),
          member: () => false,
        },
      ),
    )
    .map((row) => row.id);

integrationLayerWith(
  database,
  extensions,
)((it) => {
  describe("Where.render", () => {
    it.effect("keeps the rows Predicate.evaluate keeps", () => {
      const cases: ReadonlyArray<Predicate.Predicate<SQLWrapper>> = [
        Predicate.gt("name", "Banana"),
        Predicate.lt("name", "b"),
        Predicate.not(Predicate.eq("name", "apple")),
        Predicate.notIn("name", ["apple"]),
        Predicate.not(Predicate.isIn("name", ["apple", "Banana"])),
        Predicate.or(Predicate.isNull("name"), Predicate.gte("id", 5)),
        Predicate.not(Predicate.eq("missing", 1)),
        Predicate.or(Predicate.eq("missing", 1), Predicate.eq("id", 2)),
        Predicate.not(Predicate.and(Predicate.eq("name", "x"), Predicate.eq("id", 4))),
      ];
      return run(
        Effect.forEach(
          cases,
          (predicate) =>
            Effect.map(idsWhere(predicate), (ids) => expect(ids).toEqual(inMemory(predicate))),
          { concurrency: 1 },
        ),
      );
    });

    it.effect("matches subquery membership and its complement", () => {
      const sub = sql`SELECT 1 UNION SELECT 2`;
      return run(
        Effect.gen(function* () {
          expect(yield* idsWhere(Predicate.inSet("id", sub))).toEqual([1, 2]);
          expect(yield* idsWhere(Predicate.notInSet("id", sub))).toEqual([3, 4, 5]);
        }),
      );
    });
  });

  describe("Search", () => {
    const ranked = Effect.fn("ranked")(function* (rank: Option.Option<Search.Rank>) {
      const { matches, score } = Option.getOrElse(rank, () => expect.unreachable("no rank"));
      const tx = yield* CurrentTransaction;
      const found = yield* tx
        .select({ id: columns.id, score: sql<number>`${score}` })
        .from(item)
        .where(matches)
        .orderBy(desc(score), asc(columns.id));
      return found.map((r) => r.id);
    });

    it.effect("stores each row's configuration from its language", () =>
      run(
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          const found = yield* tx
            .select({ id: columns.id, config: columns.config })
            .from(item)
            .orderBy(asc(columns.id));
          expect(found.map((r) => r.config)).toEqual([
            "english",
            "english",
            "french",
            "simple",
            "english",
          ]);
        }),
      ),
    );

    it.effect("ranks full text in each row's language, fuzzy, literal and vector", () =>
      run(
        Effect.gen(function* () {
          expect(
            yield* ranked(
              Search.fullText({ vector: columns.search, config: columns.config, query: "run" }),
            ),
          ).toEqual([5]);
          expect(yield* ranked(Search.trigram({ column: columns.name, query: "banan" }))).toEqual([
            2,
          ]);
          expect(
            yield* ranked(Search.trigram({ column: columns.name, query: "aple", threshold: 0.2 })),
          ).toEqual([1]);
          expect(
            yield* ranked(Search.literal({ column: columns.ids, values: ["Q3", "Q9"] })),
          ).toEqual([3]);
          expect(
            yield* ranked(Search.vector({ column: columns.embedding, embedding: [1, 0, 0] })),
          ).toEqual([1, 5, 2]);
          expect(
            yield* ranked(
              Search.vector({ column: columns.embedding, embedding: [1, 0, 0], maxDistance: 0.1 }),
            ),
          ).toEqual([1, 5]);
        }),
      ),
    );
  });
});
