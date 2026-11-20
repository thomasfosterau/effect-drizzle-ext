import { getColumns, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, pgTable, text, vector } from "drizzle-orm/pg-core";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { tsvector } from "../src/columns.ts";
import * as Search from "../src/Search.ts";

const dialect = new PgDialect();

/** The value of an option a case expects to be some. */
const some = <A>(option: Option.Option<A>): A =>
  Option.getOrElse(option, () => expect.unreachable("expected Option.some"));

const render = (fragment: SQL) => dialect.sqlToQuery(fragment);

const doc = pgTable(
  "doc",
  {
    lang: text("lang").notNull(),
    config: Search.regconfig("config").notNull(),
    title: text("title"),
    body: text("body"),
    ids: Search.textArray("ids").notNull(),
    search: tsvector("search").notNull(),
    embedding: vector("embedding", { dimensions: 3 }),
  },
  (t) => [...Search.ftsIndexes("doc", { vector: t.search, trigram: [t.title] })],
);
const c = getColumns(doc);

describe("columns", () => {
  it("declares regconfig and text[]", () => {
    expect(c.config.getSQLType()).toBe("regconfig");
    expect(c.ids.getSQLType()).toBe("text[]");
  });

  it("names the fts and trigram indexes", () => {
    const indexes = getTableConfig(doc).indexes.map((i) => i.config.name);
    expect(indexes).toEqual(["doc_fts_idx", "doc_title_trgm_idx"]);
  });
});

describe("configForLanguage", () => {
  it("maps the primary subtag with a simple fallback", () => {
    const query = render(Search.configForLanguage(c.lang));
    expect(query.sql).toMatch(/^\(CASE lower\(split_part\("doc"\."lang", '-', 1\)\) WHEN 'da'/);
    expect(query.sql).toMatch(/WHEN 'en' THEN 'english'::regconfig/);
    expect(query.sql).toMatch(/ELSE 'simple'::regconfig END\)$/);
    expect(query.params).toEqual([]);
  });

  it("refuses a name it would inline unsafely", () => {
    expect(() => Search.configForLanguage(c.lang, { fallback: "x'; drop" })).toThrow(
      /not an identifier/,
    );
  });
});

describe("weightedTsvector", () => {
  it("concatenates the weights given, in order", () => {
    expect(render(Search.weightedTsvector(c.config, { B: c.body, A: c.title })).sql).toBe(
      `(setweight(to_tsvector("doc"."config", coalesce("doc"."title", '')), 'A') || setweight(to_tsvector("doc"."config", coalesce("doc"."body", '')), 'B'))`,
    );
    expect(render(Search.weightedTsvector("english", { A: c.title })).sql).toBe(
      `(setweight(to_tsvector('english'::regconfig, coalesce("doc"."title", '')), 'A'))`,
    );
    expect(render(Search.weightedTsvector("english", {})).sql).toBe(`''::tsvector`);
    expect(() => Search.weightedTsvector("x'y", { A: c.title })).toThrow(/not an identifier/);
  });
});

describe("rank fragments", () => {
  it("are none for a blank query", () => {
    expect(Option.isNone(Search.fullText({ vector: c.search, config: c.config, query: " " }))).toBe(
      true,
    );
    expect(Option.isNone(Search.trigram({ column: c.title, query: "" }))).toBe(true);
    expect(Option.isNone(Search.literal({ column: c.ids, values: [] }))).toBe(true);
    expect(Option.isNone(Search.vector({ column: c.embedding, embedding: [] }))).toBe(true);
  });

  it("parse each row's query in its own configuration", () => {
    const rank = some(
      Search.fullText({ vector: c.search, config: c.config, query: "tomato soup" }),
    );
    expect(render(rank.matches).sql).toBe(
      `("doc"."search") @@ websearch_to_tsquery("doc"."config", $1)`,
    );
    expect(render(rank.score).sql).toMatch(/^ts_rank_cd\("doc"\."search", /);
  });

  it("render trigram, literal and vector ranks", () => {
    const fuzzy = some(Search.trigram({ column: c.title, query: "tomatoe" }));
    expect(render(fuzzy.matches).sql).toBe(`("doc"."title") % $1`);
    const strict = some(Search.trigram({ column: c.title, query: "tomatoe", threshold: 0.5 }));
    expect(render(strict.matches).params).toEqual(["tomatoe", 0.5]);
    const exact = some(Search.literal({ column: c.ids, values: ["Q1", "Q2"] }));
    expect(render(exact.matches).sql).toBe(`("doc"."ids") && ARRAY[$1, $2]::text[]`);
    const near = some(
      Search.vector({ column: c.embedding, embedding: [1, 0, 0], maxDistance: 0.2 }),
    );
    expect(render(near.matches).params).toEqual(["[1,0,0]", 0.2]);
    expect(render(near.score).sql).toBe(`(1 - (("doc"."embedding") <=> $1::vector))::float8`);
    const any = some(Search.vector({ column: c.embedding, embedding: [1, 0, 0] }));
    expect(render(any.matches).sql).toBe(`("doc"."embedding") IS NOT NULL`);
  });

  it("fuses by reciprocal rank", () => {
    expect(render(Search.reciprocalRank(sql`r`, { weight: 2 })).sql).toBe(
      `($1::float8 / ($2 + r))`,
    );
  });
});
