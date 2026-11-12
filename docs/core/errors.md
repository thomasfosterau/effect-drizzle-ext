# `./errors`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

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

Every class carries `cause` (the value classification started from, so the wrapping graph — drizzle's query text and params, the `SqlError` — survives). `classifyError` is `Option.none()` outside these seven (a syntax error, a connection failure — `SqlError.reason` already covers those well). `catchConstraintViolation` / `catchUniqueViolation` are data-last Effect combinators that recover the matching class and re-fail everything else, including other constraint classes, unchanged. `isUniqueViolation` is kept for adoption parity with the consuming applications' pre-existing predicate: same name, same semantics, including a fallback to the stable Postgres message fragment when no `code` survived the wrapping.

```ts
export const findPgError: (cause: unknown) => Option.Option<PgErrorFacts>;
export const classifyError: (cause: unknown) => Option.Option<ClassifiedError>;
export const isUniqueViolation: (cause: unknown) => boolean;
export const isConstraintViolation: (cause: unknown) => boolean;
export const isRetryableTransactionFailure: (cause: unknown) => boolean;
export const catchConstraintViolation: <A2, E2, R2>(
  f: (violation: ConstraintViolation) => Effect.Effect<A2, E2, R2>,
) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E | E2, R | R2>;
export const catchUniqueViolation: <A2, E2, R2>(
  f: (violation: UniqueViolation) => Effect.Effect<A2, E2, R2>,
) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E | E2, R | R2>;
```

Not owned here: `NotFound` / `Unauthorized` / `Forbidden` (application / JSON:API wire vocabulary).
