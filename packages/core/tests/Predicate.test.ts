import { Filter } from "@thomasfosterau/effect-jsonapi";
import { getColumns, sql, type SQLWrapper } from "drizzle-orm";
import { integer, PgDialect, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { filterLiteral, predicateFromFilter } from "../src/JsonApi.ts";
import * as Predicate from "../src/Predicate.ts";
import * as Where from "../src/Where.ts";

const post = pgTable("post", {
  id: uuid("id").primaryKey(),
  title: text("title"),
  rank: integer("rank"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});
const columns = getColumns(post);
const dialect = new PgDialect();

/** The value of an option a case expects to be some. */
const some = <A>(option: Option.Option<A>): A =>
  Option.getOrElse(option, () => expect.unreachable("expected Option.some"));

/** An instant from its ISO form. */
const instant = (iso: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

const render = (predicate: Predicate.Predicate<SQLWrapper>) =>
  Option.map(Where.render(predicate, columns), (where) => dialect.sqlToQuery(where));

const sqlOf = (predicate: Predicate.Predicate<SQLWrapper>) => some(render(predicate)).sql;

describe("Predicate constructors", () => {
  it("simplifies and / or / not", () => {
    const a = Predicate.eq("title", "a");
    expect(Predicate.and()).toBe(Predicate.always);
    expect(Predicate.or()).toBe(Predicate.never);
    expect(Predicate.and(a)).toBe(a);
    expect(Predicate.and(a, Predicate.never)).toBe(Predicate.never);
    expect(Predicate.or(a, Predicate.always)).toBe(Predicate.always);
    expect(Predicate.and(a, Predicate.and(a, a))).toEqual({ _tag: "And", members: [a, a, a] });
    expect(Predicate.not(Predicate.not(a))).toBe(a);
    expect(Predicate.not(Predicate.always)).toBe(Predicate.never);
    expect(Predicate.not(Predicate.unknown)).toBe(Predicate.unknown);
  });

  it("makes unorderable comparands and oversized sets unknown", () => {
    expect(Predicate.eq("rank", Number.NaN)).toBe(Predicate.unknown);
    const invalid = instant("2026-01-01T00:00:00Z");
    invalid.setTime(Number.NaN);
    expect(Predicate.lt("publishedAt", invalid)).toBe(Predicate.unknown);
    expect(Predicate.isIn("rank", [])).toBe(Predicate.never);
    expect(Predicate.notIn("rank", [])).toBe(Predicate.always);
    const many = Array.from({ length: Predicate.MAX_SET_VALUES + 1 }, (_, i) => i);
    expect(Predicate.isIn("rank", many)).toBe(Predicate.unknown);
    expect(Predicate.notIn("rank", many)).toBe(Predicate.unknown);
    expect(Predicate.locale([])).toBe(Predicate.never);
  });

  it("lists columns and maps sets", () => {
    const p = Predicate.or(
      Predicate.eq("title", "a"),
      Predicate.not(Predicate.inSet("id", 1)),
      Predicate.isNull("title"),
    );
    expect(Predicate.columns(p)).toEqual(["title", "id"]);
    expect(Predicate.mapSets(p, (n) => n + 1)).toEqual(
      Predicate.or(
        Predicate.eq("title", "a"),
        Predicate.not(Predicate.inSet("id", 2)),
        Predicate.isNull("title"),
      ),
    );
  });
});

describe("Where.render", () => {
  it("is none for always", () => {
    expect(Option.isNone(render(Predicate.always))).toBe(true);
  });

  it("compares strings by code point and uuids as text", () => {
    expect(sqlOf(Predicate.gt("title", "b"))).toBe(`("post"."title")::text COLLATE "C" > $1`);
    expect(sqlOf(Predicate.eq("title", "b"))).toBe(`"post"."title" = $1`);
    expect(sqlOf(Predicate.eq("id", "not-a-uuid"))).toBe(`("post"."id")::text = $1`);
    expect(sqlOf(Predicate.isIn("id", ["a", "b"]))).toBe(`("post"."id")::text in ($1, $2)`);
  });

  it("binds numbers and dates through the column, and now() as the clock", () => {
    expect(sqlOf(Predicate.gte("rank", 3))).toBe(`"post"."rank" >= $1`);
    expect(sqlOf(Predicate.lt("rank", Number.POSITIVE_INFINITY))).toBe(
      `"post"."rank" < 'Infinity'::float8`,
    );
    const at = instant("2026-01-01T00:00:00Z");
    expect(some(render(Predicate.lte("publishedAt", at))).params).toEqual([at.toISOString()]);
    expect(sqlOf(Predicate.lte("publishedAt", Predicate.now))).toBe(
      `"post"."published_at" <= now()`,
    );
  });

  it("fails closed on a column the target lacks, negated or not", () => {
    expect(sqlOf(Predicate.eq("missing", 1))).toBe("NULL");
    expect(sqlOf(Predicate.not(Predicate.eq("missing", 1)))).toBe("(not NULL)");
    expect(sqlOf(Predicate.locale(["en"]))).toBe("NULL");
  });

  it("renders combinators, null tests and subquery membership", () => {
    const sub = sql`select 1`;
    expect(
      sqlOf(
        Predicate.or(
          Predicate.and(Predicate.isNull("title"), Predicate.notIn("rank", [1])),
          Predicate.inSet("id", sub),
          Predicate.notInSet("id", sub),
        ),
      ),
    ).toBe(
      `(((("post"."title" IS NULL) and ("post"."rank" not in ($1)))) or ("post"."id" IN (select 1)) or (("post"."id" IS NULL OR "post"."id" NOT IN (select 1))))`,
    );
    expect(sqlOf(Predicate.never)).toBe("false");
    expect(sqlOf(Predicate.unknown)).toBe("NULL");
  });

  it("gives a code-point key for string columns only", () => {
    expect(Option.map(Where.codePointKey(columns.title), (k) => dialect.sqlToQuery(k).sql)).toEqual(
      Option.some(`("post"."title")::text COLLATE "C"`),
    );
    expect(Option.isNone(Where.codePointKey(columns.rank))).toBe(true);
  });
});

describe("Predicate.evaluate", () => {
  const now = instant("2026-06-01T00:00:00Z");
  const context: Predicate.EvaluateContext<HashSet.HashSet<Predicate.Value>> = {
    now,
    member: (set, value) => HashSet.has(set, value),
  };
  const row = { title: "b", rank: 2, publishedAt: instant("2026-01-01T00:00:00Z"), id: null };
  const check = (p: Predicate.Predicate<HashSet.HashSet<Predicate.Value>>) =>
    Predicate.evaluate(p, row, context);

  it("compares by code point and across number kinds", () => {
    expect(check(Predicate.gt("title", "B"))).toBe(true);
    expect(check(Predicate.gt("title", "é"))).toBe(false);
    expect(check(Predicate.eq("rank", 2n))).toBe(true);
    expect(check(Predicate.lte("publishedAt", Predicate.now))).toBe(true);
    expect(check(Predicate.gt("publishedAt", Predicate.now))).toBe(false);
    expect(check(Predicate.eq("rank", "2"))).toBe(false);
  });

  it("follows three-valued logic over NULL and missing columns", () => {
    expect(check(Predicate.eq("id", "x"))).toBe(false);
    expect(check(Predicate.not(Predicate.eq("id", "x")))).toBe(false);
    expect(check(Predicate.not(Predicate.eq("missing", 1)))).toBe(false);
    expect(check(Predicate.not(Predicate.notIn("id", ["x"])))).toBe(false);
    expect(check(Predicate.or(Predicate.eq("id", "x"), Predicate.eq("rank", 2)))).toBe(true);
    expect(
      check(Predicate.not(Predicate.and(Predicate.eq("id", "x"), Predicate.eq("rank", 3)))),
    ).toBe(true);
    expect(check(Predicate.isNull("id"))).toBe(true);
    expect(check(Predicate.isIn("rank", [1, 2]))).toBe(true);
    expect(check(Predicate.notIn("rank", [1, 2]))).toBe(false);
  });

  it("treats set membership as two-valued when negated", () => {
    const set = HashSet.make<ReadonlyArray<Predicate.Value>>("b");
    expect(check(Predicate.inSet("title", set))).toBe(true);
    expect(check(Predicate.notInSet("title", set))).toBe(false);
    expect(check(Predicate.notInSet("id", set))).toBe(true);
    expect(check(Predicate.inSet("id", set))).toBe(false);
    expect(check(Predicate.not(Predicate.inSet("id", set)))).toBe(false);
  });
});

describe("predicateFromFilter", () => {
  it("compiles every node", () => {
    const filter = Filter.or(
      Filter.and(Filter.gt("rank", 1), Filter.isIn("title", ["a", "b"])),
      Filter.not(Filter.notIn("title", ["c"])),
      Filter.isNull("publishedAt", true),
      Filter.isNull("publishedAt", false),
      Filter.ne("id", "x"),
    );
    expect(predicateFromFilter(filter)).toEqual(
      Predicate.or(
        Predicate.and(Predicate.gt("rank", 1), Predicate.isIn("title", ["a", "b"])),
        Predicate.not(Predicate.notIn("title", ["c"])),
        Predicate.not(Predicate.isNull("publishedAt")),
        Predicate.isNull("publishedAt"),
        Predicate.ne("id", "x"),
      ),
    );
  });

  it("reads DateTime literals and makes unreadable ones unknown", () => {
    const at = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    expect(predicateFromFilter(Filter.lt("publishedAt", at))).toEqual(
      Predicate.lt("publishedAt", instant("2026-01-01T00:00:00Z")),
    );
    expect(predicateFromFilter(Filter.eq("title", { nested: true }))).toBe(Predicate.unknown);
    expect(predicateFromFilter(Filter.isIn("title", [{}]))).toBe(Predicate.unknown);
    expect(predicateFromFilter(Filter.notIn("title", [{}]))).toBe(Predicate.unknown);
    expect(Option.isNone(filterLiteral(Symbol.iterator))).toBe(true);
  });

  it("takes a field-aware literal reader", () => {
    const predicate = predicateFromFilter(Filter.eq("rank", "7"), {
      literal: (_field, value) => Option.some(Number(value)),
    });
    expect(predicate).toEqual(Predicate.eq("rank", 7));
  });
});
