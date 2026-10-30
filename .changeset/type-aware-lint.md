---
"@thomasfosterau/effect-drizzle-ext": patch
---

Type-aware lint cleanup: the optional last parameters of `DiscriminatorToolkit.typeParentFk` and `DiscriminatorToolkit.typeConstraints` drop a redundant `| undefined` (an optional parameter already admits `undefined`, so the emitted declarations are equivalent).
