---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

`./tooling` gains migrations for the Postgres objects drizzle-kit doesn't manage: extensions, domains and composite types (effect-drizzle-ext#212). Declare them with `extension`, `domain` and `compositeType`. `generateExtrasMigration` diffs the declarations against the state recorded in the migrations directory, then writes the SQL into a `drizzle-kit generate --custom` migration, with an `extras.json` recording the new state beside it. `checkExtrasDrift` fails when a declaration changed without a migration. The pure `planExtras` is exported for a caller composing its own report.
