/**
 * A transactional outbox: events appended in the same transaction as the
 * write they explain, drained in order by one worker at a time and handed to
 * a publisher at least once.
 *
 * @module Outbox
 */

import { asc, getTableName, inArray, isNull, sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  type ExtraConfigColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AnyRelations } from "drizzle-orm";
import type { PgTransaction } from "./index.ts";
import { columnOf as tableColumnOf, type QueryError } from "./internal/table.ts";

/**
 * The outbox table's columns, for the application to build its table with
 * (`pgTable("outbox", outboxColumns(), outboxConstraints("outbox"))`), so the
 * table sits in its schema and drizzle-kit migrates it like any other.
 *
 * - `seq`: the drain order, an identity column.
 * - `stream`, `streamVersion`, `eventIndex`: which write the event explains
 *   (an aggregate instance, the version the write landed at, and the event's
 *   place among that write's events), unique together, so a consumer can
 *   dedupe on them.
 * - `type`, `payload`: the event's tag and its encoded JSON.
 * - `recordedAt`, `publishedAt`: when it was appended, and when a drain
 *   handed it to the publisher (`NULL` while pending).
 *
 * @example
 * ```ts
 * import { outboxColumns, outboxConstraints } from "@thomasfosterau/effect-drizzle-ext-pg/Outbox";
 * import { getTableName } from "drizzle-orm";
 * import { pgTable } from "drizzle-orm/pg-core";
 *
 * export const outbox = pgTable("outbox", outboxColumns(), outboxConstraints("outbox"));
 * console.log(getTableName(outbox)); // "outbox"
 * ```
 */
