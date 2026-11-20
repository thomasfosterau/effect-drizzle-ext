/**
 * A `./Predicate` rendered as a Drizzle `WHERE` over a table's or view's
 * columns, failing closed on a column the target lacks. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/predicate.md).
 *
 * @module Where
 */

import {
  and,
  Column,
  eq,
  gt,
  gte,
  inArray,
  is,
  lt,
  lte,
  ne,
  notInArray,
  or,
  SQL,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import type { Comparand, CompareOperator, Predicate, Value } from "./Predicate.ts";
import { isNow } from "./Predicate.ts";

/**
 * A column a predicate reads: a Drizzle column, or an aliased expression a
 * view projects.
 */
export type WhereColumn = PgColumn | SQL.Aliased;

/** The columns a predicate renders over, by the name its nodes use. */
export type WhereColumns = { readonly [column: string]: WhereColumn };

/** The column a field decodes through: itself, or an aliased expression's `mapWith` column. */
const decoderOf = (column: WhereColumn): Option.Option<Column> => {
  if (!is(column, SQL.Aliased)) return Option.some(column);
  const decoder = P.hasProperty(column.sql, "decoder") ? column.sql.decoder : undefined;
  return is(decoder, Column) ? Option.some(decoder) : Option.none();
};

/** Whether a column decodes to a string, and so compares and sorts by code point. */
const isStringColumn = (column: WhereColumn): boolean =>
  Option.exists(decoderOf(column), (decoder) => decoder.dataType.split(" ")[0] === "string");

/**
 * The operand an equality or set test reads: a `uuid` column as its text, so
 * a value that is no UUID compares unequal instead of failing the query.
 */
const operand = (column: WhereColumn): WhereColumn | SQL =>
  Option.exists(decoderOf(column), (decoder) => decoder.getSQLType() === "uuid")
    ? sql`(${column})::text`
    : column;

/** A column's code-point form: `col::text COLLATE "C"`. */
const codePoint = (column: WhereColumn): SQL => sql`(${column})::text COLLATE "C"`;

const operators = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
} as const satisfies { readonly [K in CompareOperator]: string };

const drizzleOperators = { eq, ne, lt, lte, gt, gte } as const;

/** `col <op> value`: a string by code point, anything else through the column's own encoding. */
const compare = (op: CompareOperator, column: WhereColumn, value: Comparand): SQL => {
  const operator = sql.raw(operators[op]);
  if (isNow(value)) return sql`${column} ${operator} now()`;
  if (P.isString(value)) {
    return op === "eq" || op === "ne"
      ? sql`${operand(column)} ${operator} ${value}`
      : sql`${codePoint(column)} ${operator} ${value}`;
  }
  if (P.isNumber(value) && !Number.isFinite(value)) {
    return sql`${column} ${operator} ${sql.raw(value > 0 ? "'Infinity'" : "'-Infinity'")}::float8`;
  }
  const binary: typeof eq = drizzleOperators[op];
  return is(column, SQL.Aliased) ? binary(column, value) : binary(column, value);
};

const inList = (column: WhereColumn, values: ReadonlyArray<Value>, negate: boolean): SQL => {
  const left = operand(column);
  const list = [...values];
  if (is(left, SQL)) return negate ? notInArray(left, list) : inArray(left, list);
  if (is(left, SQL.Aliased)) return negate ? notInArray(left, list) : inArray(left, list);
  return negate ? notInArray(left, list) : inArray(left, list);
};

/**
 * Render `predicate` over `columns` as a `WHERE` condition, or none for
 * `always` (`Option.getOrUndefined` is what Drizzle's `.where` takes).
 *
 * - A node over a column `columns` lacks renders as `NULL` (unknown), so it
 *   admits no row, negated or not: the target fails closed.
 * - Strings order by code point (`col::text COLLATE "C"`); a `uuid` column
 *   compares as text for equality and lists, so a malformed id matches nothing.
 * - `inSet` is `col IN (<subquery>)`; its negation is the exact complement,
 *   `(col IS NULL OR col NOT IN (<subquery>))`.
 * - `now` is the database's `now()`.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import * as Predicate from "@thomasfosterau/effect-drizzle-ext/Predicate";
 * import * as Where from "@thomasfosterau/effect-drizzle-ext/Where";
 * import { getColumns } from "drizzle-orm";
 * import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
 * import * as Option from "effect/Option";
 *
 * const posts = pgTable("posts", { visibility: text("visibility"), ownerId: text("owner_id") });
 * const where = Where.render(
 *   Predicate.and(Predicate.eq("visibility", "public"), Predicate.eq("ownerId", "u-1")),
 *   getColumns(posts),
 * );
 * const query = new PgDialect().sqlToQuery(Option.getOrThrow(where));
 * strictEqual(query.sql, '(("posts"."visibility" = $1) and ("posts"."owner_id" = $2))');
 * ```
 */
export const render = (
  predicate: Predicate<SQLWrapper>,
  columns: WhereColumns,
): Option.Option<SQL> =>
  P.isTagged(predicate, "Always") ? Option.none() : Option.some(node(predicate, columns));

const node = (predicate: Predicate<SQLWrapper>, columns: WhereColumns): SQL => {
  const withColumn = (name: string, f: (column: WhereColumn) => SQL): SQL =>
    Option.match(R.get(columns, name), { onNone: () => sql`NULL`, onSome: f });
  return Match.value(predicate).pipe(
    Match.tagsExhaustive({
      Always: () => sql`true`,
      Never: () => sql`false`,
      Unknown: () => sql`NULL`,
      Compare: ({ op, column, value }) => withColumn(column, (c) => compare(op, c, value)),
      In: ({ column, values }) => withColumn(column, (c) => inList(c, values, false)),
      NotIn: ({ column, values }) => withColumn(column, (c) => inList(c, values, true)),
      InSet: ({ column, set, negated }) =>
        withColumn(column, (c) =>
          negated ? sql`(${c} IS NULL OR ${c} NOT IN (${set}))` : sql`${c} IN (${set})`,
        ),
      IsNull: ({ column }) => withColumn(column, (c) => sql`${c} IS NULL`),
      And: ({ members }) =>
        Option.getOrElse(
          Option.fromUndefinedOr(and(...Arr.map(members, (m) => node(m, columns)))),
          () => sql`true`,
        ),
      Or: ({ members }) =>
        Option.getOrElse(
          Option.fromUndefinedOr(or(...Arr.map(members, (m) => node(m, columns)))),
          () => sql`false`,
        ),
      Not: ({ member }) => sql`(not ${node(member, columns)})`,
    }),
  );
};

/**
 * A column's code-point sort key when it decodes to a string, none otherwise:
 * the `ORDER BY` / `DISTINCT` form that agrees with how {@link render}
 * compares strings.
 */
export const codePointKey = (column: WhereColumn): Option.Option<SQL> =>
  isStringColumn(column) ? Option.some(codePoint(column)) : Option.none();
