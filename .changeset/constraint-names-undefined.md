---
"@thomasfosterau/effect-drizzle-ext": patch
---

`SubtypeTablesConfig.constraintNames.pk` and `.parentFk` (`./versioned-chain`) are now spelled `?: string | undefined`, so a caller under `exactOptionalPropertyTypes` can forward its own optional value; an explicit `undefined` keeps the default constraint name, as an absent key does.
