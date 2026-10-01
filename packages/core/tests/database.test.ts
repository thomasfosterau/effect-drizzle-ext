/**
 * Unit tests for `src/database.ts` — the service factory, the read-path handle
 * resolver and the write-path transaction boundary (website #1883).
 *
 * `readHandle` is the deliberate asymmetry in the boundary design: `transact`
 * is always-open and never joins an ambient transaction, while a read prefers
 * the ambient transaction when one is open and falls back to the `Database`
 * client when none is. Both halves matter, and neither is observable through
 * the type checker — the requirement channel says `Database` either way,
 * because `Effect.serviceOption` does not surface `CurrentTransaction` in `R`.
 * A regression that always took the fallback would typecheck, and would pass
 * an integration suite whose harness pins the pool to one connection (the
 * pooled read lands on the same connection anyway), and would only misbehave
 * in production against a real pool. Hence unit tests on identity rather than
 * on rows.
 *
 * Driven against sentinel objects standing in for the two handles — no
 * database, and no dependence on either handle's query surface beyond the
 * members `ReadSurface` names.
 *
 * @module tests/database
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import {
  makeDatabaseServices,
  type ReadSurface,
  type TransactionalDatabase,
} from "../src/database.ts";

/**
 * A sentinel transaction handle: every read member reports the handle's label,
 * so an identity assertion can say WHICH handle a resolver returned.
 */
interface StubTransaction extends ReadSurface, TransactionalDatabase<StubTransaction> {
  readonly label: string;
  readonly select: () => string;
  readonly selectDistinct: () => string;
  readonly selectDistinctOn: () => string;
  readonly with: () => string;
  readonly $count: () => number;
}

/**
 * A sentinel client. Deliberately a WIDER type than the transaction (it can
 * write), which is what makes the factory's two type parameters do real work
 * here rather than collapsing into one.
 */
interface StubDatabase extends StubTransaction {
  readonly insert: () => string;
}

/** One `transaction(…)` call: the handle it was made on, and the handle it opened. */
interface Opened {
  readonly on: string;
  readonly handle: StubTransaction;
}

/** Every boundary opened by the stubs during the test in flight, in order. */
const opened: Opened[] = [];

const readMembers = (label: string) => ({
  label,
  select: () => label,
  selectDistinct: () => label,
  selectDistinctOn: () => label,
  with: () => label,
  $count: () => label.length,
});

/**
 * The stub `transaction`: records the handle it was called on and hands the
 * body a FRESH child handle, the way a driver hands the callback the
 * transaction (or savepoint) it has just opened. Which handle a nested
 * `transact` records itself against is the whole point of the nesting test.
 */
