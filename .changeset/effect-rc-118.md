---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Built against `effect` / `@effect/sql-pg` / `@effect/platform-node` 4.0.0-rc.118, which serves every former `effect/unstable/*` entry point from `effect/*`; the published declarations import `effect/sql/SqlClient`, `effect/sql/SqlError` and `effect/process/ChildProcessSpawner`.

- Peer floors: `effect` `>=4.0.0-rc.118`, `@effect/sql-pg` `>=4.0.0-rc.118`, and the optional `@thomasfosterau/effect-jsonapi` `>=0.16.0` (its rc.118 build).
- `pgClientFromUrl` and `pgClientFromPool` forward two optional `@effect/sql-pg` options, `types` (a `PgTypes.Registry`) and `prepare`. `@effect/sql-pg` rc.113+ is binary-only and some column types (enums, `vector`, `interval`, `tsvector`, `time`, `bigint({ mode: "string" })`) need a codec under Drizzle's `effect-postgres` driver; `prepare: false` is what Cloudflare Hyperdrive needs. See the pg README's "Binary codecs and Drizzle" section.
