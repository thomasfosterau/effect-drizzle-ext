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
import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { DerivationError, type ColumnBuilders } from "../src/derive.ts";
import { dbColumn, defineTree } from "../src/index.ts";
import { makeTreeTables, makeTreeViews } from "../src/versioned-chain.ts";
import { bfoTree, frbrTree } from "./fixtures/trees.ts";

const builders = {
  text: (c: string) => text(c),
  integer: (c: string) => integer(c),
} satisfies ColumnBuilders<"text" | "integer">;

const schema = pgSchema("ontology");
const dialect = new PgDialect();

const withSlugRoot = { identityColumns: { slug: text("slug") } };
const frbrTables = makeTreeTables(frbrTree, {
  schema,
  builders,
  root: withSlugRoot,
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

const textColumn = <const C extends string>(column: C) =>
  dbColumn(Schema.String, { column, pg: "text", notNull: false });

describe("makeTreeViews: a column key two sources share (effect-drizzle-ext#164)", () => {
  const withSlug = { identityColumns: { slug: text("slug") } };

  it("throws for a level column shadowing an identity column", () => {
    const tree = defineTree({
      work: { columns: { slug: textColumn("work_slug") } },
      book: { parent: "work", leaf: {} },
    });
    const tables = makeTreeTables(tree, { schema, builders, root: withSlug });
    expect(() => makeTreeViews(tree, tables, { schema })).toThrow(DerivationError);
    expect(() => makeTreeViews(tree, tables, { schema })).toThrow(
      /view "book_view" selects "slug" from both root.identityColumns and level "work"/,
    );
  });

  it("throws for a level column shadowing the chain's createdAt", () => {
    const tree = defineTree({
      work: { columns: { title: textColumn("title") } },
      book: { parent: "work", leaf: { createdAt: textColumn("created") } },
    });
    const tables = makeTreeTables(tree, { schema, builders });
    expect(() => makeTreeViews(tree, tables, { schema })).toThrow(
      /selects "createdAt" from both level "book" and the chain's timestamps/,
    );
  });

  it("throws for a branch projection reusing a selected key", () => {
    expect(() =>
      makeTreeViews(frbrTree, frbrTables, {
        schema,
        branches: { work: { project: () => ({ title: sql<string>`'x'`.as("title") }) } },
      }),
    ).toThrow(/view "work_view" \(arm "book"\) selects "title" from both level "work" and project/);
  });

  it("passes once the clash is renamed, or projected under another key", () => {
    const tree = defineTree({
      work: { columns: { workSlug: textColumn("work_slug") } },
      book: { parent: "work", leaf: {} },
    });
    const tables = makeTreeTables(tree, { schema, builders, root: withSlug });
    const views = makeTreeViews(tree, tables, {
      schema,
      branches: { work: { project: () => ({ heading: sql<string>`'x'`.as("heading") }) } },
    });
    expect(keysOf(views.leaves.book)).toEqual([
      "id",
      "version",
      "action",
      "slug",
      "workSlug",
      "timestamp",
      "createdAt",
    ]);
    expect(keysOf(views.branches.work).at(-1)).toBe("heading");
  });
});

describe("makeTreeViews: stable-table columns (effect-drizzle-ext#188)", () => {
  const tables = makeTreeTables(frbrTree, {
    schema,
    builders,
    root: withSlugRoot,
    levels: {
      agent: { stableColumns: { externalKey: text("external_key") } },
      person: { stableColumns: { wikidataId: text("wikidata_id") } },
    },
  });
  const views = makeTreeViews(frbrTree, tables, {
    schema,
    branches: {
      agent: {
        project: (_leaf, columns) => ({
          key: sql<string>`${columns.externalKey}`.as("key"),
        }),
      },
    },
  });

  it("projects each level's stable columns before its version columns", () => {
    expect(keysOf(views.leaves.person)).toEqual([
      "id",
      "version",
      "action",
      "slug",
      "externalKey",
      "name",
      "wikidataId",
      "born",
      "timestamp",
      "createdAt",
    ]);
    expect(keysOf(views.leaves.organisation)).toEqual([
      "id",
      "version",
      "action",
      "slug",
      "externalKey",
      "name",
      "timestamp",
      "createdAt",
    ]);
  });

  it("INNER JOINs on id the stable table of each level with stable columns, and no other", () => {
    const query = sqlOf(views.leaves.person);
    expect(query).toContain(
      `inner join "ontology"."agent" on "head"."id" = "ontology"."agent"."id"`,
    );
    expect(query).toContain(
      `inner join "ontology"."person" on "head"."id" = "ontology"."person"."id"`,
    );
    expect(sqlOf(views.leaves.book)).toBe(sqlOf(frbrViews.leaves.book));
    expect(query).not.toMatch(/_view"/);
  });

  it("projects a marker's stable columns into its branch view, and hands them to project", () => {
    expect(keysOf(views.branches.agent)).toEqual([
      "id",
      "version",
      "action",
      "type",
      "slug",
      "externalKey",
      "name",
      "timestamp",
      "createdAt",
      "key",
    ]);
    expect(sqlOf(views.branches.agent)).toContain(`"ontology"."agent"."external_key"`);
  });

  it("types the stable columns into the leaf, branch and as-of selections", () => {
    type Person = typeof views.leaves.person.$inferSelect;
    expectTypeOf<Person["wikidataId"]>().toBeNullable();
    expectTypeOf<NonNullable<Person["wikidataId"]>>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<Person["externalKey"]>>().toEqualTypeOf<string>();
    type Agent = typeof views.branches.agent.$inferSelect;
    expectTypeOf<Agent["externalKey"]>().toBeNullable();
    expectTypeOf<NonNullable<Agent["externalKey"]>>().toEqualTypeOf<string>();
    // A level below the branch's marker projects nothing into it.
    expectTypeOf<"wikidataId" extends keyof Agent ? true : false>().toEqualTypeOf<false>();
    expectTypeOf(views.asOf("person", { version: 0n }).wikidataId).not.toBeAny();
  });

  it("throws for a stable column sharing a key with another source of the view", () => {
    const clashing = makeTreeTables(frbrTree, {
      schema,
      builders,
      root: withSlugRoot,
      levels: { agent: { stableColumns: { born: text("born_text") } } },
    });
    expect(() => makeTreeViews(frbrTree, clashing, { schema })).toThrow(
      /view "person_view" selects "born" from both levels\.agent\.stableColumns and level "person"/,
    );
    const shadowingSlug = makeTreeTables(frbrTree, {
      schema,
      builders,
      root: withSlugRoot,
      levels: { person: { stableColumns: { slug: text("person_slug") } } },
    });
    expect(() => makeTreeViews(frbrTree, shadowingSlug, { schema })).toThrow(
      /selects "slug" from both root.identityColumns and levels\.person\.stableColumns/,
    );
  });
});
