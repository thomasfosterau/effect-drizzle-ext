---
"@thomasfosterau/effect-drizzle-ext": patch
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

`makePgDatabase` returns `locate`, which resolves the table and columns a Postgres error names to the Drizzle table and columns the database's `relations` declare: `Option.some({ key, table, columns })`, a union discriminated by the relations key (`PgErrorLocation`, `PgErrorTableLocation`, `ColumnOf`). A constraint is matched by its explicit name or the default drizzle-kit or Postgres gives an unnamed one, with a unique violation's `DETAIL` key as the fallback. Core's `findPgError` now searches 12 levels deep (was 8), so it reaches the driver error behind a classified error inside an `Exit`'s `Cause`.
