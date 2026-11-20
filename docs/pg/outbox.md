# `./Outbox`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

A transactional outbox: an event is written in the same transaction as the change it explains, so a commit can't happen without its event and a rollback can't leave one behind. A drain later hands pending events to a publisher (a queue, a webhook) and marks them published.

## The table

The table lives in your schema, so `drizzle-kit generate` migrates it like any other:

```ts
import { outboxColumns, outboxConstraints } from "@thomasfosterau/effect-drizzle-ext-pg/Outbox";

export const outboxTable = pgTable("outbox", outboxColumns(), outboxConstraints("outbox"));
```

| Column | Meaning |
| --- | --- |
| `seq` | Identity; the drain order. |
| `stream`, `stream_version`, `event_index` | Which write the event explains: a stream (one aggregate instance, say), the version the write landed at, and the event's place among that write's events. Unique together (`<name>_stream_event_unique`), so consumers dedupe on them. |
| `type`, `payload` | The event's tag and its encoded JSON (`jsonb`). |
| `recorded_at`, `published_at` | When it was appended, and when a drain handed it over (`NULL` while pending; `<name>_pending_idx` is a partial index on those rows). |

## Operations

`makeOutbox({ table, CurrentTransaction })` returns three operations. Each requires `CurrentTransaction` and none opens a transaction.

| Operation | What it does |
| --- | --- |
| `append(events)` | Inserts the events in the caller's transaction. An empty batch writes nothing; a repeated `(stream, streamVersion, eventIndex)` fails with the driver's unique violation. |
| `drain(publish, { limit? })` | Claims up to `limit` pending events (default 100, cap `MAX_DRAIN_LIMIT`, 1000) oldest first, runs `publish(batch)`, then marks them published. Returns how many it published. |
| `pending(limit?)` | The pending events, oldest first. |

**Run each drain in a transaction of its own** (`transact(outbox.drain(publish))`). If `publish` fails, the rollback leaves the whole batch pending; if the process dies after publishing but before commit, the next drain publishes it again. Delivery is **at least once**, so consumers dedupe on the stream key.

**One drain at a time per table.** A drain first takes a transaction-scoped advisory lock keyed by the table name (`pg_try_advisory_xact_lock`). A second drain that can't take it returns `0` straight away instead of waiting or skipping ahead, so events reach the publisher in global `seq` order, which keeps every stream in order too. Run the drain from wherever fits (a cron sweep, a queue consumer kicked after commit, or both): extra drains are cheap no-ops while one is running.

```ts
const outbox = makeOutbox({ table: outboxTable, CurrentTransaction });

// With the write it explains:
transact(Effect.andThen(saveOrder(order), outbox.append([orderPlaced(order)])));

// Later, on its own:
transact(outbox.drain((batch) => queue.sendBatch(batch.map(toMessage))));
```
