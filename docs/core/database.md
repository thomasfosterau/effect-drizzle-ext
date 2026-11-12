# `./database`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

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
