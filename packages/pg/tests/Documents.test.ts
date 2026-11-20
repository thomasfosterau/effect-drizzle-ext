/**
 * `./Documents` without a database: the generated hash column drizzle-kit
 * sees, the hash schema, and the module-load check that the table was built
 * from `documentColumns()`.
 *
 * @module packages/pg/tests/Documents
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/Derive";
import { getTableConfig, pgTable, text } from "drizzle-orm/pg-core";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DocumentHash, documentColumns, makeDocumentStore } from "../src/Documents.ts";
import { makePgDatabase } from "../src/PgDatabase.ts";

const { CurrentTransaction } = makePgDatabase({ relations: {}, key: "Database" });

describe("documentColumns", () => {
  it("keys the table by the generated digest", () => {
    const config = getTableConfig(pgTable("document", documentColumns()));
    expect(config.columns.map((c) => [c.name, c.getSQLType(), c.primary, c.notNull])).toEqual([
      ["hash", "bytea", true, true],
      ["document", "jsonb", false, true],
    ]);
    expect(config.columns[0]?.generated?.type).toBe("always");
  });
});

describe("DocumentHash", () => {
  it("is 64 lowercase hex characters", () => {
    expect(Schema.is(DocumentHash)("a".repeat(64))).toBe(true);
    expect(Schema.is(DocumentHash)("A".repeat(64))).toBe(false);
    expect(Schema.is(DocumentHash)("a".repeat(63))).toBe(false);
  });
});

describe("makeDocumentStore", () => {
  it("refuses a table without the document columns", () => {
    expect(() =>
      makeDocumentStore({
        table: pgTable("other", { id: text("id") }),
        document: Schema.String,
        CurrentTransaction,
      }),
    ).toThrow(DerivationError);
  });
});
