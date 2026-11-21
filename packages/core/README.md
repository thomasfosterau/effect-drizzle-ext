# `@thomasfosterau/effect-drizzle-ext`

The Effect ↔ Drizzle bridge: Effect Schema → Drizzle column derivation with an extensible column-kind system, a versioned-chain interpreter, typed Postgres error classification, pagination and transaction combinators.

[![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-drizzle-ext.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-drizzle-ext)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add @thomasfosterau/effect-drizzle-ext effect drizzle-orm
```

`effect` (`^4.0.0`) and `drizzle-orm` (`>=1.0.0-rc.5`) are peer dependencies. `@thomasfosterau/effect-jsonapi` (`>=0.16.0`) is an **optional** peer, needed only by the `./JsonApi` and `./JsonApiDerive` subpaths — a plain `Schema.Struct` consumer never installs it. Node.js 22.18 or newer is required (the floor of the `@thomasfosterau/effect-ext` dependency).

## Example

```ts
import { dbColumn } from "@thomasfosterau/effect-drizzle-ext/Annotation";
import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/Derive";
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

Each module is a PascalCase subpath, and the root entry re-exports the Drizzle-free ones as namespaces (`import { Annotation } from "@thomasfosterau/effect-drizzle-ext"`), following Effect v4's layout.

| Subpath | Drizzle? | Contents | Guide |
| --- | --- | --- | --- |
| `.` | no | The Drizzle-free modules as namespaces (`Annotation`, `Errors`, `Predicate`, `Update`), plus the `PostGis` namespace, the one part that imports Drizzle. | [overview](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/overview.md) |
| `./Annotation` | no | The `dbColumn` / `dbTable` annotation vocabulary, phantoms, `Option` readers, numeric bounds, struct-field projection, `defineTree` (the Drizzle-free ontology declaration), `DerivationError`, and the `VersionChainEntry` / `VersionSnapshot` read shapes `./VersionedChain` also exports. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/annotations.md) |
| `./Derive` | yes | The builder registry, `deriveColumnsWith`, CHECK derivation from bounds, `DerivationError`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/derive.md) |
| `./References` | yes | The lazy FK-reference registry a `resolveReference` hook is built from. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/references.md) |
| `./Constraints` | yes | `enumCheck` and the threaded `type`-discriminator toolkit. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/constraints.md) |
| `./Columns` | yes | `bytea`, `tsvector`, `jsonbSchema`, `timestamps`, the hex codec. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/columns.md) |
| `./Query` | yes | The unpaged-total window column, `Page`, `combineFilters`, `boundedPagination`, `executeRows`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/query.md) |
| `./QueryFunctions` | no | `makeQueryFunctions`: a handle's `select` / `insert` / `query` / … as free functions that find the handle in the Effect context, and `DeferredQueryError`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/query-functions.md) |
| `./Sort` | yes | The `?sort=` resolution seam: the derived sortable allow-list, `resolveSortOrder` / `chronologicalOrder` with a total-order `id` tiebreak, `UnsupportedSortError`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/sort.md) |
| `./Update` | no | The update tri-state as a `SET` map: `updateSetMap`, `insertValues`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/update.md) |
| `./Errors` | no (types only) | Postgres error facts and tagged classification over drizzle / `@effect/sql` error graphs. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/errors.md) |
| `./Database` | types only | The driver-agnostic `makeDatabaseServices` factory (`Database`, `CurrentTransaction`, `transact`, `readHandle`). | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/database.md) |
| `./VersionedChain` | yes | The whole-tree builders `makeTreeTables` / `makeTreeViews`, the per-leaf `makeSubtypeTables` / `makeCurrentVersionView`, the `VersionChainEntry` / `VersionSnapshot` read shapes, `versionTimestamps`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/versioned-chain.md) |
| `./PostGis` | yes | Typed PostGIS helpers beside `eq`: `geometryColumn` / `geographyColumn`, spatial predicates, measures, constructors and outputs that keep geometry and geography apart. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/postgis.md) |
| `./Predicate` | no | The neutral row predicate (`eq`, `isIn`, `inSet`, `and`, `not`, …) and `evaluate`, its in-memory reading. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/predicate.md) |
| `./Where` | yes | `render`: a predicate as a fail-closed `WHERE` over a view's columns; `codePointKey`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/predicate.md) |
| `./Search` | yes | Hybrid search primitives: `regconfig` / `textArray` columns, `configForLanguage`, `weightedTsvector`, `ftsIndexes`, and the `fullText` / `trigram` / `literal` / `vector` rank fragments with `reciprocalRank`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/search.md) |
| `./JsonApi` | no | `Resource.*`-shaped readers, including `resourceAttributeProjections`, `defineResourceTree`, and `predicateFromFilter`, a `Filter.Ast` as a `./Predicate` (optional peer `@thomasfosterau/effect-jsonapi`). | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/jsonapi.md) |
| `./JsonApiDerive` | yes | The Drizzle-emitting half of `./JsonApi`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/jsonapi.md) |

## Links

- [How it fits together](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/overview.md): the design, the conventions and the non-goals.
- The guides in the table above, one per entry. The API reference is each export's doc comment.
- The [`-pg` binding](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/pg/README.md), and the [changelog](CHANGELOG.md).

## License

MIT © Thomas Foster. Repository: [github.com/thomasfosterau/effect-drizzle-ext](https://github.com/thomasfosterau/effect-drizzle-ext). Extracted from the `thomasfosterau/website`, `thomasfosterau/gardeneria` and `thomasfosterau/preferenceflow` applications.
