---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

`./testing`'s runner states its contract in its types:

- `runInTestTransaction` / `withTestTransaction` take a `ManagedRuntime<R | Key, SqlError>`, so a runtime that doesn't provide the `Database` key is a type error instead of a runtime failure.
- `makeTestTransaction` accepts any `DatabaseServices` (a `PgDatabase` as before, or core's `makeDatabaseServices` output).
- `testDatabaseLayer` reads only the `layer` member.

**Migration:** none for a runtime built from `testDatabaseLayer`, which already provides the key.
