/**
 * A diamond in the fixture tree: `ebook` has two parents, the `printed` and
 * `digital` leaves, under the refinable `artefact` branch. Proven against
 * PostgreSQL: an ebook has a row at every level of both parents, so each
 * parent's view (and the branch view) still lists its whole extent, and a
 * refinement from either parent adds the other.
 *
 * @module packages/pg/tests/integration/tree-diamond
 */

import { eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { makeVersionChain, type ChainRefinement, type ChainRefinements } from "../../src/Chain.ts";
import { makePgDatabase } from "../../src/PgDatabase.ts";
import { makeTestTransaction } from "../../src/Testing.ts";
import {
  artefactView,
  digitalView,
  ebookView,
  ontologyTables,
  ontologyTree,
  printedView,
} from "../fixtures/schema.ts";
import { integrationDatabaseLayer } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;

const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction } = makeTestTransaction(database);

const chain = makeVersionChain({ tree: ontologyTree, tables: ontologyTables, CurrentTransaction });

const ID = "00000000-0000-4000-8000-0000000000d1";
const ACTOR = "actor-1";

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  runInTestTransaction(runtime, effect);

/** Every stable row's `type` for `ID`, by table, root first. */
const stableTypes = Effect.fn("diamond.stableTypes")(function* () {
  const tx = yield* CurrentTransaction;
  const result = yield* tx.execute<{ readonly t: string; readonly type: string }>(
    sql.raw(
      `SELECT 'node' AS t, type FROM ontology.node WHERE id = '${ID}'
       UNION ALL SELECT 'artefact', type FROM ontology.artefact WHERE id = '${ID}'
       UNION ALL SELECT 'printed', type FROM ontology.printed WHERE id = '${ID}'
       UNION ALL SELECT 'digital', type FROM ontology.digital WHERE id = '${ID}'
       UNION ALL SELECT 'ebook', type FROM ontology.ebook WHERE id = '${ID}'`,
    ),
  );
  return R.fromEntries(result.rows.map((row) => [row.t, row.type]));
});

/** What each view on the diamond reads for `ID`. */
const reads = Effect.fn("diamond.reads")(function* () {
  const tx = yield* CurrentTransaction;
  return {
    artefact: yield* tx.select().from(artefactView).where(eq(artefactView.id, ID)),
    printed: yield* tx.select().from(printedView).where(eq(printedView.id, ID)),
    digital: yield* tx.select().from(digitalView).where(eq(digitalView.id, ID)),
    ebook: yield* tx.select().from(ebookView).where(eq(ebookView.id, ID)),
  };
});

describe("a level with two parents", () => {
  it("writes an ebook to both parents' levels and reads it back through every view", async () => {
    await run(
      Effect.gen(function* () {
        yield* chain.ebook.create({
          id: ID,
          state: { caption: "Dune", pressRun: 500, fileSize: 2048, drm: "none" },
          actor: ACTOR,
        });
        yield* chain.ebook.update({ id: ID, patch: { fileSize: 4096 }, actor: ACTOR });
        expect(yield* stableTypes()).toEqual({
          node: "ebook",
          artefact: "ebook",
          printed: "ebook",
          digital: "ebook",
          ebook: "ebook",
        });
        const read = yield* reads();
        expect(read.artefact).toMatchObject([{ version: 1n, type: "ebook", caption: "Dune" }]);
        expect(read.printed).toMatchObject([{ version: 1n, caption: "Dune", pressRun: 500 }]);
        expect(read.digital).toMatchObject([{ version: 1n, caption: "Dune", fileSize: 4096 }]);
        expect(read.ebook).toMatchObject([
          { version: 1n, caption: "Dune", pressRun: 500, fileSize: 4096, drm: "none" },
        ]);
        expect((yield* chain.ebook.getVersion(ID, 0n)).state).toEqual({
          caption: "Dune",
          pressRun: 500,
          fileSize: 2048,
          drm: "none",
        });
      }),
    );
  });

  it("keeps a printed-only node out of the digital and ebook views", async () => {
    await run(
      Effect.gen(function* () {
        yield* chain.printed.create({
          id: ID,
          state: { caption: "Dune", pressRun: 500 },
          actor: ACTOR,
        });
        const read = yield* reads();
        expect(read.artefact).toMatchObject([{ type: "printed" }]);
        expect(read.printed).toMatchObject([{ version: 0n }]);
        expect([read.digital, read.ebook]).toEqual([[], []]);
      }),
    );
  });

  it.each(["printed", "digital"] as const)(
    "refines a %s node to an ebook, adding the other parent's level beside it",
    async (from) => {
      await run(
        Effect.gen(function* () {
          yield* chain[from].create({ id: ID, state: { caption: "Dune" }, actor: ACTOR });
          expect(
            yield* chain.ebook.refine({
              id: ID,
              from,
              patch: { pressRun: 500, fileSize: 2048, drm: "lcp" },
              actor: ACTOR,
              expectedVersion: 0n,
            }),
          ).toEqual({ id: ID, version: 1n });
          expect(yield* stableTypes()).toEqual({
            node: "ebook",
            artefact: "ebook",
            printed: "ebook",
            digital: "ebook",
            ebook: "ebook",
          });
          const read = yield* reads();
          expect(read.ebook).toMatchObject([
            { version: 1n, caption: "Dune", pressRun: 500, fileSize: 2048, drm: "lcp" },
          ]);
          expect(read.printed).toMatchObject([{ version: 1n }]);
          expect(read.digital).toMatchObject([{ version: 1n }]);
          expect(read.artefact).toMatchObject([{ version: 1n, type: "ebook" }]);
          expect(yield* chain[from].head(ID)).toEqual(Option.none());
        }),
      );
    },
  );

  it("types a refinement from either parent, adding the other parent's level", () => {
    type Spec = typeof ontologyTree.spec;
    type Tables = typeof ontologyTables;
    expectTypeOf<keyof ChainRefinements<Spec, Tables, "ebook">>().toEqualTypeOf<
      "printed" | "digital"
    >();
    type FromDigital = ChainRefinement<Spec, Tables, "ebook", "digital">["patch"];
    expectTypeOf<FromDigital>().toHaveProperty("pressRun");
    expectTypeOf<FromDigital>().toHaveProperty("drm");
    expectTypeOf<ChainRefinement<Spec, Tables, "ebook", "printed">["patch"]>().toHaveProperty(
      "fileSize",
    );
  });
});
