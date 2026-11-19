/**
 * The TIN helpers (`src/tin.ts`): the SQL each one renders through Drizzle's
 * Postgres dialect, the TINQL phrase escape, and the index options as
 * drizzle-kit writes them. No database: TIN is a PlanetScale extension that
 * the CI service container doesn't ship.
 *
 * @module packages/pg/tests/tin
 */

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { desc, eq, sql, type SQL } from "drizzle-orm";
import {
  alias,
  getTableConfig,
  integer,
  jsonb,
  PgDialect,
  pgTable,
  serial,
  text,
  varchar,
} from "drizzle-orm/pg-core";
import * as Option from "effect/Option";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  fullScore,
  highlight,
  highlightAnsi,
  matches,
  matchesAny,
  maxScore,
  phrase,
  score,
  type ScoreOptions,
  type TextOperand,
  tinIndex,
  tinIndexParameters,
} from "../src/tin.ts";

const posts = pgTable(
  "posts",
  {
    id: serial().primaryKey(),
    title: varchar({ length: 200 }).notNull(),
    body: text().notNull(),
    views: integer().notNull(),
    data: jsonb().notNull(),
  },
  (t) => [
    tinIndex("posts_title_tin", t.title),
    tinIndex("posts_body_tin", t.body, {
      stemmer: "en",
      k1: 1.5,
      scoreStopWords: ["the", "a"],
    }).where(sql`${t.views} > 0`),
  ],
);

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);

describe("matches", () => {
  it("binds the query as a text parameter", () => {
    expect(render(matches(posts.body, 'apple AND "fuji apple"'))).toEqual({
      sql: '"posts"."body" ==> $1::text',
      params: ['apple AND "fuji apple"'],
    });
  });

  it("takes an SQL expression on either side", () => {
    expect(render(matches(sql<string>`${posts.data}->>'title'`, sql`${posts.title}`))).toEqual({
      sql: `"posts"."data"->>'title' ==> "posts"."title"::text`,
      params: [],
    });
  });

  it("accepts only string-valued operands", () => {
    expectTypeOf<typeof posts.views>().not.toExtend<TextOperand>();
    expectTypeOf<typeof posts.data>().not.toExtend<TextOperand>();
    expectTypeOf<typeof posts.title>().toExtend<TextOperand>();
    expectTypeOf(matches(posts.title, "x")).toEqualTypeOf<SQL<boolean>>();
  });

  it("matchesAny binds each query, and an empty list is an empty array", () => {
    expect(render(matchesAny(posts.body, ["apple", "grape"]))).toEqual({
      sql: '"posts"."body" ==> ANY (ARRAY[$1::text, $2::text]::text[])',
      params: ["apple", "grape"],
    });
    expect(render(matchesAny(posts.body, [])).sql).toBe('"posts"."body" ==> ANY (ARRAY[]::text[])');
  });
});

describe("scores", () => {
  it("score qualifies the ctid with the table, or its alias", () => {
    expect(render(score(posts)).sql).toBe('tin.score("posts".ctid)');
    expect(render(score(alias(posts, "p"))).sql).toBe('tin.score("p".ctid)');
  });

  it("score passes its options as named, typed arguments", () => {
    expect(render(score(posts, { denseRatio: 2, k1: 3.2, b: 0.2, termAdd: ["fuji"] }))).toEqual({
      sql: 'tin.score("posts".ctid, dense_ratio => $1::real, k1 => $2::real, b => $3::real, term_add => ARRAY[$4::text]::text[])',
      params: [2, 3.2, 0.2, "fuji"],
    });
    expect(render(score(posts, { termReplace: ["a", "b"] })).sql).toBe(
      'tin.score("posts".ctid, term_replace => ARRAY[$1::text, $2::text]::text[])',
    );
    expectTypeOf<{ termAdd: string[]; termReplace: string[] }>().not.toExtend<ScoreOptions>();
  });

  it("types scores as numbers", () => {
    expectTypeOf(score(posts)).toEqualTypeOf<SQL<number>>();
    expectTypeOf(maxScore(posts)).toEqualTypeOf<SQL<number>>();
  });

  it("fullScore and maxScore", () => {
    expect(render(fullScore(posts, { b: 0.5 }))).toEqual({
      sql: 'tin.full_score("posts".ctid, b => $1::real)',
      params: [0.5],
    });
    expect(render(fullScore(posts)).sql).toBe('tin.full_score("posts".ctid)');
    expect(render(maxScore(posts)).sql).toBe('tin.max_score("posts".ctid)');
  });

  it("composes in a ranked query", () => {
    const query = dialect.sqlToQuery(
      sql`select ${posts.id} from ${posts} where ${matches(posts.body, "apple")} and ${eq(posts.views, 1)} order by ${desc(score(posts))}`,
    );
    expect(query.sql).toBe(
      'select "posts"."id" from "posts" where "posts"."body" ==> $1::text and "posts"."views" = $2 order by tin.score("posts".ctid) desc',
    );
  });
});

