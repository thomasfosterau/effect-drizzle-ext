---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Version-chain times are `DateTime.Utc` instead of `Date` (effect-drizzle-ext#249). Drizzle's `Date` is converted at the row decoders; the SQL (column types, view definitions) is unchanged, so no migration is generated.

- `VersionChainEntry.timestamp` (and so `VersionSnapshot` and pg's `ChainSnapshot`) is a `DateTime.Utc`: `head`, `load`, `getVersion` and `history` return one.
- `versionTimestamps(row)` still reads a Drizzle row's `Date`s, and returns `{ createdAt, updatedAt }` as `DateTime.Utc`.
- `AsOfPoint`'s `at` and `setPointer`'s `at` take a `DateTime.Utc`. A `Date` is still accepted for this release and will be dropped in the next minor.

**Upgrading.** Code that reads a chain time as a `Date` converts once: `DateTime.toDateUtc(entry.timestamp)` for a `Date`, `DateTime.formatIso(entry.timestamp)` for an ISO string, and `DateTime.Order` / `DateTime.Equivalence` in place of `getTime()` comparisons. Code that already held a `DateTime.Utc` drops its `DateTime.fromDateUnsafe` / `DateTime.toDateUtc` at the call site. Pass `asOf(leaf, { at })` and `setPointer({ at })` a `DateTime.Utc` now, before the `Date` overload goes.
