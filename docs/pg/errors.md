# Errors against a live database

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

## In the error channel

The context-bound `queries` `makePgDatabase` returns fail with the tagged class directly: a query whose SQLSTATE is one of the seven core classifies (`UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation`, `CheckViolation`, `ExclusionViolation`, `SerializationFailure`, `DeadlockDetected`) has that class in its error type, beside the driver's `EffectDrizzleQueryError` for everything else, so `catchTag` works on the query itself:

```ts
const { insert } = database.queries;

const createWidget = (slug: string) =>
  insert(widgets)
    .values({ slug })
    .returning()
    .pipe(
      Effect.catchTag("UniqueViolation", (violation) =>
        Option.contains(violation.constraint, "widget_slug_key")
          ? Effect.fail(new SlugTaken({ slug }))
          : Effect.die(violation),
      ),
    );
```

A failure raised outside a query is not classified for you: a `COMMIT` that loses a serialization conflict fails `transact` itself, and a query run on a handle (`tx.insert(…)`, `db.select(…)`) carries the driver's error. Pipe core's `classifyErrors` onto those, for example to retry a serializable transaction:

```ts
import { classifyErrors } from "@thomasfosterau/effect-drizzle-ext/Errors";

const transfer = transact(moveFunds).pipe(
  classifyErrors,
  Effect.retry({
    while: (error) =>
      P.isTagged(error, "SerializationFailure") || P.isTagged(error, "DeadlockDetected"),
    times: 3,
  }),
);
```

## Which table and column

Postgres names the table, column and constraint at fault; `database.locate` turns those names back into the Drizzle objects your `relations` declare. It takes any failure (a classified error, the driver's, or a `Cause`) and returns an `Option` of `{ key, table, columns }`, a union discriminated by the relations key, so checking `key` narrows `table` and `columns`:

```ts
const createAuthor = (handle: string, email: string) =>
  insert(authors)
    .values({ handle, email })
    .pipe(
      Effect.catchTag("UniqueViolation", (violation) =>
        Option.match(database.locate(violation), {
          onNone: () => Effect.die(violation),
          onSome: (location) =>
            location.key === "authors" && location.columns.includes(authors.email)
              ? Effect.fail(new EmailTaken({ email }))
              : Effect.fail(new HandleTaken({ handle })),
        }),
      ),
    );
```

`columns` comes from, in order: the column Postgres names (a NOT NULL violation); the constraint Postgres names, matched against the table's primary key, foreign keys, unique constraints, named unique indexes and column-level `.unique()`, by the explicit name or, for an unnamed one, the defaults drizzle-kit and Postgres give it; and, for a unique violation only, the columns in the `DETAIL` line's `Key (…)=(…)`. It is empty when none applies (a CHECK violation). A foreign key violation never falls back to `DETAIL`: deleting a referenced row reports the referencing table but lists the referenced table's key.

`locate` is `Option.none()` when the failure names no table (a serialization failure, a deadlock) or a table `relations` doesn't declare: a temporary table, a table only raw SQL touches, a view, or the same name in another schema (a table declared without a schema matches `public` only). Column names are matched as Drizzle declares them, so a client-level `casing` rename isn't seen.

## Recovering a classification

`classifyError` from [`@thomasfosterau/effect-drizzle-ext/Errors`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/errors.md) recovers a tagged, fact-carrying error from the drizzle / `@effect/sql-pg` error graph a real query raises — `constraint`, `table` and `column` are populated the same way against this driver as they are documented in the core package. `catchUniqueViolation` is the combinator most operations reach for, typically wrapping a `transact`ed write:

```ts
import { catchUniqueViolation } from "@thomasfosterau/effect-drizzle-ext/Errors";

const createWidget = (slug: string) =>
  transact(
    Effect.flatMap(CurrentTransaction, (tx) => tx.insert(widgets).values({ slug }).returning()),
  ).pipe(
    catchUniqueViolation((violation) =>
      violation.constraint._tag === "Some" && violation.constraint.value === "widget_slug_key"
        ? Effect.fail(new SlugTaken({ slug }))
        : Effect.die(violation),
    ),
  );
```

`violation.constraint` / `.table` / `.column` / `.detail` are `Option`s, populated per-SQLSTATE as documented in the core README; for a violation raised against a `TEMPORARY` table, `schema` is the session's temporary schema (`pg_temp_N`), not `public`.
