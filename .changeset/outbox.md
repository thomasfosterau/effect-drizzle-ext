---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Add `./Outbox`, a transactional outbox: `outboxColumns()` and `outboxConstraints(name)` build the table in your own schema, and `makeOutbox({ table, CurrentTransaction })` returns `append` (inside the caller's transaction), `drain` (one drain per table at a time, in `seq` order, at least once) and `pending`.
