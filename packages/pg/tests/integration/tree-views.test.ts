/**
 * The views `makeTreeViews` derives from the fixture tree
 * (`tests/fixtures/schema.ts`), proven against PostgreSQL: a leaf view shows
 * the head with every ancestor level's columns and the birth row's
 * timestamp; a node whose head advanced past a level yields no row (fail
 * closed); a tombstone yields its row with `action = 'delete'`; a fact-scoped
 * level's missing fact reads as `NULL`; the branch view carries each leaf's rows; and
 * `asOf` resolves an older version by number or by time.
 *
 * @module packages/pg/tests/integration/tree-views
 */

import { eq, sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it } from "vite-plus/test";
import { integrationDatabaseLayer } from "./database-url.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import { bookView, editionView, ontologyViews, workView } from "../fixtures/schema.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;

const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction } = makeTestTransaction(database);

const BOOK = "00000000-0000-4000-8000-000000000011";
const ESSAY = "00000000-0000-4000-8000-000000000012";
const EDITION = "00000000-0000-4000-8000-000000000013";

const BORN = "2026-01-01T00:00:00Z";
const EDITED = "2026-02-01T00:00:00Z";
const DELETED = "2026-03-01T00:00:00Z";

const exec = Effect.fn("treeViews.exec")(function* (statement: string) {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql.raw(statement));
});

/** A root version row at `version`, written at `at`. */
const rootVersion = (id: string, version: number, action: string, at: string) =>
  exec(
    `INSERT INTO ontology.node_version (id, version, action, timestamp) VALUES ('${id}', ${version}, '${action}', '${at}')`,
  );

/** A book at version 0: the root, the work level and the leaf. */
const seedBook = Effect.fn("treeViews.seedBook")(function* () {
  yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${BOOK}', 'book')`);
  yield* rootVersion(BOOK, 0, "create", BORN);
  yield* exec(`INSERT INTO ontology.work (id, type) VALUES ('${BOOK}', 'book')`);
  yield* exec(
    `INSERT INTO ontology.work_version (id, version, title) VALUES ('${BOOK}', 0, 'Dune')`,
  );
  yield* exec(`INSERT INTO ontology.book (id, type) VALUES ('${BOOK}', 'book')`);
  yield* exec(`INSERT INTO ontology.book_version (id, version, pages) VALUES ('${BOOK}', 0, 412)`);
});

/** Version 1 of the book: every level written at the new version. */
const editBook = Effect.fn("treeViews.editBook")(function* () {
  yield* rootVersion(BOOK, 1, "update", EDITED);
  yield* exec(
    `INSERT INTO ontology.work_version (id, version, title) VALUES ('${BOOK}', 1, 'Dune Messiah')`,
  );
  yield* exec(`INSERT INTO ontology.book_version (id, version, pages) VALUES ('${BOOK}', 1, 256)`);
});

const bookRows = Effect.fn("treeViews.bookRows")(function* () {
  const tx = yield* CurrentTransaction;
  return yield* tx.select().from(bookView).where(eq(bookView.id, BOOK));
});

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

