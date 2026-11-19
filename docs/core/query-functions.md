# `./query-functions`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

`makeQueryFunctions<Surface>()(services)` turns a Drizzle handle's query surface into free functions that find the handle in the Effect context, so a caller writes `yield* select().from(users)` instead of yielding the client and writing `db.select().from(users)`. It takes the `Database` and `CurrentTransaction` keys from [`./database`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/database.md)'s `makeDatabaseServices`, so there is no second service to wire.

An application on `@effect/sql-pg` doesn't call it: `makePgDatabase` already returns the result as `queries`, typed by Drizzle itself (see the [pg overview](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/overview.md#context-bound-query-functions)). This entry is for a binding over another Effect-native driver.

## How a deferred query works

Each function returns a **deferred query**: a stand-in that records every member read and call made on it (`.from(users)`, `.where(…)`, `.returning()`, `query.users.findMany(…)`) and is itself an Effect. Yielding it:

1. resolves the handle: the open `CurrentTransaction` when there is one, the `Database` client otherwise;
2. replays the recording against that handle, which builds the real Drizzle builder;
3. runs the builder.

The handle is resolved each time the query is yielded, not when it is built, so one deferred query can run outside a transaction and again inside one. A shared prefix is safe to extend twice: each link is its own recording.

Only the public builder API is replayed, so the module names no driver. Its static type is whatever `Surface` the binding names; for `@effect/sql-pg` that is Drizzle's own `PgEffectDatabase` typed over a query-effect kind whose requirement is the database key, so every result type is still inferred from the schema.

## Writes inside `transact`

A write resolves its handle the way `readHandle` does, so a write yielded inside `transact` runs in that transaction rather than on a second pooled connection, and rolls back with it. This opens no boundary, so it isn't the join-if-present `transact` refuses to be: `transact` still opens a SAVEPOINT every time it is called.

## Limits

A deferred query is only for running. It can't render SQL or become a subquery, because it has no handle until it is yielded:

- reading `toSQL`, `getSQL` or `as` once the chain has been called throws a `DeferredQueryError`;
- a chain that replays to something other than an Effect, or reads a member the handle doesn't have, dies with a `DeferredQueryError` when yielded.

Neither is a typed failure: no input makes a correct program raise one. Build subqueries and CTEs with Drizzle's standalone `QueryBuilder` (from `drizzle-orm/pg-core`) or the handle itself, and pass them in as arguments, which the replay hands to the real builder unchanged.

```ts
export class DeferredQueryError extends Schema.TaggedError<DeferredQueryError>()(
  "DeferredQueryError",
  { message: Schema.String },
) {}
export const makeQueryFunctions: <Surface extends object>() => <
  Db,
  Tx extends ReadSurface,
  Key extends string,
>(
  services: Pick<DatabaseServices<Db, Tx, Key>, "Database" | "CurrentTransaction">,
) => Surface;
```
