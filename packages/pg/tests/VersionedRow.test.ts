/**
 * `./VersionedRow`'s column and constructor without a database: the
 * `version` column drizzle-kit sees, and the module-load check for it.
 *
 * @module packages/pg/tests/VersionedRow
 */

import { getTableConfig, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/Derive";
import { describe, expect, it } from "vite-plus/test";
import { makePgDatabase } from "../src/PgDatabase.ts";
import { makeVersionedRow, versionColumn } from "../src/VersionedRow.ts";

const { CurrentTransaction } = makePgDatabase({ relations: {}, key: "Database" });

describe("versionColumn", () => {
  it("is a NOT NULL bigint defaulting to 0", () => {
    const config = getTableConfig(pgTable("account", { id: uuid("id"), ...versionColumn() }));
    const version = config.columns.find((column) => column.name === "version");
    expect([version?.getSQLType(), version?.notNull, version?.default]).toEqual([
      "bigint",
      true,
      0n,
    ]);
  });
});

describe("makeVersionedRow", () => {
  it("throws DerivationError at module load for a table without a version column", () => {
    const table = pgTable("account", { id: uuid("id").primaryKey(), name: text("name") });
    expect(() => makeVersionedRow({ table, CurrentTransaction })).toThrow(DerivationError);
  });
});
