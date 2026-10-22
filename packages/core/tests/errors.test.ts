/**
 * Unit coverage for `./errors` — the bounded, cycle-guarded walk that recovers
 * a `pg` driver error's facts from wherever it sits in an error graph, and the
 * tagged classification built on top of it.
 *
 * No database: every fixture here is the shape a driver / `@effect/sql-pg` /
 * drizzle failure actually has, including the one captured from a consuming
 * application's CI (a non-enumerable `.cause` holding an Effect `Cause`, with
 * the driver error inside its `reasons`).
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { SqlError, UniqueViolation as SqlUniqueViolation } from "effect/sql/SqlError";
import {
  catchConstraintViolation,
  catchUniqueViolation,
  CheckViolation,
  classifyError,
  DeadlockDetected,
  ExclusionViolation,
  findPgError,
  ForeignKeyViolation,
  isConstraintViolation,
  isRetryableTransactionFailure,
  isUniqueViolation,
  NotNullViolation,
  SerializationFailure,
  UniqueViolation,
} from "../src/errors.ts";
import type { ClassifiedError } from "../src/errors.ts";
import { runPromise } from "./harness.ts";

/**
 * Classifies `error`, asserts which tag came back, and narrows to that member
 * so the test can read the facts only that member carries. One assertion here
 * keeps every case below free of its own cast.
 */
const classifiedAs = <T extends ClassifiedError["_tag"]>(
  error: Parameters<typeof classifyError>[0],
  tag: T,
): ClassifiedError & { readonly _tag: T } => {
  const classified = classifyError(error);
  expect(Option.map(classified, (violation) => violation._tag)).toStrictEqual(Option.some(tag));
  const isRequested = (
    violation: ClassifiedError,
  ): violation is ClassifiedError & { readonly _tag: T } => Predicate.isTagged(violation, tag);
  return Option.getOrElse(Option.filter(classified, isRequested), () =>
    expect.unreachable(`classifyError did not return a ${tag}`),
  );
};

/** Recovers the driver error's facts, failing the test when there are none. */
const factsOf = (error: Parameters<typeof findPgError>[0]) =>
  Option.getOrElse(findPgError(error), () =>
    expect.unreachable("findPgError found no driver error"),
  );

/** A non-driver failure: an `Error` with a message but no SQLSTATE anywhere. */
class Boom extends Schema.TaggedError<Boom>()("Boom", { message: Schema.String }) {}

// ── Fixtures ───────────────────────────────────────────────────────

/**
 * A node-postgres `DatabaseError` as the driver builds it: the SQLSTATE under
 * `code`, and whichever of the other fields Postgres populates for that class.
 */
const pgError = <Fields extends { readonly code: string }>(fields: Fields) => ({
  name: "error",
  severity: "ERROR",
  ...fields,
});

/** Any fixture {@link pgError} builds. */
type PgDriverError = ReturnType<typeof pgError>;

/** Hides `cause` behind a non-enumerable property, as the real wrappers do. */
const withHiddenCause = <T extends object>(error: T, cause: unknown): T => {
  Object.defineProperty(error, "cause", { value: cause, enumerable: false, configurable: true });
  return error;
};

/**
 * The shape captured from a consuming application's CI: drizzle's
 * `EffectDrizzleQueryError` carrying the query, with a NON-enumerable `.cause`
 * holding an Effect `Cause` whose `reasons` array holds the `SqlError`, whose
 * own `cause` is the driver error.
 */
const drizzleWrapped = (driverError: PgDriverError): object =>
  withHiddenCause(
    {
      _tag: "EffectDrizzleQueryError",
      query: "insert into widget (slug) values ($1)",
      params: ["already-taken"],
    },
    {
      reasons: [
        {
          _tag: "Fail",
          error: withHiddenCause({ _tag: "SqlError", message: "SqlError" }, driverError),
        },
      ],
    },
  );

const uniqueFixture = pgError({
  code: "23505",
  message: 'duplicate key value violates unique constraint "widget_slug_unique"',
  constraint: "widget_slug_unique",
  table: "widget",
  schema: "public",
  detail: "Key (slug)=(already-taken) already exists.",
});

