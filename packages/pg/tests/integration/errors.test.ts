/**
 * The proof of `@thomasfosterau/effect-drizzle-ext/errors` against the live
 * driver: raise each constraint violation for real and assert `classifyError`
 * recovers the tagged class AND the facts.
 *
 * This spec is the one that cannot be faked. The core module classifies a
 * shape it recognises structurally — a node carrying a SQLSTATE, found by
 * walking `EffectDrizzleQueryError` → its `Cause` → `SqlError` → the driver
 * error. Whether that shape is what `drizzle-orm/effect-postgres` and
 * `@effect/sql-pg` actually produce, and which of `constraint` / `table` /
 * `column` PostgreSQL populates for each SQLSTATE, is a question about three
 * libraries and a server, so it is answered here rather than against a
 * fixture.
 *
 * Every violation is raised inside `attemptInSavepoint`: a statement that
 * raises aborts the whole transaction, so without the savepoint the first
 * assertion would poison every later one.
 *
 * @module packages/pg/tests/integration/errors
 */

import { classifyError } from "@thomasfosterau/effect-drizzle-ext/errors";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { assert, describe, expect } from "vite-plus/test";
import { integrationLayer } from "./database-url.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";

const relations = {};
const database = makePgDatabase({ relations, key: "Database" });
const { CurrentTransaction } = database;

const { inTestTransaction, attemptInSavepoint } = makeTestTransaction(database);

/**
 * Two `TEMPORARY` tables carrying one constraint of each class, with every
 * constraint NAMED so the assertions can pin the name the library recovers
 * rather than whatever PostgreSQL would have generated.
 */
const seed = Effect.fn("errors.seed")(function* () {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql`CREATE TEMPORARY TABLE edx_parent (id integer PRIMARY KEY)`);
  yield* tx.execute(sql`
    CREATE TEMPORARY TABLE edx_child (
      id integer PRIMARY KEY,
      parent_id integer NOT NULL CONSTRAINT edx_child_parent_fkey REFERENCES edx_parent (id),
      slug text NOT NULL CONSTRAINT edx_child_slug_key UNIQUE,
      score integer NOT NULL CONSTRAINT edx_child_score_positive CHECK (score > 0)
    )
  `);
  yield* tx.execute(sql`INSERT INTO edx_parent (id) VALUES (1)`);
  yield* tx.execute(
    sql`INSERT INTO edx_child (id, parent_id, slug, score) VALUES (1, 1, 'first', 10)`,
  );
});

/**
 * Raise `statement` inside a SAVEPOINT and hand back what `classifyError`
 * makes of the captured `Cause` — the value a consumer's `Effect.catch`
 * would be handed.
 */
const classifyRejection = Effect.fn("errors.classifyRejection")(function* (statement: string) {
  const attempt = yield* attemptInSavepoint(
    Effect.flatMap(CurrentTransaction, (tx) => tx.execute(sql.raw(statement))),
  );
  assert(Exit.isFailure(attempt), "unreachable: the statement should have failed");
  return classifyError(attempt.cause);
});

/** Unwrap a classification the spec has just asserted is present. */
const classified = <A>(option: Option.Option<A>): A => {
  expect(Option.isSome(option)).toBe(true);
  return Option.match(option, {
    onNone: () => expect.unreachable("expected a classification"),
    onSome: (value) => value,
  });
};

