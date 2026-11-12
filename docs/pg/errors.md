# Errors against a live database

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

`classifyError` from [`@thomasfosterau/effect-drizzle-ext/errors`](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/errors.md) recovers a tagged, fact-carrying error from the drizzle / `@effect/sql-pg` error graph a real query raises — `constraint`, `table` and `column` are populated the same way against this driver as they are documented in the core package. `catchUniqueViolation` is the combinator most operations reach for, typically wrapping a `transact`ed write:

```ts
import { catchUniqueViolation } from "@thomasfosterau/effect-drizzle-ext/errors";

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
