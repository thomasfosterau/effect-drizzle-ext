/**
 * @copyright Thomas Foster
 *
 * Column helpers for Drizzle table definitions this library owns outright:
 * a generic JSONB codec bridging any Effect Schema to `jsonb`, `tsvector`
 * and `bytea` custom types, the `created_at` / `updated_at` timestamp pair
 * every plain table carries, and the hex codec for rendering / parsing
 * `bytea` values without the Node `Buffer` global.
 *
 * @module columns
 */
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { customType, timestamp } from "drizzle-orm/pg-core";
import type {
  ConvertCustomConfig,
  PgCustomColumnBuilder,
  PgTimestampBuilder,
  SetHasDefault,
  SetNotNull,
} from "drizzle-orm/pg-core";

/**
 * The JSON text boundary, expressed as a schema rather than the `JSON`
 * global: encoding runs `JSON.stringify` and decoding runs a total
 * `JSON.parse` whose `None` covers a malformed string.
 */
const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJsonText = Schema.encodeSync(JsonText);
const decodeJsonText = Schema.decodeUnknownOption(JsonText);

/**
 * Builds a typed JSONB Drizzle custom type backed by an Effect Schema.
 *
 * Values are stored as PostgreSQL `jsonb`. The schema validates on both
 * read (`fromDriver`) and write (`toDriver`): writing encodes through the
 * schema and then through {@link JsonText}; reading decodes unknown driver
 * output straight through the schema.
 *
 * The driver this library ships a Postgres binding for (node-pg, via
 * `@effect/sql-pg`) already parses `jsonb` columns before `fromDriver` sees
 * them, so the `typeof value === "string"` branch below is dead under that
 * driver — it exists for a driver that hands back raw JSON text instead,
 * and is exercised directly by this module's tests.
 *
 * Nullable columns are handled transparently — `null` values pass through
 * Drizzle without reaching this codec, so `.nullable()` is not required on
 * `schema`.
 *
 * `schema` is bound to `Schema.Codec<unknown, unknown, never, never>` rather
 * than the wider `Schema.Top`: `toDriver` / `fromDriver` are synchronous
 * Drizzle hooks with no Effect context to satisfy a requirement from, so a
 * schema this codec accepts must already need no services to decode or
 * encode.
 */
export const jsonbSchema =
  <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) =>
  (
    name: string,
  ): PgCustomColumnBuilder<ConvertCustomConfig<{ data: S["Type"]; driverData: unknown }>> => {
    const encode = Schema.encodeSync(schema);
    const decode = Schema.decodeUnknownSync(schema);
    return customType<{ data: S["Type"]; driverData: unknown }>({
      dataType() {
        return "jsonb";
      },
      toDriver(value) {
        return encodeJsonText(encode(value));
      },
      fromDriver(value) {
        if (!Predicate.isString(value)) return decode(value);
        return Option.match(decodeJsonText(value), {
          onNone: () => decode(value),
          onSome: (parsed) => decode(parsed),
        });
      },
    })(name);
  };

/**
 * Custom column type for PostgreSQL `tsvector`.
 *
 * Used for generated full-text search columns. The value is opaque to the
 * consuming application — queries use `sql` template literals for matching.
 */
export const tsvector = (
  name: string,
): PgCustomColumnBuilder<ConvertCustomConfig<{ data: string; driverData: string }>> =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return "tsvector";
    },
  })(name);

/**
 * Custom column type for PostgreSQL `bytea` (binary data).
 *
 * Typed `Uint8Array` rather than `Buffer` — see {@link byteaToHex} for why
 * the Node global is off-limits here. Both directions are honest about the
 * runtime: node-pg returns a `Buffer` for `bytea` (a `Uint8Array` subclass,
 * so reads widen safely), and on the write side `pg`'s `prepareValue`
 * converts any `ArrayBuffer` view to a `Buffer` before binding the
 * parameter, so a plain `Uint8Array` binds identically to one.
 */
export const bytea = (
  name: string,
): PgCustomColumnBuilder<ConvertCustomConfig<{ data: Uint8Array; driverData: Uint8Array }>> =>
  customType<{ data: Uint8Array; driverData: Uint8Array }>({
    dataType() {
      return "bytea";
    },
  })(name);

/**
 * A fresh `created_at` / `updated_at` pair: `timestamptz`, `NOT NULL`,
 * defaulting to `now()`.
 *
 * A factory, never a shared object: Drizzle column builders are
 * **mutable** — `.notNull()` and `.defaultNow()` mutate and return the same
 * builder instance. A module-level constant reused across tables would
 * therefore hand every table the same two builders, and whichever table
 * was declared last would win any later refinement. Calling `timestamps()`
 * per table mints a fresh pair.
 *
 * `updated_at` defaults rather than auto-updates — nothing in Postgres
 * bumps it, the write path does.
 *
 * Spread rather than a base table: Drizzle records a table's columns in
 * declaration order, and that order is what a consumer's `db:generate`
 * emits as the `CREATE TABLE` column order. Spreading at the position two
 * hand-written lines occupied keeps generated SQL byte-identical, so
 * adopting this helper does not move a baseline migration.
 */
export const timestamps = (): {
  readonly createdAt: SetHasDefault<SetNotNull<PgTimestampBuilder>>;
  readonly updatedAt: SetHasDefault<SetNotNull<PgTimestampBuilder>>;
} => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Renders a `bytea` value (typically a content hash) as its lowercase hex
 * string.
 *
 * Written against `Uint8Array` rather than `Buffer.prototype.toString("hex")`
 * on purpose: a runtime that declares the Node `Buffer` global alongside
 * `@types/node` (Cloudflare Workers' `nodejs_compat` types are one example)
 * can strip the Node-only methods off the global `Buffer` interface, or
 * degrade the `Buffer` *value* to `any`, so every `Buffer.*` call goes
 * unchecked with no signal at all. `Uint8Array` is what a `bytea` row value
 * structurally is on every runtime, so this encodes identically everywhere
 * without depending on that global.
 */
export const byteaToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Decodes a hex string into the `Uint8Array` a `bytea` column binds — the
 * inverse of {@link byteaToHex}, replacing `Buffer.from(hex, "hex")`.
 *
 * Strict where `Buffer.from` is silent: `Buffer.from` decodes the leading
 * valid pairs and drops the rest, so a malformed hash quietly becomes a
 * short-but-plausible key that matches no row. This throws instead — a
 * caller that takes a hash from outside the trust boundary is expected to
 * validate its shape before calling this, and gets a loud failure instead
 * of a silently truncated key when it doesn't.
 *
 * @throws TypeError if `hex` is not an even-length run of hex digits.
 */
export const hexToBytea = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError(`Expected an even-length hex string, received ${encodeJsonText(hex)}`);
  }
  return Uint8Array.from({ length: hex.length / 2 }, (_unused, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
};
