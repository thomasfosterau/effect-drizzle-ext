---
"@thomasfosterau/effect-drizzle-ext-pg": minor
"@thomasfosterau/effect-drizzle-ext-kit": minor
---

The extras generator migrates functions (`fn`) and triggers (`trigger`), and splits its output into two custom migrations around drizzle-kit's own: extensions, domains and composite types (and dropped triggers and functions) before it, functions and triggers (and dropped types, domains and extensions) after it. `generateMigrations` runs the whole sequence, including `drizzle-kit generate`; `generateExtrasMigration` now takes a `phase`, and `ExtrasPlan` has `before` and `after` in place of `statements`. `extras.json` is version 2; version 1 files still read. Rename hints and `recordOnly` apply to the before migration. `effect-drizzle-kit generate` now runs instead of `drizzle-kit generate`, and its `--name` is drizzle-kit's slug.
