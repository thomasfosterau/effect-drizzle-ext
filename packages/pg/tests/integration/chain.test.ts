/**
 * `./Chain`'s version-chain discipline over the fixture tree's tables
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

import { classifyError } from "@thomasfosterau/effect-drizzle-ext/Errors";
import { eq, sql } from "drizzle-orm";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { assert, describe, expect } from "vite-plus/test";
import { makeVersionChain, MAX_HISTORY_LIMIT } from "../../src/Chain.ts";
import { integrationLayer, separateDatabase } from "./database-url.ts";
import { makePgDatabase } from "../../src/PgDatabase.ts";
import { makeTestTransaction } from "../../src/Testing.ts";
import {
  node,
  nodeVersion,
  ontologyTables,
  ontologyTree,
  person,
  personView,
} from "../fixtures/schema.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction, transact } = database;

const { inTestTransaction, attemptInSavepoint } = makeTestTransaction(database);

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

integrationLayer(database)((it) => {
  describe("create", () => {
    it.effect(
      "inserts the node and version 0 at every level, minting the id when none is supplied",
      () =>
        inTestTransaction(
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
        ),
    );

    it.effect("uses a caller-supplied id, and is never an upsert over an existing node", () =>
      inTestTransaction(
        Effect.gen(function* () {
          expect(yield* createBook).toEqual({ id: ID, version: 0n });
          expect(
            yield* tagOf(chain.essay.create({ id: ID, state: { title: "x" }, actor: ACTOR })),
          ).toEqual(Option.some("NodeAlreadyExists"));
          expect(yield* rowsIn("node_version")).toBe(1);
        }),
      ),
    );

    it.effect("writes a fact-scoped level's non-null facts only", () =>
      inTestTransaction(
        Effect.gen(function* () {
          const bare = yield* chain.edition.create({ state: {}, actor: ACTOR });
          expect((yield* chain.edition.getVersion(bare.id, 0n)).state).toEqual({ isbn: null });
          const withIsbn = yield* chain.edition.create({ state: { isbn: "978" }, actor: ACTOR });
          expect((yield* chain.edition.getVersion(withIsbn.id, 0n)).state).toEqual({ isbn: "978" });
        }),
      ),
    );
  });

  describe("update — append and carry forward", () => {
    it.effect("appends at N_max + 1 at every level and carries unpatched columns forward", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createBook;
          expect(yield* chain.book.update({ id: ID, patch: { pages: 256 }, actor: ACTOR })).toEqual(
            {
              id: ID,
              version: 1n,
            },
          );
          const snapshot = yield* chain.book.getVersion(ID, 1n);
          expect([snapshot.action, snapshot.state]).toEqual([
            "update",
            { title: "Dune", pages: 256 },
          ]);
          expect(yield* rowsIn("work_version")).toBe(2);
          expect(yield* rowsIn("book_version")).toBe(2);
        }),
      ),
    );

    it.effect("clears on null, carries forward on undefined", () =>
      inTestTransaction(
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
      ),
    );

    it.effect("never rewrites an existing version row", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createBook;
          yield* chain.book.update({ id: ID, patch: { title: "Dune Messiah" }, actor: ACTOR });
          expect((yield* chain.book.getVersion(ID, 0n)).state).toEqual({
            title: "Dune",
            pages: 412,
          });
        }),
      ),
    );

    it.effect("fails NodeNotFound for an unknown id, and for a node of another leaf", () =>
      inTestTransaction(
        Effect.gen(function* () {
          expect(yield* tagOf(chain.book.update({ id: ID, patch: {}, actor: ACTOR }))).toEqual(
            Option.some("NodeNotFound"),
          );
          yield* createBook;
          expect(yield* tagOf(chain.essay.update({ id: ID, patch: {}, actor: ACTOR }))).toEqual(
            Option.some("NodeNotFound"),
          );
        }),
      ),
    );

    it.effect("never resurrects a tombstone (VERSION-CHAIN-006)", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createBook;
          yield* chain.book.delete(ID, { actor: ACTOR });
          expect(
            yield* tagOf(chain.book.update({ id: ID, patch: { title: "x" }, actor: ACTOR })),
          ).toEqual(Option.some("NodeNotFound"));
          expect(yield* rowsIn("node_version")).toBe(2);
        }),
      ),
    );

    it.effect("records the actor on the root version row", () =>
      inTestTransaction(
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
      ),
    );
  });

  describe("restore — the explicit resurrection surface", () => {
    it.effect("writes over a tombstone as an update, bringing the node back live", () =>
      inTestTransaction(
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
      ),
    );
  });

  describe("delete — the tombstone", () => {
    it.effect("appends a delete version that carries the full state forward", () =>
      inTestTransaction(
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
      ),
    );

    it.effect(
      "is idempotent: a second delete returns the existing tombstone and writes nothing",
      () =>
        inTestTransaction(
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
        ),
    );

    it.effect("fails NodeNotFound for an unknown id", () =>
      inTestTransaction(
        Effect.gen(function* () {
          expect(yield* tagOf(chain.book.delete(ID, { actor: ACTOR }))).toEqual(
            Option.some("NodeNotFound"),
          );
        }),
      ),
    );
  });

  describe("getVersion / restoreVersion — history as data", () => {
    it.effect("restoreVersion re-applies the snapshot as a NEW update version", () =>
      inTestTransaction(
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
      ),
    );

    it.effect("restoreVersion restores from a tombstone, over a tombstone", () =>
      inTestTransaction(
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
      ),
    );

    it.effect("refuses an unknown version, and a partial chain, before writing anything", () =>
      inTestTransaction(
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
          expect(yield* tagOf(chain.book.getVersion(ID, 1n))).toEqual(
            Option.some("VersionNotFound"),
          );
          expect(yield* rowsIn("node_version")).toBe(2);
        }),
      ),
    );
  });

  describe("history", () => {
    it.effect("lists the chain oldest first", () =>
      inTestTransaction(
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
      ),
    );

    it.effect("is bounded: the limit applies, and is capped", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createBook;
          yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR });
          yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR });
          expect((yield* chain.book.history(ID, 2)).length).toBe(2);
          expect((yield* chain.book.history(ID, 0)).length).toBe(1);
          expect((yield* chain.book.history(ID, MAX_HISTORY_LIMIT * 10)).length).toBe(3);
        }),
      ),
    );

    it.effect("fails NodeNotFound for an id with no versions", () =>
      inTestTransaction(
        Effect.gen(function* () {
          expect(yield* tagOf(chain.book.history(ID))).toEqual(Option.some("NodeNotFound"));
        }),
      ),
    );
  });

  describe("expectedVersion — the optimistic-concurrency precondition", () => {
    it.effect("writes when the expected version is the head", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createBook;
          expect(
            yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR, expectedVersion: 0n }),
          ).toEqual({ id: ID, version: 1n });
        }),
      ),
    );

    it.effect(
      "writes nothing when the expected version is stale or ahead, and the error carries the head",
      () =>
        inTestTransaction(
          Effect.gen(function* () {
            yield* createBook;
            yield* chain.book.update({ id: ID, patch: {}, actor: ACTOR });
            const stale = yield* Effect.flip(
              chain.book.update({
                id: ID,
                patch: { title: "x" },
                actor: ACTOR,
                expectedVersion: 0n,
              }),
            );
            expect(stale).toMatchObject({ _tag: "StaleVersion", expected: 0n, current: 1n });
            expect(
              yield* tagOf(chain.book.delete(ID, { actor: ACTOR, expectedVersion: 5n })),
            ).toEqual(Option.some("StaleVersion"));
            expect(
              yield* tagOf(
                chain.book.restoreVersion(ID, 0n, { actor: ACTOR, expectedVersion: 0n }),
              ),
            ).toEqual(Option.some("StaleVersion"));
            expect(yield* rowsIn("node_version")).toBe(2);
          }),
        ),
    );

    it.effect(
      "restore over a tombstone checks the tombstone's version; update still refuses it as NotFound",
      () =>
        inTestTransaction(
          Effect.gen(function* () {
            yield* createBook;
            yield* chain.book.delete(ID, { actor: ACTOR });
            expect(
              yield* tagOf(
                chain.book.update({ id: ID, patch: {}, actor: ACTOR, expectedVersion: 1n }),
              ),
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
        ),
    );
  });

  describe("a chain that breaks its own contract", () => {
    it.effect("dies (a defect, not a typed miss) when the head has no reconstructable state", () =>
      inTestTransaction(
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
      ),
    );
  });

  describe("the concurrent-writer race", () => {
    const RACED = "00000000-0000-4000-8000-0000000000a2";

    it.effect("ends in exactly one VersionConflict when two transactions append at one head", () =>
      Effect.gen(function* () {
        // Leaf-first: each stable delete cascades its own version rows.
        yield* Effect.addFinalizer(() =>
          Effect.orDie(
            transact(
              Effect.forEach(
                ["book", "work", "node"],
                (table) => exec(`DELETE FROM ontology.${table} WHERE id = '${RACED}'`),
                { concurrency: 1, discard: true },
              ),
            ),
          ),
        );
        // The block's pool and a second one: two connections, real transactions that commit.
        const second = yield* separateDatabase(database);
        yield* transact(chain.book.create({ id: RACED, state: { title: "Race" }, actor: ACTOR }));
        // The first writer appends version 1 and holds its transaction open; the
        // second reads the same head (0, the first is uncommitted), passes the
        // precondition, and blocks on the `(id, version)` key until the first
        // commits, then loses it.
        const wrote = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const winner = yield* Effect.forkChild(
          transact(
            Effect.gen(function* () {
              const written = yield* chain.book.update({
                id: RACED,
                patch: { title: "First" },
                actor: ACTOR,
                expectedVersion: 0n,
              });
              yield* Deferred.succeed(wrote, undefined);
              yield* Deferred.await(release);
              return written;
            }),
          ),
        );
        yield* Deferred.await(wrote);
        const loser = yield* Effect.forkChild(
          transact(
            chain.book.update({
              id: RACED,
              patch: { title: "Second" },
              actor: ACTOR,
              expectedVersion: 0n,
            }),
          ).pipe(Effect.exit, Effect.provideContext(second)),
        );
        // Give the second writer time to reach its blocked insert.
        yield* Effect.sleep(Duration.millis(200));
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(winner)).toEqual({ id: RACED, version: 1n });
        const lost = yield* Fiber.join(loser);
        expect(Option.map(Exit.findErrorOption(lost), (error) => error._tag)).toEqual(
          Option.some("VersionConflict"),
        );
        const history = yield* transact(chain.book.history(RACED));
        expect(history.map((entry) => entry.version)).toEqual([0n, 1n]);
      }),
    );
  });

  describe("a keyed (localised) leaf's keyed level", () => {
    const ESSAY = "00000000-0000-4000-8000-0000000000a3";
    const createEssay = chain.essay.create({
      id: ESSAY,
      state: { title: "On Sand" },
      keyed: { en: { abstract: "Hello" }, fr: { abstract: "Bonjour" } },
      actor: ACTOR,
    });

    it.effect("writes the keyed level at create and reads it in the snapshot", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createEssay;
          const snapshot = yield* chain.essay.getVersion(ESSAY, 0n);
          expect(snapshot.keyed).toEqual({
            en: { abstract: "Hello" },
            fr: { abstract: "Bonjour" },
          });
          expect((yield* chain.book.create({ state: { title: "x" }, actor: ACTOR })).version).toBe(
            0n,
          );
        }),
      ),
    );

    it.effect(
      "carries untouched keys forward, updates a patched key, drops a null one, adds a new one",
      () =>
        inTestTransaction(
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
        ),
    );

    it.effect("carries every key through a tombstone and restores them with restoreVersion", () =>
      inTestTransaction(
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
      ),
    );

    it.effect("reads `{}` for a version that carries no key", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* chain.essay.create({ id: ESSAY, state: { title: "Bare" }, actor: ACTOR });
          expect((yield* chain.essay.getVersion(ESSAY, 0n)).keyed).toEqual({});
        }),
      ),
    );
  });

  describe("head", () => {
    it.effect(
      "reads the head entry, a tombstone's included, and none for an unknown id or another leaf's node",
      () =>
        inTestTransaction(
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
        ),
    );
  });

  describe("an id that isn't a UUID", () => {
    const MALFORMED = "not-a-uuid";

    it.effect("is an unknown node for every operation, and never reaches the database", () =>
      inTestTransaction(
        Effect.gen(function* () {
          expect(yield* chain.book.head(MALFORMED)).toEqual(Option.none());
          expect(yield* tagOf(chain.book.getVersion(MALFORMED, 0n))).toEqual(
            Option.some("VersionNotFound"),
          );
          expect(yield* tagOf(chain.book.history(MALFORMED))).toEqual(Option.some("NodeNotFound"));
          expect(
            yield* tagOf(chain.book.update({ id: MALFORMED, patch: {}, actor: ACTOR })),
          ).toEqual(Option.some("NodeNotFound"));
          expect(
            yield* tagOf(chain.book.restore({ id: MALFORMED, patch: {}, actor: ACTOR })),
          ).toEqual(Option.some("NodeNotFound"));
          expect(yield* tagOf(chain.book.delete(MALFORMED, { actor: ACTOR }))).toEqual(
            Option.some("NodeNotFound"),
          );
          expect(yield* tagOf(chain.book.restoreVersion(MALFORMED, 0n, { actor: ACTOR }))).toEqual(
            Option.some("VersionNotFound"),
          );
          // A `22P02` would have aborted the transaction; it is still usable.
          expect(yield* createBook).toEqual({ id: ID, version: 0n });
        }),
      ),
    );

    it.effect("still finds a node through any spelling PostgreSQL's uuid input accepts", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createBook;
          const heads = yield* Effect.forEach(
            [ID.toUpperCase(), `{${ID}}`, ID.replaceAll("-", "")],
            (spelling) => chain.book.head(spelling),
            { concurrency: 1 },
          );
          expect(heads.map(Option.map((entry) => entry.version))).toEqual([
            Option.some(0n),
            Option.some(0n),
            Option.some(0n),
          ]);
        }),
      ),
    );
  });

  describe("stable columns", () => {
    const PERSON = "00000000-0000-4000-8000-0000000000c1";
    const OTHER = "00000000-0000-4000-8000-0000000000c2";
    const QID = "Q42";

    /** Person `PERSON` at version 0, its stable `wikidata_id` set. */
    const createPerson = chain.person.create({
      id: PERSON,
      state: {},
      stable: { wikidataId: QID },
      actor: ACTOR,
    });

    /** The persons the view resolves, as `[id, version, wikidataId]`. */
    const personRows = Effect.fn("chain.personRows")(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx.select().from(personView).orderBy(personView.id);
      return rows.map((row) => [row.id, row.version, row.wikidataId] as const);
    });

    it.effect("writes the stable extras at create, and the view projects them", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createPerson;
          yield* chain.person.create({ id: OTHER, state: {}, actor: ACTOR });
          expect(yield* personRows()).toEqual([
            [PERSON, 0n, QID],
            [OTHER, 0n, null],
          ]);
        }),
      ),
    );

    it.effect("refuses a second node with the same key, by the consumer's constraint name", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createPerson;
          const attempt = yield* attemptInSavepoint(
            chain.person.create({
              id: OTHER,
              state: {},
              stable: { wikidataId: QID },
              actor: ACTOR,
            }),
          );
          assert(Exit.isFailure(attempt), "unreachable: a duplicate key should have been refused");
          // A typed failure the caller can recover, not a defect.
          expect(Cause.hasDies(attempt.cause)).toBe(false);
          const violation = classifyError(attempt.cause);
          expect(Option.map(violation, (error) => error._tag)).toEqual(
            Option.some("UniqueViolation"),
          );
          expect(
            Option.flatMap(violation, (error) =>
              "constraint" in error ? error.constraint : Option.none(),
            ),
          ).toEqual(Option.some("person_wikidata_id_unique"));
          expect(yield* personRows()).toEqual([[PERSON, 0n, QID]]);
        }),
      ),
    );

    it.effect("appends a second version of one node without touching its stable row", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* createPerson;
          expect(yield* chain.person.update({ id: PERSON, patch: {}, actor: ACTOR })).toEqual({
            id: PERSON,
            version: 1n,
          });
          yield* chain.person.delete(PERSON, { actor: ACTOR });
          yield* chain.person.restoreVersion(PERSON, 0n, { actor: ACTOR });
          expect(yield* personRows()).toEqual([[PERSON, 3n, QID]]);
          const tx = yield* CurrentTransaction;
          const stable = yield* tx
            .select({ wikidataId: person.wikidataId })
            .from(person)
            .where(eq(person.id, PERSON));
          expect(stable).toEqual([{ wikidataId: QID }]);
        }),
      ),
    );
  });
});
