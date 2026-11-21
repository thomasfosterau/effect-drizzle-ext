/**
 * Unit tests for `src/QueryFunctions.ts`, the context-bound query functions.
 *
 * Driven against sentinel handles whose builders report which handle ran
 * them, so an assertion can say WHERE a deferred query ran (the open
 * transaction or the client) as well as WHAT it replayed. The `@effect/sql-pg`
 * binding's types, and a run against a real client, are the pg package's
 * tests.
 *
 * @module tests/query-functions
 */

import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import { makeDatabaseServices } from "../src/Database.ts";
import { DeferredQueryError, makeQueryFunctions } from "../src/QueryFunctions.ts";

/** A builder whose every link is recorded, and which runs as an Effect. */
interface StubBuilder extends Effect.Effect<string> {
  readonly from: (table: string) => StubBuilder;
  readonly where: (condition: string) => StubBuilder;
  readonly toSQL: () => string;
}

interface StubHandle {
  readonly label: string;
  readonly select: (fields?: string) => StubBuilder;
  readonly selectDistinct: unknown;
  readonly selectDistinctOn: unknown;
  readonly with: unknown;
  readonly $count: unknown;
  readonly query: { readonly users: { readonly findFirst: () => Effect.Effect<string> } };
  readonly notAQuery: () => number;
  readonly transaction: <A, E, R>(
    f: (tx: StubHandle) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/** A builder over `parts`, evaluating to the handle's label and the SQL-ish chain. */
const builder = (label: string, parts: ReadonlyArray<string>): StubBuilder =>
  Object.assign(
    Effect.sync(() => `${label}: ${parts.join(" ")}`),
    {
      from: (table: string) => builder(label, [...parts, `from ${table}`]),
      where: (condition: string) => builder(label, [...parts, `where ${condition}`]),
      toSQL: () => parts.join(" "),
    },
  );

const stubHandle = (label: string): StubHandle => {
  const handle: StubHandle = {
    label,
    select: (fields = "*") => builder(label, [`select ${fields}`]),
    selectDistinct: undefined,
    selectDistinctOn: undefined,
    with: undefined,
    $count: undefined,
    query: { users: { findFirst: () => Effect.succeed(`${label}: first user`) } },
    notAQuery: () => 42,
    transaction: (f) => f(stubHandle(`${label}>tx`)),
  };
  return handle;
};

/** The surface a binding would name: the handle's members, requiring the key. */
interface StubSurface {
  readonly select: (fields?: string) => StubSurfaceBuilder;
  readonly query: {
    readonly users: { readonly findFirst: () => Effect.Effect<string, never, "Stub"> };
  };
  readonly notAQuery: () => Effect.Effect<number, never, "Stub">;
  readonly missing: () => Effect.Effect<number, never, "Stub">;
}

interface StubSurfaceBuilder extends Effect.Effect<string, never, "Stub"> {
  readonly from: (table: string) => StubSurfaceBuilder;
  readonly where: (condition: string) => StubSurfaceBuilder;
  readonly toSQL: () => string;
}

const services = makeDatabaseServices<StubHandle, StubHandle>()({ key: "Stub" });
const { Database, CurrentTransaction, transact } = services;
const { select, query, notAQuery, missing } = makeQueryFunctions<StubSurface>()(services);

const DB_HANDLE = stubHandle("database");

const withDatabase = <A, E>(effect: Effect.Effect<A, E, "Stub">): Effect.Effect<A, E> =>
  Effect.provideService(effect, Database, DB_HANDLE);

/** The `DeferredQueryError` a deferred query died with, if it died with one. */
const deferredDefect = (exit: Exit.Exit<unknown, unknown>): Option.Option<DeferredQueryError> =>
  Exit.isFailure(exit)
    ? Option.liftPredicate(Cause.squash(exit.cause), Schema.is(DeferredQueryError))
    : Option.none();

describe("makeQueryFunctions", () => {
  it.effect("replays the recorded chain against the Database client", () =>
    Effect.gen(function* () {
      const rows = yield* withDatabase(select("id").from("users").where("id = 1"));
      expect(rows).toBe("database: select id from users where id = 1");
    }),
  );

  it.effect("runs on the open CurrentTransaction instead of the client", () =>
    Effect.gen(function* () {
      const rows = yield* withDatabase(
        Effect.provideService(select().from("users"), CurrentTransaction, stubHandle("open")),
      );
      expect(rows).toBe("open: select * from users");
    }),
  );

  it.effect("lands a query yielded inside transact in that transaction", () =>
    Effect.gen(function* () {
      const rows = yield* withDatabase(transact(select().from("users")));
      expect(rows).toBe("database>tx: select * from users");
    }),
  );

  it.effect("resolves the handle each time it is yielded, not when it is built", () =>
    Effect.gen(function* () {
      const users = select().from("users");
      const outside = yield* withDatabase(users);
      const inside = yield* withDatabase(transact(users));
      expect([outside, inside]).toEqual([
        "database: select * from users",
        "database>tx: select * from users",
      ]);
    }),
  );

  it.effect("keeps each link of a shared prefix independent", () =>
    Effect.gen(function* () {
      const users = select().from("users");
      const one = yield* withDatabase(users.where("id = 1"));
      const all = yield* withDatabase(users);
      expect([one, all]).toEqual([
        "database: select * from users where id = 1",
        "database: select * from users",
      ]);
    }),
  );

  it.effect("replays member reads through nested objects (relational queries)", () =>
    Effect.gen(function* () {
      expect(yield* withDatabase(query.users.findFirst())).toBe("database: first user");
    }),
  );

  it.effect("composes with pipe like any Effect", () =>
    Effect.gen(function* () {
      const length = yield* withDatabase(
        select()
          .from("users")
          .pipe(Effect.map((rows) => rows.length)),
      );
      expect(length).toBe("database: select * from users".length);
    }),
  );

  it("is an Effect, and never a promise", () => {
    const users = select().from("users");
    expect(Effect.isEffect(users)).toBe(true);
    expect("then" in users).toBe(false);
  });

  it("throws a DeferredQueryError for members that need a real builder", () => {
    const users = select().from("users");
    expect(() => users.toSQL()).toThrow(DeferredQueryError);
    expect(() => users.toSQL()).toThrow(/select\(…\)\.from\(…\)\.toSQL/);
  });

  it.effect("dies with a DeferredQueryError when the chain ends in a non-Effect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(withDatabase(notAQuery()));
      const defect = deferredDefect(exit);
      expect(Option.isSome(defect)).toBe(true);
      expect(Option.map(defect, (error) => error.message)).toEqual(
        Option.some(
          "notAQuery(…) did not build a query: the handle returned a value that is not an Effect",
        ),
      );
    }),
  );

  it.effect("dies with a DeferredQueryError when the handle lacks a member", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(withDatabase(missing()));
      expect(Option.map(deferredDefect(exit), (error) => error.message)).toEqual(
        Option.some("missing is not a member of the handle"),
      );
    }),
  );
});

/** A `mapQuery` that marks every row set it saw, so a test can tell it ran. */
const wrapRows = <A, E, R>(built: Effect.Effect<A, E, R>): Effect.Effect<string, E, R> =>
  Effect.map(built, (rows) => `mapped(${String(rows)})`);

describe("makeQueryFunctions mapQuery", () => {
  const mapped = makeQueryFunctions<StubSurface>()(services, { mapQuery: wrapRows });

  it.effect("wraps the real query a deferred one replays to", () =>
    Effect.gen(function* () {
      const rows = yield* withDatabase(mapped.select().from("users"));
      expect(rows).toBe("mapped(database: select * from users)");
    }),
  );

  it.effect("runs inside the query's context, on the open transaction", () =>
    Effect.gen(function* () {
      const rows = yield* withDatabase(transact(mapped.query.users.findFirst()));
      expect(rows).toBe("mapped(database>tx: first user)");
    }),
  );
});
