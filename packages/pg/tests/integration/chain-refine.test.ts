/**
 * `LeafChain.refine` over the fixture tree's refinable `realm` branch: a node
 * of the `party` leaf, which has children, refined to `member` (one added
 * level, with a stable column) or `band` (two added levels). Proven against
 * PostgreSQL, so the `(id, type)` arcs really cascade the new `type`.
 *
 * @module packages/pg/tests/integration/chain-refine
 */

import { eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { makeVersionChain, type ChainRefinement, type ChainRefinements } from "../../src/chain.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import {
  bandView,
  member,
  memberView,
  node,
  ontologyTables,
  ontologyTree,
  partyView,
  realmView,
} from "../fixtures/schema.ts";
import { integrationDatabaseLayer } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;

const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction } = makeTestTransaction(database);

const chain = makeVersionChain({ tree: ontologyTree, tables: ontologyTables, CurrentTransaction });

const ID = "00000000-0000-4000-8000-0000000000c1";
const ACTOR = "actor-1";

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  runInTestTransaction(runtime, effect);

/** The tag of an effect's typed failure, if it failed with one. */
const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Option.map(Exit.findErrorOption(exit), (error) => error._tag),
  );

/** The party `ID` at version 0, then version 1. */
const createParty = Effect.fn("refine.createParty")(function* () {
  yield* chain.party.create({ id: ID, state: { handle: "ada" }, actor: ACTOR });
  return yield* chain.party.update({ id: ID, patch: { handle: "ada-l" }, actor: ACTOR });
});

/** Every stable row's `type` for `ID`, by table, root first. */
const stableTypes = Effect.fn("refine.stableTypes")(function* () {
  const tx = yield* CurrentTransaction;
  const result = yield* tx.execute<{ readonly t: string; readonly type: string }>(
    sql.raw(
      `SELECT 'node' AS t, type FROM ontology.node WHERE id = '${ID}'
       UNION ALL SELECT 'realm', type FROM ontology.realm WHERE id = '${ID}'
       UNION ALL SELECT 'party', type FROM ontology.party WHERE id = '${ID}'
       UNION ALL SELECT 'guild', type FROM ontology.guild WHERE id = '${ID}'
       UNION ALL SELECT 'member', type FROM ontology.member WHERE id = '${ID}'
       UNION ALL SELECT 'band', type FROM ontology.band WHERE id = '${ID}'`,
    ),
  );
  return R.fromEntries(result.rows.map((row) => [row.t, row.type]));
});

describe("a leaf with children", () => {
  it("is a node type of its own, in its leaf view and its ancestor's branch view", async () => {
    await run(
      Effect.gen(function* () {
        yield* createParty();
        const tx = yield* CurrentTransaction;
        expect(yield* tx.select().from(partyView).where(eq(partyView.id, ID))).toMatchObject([
          { version: 1n, handle: "ada-l" },
        ]);
        expect(yield* tx.select().from(realmView).where(eq(realmView.id, ID))).toMatchObject([
          { version: 1n, type: "party" },
        ]);
        expect(yield* chain.party.getVersion(ID, 1n)).toMatchObject({
          state: { handle: "ada-l" },
        });
      }),
    );
  });
});

