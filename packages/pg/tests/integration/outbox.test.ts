/**
 * `./Outbox` over the fixture's `outbox` table, against PostgreSQL: an append
 * lives and dies with its transaction, a drain hands events over in `seq`
 * order and marks them published, a failed publish leaves them pending, and
 * a second drain running alongside the first claims nothing.
 *
 * @module packages/pg/tests/integration/outbox
 */

import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { makeOutbox, type OutboxEvent, type OutboxRecord } from "../../src/Outbox.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import { outbox as outboxTable } from "../fixtures/schema.ts";
import { integrationLayer, separateDatabase } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction, transact } = database;

const { inTestTransaction, attemptInSavepoint } = makeTestTransaction(database);

const outbox = makeOutbox({ table: outboxTable, CurrentTransaction });

const event = (stream: string, streamVersion: bigint, eventIndex: number): OutboxEvent => ({
  stream,
  streamVersion,
  eventIndex,
  type: "Happened",
  payload: { stream, n: eventIndex },
});

const keyOf = (record: OutboxRecord) =>
  `${record.stream}@${record.streamVersion}#${record.eventIndex}`;

integrationLayer(database)((it) => {
  describe("append", () => {
    it.effect("stores the events, pending, in the order appended", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* outbox.append([event("a", 0n, 0), event("a", 0n, 1)]);
          yield* outbox.append([event("b", 0n, 0)]);
          const pending = yield* outbox.pending();
          expect(pending.map(keyOf)).toEqual(["a@0#0", "a@0#1", "b@0#0"]);
          expect(pending[0]?.payload).toEqual({ stream: "a", n: 0 });
          expect(pending[0]?.recordedAt).toBeInstanceOf(Date);
        }),
      ),
    );

    it.effect("leaves nothing behind when its transaction rolls back", () =>
      inTestTransaction(
        Effect.gen(function* () {
          const exit = yield* attemptInSavepoint(
            Effect.andThen(outbox.append([event("a", 0n, 0)]), Effect.fail("rolled back" as const)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(yield* outbox.pending()).toEqual([]);
        }),
      ),
    );

    it.effect("writes nothing for an empty batch", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* outbox.append([]);
          expect(yield* outbox.pending()).toEqual([]);
        }),
      ),
    );

    it.effect("refuses the same (stream, version, index) twice", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* outbox.append([event("a", 0n, 0)]);
          const exit = yield* attemptInSavepoint(outbox.append([event("a", 0n, 0)]));
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
    );
  });

  describe("drain", () => {
    it.effect(
      "publishes pending events oldest first, at most `limit`, and marks them published",
      () =>
        inTestTransaction(
          Effect.gen(function* () {
            yield* outbox.append([event("a", 0n, 0), event("b", 0n, 0), event("a", 1n, 0)]);
            const batches: Array<ReadonlyArray<string>> = [];
            const publish = (batch: ReadonlyArray<OutboxRecord>) =>
              Effect.sync(() => {
                batches.push(batch.map(keyOf));
              });
            expect(yield* outbox.drain(publish, { limit: 2 })).toBe(2);
            expect(yield* outbox.drain(publish, { limit: 2 })).toBe(1);
            expect(yield* outbox.drain(publish)).toBe(0);
            expect(batches).toEqual([["a@0#0", "b@0#0"], ["a@1#0"]]);
            expect(yield* outbox.pending()).toEqual([]);
          }),
        ),
    );

    it.effect("leaves every event pending when the publisher fails", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* outbox.append([event("a", 0n, 0), event("a", 0n, 1)]);
          const exit = yield* attemptInSavepoint(
            outbox.drain(() => Effect.fail("queue down" as const)),
          );
          expect(Exit.findErrorOption(exit)).toEqual(Option.some("queue down"));
          expect((yield* outbox.pending()).map(keyOf)).toEqual(["a@0#0", "a@0#1"]);
        }),
      ),
    );
  });

  describe("concurrent drains", () => {
    const STREAM = "concurrent";

    it.effect("lets one drain at a time claim events; the other claims nothing", () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.orDie(
            transact(
              Effect.gen(function* () {
                const tx = yield* CurrentTransaction;
                yield* tx.execute(sql`DELETE FROM fixture.outbox WHERE stream = ${STREAM}`);
              }),
            ),
          ),
        );
        // The block's pool and a second one: two connections, real transactions that commit.
        const second = yield* separateDatabase(database);
        yield* transact(outbox.append([event(STREAM, 0n, 0), event(STREAM, 1n, 0)]));
        // The first drain holds its transaction open inside the publisher; the
        // second runs meanwhile and must not see, or wait on, the claimed rows.
        const publishing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const held = yield* Effect.forkChild(
          transact(
            outbox.drain(() =>
              Effect.andThen(Deferred.succeed(publishing, undefined), Deferred.await(release)),
            ),
          ),
        );
        yield* Deferred.await(publishing);
        const onSecond = Effect.provideContext(second);
        expect(yield* onSecond(transact(outbox.drain(() => Effect.void)))).toBe(0);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(held)).toBe(2);
        expect(yield* onSecond(transact(outbox.pending()))).toEqual([]);
      }),
    );
  });
});