const transactionOn =
  (label: string) =>
  <A, E, R>(
    f: (tx: StubTransaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError, R> => {
    const child = stubTransaction(`${label}>tx${opened.length + 1}`);
    opened.push({ on: label, handle: child });
    return f(child);
  };

const stubTransaction = (label: string): StubTransaction => ({
  ...readMembers(label),
  transaction: transactionOn(label),
});

const stubDatabase = (label: string): StubDatabase => ({
  ...readMembers(label),
  insert: () => label,
  transaction: transactionOn(label),
});

const DB_HANDLE = stubDatabase("database");
const TX_HANDLE = stubTransaction("transaction");

/** The services under test, keyed the way a consuming application keys them. */
const services = makeDatabaseServices<StubDatabase, StubTransaction>()({ key: "Primary" });
const { CurrentTransaction, Database, readHandle, transact } = services;

/** A second, independently keyed set — the "two databases in one process" case. */
const replica = makeDatabaseServices<StubDatabase, StubTransaction>()({ key: "Replica" });

// The aliases an application writes over the factory's output. That these are
// the key literals rather than `string` is what makes them worth having.
type DatabaseId = typeof Database.Identifier;
type CurrentTransactionId = typeof CurrentTransaction.Identifier;

/** Binds `Database`; nothing provides `CurrentTransaction`, so none is open. */
const provideDatabase = <A, E>(effect: Effect.Effect<A, E, DatabaseId>): Effect.Effect<A, E> =>
  Effect.provideService(effect, Database, DB_HANDLE);

/** Binds `Database` and an already-open `CurrentTransaction`. */
const provideOpenTransaction = <A, E>(
  effect: Effect.Effect<A, E, DatabaseId | CurrentTransactionId>,
  transaction: StubTransaction,
): Effect.Effect<A, E> =>
  provideDatabase(Effect.provideService(effect, CurrentTransaction, transaction));

beforeEach(() => {
  opened.length = 0;
});

describe("makeDatabaseServices", () => {
  it("derives both key strings from the key it is given", () => {
    expect(Database.key).toBe("Primary");
    expect(CurrentTransaction.key).toBe("Primary/CurrentTransaction");
  });

  it("gives each factory call its own keys", () => {
    expect(replica.Database.key).toBe("Replica");
    expect(replica.CurrentTransaction.key).toBe("Replica/CurrentTransaction");
  });

  it("types each identifier as the key literal, so an application can alias it", () => {
    // The point of the `const Key` parameter: `Identifier` is `"Primary"`, not
    // `string`. An application writes
    // `type Database = typeof services.Database.Identifier` and gets a
    // requirement it can name in its own signatures. If this ever widens to
    // `string`, every such alias silently becomes "any database".
    const identifier: DatabaseId = "Primary";
    const replicaIdentifier: typeof replica.Database.Identifier = "Replica";
    expect(identifier).toBe(Database.key);
    expect(replicaIdentifier).toBe(replica.Database.key);
  });

  it("does not let one factory's services satisfy another's", () => {
    // Same shapes, different key strings: a context carrying the `Primary`
    // client holds nothing under the `Replica` key, and nothing under its own
    // transaction key either. The runtime slot is the thing that would
    // silently alias if two factories were called with one key.
    const context = Context.make(Database, DB_HANDLE);
    expect(Option.isSome(Context.getOption(context, Database))).toBe(true);
    expect(Option.isNone(Context.getOption(context, replica.Database))).toBe(true);
    expect(Option.isNone(Context.getOption(context, CurrentTransaction))).toBe(true);
  });
});

describe("readHandle (#1883)", () => {
  it("returns the ambient transaction when one is open", async () => {
    expect(await Effect.runPromise(provideOpenTransaction(readHandle, TX_HANDLE))).toBe(TX_HANDLE);
  });

  it("falls back to the Database client when no transaction is open", async () => {
    expect(await Effect.runPromise(provideDatabase(readHandle))).toBe(DB_HANDLE);
  });

  it("does not require CurrentTransaction to run — the fallback is total", async () => {
    // The point of `Effect.serviceOption`: an unprovided `CurrentTransaction`
    // is a `None`, not a defect. If this ever throws, the resolver has started
    // yielding the key directly and every read-path caller has silently gained
    // a "must be inside a transaction" requirement.
    await expect(Effect.runPromise(provideDatabase(readHandle))).resolves.toBe(DB_HANDLE);
  });

  it("narrows to the read surface without losing the handle's own signatures", async () => {
    const handle = await Effect.runPromise(provideOpenTransaction(readHandle, TX_HANDLE));
    expect(handle.select()).toBe("transaction");
    expect(handle.$count()).toBe("transaction".length);
  });

  it("opens nothing — a read has no boundary to lose", async () => {
    await Effect.runPromise(provideOpenTransaction(readHandle, TX_HANDLE));
    await Effect.runPromise(provideDatabase(readHandle));
    expect(opened).toHaveLength(0);
  });
});

describe("transact (#1883)", () => {
  it("opens on the Database client and provides the new handle as CurrentTransaction", async () => {
    const seen = await Effect.runPromise(provideDatabase(transact(CurrentTransaction)));

    expect(opened).toHaveLength(1);
    expect(opened[0]?.on).toBe("database");
    expect(seen).toBe(opened[0]?.handle);
  });

  it("opens a NESTED boundary on the ambient handle rather than joining it", async () => {
    // A join-if-present helper would typecheck identically and record ONE
    // boundary; the second entry here is the SAVEPOINT that preserves rollback
    // granularity. Adjudicated on website #1883 (owner, 2026-09-07,
    // condition 3). That the nested boundary is opened on the ambient handle
    // rather than on the client is what makes it nest on a driver that does
    // not pin the open connection to the fiber.
    const [outer, inner] = await Effect.runPromise(
      provideDatabase(
        transact(
          Effect.gen(function* () {
            const outerHandle = yield* CurrentTransaction;
            const innerHandle = yield* transact(CurrentTransaction);
            return [outerHandle, innerHandle] as const;
          }),
        ),
      ),
    );

    expect(opened).toHaveLength(2);
    expect(opened[0]?.on).toBe("database");
    expect(opened[1]?.on).toBe(outer.label);
    expect(inner).not.toBe(outer);
    expect(inner).toBe(opened[1]?.handle);
  });

  it("restores the outer handle once the inner boundary closes", async () => {
    const restored = await Effect.runPromise(
      provideDatabase(
        transact(
          Effect.gen(function* () {
            const outerHandle = yield* CurrentTransaction;
            yield* transact(Effect.void);
            return (yield* CurrentTransaction) === outerHandle;
          }),
        ),
      ),
    );

    expect(restored).toBe(true);
  });

  it("opens on the ambient handle when one is already open outside transact", async () => {
    // The ambient transaction need not have come from `transact` — a driver's
    // own `db.transaction` callback, or a test harness that opens one and
    // provides it, is the same case.
    const seen = await Effect.runPromise(
      provideOpenTransaction(transact(CurrentTransaction), TX_HANDLE),
    );

    expect(opened).toHaveLength(1);
    expect(opened[0]?.on).toBe("transaction");
    expect(seen).toBe(opened[0]?.handle);
    expect(seen).not.toBe(TX_HANDLE);
  });

  it("leaves the body's failure in the error channel", async () => {
    const exit = await Effect.runPromiseExit(provideDatabase(transact(Effect.fail("rolled back"))));

    expect(exit._tag).toBe("Failure");
    expect(opened).toHaveLength(1);
  });
});
