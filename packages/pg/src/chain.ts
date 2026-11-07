/**
 * @copyright Thomas Foster
 *
 * **The version-chain discipline, Drizzle-concrete** (effect-drizzle-ext#112,
 * decision 5): create, carry-forward update, tombstone, restore, history and
 * the expected-version precondition, written straight over the tables
 * `makeTreeTables` (core `./versioned-chain`) derives from a tree.
 *
 * The behavioural spec is pulpit's `version-chain.ts` and its tests; the
 * rules are the same, and the errors carry pulpit's names and fields so a
 * `pulpit-drizzle-pg` store can map them one to one:
 *
 * - **Append-only** (`VERSION-CHAIN-001/002`). Every write lands at
 *   `N_max + 1` on the root version table and on every level of the leaf's
 *   chain; no version row is ever updated or deleted.
 * - **Create is never an upsert.** A caller-supplied id that exists fails
 *   {@link NodeAlreadyExists}.
 * - **Update carries forward.** A patch is tri-state per field: a value sets,
 *   `null` clears, an absent (or `undefined`) key carries the head's value
 *   forward.
 * - **Delete is a tombstone that carries every column forward**, and is
 *   idempotent: on a tombstoned node it returns the existing tombstone with
 *   `alreadyDeleted: true` and writes nothing.
 * - **A plain update never resurrects** (`VERSION-CHAIN-006`): over a
 *   tombstone it fails {@link NodeNotFound}; only `restore` and
 *   `restoreVersion` write over one.
 * - **No partial restore.** `restoreVersion` reads the whole snapshot (every
 *   level) first and fails {@link VersionNotFound} before writing anything.
 * - **Every chain read is bounded** (`PERF-DB-001`): `history` caps its
 *   `limit` at {@link MAX_HISTORY_LIMIT}.
 * - **An expected version is a precondition on the append.** A moved head
 *   fails {@link StaleVersion} and writes nothing; a writer racing between
 *   the read and the append loses the root's `(id, version)` primary key and
 *   fails {@link VersionConflict}.
 *
 * The chain never opens a transaction: every operation requires the
 * application's `CurrentTransaction` (`transact` is always-open, and the
 * boundary is the caller's). A failure mid-write leaves the transaction for
 * the caller to roll back.
 *
 * @module chain
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { catchUniqueViolation } from "@thomasfosterau/effect-drizzle-ext/errors";
import type {
  VersionAction,
  VersionChainEntry,
} from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  getTableName,
  sql,
  type AnyRelations,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import type { PgTransaction } from "./index.ts";

// ── Errors (pulpit's names and fields) ────────────────────────────────

/** No such node of this leaf, or (for a plain update) a tombstoned one: the wire's 404. */
export class NodeNotFound extends Schema.TaggedError<NodeNotFound>()("NodeNotFound", {
  type: Schema.String,
  id: Schema.String,
}) {}

/** No reconstructable version at `(id, version)`: an unknown version, or a level with no row there. */
export class VersionNotFound extends Schema.TaggedError<VersionNotFound>()("VersionNotFound", {
  type: Schema.String,
  id: Schema.String,
  version: Schema.BigInt,
}) {}

/** A create whose caller-supplied id already belongs to a node — never an upsert: the wire's 409. */
export class NodeAlreadyExists extends Schema.TaggedError<NodeAlreadyExists>()(
  "NodeAlreadyExists",
  { type: Schema.String, id: Schema.String },
) {}

/**
 * The root version table refused an append because `(id, version)` is
 * already taken: a concurrent writer got there first. Never retried, because
 * a retry would base the write on a version the caller never read. The
 * transaction is aborted; the caller rolls it back.
 */
export class VersionConflict extends Schema.TaggedError<VersionConflict>()("VersionConflict", {
  id: Schema.String,
  version: Schema.BigInt,
}) {}

/**
 * An expected-version precondition that no longer holds: the head moved past
 * the version the caller last read. Nothing was written; `current` is the head
 * the write found, so the caller can re-read and re-apply.
 */
