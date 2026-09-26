/**
 * @copyright Thomas Foster
 *
 * The integration-test transaction runner: every spec runs inside a real
 * database transaction that is ALWAYS rolled back, so a suite needs no
 * truncation, no fixture reset and no ordering discipline.
 *
 * The mechanics are the ones the consuming applications carry today, with
 * three things removed because they are the caller's, not the library's:
 * the viewer services a spec layers on top, the proxy-client variants an
 * application's own deployment shape needs, and the resolution of the test
 * database URL (the caller passes it — see {@link testDatabaseLayer}).
 *
 * The shape is:
 *
 * 1. `db.transaction(...)` opens an OUTER transaction whose only job is the
 *    always-rollback, and whose handle is discarded.
 * 2. The spec's effect is wrapped in the application's own `transact`, so the
 *    spec opens its own transaction exactly as a request handler does in
 *    production (website #1883) — a SAVEPOINT on the outer one. Binding
 *    `CurrentTransaction` from the harness instead would work and touch far
 *    fewer lines, but it would make the specs the one place in the system
 *    where a write runs without anything having called `transact` — precisely
 *    the code path they exist to exercise.
 * 3. The inner `Exit` is captured, then a sentinel failure forces the outer
 *    transaction to roll back.
 * 4. The captured `Exit` is projected back to a Promise (success resolves,
 *    failure throws the underlying cause) so ordinary
 *    `await expect(...).rejects` assertions keep working.
 *
 * The library owns no schema, so a spec creates the `TEMPORARY` tables it
 * needs inside that transaction: DDL is transactional in PostgreSQL, so the
 * always-rollback disposes of them with everything else.
 *
 * The database the runner connects to is provisioned by
 * {@link provisionTestDatabase} (defined in `./provisioning.ts`, re-exported
 * here): an explicit URL, else a fresh migrated database on a reachable
 * local server, else a Testcontainers container.
 *
 * @module testing
 */

import type { AnyRelations } from "drizzle-orm/relations";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import { type PgDatabase, pgClientFromUrl } from "./index.ts";

export {
  connectionUrl,
  ContainerStartFailed,
  type DatabaseSource,
  type DatabaseSourceOptions,
  DatabaseUnreachable,
  InvalidDatabasePrefix,
  type MigrationRunner,
  probeServer,
  type ProvisionedDatabase,
  type ProvisionOptions,
  provisionTestDatabase,
  type ResolutionEnvironment,
  resolveDatabaseSource,
  type ServerProbe,
  ServerUnreachable,
  testDatabaseName,
} from "./provisioning.ts";

// ── Connect-seam retry classification ─────────────────────────────────
//
// {@link runInTestTransaction} retries the *open* of a per-test transaction
// when it fails at the connect/acquire seam under fork-pool startup
// contention, but never re-runs test logic. Which `SqlError`s count as a
// retryable connect failure is decided here.
//
// ## Why `isRetryable` alone is not enough (website #1055)
//
// The observed CI flake surfaces as
// `SqlError: Failed to acquire connection for transaction (cause: … timeout
// exceeded when trying to connect)` and, on immediate re-runs, bursts of
// `read ECONNRESET`. Both are raised by `@effect/sql-pg`'s pool acquirer
// (`reserveRaw`) and passed through its `classifyError`, which only maps a
// cause to the **retryable** `ConnectionError` when the cause carries a
// PostgreSQL SQLSTATE in the `08` class. node-pg's pool-acquisition timeout
// is a plain `Error` with **no** `.code`, and a socket `ECONNRESET` carries a
// Node `code` (`"ECONNRESET"`) that is not an `08xxx` SQLSTATE — so both are
// bucketed as a **non-retryable** `UnknownError` (`isRetryable === false`). A
// guard that only trusted `isRetryable` therefore never fired for the exact
// failure it was built to absorb.
//
// These failures still originate at the connect/acquire seam — before the
// transaction body opens — so they are safe to retry when composed (at the
// call site) with the `captured === null` guard that proves no test work has
// run. We identify the seam by the `operation` label `@effect/sql-pg` stamps
// on the reason (`"acquireConnection"` for the pool `reserveRaw` path,
// `"connect"` for client/pool creation), which is present regardless of how
// the underlying cause classified.

/**
 * The `operation` labels `@effect/sql-pg` stamps on a connect/acquire-seam
 * `SqlError` reason. A failure carrying one of these happened while opening a
 * connection, i.e. before any transaction body ran.
 */
const CONNECT_SEAM_OPERATIONS: ReadonlySet<string> = new Set(["acquireConnection", "connect"]);