export const outboxColumns = () => ({
  seq: bigint("seq", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  stream: text("stream").notNull(),
  streamVersion: bigint("stream_version", { mode: "bigint" }).notNull(),
  eventIndex: integer("event_index").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

/**
 * The outbox table's constraints, named after the table: the dedupe key
 * `${name}_stream_event_unique` and the partial index
 * `${name}_pending_idx` a drain reads.
 */
export const outboxConstraints =
  (name: string) =>
  (table: {
    readonly seq: ExtraConfigColumn;
    readonly stream: ExtraConfigColumn;
    readonly streamVersion: ExtraConfigColumn;
    readonly eventIndex: ExtraConfigColumn;
    readonly publishedAt: ExtraConfigColumn;
  }) => [
    unique(`${name}_stream_event_unique`).on(table.stream, table.streamVersion, table.eventIndex),
    index(`${name}_pending_idx`)
      .on(table.seq)
      .where(sql`${table.publishedAt} IS NULL`),
  ];

/**
 * One event to append.
 */
export interface OutboxEvent {
  readonly stream: string;
  readonly streamVersion: bigint;
  readonly eventIndex: number;
  readonly type: string;
  /** Encoded JSON. */
  readonly payload: unknown;
}

/**
 * A stored event, as a drain hands it to the publisher.
 */
export interface OutboxRecord extends OutboxEvent {
  readonly seq: bigint;
  readonly recordedAt: Date;
}

/**
 * The most events one drain claims.
 */
export const MAX_DRAIN_LIMIT = 1000;

/**
 * The outbox operations over one table. `E` is the driver's query failure;
 * `I` the `CurrentTransaction` key. None opens a transaction.
 */
export interface Outbox<E, I> {
  /** Append events inside the caller's transaction; a rollback drops them with the write. */
  readonly append: (events: ReadonlyArray<OutboxEvent>) => Effect.Effect<void, E, I>;
  /**
   * Claim up to `limit` pending events (default 100, cap
   * {@link MAX_DRAIN_LIMIT}) oldest first, hand them to `publish`, and mark
   * them published. Run it in a transaction of its own: if `publish` fails,
   * the rollback leaves every event pending for the next drain, so delivery
   * is at least once. Only one drain runs at a time per table (a
   * transaction-scoped advisory lock); a concurrent one claims nothing, so
   * events reach the publisher in `seq` order. Returns the number published.
   */
  readonly drain: <E2, R2>(
    publish: (batch: ReadonlyArray<OutboxRecord>) => Effect.Effect<void, E2, R2>,
    options?: { readonly limit?: number },
  ) => Effect.Effect<number, E | E2, I | R2>;
  /** The pending events, oldest first, at most `limit` (default 100, cap {@link MAX_DRAIN_LIMIT}). */
  readonly pending: (limit?: number) => Effect.Effect<ReadonlyArray<OutboxRecord>, E, I>;
}

const Row = Schema.Struct({
  seq: Schema.BigInt,
  stream: Schema.String,
  streamVersion: Schema.BigInt,
  eventIndex: Schema.Int,
  type: Schema.String,
  payload: Schema.Unknown,
  recordedAt: Schema.Date,
});

/** A row that doesn't fit is a broken table, a defect. */
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const Locked = Schema.Struct({ isLocked: Schema.Boolean });
const decodeLocked = Schema.decodeUnknownEffect(Schema.Array(Locked));

const columnOf = tableColumnOf("makeOutbox", "outboxColumns");

const clamp = (limit = 100): number => Math.max(1, Math.min(limit, MAX_DRAIN_LIMIT));

/**
 * The outbox operations over `table`, which must be built from
 * {@link outboxColumns}. Throws `DerivationError` at module load when a
 * column is missing.
 */
export const makeOutbox = <I, Relations extends AnyRelations>(config: {
  readonly table: PgTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): Outbox<QueryError<PgTransaction<Relations>>, I> => {
  const { table, CurrentTransaction } = config;
  const columns = {
    seq: columnOf(table, "seq"),
    stream: columnOf(table, "stream"),
    streamVersion: columnOf(table, "streamVersion"),
    eventIndex: columnOf(table, "eventIndex"),
    type: columnOf(table, "type"),
    payload: columnOf(table, "payload"),
    recordedAt: columnOf(table, "recordedAt"),
    publishedAt: columnOf(table, "publishedAt"),
  };
  const select = {
    seq: columns.seq,
    stream: columns.stream,
    streamVersion: columns.streamVersion,
    eventIndex: columns.eventIndex,
    type: columns.type,
    payload: columns.payload,
    recordedAt: columns.recordedAt,
  };
  const lockKey = `effect-drizzle-ext/outbox/${getTableName(table)}`;

  const pending = Effect.fn("Outbox.pending")(function* (limit?: number) {
    const tx = yield* CurrentTransaction;
    const rows = yield* tx
      .select(select)
      .from(table)
      .where(isNull(columns.publishedAt))
      .orderBy(asc(columns.seq))
      .limit(clamp(limit));
    return yield* Effect.orDie(decodeRows(rows));
  });

  return {
    append: Effect.fn("Outbox.append")(function* (events) {
      if (!Arr.isReadonlyArrayNonEmpty(events)) return;
      const tx = yield* CurrentTransaction;
      yield* tx.insert(table).values(
        Arr.map(events, (event) => ({
          stream: event.stream,
          streamVersion: event.streamVersion,
          eventIndex: event.eventIndex,
          type: event.type,
          payload: event.payload,
        })),
      );
    }),
    drain: Effect.fn("Outbox.drain")(function* <E2, R2>(
      publish: (batch: ReadonlyArray<OutboxRecord>) => Effect.Effect<void, E2, R2>,
      options?: { readonly limit?: number },
    ) {
      const tx = yield* CurrentTransaction;
      const lock = yield* tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS "isLocked"`,
      );
      const locked = yield* Effect.orDie(decodeLocked(lock.rows));
      if (!Arr.some(locked, (row) => row.isLocked)) return 0;
      const rows = yield* tx
        .select(select)
        .from(table)
        .where(isNull(columns.publishedAt))
        .orderBy(asc(columns.seq))
        .limit(clamp(options?.limit))
        .for("update");
      const batch = yield* Effect.orDie(decodeRows(rows));
      if (!Arr.isReadonlyArrayNonEmpty(batch)) return 0;
      yield* publish(batch);
      yield* tx
        .update(table)
        .set({ publishedAt: sql`now()` })
        .where(
          inArray(
            columns.seq,
            Arr.map(batch, (record) => record.seq),
          ),
        );
      return batch.length;
    }),
    pending,
  };
};
