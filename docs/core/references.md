# `./references`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

A `dbColumn`'s `references` annotation names its FK target as `{ table, column }`, not a Drizzle column thunk — `./derive`'s `resolveReference` hook is what turns a name pair into the thunk `.references()` needs, and `makeReferenceRegistry` is one implementation of that hook. `register(table)` records a table by its SQL name; `resolve(reference)` returns a **lazy** thunk, forced only when Drizzle materialises the foreign key (migration generation or query build), long after every table module (and its `register` call) has loaded — this sidesteps the import cycle a static `import { targetTable }` would create, since the deriver is imported _by_ the table modules. Forcing the thunk against an unregistered table, or a table with no such column, throws `DerivationError`.

A factory, not a singleton: two independent schemas in one process (an app and its test fixtures, two tenants' table sets) would share one name space under a module-scope registry and resolve each other's tables, so each call to `makeReferenceRegistry` owns its own map.

```ts
export interface ReferenceRegistry {
  readonly register: (table: PgTable) => void;
  readonly resolve: (reference: DbColumnReference) => () => AnyPgColumn;
}
export const makeReferenceRegistry: () => ReferenceRegistry;
```
