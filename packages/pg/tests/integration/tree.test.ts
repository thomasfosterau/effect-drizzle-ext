/**
 * The tables `makeTreeTables` derives from the fixture tree
 * (`tests/fixtures/schema.ts`), proven against PostgreSQL: the migration
 * drizzle-kit generated from them applies (the global setup ran it), the
 * discriminator CHECK and `(id, type)` arc refuse a wrong `type` at every
 * level, the `(id, version)` chain refuses a version its parent doesn't
 * carry, a refinable branch cascades a flipped `type`, and deleting a node
 * removes its whole chain, fact tables included.
 *
 * Every rejection runs inside `attemptInSavepoint`, so one refused statement
 * doesn't abort the spec's transaction.
 *
 * @module packages/pg/tests/integration/tree
 */

import { classifyError } from "@thomasfosterau/effect-drizzle-ext/errors";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { assert, describe, expect, it } from "vite-plus/test";
import { integrationDatabaseLayer } from "./database-url.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;

const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction, attemptInSavepoint } = makeTestTransaction(database);

const BOOK = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const EDITION = "00000000-0000-4000-8000-000000000003";

const exec = Effect.fn("tree.exec")(function* (statement: string) {
  const tx = yield* CurrentTransaction;
  yield* tx.execute(sql.raw(statement));
});

/** The constraint PostgreSQL names when it refuses `statement`. */
const refusedBy = Effect.fn("tree.refusedBy")(function* (statement: string) {
  const attempt = yield* attemptInSavepoint(exec(statement));
  assert(Exit.isFailure(attempt), `unreachable: ${statement} should have been refused`);
  return Option.flatMap(classifyError(attempt.cause), (violation) =>
    "constraint" in violation ? violation.constraint : Option.none(),
  );
});

/** A book at version 0: the root, the work level and the leaf, each stable + version. */
const seedBook = Effect.fn("tree.seedBook")(function* () {
  yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${BOOK}', 'book')`);
  yield* exec(
    `INSERT INTO ontology.node_version (id, version, action) VALUES ('${BOOK}', 0, 'create')`,
  );
  yield* exec(`INSERT INTO ontology.work (id, type) VALUES ('${BOOK}', 'book')`);
  yield* exec(
    `INSERT INTO ontology.work_version (id, version, title) VALUES ('${BOOK}', 0, 'Dune')`,
  );
  yield* exec(`INSERT INTO ontology.book (id, type) VALUES ('${BOOK}', 'book')`);
  yield* exec(`INSERT INTO ontology.book_version (id, version, pages) VALUES ('${BOOK}', 0, 412)`);
});

