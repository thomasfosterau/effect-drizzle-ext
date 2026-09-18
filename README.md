# effect-drizzle-ext

The Effect ↔ Drizzle bridge, published as two npm packages:

| Package | What it is |
| --- | --- |
| [`@thomasfosterau/effect-drizzle-ext`](packages/core/README.md) | Effect Schema → Drizzle column derivation with an extensible column-kind system, a versioned-chain interpreter, typed Postgres error classification, pagination and transaction combinators. Peers: `effect`, `drizzle-orm`. |
| [`@thomasfosterau/effect-drizzle-ext-pg`](packages/pg/README.md) | The `@effect/sql-pg` binding: `Database` / `CurrentTransaction` services over `drizzle-orm/effect-postgres`, `PgClient` layer helpers, and a sentinel-rollback test transaction runner. Peers add `@effect/sql-pg`, `pg`. |

Both extend drizzle-orm's own Effect integration (`drizzle-orm/effect-postgres`, `effect-core`) rather than replacing it, and both are built against `effect@4.0.0-rc` and `drizzle-orm@1.0.0-rc`.

**Disclaimer:** this repository and its packages have been created using Claude Code. The API is in flux; expect churn and breaking changes.

Extracted from the `thomasfosterau/website`, `thomasfosterau/gardeneria` and `thomasfosterau/preferenceflow` applications. Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Conventions: [AGENTS.md](AGENTS.md).
