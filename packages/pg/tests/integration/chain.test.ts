/**
 * `./chain`'s version-chain discipline over the fixture tree's tables
 * (`tests/fixtures/schema.ts`), proven against PostgreSQL. The cases are
 * pulpit's `version-chain` unit tests, ported from its in-memory store to the
 * real tables: create is never an upsert, update carries forward and never
 * resurrects, delete is an idempotent tombstone, restoreVersion reads the
 * whole snapshot first, history is bounded, and the expected-version
 * precondition fails `StaleVersion`. The last case races two real
 * transactions at one head and ends in exactly one `VersionConflict`.
 *
 * @module packages/pg/tests/integration/chain
 */

import { eq, sql } from "drizzle-orm";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { afterAll, assert, describe, expect, it } from "vite-plus/test";
import { makeVersionChain, MAX_HISTORY_LIMIT } from "../../src/chain.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction, testDatabaseLayer } from "../../src/testing.ts";
import { node, nodeVersion, ontologyTables, ontologyTree } from "../fixtures/schema.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction, transact } = database;

const url = Redacted.make(process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? "");
const runtime = ManagedRuntime.make(testDatabaseLayer(database, { url }));
const { runInTestTransaction } = makeTestTransaction(database);

const chain = makeVersionChain({ tree: ontologyTree, tables: ontologyTables, CurrentTransaction });

const ID = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = "actor-1";

const exec = Effect.fn("chain.exec")(function* (statement: string) {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql.raw(statement));
});

/** The tag of an effect's typed failure, if it failed with one. */
const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Option.map(Exit.findErrorOption(exit), (error) => error._tag),
  );

/** The book `ID` at version 0. */
const createBook = chain.book.create({
  id: ID,
  state: { title: "Dune", pages: 412 },
  actor: ACTOR,
});

/** How many version rows a level table holds for `ID`. */
const rowsIn = Effect.fn("chain.rowsIn")(function* (table: string) {
  const tx = yield* CurrentTransaction;
  const result = yield* tx.execute<{ readonly n: string }>(
    sql.raw(`SELECT count(*) AS n FROM ontology.${table} WHERE id = '${ID}'`),
  );
  return Number(result.rows[0]?.n ?? 0);
});

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  runInTestTransaction(runtime, effect);

describe("create", () => {
  it("inserts the node and version 0 at every level, minting the id when none is supplied", async () => {
    await run(
      Effect.gen(function* () {
        const written = yield* chain.book.create({
          state: { title: "Dune", pages: 412 },
          actor: ACTOR,
        });
        expect(written.version).toBe(0n);
        const snapshot = yield* chain.book.getVersion(written.id, 0n);
        expect(snapshot.action).toBe("create");
        expect(snapshot.state).toEqual({ title: "Dune", pages: 412 });
        const tx = yield* CurrentTransaction;
        const identity = yield* tx.select().from(node).where(eq(node.id, written.id));
        expect(identity.map((row) => row.type)).toEqual(["book"]);
      }),
    );
  });

  it("uses a caller-supplied id, and is never an upsert over an existing node", async () => {
    await run(
      Effect.gen(function* () {
        expect(yield* createBook).toEqual({ id: ID, version: 0n });
        expect(
          yield* tagOf(chain.essay.create({ id: ID, state: { title: "x" }, actor: ACTOR })),
        ).toEqual(Option.some("NodeAlreadyExists"));
        expect(yield* rowsIn("node_version")).toBe(1);
      }),
    );
  });

  it("writes a fact-scoped level's non-null facts only", async () => {
    await run(
      Effect.gen(function* () {
        const bare = yield* chain.edition.create({ state: {}, actor: ACTOR });
        expect((yield* chain.edition.getVersion(bare.id, 0n)).state).toEqual({ isbn: null });
        const withIsbn = yield* chain.edition.create({ state: { isbn: "978" }, actor: ACTOR });
        expect((yield* chain.edition.getVersion(withIsbn.id, 0n)).state).toEqual({ isbn: "978" });
      }),
    );
  });
});