const foreignKeyFixture = pgError({
  code: "23503",
  message: 'insert or update on table "widget" violates foreign key constraint "widget_kind_fk"',
  constraint: "widget_kind_fk",
  table: "widget",
  detail: 'Key (kind)=(9) is not present in table "kind".',
});

const notNullFixture = pgError({
  code: "23502",
  message: 'null value in column "slug" of relation "widget" violates not-null constraint',
  column: "slug",
  table: "widget",
});

const checkFixture = pgError({
  code: "23514",
  message: 'new row for relation "widget" violates check constraint "widget_weight_bounds"',
  constraint: "widget_weight_bounds",
  table: "widget",
});

const exclusionFixture = pgError({
  code: "23P01",
  message: 'conflicting key value violates exclusion constraint "widget_span_excl"',
  constraint: "widget_span_excl",
  table: "widget",
});

const serializationFixture = pgError({
  code: "40001",
  message: "could not serialize access due to concurrent update",
});

const deadlockFixture = pgError({
  code: "40P01",
  message: "deadlock detected",
});

// ── findPgError ────────────────────────────────────────────────────

describe("findPgError", () => {
  it("reads every fact off a bare driver error", () => {
    const facts = factsOf(uniqueFixture);
    expect(facts.code).toBe("23505");
    expect(facts.message).toContain("duplicate key value");
    expect(facts.constraint).toStrictEqual(Option.some("widget_slug_unique"));
    expect(facts.table).toStrictEqual(Option.some("widget"));
    expect(facts.schema).toStrictEqual(Option.some("public"));
    expect(facts.detail).toStrictEqual(Option.some("Key (slug)=(already-taken) already exists."));
    expect(facts.column).toStrictEqual(Option.none());
  });

  it("defaults `message` to the empty string when the node carries none", () => {
    const facts = factsOf({ code: "23505" });
    expect(facts.message).toBe("");
    expect(facts.constraint).toStrictEqual(Option.none());
  });

  it("reads the SQLSTATE from `sqlState` as well as `code`", () => {
    expect(Option.map(findPgError({ sqlState: "23505" }), (facts) => facts.code)).toStrictEqual(
      Option.some("23505"),
    );
  });

  it("descends past a wrapper carrying a non-SQLSTATE `code` of its own", () => {
    // An `SqlError` (and a Node `ErrnoException`) has a `code` that is not
    // SQLSTATE-shaped; stopping there would lose the driver error beneath it.
    const facts = findPgError({ code: "SqlError", cause: uniqueFixture });
    expect(Option.map(facts, (f) => f.constraint)).toStrictEqual(
      Option.some(Option.some("widget_slug_unique")),
    );
  });

  it("finds the driver error inside the captured drizzle / Cause shape", () => {
    const facts = factsOf(drizzleWrapped(foreignKeyFixture));
    expect(facts.code).toBe("23503");
    expect(facts.constraint).toStrictEqual(Option.some("widget_kind_fk"));
    expect(facts.table).toStrictEqual(Option.some("widget"));
  });

  it("finds the driver error under a bare `SqlError` from effect/sql", () => {
    const sqlError = new SqlError({
      reason: new SqlUniqueViolation({
        cause: uniqueFixture,
        constraint: "widget_slug_unique",
        message: "widget_slug_unique",
        operation: "insert",
      }),
    });
    const facts = factsOf(sqlError);
    expect(facts.code).toBe("23505");
    // `SqlError.reason` keeps `constraint` but drops table / detail; the walk
    // reaches the driver error underneath, which still has both.
    expect(facts.table).toStrictEqual(Option.some("widget"));
    expect(facts.detail).toStrictEqual(Option.some("Key (slug)=(already-taken) already exists."));
  });

  it("terminates on a cyclic graph, and still finds the driver error in it", () => {
    const outer = { _tag: "Wrapper" };
    const inner = { _tag: "Inner", cause: outer };
    Object.assign(outer, { cause: inner });
    expect(findPgError(outer)).toStrictEqual(Option.none());

    Object.assign(outer, { sibling: checkFixture });
    expect(Option.map(findPgError(outer), (facts) => facts.code)).toStrictEqual(
      Option.some("23514"),
    );
  });

  it("stops at the depth cap", () => {
    const nest = (depth: number): object =>
      Arr.reduce<number, object>(Arr.range(1, depth), uniqueFixture, (node) => ({ cause: node }));
    // The driver error at depth 7 is inside the bound; at depth 8 it is not.
    expect(Option.isSome(findPgError(nest(7)))).toBe(true);
    expect(findPgError(nest(8))).toStrictEqual(Option.none());
  });

  it("is none for a graph with no SQLSTATE and for non-object input", () => {
    expect(findPgError({ cause: { message: "boom" } })).toStrictEqual(Option.none());
    expect(findPgError(new Boom({ message: "boom" }))).toStrictEqual(Option.none());
    expect(findPgError(null)).toStrictEqual(Option.none());
    expect(findPgError("23505")).toStrictEqual(Option.none());
    expect(findPgError(undefined)).toStrictEqual(Option.none());
  });
});

