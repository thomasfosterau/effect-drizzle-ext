/**
 * Integration coverage for `@thomasfosterau/effect-drizzle-ext-pg/Testing`
 * against a real PostgreSQL server — the properties the fake-handle unit test
 * can only model:
 *
 * - **always-rollback.** A row written inside one test transaction is gone by
 *   the next one. This is the only assertion that needs a table OUTSIDE the
 *   transaction: a `TEMPORARY` table created inside it would vanish with the
 *   rollback whether or not the rollback worked, proving nothing. Each block
 *   creates its own committed probe table and drops it after its last spec.
 * - **failure surfacing.** `inTestTransaction` re-raises the body's own
 *   failure; the Promise runner rejects with the underlying error, so
 *   `.rejects.toThrow(/…/)` matches instead of seeing an opaque `Cause`.
 * - **`attemptInSavepoint`.** A statement that raises aborts the whole
 *   PostgreSQL transaction; nesting the attempt in a SAVEPOINT confines the
 *   abort so the enclosing transaction — and every fixture already written in
 *   it — carries on. That is a real server behaviour, not a fake's.
 *
 * @module packages/pg/tests/integration/testing
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/Query";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { integrationDatabaseLayer, integrationLayerWith } from "./database-url.ts";
import { makePgDatabase } from "../../src/PgDatabase.ts";
import { makeTestTransaction } from "../../src/Testing.ts";

const relations = {};
const database = makePgDatabase({ relations, key: "Database" });
const { Database, CurrentTransaction, transact } = database;

/** The spec's own, deliberate failure. */
class SpecFailure extends Schema.TaggedError<SpecFailure>()("SpecFailure", {
  message: Schema.String,
}) {}

const { inTestTransaction, runInTestTransaction, withTestTransaction, attemptInSavepoint } =
  makeTestTransaction(database);

/** Committed DDL, so the rollback assertion has something that could survive. */
const createProbe = (table: string) =>
  Effect.flatMap(Database, (db) =>
    db.execute(sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(table)} (n integer NOT NULL)`),
  );

const dropProbe = (table: string) =>
  Effect.flatMap(Database, (db) => db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(table)}`));

const probeRows = Effect.fn("probe.rows")(function* (table: string) {
  const db = yield* Database;
  const rows = yield* executeRows(
    db,
    sql`SELECT n FROM ${sql.identifier(table)} ORDER BY n`,
    Schema.Struct({ n: Schema.Finite }),
  );
  return rows.map((row) => Number(row.n));
});

const insertProbe = Effect.fn("probe.insert")(function* (table: string, n: number) {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql`INSERT INTO ${sql.identifier(table)} (n) VALUES (${n})`);
});

const EFFECT_PROBE = "rollback_probe_effect";
const PROMISE_PROBE = "rollback_probe_promise";

