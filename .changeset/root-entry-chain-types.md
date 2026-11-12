---
"@thomasfosterau/effect-drizzle-ext": minor
---

The root entry (`@thomasfosterau/effect-drizzle-ext`) now exports the version-chain read shapes `VersionAction`, `VersionChainEntry` and `VersionSnapshot`, so a client-bundled package can name them without pulling `drizzle-orm` into its module graph (effect-drizzle-ext#191). They are the same types `./versioned-chain` exports, and that import path keeps working: nothing needs migrating. `VersionSnapshot["columns"]` is spelled without Drizzle, as the decoded type of `Schema.Record(Schema.String, Schema.Unknown)`: exactly the type `Readonly<InferSelectModel<PgTable>>` resolved to (and `Readonly<Record<string, unknown>>`), so no caller changes.
