/**
 * Integration coverage for `makePgDatabase` against a real PostgreSQL server:
 * the layer composes, the client answers, and `transact` /
 * `CurrentTransaction` / `readHandle` behave the way the design decision
 * turns on rather than merely the way the type checker allows.
 *
 * Ported from the consuming applications' `transact.test.ts` (website #1883).
 * The two properties a type test cannot catch:
 *
 * - **`transact` provides a working handle.** The `CurrentTransaction`
 *   payload is the driver's own transaction, so writes through it are visible
 *   to the enclosing transaction once the body completes.
 * - **`transact` is always-open, never join-if-present.** Calling it inside an
 *   open transaction opens a NESTED one (a SAVEPOINT on the pinned
 *   connection), which is what preserves the rollback granularity every
 *   hand-rolled `db.transaction(…)` had before the services existed. A
 *   join-if-present variant would typecheck identically and silently delete
 *   that boundary.
 *
 * The probe table is a `TEMPORARY` table created inside the harness
 * transaction: DDL is transactional in PostgreSQL, so the always-rollback
 * disposes of it with everything else, and no fixture, foreign key or
 * migration is involved.
 *
 * @module packages/pg/tests/integration/database
 */

import { executeRows } from "@thomasfosterau/effect-drizzle-ext/query";
import { sql } from "drizzle-orm";
import { integer, pgTable } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction, testDatabaseLayer } from "../../src/testing.ts";

/** This library is relations-agnostic; the specs need no relational graph. */
const relations = {};

const database = makePgDatabase({ relations, key: "Database" });
const { Database, CurrentTransaction, transact, readHandle } = database;

/** The global setup resolved this; `provisioning.test.ts` proves it is set. */
const url = Redacted.make(process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? "");

const runtime = ManagedRuntime.make(testDatabaseLayer(database, { url }));
const { runInTestTransaction } = makeTestTransaction(database);

/**
 * A Drizzle view of the probe table, so the SELECT-only {@link readHandle} —
 * which narrows away `execute` — has something to read from. The name matches
 * the `TEMPORARY` table below; the temporary schema comes first in
 * `search_path`, so an unqualified reference resolves to it.
 */
const probe = pgTable("current_transaction_probe", { n: integer("n").notNull() });

const createProbeTable = Effect.fn("probe.create")(function* () {
  const db = yield* Database;
  yield* db.execute(sql`CREATE TEMPORARY TABLE current_transaction_probe (n integer NOT NULL)`);
});

/** Rows written so far, in insertion order, read through the client. */
const probeRows = Effect.fn("probe.rows")(function* () {
  const db = yield* Database;
  const rows = yield* executeRows<{ n: number }>(
    db,
    sql`SELECT n FROM current_transaction_probe ORDER BY n`,
  );
  return rows.map((row) => Number(row.n));
});

const insert = Effect.fn("probe.insert")(function* (n: number) {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql`INSERT INTO current_transaction_probe (n) VALUES (${n})`);
});

/** The sentinel an intentionally-rolled-back body fails with. */
class ProbeRollback {
  readonly _tag = "ProbeRollback";
}

describe("makePgDatabase against a live database", () => {
  it("answers a query through the Database service", async () => {
    const rows = await runtime.runPromise(
      Effect.flatMap(Database, (db) => executeRows<{ one: number }>(db, sql`SELECT 1::int AS one`)),
    );
    expect(rows.map((row) => Number(row.one))).toEqual([1]);
  });

  it("provides the open transaction as CurrentTransaction, and its writes land", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* createProbeTable();
        yield* transact(insert(1));
        expect(yield* probeRows()).toEqual([1]);
      }),
    );
  });

  it("opens a NESTED transaction rather than joining the ambient one", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* createProbeTable();

        const outcome = yield* Effect.exit(
          transact(
            Effect.gen(function* () {
              yield* insert(10);
              // The inner `transact` is a real, separate boundary: its
              // failure rolls back only its own write. Under a
              // join-if-present helper there would be no inner boundary, so
              // this failure would take the outer write with it.
              const inner = yield* Effect.exit(
                transact(
                  Effect.gen(function* () {
                    yield* insert(11);
                    return yield* Effect.fail(new ProbeRollback());
                  }),
                ),
              );
              expect(inner._tag).toBe("Failure");
              yield* insert(12);
            }),
          ),
        );

        expect(outcome._tag).toBe("Success");
        expect(yield* probeRows()).toEqual([10, 12]);
      }),
    );
  });

  it("shadows the outer handle with the inner one inside a nested transact", async () => {
    await runInTestTransaction(
      runtime,
      transact(
        Effect.gen(function* () {
          const outer = yield* CurrentTransaction;
          yield* transact(
            Effect.gen(function* () {
              const inner = yield* CurrentTransaction;
              expect(inner).not.toBe(outer);
            }),
          );
          // …and the outer handle is restored once the inner boundary closes.
          expect(yield* CurrentTransaction).toBe(outer);
        }),
      ),
    );
  });

  it("readHandle inside a transaction sees that transaction's uncommitted row", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* createProbeTable();
        yield* transact(
          Effect.gen(function* () {
            yield* insert(42);
            // Nothing has committed; the row exists only inside this
            // transaction, and `readHandle` prefers it over the client.
            const handle = yield* readHandle;
            const rows = yield* handle.select({ n: probe.n }).from(probe);
            expect(rows.map((row) => Number(row.n))).toEqual([42]);
          }),
        );
      }),
    );
  });
});