describe("refine", () => {
  it("flips the type, adds the new levels' stable rows and appends one version carrying the state", async () => {
    await run(
      Effect.gen(function* () {
        yield* createParty();
        expect(
          yield* chain.member.refine({
            id: ID,
            from: "party",
            patch: { rank: 3 },
            stable: { badge: "gold" },
            actor: ACTOR,
            expectedVersion: 1n,
          }),
        ).toEqual({ id: ID, version: 2n });
        expect(yield* stableTypes()).toEqual({
          node: "member",
          realm: "member",
          party: "member",
          member: "member",
        });
        const tx = yield* CurrentTransaction;
        expect(
          (yield* tx.select().from(member).where(eq(member.id, ID))).map((row) => row.badge),
        ).toEqual(["gold"]);
        const refined = yield* chain.member.getVersion(ID, 2n);
        expect([refined.action, refined.state]).toEqual(["update", { handle: "ada-l", rank: 3 }]);
        // Earlier versions predate the member level: fail closed.
        expect(yield* tagOf(chain.member.getVersion(ID, 1n))).toEqual(
          Option.some("VersionNotFound"),
        );
        expect(
          (yield* chain.member.history(ID)).map((entry) => [entry.version, entry.action]),
        ).toEqual([
          [0n, "create"],
          [1n, "update"],
          [2n, "update"],
        ]);
        expect(yield* chain.party.head(ID)).toEqual(Option.none());
        expect(yield* tx.select().from(memberView).where(eq(memberView.id, ID))).toMatchObject([
          { version: 2n, handle: "ada-l", badge: "gold", rank: 3 },
        ]);
        // The party level still has a row at the head, so its view keeps the node.
        expect(yield* tx.select().from(partyView).where(eq(partyView.id, ID))).toMatchObject([
          { version: 2n, handle: "ada-l" },
        ]);
        expect(yield* tx.select().from(realmView).where(eq(realmView.id, ID))).toMatchObject([
          { version: 2n, type: "member" },
        ]);
        // The refined node goes on as an ordinary member.
        yield* chain.member.update({ id: ID, patch: { rank: 4 }, actor: ACTOR });
        expect((yield* chain.member.getVersion(ID, 3n)).state).toEqual({
          handle: "ada-l",
          rank: 4,
        });
      }),
    );
  });

  it("adds every level below `from`, the patch supplying their required columns", async () => {
    await run(
      Effect.gen(function* () {
        yield* createParty();
        yield* chain.band.refine({
          id: ID,
          from: "party",
          patch: { handle: "the-adas", motto: "loud", genre: "punk" },
          actor: ACTOR,
        });
        expect(yield* stableTypes()).toEqual({
          node: "band",
          realm: "band",
          party: "band",
          guild: "band",
          band: "band",
        });
        const tx = yield* CurrentTransaction;
        expect(yield* tx.select().from(bandView).where(eq(bandView.id, ID))).toMatchObject([
          { version: 2n, handle: "the-adas", motto: "loud", genre: "punk" },
        ]);
      }),
    );
  });

  it("writes nothing when the expected version is not from's head", async () => {
    await run(
      Effect.gen(function* () {
        yield* createParty();
        const stale = yield* Effect.flip(
          chain.member.refine({
            id: ID,
            from: "party",
            patch: {},
            actor: ACTOR,
            expectedVersion: 0n,
          }),
        );
        expect(stale).toMatchObject({ _tag: "StaleVersion", type: "party", current: 1n });
        expect(yield* stableTypes()).toEqual({ node: "party", realm: "party", party: "party" });
      }),
    );
  });

  it("fails NodeNotFound for a node not of `from`, or a tombstone", async () => {
    await run(
      Effect.gen(function* () {
        const refine = chain.member.refine({ id: ID, from: "party", patch: {}, actor: ACTOR });
        expect(yield* tagOf(refine)).toEqual(Option.some("NodeNotFound"));
        yield* createParty();
        yield* refine;
        expect(yield* tagOf(refine)).toEqual(Option.some("NodeNotFound"));
        expect(
          yield* tagOf(
            chain.band.refine({ id: ID, from: "party", patch: { motto: "x" }, actor: ACTOR }),
          ),
        ).toEqual(Option.some("NodeNotFound"));
        const other = yield* chain.party.create({ state: { handle: "bo" }, actor: ACTOR });
        yield* chain.party.delete(other.id, { actor: ACTOR });
        expect(
          yield* tagOf(
            chain.member.refine({ id: other.id, from: "party", patch: {}, actor: ACTOR }),
          ),
        ).toEqual(Option.some("NodeNotFound"));
        const tx = yield* CurrentTransaction;
        expect(
          (yield* tx.select().from(node).where(eq(node.id, other.id))).map((row) => row.type),
        ).toEqual(["party"]);
      }),
    );
  });

  it("types `from` and the added levels' required columns", () => {
    type Spec = typeof ontologyTree.spec;
    type Tables = typeof ontologyTables;
    expectTypeOf<keyof ChainRefinements<Spec, Tables, "band">>().toEqualTypeOf<"party">();
    expectTypeOf<keyof ChainRefinements<Spec, Tables, "book">>().toEqualTypeOf<never>();
    type BandFromParty = ChainRefinement<Spec, Tables, "band", "party">;
    expectTypeOf<BandFromParty["patch"]["motto"]>().toEqualTypeOf<string>();
    expectTypeOf<{ readonly motto: string }>().toExtend<BandFromParty["patch"]>();
  });
});
