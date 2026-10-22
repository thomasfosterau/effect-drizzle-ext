/**
 * Integration coverage for `@thomasfosterau/effect-drizzle-ext-pg/testing`
 * against a real PostgreSQL server — the three properties the fake-handle
 * unit test can only model:
 *
 * - **always-rollback.** A row written inside one `runInTestTransaction` is
 *   gone by the next one. This is the only assertion that needs a table
 *   OUTSIDE the transaction: a `TEMPORARY` table created inside it would
 *   vanish with the rollback whether or not the rollback worked, proving
 *   nothing. The table is created once for this spec and dropped after it.
 * - **legible failure projection.** A failing body rejects with the
 *   underlying error, so `.rejects.toThrow(/…/)` matches instead of seeing an
 *   opaque `Cause`.
 * - **`attemptInSavepoint`.** A statement that raises aborts the whole
 *   PostgreSQL transaction; nesting the attempt in a SAVEPOINT confines the
 *   abort so the enclosing transaction — and every fixture already written in
 *   it — carries on. That is a real server behaviour, not a fake's.
 *
 * @module packages/pg/tests/integration/testing
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction, testDatabaseLayer } from "../../src/testing.ts";

const relations = {};
const database = makePgDatabase({ relations, key: "Database" });
const { Database, CurrentTransaction, transact } = database;

/** The spec's own, deliberate failure. */
class SpecFailure extends Schema.TaggedError<SpecFailure>()("SpecFailure", {
  message: Schema.String,
}) {}

const url = Redacted.make(process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? "");
const runtime = ManagedRuntime.make(testDatabaseLayer(database, { url }));
const { runInTestTransaction, withTestTransaction, attemptInSavepoint } =
  makeTestTransaction(database);

/** Committed DDL, so the rollback assertion has something that could survive. */
const createRollbackProbe = Effect.flatMap(Database, (db) =>
  db.execute(sql`CREATE TABLE IF NOT EXISTS rollback_probe (n integer NOT NULL)`),
);

const dropRollbackProbe = Effect.flatMap(Database, (db) =>
  db.execute(sql`DROP TABLE IF EXISTS rollback_probe`),
);

const rollbackProbeRows = Effect.fn("rollbackProbe.rows")(function* () {
  const db = yield* Database;
  const rows = yield* executeRows<{ n: number }>(db, sql`SELECT n FROM rollback_probe ORDER BY n`);
  return rows.map((row) => Number(row.n));
});

beforeAll(async () => {
  await runtime.runPromise(createRollbackProbe);
});

afterAll(async () => {
  await runtime.runPromise(dropRollbackProbe);
});

describe("runInTestTransaction against a live database", () => {
  it("rolls back: a row written in one run is absent in the next", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(sql`INSERT INTO rollback_probe (n) VALUES (1)`);
        // Visible inside the transaction that wrote it …
        expect(yield* rollbackProbeRows()).toEqual([1]);
      }),
    );

    // … and gone the moment the harness transaction rolled back.
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        expect(yield* rollbackProbeRows()).toEqual([]);
      }),
    );
  });

  it("rolls back even when the body fails, and rejects with a legible message", async () => {
    await expect(
      runInTestTransaction(
        runtime,
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          yield* tx.execute(sql`INSERT INTO rollback_probe (n) VALUES (2)`);
          return yield* Effect.fail(
            new SpecFailure({ message: "the spec decided this run fails" }),
          );
        }),
      ),
    ).rejects.toThrow(/the spec decided this run fails/);

    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        expect(yield* rollbackProbeRows()).toEqual([]);
      }),
    );
  });

  it("surfaces a driver failure legibly rather than as an opaque Cause", async () => {
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

describe("attemptInSavepoint against a live database", () => {
  it("captures a constraint rejection and leaves the transaction usable", async () => {
    const outcome = await runInTestTransaction(
      runtime,
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
        const rows = yield* executeRows<{ n: number; label: string }>(
          db,
          sql`SELECT n, label FROM savepoint_probe ORDER BY n`,
        );
        yield* tx.execute(sql`INSERT INTO savepoint_probe (n, label) VALUES (2, 'after')`);

        return { rejected: rejected._tag, rows: rows.map((row) => row.label) };
      }),
    );

    expect(outcome).toEqual({ rejected: "Failure", rows: ["first"] });
  });

  it("returns a Success Exit and keeps the write when the attempt succeeds", async () => {
    const outcome = await runInTestTransaction(
      runtime,
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
          const rows = yield* executeRows<{ n: number }>(db, sql`SELECT n FROM savepoint_ok`);
          return { attempt: Exit.isSuccess(attempt), rows: rows.map((row) => Number(row.n)) };
        }),
      ),
    );

    expect(outcome).toEqual({ attempt: true, rows: [7] });
  });
});