describe("makeTreeViews against PostgreSQL", () => {
  it("shows the head with its ancestor level columns and the birth row's timestamp", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedBook();
        expect(yield* bookRows()).toEqual([
          {
            id: BOOK,
            version: 0n,
            action: "create",
            title: "Dune",
            pages: 412,
            timestamp: date(BORN),
            createdAt: date(BORN),
          },
        ]);
        yield* editBook();
        expect(yield* bookRows()).toEqual([
          {
            id: BOOK,
            version: 1n,
            action: "update",
            title: "Dune Messiah",
            pages: 256,
            timestamp: date(EDITED),
            createdAt: date(BORN),
          },
        ]);
      }),
    );
  });

  it("fails closed: a head that advanced past a level yields no row, never a stale one", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedBook();
        // Version 1 reaches the root and the work level, but not the leaf.
        yield* rootVersion(BOOK, 1, "update", EDITED);
        yield* exec(
          `INSERT INTO ontology.work_version (id, version, title) VALUES ('${BOOK}', 1, 'Dune Messiah')`,
        );
        expect(yield* bookRows()).toEqual([]);
        const tx = yield* CurrentTransaction;
        expect(yield* tx.select().from(workView).where(eq(workView.id, BOOK))).toEqual([]);
      }),
    );
  });

  it("yields a tombstone's row with action 'delete'", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedBook();
        yield* rootVersion(BOOK, 1, "delete", DELETED);
        yield* exec(
          `INSERT INTO ontology.work_version (id, version, title) VALUES ('${BOOK}', 1, 'Dune')`,
        );
        yield* exec(
          `INSERT INTO ontology.book_version (id, version, pages) VALUES ('${BOOK}', 1, 412)`,
        );
        const rows = yield* bookRows();
        expect(rows.map((row) => [row.version, row.action])).toEqual([[1n, "delete"]]);
      }),
    );
  });

  it("reads a fact-scoped level's missing fact as NULL, and a present one as its value", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${EDITION}', 'edition')`);
        yield* rootVersion(EDITION, 0, "create", BORN);
        yield* exec(
          `INSERT INTO ontology.manifestation (id, type) VALUES ('${EDITION}', 'edition')`,
        );
        yield* exec(
          `INSERT INTO ontology.manifestation_version (id, version) VALUES ('${EDITION}', 0)`,
        );
        yield* exec(`INSERT INTO ontology.edition (id, type) VALUES ('${EDITION}', 'edition')`);
        yield* exec(`INSERT INTO ontology.edition_version (id, version) VALUES ('${EDITION}', 0)`);
        const tx = yield* CurrentTransaction;
        const isbn = Effect.map(
          tx
            .select({ isbn: editionView.isbn })
            .from(editionView)
            .where(eq(editionView.id, EDITION)),
          (rows) => rows.map((row) => row.isbn),
        );
        expect(yield* isbn).toEqual([null]);
        yield* exec(
          `INSERT INTO ontology.manifestation_isbn (id, version, isbn) VALUES ('${EDITION}', 0, '978-0441013593')`,
        );
        expect(yield* isbn).toEqual(["978-0441013593"]);
      }),
    );
  });

  it("unions a branch's leaves, each row carrying its leaf type", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedBook();
        yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${ESSAY}', 'essay')`);
        yield* rootVersion(ESSAY, 0, "create", BORN);
        yield* exec(`INSERT INTO ontology.work (id, type) VALUES ('${ESSAY}', 'essay')`);
        yield* exec(
          `INSERT INTO ontology.work_version (id, version, title) VALUES ('${ESSAY}', 0, 'On Sand')`,
        );
        yield* exec(`INSERT INTO ontology.essay (id, type) VALUES ('${ESSAY}', 'essay')`);
        yield* exec(`INSERT INTO ontology.essay_version (id, version) VALUES ('${ESSAY}', 0)`);
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({ id: workView.id, type: workView.type, title: workView.title })
          .from(workView)
          .orderBy(workView.id);
        expect(rows).toEqual([
          { id: BOOK, type: "book", title: "Dune" },
          { id: ESSAY, type: "essay", title: "On Sand" },
        ]);
      }),
    );
  });

  it("resolves an older version by number or by time with asOf", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedBook();
        yield* editBook();
        const tx = yield* CurrentTransaction;
        const titleAt = (point: Parameters<typeof ontologyViews.asOf>[1]) => {
          const asOf = ontologyViews.asOf("book", point);
          return tx
            .select({ version: asOf.version, title: asOf.title, createdAt: asOf.createdAt })
            .from(asOf)
            .where(eq(asOf.id, BOOK));
        };
        expect(yield* titleAt({ version: 0n })).toEqual([
          { version: 0n, title: "Dune", createdAt: date(BORN) },
        ]);
        expect(yield* titleAt({ version: 5n })).toEqual([
          { version: 1n, title: "Dune Messiah", createdAt: date(BORN) },
        ]);
        expect(yield* titleAt({ at: date("2026-01-15T00:00:00Z") })).toEqual([
          { version: 0n, title: "Dune", createdAt: date(BORN) },
        ]);
        expect(yield* titleAt({ at: date("2025-12-31T00:00:00Z") })).toEqual([]);
      }),
    );
  });
});
