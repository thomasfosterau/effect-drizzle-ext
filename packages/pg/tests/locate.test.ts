/**
 * Unit coverage for `makePgDatabase`'s `locate`: resolving the names a
 * Postgres error carries to the Drizzle tables and columns of the relations
 * graph.
 *
 * No database: the fixtures are driver errors as `@effect/sql-pg` raises
 * them (the SQLSTATE under `code`, the server's fields beside it), bare or
 * already classified. The run against a real server is
 * `tests/integration/errors.test.ts`.
 *
 * @module packages/pg/tests/locate
 */

import { UniqueViolation } from "@thomasfosterau/effect-drizzle-ext/errors";
import { defineRelations } from "drizzle-orm";
import {
  integer,
  pgSchema,
  pgTable,
  pgView,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import * as Option from "effect/Option";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { makePgDatabase } from "../src/index.ts";

const authors = pgTable("authors", {
  id: integer("id").primaryKey(),
  handle: text("handle").notNull().unique("authors_handle_key"),
  email: text("email_address").notNull(),
});

const books = pgTable(
  "books",
  {
    id: integer("id").primaryKey(),
    authorId: integer("author_id")
      .notNull()
      .references(() => authors.id),
    title: text("title").notNull(),
    isbn: text("isbn"),
    shelf: text("shelf"),
  },
  (table) => [
    unique("books_author_title_key").on(table.authorId, table.title),
    uniqueIndex("books_isbn_idx").on(table.isbn),
  ],
);

const archive = pgSchema("archive");
const archivedBooks = archive.table(
  "books",
  { authorId: integer("author_id"), title: text("title") },
  (table) => [primaryKey({ columns: [table.authorId, table.title] })],
);

const bookTitles = pgView("book_titles").as((qb) => qb.select({ title: books.title }).from(books));

const relations = defineRelations({ authors, books, archivedBooks, bookTitles });
const { locate } = makePgDatabase({ relations, key: "LocateDb" });

/** A driver error as `@effect/sql-pg` raises it. */
const pgError = (fields: { readonly code: string } & Record<string, string>) => ({
  name: "error",
  severity: "ERROR",
  ...fields,
});

/** The location, failing the test when there is none. */
const located = (cause: Parameters<typeof locate>[0]) =>
  Option.getOrElse(locate(cause), () => expect.unreachable("locate found no table"));

describe("locate", () => {
  it("resolves a NOT NULL violation's table and column, by the column's database name", () => {
    const location = located(
      pgError({ code: "23502", table: "authors", schema: "public", column: "email_address" }),
    );
    expect(location.key).toBe("authors");
    expect(location.table).toBe(authors);
    expect(location.columns).toStrictEqual([authors.email]);
  });

  it("resolves a named unique constraint, a column-level one and a unique index to their columns", () => {
    expect(
      located(pgError({ code: "23505", table: "books", constraint: "books_author_title_key" }))
        .columns,
    ).toStrictEqual([books.authorId, books.title]);
    expect(
      located(pgError({ code: "23505", table: "authors", constraint: "authors_handle_key" }))
        .columns,
    ).toStrictEqual([authors.handle]);
    expect(
      located(pgError({ code: "23505", table: "books", constraint: "books_isbn_idx" })).columns,
    ).toStrictEqual([books.isbn]);
  });

  it("resolves an unnamed primary key and foreign key by the names drizzle-kit gives them", () => {
    expect(
      located(pgError({ code: "23505", table: "authors", constraint: "authors_pkey" })).columns,
    ).toStrictEqual([authors.id]);
    expect(
      located(
        pgError({
          code: "23505",
          table: "books",
          schema: "archive",
          constraint: "books_pkey",
        }),
      ).columns,
    ).toStrictEqual([archivedBooks.authorId, archivedBooks.title]);
    expect(
      located(
        pgError({
          code: "23503",
          table: "books",
          constraint: "books_author_id_authors_id_fkey",
          detail: 'Key (id)=(1) is still referenced from table "books".',
        }),
      ).columns,
    ).toStrictEqual([books.authorId]);
  });

  it("does not read DETAIL for a foreign key violation, whose key may be the other table's", () => {
    expect(
      located(
        pgError({
          code: "23503",
          table: "books",
          constraint: "books_author_fk_custom",
          detail: 'Key (id)=(1) is still referenced from table "books".',
        }),
      ).columns,
    ).toStrictEqual([]);
  });

  it("falls back to the DETAIL key for a constraint Drizzle didn't name", () => {
    const location = located(
      pgError({
        code: "23505",
        table: "books",
        constraint: "books_shelf_generated_key",
        detail: 'Key (shelf, "title")=(A, B) already exists.',
      }),
    );
    expect(location.columns).toStrictEqual([books.shelf, books.title]);
  });

  it("matches a schema-qualified table only in its schema", () => {
    expect(located(pgError({ code: "23505", table: "books", schema: "archive" })).table).toBe(
      archivedBooks,
    );
    expect(located(pgError({ code: "23505", table: "books", schema: "public" })).table).toBe(books);
    expect(located(pgError({ code: "23505", table: "books" })).table).toBe(books);
  });
});

describe("locate when there is nothing to resolve", () => {
  it("is none for a temporary table, an unknown table, a failure without a table, or no driver error", () => {
    expect(locate(pgError({ code: "23505", table: "books", schema: "pg_temp_3" }))).toStrictEqual(
      Option.none(),
    );
    expect(locate(pgError({ code: "23505", table: "nope" }))).toStrictEqual(Option.none());
    expect(locate(pgError({ code: "40001" }))).toStrictEqual(Option.none());
    expect(locate({ message: "boom" })).toStrictEqual(Option.none());
    expect(locate("not an error")).toStrictEqual(Option.none());
  });

  it("never resolves to a view", () => {
    expect(locate(pgError({ code: "23505", table: "book_titles" }))).toStrictEqual(Option.none());
  });

  it("has no columns for a CHECK violation, and leaves out names the table doesn't have", () => {
    expect(
      located(pgError({ code: "23514", table: "books", constraint: "books_title_check" })).columns,
    ).toStrictEqual([]);
    expect(
      located(pgError({ code: "23505", table: "books", detail: "Key (gone)=(1) already exists." }))
        .columns,
    ).toStrictEqual([]);
  });
});

describe("locate on a classified error", () => {
  it("reads the facts through the classified error's cause", () => {
    const violation = new UniqueViolation({
      constraint: Option.some("authors_handle_key"),
      table: Option.some("authors"),
      detail: Option.none(),
      cause: pgError({ code: "23505", table: "authors", constraint: "authors_handle_key" }),
    });
    expect(located(violation).columns).toStrictEqual([authors.handle]);
  });
});

describe("locate types", () => {
  it("is a union discriminated by the relations key, which narrows table and columns", () => {
    const location = locate(pgError({ code: "23505", table: "authors" }));
    type Location = Option.Option.Value<typeof location>;
    expectTypeOf<Location["key"]>().toEqualTypeOf<"authors" | "books" | "archivedBooks">();
    const narrowed = Option.filter(location, (value) => value.key === "authors");
    if (Option.isSome(narrowed) && narrowed.value.key === "authors") {
      expectTypeOf(narrowed.value.table).toEqualTypeOf<typeof authors>();
      expectTypeOf(narrowed.value.columns).toEqualTypeOf<
        ReadonlyArray<(typeof authors)["_"]["columns"][keyof (typeof authors)["_"]["columns"]]>
      >();
    }
    expect(Option.isSome(location)).toBe(true);
  });
});