describe("update — append and carry forward", () => {
  it("appends at N_max + 1 at every level and carries unpatched columns forward", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        expect(yield* chain.book.update({ id: ID, patch: { pages: 256 }, actor: ACTOR })).toEqual({
          id: ID,
          version: 1n,
        });
        const snapshot = yield* chain.book.getVersion(ID, 1n);
        expect([snapshot.action, snapshot.state]).toEqual([
          "update",
          { title: "Dune", pages: 256 },
        ]);
        expect(yield* rowsIn("work_version")).toBe(2);
        expect(yield* rowsIn("book_version")).toBe(2);
      }),
    );
  });

  it("clears on null, carries forward on undefined", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({
          id: ID,
          patch: { pages: null, title: undefined },
          actor: ACTOR,
        });
        expect((yield* chain.book.getVersion(ID, 1n)).state).toEqual({
          title: "Dune",
          pages: null,
        });
      }),
    );
  });

  it("never rewrites an existing version row", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({ id: ID, patch: { title: "Dune Messiah" }, actor: ACTOR });
        expect((yield* chain.book.getVersion(ID, 0n)).state).toEqual({ title: "Dune", pages: 412 });
      }),
    );
  });

  it("fails NodeNotFound for an unknown id, and for a node of another leaf", async () => {
    await run(
      Effect.gen(function* () {
        expect(yield* tagOf(chain.book.update({ id: ID, patch: {}, actor: ACTOR }))).toEqual(
          Option.some("NodeNotFound"),
        );
        yield* createBook;
        expect(yield* tagOf(chain.essay.update({ id: ID, patch: {}, actor: ACTOR }))).toEqual(
          Option.some("NodeNotFound"),
        );
      }),
    );
  });

  it("never resurrects a tombstone (VERSION-CHAIN-006)", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.delete(ID, { actor: ACTOR });
        expect(
          yield* tagOf(chain.book.update({ id: ID, patch: { title: "x" }, actor: ACTOR })),
        ).toEqual(Option.some("NodeNotFound"));
        expect(yield* rowsIn("node_version")).toBe(2);
      }),
    );
  });

  it("records the actor on the root version row", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({ id: ID, patch: {}, actor: undefined });
        const tx = yield* CurrentTransaction;
        const rows = yield* tx
          .select({ actor: nodeVersion.actor })
          .from(nodeVersion)
          .where(eq(nodeVersion.id, ID))
          .orderBy(nodeVersion.version);
        expect(rows.map((row) => row.actor)).toEqual([ACTOR, null]);
      }),
    );
  });
});

describe("restore — the explicit resurrection surface", () => {
  it("writes over a tombstone as an update, bringing the node back live", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.delete(ID, { actor: ACTOR });
        expect(
          yield* chain.book.restore({ id: ID, patch: { title: "Back" }, actor: ACTOR }),
        ).toEqual({ id: ID, version: 2n });
        const snapshot = yield* chain.book.getVersion(ID, 2n);
        expect([snapshot.action, snapshot.state]).toEqual([
          "update",
          { title: "Back", pages: 412 },
        ]);
      }),
    );
  });
});

describe("delete — the tombstone", () => {
  it("appends a delete version that carries the full state forward", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        expect(yield* chain.book.delete(ID, { actor: ACTOR })).toEqual({
          id: ID,
          version: 1n,
          alreadyDeleted: false,
        });
        const snapshot = yield* chain.book.getVersion(ID, 1n);
        expect([snapshot.action, snapshot.state]).toEqual([
          "delete",
          { title: "Dune", pages: 412 },
        ]);
      }),
    );
  });

  it("is idempotent: a second delete returns the existing tombstone and writes nothing", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.delete(ID, { actor: ACTOR });
        expect(yield* chain.book.delete(ID, { actor: ACTOR, expectedVersion: 0n })).toEqual({
          id: ID,
          version: 1n,
          alreadyDeleted: true,
        });
        expect(yield* rowsIn("node_version")).toBe(2);
      }),
    );
  });

  it("fails NodeNotFound for an unknown id", async () => {
    await run(
      Effect.gen(function* () {
        expect(yield* tagOf(chain.book.delete(ID, { actor: ACTOR }))).toEqual(
          Option.some("NodeNotFound"),
        );
      }),
    );
  });
});

