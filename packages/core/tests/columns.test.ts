/**
 * Unit tests for `./columns` — Drizzle column helpers and the hex codec, none
 * of which need a database: DDL shape and codec behaviour are inspected
 * through `getTableConfig` against a `pgTable` built in memory.
 *
 * @module tests/columns
 */

import { describe, expect, it } from "vite-plus/test";
import { getTableConfig, pgTable } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import {
  bytea,
  byteaToHex,
  hexToBytea,
  jsonbSchema,
  timestamps,
  tsvector,
} from "../src/columns.ts";

/** A minimal Effect Schema fixture for {@link jsonbSchema} tests. */
const Fixture = Schema.Struct({ id: Schema.String, count: Schema.Finite });

/** JSON text of an arbitrary value, the codec's driver-side representation. */
const Json = Schema.fromJsonString(Schema.Unknown);

/** What a fixture lookup throws when the table has no column of that name. */
class NoSuchColumn extends Schema.TaggedError<NoSuchColumn>()("NoSuchColumn", {
  column: Schema.String,
}) {}

/** Looks up one column by name from a materialised table's DDL config. */
const columnNamed = (table: PgTable, name: string) => {
  const column = getTableConfig(table).columns.find((c) => c.name === name);
  if (!column) throw new NoSuchColumn({ column: name });
  return column;
};

type Column = ReturnType<typeof columnNamed>;

/**
 * What the tests hand the codec: JSON text, or an already-parsed object that
 * may or may not satisfy {@link Fixture}.
 */
type DriverInput = string | { readonly id: string; readonly count?: number | string };

/** The codec's decode side; Drizzle types both codec sides `any`. */
const fromDriver = (column: Column, value: DriverInput): typeof Fixture.Type =>
  column.mapFromDriverValue(value);

/** The codec's encode side; Drizzle types both codec sides `any`. */
const toDriver = (column: Column, value: DriverInput): string => column.mapToDriverValue(value);

describe("bytea", () => {
  it("is a bytea column", () => {
    const table = pgTable("widget", { hash: bytea("hash") });
    expect(columnNamed(table, "hash").getSQLType()).toBe("bytea");
  });
});

describe("tsvector", () => {
  it("is a tsvector column", () => {
    const table = pgTable("widget", { search: tsvector("search") });
    expect(columnNamed(table, "search").getSQLType()).toBe("tsvector");
  });
});

describe("jsonbSchema", () => {
  it("is a jsonb column", () => {
    const table = pgTable("widget", { data: jsonbSchema(Fixture)("data") });
    expect(columnNamed(table, "data").getSQLType()).toBe("jsonb");
  });

  it("round trips: object in -> JSON string out -> object back", () => {
    const table = pgTable("widget", { data: jsonbSchema(Fixture)("data") });
    const column = columnNamed(table, "data");
    const value = { id: "a", count: 3 };

    const driverValue = toDriver(column, value);
    expect(driverValue).toBeTypeOf("string");
    expect(Schema.decodeSync(Json)(driverValue)).toEqual(value);

    const roundTripped = fromDriver(column, driverValue);
    expect(roundTripped).toEqual(value);
  });

  it("decodes driver output handed back already-parsed (node-pg's actual behaviour)", () => {
    const table = pgTable("widget", { data: jsonbSchema(Fixture)("data") });
    const column = columnNamed(table, "data");
    const value = { id: "b", count: 7 };

    // node-pg parses jsonb before this codec ever sees it, so `fromDriver`
    // receives the object directly, not the JSON text `toDriver` produced.
    const decoded = fromDriver(column, value);
    expect(decoded).toEqual(value);
  });

  it("decodes a raw JSON string — the branch kept for a driver that hands back text", () => {
    const table = pgTable("widget", { data: jsonbSchema(Fixture)("data") });
    const column = columnNamed(table, "data");
    const value = { id: "c", count: 9 };

    const decoded = fromDriver(column, Schema.encodeSync(Json)(value));
    expect(decoded).toEqual(value);
  });

  it("falls through to decoding the raw string when it isn't valid JSON", () => {
    const table = pgTable("widget", { data: jsonbSchema(Fixture)("data") });
    const column = columnNamed(table, "data");

    // Not valid JSON, and not a Fixture either — both the JSON.parse and the
    // schema decode fail, so this exercises the `onNone` fallback path.
    expect(() => fromDriver(column, "{not valid json")).toThrow();
  });

  it("throws on a value the schema rejects", () => {
    const table = pgTable("widget", { data: jsonbSchema(Fixture)("data") });
    const column = columnNamed(table, "data");

    expect(() => fromDriver(column, { id: "d" /* missing count */ })).toThrow();
  });

  it("throws encoding a value the schema rejects", () => {
    const table = pgTable("widget", { data: jsonbSchema(Fixture)("data") });
    const column = columnNamed(table, "data");

    expect(() => toDriver(column, { id: "e", count: "not a number" })).toThrow();
  });
});

describe("timestamps", () => {
  it("emits a NOT NULL timestamptz pair defaulting to now()", () => {
    const table = pgTable("widget", { ...timestamps() });
    Arr.forEach(["created_at", "updated_at"], (name) => {
      const column = columnNamed(table, name);
      expect(column.getSQLType()).toBe("timestamp with time zone");
      expect(column.notNull).toBe(true);
      expect(column.hasDefault).toBe(true);
    });
  });

  it("mints fresh builders each call — mutating one table's pair leaves another's untouched", () => {
    const first = timestamps();
    const second = timestamps();

    expect(first.createdAt).not.toBe(second.createdAt);
    expect(first.updatedAt).not.toBe(second.updatedAt);

    // Materialising one pair into a table must not retroactively change the
    // other pair's DDL — this is the failure mode a shared module-level
    // object would produce.
    const tableA = pgTable("a", { ...first });
    const tableB = pgTable("b", { ...second });
    expect(columnNamed(tableA, "created_at").notNull).toBe(true);
    expect(columnNamed(tableB, "created_at").notNull).toBe(true);
  });
});

describe("byteaToHex / hexToBytea", () => {
  it("round trips bytes through hex", () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 255]);
    expect(hexToBytea(byteaToHex(bytes))).toEqual(bytes);
  });

  it("renders lowercase, zero-padded hex", () => {
    expect(byteaToHex(Uint8Array.from([0, 255, 10]))).toBe("00ff0a");
  });

  it("decodes an empty string to an empty array", () => {
    expect(hexToBytea("")).toEqual(new Uint8Array());
  });

  it("throws TypeError on an odd-length hex string", () => {
    expect(() => hexToBytea("abc")).toThrow(TypeError);
  });

  it("throws TypeError on non-hex characters, where Buffer.from would silently truncate", () => {
    expect(() => hexToBytea("zz")).toThrow(TypeError);
    expect(() => hexToBytea("12gg")).toThrow(TypeError);
  });
});
