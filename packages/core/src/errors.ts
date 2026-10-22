/**
 * @copyright Thomas Foster
 *
 * Typed Postgres error classification.
 *
 * Effect already classifies SQLSTATE: `@effect/sql-pg` maps a driver error
 * into `SqlError.reason` (`UniqueViolation{constraint}`, `ConstraintError`,
 * `DeadlockError`, `SerializationError`, `ConnectionError`, …). It keeps the
 * violated constraint for `23505` only — every other `23xxx` becomes a bare
 * `ConstraintError` with no constraint / table / column — and drizzle then
 * wraps the whole thing inside `EffectDrizzleQueryError.cause`, which is an
 * Effect `Cause`, not the driver error. So the facts a caller needs to say
 * *which* constraint failed are still in the graph, just not on the failure
 * it is handed.
 *
 * This module recovers them: {@link findPgError} walks the error graph for the
 * driver's Postgres error (the node carrying a SQLSTATE `code`; under
 * `@effect/sql-pg` an `Error` carrying the server's ErrorResponse fields) and
 * reads its `code` / `constraint` / `table` / `column` / `detail` / `schema`,
 * and {@link classifyError} turns those facts into one of seven tagged errors
 * a consumer can `catchTag`.
 *
 * Nothing here is thrown: these are runtime query failures and they travel in
 * the Effect error channel. (Construction-time failures are the thrown
 * `DerivationError` in `./derive`.)
 *
 * The module imports neither `drizzle-orm` nor `@effect/sql-pg`, at runtime or
 * as types: it recognises those shapes structurally, so it works the same on a
 * bare `SqlError`, a bare Postgres error and the drizzle-wrapped shape, and
 * a consumer holding any of them classifies it without pulling a driver into
 * the bundle.
 *
 * @module errors
 */

import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

// ── SQLSTATE vocabulary ────────────────────────────────────────────

/** SQLSTATE `23505` — unique (or primary key) constraint violated. */
const UNIQUE_VIOLATION = "23505";

/** SQLSTATE `23503` — foreign key constraint violated. */
const FOREIGN_KEY_VIOLATION = "23503";

/** SQLSTATE `23502` — NOT NULL constraint violated. */
const NOT_NULL_VIOLATION = "23502";

/** SQLSTATE `23514` — CHECK constraint violated. */
const CHECK_VIOLATION = "23514";

/** SQLSTATE `23P01` — EXCLUDE constraint violated. */
const EXCLUSION_VIOLATION = "23P01";

/** SQLSTATE `40001` — serialization failure; the transaction may be retried. */
const SERIALIZATION_FAILURE = "40001";

/** SQLSTATE `40P01` — deadlock detected; the transaction may be retried. */
const DEADLOCK_DETECTED = "40P01";

/**
 * The stable Postgres message fragment for a unique violation, kept as a
 * belt-and-suspenders fallback for {@link isUniqueViolation} (see its note).
 */
const PG_UNIQUE_VIOLATION_MESSAGE = "duplicate key value violates unique constraint";

/**
 * The shape of a Postgres SQLSTATE: five uppercase alphanumerics (`23505`,
 * `23P01`, `40001`). This is what tells the driver error apart from a wrapper
 * that carries a `code` of its own — an `SqlError` or a Node `ErrnoException`
 * both have a `code`, neither looks like this — so the walk descends past
 * them instead of stopping at the first `code` it meets.
 */
const PG_SQLSTATE = /^[0-9A-Z]{5}$/;

/** How deep into the error graph to search for the driver error. */
const MAX_ERROR_DEPTH = 8;

/**
 * An error node as the walk sees it: an arbitrary object read as a bag of
 * properties. `Record` here is `effect/Record`'s namespace, so the built-in
 * `Record<K, V>` utility type is shadowed; this alias is what the walk's
 * signatures use in its place.
 */
type ErrorNode = Record.ReadonlyRecord<string, unknown>;

// ── The facts a Postgres error carries ─────────────────────────────

