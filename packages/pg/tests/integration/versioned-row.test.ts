/**
 * `./VersionedRow` against PostgreSQL, over a plain table with a
 * `versionColumn`: insert at version 0 and never upsert, each write bumps the
 * version under its precondition, and two transactions racing from one read
 * end in one write and one `StaleVersion`.
 *
 * @module packages/pg/tests/integration/versioned-row
 */

import { sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import { makeVersionedRow, versionColumn } from "../../src/VersionedRow.ts";
import { integrationDatabaseLayer } from "./database-url.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction, transact } = database;
const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction, attemptInSavepoint } = makeTestTransaction(database);

const account = pgTable("versioned_row_spec", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").unique(),
  ...versionColumn(),
});
const accounts = makeVersionedRow({ table: account, CurrentTransaction, type: "account" });

const A = "00000000-0000-4000-8000-0000000000c1";
const B = "00000000-0000-4000-8000-0000000000c2";

const exec = (statement: ReturnType<typeof sql>) =>
  runtime.runPromise(
    transact(
      Effect.gen(function* () {
        const tx = yield* CurrentTransaction;
        yield* tx.execute(statement);
      }),
    ),
  );

beforeAll(() =>
  exec(sql`
    CREATE TABLE IF NOT EXISTS versioned_row_spec (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      email text CONSTRAINT versioned_row_spec_email_unique UNIQUE,
      version bigint NOT NULL DEFAULT 0
    )`),
);

afterAll(async () => {
  await exec(sql`DROP TABLE IF EXISTS versioned_row_spec`);
  await runtime.dispose();
});

const run = <A, E>(effect: Effect.Effect<A, E, "Database" | "Database/CurrentTransaction">) =>
  runInTestTransaction(runtime, effect);

/** The tag of an effect's typed failure, if it failed with one. */
const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Option.map(Exit.findErrorOption(exit), (error) => error._tag),
  );

describe("makeVersionedRow", () => {
  it("inserts at version 0, bumps on each write, and loads row and version together", async () => {
    await run(
      Effect.gen(function* () {
        expect(yield* accounts.insert(A, { name: "Ada" })).toEqual({ id: A, version: 0n });
        expect(
          yield* accounts.update({ id: A, patch: { name: "Ada L." }, expectedVersion: 0n }),
        ).toEqual({ id: A, version: 1n });
        expect(yield* accounts.update({ id: A, patch: {} })).toEqual({ id: A, version: 2n });
        expect(yield* accounts.load(A)).toEqual(
          Option.some({ id: A, name: "Ada L.", email: null, version: 2n }),
        );
        expect(yield* accounts.load(B)).toEqual(Option.none());
      }),
    );
  });

  it("never upserts, and reports another unique key as a UniqueViolation", async () => {
    await run(
      Effect.gen(function* () {
        yield* accounts.insert(A, { name: "Ada", email: "ada@example.com" });
        // A refused insert aborts the transaction, so each runs in a savepoint.
        const taken = yield* attemptInSavepoint(accounts.insert(A, { name: "Other" }));
        expect(Option.map(Exit.findErrorOption(taken), (e) => e._tag)).toEqual(
          Option.some("NodeAlreadyExists"),
        );
      }),
    );
    await run(
      Effect.gen(function* () {
        yield* accounts.insert(A, { name: "Ada", email: "ada@example.com" });
        const duplicate = yield* attemptInSavepoint(
          accounts.insert(B, { name: "Bea", email: "ada@example.com" }),
        );
        expect(Option.map(Exit.findErrorOption(duplicate), (e) => e._tag)).toEqual(
          Option.some("UniqueViolation"),
        );
      }),
    );
  });

  it("writes nothing under a stale precondition, and reports an unknown id", async () => {
    await run(
      Effect.gen(function* () {
        yield* accounts.insert(A, { name: "Ada" });
        yield* accounts.update({ id: A, patch: { name: "Ada L." } });
        const stale = yield* Effect.exit(
          accounts.update({ id: A, patch: { name: "Lost" }, expectedVersion: 0n }),
        );
        expect(Exit.findErrorOption(stale)).toEqual(
          Option.some(expect.objectContaining({ _tag: "StaleVersion", expected: 0n, current: 1n })),
        );
        expect(yield* tagOf(accounts.delete(A, { expectedVersion: 0n }))).toEqual(
          Option.some("StaleVersion"),
        );
        expect(Option.map(yield* accounts.load(A), (row) => row.name)).toEqual(
          Option.some("Ada L."),
        );
        expect(yield* tagOf(accounts.update({ id: B, patch: {} }))).toEqual(
          Option.some("NodeNotFound"),
        );
        expect(yield* tagOf(accounts.update({ id: B, patch: {}, expectedVersion: 0n }))).toEqual(
          Option.some("NodeNotFound"),
        );
        expect(yield* accounts.delete(A, { expectedVersion: 1n })).toEqual({ id: A, version: 1n });
        expect(yield* accounts.load(A)).toEqual(Option.none());
        expect(yield* tagOf(accounts.delete(A))).toEqual(Option.some("NodeNotFound"));
      }),
    );
  });

  describe("two transactions writing from the same read", () => {
    const first = ManagedRuntime.make(integrationDatabaseLayer(database));
    const second = ManagedRuntime.make(integrationDatabaseLayer(database));

    afterAll(async () => {
      await exec(sql`DELETE FROM versioned_row_spec WHERE id = ${A}`);
      await first.dispose();
      await second.dispose();
    });

    it("let the first write and fail the second StaleVersion", async () => {
      await first.runPromise(transact(accounts.insert(A, { name: "Ada" })));
      const { promise: locked, resolve: haveLock } = Promise.withResolvers<void>();
      const { promise: release, resolve: finish } = Promise.withResolvers<void>();
      // The first holds the row lock until released; the second blocks on it,
      // then re-checks the version the first moved.
      const held = first.runPromise(
        transact(
          Effect.andThen(
            accounts.update({ id: A, patch: { name: "First" }, expectedVersion: 0n }),
            Effect.andThen(
              Effect.sync(() => haveLock()),
              Effect.tryPromise({ try: () => release, catch: () => "release rejected" as const }),
            ),
          ),
        ),
      );
      await locked;
      const racing = second.runPromise(
        transact(tagOf(accounts.update({ id: A, patch: { name: "Second" }, expectedVersion: 0n }))),
      );
      finish();
      await held;
      expect(await racing).toEqual(Option.some("StaleVersion"));
      const loaded = await second.runPromise(transact(accounts.load(A)));
      expect(Option.map(loaded, (row) => [row.name, row.version])).toEqual(
        Option.some(["First", 1n]),
      );
    });
  });
});
