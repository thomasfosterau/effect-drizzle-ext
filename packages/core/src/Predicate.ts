/**
 * A neutral row predicate: plain data that a JSON:API `Filter.Ast`, a list
 * filter or a query language compiles to, `./Where` renders as SQL, and
 * {@link evaluate} checks in memory with the same three-valued logic. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/core/predicate.md).
 *
 * @module Predicate
 */

import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";

/**
 * The database's own clock, as a comparand: `now()` in SQL, the caller's
 * instant in {@link evaluate}.
 */
export interface Now {
  readonly _tag: "Now";
}

/** The comparand {@link Now} names. */
export const now: Now = { _tag: "Now" };

/** Whether a comparand is {@link now}. */
export const isNow = (value: Comparand): value is Now => P.isTagged(value, "Now");

/** A literal a column is compared with. `NULL` is never one: {@link isNull} names it. */
export type Value = string | number | bigint | boolean | Date;

/** A comparand: a literal, or {@link now}. */
export type Comparand = Value | Now;

/** The six comparison operators, named as JSON:API's filter core names them. */
export type CompareOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

/**
 * The largest literal set {@link isIn} / {@link notIn} accept; a longer one
 * is {@link unknown}, so a request can't grow a statement without bound.
 */
export const MAX_SET_VALUES = 1000;

/** Every row. */
export interface Always {
  readonly _tag: "Always";
}

/** No row. */
export interface Never {
  readonly _tag: "Never";
}

/**
 * SQL's unknown (`NULL`): no row, and still no row under {@link not}. What a
 * node over a column the target lacks, or an unorderable comparand, becomes.
 */
export interface Unknown {
  readonly _tag: "Unknown";
}

/** `column <op> value`. A `NULL` column is unknown. */
export interface Compare {
  readonly _tag: "Compare";
  readonly op: CompareOperator;
  readonly column: string;
  readonly value: Comparand;
}

/** `column IN (…values)` over a non-empty literal list. */
export interface In {
  readonly _tag: "In";
  readonly column: string;
  readonly values: Arr.NonEmptyReadonlyArray<Value>;
}

/** `column NOT IN (…values)` over a non-empty literal list. A `NULL` column is unknown. */
export interface NotIn {
  readonly _tag: "NotIn";
  readonly column: string;
  readonly values: Arr.NonEmptyReadonlyArray<Value>;
}

/**
 * Membership of a set the caller builds (a SQL subquery, a follower list), a
 * value of `Set`. Two-valued, unlike {@link NotIn}: `negated` is the exact
 * complement, so a `NULL` column is outside the set.
 */
export interface InSet<Set> {
  readonly _tag: "InSet";
  readonly column: string;
  readonly set: Set;
  readonly negated: boolean;
}

/** `column IS NULL`. */
export interface IsNull {
  readonly _tag: "IsNull";
  readonly column: string;
}

/** Every member; no members is {@link Always}. */
export interface And<Set> {
  readonly _tag: "And";
  readonly members: ReadonlyArray<Predicate<Set>>;
}

/** Any member; no members is {@link Never}. */
export interface Or<Set> {
  readonly _tag: "Or";
  readonly members: ReadonlyArray<Predicate<Set>>;
}

/** The complement, in three-valued logic: `not(unknown)` is unknown. */
export interface Not<Set> {
  readonly _tag: "Not";
  readonly member: Predicate<Set>;
}

/**
 * A predicate over named columns. `Set` is what an {@link InSet} node carries:
 * a Drizzle subquery for `./Where`, a membership test for {@link evaluate},
 * `never` where there is none.
 */
export type Predicate<Set = never> =
  | Always
  | Never
  | Unknown
  | Compare
  | In
  | NotIn
  | InSet<Set>
  | IsNull
  | And<Set>
  | Or<Set>
  | Not<Set>;

/** Every row. */
export const always: Always = { _tag: "Always" };

/** No row. */
export const never: Never = { _tag: "Never" };

/** SQL's unknown: no row, negated or not. */
export const unknown: Unknown = { _tag: "Unknown" };

