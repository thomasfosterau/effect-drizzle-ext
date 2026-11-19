/**
 * Unit coverage for `makePgDatabase`'s `queries`: the context-bound query
 * functions typed over Drizzle's own builders.
 *
 * Nothing here touches a database. The type assertions are the point: every
 * builder keeps the result type Drizzle infers from the schema, and its
 * requirement channel is the database key and nothing else, so a missing
 * `Database` layer is a compile error rather than a runtime one. The runtime
 * replay is core's unit suite; a run against a real server is
 * `tests/integration/query-functions.test.ts`.
 *
 * @module packages/pg/tests/query-functions
 */

import { eq } from "drizzle-orm";
import { defineRelations } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import type * as Effect from "effect/Effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { makePgDatabase } from "../src/index.ts";

const users = pgTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  nickname: text("nickname"),
});

const relations = defineRelations({ users });

const database = makePgDatabase({ relations, key: "TypedDb" });
const { select, insert, update, query, $count } = database.queries;
const deleteFrom = database.queries.delete;

/** The success, error and requirement channels of an Effect, for assertions. */
type Channels<T> =
  T extends Effect.Effect<infer A, infer E, infer R> ? { A: A; E: E; R: R } : never;

describe("makePgDatabase queries", () => {
  it("types a select by the schema and requires the key", () => {
    const rows = select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(eq(users.id, 1));
    expectTypeOf<Channels<typeof rows>["A"]>().toEqualTypeOf<
      { id: number; nickname: string | null }[]
    >();
    expectTypeOf<Channels<typeof rows>["R"]>().toEqualTypeOf<"TypedDb">();
  });

  it("types insert … returning, update and delete the same way", () => {
    const inserted = insert(users).values({ id: 1, name: "Ada" }).returning({ id: users.id });
    expectTypeOf<Channels<typeof inserted>["A"]>().toEqualTypeOf<{ id: number }[]>();
    expectTypeOf<Channels<typeof inserted>["R"]>().toEqualTypeOf<"TypedDb">();

    const renamed = update(users).set({ name: "Grace" }).where(eq(users.id, 1)).returning();
    expectTypeOf<Channels<typeof renamed>["A"]>().toEqualTypeOf<
      { id: number; name: string; nickname: string | null }[]
    >();
    expectTypeOf<Channels<typeof renamed>["R"]>().toEqualTypeOf<"TypedDb">();

    const removed = deleteFrom(users).where(eq(users.id, 1));
    expectTypeOf<Channels<typeof removed>["R"]>().toEqualTypeOf<"TypedDb">();
  });

  it("types the relational query and $count from the relations graph", () => {
    const first = query.users.findFirst({ columns: { name: true } });
    expectTypeOf<Channels<typeof first>["A"]>().toEqualTypeOf<{ name: string } | undefined>();
    expectTypeOf<Channels<typeof first>["R"]>().toEqualTypeOf<"TypedDb">();

    const counted = $count(users);
    expectTypeOf<Channels<typeof counted>["A"]>().toEqualTypeOf<number>();
    expectTypeOf<Channels<typeof counted>["R"]>().toEqualTypeOf<"TypedDb">();
  });

  it("keeps the client's own error type", () => {
    const rows = select().from(users);
    const fromClient = (db: Effect.Success<typeof database.make>) => db.select().from(users);
    expectTypeOf<Channels<typeof rows>["E"]>().toEqualTypeOf<
      Channels<ReturnType<typeof fromClient>>["E"]
    >();
  });

  it("leaves out the transaction boundary", () => {
    // `transact` is the boundary; a context-bound `transaction` would be a
    // second, differently behaved one.
    expectTypeOf(database.queries).not.toHaveProperty("transaction");
    expect(database.queries).toBeDefined();
  });
});
