# `@thomasfosterau/effect-drizzle-ext`

The Effect ↔ Drizzle bridge: Effect Schema → Drizzle column derivation with an extensible column-kind system, a versioned-chain interpreter, typed Postgres error classification, pagination and transaction combinators.

[![CI](https://github.com/thomasfosterau/effect-drizzle-ext/actions/workflows/ci.yml/badge.svg)](https://github.com/thomasfosterau/effect-drizzle-ext/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-drizzle-ext.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-drizzle-ext) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Installation

```bash
npm install @thomasfosterau/effect-drizzle-ext effect drizzle-orm
```

`effect` (`>=4.0.0-rc.112`) and `drizzle-orm` (`>=1.0.0-rc.5`) are peer dependencies, built against `effect@4.0.0-rc.115` and `drizzle-orm@1.0.0-rc.5`. `@thomasfosterau/effect-jsonapi` (`>=0.14.0`) is an **optional** peer, needed only by the `./jsonapi` and `./jsonapi/derive` subpaths — a plain `Schema.Struct` consumer never installs it. Node.js 22 or newer is required.

## Overview

A model attribute's base schema carries a `dbColumn` annotation describing the database column it backs, and a table's factory reads that annotation through a builder registry it supplies. One declaration — the annotated field — is the single source for both the model projection and the column: no hand-maintained `columns: { … }` map to keep in sync with the schema, and no drift between what the wire validates and what the database enforces.

This library **extends** drizzle-orm's own Effect integration (`drizzle-orm/effect-postgres`, `drizzle-orm/effect-core`) rather than replacing it — the derived columns are ordinary Drizzle column builders, and the transaction services in `./database` are generic over drizzle's own database/transaction types. It re-implements none of drizzle's Effect support. The sibling [`@thomasfosterau/effect-drizzle-ext-pg`](../pg/README.md) package binds those services to `@effect/sql-pg` (`drizzle-orm/effect-postgres` + a real Postgres client) and ships a sentinel-rollback test transaction runner.

| Subpath | Drizzle? | Contents |
| --- | --- | --- |
| `.` | no | The `dbColumn` / `dbTable` annotation vocabulary, phantoms, `Option` readers, numeric bounds, struct-field projection. |
| `./derive` | yes | The builder registry, `makeDeriveColumns`, CHECK derivation from bounds, `DerivationError`. |
| `./references` | yes | The lazy FK-reference registry a `resolveReference` hook is built from. |
| `./constraints` | yes | `enumCheck` and the threaded `type`-discriminator toolkit. |
| `./columns` | yes | `bytea`, `tsvector`, `jsonbSchema`, `timestamps`, the hex codec. |
| `./query` | yes | The unpaged-total window column, `Page`, `combineFilters`, `boundedPagination`, `executeRows`. |
| `./errors` | no (types only) | Postgres error facts and tagged classification over drizzle / `@effect/sql` error graphs. |
| `./database` | types only | The driver-agnostic `makeDatabaseServices` factory (`Database`, `CurrentTransaction`, `transact`, `readHandle`). |
| `./versioned-chain` | yes | `makeSubtypeTables`, `makeCurrentVersionView`. |
| `./jsonapi` | no | `Resource.*`-shaped readers (optional peer `@thomasfosterau/effect-jsonapi`). |
| `./jsonapi/derive` | yes | The Drizzle-emitting half of `./jsonapi`. |

## Quick start

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
  id: dbColumn(Schema.UUID, { column: "id", pg: "text", notNull: true }),
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

const references = makeReferenceRegistry();
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

## `.` — annotation entry

No Drizzle dependency: the half a client- or model-layer package can import without pulling the ORM into its bundle. Effect Schema annotations are erased from the static type, so a purely annotation-driven derivation could not stay type-safe — it could tell neither _which_ fields are columns nor recover their precise column type. `dbColumn` therefore does two things: it attaches a real runtime annotation under `DB_COLUMN_KEY`, and it carries the metadata literally in a type-level phantom (`Annotated<S, M>`), so a derived column map stays precisely typed. `dbColumnFor<Kind>()` pins a consumer's own `pg` kind union once, so an annotation naming an unknown kind is a type error at the annotation site.

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

## `./derive`

Reads the `DbColumn` metadata a schema declaration carries — via `fieldColumns`, or any other projection yielding a `Record<string, DbColumn>` (the `./jsonapi/derive` entry is one) — and emits the matching Drizzle column builders. `makeDeriveColumns(builders, options)` binds a derivation to a consumer's own kind → builder registry and returns `{ fromFields, fromMeta }`: `fromFields` takes a `Schema.Struct`'s fields directly, `fromMeta` an already-projected metadata map.

Failures here are **thrown**, never Effect failures — this module runs at _module load_, while a consumer's table modules are being evaluated, before any Effect runtime exists to fail an Effect in. A missing builder, a `references` annotation with no `resolveReference` hook, or numeric bounds on a column the table does not carry each throw `DerivationError`, a `Schema.TaggedError`. Runtime query failures are the opposite and are never thrown: see `./errors`.

`deriveCheckConstraintsFrom` / `deriveFieldCheckConstraints` turn a bounds map into `check()` constraints, named `${tableName}_${column}_${suffix}` unless the column annotation pins a `checkName`:

| Bounds                      | Suffix         | Expression                 |
| --------------------------- | -------------- | -------------------------- |
| both sides                  | `range`        | `col BETWEEN min AND max`  |
| `minimum: 0` only           | `non_negative` | `col >= 0`                 |
| one-sided minimum (nonzero) | `min`          | `col >= min` / `col > min` |
| one-sided maximum           | `max`          | `col <= max` / `col < max` |

A nullable column's expression is guarded with `col IS NULL OR …`.

```ts
export class DerivationError extends Schema.TaggedError<DerivationError>()("DerivationError", {
  message: Schema.String,
}) {}
export const makeDeriveColumns: <B extends ColumnBuilders>(
  builders: B,
  options?: DeriveOptions,
) => {
  readonly fromMeta: <Meta extends Record<string, DbColumn>>(
    metas: Meta,
  ) => DerivedColumns<Meta, B>;
  readonly fromFields: <F extends Schema.Struct.Fields>(
    fields: F,
  ) => DerivedColumns<FieldColumnsMetaOf<F>, B>;
};
export const deriveCheckConstraintsFrom: (
  bounds: Record<string, ColumnBounds>,
  tableName: string,
) => (table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[];
export const deriveFieldCheckConstraints: (
  fields: Schema.Struct.Fields,
  tableName: string,
) => (table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[];
```

## `./references`

A `dbColumn`'s `references` annotation names its FK target as `{ table, column }`, not a Drizzle column thunk — `./derive`'s `resolveReference` hook is what turns a name pair into the thunk `.references()` needs, and `makeReferenceRegistry` is one implementation of that hook. `register(table)` records a table by its SQL name; `resolve(reference)` returns a **lazy** thunk, forced only when Drizzle materialises the foreign key (migration generation or query build), long after every table module (and its `register` call) has loaded — this sidesteps the import cycle a static `import { targetTable }` would create, since the deriver is imported _by_ the table modules. Forcing the thunk against an unregistered table, or a table with no such column, throws `DerivationError`.

A factory, not a singleton: two independent schemas in one process (an app and its test fixtures, two tenants' table sets) would share one name space under a module-scope registry and resolve each other's tables, so each call to `makeReferenceRegistry` owns its own map.

```ts
export interface ReferenceRegistry {
  readonly register: (table: PgTable) => void;
  readonly resolve: (reference: DbColumnReference) => () => AnyPgColumn;
}
export const makeReferenceRegistry: () => ReferenceRegistry;
```

## `./constraints`

`enumCheck(name, column, values)` emits `CHECK (column IN ('a', 'b', …))` — a vocabulary declared once as a model's `Schema.Literals` also constrains the database, with no Postgres enum type (so growing the vocabulary is one `ALTER … DROP/ADD CONSTRAINT`, not an `ALTER TYPE … ADD VALUE` that cannot run inside a transaction). A `NULL` in the column **passes**: `NULL IN (...)` is unknown, which CHECK accepts, so the same constraint serves a nullable vocabulary with no extra `IS NULL OR` guard — nullability is the column's own `NOT NULL` to declare.

`makeDiscriminatorConstraints({ leaves, names? })` builds a `DiscriminatorToolkit<Level>` for one hierarchy: the three constraints that thread a `type` discriminator up a tree of stable tables and make a sibling-subtype chimera unrepresentable.

- `typeUnique` — `UNIQUE(id, type)`, the target every child's composite FK points at.
- `typeParentFk` — the composite `(id, type)` → parent `(id, type)` foreign key (a child can only exist under a parent carrying the same `type`); `onUpdate: "cascade"` (via `typeConstraints`' `refinable: true`) makes a bare parent row **refinable** — a `type` flip cascades down the pre-existing chain before the concrete rows are inserted, with no `DEFERRABLE` constraint needed.
- `typeCheck` — the per-level `type` CHECK, narrowing to the level's own subtree (`options.leaves(level)`). A childless marker level — no concrete leaf beneath it yet — has an empty leaf set and gets `CHECK (false)`: `type IN ()` is a syntax error, and `false` correctly marks the level uninstantiable.
- `typeConstraints` — all three for a non-root level in one call.

```ts
export const enumCheck: (
  name: string,
  column: ExtraConfigColumn,
  values: readonly string[],
) => PgTableExtraConfigValue;
export const makeDiscriminatorConstraints: <Level extends string>(options: {
  readonly leaves: (level: Level) => ReadonlyArray<string>;
  readonly names?: DiscriminatorNames | undefined;
}) => DiscriminatorToolkit<Level>;
```

## `./columns`

- `jsonbSchema(schema)(name)` — a typed `jsonb` custom column backed by an Effect Schema: writes encode through the schema then to JSON text, reads decode driver output straight through the schema (a string-typed branch is kept for a driver that hands back raw JSON text instead of a parsed value).
- `tsvector(name)` — a `tsvector` custom column, opaque to the consumer; queries use `sql` template literals to match against it.
- `bytea(name)` — a `bytea` custom column typed `Uint8Array`, never `Buffer` (a runtime that degrades the `Buffer` global, e.g. Cloudflare Workers' `nodejs_compat` types, would silently lose type checking on every `Buffer.*` call).
- `timestamps()` — a fresh `{ createdAt, updatedAt }` pair, `timestamptz NOT NULL DEFAULT now()`. A **factory**, never a shared object: Drizzle column builders are mutable, so a module-level constant reused across tables would hand every table the same two builders.
- `byteaToHex` / `hexToBytea` — the hex codec for a `bytea` value without the Node `Buffer` global; `hexToBytea` **throws `TypeError`** on a malformed input, where `Buffer.from` would silently truncate it.

```ts
export const jsonbSchema: <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) => (name: string) => PgCustomColumnBuilder<…>;
export const tsvector: (name: string) => PgCustomColumnBuilder<…>;
export const bytea: (name: string) => PgCustomColumnBuilder<…>;
export const timestamps: () => { readonly createdAt: …; readonly updatedAt: … };
export const byteaToHex: (bytes: Uint8Array) => string;
export const hexToBytea: (hex: string) => Uint8Array;
```

## `./query`

`totalCountColumn` spreads `(count(*) over ())::int` into a `.select({ … })` map; `pageOf` / `pageWithTotal` read it back off the first row into a `Page<T>`. `COUNT(*) OVER ()` is evaluated after `WHERE` and before `LIMIT`/`OFFSET`, so the unpaged total rides back on every row of the page a list read is already fetching — one round trip instead of a second sequential `count(*)` query.

A window function over zero rows returns nothing, so **an empty page reports `totalCount: 0`** — exact when nothing matches, and wrong only when a caller paged past the end of a non-empty collection. That case is self-describing (`items: []` says it) and self-correcting (paging back gives the true total); the alternative is a second query on every list read.

`combineFilters(...filters)` `AND`-joins the defined ones and returns `undefined` with none defined, so a caller omits `.where(...)` entirely rather than applying a vacuous `WHERE true`. `boundedPagination({ maxLimit, defaultLimit })` builds a `limit` / `offset` input schema bounded to `(0, maxLimit]` / `>= 0`, decoding absent keys to `defaultLimit` / `0`.

`executeRows` is a rows-normalising wrapper for raw-SQL reads (`db.execute<T>`): drizzle's effect-postgres driver types `db.execute<T>` as `readonly T[]`, but depending on the SQL client bound underneath, the query can resolve in "raw" mode with no row mapper and hand back the full driver result object (`{ rows, rowCount, … }`) instead — so `.map` on the yielded value throws. Every raw-SQL read that needs its rows should go through `executeRows` instead of `db.execute` directly; write-only executes (INSERT/DDL) that never read rows can keep calling `db.execute`.

```ts
export const totalCountColumn: { readonly __totalCount: SQL<number> };
export interface Page<T> {
  readonly items: readonly T[];
  readonly totalCount: number;
}
export const pageOf: <TRow, TResource>(
  rows: readonly TRow[],
  toResource: (row: TRow) => TResource,
) => Page<TResource>;
export const pageWithTotal: <TResource>(
  items: readonly TResource[],
  rows: readonly unknown[],
) => Page<TResource>;
export const combineFilters: (...filters: ReadonlyArray<SQL | undefined>) => SQL | undefined;
export const boundedPagination: (options: {
  readonly maxLimit: number;
  readonly defaultLimit: number;
}) => BoundedPagination;
export const executeRows: <T extends Record<string, unknown>>(
  db: {
    readonly execute: (
      query: SQLWrapper | string,
    ) => Effect.Effect<unknown, EffectDrizzleQueryError>;
  },
  query: SQLWrapper | string,
) => Effect.Effect<readonly T[], EffectDrizzleQueryError>;
```

## `./errors`

`@effect/sql-pg` already classifies SQLSTATE into `SqlError.reason`, but keeps the violated constraint for `23505` only — every other `23xxx` becomes a bare `ConstraintError` with no constraint / table / column — and drizzle wraps the whole thing inside `EffectDrizzleQueryError.cause`, an Effect `Cause`, not the driver error. `findPgError` recovers the facts anyway: a bounded (depth 8), cycle-guarded walk of the error graph — reading `.cause` explicitly (it is non-enumerable on both `SqlError` and `EffectDrizzleQueryError`) plus enumerable values and arrays (a `Cause`'s `reasons`) — for the first node whose `code` / `sqlState` looks like a five-character SQLSTATE. It matches a bare driver error, a bare `SqlError`, or the fully drizzle-wrapped shape alike, and imports neither `drizzle-orm` nor `@effect/sql-pg` to do it (the shapes are recognised structurally).

`classifyError` dispatches the recovered SQLSTATE into one of seven tagged errors:

| SQLSTATE | Class                  | Facts                           | Retryable |
| -------- | ---------------------- | ------------------------------- | --------- |
| `23505`  | `UniqueViolation`      | `constraint`, `table`, `detail` | no        |
| `23503`  | `ForeignKeyViolation`  | `constraint`, `table`, `detail` | no        |
| `23502`  | `NotNullViolation`     | `column`, `table`               | no        |
| `23514`  | `CheckViolation`       | `constraint`, `table`           | no        |
| `23P01`  | `ExclusionViolation`   | `constraint`, `table`           | no        |
| `40001`  | `SerializationFailure` | —                               | yes       |
| `40P01`  | `DeadlockDetected`     | —                               | yes       |

Every class carries `cause` (the value classification started from, so the wrapping graph — drizzle's query text and params, the `SqlError` — survives). `classifyError` is `Option.none()` outside these seven (a syntax error, a connection failure — `SqlError.reason` already covers those well). `catchConstraintViolation` / `catchUniqueViolation` are data-last Effect combinators that recover the matching class and re-fail everything else, including other constraint classes, unchanged. `isUniqueViolation` is kept for adoption parity with the consuming applications' pre-existing predicate: same name, same semantics, including a fallback to the stable `pg` message fragment when no `code` survived the wrapping.

```ts
export const findPgError: (error: unknown) => Option.Option<PgErrorFacts>;
export const classifyError: (error: unknown) => Option.Option<ClassifiedError>;
export const isUniqueViolation: (error: unknown) => boolean;
export const isConstraintViolation: (error: unknown) => boolean;
export const isRetryableTransactionFailure: (error: unknown) => boolean;
export const catchConstraintViolation: <A2, E2, R2>(
  f: (violation: ConstraintViolation) => Effect.Effect<A2, E2, R2>,
) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E | E2, R | R2>;
export const catchUniqueViolation: <A2, E2, R2>(
  f: (violation: UniqueViolation) => Effect.Effect<A2, E2, R2>,
) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E | E2, R | R2>;
```

Not owned here: `NotFound` / `Unauthorized` / `Forbidden` (application / JSON:API wire vocabulary).

## `./database`

`makeDatabaseServices<Db, Tx>()({ key })` builds one application's transaction boundary as a pair of `Context.Service` keys plus two helpers, generic over the app's own Effect-native Drizzle database and transaction types — no `@effect/sql-pg` type reaches this module. The identifier of each key is the key string itself, so an application writes `type Database = typeof Database.Identifier` and gets a requirement it can name in its own signatures; `CurrentTransaction`'s key is `${Key}/CurrentTransaction`, so two applications composed into one process never collide.

`transact(body)` is **always-open, never join-if-present**: calling it while a transaction is already open deliberately opens a _nested_ one (a SAVEPOINT on the same connection, via `tx.transaction(...)` rather than `db.transaction(...)`, which is a SAVEPOINT on every driver). A "join the ambient transaction if there is one" variant is easy to write and is the wrong call — it would silently delete every SAVEPOINT the calling code currently takes, changing rollback granularity without changing a line of that code. To reuse the open transaction, yield `CurrentTransaction` directly and do not open another; this is adjudicated (website #1883) and is not something to "improve" into join-if-present.

`readHandle` is the asymmetric counterpart for reads: it prefers the ambient `CurrentTransaction` when one is open, falling back to `Database` otherwise. A read opens no boundary, so there is nothing to lose by joining — preferring the transaction is also the safer default, not merely convenient, since a read issued against `Database` from inside an open transaction takes its own pooled connection and is not guaranteed to see that transaction's uncommitted writes.

```ts
export interface DatabaseServices<Db, Tx extends ReadSurface, Key extends string> {
  readonly Database: Context.Service<Key, Db>;
  readonly CurrentTransaction: Context.Service<`${Key}/CurrentTransaction`, Tx>;
  readonly transact: <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, Exclude<R, `${Key}/CurrentTransaction`> | Key>;
  readonly readHandle: Effect.Effect<ReadHandle<Tx>, never, Key>;
}
export const makeDatabaseServices: <
  Db extends TransactionalDatabase<Tx> & ReadHandle<Tx>,
  Tx extends ReadSurface & TransactionalDatabase<Tx>,
>() => <const Key extends string>(options: { readonly key: Key }) => DatabaseServices<Db, Tx, Key>;
```

## `./versioned-chain`

The opt-in interpreter for "a tree of levels, each a stable + version table pair, joined up a composite `(id, version)` FK chain to a root, with fail-closed current-version views" — the shape a temporal-versioned node hierarchy takes. `./versioned-chain` carries no application ontology; both factories are parameterised over the bits one hierarchy pins.

`makeSubtypeTables(applyDiscriminator)(schema, config)` builds one leaf's `{ stable, version }` pair: the stable identity row (`id` primary key referencing the parent branch's stable `id`, plus a denormalised `type` discriminator), and the version row (`(id, version)` primary key, `(id, version)` foreign-keyed to the parent branch's version table). Domain columns are authored per leaf and merged in via `config.columns`; `discriminator`, when present, makes `type` `NOT NULL` and appends the constraints `applyDiscriminator` returns (a `./constraints` `DiscriminatorToolkit` is the intended hook). Its return type, `SubtypeTables<TColumns>`, is written out as an explicit annotation rather than inferred — the declaration printer cannot reduce the homomorphic `PgBuildColumns` mapped type while `TColumns` is still generic, and would otherwise emit an unbound `TTableName` reference that `skipLibCheck` hides.

`makeCurrentVersionView(deps)(schema, name, config)` builds the uniform fail-closed current-version view: currency resolves from `deps.rootVersion` (a `MAX(version)` sub-select grouped by `id`), and `config.leaf` / `config.through` INNER JOIN at exactly that `(id, version)` — a node whose root version advanced past its leaf (a partial-chain tombstone) yields **no row**, rather than surfacing a stale older leaf row. `config.optional` LEFT JOINs 6NF satellite fact tables instead, where row-absence at a version encodes NULL. `deps.merge` can be a plain object (columns merged from `deps.identity`, no extra join, the emitted view definition unchanged) or a function (additionally INNER JOINs a `version = 0` alias of `rootVersion` and hands it to the callback, so a hierarchy can merge in a true `createdAt` sourced from the node's birth row, distinct from the current version's timestamp) — the object form matters for a root version table whose view is itself joined by another hand-written view, since drizzle-kit does not topologically order view-on-view DROPs.

**No view built by `makeCurrentVersionView` may select from another view built by `makeCurrentVersionView`** — a library-level rule, not just an observation about the DROP-ordering hazard above.

```ts
export const makeSubtypeTables: <TDiscriminator>(
  applyDiscriminator: (
    level: string,
    stable: DiscriminatorColumns,
    discriminator: TDiscriminator,
  ) => PgTableExtraConfigValue[],
) => <TColumns extends Record<string, ColumnBuilderBase>>(
  schema: PgSchema,
  config: SubtypeTablesConfig<TColumns, TDiscriminator>,
) => SubtypeTables<TColumns>;
export const makeCurrentVersionView: <
  TRoot extends PgTable & VersionTable,
  TMerge extends ViewColumns,
>(
  deps: CurrentVersionViewDeps<TRoot, TMerge>,
) => <TColumns extends ViewColumns>(
  schema: PgSchema,
  name: string,
  config: CurrentVersionViewConfig<TColumns>,
) => CurrentVersionViewResult<TColumns, TMerge>;
```

## `./jsonapi` and `./jsonapi/derive`

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
import { makeDeriveResourceColumns } from "@thomasfosterau/effect-drizzle-ext/jsonapi/derive";

const deriveResourceColumns = makeDeriveResourceColumns(builders, {
  resolveReference: references.resolve,
});
export const articleColumns = deriveResourceColumns(Article);
```

`dbTable` / `dbTableFor` / `readDbTable` are re-exported here narrowed to `R extends AnyResource` — the same functions as `.`, so a resource-facing `db-annotation.ts` imports every name it needs from one place.

```ts
export type AnyResource = Resource.Any;
export const resourceColumns: (resource: AnyResource) => Record<string, DbColumn>;
export const resourceColumnBounds: (resource: AnyResource) => Record<string, ColumnBounds>;
export const makeDeriveResourceColumns: <B extends ColumnBuilders>(
  builders: B,
  options?: DeriveOptions,
) => <R extends AnyResource>(resource: R) => DerivedResourceColumns<R, B>;
export const deriveCheckConstraints: (
  resource: AnyResource,
  tableName: string,
) => (table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[];
```

## Conventions

**Drizzle-facing config members are `?: T | undefined`, never `Option`.** Drizzle reads `undefined` as "not supplied"; handed an `Option`, it would emit the wrapper object itself as a literal value — wrong DDL that no type error and no unit test catches. Every reader the library owns (`readDbColumn`, `readDbTable`, `findPgError`, …) returns `Option` instead; the conversion happens at that boundary.

**The derivation decides column _types_, never column _order_ or _names_.** Both are what a consumer's `db:generate` emits into a migration, so reordering or renaming fields in a schema declaration is a migration to write by hand, not something this library infers.

**Explicit return annotations on the chain tables.** `SubtypeTables` and `CurrentVersionViewResult` are written out, not inferred, because the declaration printer cannot reduce `PgBuildColumns` / `PgViewWithSelection` while their column map is still generic — an inferred form would emit an unbound `TTableName` reference that only shows up as `any` downstream, past `skipLibCheck`.

**No view selects from another view built by `makeCurrentVersionView`.** drizzle-kit does not topologically order view-on-view DROPs, so layering one generated current-version view on top of another breaks migration generation; a hierarchy's own hand-written views may join a generated one, never the reverse.

## Limitations / non-goals

- **Id brands** — a consumer's own branded id types (`ArticleId`, `PersonId`, …) stay in the application; this library is id-agnostic.
- **Owner scoping** — multi-tenant visibility predicates (`owner_id`, role ladders) are application trust policy and stay in the application.
- **Migrations tooling** — running `drizzle-kit generate` / `migrate`, and the generated SQL files themselves, stay in the application.
- **Provisioning** — bootstrapping a real database (fixture users, seed data, a CI Postgres service) stays in the application; `@thomasfosterau/effect-drizzle-ext-pg/testing` ships only the transaction-rollback test harness.
- **Operation factories** — the model / route / handler layer built around a derived table (create/update/list operations, viewer-scoped queries) stays in the application.

## Metadata

MIT © Thomas Foster. Repository: [github.com/thomasfosterau/effect-drizzle-ext](https://github.com/thomasfosterau/effect-drizzle-ext). Extracted from the `thomasfosterau/website`, `thomasfosterau/gardeneria` and `thomasfosterau/preferenceflow` applications.
