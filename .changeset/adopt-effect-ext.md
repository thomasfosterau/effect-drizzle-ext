---
"@thomasfosterau/effect-drizzle-ext": patch
---

Depend on `@thomasfosterau/effect-ext` for the pure Schema helpers instead of keeping local copies (effect-drizzle-ext#135). `resourceAttributeProjections` (`./jsonapi`) reads each attribute's `optional` / `nullable` / `array` / `date` traits with effect-ext's `Ast` predicates, the same JSON-codec decode probes as before, and the version table's `action` values are a `LiteralExact.tuple` checked against `VersionAction`. No behaviour or type changes. `@thomasfosterau/effect-ext` (`^0.1.0`) is a regular dependency; its one required peer, `effect ^4.0.0`, is already a peer of this package.