/** `NaN`, or an invalid `Date`: a comparand with no place in any order. */
export const isUnorderable = (value: Comparand): boolean =>
  (P.isNumber(value) && Number.isNaN(value)) || (P.isDate(value) && Number.isNaN(value.getTime()));

const compareWith =
  (op: CompareOperator) =>
  (column: string, value: Comparand): Compare | Unknown =>
    isUnorderable(value) ? unknown : { _tag: "Compare", op, column, value };

/** `column = value`. */
export const eq = compareWith("eq");
/** `column <> value`. */
export const ne = compareWith("ne");
/** `column < value`. */
export const lt = compareWith("lt");
/** `column <= value`. */
export const lte = compareWith("lte");
/** `column > value`. */
export const gt = compareWith("gt");
/** `column >= value`. */
export const gte = compareWith("gte");

const boundedSet = (values: ReadonlyArray<Value>): Option.Option<ReadonlyArray<Value>> =>
  values.length > MAX_SET_VALUES || Arr.some(values, isUnorderable)
    ? Option.none()
    : Option.some(values);

/**
 * `column IN (…values)`. No values is {@link never}; more than
 * {@link MAX_SET_VALUES}, or one unorderable, is {@link unknown}.
 */
export const isIn = (column: string, values: ReadonlyArray<Value>): In | Never | Unknown =>
  Option.match(boundedSet(values), {
    onNone: () => unknown,
    onSome: (bounded) =>
      Arr.isReadonlyArrayNonEmpty(bounded) ? { _tag: "In", column, values: bounded } : never,
  });

/**
 * `column NOT IN (…values)`. No values is {@link always} (every row, a `NULL`
 * column included); more than {@link MAX_SET_VALUES}, or one unorderable, is
 * {@link unknown}.
 */
export const notIn = (column: string, values: ReadonlyArray<Value>): NotIn | Always | Unknown =>
  Option.match(boundedSet(values), {
    onNone: () => unknown,
    onSome: (bounded) =>
      Arr.isReadonlyArrayNonEmpty(bounded) ? { _tag: "NotIn", column, values: bounded } : always,
  });

/** `column` is a member of `set`. */
export const inSet = <Set>(column: string, set: Set): InSet<Set> => ({
  _tag: "InSet",
  column,
  set,
  negated: false,
});

/** `column` is not a member of `set`, a `NULL` column included. */
export const notInSet = <Set>(column: string, set: Set): InSet<Set> => ({
  _tag: "InSet",
  column,
  set,
  negated: true,
});

/** `column IS NULL`. */
export const isNull = (column: string): IsNull => ({ _tag: "IsNull", column });

/** The column {@link locale} reads. */
export const LOCALE_COLUMN = "locale";

/**
 * The row's `locale` column is one of `locales`: a keyed fact view's language
 * filter. Over a target with no `locale` column it is {@link unknown}.
 */
export const locale = (locales: ReadonlyArray<string>): In | Never | Unknown =>
  isIn(LOCALE_COLUMN, locales);

/**
 * Every member, flattened and simplified: a {@link never} member makes the
 * whole {@link never}, {@link always} members drop out, one member stands
 * alone and none is {@link always}.
 */
export const and = <Set = never>(...members: ReadonlyArray<Predicate<Set>>): Predicate<Set> => {
  const flat = Arr.flatMap(members, (m) => (P.isTagged(m, "And") ? m.members : [m]));
  if (Arr.some(flat, P.isTagged("Never"))) return never;
  return collapse(Arr.filter(flat, P.not(P.isTagged("Always"))), always, (parts) => ({
    _tag: "And",
    members: parts,
  }));
};

/**
 * Any member, flattened and simplified: an {@link always} member makes the
 * whole {@link always}, {@link never} members drop out, one member stands
 * alone and none is {@link never}.
 */