/**
 * Whether `error` is a `SqlError` that failed at the connect/acquire seam and
 * so is safe to retry (when the caller has also confirmed no test body ran).
 *
 * Returns `true` for:
 *  - any reason the driver already flags `isRetryable` (`ConnectionError` from
 *    an `08xxx` SQLSTATE, `DeadlockError`, `SerializationError`, the timeout
 *    reasons), and
 *  - a reason whose `operation` is a connect/acquire seam label, which catches
 *    the misclassified `UnknownError` the website #1055 flake surfaces as
 *    (pool "timeout exceeded when trying to connect" / `ECONNRESET`, neither
 *    of which carries an `08` SQLSTATE).
 *
 * Returns `false` for a `UniqueViolation` / `ConstraintError` /
 * `SqlSyntaxError` raised by a test's own query (`operation === "execute"`),
 * so genuine test failures are never retried.
 */
export const isRetryableConnectFailure = (error: unknown): boolean => {
  if (!isSqlError(error)) return false;
  if (error.isRetryable) return true;
  const operation = error.reason.operation;
  return operation !== undefined && CONNECT_SEAM_OPERATIONS.has(operation);
};

/**
 * `maxConnections` is pinned to 1 because a fork runs its tests strictly
 * sequentially and the runner holds exactly one transaction-bound connection
 * at a time (the whole test body runs inside a single `db.transaction`, with
 * the spec's own `transact` nesting a SAVEPOINT on that same connection) — so
 * 1 is the real per-fork demand, not a compromise. It is also what forces an
 * operation-opened transaction to nest as a SAVEPOINT on the same connection
 * (and so see the outer transaction's uncommitted writes) rather than
 * silently acquiring a second connection that cannot.
 */
const TEST_POOL_MAX_CONNECTIONS = 1;

/**
 * How long a single connection attempt may take before the driver gives up.
 *
 * Under fork parallelism all forks race to open their connection at once
 * while each imports the module graph, so at startup the connect handshakes
 * contend. A generous per-attempt timeout costs nothing on the happy path (a
 * healthy connect resolves in milliseconds and never approaches this
 * ceiling), so it stays as cheap insurance for slow CI service-container
 * startup.
 */
const TEST_CONNECT_TIMEOUT = Duration.seconds(30);

/** Sentinel cause used to force the outer test transaction to roll back. */
const ROLLBACK_TAG = "__effect_test_rollback__";

interface RollbackSignal {
  readonly _tag: typeof ROLLBACK_TAG;
}

const rollback: RollbackSignal = { _tag: ROLLBACK_TAG };

const isRollback = (u: unknown): u is RollbackSignal =>
  typeof u === "object" && u !== null && "_tag" in u && (u as RollbackSignal)._tag === ROLLBACK_TAG;

/**
 * Whether a captured failure cause carries the rollback sentinel.
 *
 * Effect causes are nested objects; this is a structural walk that finds the
 * rollback tag without depending on `Cause` internals.
 */
const causeContainsRollback = (cause: unknown): boolean => {
  const seen = new Set<unknown>();
  const stack: Array<unknown> = [cause];
  // oxlint-disable-next-line effect/imperative-loops -- an explicit stack walk over an opaque object graph; the ported mechanism, unchanged.
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (isRollback(node)) return true;
    for (const value of Object.values(node as Record<string, unknown>)) {
      stack.push(value);
    }
  }
  return false;
};

// ── Connect-time retry policy ─────────────────────────────────────────
//
// See the connect-seam classification above for the flake this guards
// against and why `isRetryable` alone doesn't catch it (website #1055). The
// attempt count and backoff floor are tunable here. Five retries over an
// exponential, jittered backoff (≈0.25s, 0.5s, 1s, 2s, 4s, with jitter to
// de-correlate the parallel forks) comfortably outlasts a transient
// saturation spike without meaningfully slowing a healthy run (which never
// retries — the schedule only fires for a connect-seam `SqlError` that failed
// before any test body ran; see the `while` guard at the call site).
const CONNECT_RETRY_ATTEMPTS = 5;
const CONNECT_RETRY_BASE_DELAY = Duration.millis(250);

const connectRetrySchedule = Schedule.max([
  Schedule.exponential(CONNECT_RETRY_BASE_DELAY),
  Schedule.recurs(CONNECT_RETRY_ATTEMPTS),
]).pipe(Schedule.jittered);

/**
 * Project a captured `Cause` to something a test can assert on. Throwing the
 * raw `Cause` makes vitest serialise it as `{ _tag: 'Die', defect: [Object] }`
 * with an empty `.message`, so `.rejects.toThrow(/…/)` never matches and a
 * defect's real error is invisible. `Cause.squash` collapses the cause to its
 * underlying value — a typed `Fail`'s error (keeps `_tag` + message) or a
 * `Die`'s thrown defect (a real `Error` with a message + stack) — so the
 * actual failure surfaces in vitest output and `.rejects.toThrow(/…/)`
 * matches.
 */
