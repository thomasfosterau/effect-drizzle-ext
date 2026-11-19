# `./tin`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

Typed Drizzle helpers for [TIN](https://planetscale.com/docs/postgres/search), PlanetScale's full-text search extension for Postgres. TIN adds a `tin` index method, the `==>` match operator over its TINQL query language, BM25 scoring and highlighting. These helpers sit beside Drizzle's own `eq` and `ilike`: each builds an `SQL` fragment, and none of them opens a connection, runs an Effect or adds a dependency.

| Helper | SQL |
| --- | --- |
| `matches(column, query)` | `column ==> query` |
| `matchesAny(column, queries)` | `column ==> ANY (ARRAY[…])` |
| `score(table, options?)` | `tin.score(table.ctid, dense_ratio => …, k1 => …, b => …, term_add / term_replace => …)` |
| `fullScore(table, options?)` | `tin.full_score(table.ctid, k1 => …, b => …)` |
| `maxScore(table)` | `tin.max_score(table.ctid)` |
| `highlight(column, options?)` | `tin.highlight(column, begin_tag => …, end_tag => …, query => …)` |
| `highlightAnsi(column, options?)` | `tin.highlight_ansi(column, wrap_to => …, query => …)` |
| `tinIndex(name, column, options?)` | `CREATE INDEX name ON table USING tin (column) WITH (…)` |
| `phrase(input)` | A TINQL phrase quoting user input, `None` when blank |

## Setup

Declare the extension with `./tooling`'s extras so a fresh database gets it, and index each column you search. TIN indexes one column or expression per index, so cross-column search takes one index per column.

```ts
import { tinIndex } from "@thomasfosterau/effect-drizzle-ext-pg/tin";
import { extension } from "@thomasfosterau/effect-drizzle-ext-pg/tooling";
import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const tin = extension("tin");

export const posts = pgTable(
  "posts",
  { id: serial().primaryKey(), title: text().notNull(), body: text().notNull() },
  (t) => [
    tinIndex("posts_title_tin", t.title),
    tinIndex("posts_body_tin", t.body, { stemmer: "en" }),
  ],
);
```

`tinIndex` returns Drizzle's own `IndexBuilder`, so `.where(…)` makes a partial index and `.concurrently()` builds one without blocking writes. drizzle-kit writes the options as `WITH (stemmer=en, …)`, the form Postgres records. A tokenization option changed on a populated index needs a `REINDEX`, which drizzle-kit doesn't issue: add it to the migration by hand. The scoring options (`k1`, `b`, `scoreStopWords`) apply from the next query.

## Querying

```ts
const relevance = score(posts);

db.select({
  id: posts.id,
  relevance,
  snippet: highlight(posts.body, { begin: "<mark>", end: "</mark>" }),
})
  .from(posts)
  .where(matches(posts.body, "apple OR grape"))
  .orderBy(desc(relevance))
  .limit(10);
```

- **The query is a bound parameter**, never SQL text. It is still TINQL, though: uppercase `AND`, `OR`, `NEAR/5` and friends in it are operators, and an unbalanced `"`, `(` or `[` is a parse error when the query runs. Pass raw user input through `phrase`, which quotes it and escapes `"`, `\`, `_`, `[` and `]`, so it is searched as words.
- **Scores need a TIN index scan.** `score`, `fullScore` and `maxScore` raise "requires a tin index scan" when the query doesn't scan the table through a TIN index (a `RETURNING` clause, or a filter Postgres plans another way). The ctid is qualified with the table you pass, or its `alias(…)`, so a join scores the right relation. Every `score` in one query must agree on `denseRatio`, `termAdd` and `termReplace`, and `score` and `fullScore` can't share a relation.
- **Scores compare within one query only.** `score / maxScore` gives a relevance in `[0, 1]`. On a partitioned table each partition scores on its own statistics.
- **`highlight` doesn't escape the text.** Escape the result, or render it as text, before it reaches a page, unless the column holds trusted markup.

Every failure here is Postgres's, at query time, so it travels in the Effect error channel as a `SqlError` like any other.

## Testing

TIN isn't in the `pgvector/pgvector` image the integration suite runs against, so this package checks the SQL each helper renders and the DDL drizzle-kit generates, not results against a live TIN. PlanetScale's [Lead](https://github.com/planetscale/lead) installs as `tin` for local and CI databases; it scans rather than indexes, so use it to check queries, not for performance.
