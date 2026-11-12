---
"@thomasfosterau/effect-drizzle-ext-pg": patch
---

`./tooling` exports `SchemaModule`, the schema-module type drizzle-kit's `generateDrizzleJson` takes. `MigrationDriftOptions.schema` and `checkViewDependencies`' `schema` are now typed with it, which is the same `Record<string, unknown>` as before.
