---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

A new `./tin` entry: typed Drizzle helpers for PlanetScale's TIN full-text search extension, to use beside `eq` and `ilike`. `matches` and `matchesAny` build the `==>` operator, `score`, `fullScore` and `maxScore` the BM25 functions (named, typed arguments; the ctid qualified with the table or its alias), `highlight` and `highlightAnsi` the highlighters, and `tinIndex` a `USING tin` index with its `WITH` options typed and rendered for drizzle-kit. `phrase` quotes user input as a TINQL phrase so its operators and quotes are searched as words.
