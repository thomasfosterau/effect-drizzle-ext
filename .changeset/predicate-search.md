---
"@thomasfosterau/effect-drizzle-ext": minor
---

Add `./Predicate`, a neutral row predicate with an in-memory `evaluate`, and `./Where`, which renders one as a fail-closed `WHERE` over a view's columns (three-valued logic, strings by code point). `./jsonapi` gains `predicateFromFilter`, which compiles a JSON:API `Filter.Ast` to it. Add `./Search`, the hybrid search primitives: `regconfig` and `textArray` columns, `configForLanguage`, `weightedTsvector`, `ftsIndexes`, and the `fullText`, `trigram`, `literal` and `vector` rank fragments with `reciprocalRank`. `makeCurrentVersionView` now throws `DerivationError` when `columns` and `merge` share a key, instead of silently keeping the merged column.
