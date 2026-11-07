/**
 * The pointer and keyed-fact levels `makeTreeTables` / `makeTreeViews` derive
 * for the fixture tree (`tests/fixtures/schema.ts`), proven against
 * PostgreSQL: the `live` pointer view lags the head after an edit, follows a
 * newer fact, hides a node on an unpublish or before a scheduled fact's `at`,
 * and reads the head's `action` (so a tombstone shows as one); essay's locale
 * view yields one row per locale and one `NULL` row for a locale-free head;
 * and the live view of the localised essay composes both.
 *
 * @module packages/pg/tests/integration/tree-pointers-keyed
 */

import { asc, eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction, testDatabaseLayer } from "../../src/testing.ts";
import {
  bookLiveView,
  essayLocaleLiveView,
  essayLocaleView,
  essayView,
} from "../fixtures/schema.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;

const url = Redacted.make(process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? "");
const runtime = ManagedRuntime.make(testDatabaseLayer(database, { url }));
const { runInTestTransaction } = makeTestTransaction(database);

const BOOK = "00000000-0000-4000-8000-000000000021";
const ESSAY = "00000000-0000-4000-8000-000000000022";

const exec = Effect.fn("pointersKeyed.exec")(function* (statement: string) {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql.raw(statement));
});

/** A work leaf `leaf` with versions `0..versions-1`, titled `t0`, `t1`, …. */
const seedWork = Effect.fn("pointersKeyed.seedWork")(function* (
  id: string,
  leaf: "book" | "essay",
  versions: number,
) {
  yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${id}', '${leaf}')`);
  yield* exec(`INSERT INTO ontology.work (id, type) VALUES ('${id}', '${leaf}')`);
  yield* exec(`INSERT INTO ontology.${leaf} (id, type) VALUES ('${id}', '${leaf}')`);
  yield* Effect.forEach(
    Array.from({ length: versions }, (_, v) => v),
    (v) =>
      Effect.gen(function* () {
        yield* exec(
          `INSERT INTO ontology.node_version (id, version, action) VALUES ('${id}', ${v}, '${v === 0 ? "create" : "update"}')`,
        );
        yield* exec(
          `INSERT INTO ontology.work_version (id, version, title) VALUES ('${id}', ${v}, 't${v}')`,
        );
        yield* exec(`INSERT INTO ontology.${leaf}_version (id, version) VALUES ('${id}', ${v})`);
      }),
    { concurrency: 1, discard: true },
  );
});

/** Record a `live` fact for `id`: a version, or `NULL` to clear; `at` an SQL expression. */
const point = (id: string, version: Option.Option<number>, at = "now()") =>
  exec(
    `INSERT INTO ontology.live_pointer (id, version, at) VALUES ('${id}', ${Option.getOrElse(Option.map(version, String), () => "NULL")}, ${at})`,
  );

const bookLive = Effect.fn("pointersKeyed.bookLive")(function* () {
  const tx = yield* CurrentTransaction;
  return yield* tx
    .select({
      version: bookLiveView.version,
      title: bookLiveView.title,
      action: bookLiveView.action,
    })
    .from(bookLiveView)
    .where(eq(bookLiveView.id, BOOK));
});

