/**
 * `makePgDatabase`'s `locate` against the live driver: raise each violation
 * for real through the context-bound queries and assert the error resolves
 * to the Drizzle table and columns that declared it.
 *
 * The tables live in a schema created inside the harness transaction, so the
 * always-rollback disposes of them; the DDL is what `drizzle-kit export`
 * emits for these declarations, constraint names included, so the names
 * `locate` matches are the ones a migrated database really has.
 *
 * @module packages/pg/tests/integration/locate
 */

import { defineRelations, sql } from "drizzle-orm";
import { check, integer, pgSchema, text, unique } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { assert, describe, expect } from "vite-plus/test";
import { integrationLayer } from "./database-url.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";

const locateSchema = pgSchema("edx_locate");

const owners = locateSchema.table("owners", {
  id: integer("id").primaryKey(),
  handle: text("handle").notNull().unique(),
});

const pets = locateSchema.table(
  "pets",
  {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => owners.id),
    name: text("name").notNull(),
    legs: integer("legs").notNull(),
  },
  (table) => [
    unique().on(table.ownerId, table.name),
    check("pets_legs_check", sql`${table.legs} >= 0`),
  ],
);

const relations = defineRelations({ owners, pets });
const database = makePgDatabase({ relations, key: "Database" });
const { insert } = database.queries;

const { inTestTransaction, attemptInSavepoint } = makeTestTransaction(database);

/** The tables, as `drizzle-kit export` writes them for the declarations above. */
const seed = Effect.fn("locate.seed")(function* () {
  const { execute } = database.queries;
  yield* execute(sql`CREATE SCHEMA "edx_locate"`);
  yield* execute(sql`
    CREATE TABLE "edx_locate"."owners" (
      "id" integer PRIMARY KEY,
      "handle" text NOT NULL UNIQUE
    )
  `);
  yield* execute(sql`
    CREATE TABLE "edx_locate"."pets" (
      "id" integer PRIMARY KEY,
      "owner_id" integer NOT NULL,
      "name" text NOT NULL,
      "legs" integer NOT NULL,
      CONSTRAINT "pets_owner_id_name_unique" UNIQUE("owner_id","name"),
      CONSTRAINT "pets_legs_check" CHECK ("legs" >= 0)
    )
  `);
  yield* execute(sql`
    ALTER TABLE "edx_locate"."pets" ADD CONSTRAINT "pets_owner_id_owners_id_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "edx_locate"."owners"("id")
  `);
  yield* insert(owners).values({ id: 1, handle: "ada" });
  yield* insert(pets).values({ id: 1, ownerId: 1, name: "Rex", legs: 4 });
});

/** Runs a failing write in a SAVEPOINT and returns where `locate` puts its failure. */
const locateRejection = Effect.fn("locate.rejection")(function* <A, E>(
  write: Effect.Effect<A, E, "Database">,
) {
  const attempt = yield* attemptInSavepoint(write);
  assert(Exit.isFailure(attempt), "unreachable: the write should have failed");
  return database.locate(attempt.cause);
});

/** The location, failing the test when there is none. */
const located = <A>(option: Option.Option<A>): A =>
  Option.getOrElse(option, () => expect.unreachable("locate found no table"));

integrationLayer(database)((it) => {
  describe("locate against the live driver", () => {
    it.effect("resolves a column-level unique violation (Postgres' own constraint name)", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const location = located(
            yield* locateRejection(insert(owners).values({ id: 2, handle: "ada" })),
          );
          expect(location.table).toBe(owners);
          expect(location.columns).toStrictEqual([owners.handle]);
        }),
      ),
    );

    it.effect("resolves a composite unique violation and a primary key violation", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const composite = located(
            yield* locateRejection(
              insert(pets).values({ id: 2, ownerId: 1, name: "Rex", legs: 3 }),
            ),
          );
          expect(composite.table).toBe(pets);
          expect(composite.columns).toStrictEqual([pets.ownerId, pets.name]);

          const primary = located(
            yield* locateRejection(
              insert(pets).values({ id: 1, ownerId: 1, name: "Fido", legs: 4 }),
            ),
          );
          expect(primary.columns).toStrictEqual([pets.id]);
        }),
      ),
    );

    it.effect("resolves a foreign key violation to the referencing column", () =>
      inTestTransaction(
        Effect.gen(function* () {
          yield* seed();
          const location = located(
            yield* locateRejection(
              insert(pets).values({ id: 3, ownerId: 99, name: "Tom", legs: 4 }),
            ),
          );
          expect(location.table).toBe(pets);
          expect(location.columns).toStrictEqual([pets.ownerId]);
        }),
      ),
    );

    it.effect(
      "resolves a NOT NULL violation to its column, and a CHECK violation to its table",
      () =>
        inTestTransaction(
          Effect.gen(function* () {
            yield* seed();
            const notNull = located(
              yield* locateRejection(
                database.queries.execute(
                  sql`INSERT INTO "edx_locate"."pets" (id, owner_id, legs) VALUES (4, 1, 4)`,
                ),
              ),
            );
            expect(notNull.columns).toStrictEqual([pets.name]);

            const checked = located(
              yield* locateRejection(
                insert(pets).values({ id: 5, ownerId: 1, name: "Odd", legs: -1 }),
              ),
            );
            expect(checked.table).toBe(pets);
            expect(checked.columns).toStrictEqual([]);
          }),
        ),
    );
  });
});