/**
 * The fields of a Postgres error response this library reads, as recovered from
 * wherever the driver's error sits in an error graph. `code` is the SQLSTATE and
 * is always present (finding it is what identifies the node); every other
 * fact is `Option` because Postgres populates it per error class — a `23502`
 * carries `column` and `table` but no `constraint`, a `23503` carries
 * `constraint`, `table` and `detail`.
 */
export interface PgErrorFacts {
  /** The five-character SQLSTATE, e.g. `23505`. */
  readonly code: string;
  /** The driver's message, or `""` when the node carries none. */
  readonly message: string;
  /** The violated constraint's name, for the constraint classes that name one. */
  readonly constraint: Option.Option<string>;
  /** The table the statement touched. */
  readonly table: Option.Option<string>;
  /** The column at fault, populated for NOT NULL violations. */
  readonly column: Option.Option<string>;
  /** Postgres' `DETAIL` line, which names the conflicting key values. */
  readonly detail: Option.Option<string>;
  /** The schema the table lives in. */
  readonly schema: Option.Option<string>;
}

/** Reads a string-valued property off an error node as an `Option`. */
const readString = (node: ErrorNode, key: string): Option.Option<string> => {
  const value = node[key];
  return Predicate.isString(value) ? Option.some(value) : Option.none();
};

/**
 * The SQLSTATE a node declares, under either `code` (node-postgres) or
 * `sqlState` (the field name other drivers and some wrappers use), and only
 * when it actually looks like a SQLSTATE.
 */
const sqlStateOf = (node: ErrorNode): Option.Option<string> =>
  Option.filter(
    Option.orElse(readString(node, "code"), () => readString(node, "sqlState")),
    (code) => PG_SQLSTATE.test(code),
  );

/** The driver error's facts, when this node *is* the driver error. */
const pgErrorFactsOf = (node: ErrorNode): Option.Option<PgErrorFacts> =>
  Option.map(sqlStateOf(node), (code) => ({
    code,
    message: Option.getOrElse(readString(node, "message"), () => ""),
    constraint: readString(node, "constraint"),
    table: readString(node, "table"),
    column: readString(node, "column"),
    detail: readString(node, "detail"),
    schema: readString(node, "schema"),
  }));

// ── The bounded, cycle-guarded walk ────────────────────────────────

/** True when `error` is a fresh object worth descending into (within depth, not yet visited). */
const isSearchable = (error: unknown, depth: number, seen: Set<unknown>): error is ErrorNode =>
  Predicate.isObjectOrArray(error) && depth < MAX_ERROR_DEPTH && !seen.has(error);

/**
 * The child error nodes reachable from a node: its `.cause` (read explicitly,
 * as it is often a NON-enumerable field on `SqlError` and on drizzle's
 * `EffectDrizzleQueryError`) plus its enumerable values, with arrays flattened
 * (an Effect `Cause`'s `reasons`).
 */
const childErrorNodes = (node: ErrorNode): unknown[] => [
  node["cause"],
  ...Array.flatMap(Record.values(node), (value) => (Array.isArray(value) ? value : [value])),
];

/**
 * Bounded, cycle-guarded depth-first search of an error graph for the first
 * node `match` accepts.
 *
 * A failed write reaches a caller deeply wrapped, and NOT on a simple `.cause`
 * chain: drizzle's `EffectDrizzleQueryError` holds an Effect `Cause` under a
 * (non-enumerable) `.cause`, and the driver's Postgres error carrying the SQLSTATE
 * sits inside that Cause's `reasons`. Hence a search over the whole reachable
 * graph — reading `.cause` explicitly (for the non-enumerable wrappers) and
 * sweeping enumerable values / arrays (for the Cause `reasons`) — rather than
 * a cause chain.
 */
const searchErrorGraph = <A>(
  cause: unknown,
  match: (node: ErrorNode) => Option.Option<A>,
  depth: number,
  seen: Set<unknown>,
): Option.Option<A> => {
  if (!isSearchable(cause, depth, seen)) return Option.none();
  seen.add(cause);
  return Option.orElse(match(cause), () =>
    Array.findFirst(childErrorNodes(cause), (child) =>
      searchErrorGraph(child, match, depth + 1, seen),
    ),
  );
};

