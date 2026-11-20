/**
 * `./Outbox`'s table builder and constructor without a database: the columns
 * and constraints drizzle-kit sees, and the module-load check that the table was built from `outboxColumns()`.
 *
 * @module packages/pg/tests/Outbox
 */

import { getTableConfig, pgTable, text } from "drizzle-orm/pg-core";
import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { describe, expect, it } from "vite-plus/test";
import { makeOutbox, outboxColumns, outboxConstraints } from "../src/Outbox.ts";
import { makePgDatabase } from "../src/index.ts";

const { CurrentTransaction } = makePgDatabase({ relations: {}, key: "Database" });

describe("outboxColumns / outboxConstraints", () => {
  const config = getTableConfig(pgTable("events", outboxColumns(), outboxConstraints("events")));

  it("names the columns in snake case, with only publishedAt nullable", () => {
    expect(config.columns.map((column) => [column.name, column.notNull])).toEqual([
      ["seq", true],
      ["stream", true],
      ["stream_version", true],
      ["event_index", true],
      ["type", true],
      ["payload", true],
      ["recorded_at", true],
      ["published_at", false],
    ]);
  });

  it("dedupes on (stream, version, index) and indexes the pending rows", () => {
    expect(
      config.uniqueConstraints.map((unique) => [
        unique.name,
        unique.columns.map((column) => column.name),
      ]),
    ).toEqual([["events_stream_event_unique", ["stream", "stream_version", "event_index"]]]);
    expect(config.indexes.map((index) => index.config.name)).toEqual(["events_pending_idx"]);
    expect(config.indexes[0]?.config.where).toBeDefined();
  });
});

describe("makeOutbox", () => {
  it("throws DerivationError for a table not built from outboxColumns()", () => {
    const table = pgTable("events", { stream: text("stream") });
    expect(() => makeOutbox({ table, CurrentTransaction })).toThrow(DerivationError);
  });
});
