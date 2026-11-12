# `@thomasfosterau/effect-drizzle-ext-pg`

The `@effect/sql-pg` binding for `@thomasfosterau/effect-drizzle-ext`: `Database` / `CurrentTransaction` services over `drizzle-orm/effect-postgres`, `PgClient` layers, the version-chain discipline over a tree's tables (`./chain`), a sentinel-rollback test runner with test-database provisioning, a fresh-database migration runner, and migration-drift / view-dependency guards.

[![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-drizzle-ext-pg.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-drizzle-ext-pg)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add @thomasfosterau/effect-drizzle-ext-pg @thomasfosterau/effect-drizzle-ext effect drizzle-orm @effect/sql-pg
# optional: ./tooling's schema guards, ./testing's container fallback
pnpm add --save-dev drizzle-kit @testcontainers/postgresql
```

`effect` (`^4.0.0`), `drizzle-orm` (`>=1.0.0-rc.5`) and `@effect/sql-pg` (`^4.0.0`) are peer dependencies. The client constructors below are written against `@effect/sql-pg`'s own wire protocol, and `pg` is no longer a peer. `drizzle-kit` (`>=1.0.0-rc.5`, for `./tooling`) and `@testcontainers/postgresql` (`>=12`, for `./testing`'s container fallback) are **optional** peers. `@thomasfosterau/effect-drizzle-ext` is a regular dependency, not a peer — it supplies the driver-agnostic `makeDatabaseServices` factory this package specialises. Node.js 22.18 or newer is required (the floor of the `@thomasfosterau/effect-ext` dependency).

## Example

```ts
import { makePgDatabase, pgClientFromPool } from "@thomasfosterau/effect-drizzle-ext-pg";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { relations } from "./relations.ts"; // this application's drizzle relations graph

const database = makePgDatabase({ relations, key: "Database" });
export const { Database, CurrentTransaction, transact, readHandle } = database;

// Wire the client: a pool that lives and dies with the runtime that built it.
const DatabaseLive = database.layer.pipe(
  Layer.provide(pgClientFromPool({ connectionString: Redacted.make(process.env.DATABASE_URL!) })),
);
```

The [overview](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/overview.md) walks through running effects, transactions and testing against it.

## Entries

| Subpath | Contents | Guide |
| --- | --- | --- |
| `.` | The `makePgDatabase` services and the `PgClient` layers (`pgClientFromUrl`, `pgClientFromPool`). | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/overview.md) |
| `./chain` | The version-chain discipline over a tree's tables: `makeVersionChain`, append-only writes, the pulpit errors. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/chain.md) |
| `./migrations` | The fresh-database migration runner, `applyMigrations`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/migrations.md) |
| `./testing` | The sentinel-rollback test runner, test-database provisioning and the connect-seam retry. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/testing.md) |
| `./tooling` | The migration-drift and view-dependency schema guards (optional peer `drizzle-kit`). | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/tooling.md) |

## Links

- [How it fits together](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/overview.md): the services, the binary-codec caveat and the limitations; [errors against a live database](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/errors.md).
- The guides in the table above, one per entry. The API reference is each export's doc comment.
- The [core package](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/core/README.md), and the [changelog](CHANGELOG.md).

## License

MIT © Thomas Foster. Repository: [github.com/thomasfosterau/effect-drizzle-ext](https://github.com/thomasfosterau/effect-drizzle-ext), package directory `packages/pg`. Extracted from the `thomasfosterau/website`, `thomasfosterau/gardeneria` and `thomasfosterau/preferenceflow` applications. See [`@thomasfosterau/effect-drizzle-ext`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/core/README.md) for the driver-agnostic half.