export class StaleVersion extends Schema.TaggedError<StaleVersion>()("StaleVersion", {
  type: Schema.String,
  id: Schema.String,
  /** The version the caller expected the head to be. */
  expected: Schema.BigInt,
  /** The head version the write found. */
  current: Schema.BigInt,
}) {}

/**
 * The head version has no reconstructable state: a level of the chain has no
 * row at the head. A defect (raised with `Effect.die`), never a typed failure:
 * the tables broke the chain's own contract.
 */
export class BrokenChain extends Schema.TaggedError<BrokenChain>()("BrokenChain", {
  type: Schema.String,
  id: Schema.String,
  version: Schema.BigInt,
}) {}

/**
 * The hard cap on a history read (`PERF-DB-001`): a chain is tiny in
 * practice; this bounds a pathological one.
 */
export const MAX_HISTORY_LIMIT = 1000;

// ── Types ─────────────────────────────────────────────────────────────

/**
 * The shape of `makeTreeTables`' output the chain reads: the root pair, every
 * level's pair and every level's fact tables.
 */
export interface ChainTables {
  readonly root: { readonly identity: PgTable; readonly version: PgTable };
  readonly levels: Readonly<
    Record<string, { readonly stable: PgTable; readonly version: PgTable }>
  >;
  readonly facts: Readonly<Record<string, Readonly<Record<string, PgTable>>>>;
}

/** The tree facts the chain reads (a `defineTree` result satisfies it). */
export interface ChainTree<S> {
  readonly spec: S;
  readonly leaves: ReadonlyArray<string>;
  readonly levels: ReadonlyArray<{
    readonly name: string;
    readonly ancestors: ReadonlyArray<string>;
  }>;
}

/** Flatten an intersection into one object type, for the hover. */
type Simplify<A> = { [K in keyof A]: A[K] };

/** A table type's select row. */
type RowOf<Tb> = Tb extends { readonly $inferSelect: infer Selected } ? Selected : never;

/** A table type's insert row. */
type InsertOf<Tb> = Tb extends { readonly $inferInsert: infer Inserted } ? Inserted : never;

/** Member `K` of `A`, or `never`. */
type MemberOf<A, K> = K extends keyof A ? A[K] : never;

/** Level `K`'s path from its branch root down to itself, as a tuple of names. */
type PathOf<S, K> = K extends keyof S
  ? S[K] extends { readonly parent: infer P }
    ? P extends keyof S
      ? [...PathOf<S, P>, K]
      : [K]
    : [K]
  : [];

/** The leaf names of declaration `S`. */
type LeafOf<S> = {
  readonly [K in keyof S]: S[K] extends { readonly leaf?: infer L }
    ? [Exclude<L, undefined>] extends [never]
      ? never
      : K
    : never;
}[keyof S] &
  string;

/* oxlint-disable effect/prefer-option-over-null -- Drizzle row types: a nullable column reads and writes `T | null`, a fact's absence at a version is its `NULL`, and the tri-state patch's `undefined` arm is "carry forward" (core's `./update`) */
/** One level's state: its version columns past `(id, version)`, then its facts. */
type LevelState<T extends ChainTables, L> = Omit<
  RowOf<MemberOf<MemberOf<T["levels"], L>, "version">>,
  "id" | "version"
> & {
  readonly [F in keyof MemberOf<T["facts"], L>]: MemberOf<
    RowOf<MemberOf<MemberOf<T["facts"], L>, F>>,
    F
  > | null;
};

/** One level's create input: its version insert row past `(id, version)`, then its facts (optional). */
type LevelCreate<T extends ChainTables, L> = Omit<
  InsertOf<MemberOf<MemberOf<T["levels"], L>, "version">>,
  "id" | "version"
> & {
  readonly [F in keyof MemberOf<T["facts"], L>]?:
    | MemberOf<RowOf<MemberOf<MemberOf<T["facts"], L>, F>>, F>
    | null
    | undefined;
};

