---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Context-bound query functions. `makePgDatabase` now returns `queries`: the client's `select`, `insert`, `update`, `delete`, `query`, `$count`, `execute` and the rest as free functions that find the client in the Effect context, so a caller writes `yield* select().from(users)` instead of yielding the client first. Every builder keeps Drizzle's own types, inferred from the schema, with the database key in its requirement channel (`PgQueryFunctions`, `PgContextQueryEffectHKT`). Each query runs on the open `CurrentTransaction` when there is one, so a write inside `transact` lands in that transaction, and on the `Database` client otherwise. The driver-agnostic factory behind it is core's new `./query-functions` entry (`makeQueryFunctions`, `DeferredQueryError`).