// ── classifyError ──────────────────────────────────────────────────

describe("classifyError", () => {
  it("classifies 23505 as a UniqueViolation carrying constraint, table and detail", () => {
    const wrapped = drizzleWrapped(uniqueFixture);
    const violation = classifiedAs(wrapped, "UniqueViolation");
    expect(violation).toBeInstanceOf(UniqueViolation);
    expect(violation.constraint).toStrictEqual(Option.some("widget_slug_unique"));
    expect(violation.table).toStrictEqual(Option.some("widget"));
    expect(violation.detail).toStrictEqual(
      Option.some("Key (slug)=(already-taken) already exists."),
    );
    // `cause` is the value classification started from, so the drizzle wrapper
    // (query text, params) survives the recovery.
    expect(violation.cause).toBe(wrapped);
  });

  it("classifies 23503 as a ForeignKeyViolation", () => {
    const classified = classifiedAs(foreignKeyFixture, "ForeignKeyViolation");
    expect(classified).toBeInstanceOf(ForeignKeyViolation);
    expect(classified.constraint).toStrictEqual(Option.some("widget_kind_fk"));
    expect(classified.detail).toStrictEqual(
      Option.some('Key (kind)=(9) is not present in table "kind".'),
    );
  });

  it("classifies 23502 as a NotNullViolation carrying the column", () => {
    const classified = classifiedAs(notNullFixture, "NotNullViolation");
    expect(classified).toBeInstanceOf(NotNullViolation);
    expect(classified.column).toStrictEqual(Option.some("slug"));
    expect(classified.table).toStrictEqual(Option.some("widget"));
  });

  it("classifies 23514 as a CheckViolation", () => {
    const classified = classifiedAs(checkFixture, "CheckViolation");
    expect(classified).toBeInstanceOf(CheckViolation);
    expect(classified.constraint).toStrictEqual(Option.some("widget_weight_bounds"));
  });

  it("classifies 23P01 as an ExclusionViolation", () => {
    const classified = classifiedAs(exclusionFixture, "ExclusionViolation");
    expect(classified).toBeInstanceOf(ExclusionViolation);
    expect(classified.constraint).toStrictEqual(Option.some("widget_span_excl"));
  });

  it("classifies 40001 as a SerializationFailure and 40P01 as a DeadlockDetected", () => {
    expect(classifiedAs(serializationFixture, "SerializationFailure")).toBeInstanceOf(
      SerializationFailure,
    );
    expect(classifiedAs(deadlockFixture, "DeadlockDetected")).toBeInstanceOf(DeadlockDetected);
  });

  it("is none for a SQLSTATE outside the classified families, and for a non-error", () => {
    // 42601 is a syntax error: `SqlError.reason` already models it well, so
    // this module leaves it alone rather than inventing a tag for it.
    expect(classifyError(pgError({ code: "42601", message: "syntax error" }))).toStrictEqual(
      Option.none(),
    );
    expect(classifyError("nope")).toStrictEqual(Option.none());
  });
});

// ── Predicates ─────────────────────────────────────────────────────

