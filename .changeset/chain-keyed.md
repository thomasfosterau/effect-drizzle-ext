---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

`./chain` writes and reads a keyed leaf's keyed level, such as a localised leaf's locales (effect-drizzle-ext#149). `create` takes `keyed`, the whole level at version 0. `update` / `restore` take `keyed`, a per-key tri-state patch: a patch updates that key (starting from none for a new key), `null` drops it, and an absent key carries it forward. Every write appends one version of the whole node. `delete` carries every key through the tombstone, and `restoreVersion` restores them with the shared columns. `getVersion` returns them as `keyed`, keyed by key, with `{}` for a version that carries none. This matches pulpit's `LocaleStates` / `LocalePatch`. `ChainTables` now requires `keyed`, which every `makeTreeTables` result has.

It also exposes `head(id)`, the node's head entry (`version`, `action`, `timestamp`) or `Option.none()` for an id with no versions of the leaf, so a caller can pin a write's `expectedVersion` (effect-drizzle-ext#153).
