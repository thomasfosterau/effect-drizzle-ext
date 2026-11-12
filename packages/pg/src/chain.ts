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
 * - **An id that isn't a UUID is an unknown node.** `head` returns
 *   `Option.none()`, and `update` / `restore` / `delete` / `history` fail
 *   {@link NodeNotFound} (`getVersion` / `restoreVersion` fail
 *   {@link VersionNotFound}), all without a query. A malformed id from a URL
 *   is then the wire's 404, not a `22P02` that aborts the transaction.
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
  type InferSelectModel,
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
  readonly keyed: Readonly<Record<string, PgTable>>;
}

/** The tree facts the chain reads (a `defineTree` result satisfies it). */
export interface ChainTree<S> {
  readonly spec: S;
  readonly leaves: ReadonlyArray<string>;
  readonly levels: ReadonlyArray<{
    readonly name: string;
    readonly ancestors: ReadonlyArray<string>;
    readonly keyed: Option.Option<{ readonly name: string }>;
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

/** The key column's name a leaf entry's keyed level declares; `never` when it has none. */
type KeyedNameOf<E> = E extends { readonly keyed?: infer K }
  ? Exclude<K, undefined> extends { readonly name: infer N extends string }
    ? N
    : never
  : never;

/**
 * One key's columns in leaf `K`'s keyed level (a locale's translated
 * columns); `never` for a leaf with no keyed level.
 */
export type ChainKeyedState<S, T extends ChainTables, K> = K extends keyof T["keyed"]
  ? Simplify<Omit<RowOf<T["keyed"][K]>, "id" | "version" | KeyedNameOf<MemberOf<S, K>>>>
  : never;

/**
 * Leaf `K`'s keyed level at one version: each key it carries, and that key's
 * columns. A version that carries none is `{}`.
 */
export type ChainKeyedLevel<S, T extends ChainTables, K> = {
  readonly [key: string]: ChainKeyedState<S, T, K>;
};

/**
 * A per-key tri-state patch over a {@link ChainKeyedLevel}: a key's patch
 * updates its columns (from none for a key the head lacks), `null` drops the
 * key, and an absent or `undefined` key carries it forward.
 */
export type ChainKeyedPatch<S, T extends ChainTables, K> = {
  readonly [key: string]:
    | { readonly [F in keyof ChainKeyedState<S, T, K>]?: ChainKeyedState<S, T, K>[F] | undefined }
    | null
    | undefined;
};

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
export interface ChainCreateInput<State, IE, VE, KL = never> extends ChainActor<VE> {
  /** A caller-supplied node id; minted (`gen_random_uuid()`) when absent. */
  readonly id?: string | undefined;
  /** The leaf's full state at version 0. */
  readonly state: State;
  /** A keyed leaf's keyed level at version 0 (every key it carries); absent, none. */
  readonly keyed?: KL | undefined;
  /** The root identity table's injected extras. */
  readonly identity?: IE | undefined;
}

/** The input to {@link LeafChain.update} and {@link LeafChain.restore}. */
export interface ChainUpdateInput<Patch, VE, KP = never> extends ChainActor<VE>, ChainPrecondition {
  /** The node to append to. */
  readonly id: string;
  /** The tri-state patch over the head's state. */
  readonly patch: Patch;
  /**
   * A keyed leaf's per-key patch ({@link ChainKeyedPatch}); absent, every key
   * carries forward. A write touching one key still appends one version of
   * the whole node.
   */
  readonly keyed?: KP | undefined;
}

/** The options {@link LeafChain.delete} and {@link LeafChain.restoreVersion} take. */
export interface ChainWriteOptions<VE> extends ChainActor<VE>, ChainPrecondition {}

/** What a chain write returns: the node and the version it landed at. */
export interface ChainWrite {
  readonly id: string;
  readonly version: bigint;
}

/** One version's reconstructed state: the root entry plus every level's columns. */
export interface ChainSnapshot<State, KL = Record<never, never>> extends VersionChainEntry {
  readonly state: State;
  /** A keyed leaf's keyed level at this version; `{}` for none (and for a leaf with no keyed level). */
  readonly keyed: KL;
}

/** The chain operations for one leaf. `E` is the driver's query failure; `I` the `CurrentTransaction` key. */
export interface LeafChain<
  State,
  CreateState,
  Patch,
  IE,
  VE,
  E,
  I,
  KL = Record<never, never>,
  KP = never,
> {
  /** Insert the node and version 0 (`create`) at every level. Fails {@link NodeAlreadyExists} on a taken id. */
  readonly create: (
    input: ChainCreateInput<CreateState, IE, VE, KL>,
  ) => Effect.Effect<ChainWrite, E | NodeAlreadyExists | VersionConflict, I>;
  /**
   * Append an `update` version carrying the patch over the head's state.
   * Fails {@link NodeNotFound} for an unknown or tombstoned node and
   * {@link StaleVersion} when `expectedVersion` is not the head.
   */
  readonly update: (
    input: ChainUpdateInput<Patch, VE, KP>,
  ) => Effect.Effect<ChainWrite, E | NodeNotFound | StaleVersion | VersionConflict, I>;
  /** {@link update}, except a tombstone does not fail: the explicit restore surface (`VERSION-CHAIN-006`). */
  readonly restore: (
    input: ChainUpdateInput<Patch, VE, KP>,
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
  /**
   * The node's head entry (`version`, `action`, `timestamp`): what a caller
   * reads to pin a write's `expectedVersion`. `Option.none()` for an id with
   * no versions of this leaf (unknown, or another leaf's node); never a
   * failure. A tombstone's head is its `delete` entry.
   */
  readonly head: (id: string) => Effect.Effect<Option.Option<VersionChainEntry>, E, I>;
  /** The reconstructed state at `(id, version)`. Fails {@link VersionNotFound} when any level has no row there. */
  readonly getVersion: (
    id: string,
    version: bigint,
  ) => Effect.Effect<ChainSnapshot<State, KL>, E | VersionNotFound, I>;
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
    I,
    ChainKeyedLevel<S, T, K>,
    ChainKeyedPatch<S, T, K>
  >;
};

/** A runtime row: column values keyed by field. */
type Row = Readonly<InferSelectModel<PgTable>>;

/** A keyed level as the runtime holds it: each key's columns, keyed by key. */
type KeyedRows = Readonly<Record<string, Row>>;

type KeyedPatchRows = Readonly<Record<string, Row | null | undefined>>;

/** What one version stores: the shared state and the keyed level. */
interface Content {
  readonly state: Row;
  readonly keyed: KeyedRows;
}

/**
 * Apply a per-key patch: a key's patch updates its columns (from none for a
 * new key), `null` drops the key, `undefined` carries it forward.
 */
const applyKeyedPatch = (level: KeyedRows, patch: Option.Option<KeyedPatchRows>): KeyedRows =>
  R.reduce(
    Option.getOrElse(patch, (): KeyedPatchRows => ({})),
    level,
    (acc, change, key) =>
      change === undefined
        ? acc
        : change === null
          ? R.remove(acc, key)
          : {
              ...acc,
              [key]: { ...Option.getOrElse(R.get(acc, key), () => ({})), ...present(change) },
            },
  );

/** A create's keyed level: each key's present columns, `{}` when absent. */
const initialKeyed = (level: Option.Option<KeyedRows>): KeyedRows =>
  R.map(
    Option.getOrElse(level, (): KeyedRows => ({})),
    (values) => present(values),
  );

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
/**
 * PostgreSQL's `uuid` input grammar (`uuid_in`): 32 hex digits, a hyphen
 * allowed after any group of four, the whole optionally in braces, any case.
 * Not a version / variant check: the column takes any 128-bit value.
 */
const PG_UUID = /^(?:\{[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(?:-?[0-9a-f]{4}){7})$/i;

/**
 * Whether `id` can name a node at all. A string PostgreSQL's `uuid` column
 * rejects (`22P02`) is an unknown node, never a query: sending it would fail
 * the statement and abort the caller's transaction.
 */
const isNodeId = (id: string): boolean => PG_UUID.test(id);

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
 * A keyed leaf (core's `keyed: { name, columns }`) also writes its keyed
 * level on every append: one `${leaf}_${name}` row per key. `create` takes the
 * whole level (`keyed`), `update` / `restore` a per-key tri-state patch (a
 * patch updates a key, `null` drops it, an absent key carries it forward),
 * `delete` and `restoreVersion` carry or restore every key, and a snapshot
 * reads it back as `keyed`, keyed by key (`{}` for none), pulpit#56's
 * `LocaleStates`.
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
    // A keyed leaf's key name, table and keyed columns.
    const keyed = Option.flatMap(
      Arr.findFirst(tree.levels, (level) => level.name === leaf),
      (level) =>
        Option.map(level.keyed, ({ name }) => {
          const table = Option.getOrElse(R.get(tables.keyed, leaf), () =>
            tablesError(`leaf "${leaf}" has no keyed table; were the tables built from this tree?`),
          );
          return {
            name,
            table,
            keyColumn: columnOf(table, name),
            columns: Arr.filter(columnKeys(table), (key) => key !== name),
          };
        }),
    );
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
      if (!isNodeId(id)) return Option.none();
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
      if (!isNodeId(id)) return Option.none();
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
      const found = yield* Effect.orDie(
        Effect.transposeOption(
          Option.map(Arr.head(rows), ({ version: v, action, timestamp, ...state }) =>
            Effect.map(decodeEntry({ version: v, action, timestamp }), (entry) => ({
              ...entry,
              state,
            })),
          ),
        ),
      );
      if (Option.isNone(found)) return Option.none();
      return Option.some({ ...found.value, keyed: yield* keyedAt(id, version) });
    });

    /** The keyed level at `(id, version)`: each key's columns, keyed by key. */
    const keyedAt = Effect.fn(`${leaf}.keyedAt`)(function* (id: string, version: bigint) {
      if (Option.isNone(keyed)) return R.empty<string, Row>();
      const tx = yield* CurrentTransaction;
      const { table, keyColumn, columns } = keyed.value;
      const rows: ReadonlyArray<Row> = yield* tx
        .select({
          key: keyColumn,
          ...R.fromEntries(Arr.map(columns, (key) => [key, columnOf(table, key)] as const)),
        })
        .from(table)
        .where(and(eq(columnOf(table, "id"), id), eq(columnOf(table, "version"), version)))
        .orderBy(asc(keyColumn));
      return R.fromEntries(Arr.map(rows, ({ key, ...values }) => [String(key), values] as const));
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
      keyedLevel: KeyedRows,
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
      yield* Option.match(keyed, {
        onNone: () => Effect.void,
        onSome: ({ name, table }) =>
          Effect.forEach(
            R.toEntries(keyedLevel),
            ([key, values]) => tx.insert(table).values({ ...values, id, version, [name]: key }),
            { concurrency: 1, discard: true },
          ),
      });
    });

    /** Append at `previous + 1` after checking the precondition against that same head. */
    const appendNext = (
      id: string,
      previous: VersionChainEntry,
      action: VersionAction,
      content: Content,
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
        : Effect.as(
            writeVersion(id, previous.version + 1n, action, content.state, content.keyed, options),
            {
              id,
              version: previous.version + 1n,
            },
          );

    const mintId = Effect.fn(`${leaf}.mintId`)(function* () {
      const tx = yield* CurrentTransaction;
      const rows = yield* tx.execute<{ readonly id: string }>(sql`SELECT gen_random_uuid() AS id`);
      return Option.getOrElse(Arr.head(rows.rows).pipe(Option.map((row) => row.id)), () =>
        tablesError("gen_random_uuid() returned no row"),
      );
    });

    const create = Effect.fn(`${leaf}.create`)(function* (
      input: ChainCreateInput<Row, Row, Row, KeyedRows>,
    ) {
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
      yield* writeVersion(
        id,
        0n,
        "create",
        present(input.state),
        initialKeyed(Option.fromUndefinedOr(input.keyed)),
        input,
      );
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

    const merge = (input: ChainUpdateInput<Row, Row, KeyedPatchRows>, allowDeleted: boolean) =>
      Effect.gen(function* () {
        const found = yield* current(input.id);
        if (Option.isNone(found) || (found.value.action === "delete" && !allowDeleted)) {
          return yield* new NodeNotFound({ type: leaf, id: input.id });
        }
        return yield* appendNext(
          input.id,
          found.value,
          "update",
          {
            state: { ...found.value.state, ...present(input.patch) },
            keyed: applyKeyedPatch(found.value.keyed, Option.fromUndefinedOr(input.keyed)),
          },
          input,
        );
      });

    const update = Effect.fn(`${leaf}.update`)(function* (
      input: ChainUpdateInput<Row, Row, KeyedPatchRows>,
    ) {
      return yield* merge(input, false);
    });

    const restore = Effect.fn(`${leaf}.restore`)(function* (
      input: ChainUpdateInput<Row, Row, KeyedPatchRows>,
    ) {
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
      const written = yield* appendNext(id, found.value, "delete", found.value, options);
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
      return yield* appendNext(id, latest.value, "update", found.value, options);
    });

    const history = Effect.fn(`${leaf}.history`)(function* (
      id: string,
      limit: number = MAX_HISTORY_LIMIT,
    ) {
      if (!isNodeId(id)) return yield* new NodeNotFound({ type: leaf, id });
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
      head,
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
  return chains as unknown as VersionChain<S, T, QueryError<PgTransaction<Relations>>, I>;
};
