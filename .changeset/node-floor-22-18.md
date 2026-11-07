---
"@thomasfosterau/effect-drizzle-ext": patch
"@thomasfosterau/effect-drizzle-ext-pg": patch
---

`engines.node` is now `>=22.18`, the floor of the `@thomasfosterau/effect-ext` dependency core gained in effect-drizzle-ext#136 (pg reaches it through core). Before this, both packages declared `>=22` while depending on a package that declares `>=22.18`, so Node 22.0–22.17 installs warned (`EBADENGINE`) or, under `engine-strict`, failed inside the dependency (effect-drizzle-ext#140).