export const or = <Set = never>(...members: ReadonlyArray<Predicate<Set>>): Predicate<Set> => {
  const flat = Arr.flatMap(members, (m) => (P.isTagged(m, "Or") ? m.members : [m]));
  if (Arr.some(flat, P.isTagged("Always"))) return always;
  return collapse(Arr.filter(flat, P.not(P.isTagged("Never"))), never, (parts) => ({
    _tag: "Or",
    members: parts,
  }));
};

/** The complement: swaps {@link always} and {@link never}, unwraps a double negation, keeps {@link unknown}. */
export const not = <Set = never>(member: Predicate<Set>): Predicate<Set> =>
  Match.value(member).pipe(
    Match.tag("Always", (): Predicate<Set> => never),
    Match.tag("Never", (): Predicate<Set> => always),
    Match.tag("Unknown", (): Predicate<Set> => unknown),
    Match.tag("Not", (m) => m.member),
    Match.orElse((m): Predicate<Set> => ({ _tag: "Not", member: m })),
  );

const collapse = <Set>(
  parts: ReadonlyArray<Predicate<Set>>,
  identity: Predicate<Set>,
  combine: (parts: Arr.NonEmptyReadonlyArray<Predicate<Set>>) => Predicate<Set>,
): Predicate<Set> =>
  Arr.match(parts, {
    onEmpty: () => identity,
    onNonEmpty: (nonEmpty) =>
      Arr.isReadonlyArrayNonEmpty(Arr.tailNonEmpty(nonEmpty))
        ? combine(nonEmpty)
        : Arr.headNonEmpty(nonEmpty),
  });

/** Every column a predicate names, once each, in first-seen order. */
export const columns = <Set>(predicate: Predicate<Set>): ReadonlyArray<string> => {
  const walk = (p: Predicate<Set>): ReadonlyArray<string> =>
    Match.value(p).pipe(
      Match.tags({
        And: ({ members }) => Arr.flatMap(members, walk),
        Or: ({ members }) => Arr.flatMap(members, walk),
        Not: ({ member }) => walk(member),
        Compare: ({ column }) => [column],
        In: ({ column }) => [column],
        NotIn: ({ column }) => [column],
        InSet: ({ column }) => [column],
        IsNull: ({ column }) => [column],
      }),
      Match.orElse(() => []),
    );
  return Arr.dedupe(walk(predicate));
};

/** Replace every {@link InSet}'s set. */
export const mapSets = <A, B>(predicate: Predicate<A>, f: (set: A) => B): Predicate<B> =>
  Match.value(predicate).pipe(
    Match.tags({
      InSet: (node): Predicate<B> => ({ ...node, set: f(node.set) }),
      And: ({ members }): Predicate<B> => ({
        _tag: "And",
        members: Arr.map(members, (m) => mapSets(m, f)),
      }),
      Or: ({ members }): Predicate<B> => ({
        _tag: "Or",
        members: Arr.map(members, (m) => mapSets(m, f)),
      }),
      Not: ({ member }): Predicate<B> => ({ _tag: "Not", member: mapSets(member, f) }),
    }),
    Match.orElse((node): Predicate<B> => node),
  );

// ── In memory ─────────────────────────

/** A row {@link evaluate} reads, as Drizzle selects one: column name → value, `null` for SQL `NULL`. */
export type Row = { readonly [column: string]: Value | null };

/** What {@link evaluate} needs beyond the row. */
export interface EvaluateContext<Set> {
  /** The instant {@link now} stands for. */
  readonly now: Date;
  /** Membership of an {@link InSet}'s set. */
  readonly member: (set: Set, value: Value) => boolean;
}

/** Kleene's three values: `some(true)`, `some(false)`, and unknown as `none`. */
type Truth = Option.Option<boolean>;

const unknownTruth: Truth = Option.none();

const kleeneAnd = (values: ReadonlyArray<Truth>): Truth =>
  Arr.some(values, (v) => Option.contains(v, false))
    ? Option.some(false)
    : Arr.some(values, Option.isNone)
      ? unknownTruth
      : Option.some(true);

