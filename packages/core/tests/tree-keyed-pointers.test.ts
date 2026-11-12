import { getTableName } from "drizzle-orm";
import {
  getTableConfig,
  getViewConfig,
  integer,
  PgDialect,
  pgSchema,
  text,
  type PgTable,
  type PgView,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type { ColumnBuilders } from "../src/derive.ts";
import { dbColumn, defineTree } from "../src/index.ts";
import { makeTreeTables, makeTreeViews } from "../src/versioned-chain.ts";

const builders = {
  text: (c: string) => text(c),
  integer: (c: string) => integer(c),
} satisfies ColumnBuilders<"text" | "integer">;

const textColumn = <const C extends string>(column: C) =>
  dbColumn(Schema.String, { column, pg: "text", notNull: false });

const tree = defineTree({
  work: { columns: { slugline: textColumn("slugline") } },
  article: {
    parent: "work",
    leaf: {
      wordCount: dbColumn(Schema.Finite, { column: "word_count", pg: "integer", notNull: false }),
    },
    keyed: { name: "locale", columns: { title: textColumn("title"), body: textColumn("body") } },
  },
  note: { parent: "work", leaf: {} },
});

const schema = pgSchema("ontology");
const dialect = new PgDialect();
const tables = makeTreeTables(tree, { schema, builders, root: { pointers: ["live"] } });
const views = makeTreeViews(tree, tables, {
  schema,
  pointers: { live: ["article", "note"] },
});

const columnNamesOf = (table: PgTable) => Arr.map(getTableConfig(table).columns, (c) => c.name);
const keysOf = (view: PgView) => R.keys(getViewConfig(view).selectedFields);
const sqlOf = (view: PgView) => {
  const { query } = getViewConfig(view);
  return query === undefined ? "" : dialect.sqlToQuery(query).sql;
};

describe("defineTree: keyed levels", () => {
  it("records a leaf's keyed level, its columns out of the leaf's own", () => {
    const article = tree.level("article");
    expect(Option.map(article.keyed, (keyed) => [keyed.name, R.keys(keyed.columns)])).toEqual(
      Option.some(["locale", ["title", "body"]]),
    );
    expect(R.keys(article.leafColumns)).toEqual(["wordCount"]);
    expect(Option.isNone(tree.level("note").keyed)).toBe(true);
  });

  it("throws at module load for a keyed level on a marker", () => {
    expect(() =>
      defineTree({
        work: { keyed: { name: "locale", columns: { title: textColumn("title") } } },
        book: { parent: "work", leaf: {} },
      }),
    ).toThrow(/marker level "work" declares a keyed level/);
  });

  it("throws at module load for a keyed column colliding with the path, or a reserved key", () => {
    expect(() =>
      defineTree({
        work: { columns: { title: textColumn("title") } },
        book: {
          parent: "work",
          leaf: {},
          keyed: { name: "locale", columns: { title: textColumn("title") } },
        },
      }),
    ).toThrow(/"title" \(column "title"\) on level "book" collides/);
    expect(() =>
      defineTree({
        book: { leaf: {}, keyed: { name: "version", columns: { title: textColumn("title") } } },
      }),
    ).toThrow(/reserved for the chain/);
  });
});

describe("makeTreeTables: keyed and pointer tables", () => {
  it("derives a keyed table keyed (id, version, key), foreign-keyed to the leaf version", () => {
    const keyed = tables.keyed.article;
    expect(getTableName(keyed)).toBe("article_locale");
    expect(columnNamesOf(keyed)).toEqual(["id", "version", "locale", "title", "body"]);
    const config = getTableConfig(keyed);
    expect(config.primaryKeys[0]?.getName()).toBe("article_locale_pkey");
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(["id", "version", "locale"]);
    expect(config.foreignKeys.map((fk) => [fk.getName(), fk.onDelete])).toEqual([
      ["article_locale_article_version_fk", "cascade"],
    ]);
    expect(R.keys(tables.keyed)).toEqual(["article"]);
    type Keyed = typeof tables.keyed.article.$inferSelect;
    expectTypeOf<Keyed["locale"]>().toEqualTypeOf<string>();
    expectTypeOf<Keyed["title"]>().toBeNullable();
  });

  it("derives one append-only log per named pointer", () => {
    const log = tables.pointers.live;
    expect(getTableName(log)).toBe("live_pointer");
    expect(columnNamesOf(log)).toEqual(["seq", "id", "version", "at", "actor", "recorded_at"]);
    const config = getTableConfig(log);
    expect(config.foreignKeys.map((fk) => fk.getName())).toContain("live_pointer_node_version_fk");
    expect(config.indexes.map((i) => i.config.name)).toEqual(["live_pointer_id_seq_idx"]);
    type Fact = typeof tables.pointers.live.$inferSelect;
    expectTypeOf<Fact["version"]>().toBeNullable();
    expectTypeOf<Fact["at"]>().toEqualTypeOf<Date>();
  });

  it("derives no keyed or pointer table for a tree that names none", () => {
    const plain = makeTreeTables(defineTree({ book: { leaf: {} } }), { schema, builders });
    expect(plain.keyed).toEqual({});
    expect(plain.pointers).toEqual({});
  });
});

describe("makeTreeViews: keyed views", () => {
  it("projects the leaf view, then the key and the keyed columns", () => {
    const view = views.keyed.article;
    expect(getViewConfig(view).name).toBe("article_locale_view");
    expect(keysOf(view)).toEqual([
      "id",
      "version",
      "action",
      "slugline",
      "wordCount",
      "locale",
      "title",
      "body",
      "timestamp",
      "createdAt",
    ]);
    expect(sqlOf(view)).toContain(`left join "ontology"."article_locale"`);
    type Row = typeof view.$inferSelect;
    expectTypeOf<Row["locale"]>().toBeNullable();
    expectTypeOf<NonNullable<Row["title"]>>().toEqualTypeOf<string>();
  });

  it("keeps the shared leaf view to one row per node", () => {
    expect(sqlOf(views.leaves.article)).not.toContain("article_locale");
    expect(R.keys(views.keyed)).toEqual(["article"]);
  });
});

describe("makeTreeViews: pointer views", () => {
  it("resolves each named leaf at the pointer's effective fact, `action` off the head", () => {
    const view = views.pointers.live.leaves.note;
    expect(getViewConfig(view).name).toBe("note_live_view");
    expect(keysOf(view)).toEqual([
      "id",
      "version",
      "action",
      "slugline",
      "timestamp",
      "createdAt",
      "liveAt",
    ]);
    const query = sqlOf(view);
    expect(query).toContain(`select distinct on ("ontology"."live_pointer"."id")`);
    expect(query).toContain(`"ontology"."live_pointer"."at" <= now()`);
    expect(query).toContain(
      `order by "ontology"."live_pointer"."id", "ontology"."live_pointer"."seq" desc`,
    );
    expect(query).toContain(`"head_row"."action"`);
    // The head row is found by the same anti-join as a head view, not a grouped max.
    expect(query).toContain(
      `inner join "ontology"."node_version" "head_row" on "pointer"."id" = "head_row"."id"`,
    );
    expect(query).toContain(
      `where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "head_row"."id") and ("newer"."version" > "head_row"."version")))`,
    );
    expect(query).not.toContain("max(");
    type Row = typeof view.$inferSelect;
    expectTypeOf<Row["liveAt"]>().toEqualTypeOf<Date>();
  });

  it("composes with a keyed level: the live view of a localised leaf", () => {
    const view = views.pointers.live.keyed.article;
    expect(getViewConfig(view).name).toBe("article_locale_live_view");
    expect(keysOf(view)).toContain("locale");
    expect(keysOf(view).at(-1)).toBe("liveAt");
    expect(R.keys(views.pointers.live.keyed)).toEqual(["article"]);
  });
});