/** Every level on a path's state, root-most first. */
type PathState<T extends ChainTables, P> = P extends readonly [infer H, ...infer Rest]
  ? LevelState<T, H> & PathState<T, Rest>
  : Record<never, never>;

/** Every level on a path's create input, root-most first. */
type PathCreate<T extends ChainTables, P> = P extends readonly [infer H, ...infer Rest]
  ? LevelCreate<T, H> & PathCreate<T, Rest>
  : Record<never, never>;

/**
 * Leaf `K`'s state at one version: every column of every level of its chain,
 * keyed by field (hook columns included; a fact is `null` when absent).
 */
export type ChainState<S, T extends ChainTables, K> = Simplify<PathState<T, PathOf<S, K>>>;

/** A tri-state patch over a {@link ChainState}: a value sets, `null` clears, an absent key carries forward. */
export type ChainPatch<S, T extends ChainTables, K> = {
  readonly [F in keyof ChainState<S, T, K>]?: ChainState<S, T, K>[F] | undefined;
};

/** Leaf `K`'s state at version 0: every required column, the rest optional. */
export type ChainCreateState<S, T extends ChainTables, K> = Simplify<PathCreate<T, PathOf<S, K>>>;

/** The root identity table's injected extras (`slug`, say), as written at create. */
export type ChainIdentityExtras<T extends ChainTables> = Omit<
  InsertOf<T["root"]["identity"]>,
  "id" | "type"
>;

/** The root version table's injected extras (pulpit's `proposed_by`), as written on each version. */
export type ChainVersionExtras<T extends ChainTables> = Omit<
  InsertOf<T["root"]["version"]>,
  "id" | "version" | "action" | "timestamp" | "actor"
>;

/**
 * Who wrote a version, and the extras its root row records. `actor` is
 * required, so every caller states it (`undefined` for a write with no session
 * behind it).
 */
export interface ChainActor<VE> {
  /** The acting account, recorded in the root version table's actor column. */
  readonly actor: string | undefined;
  /** The root version table's injected extras for this version. */
  readonly root?: VE | undefined;
}

/** An optimistic-concurrency precondition: the head version the caller last read. */
export interface ChainPrecondition {
  /**
   * The head version the caller last read. Present: the write fails
   * {@link StaleVersion}, writing nothing, unless the head it extends is
   * exactly this. Absent: the write extends whatever the head is.
   */
  readonly expectedVersion?: bigint | undefined;
}

/** The input to {@link LeafChain.create}. */
export interface ChainCreateInput<State, IE, VE> extends ChainActor<VE> {
  /** A caller-supplied node id; minted (`gen_random_uuid()`) when absent. */
  readonly id?: string | undefined;
  /** The leaf's full state at version 0. */
  readonly state: State;
  /** The root identity table's injected extras. */
  readonly identity?: IE | undefined;
}

/** The input to {@link LeafChain.update} and {@link LeafChain.restore}. */
export interface ChainUpdateInput<Patch, VE> extends ChainActor<VE>, ChainPrecondition {
  /** The node to append to. */
  readonly id: string;
  /** The tri-state patch over the head's state. */
  readonly patch: Patch;
}

/** The options {@link LeafChain.delete} and {@link LeafChain.restoreVersion} take. */
export interface ChainWriteOptions<VE> extends ChainActor<VE>, ChainPrecondition {}
/* oxlint-enable effect/prefer-option-over-null */

/** What a chain write returns: the node and the version it landed at. */
export interface ChainWrite {
  readonly id: string;
  readonly version: bigint;
}

/** One version's reconstructed state: the root entry plus every level's columns. */
export interface ChainSnapshot<State> extends VersionChainEntry {
  readonly state: State;
}