const legibleFailure = (cause: Cause.Cause<unknown>): unknown => Cause.squash(cause);

/**
 * The always-rollback test transaction runner for one application's
 * {@link PgDatabase}, built by {@link makeTestTransaction}.
 *
 * Only the service KEY matters to these signatures — the handle types are
 * closed over by the factory — so the interface is parameterised by the key
 * string alone.
 */
export interface TestTransaction<Key extends string> {
  /**
   * Runs `effect` inside a transaction that is always rolled back once the
   * test completes, against a caller-supplied runtime.
   *
   * `R` is the runtime's own context. It **must include the `Database`
   * key**, which is what lets the program below yield the client; that
   * relationship is not expressible as a generic constraint once `R` can be a
   * union that also carries unrelated services (a harness's platform binding
   * stubs, a spec's viewer services), so it is documented here rather than
   * enforced by the type checker — the same trade-off the ported wrapper
   * makes.
   *
   * `${Key}/CurrentTransaction` is in the ACCEPTED requirement, not in the
   * runtime's catalogue: nothing provides it as a layer. The runner wraps the
   * effect in `transact`, so the spec stands in for the handler that opens
   * the boundary in production, and the requirement is discharged there.
   */
  readonly runInTestTransaction: <R, A, E>(
    runtime: ManagedRuntime.ManagedRuntime<R, SqlError>,
    effect: Effect.Effect<A, E, R | `${Key}/CurrentTransaction`>,
  ) => Promise<A>;

  /**
   * {@link runInTestTransaction} with the runtime bound once — the form a
   * suite exports as its own `withTestTransaction(effect)` helper.
   */
  readonly withTestTransaction: <R>(
    runtime: ManagedRuntime.ManagedRuntime<R, SqlError>,
  ) => <A, E>(effect: Effect.Effect<A, E, R | `${Key}/CurrentTransaction`>) => Promise<A>;

  /**
   * Run `effect` inside a **SAVEPOINT** and hand back its `Exit`, leaving the
   * enclosing transaction usable whether it succeeded or failed.
   *
   * This is what a spec asserting "the constraint rejects this write" needs.
   * A statement that raises in PostgreSQL aborts the whole transaction, so a
   * bare `Effect.exit(tx.insert(…))` captures the expected failure and then
   * poisons every later statement in the test with `current transaction is
   * aborted, commands ignored until end of transaction block` — which
   * surfaces as the *next* query failing, several assertions away from the
   * cause. Nesting the attempt (`tx.transaction`, a SAVEPOINT on the same
   * pinned connection) confines the abort to the savepoint: the driver rolls
   * back to it and the outer transaction, with every fixture the test has
   * already written, carries on.
   *
   * `effect` keeps using the ambient `CurrentTransaction` handle — the
   * savepoint is a property of the CONNECTION, which `maxConnections: 1`
   * pins, so nothing has to be re-threaded through a nested handle.
   *
   * The `Exit` is returned rather than asserted on, so the caller keeps the
   * choice: `expect(exit._tag).toBe("Failure")` for a rejection, or a look at
   * the cause when the message matters.
   */
  readonly attemptInSavepoint: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Exit.Exit<A, E | SqlError>, never, R | `${Key}/CurrentTransaction`>;
}

/**
 * Builds the always-rollback test transaction runner for one application's
 * database services.
 *
 * The services carry the key strings and the `transact` boundary, so the
 * runner needs nothing else: a suite calls this once next to its
 * {@link makePgDatabase} call and exports the three helpers.
 */
