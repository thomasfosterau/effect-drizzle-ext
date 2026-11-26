/**
 * Hybrid search primitives: a per-row text-search configuration column, the
 * weighted `tsvector` and its indexes, and rank fragments (full text,
 * trigram, literal, vector) that each say which rows match and how well. See
 * the [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/search.md).
 *
 * @module Search
 */

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  customType,
  index,
  type ExtraConfigColumn,
  type IndexBuilder,
  type PgCustomColumnBuilder,
} from "drizzle-orm/pg-core";
import type { ConvertCustomConfig } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Str from "effect/String";

/**
 * A `regconfig` column: a text-search configuration (`'english'`). Read it
 * with {@link configName}: over a binary-protocol driver such as
 * `@effect/sql-pg`, selecting the column itself returns the configuration's
 * OID, which no codec can turn back into its name.
 */
export const regconfig = (
  name: string,
): PgCustomColumnBuilder<ConvertCustomConfig<{ data: string; driverData: string }>> =>
  customType<{ data: string; driverData: string }>({
    dataType: () => "regconfig",
    codec: "regconfig",
  })(name);

/**
 * A `regconfig` column (or expression) selected as its configuration's name.
 *
 * @example
 * ```ts
 * import { configName, regconfig } from "@thomasfosterau/effect-drizzle-ext/Search";
 * import { PgDialect, pgTable } from "drizzle-orm/pg-core";
 *
 * const doc = pgTable("doc", { config: regconfig("config") });
 * const { sql } = new PgDialect().sqlToQuery(configName(doc.config));
 * console.log(sql); // "doc"."config"::text
 * ```
 */
export const configName = (config: SQLWrapper): SQL<string> => sql<string>`${config}::text`;

/** A `text[]` column, for exact-match literals (identifiers, URLs, codes). */
export const textArray = (
  name: string,
): PgCustomColumnBuilder<
  ConvertCustomConfig<{ data: ReadonlyArray<string>; driverData: ReadonlyArray<string> }>
> =>
  customType<{ data: ReadonlyArray<string>; driverData: ReadonlyArray<string> }>({
    dataType: () => "text[]",
  })(name);

/** A text-search configuration: its name, or an expression (a `regconfig` column). */
export type Config = string | SQLWrapper;

const SAFE_NAME = /^[a-z0-9_]+$/;

const identifier = (name: string, where: string): string => {
  if (!SAFE_NAME.test(name)) {
    throw new TypeError(`${where}: "${name}" is not an identifier`);
  }
  return name;
};

/**
 * A configuration as SQL: a name inlined as a `regconfig` constant (so it can
 * sit in a generated column or a view, which take no parameters), an
 * expression as itself.
 */
const configSql = (config: Config): SQL =>
  P.isString(config) ? sql.raw(`'${identifier(config, "Search")}'::regconfig`) : sql`${config}`;

/**
 * The snowball configurations PostgreSQL has shipped in `pg_catalog` since
 * 8.3, by BCP 47 primary language subtag. Later ones are left out: a name a
 * server lacks fails at query time, inside a view.
 */
export const SNOWBALL_CONFIGS: ReadonlyArray<readonly [subtag: string, config: string]> = [
  ["da", "danish"],
  ["de", "german"],
  ["en", "english"],
  ["es", "spanish"],
  ["fi", "finnish"],
  ["fr", "french"],
  ["hu", "hungarian"],
  ["it", "italian"],
  ["nb", "norwegian"],
  ["nl", "dutch"],
  ["nn", "norwegian"],
  ["no", "norwegian"],
  ["pt", "portuguese"],
  ["ro", "romanian"],
  ["ru", "russian"],
  ["sv", "swedish"],
  ["tr", "turkish"],
];

/**
 * The configuration for a BCP 47 language tag expression: a `CASE` over its
 * primary subtag (`en-AU` → `english`), `fallback` (`simple`: no stemming,
 * never a wrong language's) for any other. Each arm is a `regconfig`
 * constant, so the expression is immutable and can sit in a generated column
 * or a view. Subtags and names must be lowercase identifiers (they are
 * inlined); anything else throws.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { configForLanguage } from "@thomasfosterau/effect-drizzle-ext/Search";
 * import { sql } from "drizzle-orm";
 * import { PgDialect } from "drizzle-orm/pg-core";
 *
 * const config = configForLanguage(sql`lang`, { configs: [["en", "english"]] });
 * strictEqual(
 *   new PgDialect().sqlToQuery(config).sql,
 *   "(CASE lower(split_part(lang, '-', 1)) WHEN 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END)",
 * );
 * ```
 */
export const configForLanguage = (
  language: SQLWrapper,
  options: {
    readonly configs?: ReadonlyArray<readonly [subtag: string, config: string]>;
    readonly fallback?: string;
  } = {},
): SQL => {
  const configs = options.configs ?? SNOWBALL_CONFIGS;
  const fallback = options.fallback ?? "simple";
  const branches = Arr.map(configs, ([subtag, config]) =>
    sql.raw(
      `WHEN '${identifier(subtag, "configForLanguage")}' THEN '${identifier(config, "configForLanguage")}'::regconfig`,
    ),
  );
  return sql`(CASE lower(split_part(${language}, '-', 1)) ${sql.join(branches, sql` `)} ${sql.raw(`ELSE '${identifier(fallback, "configForLanguage")}'::regconfig`)} END)`;
};

/** The four `setweight` classes, most important first. */
export type Weight = "A" | "B" | "C" | "D";

