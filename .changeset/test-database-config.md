---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

`provisionTestDatabase` and `resolveDatabaseSource` read `DATABASE_URL_TEST`, `DATABASE_URL` and the `PG*` variables through Effect `Config` (the new `TestDatabaseConfig`), so the URLs and `PGPASSWORD` are `Redacted` from the moment they are read and a malformed `PGPORT` fails with a typed `ConfigError`. Settings come from the current `ConfigProvider`, which defaults to `process.env`.

Upgrading: drop `env: process.env` from a Vitest global setup; a test that passed an `env` record provides `ConfigProvider.fromEnvRecord({ … })` instead. The `env` option still works but is deprecated and will be removed in the next release. `connectionUrl` now takes a `TestServer` (from `TestDatabaseConfig`) rather than an environment record, both functions' error channels gain `ConfigError`, and `ResolutionEnvironment` is deprecated.
