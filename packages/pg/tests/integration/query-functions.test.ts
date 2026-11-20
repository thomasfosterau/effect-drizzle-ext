/**
 * Integration coverage for `makePgDatabase`'s context-bound `queries` against
 * a real PostgreSQL server: a deferred query replays onto the real
 * `drizzle-orm/effect-postgres` builders, and it runs on the open
 * transaction when there is one, so a write inside `transact` rolls back
 * with it and a read sees it before it commits.
 *
 * The probe table is a `TEMPORARY` table created inside the harness
 * transaction, as in `database.test.ts`, so the always-rollback disposes of
 * it.
 *
 * @module packages/pg/tests/integration/query-functions
 */

import { defineRelations, eq, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { integrationLayer } from "./database-url.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";

const probe = pgTable("query_functions_probe", {
  n: integer("n").notNull(),
  label: text("label").notNull(),
});

const relations = defineRelations({ probe });

const database = makePgDatabase({ relations, key: "Database" });
const { transact } = database;
const { select, insert, update, execute, $count, query } = database.queries;
const deleteFrom = database.queries.delete;

const { inTestTransaction } = makeTestTransaction(database);

const createProbeTable = execute(
  sql`CREATE TEMPORARY TABLE query_functions_probe (n integer NOT NULL, label text NOT NULL)`,
);

/** The sentinel an intentionally rolled-back body fails with. */
class ProbeRollback {
  readonly _tag = "ProbeRollback";
}

integrationLayer(database)((it) => {
  describe("makePgDatabase queries against a live database", () => {
    it.effect("inserts, selects, updates and deletes without naming a client", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createProbeTable;
          const inserted = yield* insert(probe)
            .values([
              { n: 1, label: "one" },
              { n: 2, label: "two" },
            ])
            .returning({ n: probe.n });
          expect(inserted).toEqual([{ n: 1 }, { n: 2 }]);

          yield* update(probe).set({ label: "uno" }).where(eq(probe.n, 1));
          yield* deleteFrom(probe).where(eq(probe.n, 2));

          const rows = yield* select({ n: probe.n, label: probe.label }).from(probe);
          expect(rows).toEqual([{ n: 1, label: "uno" }]);
          expect(yield* $count(probe)).toBe(1);
          expect(yield* query.probe.findFirst({ columns: { label: true } })).toEqual({
            label: "uno",
          });
        }),
      ),
    );

    it.effect("writes inside transact land in that transaction and roll back with it", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createProbeTable;
          const outcome = yield* Effect.exit(
            transact(
              Effect.gen(function* () {
                yield* insert(probe).values({ n: 10, label: "ten" });
                // The uncommitted row is visible: the read ran on the open
                // transaction, not on a second pooled connection.
                expect(yield* $count(probe)).toBe(1);
                return yield* Effect.fail(new ProbeRollback());
              }),
            ),
          );
          expect(outcome._tag).toBe("Failure");
          expect(yield* $count(probe)).toBe(0);
        }),
      ),
    );
  });
});
