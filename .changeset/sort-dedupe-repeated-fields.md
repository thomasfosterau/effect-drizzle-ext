---
"@thomasfosterau/effect-drizzle-ext": patch
---

`resolveSortOrder` (`./sort`) keeps only the first occurrence of a field repeated in the caller's sort, and the closing `id` tiebreak follows the de-duplicated list (effect-drizzle-ext#190). `[name asc, name desc]` now resolves to `name asc, id asc`, the same order as `[name asc]`, instead of `name asc, name desc, id desc`. `resourceAttributeProjections`' doc comment now says `column` is an `Option` by design.