describe("getVersion / restoreVersion — history as data", () => {
  it("restoreVersion re-applies the snapshot as a NEW update version", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({
          id: ID,
          patch: { title: "Dune Messiah", pages: 256 },
          actor: ACTOR,
        });
        expect(yield* chain.book.restoreVersion(ID, 0n, { actor: ACTOR })).toEqual({
          id: ID,
          version: 2n,
        });
        const snapshot = yield* chain.book.getVersion(ID, 2n);
        expect([snapshot.action, snapshot.state]).toEqual([
          "update",
          { title: "Dune", pages: 412 },
        ]);
      }),
    );
  });

  it("restoreVersion restores from a tombstone, over a tombstone", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.delete(ID, { actor: ACTOR });
        yield* chain.book.restoreVersion(ID, 1n, { actor: ACTOR });
        const snapshot = yield* chain.book.getVersion(ID, 2n);
        expect([snapshot.action, snapshot.state]).toEqual([
          "update",
          { title: "Dune", pages: 412 },
        ]);
      }),
    );
  });

  it("refuses an unknown version, and a partial chain, before writing anything", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        expect(yield* tagOf(chain.book.restoreVersion(ID, 9n, { actor: ACTOR }))).toEqual(
          Option.some("VersionNotFound"),
        );
        // Version 1 reaches the root and the work level, but not the leaf.
        yield* exec(
          `INSERT INTO ontology.node_version (id, version, action) VALUES ('${ID}', 1, 'update')`,
        );
        yield* exec(
          `INSERT INTO ontology.work_version (id, version, title) VALUES ('${ID}', 1, 'x')`,
        );
        expect(yield* tagOf(chain.book.restoreVersion(ID, 1n, { actor: ACTOR }))).toEqual(
          Option.some("VersionNotFound"),
        );
        expect(yield* tagOf(chain.book.getVersion(ID, 1n))).toEqual(Option.some("VersionNotFound"));
        expect(yield* rowsIn("node_version")).toBe(2);
      }),
    );
  });
});

describe("history", () => {
  it("lists the chain oldest first", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR });
        yield* chain.book.delete(ID, { actor: ACTOR });
        const entries = yield* chain.book.history(ID);
        expect(entries.map((entry) => [entry.version, entry.action])).toEqual([
          [0n, "create"],
          [1n, "update"],
          [2n, "delete"],
        ]);
        expect(entries[0]?.timestamp).toBeInstanceOf(Date);
      }),
    );
  });

  it("is bounded: the limit applies, and is capped", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR });
        yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR });
        expect((yield* chain.book.history(ID, 2)).length).toBe(2);
        expect((yield* chain.book.history(ID, 0)).length).toBe(1);
        expect((yield* chain.book.history(ID, MAX_HISTORY_LIMIT * 10)).length).toBe(3);
      }),
    );
  });

  it("fails NodeNotFound for an id with no versions", async () => {
    await run(
      Effect.gen(function* () {
        expect(yield* tagOf(chain.book.history(ID))).toEqual(Option.some("NodeNotFound"));
      }),
    );
  });
});

