/**
 * Unit coverage for `@thomasfosterau/effect-drizzle-ext-pg/testing`.
 *
 * Two halves, neither needing a database:
 *
 * - **`isRetryableConnectFailure`** — ported from the consuming
 *   applications' `connect-retry.test.ts`. The point of the predicate, and of
 *   this test, is website #1055: the acquisition-timeout / `ECONNRESET` flake
 *   surfaces as a `SqlError` whose reason `@effect/sql-pg` classifies as a
 *   **non-retryable** `UnknownError` (the cause carries no `08xxx` SQLSTATE),
 *   so a guard trusting `isRetryable` alone never retried it. The predicate
 *   must catch it via the connect/acquire seam `operation` label while still
 *   refusing to retry a genuine per-test query failure.
 *
 * - **the runner's control flow** — `runInTestTransaction` against a fake
 *   handle that records every boundary it opens and how it closed. That is
 *   what pins the always-rollback, the sentinel walk (`causeContainsRollback`
 *   — the sentinel must never reach the caller, and a NON-sentinel outer
 *   failure must be reported), the legible-failure projection and both retry
 *   guards without a server.
 *
 * The live-database half is `tests/integration/testing.test.ts`.
 *
 * @module packages/pg/tests/testing
 */

import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import {
  ConnectionError,
  ConstraintError,
  SqlError,
  UniqueViolation,
  UnknownError,
} from "effect/unstable/sql/SqlError";
import { makeDatabaseServices } from "@thomasfosterau/effect-drizzle-ext/database";
import { describe, expect, it } from "vite-plus/test";
import type { PgDatabase } from "../src/index.ts";
import {
  isRetryableConnectFailure,
  makeTestTransaction,
  testDatabaseLayer,
} from "../src/testing.ts";

// ── isRetryableConnectFailure (ported) ─────────────────────────────────

/** The pool-acquisition timeout node-pg raises (a plain Error, no `.code`). */
const acquisitionTimeout = () =>
  new SqlError({
    reason: new UnknownError({
      cause: new Error("timeout exceeded when trying to connect"),
      message: "Failed to acquire connection for transaction",
      operation: "acquireConnection",
    }),
  });

/** A socket `ECONNRESET` surfacing at the acquire seam (Node `code`, not a SQLSTATE). */
const econnresetOnAcquire = () => {
  const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  return new SqlError({
    reason: new UnknownError({
      cause,
      message: "Failed to acquire connection for transaction",
      operation: "acquireConnection",
    }),
  });
};

describe("isRetryableConnectFailure", () => {
  it("retries the website #1055 pool-acquisition timeout (misclassified UnknownError)", () => {
    const error = acquisitionTimeout();
    // Guard against the trap the bug lived in: the reason is genuinely not
    // flagged retryable, yet the predicate must still retry it.
    expect(error.isRetryable).toBe(false);
    expect(isRetryableConnectFailure(error)).toBe(true);
  });

  it("retries an ECONNRESET burst raised at the acquire seam", () => {
    expect(isRetryableConnectFailure(econnresetOnAcquire())).toBe(true);
  });

  it("retries a driver-flagged retryable ConnectionError (connect seam)", () => {
    const error = new SqlError({
      reason: new ConnectionError({
        cause: new Error("Connection timed out"),
        message: "PgClient: Connection timed out",
        operation: "connect",
      }),
    });
    expect(error.isRetryable).toBe(true);
    expect(isRetryableConnectFailure(error)).toBe(true);
  });

  it("does NOT retry a UniqueViolation from a test's own query", () => {
    const error = new SqlError({
      reason: new UniqueViolation({
        cause: new Error("duplicate key"),
        message: "insert failed",
        operation: "execute",
        constraint: "widgets_slug_key",
      }),
    });
    expect(isRetryableConnectFailure(error)).toBe(false);
  });

  it("does NOT retry a non-retryable UnknownError raised during statement execution", () => {
    // Same reason tag as the #1055 flake, but stamped `execute` — a genuine
    // query fault, not a connect-seam transient. Must not be retried.
    const error = new SqlError({
      reason: new UnknownError({
        cause: new Error("something went wrong mid-query"),
        message: "Failed to execute statement",
        operation: "execute",
      }),
    });
    expect(isRetryableConnectFailure(error)).toBe(false);
  });

  it("does NOT retry a non-retryable ConstraintError", () => {
    const error = new SqlError({
      reason: new ConstraintError({
        cause: new Error("check violation"),
        message: "insert failed",
        operation: "execute",
      }),
    });
    expect(isRetryableConnectFailure(error)).toBe(false);
  });

  it("ignores non-SqlError values (plain errors, the rollback sentinel, nullish)", () => {
    expect(isRetryableConnectFailure(new Error("boom"))).toBe(false);
    expect(isRetryableConnectFailure({ _tag: "__effect_test_rollback__" })).toBe(false);
    expect(isRetryableConnectFailure(undefined)).toBe(false);
    // oxlint-disable-next-line effect/prefer-option-over-null -- the predicate's contract is "any unknown value"; `null` is one of the values it must tolerate
    expect(isRetryableConnectFailure(null)).toBe(false);
  });
});

