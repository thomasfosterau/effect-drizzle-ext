# effect-drizzle-ext

The Effect ↔ Drizzle bridge, published as two npm packages:

| Package | What it is |
| --- | --- |
| [`@thomasfosterau/effect-drizzle-ext`](packages/core/README.md) | Effect Schema → Drizzle column derivation with an extensible column-kind system, a versioned-chain interpreter, typed Postgres error classification, pagination and transaction combinators. Peers: `effect`, `drizzle-orm`. |
| [`@thomasfosterau/effect-drizzle-ext-pg`](packages/pg/README.md) | The `@effect/sql-pg` binding: `Database` / `CurrentTransaction` services over `drizzle-orm/effect-postgres`, `PgClient` layer helpers, a sentinel-rollback test transaction runner and test-database provisioning, a fresh-database migration runner, and the migration-drift / view-dependency schema guards. Peers add `@effect/sql-pg`; `drizzle-kit` and `@testcontainers/postgresql` are optional. |

Both extend drizzle-orm's own Effect integration (`drizzle-orm/effect-postgres`, `effect-core`) rather than replacing it, and both are built against `effect@4.0.0-rc` and `drizzle-orm@1.0.0-rc`.

**Disclaimer:** this repository and its packages have been created using Claude Code. The API is in flux; expect churn and breaking changes.

## Install

```sh
pnpm add @thomasfosterau/effect-drizzle-ext @thomasfosterau/effect-drizzle-ext-pg effect drizzle-orm @effect/sql-pg
```

The core package alone (`effect`, `drizzle-orm` peers) covers derivation, errors, sorting and the driver-agnostic services; add the pg package for the `@effect/sql-pg` binding. Each package README lists its optional peers.

## Quick start

```ts
import { dbColumnFor } from "@thomasfosterau/effect-drizzle-ext";
import { makeDeriveColumns } from "@thomasfosterau/effect-drizzle-ext/derive";
import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import * as Schema from "effect/Schema";
import { relations } from "./relations.ts"; // your application's drizzle relations graph

// Pin a column-kind union once, and annotate a model field with its column.
export const dbColumn = dbColumnFor<"text" | "integer">();
const Article = Schema.Struct({
  title: dbColumn(Schema.NonEmptyString, { column: "title", pg: "text", notNull: true }),
});

// A builder registry turns the annotations into Drizzle columns.
const { fromFields } = makeDeriveColumns({ text, integer });
export const articleTable = pgTable("article", fromFields(Article.fields));

// One `@effect/sql-pg` binding call gives the app its services.
const database = makePgDatabase({ relations, key: "Database" });
export const { Database, CurrentTransaction, transact, readHandle } = database;
```

`transact` opens the write boundary (always a fresh transaction or SAVEPOINT, never a silent join); `readHandle` reads through whichever is already open.

## Documentation

[`packages/core/README.md`](packages/core/README.md) and [`packages/pg/README.md`](packages/pg/README.md) are the two packages' API references. Extracted from the `thomasfosterau/website`, `thomasfosterau/gardeneria` and `thomasfosterau/preferenceflow` applications.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md); agent conventions are in [AGENTS.md](AGENTS.md). Releases: [PUBLISHING.md](PUBLISHING.md). Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

MIT © Thomas Foster. See [LICENSE](LICENSE).
