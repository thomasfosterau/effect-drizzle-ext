---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

`./chain`'s `LeafChain` exposes `head(id)`: the node's head entry (`version`, `action`, `timestamp`), or `Option.none()` for an id with no versions of this leaf. A caller can read it to pin a write's `expectedVersion` (effect-drizzle-ext#153).
