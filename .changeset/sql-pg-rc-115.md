---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

The client layers run on `@effect/sql-pg`'s own wire protocol (rc.115 and later), not the `pg` driver, so `pg` is not a peer:

- `pgClientFromPool` is `@effect/sql-pg`'s own lazily-connecting pool: it never connects at layer build, is shut down with the layer's scope, and takes `maxConnections` / `connectTimeout`;
- `pgClientFromUrl` pings at layer build, through an explicit `SELECT 1`.
