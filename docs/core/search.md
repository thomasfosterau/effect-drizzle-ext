# `./Search`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

The pieces of a hybrid, multilingual search: what a searchable row stores, the indexes over it, and the **rank fragments** that each say which rows an arm matches and how well. Fusing the arms (one statement, reciprocal rank fusion) and scoping them is the application's query; `reciprocalRank` is the term it sums.

## Storing a searchable row

| Export | What it is |
| --- | --- |
| `regconfig(name)` | A text-search configuration column. Select it with `configName(column)`, which reads it as its name: over `@effect/sql-pg` the bare column comes back as an OID. |
| `configName(config)` | A `regconfig` column or expression as its name (`::text`). |
| `textArray(name)` | A `text[]` column for exact-match literals: identifiers, URLs, codes. |
| `configForLanguage(lang, { configs?, fallback? })` | The configuration for a BCP 47 tag expression: a `CASE` over its primary subtag (`en-AU` → `english`), `simple` otherwise. `SNOWBALL_CONFIGS` is the default map. |
| `weightedTsvector(config, { A?, B?, C?, D? })` | `setweight(to_tsvector(config, coalesce(text, '')), w) \|\| …` over the weights given. |
| `ftsIndexes(name, { vector, trigram? })` | GIN `${name}_fts_idx` over the vector and a `gin_trgm_ops` GIN `${name}_${column}_trgm_idx` per fuzzy column. |

Both `configForLanguage` and `weightedTsvector` with a named configuration inline their configurations as `regconfig` constants, so they are **immutable** and can sit in a generated column or a view (which take no parameters). A text-to-`regconfig` cast is not immutable, so don't wrap them in one. A generated column can't read another generated column: compute the configuration inside the vector's expression too.

```ts
const config = Search.configForLanguage(sql`lang`);
export const article = pgTable(
  "article",
  {
    lang: text("lang").notNull(),
    title: text("title"),
    body: text("body"),
    config: Search.regconfig("config").generatedAlwaysAs(config),
    search: tsvector("search").generatedAlwaysAs(
      Search.weightedTsvector(config, { A: sql`title`, C: sql`body` }),
    ),
  },
  (t) => [...Search.ftsIndexes("article", { vector: t.search, trigram: [t.title] })],
);
```

## Ranking

Each fragment returns `Option<Rank>`, `{ matches, score }` with a `double precision` score where higher is better. It is none when the arm can match nothing (a blank query, no literals, an empty embedding), so the caller skips that arm.

| Fragment | `matches` | `score` |
| --- | --- | --- |
| `fullText({ vector, config, query })` | `vector @@ websearch_to_tsquery(config, query)`. Pass the row's `regconfig` column as `config` to parse the query in each row's language. | `ts_rank_cd` |
| `trigram({ column, query, threshold? })` | `column % query` (the server's threshold, which the trigram index serves), or `similarity >= threshold` | `similarity` |
| `literal({ column, values })` | `column && ARRAY[…]::text[]` | `1` |
| `vector({ column, embedding, maxDistance? })` | rows with an embedding, or within `maxDistance` | `1 - (column <=> embedding)` (cosine, pgvector) |

`reciprocalRank(rank, { k?, weight? })` is `weight / (k + rank)` with `k = 60`, over a `row_number()` an arm's CTE computes. Sum it across arms per row to fuse them.