export const makeTestTransaction = <Relations extends AnyRelations, Key extends string>(
  database: PgDatabase<Relations, Key>,
): TestTransaction<Key> => {
  const runInTestTransaction = async <R, A, E>(
    runtime: ManagedRuntime.ManagedRuntime<R, SqlError>,
    effect: Effect.Effect<A, E, R | `${Key}/CurrentTransaction`>,
  ): Promise<A> => {
    // oxlint-disable-next-line effect/prefer-option-over-null -- write-once slot assigned inside the nested `Effect.gen` closure; the `null` sentinel is what the "inner Exit was never captured" check below tests, and TS's control-flow analysis (see the note at the read site) already treats this declaration specially
    let captured: Exit.Exit<A, E> | null = null;

    const program = Effect.gen(function* () {
      const db = yield* database.Database;
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const inner = yield* Effect.exit(database.transact(effect));
          captured = inner as Exit.Exit<A, E>;
          return yield* Effect.fail(rollback);
        }),
      );
    }).pipe(
      // Retry ONLY a connect-time transient failure — never test logic.
      //
      // Two guards keep this honest:
      //  1. `isRetryableConnectFailure(e)` — fires for a `SqlError` that
      //     failed at the connect/acquire seam (the retryable
      //     `ConnectionError`, plus the misclassified `UnknownError` the
      //     website #1055 acquisition-timeout / `ECONNRESET` flake surfaces
      //     as) but NOT for a `UniqueViolation` / `ConstraintError` /
      //     `SqlSyntaxError` raised by a test's own query. The rollback
      //     sentinel that the body always forces is a plain object, not a
      //     `SqlError`, so a *successful* test and a *genuinely failing* test
      //     (whose Exit is captured before the rollback) both fail the
      //     program with `rollback` and never retry.
      //  2. `captured === null` — the inner test body never ran. A
      //     connect-seam `SqlError` can in principle surface *after* the body
      //     has executed and been captured (e.g. the connection drops on the
      //     rollback raise); re-running then would double-execute the test's
      //     side effects, so we refuse to retry once any test work has
      //     happened. The connect flake by construction fails before the
      //     transaction body opens, so `captured` is still null then —
      //     exactly the case we retry.
      Effect.retry({
        schedule: connectRetrySchedule,
        while: (e) => captured === null && isRetryableConnectFailure(e),
      }),
    );

    const outer = await runtime.runPromiseExit(
      program as unknown as Effect.Effect<unknown, unknown, R>,
    );

    // Snapshot to a local const: `captured` is only ever reassigned inside the
    // nested `Effect.gen` closure above, so TS's control-flow analysis doesn't
    // track that write here — it narrows `captured` as if still `null` (its
    // only textually-direct assignment), collapsing every read below to
    // `never`. The annotation restates the variable's real declared type,
    // which the runtime assignment inside the closure does in fact produce.
    // oxlint-disable-next-line effect/prefer-option-over-null -- restates `captured`'s declared type verbatim; see the comment above
    const innerExit = captured as Exit.Exit<A, E> | null;
    if (!innerExit) {
      if (Exit.isFailure(outer)) {
        throw new Error(`runInTestTransaction: outer transaction failed: ${String(outer.cause)}`);
      }
      throw new Error("runInTestTransaction: inner Exit was never captured");
    }

    // The outer Exit should be the rollback failure we forced. Anything
    // else is a transaction-level failure we didn't expect (e.g. the
    // connection dropped between the inner result and the rollback raise).
    if (Exit.isFailure(outer) && !causeContainsRollback(outer.cause)) {
      throw new Error(`runInTestTransaction: unexpected outer failure: ${String(outer.cause)}`);
    }

    if (Exit.isSuccess(innerExit)) return innerExit.value;
    throw legibleFailure(innerExit.cause);
  };

  return {
    runInTestTransaction,
    withTestTransaction:
      <R>(runtime: ManagedRuntime.ManagedRuntime<R, SqlError>) =>
      <A, E>(effect: Effect.Effect<A, E, R | `${Key}/CurrentTransaction`>): Promise<A> =>
        runInTestTransaction(runtime, effect),
    attemptInSavepoint: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<Exit.Exit<A, E | SqlError>, never, R | `${Key}/CurrentTransaction`> =>
      Effect.gen(function* () {
        const tx = yield* database.CurrentTransaction;
        return yield* Effect.exit(tx.transaction(() => effect));
      }),
  };
};

/**
 * The `Database` layer an integration suite runs against: the application's
 * own {@link PgDatabase.layer} over a `PgClient` built from `url`, with the
 * pool pinned to one connection (see {@link TEST_POOL_MAX_CONNECTIONS}).
 *
 * Built once per process and reused by every spec in it. `url` is the
 * caller's: this library does not read `DATABASE_URL_TEST` or decide how a
 * test database is provisioned.
 *
 * Unlike production, this uses the pinging {@link pgClientFromUrl} on
 * purpose — a suite that cannot reach its database should fail at layer build
 * with one legible `SqlError`, not once per spec on the first query.
 */
/* oxlint-disable effect/prefer-option-over-null -- driver-facing config: `connectTimeout` is forwarded verbatim to `pgClientFromUrl` and from there to `@effect/sql-pg`'s `PgPoolConfig`, which reads `undefined` as "not supplied". See `pgClientFromUrl`'s block in ./index.ts. */
export const testDatabaseLayer = <Relations extends AnyRelations, Key extends string>(
  database: PgDatabase<Relations, Key>,
  options: {
    readonly url: Redacted.Redacted<string>;
    readonly connectTimeout?: Duration.Input | undefined;
  },
): Layer.Layer<Key, SqlError> =>
  database.layer.pipe(
    Layer.provide(
      pgClientFromUrl({
        url: options.url,
        maxConnections: TEST_POOL_MAX_CONNECTIONS,
        connectTimeout: options.connectTimeout ?? TEST_CONNECT_TIMEOUT,
      }),
    ),
  );
/* oxlint-enable effect/prefer-option-over-null */
