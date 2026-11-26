---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
"@thomasfosterau/effect-drizzle-ext-kit": minor
---

Require drizzle-orm and drizzle-kit 1.0.0-rc.6. The migration-drift gate now reads drizzle-kit rc.6's version `"10"` chain snapshots (and still a lone version `"8"` full snapshot); run `drizzle-kit up` once on a migrations folder that rc.5 wrote. rc.6 no longer reads enum arrays, `vector`, `macaddr`, `regconfig` or `interval` columns as text over `@effect/sql-pg`: select them through a cast (the pg overview guide lists each one), and a `Search.regconfig` column through the new `Search.configName`.
