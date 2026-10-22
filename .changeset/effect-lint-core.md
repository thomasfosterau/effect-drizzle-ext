---
"@thomasfosterau/effect-drizzle-ext": patch
---

Internal refactor to the idiomatic Effect shapes `@mpsuesser/oxlint-plugin-effect` asks for, with no behaviour change. The emitted declarations change compatibly: `readDbTable` is generic over its target, and the inline return types of `makeDeriveColumns`, `timestamps()` and `versionTimestamps` are now the named, documented interfaces `DeriveColumns`, `TimestampColumns` and `VersionTimestamps` (same shapes).
