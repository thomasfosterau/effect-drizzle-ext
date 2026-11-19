# effect-drizzle-ext

The Effect ↔ Drizzle bridge: derive Drizzle tables from Effect Schema annotations, version entities on append-only chains, classify Postgres errors, and run Drizzle queries as Effects over `@effect/sql-pg`. It extends drizzle-orm's own Effect integration rather than replacing it.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between releases.

## Install

```sh
pnpm add @thomasfosterau/effect-drizzle-ext @thomasfosterau/effect-drizzle-ext-pg effect drizzle-orm @effect/sql-pg
```

## Usage

```ts
import { dbColumnFor } from "@thomasfosterau/effect-drizzle-ext";
import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/derive";
import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import * as Schema from "effect/Schema";
import { relations } from "./relations.ts"; // your drizzle relations graph

const dbColumn = dbColumnFor<"text" | "integer">();
const Article = Schema.Struct({
  title: dbColumn(Schema.NonEmptyString, { column: "title", pg: "text", notNull: true }),
});

const { fromFields } = deriveColumnsWith({ text, integer });
export const articleTable = pgTable("article", fromFields(Article.fields));

export const { Database, CurrentTransaction, transact, readHandle } = makePgDatabase({
  relations,
  key: "Database",
});
```

## Packages

| Package | What it is |
| --- | --- |
| [`@thomasfosterau/effect-drizzle-ext`](packages/core/README.md) | Schema → column derivation, versioned chains, error classification, sorting, pagination and transaction combinators. Peers: `effect`, `drizzle-orm`. |
| [`@thomasfosterau/effect-drizzle-ext-pg`](packages/pg/README.md) | The `@effect/sql-pg` binding: `Database` services, test runner and provisioning, migration runner, schema guards. |
| [`@thomasfosterau/effect-drizzle-ext-kit`](packages/kit/README.md) | `effect-drizzle-kit`, a CLI companion to drizzle-kit for extensions, domains, composite types and drift checks. |

Guides are in [`docs/`](docs/); the API reference is each export's doc comment.

## Contributing

[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) · [docs/PUBLISHING.md](docs/PUBLISHING.md) · [docs/SECURITY.md](docs/SECURITY.md)

## License

[MIT](LICENSE.md)