describe("expectedVersion — the optimistic-concurrency precondition", () => {
  it("writes when the expected version is the head", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        expect(
          yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR, expectedVersion: 0n }),
        ).toEqual({ id: ID, version: 1n });
      }),
    );
  });

  it("writes nothing when the expected version is stale or ahead, and the error carries the head", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR });
        const stale = yield* Effect.flip(
          chain.book.update({ id: ID, patch: { title: "x" }, actor: ACTOR, expectedVersion: 0n }),
        );
        expect(stale).toMatchObject({ _tag: "StaleVersion", expected: 0n, current: 1n });
        expect(yield* tagOf(chain.book.delete(ID, { actor: ACTOR, expectedVersion: 5n }))).toEqual(
          Option.some("StaleVersion"),
        );
        expect(
          yield* tagOf(chain.book.restoreVersion(ID, 0n, { actor: ACTOR, expectedVersion: 0n })),
        ).toEqual(Option.some("StaleVersion"));
        expect(yield* rowsIn("node_version")).toBe(2);
      }),
    );
  });

  it("restore over a tombstone checks the tombstone's version; update still refuses it as NotFound", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* chain.book.delete(ID, { actor: ACTOR });
        expect(
          yield* tagOf(chain.book.update({ id: ID, patch: {}, actor: ACTOR, expectedVersion: 1n })),
        ).toEqual(Option.some("NodeNotFound"));
        expect(
          yield* tagOf(
            chain.book.restore({ id: ID, patch: {}, actor: ACTOR, expectedVersion: 0n }),
          ),
        ).toEqual(Option.some("StaleVersion"));
        expect(
          yield* chain.book.restore({ id: ID, patch: {}, actor: ACTOR, expectedVersion: 1n }),
        ).toEqual({ id: ID, version: 2n });
      }),
    );
  });
});

describe("a chain that breaks its own contract", () => {
  it("dies (a defect, not a typed miss) when the head has no reconstructable state", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBook;
        yield* exec(
          `INSERT INTO ontology.node_version (id, version, action) VALUES ('${ID}', 1, 'update')`,
        );
        const exit = yield* Effect.exit(chain.book.update({ id: ID, patch: {}, actor: ACTOR }));
        assert(Exit.isFailure(exit), "unreachable: the write should have died");
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(String(Cause.squash(exit.cause))).toContain("BrokenChain");
      }),
    );
  });
});

describe("the concurrent-writer race", () => {
  const RACED = "00000000-0000-4000-8000-0000000000a2";
  // Two runtimes, two pools, two connections: real transactions that commit.
  const first = ManagedRuntime.make(testDatabaseLayer(database, { url }));
  const second = ManagedRuntime.make(testDatabaseLayer(database, { url }));

  afterAll(async () => {
    // Leaf-first: each stable delete cascades its own version rows.
    await first.runPromise(
      transact(
        Effect.forEach(
          ["book", "work", "node"],
          (table) => exec(`DELETE FROM ontology.${table} WHERE id = '${RACED}'`),
          { concurrency: 1, discard: true },
        ),
      ),
    );
    await first.dispose();
    await second.dispose();
  });

  it("ends in exactly one VersionConflict when two transactions append at one head", async () => {
    await first.runPromise(
      transact(chain.book.create({ id: RACED, state: { title: "Race" }, actor: ACTOR })),
    );
    // The first writer appends version 1 and holds its transaction open; the
    // second reads the same head (0, the first is uncommitted), passes the
    // precondition, and blocks on the `(id, version)` key until the first
    // commits, then loses it.
    const { promise: firstWrote, resolve: wrote } = Promise.withResolvers<void>();
    const { promise: release, resolve: commit } = Promise.withResolvers<void>();
    const winner = first.runPromise(
      transact(
        Effect.gen(function* () {
          const written = yield* chain.book.update({
            id: RACED,
            patch: { title: "First" },
            actor: ACTOR,
            expectedVersion: 0n,
          });
          wrote();
          yield* Effect.tryPromise({
            try: () => release,
            catch: () => "release rejected" as const,
          });
          return written;
        }),
      ),
    );
    await firstWrote;
    const loser = second.runPromiseExit(
      transact(
        chain.book.update({
          id: RACED,
          patch: { title: "Second" },
          actor: ACTOR,
          expectedVersion: 0n,
        }),
      ),
    );
    // Give the second writer time to reach its blocked insert.
    await new Promise((resolve) => setTimeout(resolve, 200));
    commit();
    expect(await winner).toEqual({ id: RACED, version: 1n });
    const lost = await loser;
    expect(Option.map(Exit.findErrorOption(lost), (error) => error._tag)).toEqual(
      Option.some("VersionConflict"),
    );
    const history = await first.runPromise(transact(chain.book.history(RACED)));
    expect(history.map((entry) => entry.version)).toEqual([0n, 1n]);
  });
});

