---
"@thomasfosterau/effect-drizzle-ext-pg": patch
---

`DatabaseSourceOptions.probe`, `ProvisionOptions.applyMigrations` (`./testing`) and `MigrationDriftOptions.base` (`./tooling`) are now spelled `?: T | undefined`, so a caller under `exactOptionalPropertyTypes` can forward its own optional value; an explicit `undefined` behaves as an absent key.
