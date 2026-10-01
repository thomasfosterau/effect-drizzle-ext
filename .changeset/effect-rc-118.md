---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

**Breaking:** require `effect@>=4.0.0-rc.118`. Effect rc.118 moved every `effect/unstable/*` entry point to `effect/*`, so the published declarations now import `effect/sql/SqlClient`, `effect/sql/SqlError` and `effect/process/ChildProcessSpawner` and no longer resolve against rc.117 or earlier.

- the `effect` peer floor is now `>=4.0.0-rc.118` (was `>=4.0.0-rc.112`), and the `@effect/sql-pg` peer floor is `>=4.0.0-rc.118` (was `>=4.0.0-rc.115`);
- the optional `@thomasfosterau/effect-jsonapi` peer floor is `>=0.16.0`, the rc.118 build of that package;
- built and tested against `effect` / `@effect/sql-pg` / `@effect/platform-node` 4.0.0-rc.118; import paths moved from `effect/unstable/*` to `effect/*`.
- `pgClientFromUrl` and `pgClientFromPool` forward two new optional `@effect/sql-pg` options, `types` (a `PgTypes.Registry`) and `prepare`. `@effect/sql-pg` rc.113+ is binary-only and some column types (enums, `vector`, `interval`, `tsvector`, `time`, `bigint({ mode: "string" })`) need a codec under Drizzle's `effect-postgres` driver; `prepare: false` is what Cloudflare Hyperdrive needs. See the pg README's "Binary codecs and Drizzle" section.
