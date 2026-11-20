---
"@thomasfosterau/effect-drizzle-ext-pg": minor
"@thomasfosterau/effect-drizzle-ext-kit": minor
---

The extras generator takes rename hints and a record-only mode. `generateExtrasMigration({ renames })` (and `planExtras`'s third argument) turns a renamed domain, composite type or attribute into `ALTER … RENAME` instead of a drop plus a create; `recordOnly: true` writes the declared state into a custom migration whose SQL you write by hand, for a change the generator refuses. `effect-drizzle-kit generate` gains `--rename` and `--record-only`.
