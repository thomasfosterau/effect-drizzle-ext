# `./jsonapi` and `./jsonapi/derive`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

For a consumer whose models are `@thomasfosterau/effect-jsonapi` `Resource.make` definitions, whose `dbColumn` annotations sit behind an extra layer — the `Resource.attribute` descriptor, and the `optionalKey` wrapper a `resource: "optional"` attribute takes. `./jsonapi` is the reader for that shape (the resource-shaped counterpart of `fieldColumns` / `fieldColumnBounds`); `./jsonapi/derive` is the Drizzle-emitting half, a thin join over `./derive`'s generic interpreter — no failure modes, CHECK naming or `resolveReference` semantics of its own.

```ts
import { Resource } from "@thomasfosterau/effect-jsonapi";
import { dbColumn, dbTable } from "./db-annotation.ts"; // resource-narrowed dbColumnFor / dbTableFor

export const Article = Resource.make("articles", {
  attributes: {
    title: dbColumn(Schema.NonEmptyString, { column: "title", pg: "text", notNull: true }),
  },
});
dbTable(Article, { name: "article", level: "work" });
```

```ts
import { deriveResourceColumnsWith } from "@thomasfosterau/effect-drizzle-ext/jsonapi/derive";

const deriveResourceColumns = deriveResourceColumnsWith(builders, {
  resolveReference: references.resolve,
});
export const articleColumns = deriveResourceColumns(Article);
```

`resourceAttributeProjections(resource)` reads each resource-object attribute's **projection shape** as plain data, in declaration order. That shape is what an operation factory needs to derive a row → resource mapper and a column map from the model alone:

- `optional` — an `optionalKey` projection, read off the AST;
- `nullable`, `array`, `date` — behavioural decode probes through the attribute's JSON codec, so `Schema.Date` counts as a date because an ISO string decodes to a `Date`;
- `column` — the `dbColumn` column name, `Option.none()` when the attribute declares none.

Input-only attributes (`resource: false`) are not on the resource object and are not listed.

`dbTable` / `dbTableFor` / `readDbTable` are re-exported here narrowed to `R extends AnyResource` — the same functions as `.`, so a resource-facing `db-annotation.ts` imports every name it needs from one place.

```ts
export type AnyResource = Resource.Any;
export const resourceColumns: (resource: AnyResource) => Record<string, DbColumn>;
export const resourceColumnBounds: (resource: AnyResource) => Record<string, ColumnBounds>;
export interface ResourceAttributeProjection {
  readonly key: string;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly array: boolean;
  readonly date: boolean;
  readonly column: Option.Option<string>;
}
export const resourceAttributeProjections: (
  resource: AnyResource,
) => ReadonlyArray<ResourceAttributeProjection>;
export const deriveResourceColumnsWith: <B extends ColumnBuilders>(
  builders: B,
  options?: DeriveOptions,
) => <R extends AnyResource>(resource: R) => DerivedResourceColumns<R, B>;
export const deriveCheckConstraints: (
  resource: AnyResource,
  tableName: string,
) => (table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[];
```