describe("isUniqueViolation", () => {
  it("detects 23505 on the error itself, on its cause, and under `sqlState`", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { cause: { code: "23505" } } })).toBe(true);
    expect(isUniqueViolation({ cause: { sqlState: "23505" } })).toBe(true);
    expect(isUniqueViolation({ code: "SqlError", cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(drizzleWrapped(uniqueFixture))).toBe(true);
  });

  it("falls back to the pg message fragment when no code survived the wrapping", () => {
    // Parity with the consuming applications: the fallback is part of this
    // predicate's contract, and is deliberately not in `classifyError`.
    expect(
      isUniqueViolation({
        cause: {
          reasons: [
            { error: { message: 'duplicate key value violates unique constraint "foo_unique"' } },
          ],
        },
      }),
    ).toBe(true);
  });

  it("is false for another SQLSTATE, a missing code, or a non-object", () => {
    expect(isUniqueViolation(foreignKeyFixture)).toBe(false);
    expect(isUniqueViolation({ cause: {} })).toBe(false);
    expect(isUniqueViolation(new Boom({ message: "boom" }))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("isConstraintViolation", () => {
  it("is true for each of the five integrity classes", () => {
    Arr.forEach(
      [uniqueFixture, foreignKeyFixture, notNullFixture, checkFixture, exclusionFixture],
      (fixture) => {
        expect(isConstraintViolation(fixture)).toBe(true);
      },
    );
  });

  it("is false for a transaction failure, an unclassified SQLSTATE and a non-error", () => {
    expect(isConstraintViolation(serializationFixture)).toBe(false);
    expect(isConstraintViolation(pgError({ code: "42601" }))).toBe(false);
    expect(isConstraintViolation("nope")).toBe(false);
  });
});

describe("isRetryableTransactionFailure", () => {
  it("is true for 40001 and 40P01 only", () => {
    expect(isRetryableTransactionFailure(serializationFixture)).toBe(true);
    expect(isRetryableTransactionFailure(drizzleWrapped(deadlockFixture))).toBe(true);
    expect(isRetryableTransactionFailure(uniqueFixture)).toBe(false);
    expect(isRetryableTransactionFailure("nope")).toBe(false);
  });
});

// ── Effect combinators ─────────────────────────────────────────────

describe("catchConstraintViolation", () => {
  it("recovers a matching failure with the classified violation", async () => {
    const recovered = await runPromise(
      Effect.fail(drizzleWrapped(notNullFixture)).pipe(
        catchConstraintViolation((violation) =>
          Effect.succeed(`${violation._tag}:${Option.getOrElse(violation.table, () => "?")}`),
        ),
      ),
    );
    expect(recovered).toBe("NotNullViolation:widget");
  });

  it("leaves an unrelated failure untouched", async () => {
    const failure = await runPromise(
      Effect.flip(
        Effect.fail("unrelated").pipe(catchConstraintViolation(() => Effect.succeed("recovered"))),
      ),
    );
    expect(failure).toBe("unrelated");
  });

  it("leaves a retryable transaction failure untouched", async () => {
    const failure = await runPromise(
      Effect.flip(
        Effect.fail(serializationFixture).pipe(
          catchConstraintViolation(() => Effect.succeed("recovered")),
        ),
      ),
    );
    expect(failure).toBe(serializationFixture);
  });

  it("does not touch a success", async () => {
    const value = await runPromise(
      Effect.succeed("ok").pipe(catchConstraintViolation(() => Effect.succeed("recovered"))),
    );
    expect(value).toBe("ok");
  });
});

describe("catchUniqueViolation", () => {
  it("recovers a 23505 with the constraint name", async () => {
    const recovered = await runPromise(
      Effect.fail(drizzleWrapped(uniqueFixture)).pipe(
        catchUniqueViolation((violation) =>
          Effect.succeed(Option.getOrElse(violation.constraint, () => "?")),
        ),
      ),
    );
    expect(recovered).toBe("widget_slug_unique");
  });

  it("passes another constraint violation through unchanged", async () => {
    const failure = await runPromise(
      Effect.flip(
        Effect.fail(foreignKeyFixture).pipe(
          catchUniqueViolation(() => Effect.succeed("recovered")),
        ),
      ),
    );
    expect(failure).toBe(foreignKeyFixture);
  });
});
