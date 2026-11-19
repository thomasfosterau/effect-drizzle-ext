/**
 * @copyright Thomas Foster
 *
 * **Typed Drizzle helpers for TIN**, PlanetScale's full-text search extension
 * for Postgres (`CREATE EXTENSION tin`): the `==>` match operator, the BM25
 * score functions, highlighting and the `tin` index method, written to sit
 * beside Drizzle's own `eq`, `ilike` and `cosineDistance`.
 *
 * ```ts
 * db.select({ id: posts.id, score: score(posts) })
 *   .from(posts)
 *   .where(matches(posts.body, "apple OR grape"))
 *   .orderBy(desc(score(posts)))
 *   .limit(10);
 * ```
 *
 * Every helper builds a Drizzle `SQL` fragment and nothing else: no Effect,
 * no connection, no new dependency. The query string is always a bound
 * parameter, never SQL text, as PlanetScale's docs recommend. It is still
 * TINQL, though: uppercase `AND` / `OR` / `NEAR` in user input are operators,
 * and a stray `"` or `(` is a TINQL parse error at query time (the Effect
 * error channel, as a `SqlError`). Wrap raw user input with {@link phrase}
 * to search it literally.
 *
 * The extension itself is declared like any other, with `./tooling`'s
 * `extension("tin")`, so a fresh database gets it from the extras migration.
 *
 * TIN's reference: https://planetscale.com/docs/postgres/search
 *
 * @module tin
 */

