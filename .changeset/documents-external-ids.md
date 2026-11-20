---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Add `./Documents`, a content-addressed document store keyed by Postgres's own digest of the canonical `jsonb` (`documentColumns`, `makeDocumentStore` with `put`, `get` and `getMany`), and `./ExternalIds`, a node's ids at outside authorities (`makeExternalIdTable`, `makeExternalIdStore` with `lookup`, `linksOf` and `link`).