integrationLayer(database)((it) => {
  describe("classifyError against the live driver", () => {
    it.effect("classifies a unique violation (23505) with its constraint and table", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const violation = classified(
            yield* classifyRejection(
              `INSERT INTO edx_child (id, parent_id, slug, score) VALUES (2, 1, 'first', 10)`,
            ),
          );
          expect(violation._tag).toBe("UniqueViolation");
          expect(violation).toMatchObject({ _tag: "UniqueViolation" });
          if (!P.isTagged(violation, "UniqueViolation")) return;
          expect(violation.constraint).toEqual(Option.some("edx_child_slug_key"));
          expect(violation.table).toEqual(Option.some("edx_child"));
          expect(Option.isSome(violation.detail)).toBe(true);
        }),
      ),
    );

    it.effect("classifies a foreign key violation (23503) with its constraint and table", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const violation = classified(
            yield* classifyRejection(
              `INSERT INTO edx_child (id, parent_id, slug, score) VALUES (3, 99, 'third', 10)`,
            ),
          );
          expect(violation._tag).toBe("ForeignKeyViolation");
          if (!P.isTagged(violation, "ForeignKeyViolation")) return;
          expect(violation.constraint).toEqual(Option.some("edx_child_parent_fkey"));
          expect(violation.table).toEqual(Option.some("edx_child"));
          expect(Option.isSome(violation.detail)).toBe(true);
        }),
      ),
    );

    it.effect("classifies a not-null violation (23502) with its column and table", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const violation = classified(
            yield* classifyRejection(
              `INSERT INTO edx_child (id, parent_id, slug, score) VALUES (4, 1, NULL, 10)`,
            ),
          );
          expect(violation._tag).toBe("NotNullViolation");
          if (!P.isTagged(violation, "NotNullViolation")) return;
          expect(violation.column).toEqual(Option.some("slug"));
          expect(violation.table).toEqual(Option.some("edx_child"));
        }),
      ),
    );

    it.effect("classifies a check violation (23514) with its constraint and table", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const violation = classified(
            yield* classifyRejection(
              `INSERT INTO edx_child (id, parent_id, slug, score) VALUES (5, 1, 'fifth', 0)`,
            ),
          );
          expect(violation._tag).toBe("CheckViolation");
          if (!P.isTagged(violation, "CheckViolation")) return;
          expect(violation.constraint).toEqual(Option.some("edx_child_score_positive"));
          expect(violation.table).toEqual(Option.some("edx_child"));
        }),
      ),
    );

    it.effect("leaves an unclassified SQLSTATE alone (42P01 — undefined table)", () =>
      inTestTransaction(
        Effect.gen(function* () {
          const outcome = yield* classifyRejection(`SELECT * FROM edx_no_such_table`);
          // Not one of the seven the library tags: `SqlError.reason` already
          // models the syntax/undefined-object classes well enough.
          expect(Option.isNone(outcome)).toBe(true);
        }),
      ),
    );

    it.effect("keeps the driver's wrapper as the tagged error's cause", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const violation = classified(
            yield* classifyRejection(
              `INSERT INTO edx_child (id, parent_id, slug, score) VALUES (6, 1, 'first', 10)`,
            ),
          );
          // The value classification started from, so the query text and params
          // the drizzle wrapper carries survive the recovery.
          expect(violation.cause).toBeDefined();
        }),
      ),
    );
  });

  describe("the context-bound queries against the live driver", () => {
    const { execute } = database.queries;

    it.effect("fail with the tagged class, so catchTag reads the facts directly", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const attempt = yield* attemptInSavepoint(
            execute(
              sql.raw(
                `INSERT INTO edx_child (id, parent_id, slug, score) VALUES (7, 1, 'first', 10)`,
              ),
            ),
          );
          assert(Exit.isFailure(attempt), "unreachable: the statement should have failed");
          // An `Exit` is an Effect: re-running it re-raises the failure.
          const constraint = yield* attempt.pipe(
            Effect.as(Option.none<string>()),
            Effect.catchTag("UniqueViolation", (violation) => Effect.succeed(violation.constraint)),
          );
          expect(constraint).toEqual(Option.some("edx_child_slug_key"));
        }),
      ),
    );

    it.effect("leave an unclassified failure as the driver's error", () =>
      inTestTransaction(
        Effect.gen(function* () {
          const attempt = yield* attemptInSavepoint(
            execute(sql.raw(`SELECT * FROM edx_no_such_table`)),
          );
          assert(Exit.isFailure(attempt), "unreachable: the statement should have failed");
          const failure = yield* Effect.flip(attempt);
          expect(P.isTagged(failure, "EffectDrizzleQueryError")).toBe(true);
        }),
      ),
    );
  });
});
