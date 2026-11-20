# `./Predicate` and `./Where`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

A **neutral row predicate**: plain data that every filter language an application speaks compiles to once, and that renders to SQL and evaluates in memory with the same answer. A JSON:API `Filter.Ast` compiles to it (`predicateFromFilter` in `./jsonapi`); a list filter or a query language can do the same.

`./Predicate` is Drizzle-free, so a client bundle can build predicates. `./Where` renders one over a table's or view's columns.

## The nodes

| Node | Constructor | Meaning |
| --- | --- | --- |
| `Always`, `Never` | `always`, `never` | Every row, no row. |
| `Unknown` | `unknown` | SQL's `NULL`: no row, and still no row under `not`. |
| `Compare` | `eq` `ne` `lt` `lte` `gt` `gte` | `column <op> value`. The value may be `now`, the database's clock. |
| `In`, `NotIn` | `isIn`, `notIn` | Membership of a literal list, at most `MAX_SET_VALUES` (1000). |
| `InSet` | `inSet`, `notInSet` | Membership of a set the caller builds: a Drizzle subquery for `./Where`, a membership test for `evaluate`. |
| `IsNull` | `isNull` | `column IS NULL`. |
| `And`, `Or`, `Not` | `and`, `or`, `not` | Combinators. The constructors flatten and simplify. |

`locale(locales)` is `isIn("locale", locales)`, the language filter over a keyed fact view.

## Semantics

These hold in both `Where.render` and `Predicate.evaluate`, and the integration suite checks that the two keep the same rows:

- **Three-valued logic.** A `NULL` column is unknown in every comparison and list test, so `not(eq(c, v))` doesn't match a `NULL` `c`. Only a true result keeps a row.
- **Fail closed.** A node over a column the target lacks renders as `NULL`, so it matches no row, negated or not. So does an unorderable comparand (`NaN`, an invalid `Date`) and an oversized list. A literal `predicateFromFilter` can't read does the same.
- **Strings compare by code point** (`col::text COLLATE "C"`), never by the database's collation. `Where.codePointKey` gives the matching `ORDER BY` form.
- **A `uuid` column compares as text** for equality and lists, so a malformed id matches nothing instead of failing the statement.
- **Set membership is two-valued when negated.** `notInSet` is the exact complement of `inSet`, `(col IS NULL OR col NOT IN (<subquery>))`, so a server-built set never leaves rows in neither.

```ts
import * as Predicate from "@thomasfosterau/effect-drizzle-ext/Predicate";
import * as Where from "@thomasfosterau/effect-drizzle-ext/Where";
import { predicateFromFilter } from "@thomasfosterau/effect-drizzle-ext/jsonapi";

const scope = Predicate.or(Predicate.eq("visibility", "public"), Predicate.eq("ownerId", viewer));
const predicate = Predicate.and(scope, predicateFromFilter(query.filter));
db.select()
  .from(view)
  .where(Option.getOrUndefined(Where.render(predicate, getColumns(view))));
```

`predicateFromFilter` keeps field names as they are; `./Where` maps them through the columns record you pass. Its `literal` option reads a decoded literal per field. By default it takes strings, numbers, bigints, booleans and `Date`s, and an Effect `DateTime` as its `Date`.