describe("the live pointer view", () => {
  it("lags the head after an edit, and follows the latest fact whose `at` has arrived", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWork(BOOK, "book", 1);
        expect(yield* bookLive()).toEqual([]);
        yield* point(BOOK, Option.some(0));
        expect(yield* bookLive()).toEqual([{ version: 0n, title: "t0", action: "create" }]);
        // An edit appends a version; the pointer still names version 0.
        yield* exec(
          `INSERT INTO ontology.node_version (id, version, action) VALUES ('${BOOK}', 1, 'update')`,
        );
        yield* exec(
          `INSERT INTO ontology.work_version (id, version, title) VALUES ('${BOOK}', 1, 't1')`,
        );
        yield* exec(`INSERT INTO ontology.book_version (id, version) VALUES ('${BOOK}', 1)`);
        expect(yield* bookLive()).toEqual([{ version: 0n, title: "t0", action: "update" }]);
        // A fact scheduled in the future isn't effective yet.
        yield* point(BOOK, Option.some(1), "now() + interval '1 day'");
        expect((yield* bookLive()).map((row) => row.version)).toEqual([0n]);
        yield* point(BOOK, Option.some(1));
        expect((yield* bookLive()).map((row) => row.version)).toEqual([1n]);
      }),
    );
  });

  it("hides a node whose effective fact clears the pointer", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWork(BOOK, "book", 1);
        yield* point(BOOK, Option.some(0));
        yield* point(BOOK, Option.none());
        expect(yield* bookLive()).toEqual([]);
      }),
    );
  });

  it("reads `action` off the head, so a tombstone shows at the pointed version", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWork(BOOK, "book", 1);
        yield* point(BOOK, Option.some(0));
        yield* exec(
          `INSERT INTO ontology.node_version (id, version, action) VALUES ('${BOOK}', 1, 'delete')`,
        );
        yield* exec(
          `INSERT INTO ontology.work_version (id, version, title) VALUES ('${BOOK}', 1, 't0')`,
        );
        yield* exec(`INSERT INTO ontology.book_version (id, version) VALUES ('${BOOK}', 1)`);
        expect(yield* bookLive()).toEqual([{ version: 0n, title: "t0", action: "delete" }]);
      }),
    );
  });

  it("writes no version: a fact leaves the chain untouched", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWork(BOOK, "book", 1);
        yield* point(BOOK, Option.some(0));
        const tx = yield* CurrentTransaction;
        const rows = yield* tx.execute<{ readonly n: string }>(
          sql`SELECT count(*) AS n FROM ontology.node_version WHERE id = ${BOOK}`,
        );
        expect(rows.rows.map((row) => Number(row.n))).toEqual([1]);
      }),
    );
  });
});

describe("the locale (keyed) view", () => {
  const locales = Effect.fn("pointersKeyed.locales")(function* () {
    const tx = yield* CurrentTransaction;
    return yield* tx
      .select({
        version: essayLocaleView.version,
        locale: essayLocaleView.locale,
        abstract: essayLocaleView.abstract,
      })
      .from(essayLocaleView)
      .where(eq(essayLocaleView.id, ESSAY))
      .orderBy(asc(essayLocaleView.locale));
  });

  it("yields one NULL-locale row for a head that carries no locale", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWork(ESSAY, "essay", 1);
        expect(yield* locales()).toEqual([{ version: 0n, locale: null, abstract: null }]);
      }),
    );
  });

  it("yields one row per locale the head carries, and none of an older version's", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWork(ESSAY, "essay", 2);
        yield* exec(
          `INSERT INTO ontology.essay_locale (id, version, locale, abstract) VALUES ('${ESSAY}', 0, 'de', 'alt')`,
        );
        yield* exec(
          `INSERT INTO ontology.essay_locale (id, version, locale, abstract) VALUES ('${ESSAY}', 1, 'en', 'Hello'), ('${ESSAY}', 1, 'fr', 'Bonjour')`,
        );
        expect(yield* locales()).toEqual([
          { version: 1n, locale: "en", abstract: "Hello" },
          { version: 1n, locale: "fr", abstract: "Bonjour" },
        ]);
        // The shared view stays one row per node.
        const tx = yield* CurrentTransaction;
        const shared = yield* tx
          .select({ id: essayView.id })
          .from(essayView)
          .where(eq(essayView.id, ESSAY));
        expect(shared).toEqual([{ id: ESSAY }]);
      }),
    );
  });

  it("composes with the pointer: the live view of the localised essay", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWork(ESSAY, "essay", 2);
        yield* exec(
          `INSERT INTO ontology.essay_locale (id, version, locale, abstract) VALUES ('${ESSAY}', 0, 'en', 'Draft zero'), ('${ESSAY}', 1, 'en', 'Head')`,
        );
        yield* point(ESSAY, Option.some(0));
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({
            version: essayLocaleLiveView.version,
            locale: essayLocaleLiveView.locale,
            abstract: essayLocaleLiveView.abstract,
          })
          .from(essayLocaleLiveView)
          .where(eq(essayLocaleLiveView.id, ESSAY));
        expect(rows).toEqual([{ version: 0n, locale: "en", abstract: "Draft zero" }]);
      }),
    );
  });
});