describe("highlight", () => {
  it("defaults every marker", () => {
    expect(render(highlight(posts.body)).sql).toBe('tin.highlight("posts"."body")');
  });

  it("names the markers and the query", () => {
    expect(
      render(highlight(posts.body, { begin: "<mark>", end: "</mark>", query: "apple" })),
    ).toEqual({
      sql: 'tin.highlight("posts"."body", begin_tag => $1::text, end_tag => $2::text, query => $3::text)',
      params: ["<mark>", "</mark>", "apple"],
    });
  });

  it("highlightAnsi wraps and names the query", () => {
    expect(render(highlightAnsi(posts.body, { wrapTo: 80, query: "apple" }))).toEqual({
      sql: 'tin.highlight_ansi("posts"."body", wrap_to => $1::integer, query => $2::text)',
      params: [80, "apple"],
    });
  });
});

describe("phrase", () => {
  it("quotes and escapes the phrase specials", () => {
    expect(phrase('say "AND" [now]')).toEqual(Option.some(String.raw`"say \"AND\" \[now\]"`));
    expect(phrase(String.raw`a\b_c`)).toEqual(Option.some(String.raw`"a\\b\_c"`));
    expect(phrase("apple* OR ~2")).toEqual(Option.some('"apple* OR ~2"'));
  });

  it("is None for blank input, which TIN would reject as an empty phrase", () => {
    expect(phrase("")).toEqual(Option.none());
    expect(phrase(" \t\n")).toEqual(Option.none());
  });
});

describe("tinIndex", () => {
  it("is a tin index with its options rendered for drizzle-kit", () => {
    const [title, body] = getTableConfig(posts).indexes;
    expect(title?.config).toMatchObject({ name: "posts_title_tin", method: "tin" });
    expect(title?.config.with).toBeUndefined();
    expect(body?.config).toMatchObject({
      name: "posts_body_tin",
      method: "tin",
      with: { k1: "1.5", score_stop_words: "'the,a'", stemmer: "en" },
    });
    expect(body?.config.where).toBeDefined();
  });

  it("renders every option under TIN's own name", () => {
    expect(
      tinIndexParameters({
        k1: 1.2,
        b: 0.75,
        scoreStopWords: ["it's"],
        tokenizer: "whitespace",
        caseFolding: "preserve",
        accentFolding: "preserve",
        longTokens: "truncate",
        maxTokenBytes: 64,
        graphemes: "discard",
        positionGaps: "collapse",
        initialSegmentCount: 4,
        targetSegmentCount: 2,
        maxMutableSegmentSize: 131_072,
        maxMergedSegmentSize: 100,
        deadPercentThreshold: 0.25,
      }),
    ).toEqual({
      k1: "1.2",
      b: "0.75",
      score_stop_words: "'it''s'",
      tokenizer: "whitespace",
      case_folding: "preserve",
      accent_folding: "preserve",
      long_tokens: "truncate",
      max_token_bytes: "64",
      graphemes: "discard",
      position_gaps: "collapse",
      initial_segment_count: "4",
      target_segment_count: "2",
      max_mutable_segment_size: "131072",
      max_merged_segment_size: "100",
      dead_percent_threshold: "0.25",
    });
    expect(tinIndexParameters({})).toEqual({});
  });

  it("is the DDL drizzle-kit generates", async () => {
    const table = pgTable("docs", { id: serial().primaryKey(), body: text().notNull() }, (t) => [
      tinIndex("docs_body_tin", t.body, { stemmer: "en", k1: 1.5, scoreStopWords: ["the", "a"] }),
      tinIndex("docs_lower_tin", sql`lower(${t.body})`).where(sql`${t.id} > 0`),
    ]);
    const statements = await generateMigration(
      await generateDrizzleJson({}),
      await generateDrizzleJson({ table }),
    );
    expect(statements).toContain(
      `CREATE INDEX "docs_body_tin" ON "docs" USING tin ("body") WITH (k1=1.5, score_stop_words='the,a', stemmer=en);`,
    );
    expect(statements).toContain(
      `CREATE INDEX "docs_lower_tin" ON "docs" USING tin (lower("body")) WHERE "id" > 0;`,
    );
  });
});