/**
 * The driver's Postgres error facts, recovered from anywhere in `error`'s graph:
 * a bare Postgres error, a bare `SqlError` (whose `reason` holds the driver
 * error as its `cause`), or drizzle's `EffectDrizzleQueryError` wrapping an
 * Effect `Cause` that holds the `SqlError`. `Option.none()` when the graph
 * holds no node declaring a SQLSTATE, including for a non-object input.
 *
 * The walk is bounded (depth 8) and cycle-guarded, so a self-referential or
 * pathologically deep graph terminates.
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- public entry over an opaque failure graph (any caught value); narrowing it would break callers
export const findPgError = (error: unknown): Option.Option<PgErrorFacts> =>
  // The cycle guard needs *reference* identity across an arbitrary error graph:
  // `HashSet`'s structural equality would mis-merge distinct-but-equal nodes and
  // would hash (i.e. walk) cyclic values it is meant to stop us walking.
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- reference identity is the point
  searchErrorGraph(error, pgErrorFactsOf, 0, new Set());

// ── The tagged classification ──────────────────────────────────────

/**
 * SQLSTATE `23505`: a unique or primary key constraint was violated.
 * `cause` is the value classification started from, so the wrapping graph
 * (drizzle's query text and params, the `SqlError`) survives the recovery.
 */
export class UniqueViolation extends Schema.TaggedError<UniqueViolation>()("UniqueViolation", {
  constraint: Schema.Option(Schema.String),
  table: Schema.Option(Schema.String),
  detail: Schema.Option(Schema.String),
  cause: Schema.Defect(),
}) {}

/** SQLSTATE `23503`: a foreign key constraint was violated. `cause` as in {@link UniqueViolation}. */
export class ForeignKeyViolation extends Schema.TaggedError<ForeignKeyViolation>()(
  "ForeignKeyViolation",
  {
    constraint: Schema.Option(Schema.String),
    table: Schema.Option(Schema.String),
    detail: Schema.Option(Schema.String),
    cause: Schema.Defect(),
  },
) {}

/** SQLSTATE `23502`: a NOT NULL constraint was violated. `column` names the offending column. */
export class NotNullViolation extends Schema.TaggedError<NotNullViolation>()("NotNullViolation", {
  column: Schema.Option(Schema.String),
  table: Schema.Option(Schema.String),
  cause: Schema.Defect(),
}) {}

/** SQLSTATE `23514`: a CHECK constraint was violated — including the bounds checks `./derive` writes. */
export class CheckViolation extends Schema.TaggedError<CheckViolation>()("CheckViolation", {
  constraint: Schema.Option(Schema.String),
  table: Schema.Option(Schema.String),
  cause: Schema.Defect(),
}) {}

/** SQLSTATE `23P01`: an EXCLUDE constraint was violated. */
export class ExclusionViolation extends Schema.TaggedError<ExclusionViolation>()(
  "ExclusionViolation",
  {
    constraint: Schema.Option(Schema.String),
    table: Schema.Option(Schema.String),
    cause: Schema.Defect(),
  },
) {}

/**
 * SQLSTATE `40001`: the transaction lost a serialization conflict. Retryable:
 * the same transaction re-run from the top may commit.
 */
export class SerializationFailure extends Schema.TaggedError<SerializationFailure>()(
  "SerializationFailure",
  { cause: Schema.Defect() },
) {}

/**
 * SQLSTATE `40P01`: the transaction was chosen as a deadlock victim.
 * Retryable, like {@link SerializationFailure}.
 */
export class DeadlockDetected extends Schema.TaggedError<DeadlockDetected>()("DeadlockDetected", {
  cause: Schema.Defect(),
}) {}

/**
 * The integrity-constraint family (`23xxx`): a failure the *statement* caused,
 * which a caller can map to a domain conflict. Retrying it unchanged fails
 * again.
 */
export type ConstraintViolation =
  | UniqueViolation
  | ForeignKeyViolation
  | NotNullViolation
  | CheckViolation
  | ExclusionViolation;

