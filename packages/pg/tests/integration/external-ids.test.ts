/**
 * `./ExternalIds` against PostgreSQL, over a `TEMPORARY` table with the
 * builder's keys: a link is made once and never moved, a taken id says so,
 * and lookups and a node's links read back what was linked.
 *
 * @module packages/pg/tests/integration/external-ids
 */

import { sql } from "drizzle-orm";
import { pgTable, uuid } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { makeExternalIdStore, makeExternalIdTable } from "../../src/ExternalIds.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import { integrationLayer } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;
const { inTestTransaction, attemptInSavepoint } = makeTestTransaction(database);

const node = pgTable("external_ids_node", { id: uuid("id").primaryKey() });
const externalIds = makeExternalIdTable({ identity: node, name: "external_ids_spec" });
const store = makeExternalIdStore({ table: externalIds, CurrentTransaction });

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const seed = Effect.fn("externalIds.seed")(function* () {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql`
    CREATE TEMPORARY TABLE external_ids_spec (
      authority text NOT NULL,
      external_id text NOT NULL,
      node_id uuid NOT NULL,
      CONSTRAINT external_ids_spec_pkey PRIMARY KEY (authority, external_id),
      CONSTRAINT external_ids_spec_node UNIQUE (node_id, authority)
    )`);
});

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  inTestTransaction(Effect.andThen(seed(), effect));

integrationLayer(database)((it) => {
  describe("makeExternalIdStore", () => {
    it.effect("links once, reports a present link, and never moves a taken one", () =>
      run(
        Effect.gen(function* () {
          expect(yield* store.link({ authority: "wikidata", externalId: "Q1", nodeId: A })).toBe(
            "linked",
          );
          expect(yield* store.link({ authority: "wikidata", externalId: "Q1", nodeId: A })).toBe(
            "present",
          );
          expect(yield* store.link({ authority: "wikidata", externalId: "Q1", nodeId: B })).toBe(
            "taken",
          );
          expect(yield* store.link({ authority: "viaf", externalId: "1", nodeId: A })).toBe(
            "linked",
          );
          const second = yield* attemptInSavepoint(
            store.link({ authority: "wikidata", externalId: "Q2", nodeId: A }),
          );
          expect(Exit.isFailure(second)).toBe(true);
        }),
      ),
    );

    it.effect("looks up by authority and lists a node's links", () =>
      run(
        Effect.gen(function* () {
          yield* store.link({ authority: "wikidata", externalId: "Q1", nodeId: A });
          yield* store.link({ authority: "wikidata", externalId: "Q2", nodeId: B });
          yield* store.link({ authority: "viaf", externalId: "Q2", nodeId: A });
          const found = yield* store.lookup("wikidata", ["Q1", "Q2", "Q3", "Q1"]);
          expect(HashMap.get(found, "Q1")).toEqual(Option.some(A));
          expect(HashMap.get(found, "Q2")).toEqual(Option.some(B));
          expect(HashMap.size(found)).toBe(2);
          expect(HashMap.size(yield* store.lookup("wikidata", []))).toBe(0);
          expect(yield* store.linksOf(A)).toEqual([
            { authority: "viaf", externalId: "Q2", nodeId: A },
            { authority: "wikidata", externalId: "Q1", nodeId: A },
          ]);
          expect(yield* store.linksOf("not-a-uuid")).toEqual([]);
        }),
      ),
    );
  });
});