integrationLayerWith(
  database,
  Layer.effectDiscard(
    Effect.acquireRelease(createProbe(EFFECT_PROBE), () => Effect.orDie(dropProbe(EFFECT_PROBE))),
  ),
)((it) => {
  describe("inTestTransaction against a live database", () => {
    it.effect("rolls back: a row written in one run is absent in the next", () =>
      Effect.gen(function* () {
        yield* inTestTransaction(
          Effect.gen(function* () {
            yield* insertProbe(EFFECT_PROBE, 1);
            // Visible inside the transaction that wrote it …
            expect(yield* probeRows(EFFECT_PROBE)).toEqual([1]);
          }),
        );
        // … and gone the moment the harness transaction rolled back.
        expect(yield* inTestTransaction(probeRows(EFFECT_PROBE))).toEqual([]);
      }),
    );

    it.effect("rolls back when the body fails, and re-raises the body's own failure", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          inTestTransaction(
            Effect.gen(function* () {
              yield* insertProbe(EFFECT_PROBE, 2);
              return yield* new SpecFailure({ message: "the spec decided this run fails" });
            }),
          ),
        );
        expect(failure).toBeInstanceOf(SpecFailure);
        expect(yield* inTestTransaction(probeRows(EFFECT_PROBE))).toEqual([]);
      }),
    );
  });

  describe("attemptInSavepoint against a live database", () => {
    it.effect("captures a constraint rejection and leaves the transaction usable", () =>
      inTestTransaction(
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          yield* tx.execute(
            sql`CREATE TEMPORARY TABLE savepoint_probe (n integer PRIMARY KEY, label text NOT NULL)`,
          );
          yield* tx.execute(sql`INSERT INTO savepoint_probe (n, label) VALUES (1, 'first')`);

          const rejected = yield* attemptInSavepoint(
            Effect.flatMap(CurrentTransaction, (inner) =>
              inner.execute(sql`INSERT INTO savepoint_probe (n, label) VALUES (1, 'duplicate')`),
            ),
          );

          // The savepoint absorbed the abort: without it, every statement below
          // would fail with "current transaction is aborted".
          const db = yield* Database;
          const rows = yield* executeRows(
            db,
            sql`SELECT n, label FROM savepoint_probe ORDER BY n`,
            Schema.Struct({ n: Schema.Finite, label: Schema.String }),
          );
          yield* tx.execute(sql`INSERT INTO savepoint_probe (n, label) VALUES (2, 'after')`);

          expect(rejected._tag).toBe("Failure");
          expect(rows.map((row) => row.label)).toEqual(["first"]);
        }),
      ),
    );

    it.effect("returns a Success Exit and keeps the write when the attempt succeeds", () =>
      inTestTransaction(
        transact(
          Effect.gen(function* () {
            const tx = yield* CurrentTransaction;
            yield* tx.execute(sql`CREATE TEMPORARY TABLE savepoint_ok (n integer NOT NULL)`);
            const attempt = yield* attemptInSavepoint(
              Effect.flatMap(CurrentTransaction, (inner) =>
                inner.execute(sql`INSERT INTO savepoint_ok (n) VALUES (7)`),
              ),
            );
            const db = yield* Database;
            const rows = yield* executeRows(
              db,
              sql`SELECT n FROM savepoint_ok`,
              Schema.Struct({ n: Schema.Finite }),
            );
            expect(Exit.isSuccess(attempt)).toBe(true);
            expect(rows.map((row) => Number(row.n))).toEqual([7]);
          }),
        ),
      ),
    );
  });
});

/**
 * The Promise runner, for suites that drive their own runtime: what it adds
 * over {@link inTestTransaction} is the rejection a plain `it` awaits.
 */
describe("runInTestTransaction against a live database", () => {
  const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));

  beforeAll(() => runtime.runPromise(createProbe(PROMISE_PROBE)));

  afterAll(async () => {
    await runtime.runPromise(dropProbe(PROMISE_PROBE));
    await runtime.dispose();
  });

  test("rolls back: a row written in one run is absent in the next", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* insertProbe(PROMISE_PROBE, 1);
        // Visible inside the transaction that wrote it …
        expect(yield* probeRows(PROMISE_PROBE)).toEqual([1]);
      }),
    );

    // … and gone the moment the harness transaction rolled back.
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        expect(yield* probeRows(PROMISE_PROBE)).toEqual([]);
      }),
    );
  });

  test("rolls back even when the body fails, and rejects with a legible message", async () => {
    await expect(
      runInTestTransaction(
        runtime,
        Effect.gen(function* () {
          yield* insertProbe(PROMISE_PROBE, 2);
          return yield* new SpecFailure({ message: "the spec decided this run fails" });
        }),
      ),
    ).rejects.toThrow(/the spec decided this run fails/);

    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        expect(yield* probeRows(PROMISE_PROBE)).toEqual([]);
      }),
    );
  });

  test("surfaces a driver failure legibly rather than as an opaque Cause", async () => {
    // A genuine SQL fault: the message has to reach the matcher.
    await expect(
      withTestTransaction(runtime)(
        Effect.flatMap(CurrentTransaction, (tx) =>
          tx.execute(sql`SELECT * FROM a_table_that_does_not_exist`),
        ),
      ),
    ).rejects.toThrow(/a_table_that_does_not_exist/);
  });
});
