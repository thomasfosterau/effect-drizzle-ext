---
"@thomasfosterau/effect-drizzle-ext-kit": minor
---

New package: `effect-drizzle-kit`, a command-line companion to drizzle-kit (effect-drizzle-ext#216). `effect-drizzle-kit generate --name <slug>` writes the extensions, domains and composite types an `effect-drizzle-kit.config.ts` declares into a drizzle-kit custom migration, and `effect-drizzle-kit check` fails when they drifted from the committed migrations. When the config names its Drizzle schema module, `check` also runs the migration-drift gate. The library entry exports `defineConfig`, `loadConfig`, the `generate` / `check` Effects and the `cli` command.
