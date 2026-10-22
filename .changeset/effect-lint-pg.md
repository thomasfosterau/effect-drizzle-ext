---
"@thomasfosterau/effect-drizzle-ext-pg": patch
---

Internal refactor to the idiomatic Effect shapes `@mpsuesser/oxlint-plugin-effect` asks for. No exported signature changes. `runInTestTransaction`'s own failures ("outer transaction failed", "inner Exit was never captured", "unexpected outer failure") now reject with a tagged `TestTransactionError` (still an `Error`, same message) instead of a plain `Error`. The `./tooling` doc examples name `origin/trunk` as the base ref.