/**
 * `setweight(to_tsvector(config, coalesce(text, '')), weight) || …` over the
 * weights given, in `A`–`D` order: the expression a generated `tsvector`
 * column or a search view stores. A missing weight contributes nothing.
 */
export const weightedTsvector = (
  config: Config,
  parts: { readonly [W in Weight]?: SQLWrapper },
): SQL => {
  const present = Arr.flatMap(["A", "B", "C", "D"] as const, (weight) => {
    const text = parts[weight];
    return text === undefined ? [] : [[weight, text] as const];
  });
  const vectors = Arr.map(
    present,
    ([weight, text]) =>
      sql`setweight(to_tsvector(${configSql(config)}, coalesce(${text}, '')), ${sql.raw(`'${weight}'`)})`,
  );
  return Arr.match(vectors, {
    onEmpty: () => sql`''::tsvector`,
    onNonEmpty: (nonEmpty) => sql`(${sql.join(nonEmpty, sql` || `)})`,
  });
};

/**
 * The full-text indexes for a table: GIN over its `tsvector` column,
 * `${name}_fts_idx`, and a trigram GIN per fuzzy-matched text column,
 * `${name}_${column}_trgm_idx` (`pg_trgm`'s `gin_trgm_ops`). Returns what a
 * table's extra-config callback spreads.
 */
export const ftsIndexes = (
  name: string,
  config: {
    readonly vector: ExtraConfigColumn;
    readonly trigram?: ReadonlyArray<ExtraConfigColumn>;
  },
): ReadonlyArray<IndexBuilder> => [
  index(`${name}_fts_idx`).using("gin", config.vector),
  ...Arr.map(config.trigram ?? [], (column) =>
    index(`${name}_${column.name}_trgm_idx`).using("gin", sql`${column} gin_trgm_ops`),
  ),
];

/**
 * How one search arm ranks a row: `matches`, the condition every hit
 * satisfies, and `score`, a `double precision`, higher is better.
 */
export interface Rank {
  readonly matches: SQL;
  readonly score: SQL;
}

const blank = (query: string): boolean => Str.isEmpty(Str.trim(query));

/**
 * Full text: `vector @@ websearch_to_tsquery(config, query)`, scored by
 * `ts_rank_cd`. `config` may be a row's own `regconfig` column, so each row's
 * query is parsed in its own language. None for a blank query.
 */
export const fullText = (options: {
  readonly vector: SQLWrapper;
  readonly config: Config;
  readonly query: string;
}): Option.Option<Rank> => {
  if (blank(options.query)) return Option.none();
  const tsquery = sql`websearch_to_tsquery(${configSql(options.config)}, ${options.query})`;
  return Option.some({
    matches: sql`(${options.vector}) @@ ${tsquery}`,
    score: sql`ts_rank_cd(${options.vector}, ${tsquery})::float8`,
  });
};

/**
 * Trigram similarity (`pg_trgm`), scored by `similarity(column, query)`.
 * Matches `column % query` (the server's `pg_trgm.similarity_threshold`, which
 * a `gin_trgm_ops` index serves), or `similarity >= threshold` when one is
 * given (checked per row). None for a blank query.
 */
export const trigram = (options: {
  readonly column: SQLWrapper;
  readonly query: string;
  readonly threshold?: number;
}): Option.Option<Rank> => {
  if (blank(options.query)) return Option.none();
  const score = sql`similarity(${options.column}, ${options.query})::float8`;
  return Option.some({
    matches:
      options.threshold === undefined
        ? sql`(${options.column}) % ${options.query}`
        : sql`${score} >= ${options.threshold}`,
    score,
  });
};

/**
 * Exact literals: the row's `text[]` overlaps `values` (`&&`), scored `1`.
 * None for no values.
 */
export const literal = (options: {
  readonly column: SQLWrapper;
  readonly values: ReadonlyArray<string>;
}): Option.Option<Rank> =>
  Arr.match(options.values, {
    onEmpty: () => Option.none(),
    onNonEmpty: (values) =>
      Option.some({
        matches: sql`(${options.column}) && ARRAY[${sql.join(
          Arr.map(values, (value) => sql`${value}`),
          sql`, `,
        )}]::text[]`,
        score: sql`1::float8`,
      }),
  });

/**
 * Vector similarity (`pgvector`): cosine distance `column <=> embedding`,
 * scored `1 - distance`; matches every row with an embedding, or those
 * within `maxDistance`. None for an empty embedding.
 */
export const vector = (options: {
  readonly column: SQLWrapper;
  readonly embedding: ReadonlyArray<number>;
  readonly maxDistance?: number;
}): Option.Option<Rank> => {
  if (Arr.isReadonlyArrayEmpty(options.embedding)) return Option.none();
  const distance = sql`((${options.column}) <=> ${`[${options.embedding.join(",")}]`}::vector)`;
  return Option.some({
    matches:
      options.maxDistance === undefined
        ? sql`(${options.column}) IS NOT NULL`
        : sql`${distance} <= ${options.maxDistance}`,
    score: sql`(1 - ${distance})::float8`,
  });
};

/**
 * Reciprocal rank fusion's term for one arm, `weight / (k + rank)`, over a
 * `rank` expression (a `row_number() OVER (ORDER BY score DESC)`); `k`
 * defaults to `60`. Sum the terms of a row's arms, `coalesce`d to `0` where
 * an arm missed it, to fuse them.
 */
export const reciprocalRank = (
  rank: SQLWrapper,
  options: { readonly k?: number; readonly weight?: number } = {},
): SQL => sql`(${options.weight ?? 1}::float8 / (${options.k ?? 60} + ${rank}))`;