const kleeneOr = (values: ReadonlyArray<Truth>): Truth =>
  Arr.some(values, (v) => Option.contains(v, true))
    ? Option.some(true)
    : Arr.some(values, Option.isNone)
      ? unknownTruth
      : Option.some(false);

/** A value's place in an order: strings by code point, instants by time, everything else as is. */
const orderKey = (value: Value): string | number | bigint | boolean =>
  P.isDate(value) ? value.getTime() : value;

const codePoints = (text: string): ReadonlyArray<number> =>
  Arr.map(Array.from(text), (char) => char.codePointAt(0) ?? 0);

const byCodePoint = (a: string, b: string): number => {
  const left = codePoints(a);
  const right = codePoints(b);
  return Option.getOrElse(
    Arr.findFirst(
      Arr.zipWith(left, right, (x, y) => x - y),
      (delta) => delta !== 0,
    ),
    () => left.length - right.length,
  );
};

/** `a` against `b`, or none when they are not of one type. */
const compareValues = (a: Value, b: Value): Option.Option<number> => {
  const x = orderKey(a);
  const y = orderKey(b);
  if (P.isString(x) && P.isString(y)) return Option.some(byCodePoint(x, y));
  if ((P.isNumber(x) || P.isBigInt(x)) && (P.isNumber(y) || P.isBigInt(y))) {
    return Option.some(x < y ? -1 : x > y ? 1 : 0);
  }
  if (P.isBoolean(x) && P.isBoolean(y)) return Option.some(Number(x) - Number(y));
  return Option.none();
};

const holds = (op: CompareOperator, order: number): boolean =>
  Match.value(op).pipe(
    Match.when("eq", () => order === 0),
    Match.when("ne", () => order !== 0),
    Match.when("lt", () => order < 0),
    Match.when("lte", () => order <= 0),
    Match.when("gt", () => order > 0),
    Match.when("gte", () => order >= 0),
    Match.exhaustive,
  );

/**
 * Whether `row` satisfies `predicate`, as `./Where`'s SQL decides it: SQL's
 * three-valued logic, a `NULL` or absent column unknown in every comparison,
 * strings by code point, and only a `true` result keeping the row.
 * A comparison across types (a string column against a number) is unknown.
 */
export const evaluate = <Set>(
  predicate: Predicate<Set>,
  row: Row,
  context: EvaluateContext<Set>,
): boolean => Option.contains(truth(predicate, row, context), true);

const within = (value: Value, values: ReadonlyArray<Value>): boolean =>
  Arr.some(values, (v) => Option.contains(compareValues(value, v), 0));

const truth = <Set>(predicate: Predicate<Set>, row: Row, context: EvaluateContext<Set>): Truth => {
  const cell = (column: string): Option.Option<Value> =>
    Option.flatMap(R.get(row, column), Option.fromNullOr);
  return Match.value(predicate).pipe(
    Match.tagsExhaustive({
      Always: (): Truth => Option.some(true),
      Never: (): Truth => Option.some(false),
      Unknown: (): Truth => unknownTruth,
      Compare: ({ op, column, value }) =>
        Option.flatMap(cell(column), (v) =>
          Option.map(compareValues(v, isNow(value) ? context.now : value), (order) =>
            holds(op, order),
          ),
        ),
      In: ({ column, values }) => Option.map(cell(column), (v) => within(v, values)),
      NotIn: ({ column, values }) => Option.map(cell(column), (v) => !within(v, values)),
      InSet: ({ column, set, negated }) =>
        Option.match(cell(column), {
          onNone: (): Truth => (negated ? Option.some(true) : unknownTruth),
          onSome: (v) => Option.some(context.member(set, v) !== negated),
        }),
      IsNull: ({ column }) => Option.some(Option.isNone(cell(column))),
      And: ({ members }) => kleeneAnd(Arr.map(members, (m) => truth(m, row, context))),
      Or: ({ members }) => kleeneOr(Arr.map(members, (m) => truth(m, row, context))),
      Not: ({ member }) => Option.map(truth(member, row, context), (inner) => !inner),
    }),
  );
};
