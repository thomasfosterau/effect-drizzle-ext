/**
 * `./Chain`'s reads and writes an aggregate repository builds on, against
 * PostgreSQL: `load` reads the head's state and version together, and
 * `setPointer` moves a named pointer as a discrete write, never a version.
 *
 * @module packages/pg/tests/integration/chain-repository
 */

import { eq, sql } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { makeVersionChain } from "../../src/Chain.ts";
import { makePgDatabase } from "../../src/PgDatabase.ts";
import { makeTestTransaction } from "../../src/Testing.ts";
import { bookLiveView, ontologyTables, ontologyTree } from "../fixtures/schema.ts";
import { integrationDatabaseLayer } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;
const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction } = makeTestTransaction(database);
afterAll(() => runtime.dispose());

const chain = makeVersionChain({ tree: ontologyTree, tables: ontologyTables, CurrentTransaction });

const BOOK = "00000000-0000-4000-8000-0000000000b1";
const ESSAY = "00000000-0000-4000-8000-0000000000e1";
const ACTOR = "actor-1";

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  runInTestTransaction(runtime, effect);

/** The tag of an effect's typed failure, if it failed with one. */
const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Option.map(Exit.findErrorOption(exit), (error) => error._tag),
  );

const createBook = chain.book.create({
  id: BOOK,
  state: { title: "Dune", pages: 412 },
  actor: ACTOR,
});

const liveVersion = Effect.fn("chainRepository.liveVersion")(function* () {
  const tx = yield* CurrentTransaction;
  const rows = yield* tx
    .select({ version: bookLiveView.version, title: bookLiveView.title })
    .from(bookLiveView)
    .where(eq(bookLiveView.id, BOOK));
  return rows;
});

describe("load", () => {
  it("reads the head's state and version together", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({ id: BOOK, patch: { pages: 500 }, actor: ACTOR });
        const loaded = yield* chain.book.load(BOOK);
        assertSome(loaded);
        expect(loaded.value.version).toBe(1n);
        expect(loaded.value.action).toBe("update");
        expect(loaded.value.state).toEqual({ title: "Dune", pages: 500 });
        expect(loaded.value.keyed).toEqual({});
      }),
    );
  });

  it("reads a tombstone as its delete snapshot", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.delete(BOOK, { actor: ACTOR });
        const loaded = yield* chain.book.load(BOOK);
        assertSome(loaded);
        expect(loaded.value.action).toBe("delete");
        expect(loaded.value.state).toEqual({ title: "Dune", pages: 412 });
      }),
    );
  });

  it("reads a keyed leaf's keyed level at the head", async () => {
    await run(
      Effect.gen(function* () {
        yield* chain.essay.create({
          id: ESSAY,
          state: { title: "On Drains" },
          keyed: { en: { abstract: "Hello" } },
          actor: ACTOR,
        });
        yield* chain.essay.update({
          id: ESSAY,
          patch: {},
          keyed: { fr: { abstract: "Bonjour" } },
          actor: ACTOR,
          expectedVersion: 0n,
        });
        const loaded = yield* chain.essay.load(ESSAY);
        assertSome(loaded);
        expect(loaded.value.version).toBe(1n);
        expect(loaded.value.keyed).toEqual({
          en: { abstract: "Hello" },
          fr: { abstract: "Bonjour" },
        });
      }),
    );
  });

  it("is none for an unknown id, another leaf's node, or a string that is no uuid", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        expect(yield* chain.book.load(ESSAY)).toEqual(Option.none());
        expect(yield* chain.essay.load(BOOK)).toEqual(Option.none());
        expect(yield* chain.book.load("not-a-uuid")).toEqual(Option.none());
      }),
    );
  });
});

describe("setPointer", () => {
  it("moves the pointer to a version and clears it, appending no version", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({ id: BOOK, patch: { title: "Dune II" }, actor: ACTOR });
        const first = yield* chain.book.setPointer({
          pointer: "live",
          id: BOOK,
          version: Option.some(0n),
          actor: ACTOR,
        });
        expect(yield* liveVersion()).toEqual([{ version: 0n, title: "Dune" }]);
        const moved = yield* chain.book.setPointer({
          pointer: "live",
          id: BOOK,
          version: Option.some(1n),
          actor: ACTOR,
          expectedVersion: 1n,
        });
        expect(moved.id).toBe(BOOK);
        expect(moved.seq > first.seq).toBe(true);
        expect(yield* liveVersion()).toEqual([{ version: 1n, title: "Dune II" }]);
        yield* chain.book.setPointer({
          pointer: "live",
          id: BOOK,
          version: Option.none(),
          actor: ACTOR,
        });
        expect(yield* liveVersion()).toEqual([]);
        const head = yield* chain.book.head(BOOK);
        expect(Option.map(head, (entry) => entry.version)).toEqual(Option.some(1n));
      }),
    );
  });

  it("schedules a move that takes effect at `at`", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.setPointer({
          pointer: "live",
          id: BOOK,
          version: Option.some(0n),
          at: DateTime.add(yield* DateTime.now, { days: 1 }),
          actor: ACTOR,
        });
        expect(yield* liveVersion()).toEqual([]);
        const tx = yield* CurrentTransaction;
        const rows = yield* tx.execute<{ readonly n: string }>(
          sql`SELECT count(*) AS n FROM ontology.live_pointer WHERE id = ${BOOK} AND at > now()`,
        );
        expect(rows.rows.map((row) => Number(row.n))).toEqual([1]);
      }),
    );
  });

  it("refuses an unknown node, a version past the head, and a stale precondition", async () => {
    await run(
      Effect.gen(function* () {
        expect(
          yield* tagOf(
            chain.book.setPointer({
              pointer: "live",
              id: BOOK,
              version: Option.some(0n),
              actor: ACTOR,
            }),
          ),
        ).toEqual(Option.some("NodeNotFound"));
        yield* createBook;
        expect(
          yield* tagOf(
            chain.book.setPointer({
              pointer: "live",
              id: BOOK,
              version: Option.some(1n),
              actor: ACTOR,
            }),
          ),
        ).toEqual(Option.some("VersionNotFound"));
        expect(
          yield* tagOf(
            chain.book.setPointer({
              pointer: "live",
              id: BOOK,
              version: Option.some(0n),
              actor: ACTOR,
              expectedVersion: 3n,
            }),
          ),
        ).toEqual(Option.some("StaleVersion"));
        expect(
          yield* tagOf(
            chain.essay.setPointer({
              pointer: "live",
              id: BOOK,
              version: Option.some(0n),
              actor: ACTOR,
            }),
          ),
        ).toEqual(Option.some("NodeNotFound"));
        expect(yield* liveVersion()).toEqual([]);
      }),
    );
  });
});

function assertSome<A>(option: Option.Option<A>): asserts option is Option.Some<A> {
  expect(Option.isSome(option)).toBe(true);
}