describe("a keyed (localised) leaf's keyed level", () => {
  const ESSAY = "00000000-0000-4000-8000-0000000000a3";
  const createEssay = chain.essay.create({
    id: ESSAY,
    state: { title: "On Sand" },
    keyed: { en: { abstract: "Hello" }, fr: { abstract: "Bonjour" } },
    actor: ACTOR,
  });

  it("writes the keyed level at create and reads it in the snapshot", async () => {
    await run(
      Effect.gen(function* () {
        yield* createEssay;
        const snapshot = yield* chain.essay.getVersion(ESSAY, 0n);
        expect(snapshot.keyed).toEqual({ en: { abstract: "Hello" }, fr: { abstract: "Bonjour" } });
        expect((yield* chain.book.create({ state: { title: "x" }, actor: ACTOR })).version).toBe(
          0n,
        );
      }),
    );
  });

  it("carries untouched keys forward, updates a patched key, drops a null one, adds a new one", async () => {
    await run(
      Effect.gen(function* () {
        yield* createEssay;
        yield* chain.essay.update({
          id: ESSAY,
          patch: {},
          keyed: { en: { abstract: "Hi" }, fr: null, de: { abstract: "Hallo" } },
          actor: ACTOR,
        });
        expect((yield* chain.essay.getVersion(ESSAY, 1n)).keyed).toEqual({
          de: { abstract: "Hallo" },
          en: { abstract: "Hi" },
        });
        yield* chain.essay.update({ id: ESSAY, patch: { title: "On Dunes" }, actor: ACTOR });
        const carried = yield* chain.essay.getVersion(ESSAY, 2n);
        expect([carried.state, carried.keyed]).toEqual([
          { title: "On Dunes" },
          { de: { abstract: "Hallo" }, en: { abstract: "Hi" } },
        ]);
      }),
    );
  });

  it("carries every key through a tombstone and restores them with restoreVersion", async () => {
    await run(
      Effect.gen(function* () {
        yield* createEssay;
        yield* chain.essay.update({ id: ESSAY, patch: {}, keyed: { fr: null }, actor: ACTOR });
        yield* chain.essay.delete(ESSAY, { actor: ACTOR });
        expect((yield* chain.essay.getVersion(ESSAY, 2n)).keyed).toEqual({
          en: { abstract: "Hello" },
        });
        yield* chain.essay.restoreVersion(ESSAY, 0n, { actor: ACTOR });
        expect((yield* chain.essay.getVersion(ESSAY, 3n)).keyed).toEqual({
          en: { abstract: "Hello" },
          fr: { abstract: "Bonjour" },
        });
      }),
    );
  });

  it("reads `{}` for a version that carries no key", async () => {
    await run(
      Effect.gen(function* () {
        yield* chain.essay.create({ id: ESSAY, state: { title: "Bare" }, actor: ACTOR });
        expect((yield* chain.essay.getVersion(ESSAY, 0n)).keyed).toEqual({});
      }),
    );
  });
});

describe("head", () => {
  it("reads the head entry, a tombstone's included, and none for an unknown id or another leaf's node", async () => {
    await run(
      Effect.gen(function* () {
        expect(yield* chain.book.head(ID)).toEqual(Option.none());
        yield* createBook;
        yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR });
        expect(
          Option.map(yield* chain.book.head(ID), (entry) => [entry.version, entry.action]),
        ).toEqual(Option.some([1n, "update"]));
        yield* chain.book.delete(ID, { actor: ACTOR });
        expect(
          Option.map(yield* chain.book.head(ID), (entry) => [entry.version, entry.action]),
        ).toEqual(Option.some([2n, "delete"]));
        expect(yield* chain.essay.head(ID)).toEqual(Option.none());
      }),
    );
  });
});
