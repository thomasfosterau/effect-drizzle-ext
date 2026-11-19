---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Typed Postgres errors in the error channel. `makePgDatabase`'s context-bound `queries` now fail with core's tagged classes (`UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation`, `CheckViolation`, `ExclusionViolation`, `SerializationFailure`, `DeadlockDetected`, each carrying its `constraint` / `table` / `column` / `detail`) when the SQLSTATE is one of those, so a caller can `Effect.catchTag("UniqueViolation", …)` on the query itself; every other failure is still the driver's `EffectDrizzleQueryError`. Core's `./errors` gains `classifyErrors`, the combinator that does this for any Effect (a `transact`, or a query run on a handle), and `isClassifiedError`; `classifyError` now returns an already-classified error as it is. `./query-functions`' `makeQueryFunctions` takes an optional `mapQuery` that wraps every query before it runs.