/** The chain operations for one leaf. `E` is the driver's query failure; `I` the `CurrentTransaction` key. */
export interface LeafChain<State, CreateState, Patch, IE, VE, E, I> {
  /** Insert the node and version 0 (`create`) at every level. Fails {@link NodeAlreadyExists} on a taken id. */
  readonly create: (
    input: ChainCreateInput<CreateState, IE, VE>,
  ) => Effect.Effect<ChainWrite, E | NodeAlreadyExists | VersionConflict, I>;
  /**
   * Append an `update` version carrying the patch over the head's state.
   * Fails {@link NodeNotFound} for an unknown or tombstoned node and
   * {@link StaleVersion} when `expectedVersion` is not the head.
   */
  readonly update: (
    input: ChainUpdateInput<Patch, VE>,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | StaleVersion | VersionConflict, I>;
  /** {@link update}, except a tombstone does not fail: the explicit restore surface (`VERSION-CHAIN-006`). */
  readonly restore: (
    input: ChainUpdateInput<Patch, VE>,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | StaleVersion | VersionConflict, I>;
  /**
   * Append a `delete` version carrying every column forward. Idempotent: on a
   * tombstone it returns the existing one with `alreadyDeleted: true` and
   * writes nothing, whatever the precondition says.
   */
  readonly delete: (
    id: string,
    options: ChainWriteOptions<VE>,
  ) => Effect.Effect<
    ChainWrite & { readonly alreadyDeleted: boolean },
    E | NodeNotFound | StaleVersion | VersionConflict,
    I
  >;
  /**
   * Re-apply the full snapshot at `(id, version)` as a new `update` version,
   * over a tombstone too. Reads every level first: fails
   * {@link VersionNotFound} before writing anything when any has no row
   * there, and {@link StaleVersion} when the head is not `expectedVersion`.
   */
  readonly restoreVersion: (
    id: string,
    version: bigint,
    options: ChainWriteOptions<VE>,
  ) => Effect.Effect<ChainWrite, E | VersionNotFound | StaleVersion | VersionConflict, I>;
  /** The reconstructed state at `(id, version)`. Fails {@link VersionNotFound} when any level has no row there. */
  readonly getVersion: (
    id: string,
    version: bigint,
  ) => Effect.Effect<ChainSnapshot<State>, E | VersionNotFound, I>;
  /**
   * The chain, oldest first, at most `limit` entries (default and cap
   * {@link MAX_HISTORY_LIMIT}). Fails {@link NodeNotFound} when the id has no
   * versions of this leaf.
   */
  readonly history: (
    id: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<VersionChainEntry>, E | NodeNotFound, I>;
}

/** Every leaf's {@link LeafChain}, keyed by leaf name. */
export type VersionChain<S, T extends ChainTables, E, I> = {
  readonly [K in LeafOf<S>]: LeafChain<
    ChainState<S, T, K>,
    ChainCreateState<S, T, K>,
    ChainPatch<S, T, K>,
    ChainIdentityExtras<T>,
    ChainVersionExtras<T>,
    E,
    I
  >;
};

/** A runtime row: column values keyed by field. */
// oxlint-disable-next-line effect/no-unsafe-dictionary-type -- a Drizzle row seam: values are whatever the consumer's column builders decode; the typed surface is `ChainState`
type Row = Readonly<Record<string, unknown>>;

/** A root version row as the chain reads it: decoded at the driver boundary. */
const ChainEntryRow = Schema.Struct({
  version: Schema.BigInt,
  action: Schema.Literals(["create", "update", "delete"]),
  timestamp: Schema.Date,
});

/** Decode a root version row; a row that doesn't fit is a broken table, a defect. */
const decodeEntry = Schema.decodeUnknownEffect(ChainEntryRow);

/** The query failure a Drizzle `CurrentTransaction` reports. */
type QueryError<Tx> = Tx extends {
  readonly select: () => { readonly from: (table: never) => infer Q };
}
  ? Q extends Effect.Effect<unknown, infer E, unknown>
    ? E
    : never
  : never;

// ── The builder ───────────────────────────────────────────────────────

/** A thrown `DerivationError` for tables that don't match the tree. */
const tablesError = (message: string): never => {
  throw new DerivationError({ message: `makeVersionChain: ${message}` });
};

/** Column `key` of `table`, or a thrown `DerivationError`. */
const columnOf = (table: PgTable, key: string): AnyPgColumn =>
  Option.getOrElse(R.get(getTableColumns(table), key), () =>
    tablesError(
      `table "${getTableName(table)}" has no "${key}" column; was it built by makeTreeTables?`,
    ),
  );

/** The fields of a row that name a column of `table`, past `(id, version)`. */
const columnKeys = (table: PgTable): ReadonlyArray<string> =>
  Arr.filter(R.keys(getTableColumns(table)), (key) => key !== "id" && key !== "version");

/** `table`'s row at `(id, version)`: the join condition every level and fact takes. */
const atVersion = (table: PgTable, idColumn: AnyPgColumn, versionColumn: SQL | AnyPgColumn) =>
  and(eq(columnOf(table, "id"), idColumn), eq(columnOf(table, "version"), versionColumn));

/** Drop the `undefined` (carry-forward) arm of a patch. */
const present = (patch: Row): Row => R.filter(patch, (value) => value !== undefined);

/** Whether a (deep) Drizzle failure is the unique violation of constraint `name`. */
const onUniqueViolation =
  <A2, E2>(name: string, recover: () => Effect.Effect<A2, E2>) =>
  <A, E, Rq>(self: Effect.Effect<A, E, Rq>): Effect.Effect<A | A2, E | E2, Rq> =>
    self.pipe(
      catchUniqueViolation((violation) =>
        Option.contains(violation.constraint, name) ? recover() : Effect.die(violation),
      ),
    );

/**
 * Bind the version-chain discipline to a tree's tables and the application's
 * `CurrentTransaction`: one {@link LeafChain} per leaf, every operation
 * requiring the open transaction and traced as `${leaf}.<operation>`.
 *
 * Each version is written at every level of the leaf's chain: the root
 * version row (`action`, the actor, the injected extras; `timestamp` from
 * its default, the transaction's `now()`), then each level's version row in
 * path order, then each non-null fact. A create first writes the identity
 * row and every level's stable row, `type` set to the leaf. State is keyed by
 * field across the whole path (the tree rejects a key two levels of one path
 * share).
 *
 * Throws `DerivationError` at module load when the tables don't carry the
 * columns `makeTreeTables` derives. Query failures travel in the Effect error
 * channel as the driver's own error; a unique violation other than the root
 * version or identity key is a defect.
 *
 * @example
 * ```ts
 * import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
 * import { makeTreeTables } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
 * import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
 * import { makeVersionChain } from "@thomasfosterau/effect-drizzle-ext-pg/chain";
 * import { integer, pgSchema, text } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const tree = defineTree({
 *   work: {
 *     columns: { title: dbColumn(Schema.String, { column: "title", pg: "text", notNull: true }) },
 *   },
 *   book: {
 *     parent: "work",
 *     leaf: { pages: dbColumn(Schema.Finite, { column: "pages", pg: "integer", notNull: false }) },
 *   },
 * });
 * const tables = makeTreeTables(tree, {
 *   schema: pgSchema("catalogue"),
 *   builders: { text: (c: string) => text(c), integer: (c: string) => integer(c) },
 * });
 * const { CurrentTransaction, transact } = makePgDatabase({ relations: {}, key: "Database" });
 * const chain = makeVersionChain({ tree, tables, CurrentTransaction });
 *
 * // An Effect requiring the database; run it with the application's layer.
 * const created = transact(
 *   chain.book.create({ state: { title: "Dune", pages: 412 }, actor: undefined }),
 * );
 * console.log(typeof created); // "object"
 * ```
 */
export const makeVersionChain = <
  S,
  T extends ChainTables,
  I,
  Relations extends AnyRelations,
>(config: {
  readonly tree: ChainTree<S>;
  readonly tables: T;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): VersionChain<S, T, QueryError<PgTransaction<Relations>>, I> => {
  const { tree, tables, CurrentTransaction } = config;
  const identity = tables.root.identity;
  const rootVersion = tables.root.version;
  const root = {
    id: columnOf(rootVersion, "id"),
    version: columnOf(rootVersion, "version"),
    action: columnOf(rootVersion, "action"),
    timestamp: columnOf(rootVersion, "timestamp"),
  };
  const identityId = columnOf(identity, "id");
  const identityType = columnOf(identity, "type");
  const rootVersionKey = `${getTableName(rootVersion)}_pkey`;
  const identityKey = `${getTableName(identity)}_pkey`;
  const levelTables = (name: string) =>
    Option.getOrElse(R.get(tables.levels, name), () =>
      tablesError(`level "${name}" has no tables; were they built from this tree?`),
    );
  const factTables = (name: string) => Option.getOrElse(R.get(tables.facts, name), () => ({}));

  const leafChain = (leaf: string) => {
    const ancestors = Option.match(
      Arr.findFirst(tree.levels, (level) => level.name === leaf),
      {
        onNone: () => tablesError(`"${leaf}" is not a level of this tree`),
        onSome: (level) => level.ancestors,
      },
    );
    const path = [...ancestors, leaf];
    const levels = Arr.map(path, (name) => ({
      name,
      ...levelTables(name),
      keys: columnKeys(levelTables(name).version),
      facts: R.toEntries(factTables(name)),
    }));

    // The state at `(id, version)`: every level INNER JOINed (so a missing
    // level is a missing snapshot), every fact LEFT JOINed.
    const stateSelection = R.fromEntries([
      ...Arr.flatMap(levels, (level) =>
        Arr.map(level.keys, (key) => [key, columnOf(level.version, key)] as const),
      ),
      ...Arr.flatMap(levels, (level) =>
        Arr.map(level.facts, ([key, fact]) => [key, columnOf(fact, key)] as const),
      ),
    ]);

    const head = Effect.fn(`${leaf}.head`)(function* (id: string) {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select({ version: root.version, action: root.action, timestamp: root.timestamp })
        .from(rootVersion)
        .innerJoin(identity, eq(identityId, root.id))
        .where(and(eq(root.id, id), eq(identityType, leaf)))
        .orderBy(desc(root.version))
        .limit(1);
      return yield* Effect.orDie(
        Effect.transposeOption(Option.map(Arr.head(rows), (row) => decodeEntry(row))),
      );
    });

    const snapshot = Effect.fn(`${leaf}.snapshot`)(function* (id: string, version: bigint) {
      const tx = yield* CurrentTransaction;
      const query = Arr.reduce(
        levels,
        tx
          .select({
            version: root.version,
            action: root.action,
            timestamp: root.timestamp,
            ...stateSelection,
          })
          .from(rootVersion)
          .innerJoin(identity, eq(identityId, root.id))
          .$dynamic(),
        (q, level) => q.innerJoin(level.version, atVersion(level.version, root.id, root.version)),
      );
      const rows = yield* Arr.reduce(
        Arr.flatMap(levels, (level) => Arr.map(level.facts, ([, fact]) => fact)),
        query,
        (q, fact) => q.leftJoin(fact, atVersion(fact, root.id, root.version)),
      )
        .where(and(eq(root.id, id), eq(root.version, version), eq(identityType, leaf)))
        .limit(1);
      return yield* Effect.orDie(
        Effect.transposeOption(
          Option.map(Arr.head(rows), ({ version: v, action, timestamp, ...state }) =>
            Effect.map(decodeEntry({ version: v, action, timestamp }), (entry) => ({
              ...entry,
              state,
            })),
          ),
        ),
      );
    });

    /** The head's snapshot; a head with no snapshot is a broken chain (a defect). */
    const current = Effect.fn(`${leaf}.current`)(function* (id: string) {
      const found = yield* head(id);
      if (Option.isNone(found)) return Option.none();
      const state = yield* snapshot(id, found.value.version);
      if (Option.isNone(state)) {
        return yield* Effect.die(new BrokenChain({ type: leaf, id, version: found.value.version }));
      }
      return state;
    });

    /** Write one version at every level: the root row, each level's row, each non-null fact. */
    const writeVersion = Effect.fn(`${leaf}.writeVersion`)(function* (
      id: string,
      version: bigint,
      action: VersionAction,
      state: Row,
      who: ChainActor<Row>,
    ) {
      const tx = yield* CurrentTransaction;
      yield* tx
        .insert(rootVersion)
        .values({ ...who.root, id, version, action, actor: who.actor })
        .pipe(
          onUniqueViolation(rootVersionKey, () =>
            Effect.fail(new VersionConflict({ id, version })),
          ),
        );
      yield* Effect.forEach(
        levels,
        (level) =>
          tx
            .insert(level.version)
            .values({ ...R.filter(state, (_, key) => Arr.contains(level.keys, key)), id, version }),
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(
        Arr.flatMap(levels, (level) => level.facts),
        ([key, fact]) =>
          Option.match(Option.fromNullishOr(R.get(state, key).pipe(Option.getOrUndefined)), {
            onNone: () => Effect.void,
            onSome: (value) => Effect.asVoid(tx.insert(fact).values({ id, version, [key]: value })),
          }),
        { concurrency: 1, discard: true },
      );
    });

    /** Append at `previous + 1` after checking the precondition against that same head. */
    const appendNext = (
      id: string,
      previous: VersionChainEntry,
      action: VersionAction,
      state: Row,
      options: ChainWriteOptions<Row>,
    ) =>
      options.expectedVersion !== undefined && options.expectedVersion !== previous.version
        ? Effect.fail(
            new StaleVersion({
              type: leaf,
              id,
              expected: options.expectedVersion,
              current: previous.version,
            }),
          )
        : Effect.as(writeVersion(id, previous.version + 1n, action, state, options), {
            id,
            version: previous.version + 1n,
          });

    const mintId = Effect.fn(`${leaf}.mintId`)(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx.execute<{ readonly id: string }>(sql`SELECT gen_random_uuid() AS id`);
      return Option.getOrElse(Arr.head(rows.rows).pipe(Option.map((row) => row.id)), () =>
        tablesError("gen_random_uuid() returned no row"),
      );
    });

    const create = Effect.fn(`${leaf}.create`)(function* (input: ChainCreateInput<Row, Row, Row>) {
      const tx = yield* CurrentTransaction;
      const id = input.id ?? (yield* mintId());
      if (input.id !== undefined && Option.isSome(yield* headAnyType(id))) {
        return yield* new NodeAlreadyExists({ type: leaf, id });
      }
      yield* tx
        .insert(identity)
        .values({ ...input.identity, id, type: leaf })
        .pipe(
          // A racing create that took the id between the check and this insert.
          onUniqueViolation(identityKey, () =>
            Effect.fail(new NodeAlreadyExists({ type: leaf, id })),
          ),
        );
      // Stable rows in path order: each references its parent's (the branch
      // root's references the identity row). The version rows follow.
      yield* Effect.forEach(levels, (level) => tx.insert(level.stable).values({ id, type: leaf }), {
        concurrency: 1,
        discard: true,
      });
      yield* writeVersion(id, 0n, "create", present(input.state), input);
      return { id, version: 0n };
    });

    /** Any node's head, whatever its leaf: what makes a create never an upsert. */
    const headAnyType = Effect.fn(`${leaf}.headAnyType`)(function* (id: string) {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select({ id: identityId })
        .from(identity)
        .where(eq(identityId, id))
        .limit(1);
      return Arr.head(rows);
    });

    const merge = (input: ChainUpdateInput<Row, Row>, allowDeleted: boolean) =>
      Effect.gen(function* () {
        const found = yield* current(input.id);
        if (Option.isNone(found) || (found.value.action === "delete" && !allowDeleted)) {
          return yield* new NodeNotFound({ type: leaf, id: input.id });
        }
        return yield* appendNext(
          input.id,
          found.value,
          "update",
          { ...found.value.state, ...present(input.patch) },
          input,
        );
      });

    const update = Effect.fn(`${leaf}.update`)(function* (input: ChainUpdateInput<Row, Row>) {
      return yield* merge(input, false);
    });

    const restore = Effect.fn(`${leaf}.restore`)(function* (input: ChainUpdateInput<Row, Row>) {
      return yield* merge(input, true);
    });

    const softDelete = Effect.fn(`${leaf}.delete`)(function* (
      id: string,
      options: ChainWriteOptions<Row>,
    ) {
      const found = yield* current(id);
      if (Option.isNone(found)) return yield* new NodeNotFound({ type: leaf, id });
      if (found.value.action === "delete") {
        return { id, version: found.value.version, alreadyDeleted: true };
      }
      const written = yield* appendNext(id, found.value, "delete", found.value.state, options);
      return { ...written, alreadyDeleted: false };
    });

    const getVersion = Effect.fn(`${leaf}.getVersion`)(function* (id: string, version: bigint) {
      const found = yield* snapshot(id, version);
      if (Option.isNone(found)) return yield* new VersionNotFound({ type: leaf, id, version });
      return found.value;
    });

    const restoreVersion = Effect.fn(`${leaf}.restoreVersion`)(function* (
      id: string,
      version: bigint,
      options: ChainWriteOptions<Row>,
    ) {
      // Read the whole historical state first, so an unreconstructable version
      // fails before the chain is touched.
      const found = yield* snapshot(id, version);
      if (Option.isNone(found)) return yield* new VersionNotFound({ type: leaf, id, version });
      const latest = yield* head(id);
      if (Option.isNone(latest)) return yield* new VersionNotFound({ type: leaf, id, version });
      // `update`, not a fourth action: a restore is an ordinary edit whose
      // content came from history, and `action` stays the currency /
      // tombstone axis every fail-closed view reads.
      return yield* appendNext(id, latest.value, "update", found.value.state, options);
    });

    const history = Effect.fn(`${leaf}.history`)(function* (
      id: string,
      limit: number = MAX_HISTORY_LIMIT,
    ) {
      const tx = yield* CurrentTransaction;
      const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_HISTORY_LIMIT));
      const rows = yield* tx
        .select({ version: root.version, action: root.action, timestamp: root.timestamp })
        .from(rootVersion)
        .innerJoin(identity, eq(identityId, root.id))
        .where(and(eq(root.id, id), eq(identityType, leaf)))
        .orderBy(asc(root.version))
        .limit(bounded);
      const entries = yield* Effect.orDie(
        Effect.forEach(rows, (row) => decodeEntry(row), { concurrency: 1 }),
      );
      return yield* Arr.match(entries, {
        onEmpty: () => Effect.fail(new NodeNotFound({ type: leaf, id })),
        onNonEmpty: (nonEmpty) => Effect.succeed(nonEmpty),
      });
    });

    return {
      create,
      update,
      restore,
      delete: softDelete,
      restoreVersion,
      getVersion,
      history,
    };
  };

  const chains = R.fromEntries(Arr.map(tree.leaves, (leaf) => [leaf, leafChain(leaf)]));
  // SAFETY: the type-erasure seam, as in core's makeTreeTables. Every leaf's
  // operations were built above over the same tables `T` types, reading and
  // writing exactly the fields `ChainState` / `ChainCreateState` name; only the
  // per-leaf precision was erased by assembling them from the runtime tree.
  // oxlint-disable-next-line effect/no-chained-type-assertions, effect/avoid-any -- the seam above: the runtime operations take the untyped `Row`, the typed surface each leaf's own state, so the two share no overlap TypeScript can check
  return chains as unknown as VersionChain<S, T, QueryError<PgTransaction<Relations>>, I>;
};
