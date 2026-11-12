# `@thomasfosterau/effect-drizzle-ext`

The Effect ↔ Drizzle bridge: Effect Schema → Drizzle column derivation with an extensible column-kind system, a versioned-chain interpreter, typed Postgres error classification, pagination and transaction combinators.

[![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-drizzle-ext.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-drizzle-ext)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add @thomasfosterau/effect-drizzle-ext effect drizzle-orm
```

`effect` (`^4.0.0`) and `drizzle-orm` (`>=1.0.0-rc.5`) are peer dependencies. `@thomasfosterau/effect-jsonapi` (`>=0.16.0`) is an **optional** peer, needed only by the `./jsonapi` and `./jsonapi/derive` subpaths — a plain `Schema.Struct` consumer never installs it. Node.js 22.18 or newer is required (the floor of the `@thomasfosterau/effect-ext` dependency).

## Example

```ts
import { dbColumn } from "@thomasfosterau/effect-drizzle-ext";
import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/derive";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import * as Schema from "effect/Schema";

// One declaration: the model field, annotated with the column it backs.
const Article = Schema.Struct({
  title: dbColumn(Schema.NonEmptyString, { column: "title", pg: "text", notNull: true }),
  views: dbColumn(Schema.Finite, { column: "views", pg: "integer", notNull: true, default: 0 }),
});

// A builder registry turns the annotations into Drizzle columns.
const { fromFields } = deriveColumnsWith({
  text: (c: string) => text(c),
  integer: (c: string) => integer(c),
});
export const article = pgTable("article", fromFields(Article.fields));
```

The [overview](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/overview.md) walks through the full setup: pinned kind unions, FK references and the CHECKs derived from bounds.

## Entries

| Subpath | Drizzle? | Contents | Guide |
| --- | --- | --- | --- |
| `.` | no | The `dbColumn` / `dbTable` annotation vocabulary, phantoms, `Option` readers, numeric bounds, struct-field projection, and `defineTree`, the Drizzle-free ontology declaration. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/annotations.md) |
| `./derive` | yes | The builder registry, `deriveColumnsWith`, CHECK derivation from bounds, `DerivationError`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/derive.md) |
| `./references` | yes | The lazy FK-reference registry a `resolveReference` hook is built from. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/references.md) |
| `./constraints` | yes | `enumCheck` and the threaded `type`-discriminator toolkit. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/constraints.md) |
| `./columns` | yes | `bytea`, `tsvector`, `jsonbSchema`, `timestamps`, the hex codec. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/columns.md) |
| `./query` | yes | The unpaged-total window column, `Page`, `combineFilters`, `boundedPagination`, `executeRows`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/query.md) |
| `./sort` | yes | The `?sort=` resolution seam: the derived sortable allow-list, `resolveSortOrder` / `chronologicalOrder` with a total-order `id` tiebreak, `UnsupportedSortError`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/sort.md) |
| `./update` | no | The update tri-state as a `SET` map: `updateSetMap`, `insertValues`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/update.md) |
| `./errors` | no (types only) | Postgres error facts and tagged classification over drizzle / `@effect/sql` error graphs. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/errors.md) |
| `./database` | types only | The driver-agnostic `makeDatabaseServices` factory (`Database`, `CurrentTransaction`, `transact`, `readHandle`). | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/database.md) |
| `./versioned-chain` | yes | The whole-tree builders `makeTreeTables` / `makeTreeViews`, the per-leaf `makeSubtypeTables` / `makeCurrentVersionView`, the `VersionChainEntry` / `VersionSnapshot` read shapes, `versionTimestamps`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/versioned-chain.md) |
| `./jsonapi` | no | `Resource.*`-shaped readers, including `resourceAttributeProjections`, and `defineResourceTree` (optional peer `@thomasfosterau/effect-jsonapi`). | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/jsonapi.md) |
| `./jsonapi/derive` | yes | The Drizzle-emitting half of `./jsonapi`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/jsonapi.md) |

## Links

- [How it fits together](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/overview.md): the design, the conventions and the non-goals.
- The guides in the table above, one per entry. The API reference is each export's doc comment.
- The [`-pg` binding](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/pg/README.md), and the [changelog](CHANGELOG.md).

## License

MIT © Thomas Foster. Repository: [github.com/thomasfosterau/effect-drizzle-ext](https://github.com/thomasfosterau/effect-drizzle-ext). Extracted from the `thomasfosterau/website`, `thomasfosterau/gardeneria` and `thomasfosterau/preferenceflow` applications.
