# How it fits together

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

A model attribute's base schema carries a `dbColumn` annotation describing the database column it backs, and a table's factory reads that annotation through a builder registry it supplies. One declaration — the annotated field — is the single source for both the model projection and the column: no hand-maintained `columns: { … }` map to keep in sync with the schema, and no drift between what the wire validates and what the database enforces.

This library **extends** drizzle-orm's own Effect integration (`drizzle-orm/effect-postgres`, `drizzle-orm/effect-core`) rather than replacing it — the derived columns are ordinary Drizzle column builders, and the transaction services in `./database` are generic over drizzle's own database/transaction types. It re-implements none of drizzle's Effect support. The sibling [`@thomasfosterau/effect-drizzle-ext-pg`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/pg/README.md) package binds those services to `@effect/sql-pg` (`drizzle-orm/effect-postgres` + a real Postgres client) and ships a sentinel-rollback test transaction runner.

## Conventions

**Drizzle-facing config members are `?: T | undefined`, never `Option`.** Drizzle reads `undefined` as "not supplied"; handed an `Option`, it would emit the wrapper object itself as a literal value — wrong DDL that no type error and no unit test catches. Every reader the library owns (`readDbColumn`, `readDbTable`, `findPgError`, …) returns `Option` instead; the conversion happens at that boundary.

**The derivation decides column _types_, never column _order_ or _names_.** Both are what a consumer's `db:generate` emits into a migration, so reordering or renaming fields in a schema declaration is a migration to write by hand, not something this library infers.

**No view selects from another view built by `makeCurrentVersionView`.** drizzle-kit does not topologically order view-on-view DROPs, so layering one generated current-version view on top of another breaks migration generation; a hierarchy's own hand-written views may join a generated one, never the reverse.

## Limitations / non-goals

- **Id brands** — a consumer's own branded id types (`ArticleId`, `PersonId`, …) stay in the application; this library is id-agnostic.
- **Owner scoping** — multi-tenant visibility predicates (`owner_id`, role ladders) are application trust policy and stay in the application.
- **Migrations** — `drizzle-kit generate`, the generated SQL files and the deploy-time migrator stay in the application. The fresh-database runner, test-database provisioning and the drift / view-dependency guards are in [`@thomasfosterau/effect-drizzle-ext-pg`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/pg/README.md) (`./migrations`, `./testing`, `./tooling`).
- **Seed data** — fixture users and application seeds stay in the application's harness.
- **Operation factories** — the model / route / handler layer built around a derived table (create/update/list operations, viewer-scoped queries) stays in the application. The pieces of it that are generic over any table — the sort seam, the update `SET` map, the attribute projections — ship here; JSON:API link builders belong to `@thomasfosterau/effect-jsonapi`, and list visibility predicates to the authorization layer.

## Walk-through

A consumer pins its own column-kind and hierarchy-level unions once, in one file:

```ts
import { dbColumnFor, dbTableFor } from "@thomasfosterau/effect-drizzle-ext";

export type PgKind = "text" | "integer" | "boolean" | "timestamp";
export type LeafLevel = "work" | "manifestation";

export const dbColumn = dbColumnFor<PgKind>();
export const dbTable = dbTableFor<LeafLevel>();
```

Then annotates a model's fields with the column they back:

```ts
import * as Schema from "effect/Schema";
import { dbColumn } from "./db-annotation.ts";

export const Article = Schema.Struct({
  id: dbColumn(Schema.String.check(Schema.isUUID()), { column: "id", pg: "text", notNull: true }),
  title: dbColumn(Schema.NonEmptyString, { column: "title", pg: "text", notNull: true }),
  views: dbColumn(Schema.Finite, { column: "views", pg: "integer", notNull: true, default: 0 }),
});
```

A builder registry supplies the Drizzle column for each `pg` kind, and `makeDeriveColumns` interprets the annotations against it:

```ts
import { boolean, integer, text, timestamp } from "drizzle-orm/pg-core";
import { makeDeriveColumns, type ColumnBuilders } from "@thomasfosterau/effect-drizzle-ext/derive";
import { makeReferenceRegistry } from "@thomasfosterau/effect-drizzle-ext/references";
import type { PgKind } from "./db-annotation.ts";

export const references = makeReferenceRegistry();
const builders: ColumnBuilders<PgKind> = { text, integer, boolean, timestamp };
export const { fromFields } = makeDeriveColumns(builders, { resolveReference: references.resolve });
```

The table factory spreads `fromFields(...)` for the columns and `deriveFieldCheckConstraints(...)` for the numeric-bound CHECKs the model's own `Schema.isGreaterThanOrEqualTo` / `isBetween` checks imply:

```ts
import { pgTable } from "drizzle-orm/pg-core";
import { deriveFieldCheckConstraints } from "@thomasfosterau/effect-drizzle-ext/derive";
import { fromFields, references } from "./derive.ts";
import { Article } from "./article.model.ts";

export const articleTable = pgTable(
  "article",
  fromFields(Article.fields),
  deriveFieldCheckConstraints(Article.fields, "article"),
);
references.register(articleTable);
```

This library only goes **Schema → table**. The reverse direction — deriving a `Schema.Struct` back off a Drizzle table — is drizzle's own `drizzle-orm/effect-schema` (`createSelectSchema` and friends); nothing here duplicates it.