// ── The runner's control flow, against a fake handle ───────────────────

/**
 * A stand-in for the driver's database/transaction handle: the five read
 * members the core factory's `ReadSurface` bound asks for, plus a
 * `transaction` that records the boundary it opens and how it closed.
 *
 * `transaction` is the only member the runner exercises, so the read members
 * are inert.
 */
interface FakeHandle {
  readonly select: () => void;
  readonly selectDistinct: () => void;
  readonly selectDistinctOn: () => void;
  readonly with: () => void;
  readonly $count: () => void;
  readonly transaction: <A, E, R>(
    f: (tx: FakeHandle) => Effect.Effect<A, E, R>,
    config?: PgTransactionConfig,
  ) => Effect.Effect<A, E | SqlError, R>;
}

const services = makeDatabaseServices<FakeHandle, FakeHandle>()({ key: "Fake" });

interface Fake {
  /** `open:<depth>` / `commit:<depth>` / `rollback:<depth>` / `open-failed:<attempt>`. */
  readonly events: ReadonlyArray<string>;
  /** How many times the OUTER boundary was attempted (the retry counter). */
  readonly attempts: () => number;
  readonly database: PgDatabase<AnyRelations, "Fake">;
  readonly runtime: ManagedRuntime.ManagedRuntime<"Fake", never>;
}

const noop = (): void => {};

/**
 * Build a fake database.
 *
 * `failOpen` fails the OUTER boundary before the body runs (the connect-seam
 * shape); `failAfterBody` fails it AFTER the body ran and its Exit was
 * captured (the "connection dropped on the rollback raise" shape the second
 * retry guard exists for).
 */