/**
 * Every failure this module recognises: a {@link ConstraintViolation}, or one
 * of the two retryable transaction failures.
 */
export type ClassifiedError = ConstraintViolation | SerializationFailure | DeadlockDetected;

/** Builds the `23505` classification; shared by `classifyError` and `catchUniqueViolation`. */
const makeUniqueViolation = (facts: PgErrorFacts, cause: unknown): UniqueViolation =>
  new UniqueViolation({
    constraint: facts.constraint,
    table: facts.table,
    detail: facts.detail,
    cause,
  });

/**
 * SQLSTATE → constraint-family constructor. A table rather than a `switch`:
 * the SQLSTATE is the key the whole module dispatches on, and a lookup that
 * misses is exactly the `Option.none()` an unclassified code should produce.
 */
const CONSTRAINT_VIOLATION_BY_CODE: Record.ReadonlyRecord<
  string,
  (facts: PgErrorFacts, cause: unknown) => ConstraintViolation
> = {
  [UNIQUE_VIOLATION]: makeUniqueViolation,
  [FOREIGN_KEY_VIOLATION]: (facts, cause) =>
    new ForeignKeyViolation({
      constraint: facts.constraint,
      table: facts.table,
      detail: facts.detail,
      cause,
    }),
  [NOT_NULL_VIOLATION]: (facts, cause) =>
    new NotNullViolation({ column: facts.column, table: facts.table, cause }),
  [CHECK_VIOLATION]: (facts, cause) =>
    new CheckViolation({ constraint: facts.constraint, table: facts.table, cause }),
  [EXCLUSION_VIOLATION]: (facts, cause) =>
    new ExclusionViolation({ constraint: facts.constraint, table: facts.table, cause }),
};

/** SQLSTATE → retryable-transaction-failure constructor; a table, as above. */
const TRANSACTION_FAILURE_BY_CODE: Record.ReadonlyRecord<
  string,
  (cause: unknown) => SerializationFailure | DeadlockDetected
> = {
  [SERIALIZATION_FAILURE]: (cause) => new SerializationFailure({ cause }),
  [DEADLOCK_DETECTED]: (cause) => new DeadlockDetected({ cause }),
};

/** The constraint-family classification for these facts, if the SQLSTATE is one of the five. */
const makeConstraintViolation = (
  facts: PgErrorFacts,
  cause: unknown,
): Option.Option<ConstraintViolation> =>
  Option.map(Record.get(CONSTRAINT_VIOLATION_BY_CODE, facts.code), (make) => make(facts, cause));

/** The retryable-transaction classification for these facts, if the SQLSTATE is one of the two. */
const makeTransactionFailure = (
  facts: PgErrorFacts,
  cause: unknown,
): Option.Option<SerializationFailure | DeadlockDetected> =>
  Option.map(Record.get(TRANSACTION_FAILURE_BY_CODE, facts.code), (make) => make(cause));

/**
 * Classifies any value into one of the seven tagged errors, by finding the
 * driver's Postgres error in its graph ({@link findPgError}) and dispatching on the
 * SQLSTATE. `Option.none()` when the graph holds no driver error, or holds one
 * whose SQLSTATE is outside the classified families (a syntax error, a
 * connection failure — `SqlError.reason` already covers those well).
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- public entry over an opaque failure graph (any caught value); narrowing it would break callers
export const classifyError = (error: unknown): Option.Option<ClassifiedError> =>
  Option.flatMap(findPgError(error), (facts) =>
    Option.orElse<ClassifiedError, ClassifiedError>(makeConstraintViolation(facts, error), () =>
      makeTransactionFailure(facts, error),
    ),
  );

/** The `23505` classification for `error`, if that is what it is. */
const uniqueViolationOf = (cause: unknown): Option.Option<UniqueViolation> =>
  Option.map(
    Option.filter(findPgError(cause), (facts) => facts.code === UNIQUE_VIOLATION),
    (facts) => makeUniqueViolation(facts, cause),
  );

