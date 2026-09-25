---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Build against `effect` / `@effect/sql-pg` 4.0.0-rc.115. That `@effect/sql-pg` release replaced the `pg` driver with its own wire protocol and removed `PgClient.fromPool`, so:

- the `@effect/sql-pg` peer floor is now `>=4.0.0-rc.115` (the `effect` floor stays `>=4.0.0-rc.112`), and `pg` is no longer a peer;
- `pgClientFromPool` is `@effect/sql-pg`'s own lazily-connecting pool (still never connects at layer build, still shut down with the layer's scope); its `endTimeout` option is gone, and it gains `maxConnections` / `connectTimeout`;
- `pgClientFromUrl` keeps its contract — it pings at layer build — now through an explicit `SELECT 1`, since `PgClient.layer` no longer pings on its own.