/* oxlint-disable effect/prefer-option-over-null -- the fake mirrors the driver's own optional-member shape (`?: T | undefined`), which is what the code under test reads; wrapping these in `Option` would test a different contract. */
const makeFake = (options: {
  readonly failOpen?: ((attempt: number) => SqlError | undefined) | undefined;
  readonly failAfterBody?: SqlError | undefined;
}): Fake => {
  /* oxlint-enable effect/prefer-option-over-null */
  const events: Array<string> = [];
  let attempts = 0;
  // Nesting depth of the ONE pinned connection, not of a handle: the runner
  // pins `maxConnections: 1` precisely so a `transact` that opens on the
  // CLIENT still lands on the connection the harness transaction holds, as a
  // SAVEPOINT. Modelling depth per handle would make the fake nest where the
  // real driver does not, and vice versa.
  let openBoundaries = 0;

  const makeHandle = (): FakeHandle => ({
    select: noop,
    selectDistinct: noop,
    selectDistinctOn: noop,
    with: noop,
    $count: noop,
    transaction: <A, E, R>(
      f: (tx: FakeHandle) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> =>
      Effect.suspend(() => {
        if (openBoundaries === 0) {
          attempts += 1;
          const failure = options.failOpen?.(attempts);
          if (failure !== undefined) {
            events.push(`open-failed:${attempts}`);
            return Effect.fail(failure);
          }
        }
        openBoundaries += 1;
        const level = openBoundaries;
        events.push(`open:${level}`);
        // A fresh handle per boundary, as the driver hands one to each
        // callback — identity is what the "inner is not the outer" assertions
        // turn on.
        return Effect.flatMap(
          Effect.exit(f(makeHandle())),
          (exit): Effect.Effect<A, E | SqlError> => {
            openBoundaries -= 1;
            events.push(Exit.isSuccess(exit) ? `commit:${level}` : `rollback:${level}`);
            if (level === 1 && options.failAfterBody !== undefined) {
              return Effect.fail(options.failAfterBody);
            }
            return exit;
          },
        );
      }),
  });

  const handle = makeHandle();
  return {
    events,
    attempts: () => attempts,
    // The runner only reads `Database`, `CurrentTransaction` and `transact`;
    // `make` / `layer` exist so the value satisfies the published interface.
    database: {
      ...services,
      make: Effect.succeed(handle),
      layer: Layer.succeed(services.Database, handle),
    } as unknown as PgDatabase<AnyRelations, "Fake">,
    runtime: ManagedRuntime.make(Layer.succeed(services.Database, handle)),
  };
};

const connectSeamFailure = (): SqlError =>
  new SqlError({
    reason: new UnknownError({
      cause: new Error("timeout exceeded when trying to connect"),
      message: "Failed to acquire connection for transaction",
      operation: "acquireConnection",
    }),
  });

const queryFailure = (): SqlError =>
  new SqlError({
    reason: new ConstraintError({
      cause: new Error("check violation"),
      message: "insert failed",
      operation: "execute",
    }),
  });

describe("runInTestTransaction", () => {
  it("opens an outer boundary, nests the spec's own, and always rolls the outer back", async () => {
    const fake = makeFake({});
    const { runInTestTransaction } = makeTestTransaction(fake.database);

    const value = await runInTestTransaction(fake.runtime, Effect.succeed("answer"));

    expect(value).toBe("answer");
    // 1 = the harness's always-rollback transaction; 2 = the `transact` the
    // spec's effect is wrapped in, a SAVEPOINT on the same connection.
    expect(fake.events).toEqual(["open:1", "open:2", "commit:2", "rollback:1"]);
  });

  it("provides CurrentTransaction to the spec's effect", async () => {
    const fake = makeFake({});
    const { runInTestTransaction } = makeTestTransaction(fake.database);

    const handle = await runInTestTransaction(
      fake.runtime,
      Effect.map(services.CurrentTransaction, (tx) => typeof tx.transaction),
    );

    expect(handle).toBe("function");
  });

  it("rolls back and rejects with a legible failure when the body fails", async () => {
    const fake = makeFake({});
    const { runInTestTransaction } = makeTestTransaction(fake.database);

    await expect(
      runInTestTransaction(fake.runtime, Effect.fail(new Error("the spec's own failure"))),
    ).rejects.toThrow(/the spec's own failure/);

    expect(fake.events).toEqual(["open:1", "open:2", "rollback:2", "rollback:1"]);
  });

  it("projects a DEFECT to its underlying error, not to an opaque Cause", async () => {
    const fake = makeFake({});
    const { runInTestTransaction } = makeTestTransaction(fake.database);

    // Without `Cause.squash` this serialises as `{ _tag: 'Die', defect: … }`
    // with an empty `.message` and the regex never matches.
    await expect(
      runInTestTransaction(fake.runtime, Effect.die(new Error("a thrown defect"))),
    ).rejects.toThrow(/a thrown defect/);
  });

  it("never leaks the rollback sentinel to the caller", async () => {
    const fake = makeFake({});
    const { runInTestTransaction } = makeTestTransaction(fake.database);

    const value = await runInTestTransaction(fake.runtime, Effect.succeed(1));
    expect(value).toBe(1);
    expect(fake.events).toContain("rollback:1");
  });

  it("retries a connect-seam failure that happened BEFORE the body ran", async () => {
    const fake = makeFake({
      failOpen: (attempt) => (attempt === 1 ? connectSeamFailure() : undefined),
    });
    const { runInTestTransaction } = makeTestTransaction(fake.database);

    const value = await runInTestTransaction(fake.runtime, Effect.succeed("second attempt"));

    expect(value).toBe("second attempt");
    expect(fake.attempts()).toBe(2);
    expect(fake.events).toEqual(["open-failed:1", "open:1", "open:2", "commit:2", "rollback:1"]);
  });

  it("does NOT retry a connect-seam failure once the body has already run", async () => {
    // Guard 2: re-running here would double-execute the spec's side effects.
    const fake = makeFake({ failAfterBody: connectSeamFailure() });
    const { runInTestTransaction } = makeTestTransaction(fake.database);

    await expect(runInTestTransaction(fake.runtime, Effect.succeed(1))).rejects.toThrow(
      /unexpected outer failure/,
    );
    expect(fake.attempts()).toBe(1);
  });

  it("does NOT retry a failure that is not a connect-seam one", async () => {
    // Guard 1: a constraint rejection from the spec's own query is a real
    // failure. Nothing was captured, so the outer-failure branch reports it.
    const fake = makeFake({ failOpen: () => queryFailure() });
    const { runInTestTransaction } = makeTestTransaction(fake.database);

    await expect(runInTestTransaction(fake.runtime, Effect.succeed(1))).rejects.toThrow(
      /outer transaction failed/,
    );
    expect(fake.attempts()).toBe(1);
  });
});

describe("withTestTransaction", () => {
  it("binds the runtime once and otherwise behaves as runInTestTransaction", async () => {
    const fake = makeFake({});
    const { withTestTransaction } = makeTestTransaction(fake.database);
    const run = withTestTransaction(fake.runtime);

    expect(await run(Effect.succeed("bound"))).toBe("bound");
    expect(fake.events).toEqual(["open:1", "open:2", "commit:2", "rollback:1"]);
  });
});

describe("attemptInSavepoint", () => {
  it("nests a boundary on the ambient handle and hands back the Exit", async () => {
    const fake = makeFake({});
    const { runInTestTransaction, attemptInSavepoint } = makeTestTransaction(fake.database);

    const outcome = await runInTestTransaction(
      fake.runtime,
      Effect.gen(function* () {
        const rejected = yield* attemptInSavepoint(Effect.fail(new Error("constraint rejected")));
        // The enclosing transaction is still usable — that is the point.
        const accepted = yield* attemptInSavepoint(Effect.succeed("ok"));
        return { rejected: rejected._tag, accepted: accepted._tag };
      }),
    );

    expect(outcome).toEqual({ rejected: "Failure", accepted: "Success" });
    // Depth 3 twice: a SAVEPOINT inside the spec's own transaction (2),
    // itself inside the harness's (1). The failing one rolled back alone.
    expect(fake.events).toEqual([
      "open:1",
      "open:2",
      "open:3",
      "rollback:3",
      "open:3",
      "commit:3",
      "commit:2",
      "rollback:1",
    ]);
  });
});

describe("testDatabaseLayer", () => {
  it("is a Layer providing the Database key, failing with SqlError", () => {
    const fake = makeFake({});
    // The annotation is the assertion: the pool config is the library's, the
    // URL is the caller's, and the only failure mode is the driver's.
    const layer: Layer.Layer<"Fake", SqlError> = testDatabaseLayer(fake.database, {
      url: Redacted.make("postgresql://postgres@127.0.0.1:1/nothing"),
      connectTimeout: "1 second",
    });
    expect(Layer.isLayer(layer)).toBe(true);
  });
});
