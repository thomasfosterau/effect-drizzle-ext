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
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { makeOutbox, type OutboxEvent, type OutboxRecord } from "../../src/Outbox.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import { outbox as outboxTable } from "../fixtures/schema.ts";
import { integrationDatabaseLayer } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction, transact } = database;

const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction, attemptInSavepoint } = makeTestTransaction(database);

const outbox = makeOutbox({ table: outboxTable, CurrentTransaction });

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  runInTestTransaction(runtime, effect);

const event = (stream: string, streamVersion: bigint, eventIndex: number): OutboxEvent => ({
  stream,
  streamVersion,
  eventIndex,
  type: "Happened",
  payload: { stream, n: eventIndex },
});

const keyOf = (record: OutboxRecord) =>
  `${record.stream}@${record.streamVersion}#${record.eventIndex}`;

afterAll(() => runtime.dispose());

describe("append", () => {
  it("stores the events, pending, in the order appended", async () => {
    await run(
      Effect.gen(function* () {
        yield* outbox.append([event("a", 0n, 0), event("a", 0n, 1)]);
        yield* outbox.append([event("b", 0n, 0)]);
        const pending = yield* outbox.pending();
        expect(pending.map(keyOf)).toEqual(["a@0#0", "a@0#1", "b@0#0"]);
        expect(pending[0]?.payload).toEqual({ stream: "a", n: 0 });
        expect(pending[0]?.recordedAt).toBeInstanceOf(Date);
      }),
    );
  });

  it("leaves nothing behind when its transaction rolls back", async () => {
    await run(
      Effect.gen(function* () {
        const exit = yield* attemptInSavepoint(
          Effect.andThen(outbox.append([event("a", 0n, 0)]), Effect.fail("rolled back" as const)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* outbox.pending()).toEqual([]);
      }),
    );
  });

  it("writes nothing for an empty batch", async () => {
    await run(
      Effect.gen(function* () {
        yield* outbox.append([]);
        expect(yield* outbox.pending()).toEqual([]);
      }),
    );
  });

  it("refuses the same (stream, version, index) twice", async () => {
    await run(
      Effect.gen(function* () {
        yield* outbox.append([event("a", 0n, 0)]);
        const exit = yield* attemptInSavepoint(outbox.append([event("a", 0n, 0)]));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });
});

describe("drain", () => {
  it("publishes pending events oldest first, at most `limit`, and marks them published", async () => {
    await run(
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
    );
  });

  it("leaves every event pending when the publisher fails", async () => {
    await run(
      Effect.gen(function* () {
        yield* outbox.append([event("a", 0n, 0), event("a", 0n, 1)]);
        const exit = yield* attemptInSavepoint(
          outbox.drain(() => Effect.fail("queue down" as const)),
        );
        expect(Exit.findErrorOption(exit)).toEqual(Option.some("queue down"));
        expect((yield* outbox.pending()).map(keyOf)).toEqual(["a@0#0", "a@0#1"]);
      }),
    );
  });
});

describe("concurrent drains", () => {
  const STREAM = "concurrent";
  // Two runtimes, two pools, two connections: real transactions that commit.
  const first = ManagedRuntime.make(integrationDatabaseLayer(database));
  const second = ManagedRuntime.make(integrationDatabaseLayer(database));

  afterAll(async () => {
    await first.runPromise(
      transact(
        Effect.gen(function* () {
          const tx = yield* CurrentTransaction;
          yield* tx.execute(sql`DELETE FROM fixture.outbox WHERE stream = ${STREAM}`);
        }),
      ),
    );
    await first.dispose();
    await second.dispose();
  });

  it("lets one drain at a time claim events; the other claims nothing", async () => {
    await first.runPromise(transact(outbox.append([event(STREAM, 0n, 0), event(STREAM, 1n, 0)])));
    // The first drain holds its transaction open inside the publisher; the
    // second runs meanwhile and must not see, or wait on, the claimed rows.
    const { promise: publishing, resolve: started } = Promise.withResolvers<void>();
    const { promise: release, resolve: finish } = Promise.withResolvers<void>();
    const held = first.runPromise(
      transact(
        outbox.drain(() =>
          Effect.andThen(
            Effect.sync(() => started()),
            Effect.tryPromise({ try: () => release, catch: () => "release rejected" as const }),
          ),
        ),
      ),
    );
    await publishing;
    expect(await second.runPromise(transact(outbox.drain(() => Effect.void)))).toBe(0);
    finish();
    expect(await held).toBe(2);
    expect(await second.runPromise(transact(outbox.pending()))).toEqual([]);
  });
});