describe("makeTreeTables against PostgreSQL", () => {
  it("accepts a well-formed chain", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedBook();
        const tx = yield* CurrentTransaction;
        const rows = yield* tx.execute<{ readonly title: string }>(
          sql`SELECT title FROM ontology.work_version WHERE id = ${BOOK}`,
        );
        expect(rows.rows.map((row) => row.title)).toEqual(["Dune"]);
      }),
    );
  });

  it("refuses a type outside the level's subtree, at every level", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${AGENT}', 'person')`);
        expect(
          yield* refusedBy(`INSERT INTO ontology.work (id, type) VALUES ('${AGENT}', 'person')`),
        ).toEqual(Option.some("work_type_valid"));
        expect(
          yield* refusedBy(`INSERT INTO ontology.agent (id, type) VALUES ('${AGENT}', 'book')`),
        ).toEqual(Option.some("agent_type_valid"));
        yield* exec(`INSERT INTO ontology.agent (id, type) VALUES ('${AGENT}', 'person')`);
        expect(
          yield* refusedBy(
            `INSERT INTO ontology.person (id, type) VALUES ('${AGENT}', 'organisation')`,
          ),
        ).toEqual(Option.some("person_type_valid"));
      }),
    );
  });

  it("refuses a type that disagrees with the parent's (a sibling chimera)", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${BOOK}', 'book')`);
        expect(
          yield* refusedBy(`INSERT INTO ontology.work (id, type) VALUES ('${BOOK}', 'essay')`),
        ).toEqual(Option.some("work_id_type_fk"));
        yield* exec(`INSERT INTO ontology.work (id, type) VALUES ('${BOOK}', 'book')`);
        expect(
          yield* refusedBy(`INSERT INTO ontology.essay (id, type) VALUES ('${BOOK}', 'essay')`),
        ).toEqual(Option.some("essay_id_type_fk"));
      }),
    );
  });

  it("refuses a level version the parent's version chain doesn't carry", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedBook();
        expect(
          yield* refusedBy(
            `INSERT INTO ontology.book_version (id, version, pages) VALUES ('${BOOK}', 1, 500)`,
          ),
        ).toEqual(Option.some("book_version_work_version_fk"));
        expect(
          yield* refusedBy(
            `INSERT INTO ontology.work_version (id, version, title) VALUES ('${BOOK}', 1, 'Dune')`,
          ),
        ).toEqual(Option.some("work_version_node_version_fk"));
        expect(
          yield* refusedBy(
            `INSERT INTO ontology.node_version (id, version, action) VALUES ('${BOOK}', 1, 'publish')`,
          ),
        ).toEqual(Option.some("node_version_action_valid"));
      }),
    );
  });

  it("cascades a flipped type down a refinable branch, and refuses one elsewhere", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${AGENT}', 'person')`);
        yield* exec(`INSERT INTO ontology.agent (id, type) VALUES ('${AGENT}', 'person')`);
        yield* exec(`UPDATE ontology.node SET type = 'organisation' WHERE id = '${AGENT}'`);
        const tx = yield* CurrentTransaction;
        const rows = yield* tx.execute<{ readonly type: string }>(
          sql`SELECT type FROM ontology.agent WHERE id = ${AGENT}`,
        );
        expect(rows.rows.map((row) => row.type)).toEqual(["organisation"]);
        yield* exec(
          `INSERT INTO ontology.organisation (id, type) VALUES ('${AGENT}', 'organisation')`,
        );

        yield* seedBook();
        expect(
          yield* refusedBy(`UPDATE ontology.node SET type = 'essay' WHERE id = '${BOOK}'`),
        ).toEqual(Option.some("work_id_type_fk"));
      }),
    );
  });

  it("keys a fact-scoped level's facts on its spine, and deletes a node's whole chain", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* exec(`INSERT INTO ontology.node (id, type) VALUES ('${EDITION}', 'edition')`);
        yield* exec(
          `INSERT INTO ontology.node_version (id, version, action) VALUES ('${EDITION}', 0, 'create')`,
        );
        yield* exec(
          `INSERT INTO ontology.manifestation (id, type) VALUES ('${EDITION}', 'edition')`,
        );
        expect(
          yield* refusedBy(
            `INSERT INTO ontology.manifestation_isbn (id, version, isbn) VALUES ('${EDITION}', 0, '978')`,
          ),
        ).toEqual(Option.some("manifestation_isbn_manifestation_version_fk"));
        yield* exec(
          `INSERT INTO ontology.manifestation_version (id, version) VALUES ('${EDITION}', 0)`,
        );
        yield* exec(
          `INSERT INTO ontology.manifestation_isbn (id, version, isbn) VALUES ('${EDITION}', 0, '978')`,
        );

        yield* exec(`DELETE FROM ontology.node WHERE id = '${EDITION}'`);
        const tx = yield* CurrentTransaction;
        const left = yield* tx.execute<{ readonly n: string }>(
          sql`SELECT count(*) AS n FROM ontology.manifestation_isbn WHERE id = ${EDITION}`,
        );
        expect(left.rows.map((row) => Number(row.n))).toEqual([0]);
      }),
    );
  });

  it("deletes a multi-level leaf's whole chain with its node (effect-drizzle-ext#145)", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedBook();
        yield* exec(`DELETE FROM ontology.node WHERE id = '${BOOK}'`);
        const tx = yield* CurrentTransaction;
        const left = yield* tx.execute<{ readonly n: string }>(
          sql`SELECT (SELECT count(*) FROM ontology.node_version WHERE id = ${BOOK})
            + (SELECT count(*) FROM ontology.work_version WHERE id = ${BOOK})
            + (SELECT count(*) FROM ontology.book_version WHERE id = ${BOOK}) AS n`,
        );
        expect(left.rows.map((row) => Number(row.n))).toEqual([0]);
      }),
    );
  });
});
