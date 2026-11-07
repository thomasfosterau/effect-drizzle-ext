import { sql } from "drizzle-orm";
import {
  getViewConfig,
  integer,
  PgDialect,
  pgSchema,
  text,
  type PgView,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as R from "effect/Record";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type { ColumnBuilders } from "../src/derive.ts";
import { makeTreeTables, makeTreeViews } from "../src/versioned-chain.ts";
import { bfoTree, frbrTree } from "./fixtures/trees.ts";

const builders = {
  text: (c: string) => text(c),
  integer: (c: string) => integer(c),
} satisfies ColumnBuilders<"text" | "integer">;

const schema = pgSchema("ontology");
const dialect = new PgDialect();

const frbrTables = makeTreeTables(frbrTree, {
  schema,
  builders,
  root: { identityColumns: { slug: text("slug") } },
});
const frbrViews = makeTreeViews(frbrTree, frbrTables, {
  schema,
  branches: { work: true, agent: true },
});

const keysOf = (view: PgView) => R.keys(getViewConfig(view).selectedFields);
const sqlOf = (view: PgView) => {
  const { query } = getViewConfig(view);
  return query === undefined ? "" : dialect.sqlToQuery(query).sql;
};

describe("makeTreeViews: leaf views", () => {
  it("names one view per leaf, in declaration order", () => {
    expect(R.keys(frbrViews.leaves)).toEqual([
      "book",
      "essay",
      "edition",
      "person",
      "organisation",
    ]);
    expect(getViewConfig(frbrViews.leaves.book).name).toBe("book_view");
  });

  it("projects the head, the identity extras, every level root-most first, then the timestamps", () => {
    expect(keysOf(frbrViews.leaves.book)).toEqual([
      "id",
      "version",
      "action",
      "slug",
      "title",
      "url",
      "pages",
      "timestamp",
      "createdAt",
    ]);
    expect(keysOf(frbrViews.leaves.edition)).toEqual([
      "id",
      "version",
      "action",
      "slug",
      "format",
      "isbn",
      "printRun",
      "timestamp",
      "createdAt",
    ]);
  });

  it("resolves the head from the root and INNER JOINs every level's version table at it", () => {
    const query = sqlOf(frbrViews.leaves.book);
    expect(query).toContain(`max("version") as "head_version" from "ontology"."node_version"`);
    expect(query).toContain(`group by "ontology"."node_version"."id"`);
    expect(query).toContain(`inner join "ontology"."work_version"`);
    expect(query).toContain(`inner join "ontology"."book_version"`);
    expect(query).toContain(`inner join "ontology"."node_version" "version_zero"`);
    expect(query).not.toContain("left join");
  });

  it("LEFT JOINs a fact-scoped level's facts and INNER JOINs its spine", () => {
    const query = sqlOf(frbrViews.leaves.edition);
    expect(query).toContain(`inner join "ontology"."manifestation_version"`);
    expect(query).toContain(`left join "ontology"."manifestation_format"`);
    expect(query).toContain(`left join "ontology"."manifestation_isbn"`);
  });

  it("reads base tables only, never another view", () => {
    Arr.forEach(R.values(frbrViews.leaves), (view) => {
      expect(sqlOf(view)).not.toMatch(/_view"/);
    });
  });

  it("types each view's row from the tree", () => {
    type Book = typeof frbrViews.leaves.book.$inferSelect;
    expectTypeOf<keyof Book>().toEqualTypeOf<
      "id" | "version" | "action" | "slug" | "title" | "url" | "pages" | "timestamp" | "createdAt"
    >();
    expectTypeOf<Book["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Book["version"]>().toEqualTypeOf<bigint>();
    expectTypeOf<Book["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Book["pages"]>().toBeNullable();
    expectTypeOf<NonNullable<Book["pages"]>>().toEqualTypeOf<number>();
    expectTypeOf<Book["createdAt"]>().toEqualTypeOf<Date>();
    type Edition = typeof frbrViews.leaves.edition.$inferSelect;
    expectTypeOf<Edition["isbn"]>().toBeNullable();
    expectTypeOf<NonNullable<Edition["isbn"]>>().toEqualTypeOf<string>();
  });

  it("projects ancestor level columns through nested markers", () => {
    const tables = makeTreeTables(bfoTree, { schema, builders });
    const views = makeTreeViews(bfoTree, tables, { schema });
    expect(keysOf(views.leaves.plant)).toEqual([
      "id",
      "version",
      "action",
      "label",
      "mass",
      "species",
      "timestamp",
      "createdAt",
    ]);
    expect(R.keys(views.branches)).toEqual([]);
  });
});

describe("makeTreeViews: branch views", () => {
  it("unions every subtree leaf, projecting the marker's path and `type`", () => {
    const view = frbrViews.branches.work;
    expect(getViewConfig(view).name).toBe("work_view");
    expect(keysOf(view)).toEqual([
      "id",
      "version",
      "action",
      "type",
      "slug",
      "title",
      "url",
      "timestamp",
      "createdAt",
    ]);
    const query = sqlOf(view);
    expect(query.match(/union all/g)?.length).toBe(1);
    // Each arm still INNER JOINs its own leaf, so it fails closed.
    expect(query).toContain(`inner join "ontology"."book_version"`);
    expect(query).toContain(`inner join "ontology"."essay_version"`);
    type Work = typeof view.$inferSelect;
    expectTypeOf<Work["type"]>().toEqualTypeOf<string>();
    expectTypeOf<Work["title"]>().toEqualTypeOf<string>();
  });

  it("adds a per-leaf projection to every arm (the search union)", () => {
    const views = makeTreeViews(frbrTree, frbrTables, {
      schema,
      branches: {
        work: {
          project: (leaf) => ({ searchText: sql<string>`${leaf}`.as("search_text") }),
        },
      },
    });
    expect(keysOf(views.branches.work).at(-1)).toBe("searchText");
    expectTypeOf<(typeof views.branches.work.$inferSelect)["searchText"]>().toEqualTypeOf<string>();
  });

  it("throws at module load for a projection whose columns differ between leaves", () => {
    expect(() =>
      makeTreeViews(frbrTree, frbrTables, {
        schema,
        branches: {
          work: {
            project: (leaf) =>
              leaf === "book" ? { a: sql<string>`'a'`.as("a") } : { b: sql<string>`'b'`.as("b") },
          },
        },
      }),
    ).toThrow(/project returns columns \(b\) for "essay" but \(a\) for "book"/);
  });

  it("throws at module load for a branch naming a leaf", () => {
    expect(() =>
      makeTreeViews(frbrTree, frbrTables, {
        schema,
        branches: { book: true },
      }),
    ).toThrow(/"book", which is not a marker level/);
  });
});

describe("makeTreeViews: as-of reads", () => {
  it("bounds the head by version", () => {
    const query = dialect.sqlToQuery(sql`select * from ${frbrViews.asOf("book", { version: 2n })}`);
    expect(query.sql).toContain(`where "ontology"."node_version"."version" <= $1`);
    expect(query.sql).toContain(`inner join "ontology"."book_version"`);
    expect(query.params).toContain(2n);
  });

  it("bounds the head by time", () => {
    const at = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));
    const query = dialect.sqlToQuery(sql`select * from ${frbrViews.asOf("book", { at })}`);
    expect(query.sql).toContain(`where "ontology"."node_version"."timestamp" <= $1`);
  });

  it("types the subquery's columns as the leaf view's", () => {
    const asOf = frbrViews.asOf("book", { version: 0n });
    expectTypeOf(asOf.pages).not.toBeAny();
    expectTypeOf(asOf.title).not.toBeAny();
  });
});
