/**
 * `./Documents` against PostgreSQL, over a `TEMPORARY` table built from
 * `documentColumns()`'s DDL: the hash is the database's own digest of the
 * canonical `jsonb` text, an equal document under another key order is the
 * same document, and a malformed hash reads nothing.
 *
 * @module packages/pg/tests/integration/documents
 */

import { sql } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import { documentColumns, makeDocumentStore } from "../../src/Documents.ts";
import { makePgDatabase } from "../../src/PgDatabase.ts";
import { makeTestTransaction } from "../../src/Testing.ts";
import { integrationLayer } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;
const { inTestTransaction } = makeTestTransaction(database);

const documents = pgTable("documents_spec", documentColumns());
const Doc = Schema.Struct({ title: Schema.String, tags: Schema.Array(Schema.String) });
const store = makeDocumentStore({ table: documents, document: Doc, CurrentTransaction });

const seed = Effect.fn("documents.seed")(function* () {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  yield* tx.execute(sql`
    CREATE TEMPORARY TABLE documents_spec (
      hash bytea PRIMARY KEY GENERATED ALWAYS AS (digest(document::text, 'sha256')) STORED,
      document jsonb NOT NULL
    )`);
});

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  inTestTransaction(Effect.andThen(seed(), effect));

integrationLayer(database)((it) => {
  describe("makeDocumentStore", () => {
    it.effect("stores a document once, keyed by the database's digest", () =>
      run(
        Effect.gen(function* () {
          const first = yield* store.put({ title: "Tomato", tags: ["a"] });
          expect(first.inserted).toBe(true);
          expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
          const again = yield* store.put({ tags: ["a"], title: "Tomato" });
          expect(again).toEqual({ hash: first.hash, inserted: false });
          const tx = yield* CurrentTransaction;
          const digest = yield* tx.execute(
            sql`SELECT encode(digest('{"tags": ["a"], "title": "Tomato"}'::jsonb::text, 'sha256'), 'hex') AS hash`,
          );
          expect(digest.rows[0]).toEqual({ hash: first.hash });
          expect(yield* store.get(first.hash)).toEqual(
            Option.some({ title: "Tomato", tags: ["a"] }),
          );
        }),
      ),
    );

    it.effect("reads many in one go and ignores malformed or unknown hashes", () =>
      run(
        Effect.gen(function* () {
          const a = yield* store.put({ title: "A", tags: [] });
          const b = yield* store.put({ title: "B", tags: [] });
          const found = yield* store.getMany([a.hash, b.hash, a.hash, "nope", "0".repeat(64)]);
          expect(HashMap.size(found)).toBe(2);
          expect(HashMap.get(found, b.hash)).toEqual(Option.some({ title: "B", tags: [] }));
          expect(yield* store.get("nope")).toEqual(Option.none());
          expect(yield* store.get("0".repeat(64))).toEqual(Option.none());
          expect(HashMap.size(yield* store.getMany([]))).toBe(0);
        }),
      ),
    );
  });
});
