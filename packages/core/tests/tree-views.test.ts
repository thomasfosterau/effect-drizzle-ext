import { Column, getColumnFromDecoder, is, SQL, sql } from "drizzle-orm";
import {
  getViewConfig,
  integer,
  timestamp,
  type AnyPgColumn,
  PgDialect,
  pgSchema,
  text,
  type PgView,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Order from "effect/Order";
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

  it("drives from the leaf's version table, keeps head rows by an anti-join, and INNER JOINs every other level at it", () => {
    const query = sqlOf(frbrViews.leaves.book);
    expect(query).toContain(
      `from "ontology"."book_version" inner join "ontology"."node_version" on`,
    );
    expect(query).toContain(
      `where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."book_version"."id") and ("newer"."version" > "ontology"."book_version"."version")))`,
    );
    // No grouped head: the head is a primary-key probe, not an aggregate.
    expect(query).not.toContain("max(");
    expect(query).not.toContain("group by");
    expect(query).toContain(
      `inner join "ontology"."work_version" on (("ontology"."book_version"."id" = "ontology"."work_version"."id") and ("ontology"."book_version"."version" = "ontology"."work_version"."version"))`,
    );
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

/** A view selection, as a branch `project` receives it. */
type Columns = Readonly<Record<string, AnyPgColumn | SQL | SQL.Aliased>>;

/** Each leaf's own `label`. */
const projectLabel = (_leaf: string, columns: Columns) => ({
  label: columns["label"] ?? sql`null`.as("label"),
});

/** Each leaf's stable `seenAt`, wrapped. */
const seenAt = (_leaf: string, columns: Columns) => ({
  seen: sql`${columns["seenAt"]}`.as("seen"),
});

/** A computed value decoded with book's `seenAt`, but essay's `title`. */
const decoded = (leaf: string, columns: Columns) => {
  const decoder = columns[leaf === "book" ? "seenAt" : "title"];
  return {
    seen: is(decoder, Column)
      ? sql`coalesce(null)`.mapWith(decoder).as("seen")
      : sql`null`.as("seen"),
  };
};

describe("makeTreeViews: branch views", () => {
  it("drives one SELECT from the marker's version table, projecting its path and `type`", () => {
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
    // One driver, not a union of per-leaf arms (effect-drizzle-ext#200).
    expect(query).not.toContain("union all");
    expect(query).toContain(`from "ontology"."work_version" inner join "ontology"."node_version"`);
    expect(query.match(/not exists/g)?.length).toBe(1);
    expect(query).toContain(`("newer"."id" = "ontology"."work_version"."id")`);
    // Each subtree leaf LEFT JOINs at the driver's (id, version), in declaration order.
    const bookJoin = query.indexOf(`left join "ontology"."book_version"`);
    const essayJoin = query.indexOf(`left join "ontology"."essay_version"`);
    expect(bookJoin).toBeGreaterThan(0);
    expect(essayJoin).toBeGreaterThan(bookJoin);
    // Fail closed: the row's `type` must name a leaf whose row joined.
    expect(query).toContain(
      `((("ontology"."node"."type" = 'book') and (("ontology"."book_version"."id" is not null)))) or ((("ontology"."node"."type" = 'essay') and (("ontology"."essay_version"."id" is not null))))`,
    );
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
    // One CASE over the row's `type`, one arm per leaf, under the leaf's alias.
    expect(sqlOf(views.branches.work)).toContain(
      `case "ontology"."node"."type" when 'book' then 'book' when 'essay' then 'essay' end as "search_text"`,
    );
  });

  it("projects a leaf column through a CASE on `type`, under the column's name and decoder", () => {
    const views = makeTreeViews(frbrTree, frbrTables, {
      schema,
      branches: {
        work: {
          project: (leaf, columns) => ({
            note:
              leaf === "book"
                ? columns.pages
                : sql`length(${columns.title})`.mapWith(Number).as("pages"),
          }),
        },
      },
    });
    const query = sqlOf(views.branches.work);
    expect(query).toContain(
      `case "ontology"."node"."type" when 'book' then "ontology"."book_version"."pages" when 'essay' then length("ontology"."work_version"."title") end as "pages"`,
    );
    const note = getViewConfig(views.branches.work).selectedFields["note"];
    expect(note).toBeInstanceOf(SQL.Aliased);
    // Decoded as the first leaf's column.
    expect(is(note, SQL.Aliased) ? getColumnFromDecoder(note)?.name : undefined).toBe("pages");
  });

  it("selects a column every leaf projects as itself bare, with no CASE", () => {
    const views = makeTreeViews(frbrTree, frbrTables, {
      schema,
      branches: { work: { project: (_leaf, columns) => ({ heading: columns.url }) } },
    });
    expect(sqlOf(views.branches.work)).not.toContain("case");
  });

  it("keeps a non-column projection's own decoder", () => {
    const views = makeTreeViews(frbrTree, frbrTables, {
      schema,
      branches: {
        work: { project: (leaf) => ({ size: sql`length(${leaf})`.mapWith(Number).as("size") }) },
      },
    });
    const size = getViewConfig(views.branches.work).selectedFields["size"];
    expect(is(size, SQL.Aliased) ? size.sql : undefined).toMatchObject({
      decoder: { mapFromDriverValue: Number },
    });
  });

  it("throws at module load for leaves projecting one key as different SQL types", () => {
    const tree = defineTree({
      work: { columns: { title: textColumn("title") } },
      book: { parent: "work", leaf: { label: textColumn("label") } },
      essay: {
        parent: "work",
        leaf: {
          label: dbColumn(Schema.Finite, { column: "label", pg: "integer", notNull: false }),
        },
      },
    });
    const tables = makeTreeTables(tree, { schema, builders });
    expect(() =>
      makeTreeViews(tree, tables, { schema, branches: { work: { project: projectLabel } } }),
    ).toThrow(DerivationError);
    expect(() =>
      makeTreeViews(tree, tables, { schema, branches: { work: { project: projectLabel } } }),
    ).toThrow(
      /branch "work"'s project returns "label" as integer for "essay" but as text for "book"/,
    );
  });

  it("throws for timestamptz against timestamp, and for a mapWith column of another type", () => {
    const tree = defineTree({
      work: { columns: { title: textColumn("title") } },
      book: { parent: "work", leaf: {} },
      essay: { parent: "work", leaf: {} },
    });
    const tables = makeTreeTables(tree, {
      schema,
      builders,
      levels: {
        book: { stableColumns: { seenAt: timestamp("seen_at", { withTimezone: true }) } },
        essay: { stableColumns: { seenAt: timestamp("seen_at") } },
      },
    });
    expect(() =>
      makeTreeViews(tree, tables, { schema, branches: { work: { project: seenAt } } }),
    ).toThrow(/returns "seen" as timestamp for "essay" but as timestamp with time zone for "book"/);
    expect(() =>
      makeTreeViews(tree, tables, { schema, branches: { work: { project: decoded } } }),
    ).toThrow(/returns "seen" as text for "essay" but as timestamp with time zone for "book"/);
  });

  it("does not compare computed projections that name no column", () => {
    expect(() =>
      makeTreeViews(frbrTree, frbrTables, {
        schema,
        branches: {
          work: {
            project: (leaf) => ({ v: (leaf === "book" ? sql`1` : sql`'x'`).as("v") }),
          },
        },
      }),
    ).not.toThrow();
  });

  it("throws at module load for an unaliased projected expression", () => {
    expect(() =>
      makeTreeViews(frbrTree, frbrTables, {
        schema,
        branches: { work: { project: () => ({ bare: sql`1` }) } },
      }),
    ).toThrow(/branch "work"'s project returns an unaliased expression for "bare"/);
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

  it("LEFT JOINs each marker below the branch once, and requires the leaf's markers", () => {
    const tables = makeTreeTables(bfoTree, { schema, builders });
    const views = makeTreeViews(bfoTree, tables, {
      schema,
      branches: { continuant: true, independent_continuant: true },
    });
    // The selection stops at the branch: no marker or leaf column below it.
    expect(keysOf(views.branches.continuant)).toEqual([
      "id",
      "version",
      "action",
      "type",
      "label",
      "timestamp",
      "createdAt",
    ]);
    const query = sqlOf(views.branches.continuant);
    const joins = Arr.map(
      [
        `left join "ontology"."independent_continuant_version"`,
        `left join "ontology"."material_entity_version"`,
        `left join "ontology"."dependent_continuant_version"`,
        `left join "ontology"."plant_version"`,
        `left join "ontology"."bed_version"`,
        `left join "ontology"."document_version"`,
      ],
      (join) => {
        expect(query.split(join).length - 1, `once: ${join}`).toBe(1);
        return query.indexOf(join);
      },
    );
    // Markers in declaration order, then leaves in declaration order.
    expect(joins).toEqual(Arr.sort(joins, Order.Number));
    expect(query).toContain(
      `("ontology"."node"."type" = 'plant') and (("ontology"."independent_continuant_version"."id" is not null)) and (("ontology"."material_entity_version"."id" is not null)) and (("ontology"."plant_version"."id" is not null))`,
    );
    expect(query).toContain(
      `("ontology"."node"."type" = 'document') and (("ontology"."dependent_continuant_version"."id" is not null)) and (("ontology"."document_version"."id" is not null))`,
    );
    // A nested branch INNER JOINs the levels above it and drives from its own.
    const nested = sqlOf(views.branches.independent_continuant);
    expect(nested).toContain(`from "ontology"."independent_continuant_version" inner join`);
    expect(nested).toContain(`inner join "ontology"."continuant_version"`);
    expect(nested).not.toContain(`"ontology"."document_version"`);
    expect(keysOf(views.branches.independent_continuant)).toEqual(
      keysOf(views.branches.continuant),
    );
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
    // The bound applies to the row itself and inside the anti-join.
    expect(query.sql).toContain(
      `where (("ontology"."node_version"."version" <= $2) and (not exists`,
    );
    expect(query.sql).toContain(`and ("newer"."version" <= $3))`);
    expect(query.sql).toContain(`from "ontology"."book_version" inner join`);
    expect(query.params).toEqual([0n, 2n, 2n]);
  });

  it("bounds the head by time", () => {
    const at = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));
    const query = dialect.sqlToQuery(sql`select * from ${frbrViews.asOf("book", { at })}`);
    expect(query.sql).toContain(
      `where (("ontology"."node_version"."timestamp" <= $2) and (not exists`,
    );
    expect(query.sql).toContain(`and ("newer"."timestamp" <= $3))`);
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
    ).toThrow(/view "work_view" selects "title" from both level "work" and project/);
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
      `inner join "ontology"."agent" on "ontology"."person_version"."id" = "ontology"."agent"."id"`,
    );
    expect(query).toContain(
      `inner join "ontology"."person" on "ontology"."person_version"."id" = "ontology"."person"."id"`,
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
