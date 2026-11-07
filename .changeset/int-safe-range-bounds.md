---
"@thomasfosterau/effect-drizzle-ext": patch
---

`numericBounds` (and the CHECK constraints derived from it) no longer reads `Schema.isInt()`'s safe-integer range as a declared bound (effect-drizzle-ext#138). Since effect 4.0.5 that check's JSON Schema carries `minimum: Number.MIN_SAFE_INTEGER` / `maximum: Number.MAX_SAFE_INTEGER`. That turned every `Schema.Int` column's `_non_negative` / `_min` / `_max` CHECK into a `BETWEEN … _range`, gave an unbounded `Schema.Int` a CHECK it never declared, and dropped the `> 0` of an `Int.check(isGreaterThan(0), isLessThanOrEqualTo(n))`. A user-declared bound still applies, including the range of `Schema.isInt32()` / `isUint32()`.