import type { AnyColumn, SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { index, type IndexBuilder, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";

// ── Operands ────────────────────────────────────────────────────────────

/**
 * A text operand TIN can search: a column whose values are strings (`text`,
 * `varchar`, `citext`, a string enum), or an `SQL<string>` expression such
 * as `sql<string>\`${docs.data}->>'title'\`` for an expression index.
 *
 * A non-string column (an `integer`, a `jsonb`) is a type error.
 */
export type TextOperand = AnyColumn<{ data: string }> | SQLWrapper<string>;

/** A TINQL query: a string, bound as a parameter, or an SQL expression (a placeholder, an outer column). */
export type QueryOperand = string | SQLWrapper;

const text = (value: QueryOperand): SQL => sql`${value}::text`;

// ── The match operator ──────────────────────────────────────────────────

/**
 * `column ==> query`: true when the column's text satisfies the TINQL query.
 *
 * The query is bound as a parameter. Malformed TINQL (an unbalanced `"`, `(`
 * or `[`, an empty phrase `""`) fails when the query runs, in the Effect
 * error channel as a `SqlError`; an empty or all-punctuation query matches
 * nothing. Without a TIN index on the column Postgres has no way to evaluate
 * it, so index the exact column or expression with {@link tinIndex}.
 *
 * @example
 * ```ts
 * import { matches, phrase } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
 * import { and } from "drizzle-orm";
 * import { pgTable, serial, text } from "drizzle-orm/pg-core";
 * import * as Option from "effect/Option";
 *
 * const posts = pgTable("posts", { id: serial().primaryKey(), body: text().notNull() });
 *
 * const fuji = matches(posts.body, 'apple AND "fuji apple" AND NOT peel');
 * const literal = Option.map(phrase("Ask HN: AND/OR?"), (query) => matches(posts.body, query));
 * export const where = and(fuji, Option.getOrUndefined(literal));
 * ```
 */
export const matches = (column: TextOperand, query: QueryOperand): SQL<boolean> =>
  sql<boolean>`${column} ==> ${text(query)}`;

/**
 * `column ==> ANY (ARRAY[…])`: true when the column's text satisfies any one
 * of the TINQL queries. An empty list matches nothing.
 *
 * @example
 * ```ts
 * import { matchesAny } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
 * import { pgTable, serial, text } from "drizzle-orm/pg-core";
 *
 * const posts = pgTable("posts", { id: serial().primaryKey(), body: text().notNull() });
 *
 * export const where = matchesAny(posts.body, ["apple", '"fuji apple"']);
 * ```
 */
export const matchesAny = (
  column: TextOperand,
  queries: ReadonlyArray<QueryOperand>,
): SQL<boolean> =>
  sql<boolean>`${column} ==> ANY (ARRAY[${sql.join(Arr.map(queries, text), sql`, `)}]::text[])`;

// ── Scoring ─────────────────────────────────────────────────────────────

/** BM25 parameters a score function can override for one query, in place of the index's own. */
export interface Bm25Options {
  /** Term-frequency saturation, in `[0, 10000]`; the index's `k1` (default `1.2`) when absent. */
  readonly k1?: number;
  /** Length normalisation, in `[0, 1]`; the index's `b` (default `0.75`) when absent. */
  readonly b?: number;
}

/**
 * The options {@link score} takes. Every `score` call in one query must agree
 * on `denseRatio`, `termAdd` and `termReplace`; TIN rejects the query
 * otherwise. `termAdd` and `termReplace` exclude each other.
 */
export type ScoreOptions = Bm25Options & {
  /**
   * A term matching at least this fraction of documents is left out of the
   * score (matching is unaffected); TIN's default `0.10` when absent, and a
   * value above `1` turns the elision off.
   */
  readonly denseRatio?: number;
} & (
    | {
        /** Extra terms scored alongside the query's own, in analysed form. */
        readonly termAdd?: ReadonlyArray<string>;
        readonly termReplace?: never;
      }
    | {
        readonly termAdd?: never;
        /** Terms scored instead of the query's own, in analysed form. */
        readonly termReplace?: ReadonlyArray<string>;
      }
  );

/** `, name => value` when the option is present, nothing when it is absent. */
const namedArgument = <A>(
  name: string,
  value: Option.Option<A>,
  render: (value: A) => SQL,
): ReadonlyArray<SQL> =>
  Arr.fromOption(Option.map(value, (present) => sql`, ${sql.raw(name)} => ${render(present)}`));

const real = (value: number): SQL => sql`${value}::real`;

const bm25Arguments = (options?: Bm25Options): ReadonlyArray<SQL> => [
  ...namedArgument("k1", Option.fromUndefinedOr(options?.k1), real),
  ...namedArgument("b", Option.fromUndefinedOr(options?.b), real),
];

const textArray = (values: ReadonlyArray<string>): SQL =>
  sql`ARRAY[${sql.join(
    Arr.map(values, (value) => sql`${value}::text`),
    sql`, `,
  )}]::text[]`;

const ctid = (table: PgTable): SQL => sql`${table}.ctid`;

/**
 * `tin.score(table.ctid, …)`: the row's BM25 relevance to the TIN query that
 * selected it, higher is better. Scores compare only within one query.
 *
 * The query must scan the table through a TIN index ({@link matches} on an
 * indexed column); without one, Postgres raises "requires a tin index scan"
 * when it runs, in the Effect error channel as a `SqlError`. The ctid is
 * qualified with the table (or its `alias(...)`), so a join scores the right
 * relation. Under `FOR UPDATE` / `FOR SHARE` a concurrently updated row can
 * score `NULL`.
 *
 * @example
 * ```ts
 * import { matches, score } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
 * import { desc } from "drizzle-orm";
 * import { pgTable, serial, text } from "drizzle-orm/pg-core";
 *
 * const posts = pgTable("posts", { id: serial().primaryKey(), body: text().notNull() });
 *
 * // db.select({ id: posts.id, score: relevance }).from(posts).where(where).orderBy(desc(relevance)).limit(10)
 * export const where = matches(posts.body, "apple OR grape");
 * export const relevance = score(posts, { k1: 1.5 });
 * export const orderBy = desc(relevance);
 * ```
 */
export const score = (table: PgTable, options?: ScoreOptions): SQL<number> =>
  sql<number>`tin.score(${ctid(table)}${sql.join([
    ...namedArgument("dense_ratio", Option.fromUndefinedOr(options?.denseRatio), real),
    ...bm25Arguments(options),
    ...namedArgument("term_add", Option.fromUndefinedOr(options?.termAdd), textArray),
    ...namedArgument("term_replace", Option.fromUndefinedOr(options?.termReplace), textArray),
  ])})`.mapWith(Number);

/**
 * `tin.full_score(table.ctid, …)`: BM25 over every query term, with no dense
 * elision and no `score_stop_words`. It needs a TIN index scan, as
 * {@link score} does, and can't be combined with `score` on the same
 * relation in one query (Postgres rejects it when it runs).
 */
export const fullScore = (table: PgTable, options?: Bm25Options): SQL<number> =>
  sql<number>`tin.full_score(${ctid(table)}${sql.join([...bm25Arguments(options)])})`.mapWith(
    Number,
  );

/**
 * `tin.max_score(table.ctid)`: the highest {@link score} among the query's
 * matches, the same on every row, so `score / maxScore` is a relevance in
 * `[0, 1]`. It needs a TIN index scan, as `score` does.
 *
 * @example
 * ```ts
 * import { maxScore, score } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
 * import { sql } from "drizzle-orm";
 * import { pgTable, serial, text } from "drizzle-orm/pg-core";
 *
 * const posts = pgTable("posts", { id: serial().primaryKey(), body: text().notNull() });
 *
 * export const relative = sql<number>`${score(posts)} / ${maxScore(posts)}`.mapWith(Number);
 * ```
 */
export const maxScore = (table: PgTable): SQL<number> =>
  sql<number>`tin.max_score(${ctid(table)})`.mapWith(Number);

// ── Highlighting ────────────────────────────────────────────────────────

/** The options {@link highlight} takes. */
export interface HighlightOptions {
  /**
   * Written before each match; TIN's `<b>` when absent. `$QUERY_PART` and
   * `$QUERY_LABEL` in it expand to the matched query part (HTML-escaped)
   * and a CSS-safe label for it.
   */
  readonly begin?: string;
  /** Written after each match; TIN's `</b>` when absent. */
  readonly end?: string;
  /** The TINQL query to highlight; the query's `==>` on the same column when absent. */
  readonly query?: QueryOperand;
}

/**
 * `tin.highlight(column, …)`: the column's text with each match of the query
 * wrapped in markers.
 *
 * The text is not HTML-escaped: escape it (or render it as text) before it
 * reaches a page, unless the column is trusted markup.
 *
 * @example
 * ```ts
 * import { highlight, matches } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
 * import { pgTable, serial, text } from "drizzle-orm/pg-core";
 *
 * const posts = pgTable("posts", { id: serial().primaryKey(), body: text().notNull() });
 *
 * export const select = { id: posts.id, snippet: highlight(posts.body, { begin: "<mark>", end: "</mark>" }) };
 * export const where = matches(posts.body, "apple");
 * ```
 */
export const highlight = (column: TextOperand, options?: HighlightOptions): SQL<string> =>
  sql<string>`tin.highlight(${column}${sql.join([
    ...namedArgument("begin_tag", Option.fromUndefinedOr(options?.begin), text),
    ...namedArgument("end_tag", Option.fromUndefinedOr(options?.end), text),
    ...namedArgument("query", Option.fromUndefinedOr(options?.query), text),
  ])})`;

/** The options {@link highlightAnsi} takes. */
export interface HighlightAnsiOptions {
  /** Rewrap the text to this many columns before highlighting; no rewrap when absent. */
  readonly wrapTo?: number;
  /** The TINQL query to highlight; the query's `==>` on the same column when absent. */
  readonly query?: QueryOperand;
}

/** `tin.highlight_ansi(column, …)`: {@link highlight} with ANSI terminal colours for markers. */
export const highlightAnsi = (column: TextOperand, options?: HighlightAnsiOptions): SQL<string> =>
  sql<string>`tin.highlight_ansi(${column}${sql.join([
    ...namedArgument(
      "wrap_to",
      Option.fromUndefinedOr(options?.wrapTo),
      (columns) => sql`${columns}::integer`,
    ),
    ...namedArgument("query", Option.fromUndefinedOr(options?.query), text),
  ])})`;

// ── Escaping ────────────────────────────────────────────────────────────

/**
 * Quote arbitrary text as one TINQL phrase, so `AND`, `*`, `~` and stray
 * quotes in user input are searched as words rather than parsed. `"`, `\`,
 * `_`, `[` and `]` are escaped with `\`.
 *
 * `None` when the text is blank: TIN rejects the empty phrase `""` as a parse
 * error. Hyphens still split words (`wi-fi` searches `"wi fi"`), because that
 * is the tokenizer, not the query syntax.
 *
 * @example
 * ```ts
 * import { phrase } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
 * import * as Option from "effect/Option";
 *
 * console.log(Option.getOrThrow(phrase('say "AND" [now]'))); // "say \"AND\" \[now\]"
 * console.log(Option.isNone(phrase("   "))); // true
 * ```
 */
export const phrase = (input: string): Option.Option<string> =>
  Str.isEmpty(Str.trim(input))
    ? Option.none()
    : Option.some(`"${input.replaceAll(/["\\_[\]]/gu, (character) => `\\${character}`)}"`);

// ── Indexes ─────────────────────────────────────────────────────────────

/** A Snowball stemmer TIN ships, by language code. */
export type TinStemmer =
  | "ar"
  | "da"
  | "de"
  | "el"
  | "en"
  | "es"
  | "fi"
  | "fr"
  | "hu"
  | "it"
  | "nl"
  | "no"
  | "pt"
  | "ro"
  | "ru"
  | "sv"
  | "ta"
  | "tr";

/**
 * A TIN index's `WITH (…)` options; each absent one keeps TIN's default.
 * Changing a tokenization option on a populated index needs a `REINDEX`;
 * the scoring ones (`k1`, `b`, `scoreStopWords`) apply to the next query.
 */
export interface TinIndexOptions extends Bm25Options {
  /** Terms {@link score} leaves out, in analysed form (lowercase on a folding index, stemmed under a stemmer). */
  readonly scoreStopWords?: ReadonlyArray<string>;
  /** `unicode` (default) splits on Unicode word boundaries; `whitespace` on whitespace only. */
  readonly tokenizer?: "unicode" | "whitespace";
  /** Lowercase terms (`fold`, default) or keep their case (`preserve`). */
  readonly caseFolding?: "fold" | "preserve";
  /** Strip accents (`fold`, default) or keep them (`preserve`). */
  readonly accentFolding?: "fold" | "preserve";
  /** Stem terms in this language; unstemmed when absent. Requires `caseFolding: "fold"`. */
  readonly stemmer?: TinStemmer;
  /** What to do with a token over `maxTokenBytes`: `split` (default), `truncate` or `discard`. */
  readonly longTokens?: "split" | "truncate" | "discard";
  /** The longest token, in bytes, in `[4, 2692]`; TIN's default is `256`. */
  readonly maxTokenBytes?: number;
  /** Emoji and other non-word graphemes: indexed as terms (`emoji`, default), `retain` or `discard`. */
  readonly graphemes?: "emoji" | "retain" | "discard";
  /** Keep the positions of dropped tokens (`preserve`, default) or `collapse` them for phrase matching. */
  readonly positionGaps?: "preserve" | "collapse";
  /** Segments the initial build creates, in `[1, 4096]`; the available parallelism when absent. */
  readonly initialSegmentCount?: number;
  /** Segments maintenance merges toward, in `[1, 4096]`; `initialSegmentCount` when absent. */
  readonly targetSegmentCount?: number;
  /** Bytes a mutable segment holds before it is frozen, at least `131072`; TIN's default is 4 MiB. */
  readonly maxMutableSegmentSize?: number;
  /** Megabytes a merged segment may reach, at least `100`; TIN's default is `2000`. */
  readonly maxMergedSegmentSize?: number;
  /** The dead-row fraction, in `[0, 1]`, that triggers a segment rewrite; TIN's default is `0.5`. */
  readonly deadPercentThreshold?: number;
}

/**
 * A storage-parameter word as DDL text: drizzle-kit writes `with` values into
 * the `CREATE INDEX` verbatim, so a word stays bare (`stemmer = en`, as
 * Postgres records it) and anything else is a quoted literal.
 */
const word = (value: string): string =>
  /^[a-z_][a-z0-9_]*$/u.test(value) ? value : `'${value.replaceAll("'", "''")}'`;

/**
 * The `WITH (…)` record a TIN index takes, keyed by TIN's own parameter names
 * and rendered as DDL, for an index built by hand with
 * `index(name).using("tin", …).with(…)`.
 *
 * @example
 * ```ts
 * import { tinIndexParameters } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
 *
 * console.log(tinIndexParameters({ stemmer: "en", k1: 1.5 })); // { k1: "1.5", stemmer: "en" }
 * ```
 */
export const tinIndexParameters = (options: TinIndexOptions): Record<string, string> =>
  R.getSomes({
    k1: Option.map(Option.fromUndefinedOr(options.k1), String),
    b: Option.map(Option.fromUndefinedOr(options.b), String),
    score_stop_words: Option.map(Option.fromUndefinedOr(options.scoreStopWords), (words) =>
      word(Arr.join(words, ",")),
    ),
    tokenizer: Option.map(Option.fromUndefinedOr(options.tokenizer), word),
    case_folding: Option.map(Option.fromUndefinedOr(options.caseFolding), word),
    accent_folding: Option.map(Option.fromUndefinedOr(options.accentFolding), word),
    stemmer: Option.map(Option.fromUndefinedOr(options.stemmer), word),
    long_tokens: Option.map(Option.fromUndefinedOr(options.longTokens), word),
    max_token_bytes: Option.map(Option.fromUndefinedOr(options.maxTokenBytes), String),
    graphemes: Option.map(Option.fromUndefinedOr(options.graphemes), word),
    position_gaps: Option.map(Option.fromUndefinedOr(options.positionGaps), word),
    initial_segment_count: Option.map(Option.fromUndefinedOr(options.initialSegmentCount), String),
    target_segment_count: Option.map(Option.fromUndefinedOr(options.targetSegmentCount), String),
    max_mutable_segment_size: Option.map(
      Option.fromUndefinedOr(options.maxMutableSegmentSize),
      String,
    ),
    max_merged_segment_size: Option.map(
      Option.fromUndefinedOr(options.maxMergedSegmentSize),
      String,
    ),
    dead_percent_threshold: Option.map(
      Option.fromUndefinedOr(options.deadPercentThreshold),
      String,
    ),
  });

/**
 * A `CREATE INDEX … USING tin (column) WITH (…)` for a table's extra config,
 * the index every helper here needs. TIN indexes one column or expression;
 * cross-column search is one index per column.
 *
 * The result is Drizzle's own `IndexBuilder`, so `.where(…)` makes it partial
 * and `.concurrently()` builds it without blocking writes.
 *
 * @example
 * ```ts
 * import { tinIndex } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
 * import { pgTable, serial, text } from "drizzle-orm/pg-core";
 *
 * export const posts = pgTable(
 *   "posts",
 *   { id: serial().primaryKey(), title: text().notNull(), body: text().notNull() },
 *   (t) => [
 *     tinIndex("posts_title_tin", t.title),
 *     tinIndex("posts_body_tin", t.body, { stemmer: "en", scoreStopWords: ["the", "a"] }),
 *   ],
 * );
 * ```
 */
export const tinIndex = (
  name: string,
  column: PgColumn | SQL,
  options?: TinIndexOptions,
): IndexBuilder => {
  const builder = index(name).using("tin", column);
  const parameters = tinIndexParameters(options ?? {});
  return R.isEmptyRecord(parameters) ? builder : builder.with(parameters);
};
