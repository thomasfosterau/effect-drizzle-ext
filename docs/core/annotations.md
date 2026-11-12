# `.` — annotation entry

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

No Drizzle dependency: the half a client- or model-layer package can import without pulling the ORM into its bundle. Effect Schema annotations are erased from the static type, so a purely annotation-driven derivation could not stay type-safe — it could tell neither _which_ fields are columns nor recover their precise column type. `dbColumn` therefore does two things: it attaches a real runtime annotation under `DB_COLUMN_KEY`, and it carries the metadata literally in a type-level phantom (`Annotated<S, M>`), so a derived column map stays precisely typed. `dbColumnFor<Kind>()` pins a consumer's own `pg` kind union once, so an annotation naming an unknown kind is a type error at the annotation site.

The entry also re-exports the version-chain read shapes `VersionAction`, `VersionChainEntry` and `VersionSnapshot` (the same types [`./versioned-chain`](versioned-chain.md) exports), so a history listing's client can name them without Drizzle. A build check (`tests/dist-consumer`) walks this entry's emitted JavaScript and declarations and fails if any file they reach imports `drizzle-orm`.

`dbTable` is the table-level counterpart: it stamps `TableMeta` (`{ name }`) or the level-carrying `DbTable<Level>` onto any object as a non-enumerable symbol property, not an Effect annotation — `annotate` rebuilds a schema, which would drop the properties a `Resource.make` definition assigns and break the referential identity a registry compares by. `dbTable` accepts any `TableMeta`, so a flat consumer (no hierarchy) annotates with `{ name }` alone rather than re-implementing the helper just to drop `level`; `dbTableFor<Level>()` pins the level union for a level-dispatching consumer.

Every reader the library owns returns `Option`: `readDbColumn`, `readDbTable`, `numericBounds`. `numericBounds` recovers the `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` a schema's own checks declare — the source of a derived CHECK constraint — reading own checks plus one union level (the `Schema.NullOr(Schema.Finite.check(...))` shape a nullable numeric attribute takes). `fieldColumns` and `fieldColumnBounds` project a whole `Schema.Struct.Fields` map at once, peeling the `optional` / `optionalKey` / `NullOr` / `UndefinedOr` wrappers an attribute applies, and are what `./derive`'s `fromFields` and `deriveFieldCheckConstraints` are built on.

```ts
export const dbColumn: <S extends Schema.Top, const M extends DbColumn>(
  schema: S,
  meta: M,
) => Annotated<S, M>;
export const readDbColumn: (schema: Schema.Constraint) => Option.Option<DbColumn>;
export const dbTable: <T extends object, const M extends TableMeta>(
  target: T,
  meta: M,
) => TableAnnotated<T, M>;
export const readDbTable: (target: object) => Option.Option<TableMeta>;
export const numericBounds: (schema: Schema.Constraint) => Option.Option<NumericBounds>;
export const fieldColumns: (fields: Schema.Struct.Fields) => Record<string, DbColumn>;
export const fieldColumnBounds: (fields: Schema.Struct.Fields) => Record<string, ColumnBounds>;
```

### Declaring a tree

`defineTree(spec)` declares a versioned ontology once, with no Drizzle import, so a models package can state it and the database layer derive every table, constraint and view from it (effect-drizzle-ext#112). Each entry of `spec` is a level:

- A **marker** has no `leaf`; a **leaf** carries its domain fields (`dbColumn`-annotated), and its name is its discriminator value.
- `parent` names another level; absent, the level is a branch root under the tree's root (the `node` identity and `node_version` tables).
- `columns` are **level columns**: fields on that level's version table that reach every descendant's view (a work's `title` on every book).
- `kind: "fact-scoped"` keeps a level's columns in one 6NF fact table each, where a fact's absence at a version is its `NULL`.
- `keyed: { name, columns }` (a leaf only) declares a **keyed fact level**: columns held once per `(id, version, key)`, such as a localised leaf's translated columns keyed by `locale`. They stay out of the leaf's shared columns.

`defineResourceTree` (`./jsonapi`) is the same over `Resource.make` definitions, each leaf's resource `type` being its level's name. `defineTreeFor<Ext>()` / `defineResourceTreeFor<Ext>()` pin an extension record every entry must carry (pulpit's registry flags), which the library never reads.

The result is a checked `Tree`: per level, its ancestors, children, descendants, subtree leaves (its discriminator CHECK value set) and branch, all in declaration order. A parent naming no level is a type error. Every other fault throws `DerivationError` at module load: a cycle, a leaf with children, a marker with no leaf below it, an unannotated column, a reserved name (`id`, `version`, `action`, `type`), two columns on one root-to-leaf path sharing a key or column name, or a keyed level on a marker.

```ts
import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import * as Schema from "effect/Schema";

const text = (column: string) => dbColumn(Schema.String, { column, pg: "text", notNull: false });

export const tree = defineTree({
  work: { columns: { title: text("title") } },
  book: { parent: "work", leaf: { isbn: text("isbn") } },
  essay: {
    parent: "work",
    leaf: {},
    keyed: { name: "locale", columns: { abstract: text("abstract") } },
  },
  agent: {},
  person: { parent: "agent", leaf: {} },
});
```