/** The constraint-family classification for `error`, if that is what it is. */
const constraintViolationOf = (cause: unknown): Option.Option<ConstraintViolation> =>
  Option.flatMap(findPgError(cause), (facts) => makeConstraintViolation(facts, cause));

// ── Predicates ─────────────────────────────────────────────────────

/** True when a node declares `23505` by SQLSTATE, or by the stable Postgres message fragment. */
const uniqueViolationNode = (node: ErrorNode): Option.Option<true> => {
  const code = Option.orElse(readString(node, "code"), () => readString(node, "sqlState"));
  if (Option.contains(code, UNIQUE_VIOLATION)) return Option.some(true);
  return Option.isSome(
    Option.filter(readString(node, "message"), (message) =>
      message.includes(PG_UNIQUE_VIOLATION_MESSAGE),
    ),
  )
    ? Option.some(true)
    : Option.none();
};

/**
 * True when `error` is (or wraps) a unique-constraint violation.
 *
 * Kept as its own predicate, with its own walk, for adoption parity: this is
 * the name and the semantics the consuming applications already call, and the
 * semantics include a fallback the typed classification deliberately does not
 * have — matching the stable Postgres message fragment when no `code` survived the
 * wrapping. It also matches a `23505` declared under a `code` that is not
 * SQLSTATE-shaped, which {@link classifyError} skips.
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- public predicate over an opaque failure graph (any caught value); narrowing it would break callers
export const isUniqueViolation = (error: unknown): boolean =>
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- reference identity is the point
  Option.isSome(searchErrorGraph(error, uniqueViolationNode, 0, new Set()));

/**
 * True when `error` is (or wraps) an integrity-constraint violation — one of
 * the five `23xxx` classes {@link classifyError} recognises.
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- public predicate over an opaque failure graph (any caught value); narrowing it would break callers
export const isConstraintViolation = (error: unknown): boolean =>
  Option.isSome(constraintViolationOf(error));

/**
 * True when `error` is (or wraps) a transaction failure that re-running the
 * whole transaction may clear: a serialization failure (`40001`) or a deadlock
 * (`40P01`). Retrying a {@link ConstraintViolation} is pointless; retrying
 * these is the documented remedy.
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- public predicate over an opaque failure graph (any caught value); narrowing it would break callers
export const isRetryableTransactionFailure = (error: unknown): boolean =>
  Option.isSome(
    Option.filter(
      findPgError(error),
      (facts) => facts.code === SERIALIZATION_FAILURE || facts.code === DEADLOCK_DETECTED,
    ),
  );

// ── Effect combinators ─────────────────────────────────────────────

/**
 * Recovers from a constraint violation in the error channel, leaving every
 * other failure untouched — the failure is re-failed unchanged, with its
 * original type, so a handler for one Postgres conflict does not swallow the
 * rest of the channel.
 *
 * Data-last only: `self.pipe(catchConstraintViolation(handler))`.
 */
export const catchConstraintViolation =
  <A2, E2, R2>(f: (violation: ConstraintViolation) => Effect.Effect<A2, E2, R2>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E | E2, R | R2> =>
    Effect.catch(self, (error: E) =>
      Option.match(constraintViolationOf(error), {
        onNone: (): Effect.Effect<A2, E | E2, R2> => Effect.fail(error),
        onSome: f,
      }),
    );

/**
 * {@link catchConstraintViolation} narrowed to `23505`: recovers only a unique
 * violation, passing everything else — including other constraint violations —
 * through unchanged. This is the duplicate-key conflict a consumer maps to a
 * domain "already exists".
 *
 * Data-last only: `self.pipe(catchUniqueViolation(handler))`.
 */
export const catchUniqueViolation =
  <A2, E2, R2>(f: (violation: UniqueViolation) => Effect.Effect<A2, E2, R2>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E | E2, R | R2> =>
    Effect.catch(self, (error: E) =>
      Option.match(uniqueViolationOf(error), {
        onNone: (): Effect.Effect<A2, E | E2, R2> => Effect.fail(error),
        onSome: f,
      }),
    );
