/**
 * `./ExternalIds`' table builder and constructor without a database: the
 * columns, keys and reference drizzle-kit sees, and the module-load check
 * that the table was built from `externalIdColumns()`.
 *
 * @module packages/pg/tests/ExternalIds
 */

import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/Derive";
import { getTableConfig, jsonb, pgSchema, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";
import {
  externalIdColumns,
  externalIdConstraints,
  makeExternalIdStore,
  makeExternalIdTable,
} from "../src/ExternalIds.ts";
import { makePgDatabase } from "../src/PgDatabase.ts";

const { CurrentTransaction } = makePgDatabase({ relations: {}, key: "Database" });
const node = pgTable("node", { id: uuid("id").primaryKey() });

describe("externalIdColumns / makeExternalIdTable", () => {
  it("keys by (authority, external_id), one id per authority per node", () => {
    const config = getTableConfig(
      pgTable(
        "authority_id",
        { ...externalIdColumns(node.id), baseline: jsonb("baseline") },
        externalIdConstraints("authority_id"),
      ),
    );
    expect(config.columns.map((c) => [c.name, c.notNull])).toEqual([
      ["authority", true],
      ["external_id", true],
      ["node_id", true],
      ["baseline", false],
    ]);
    expect(config.primaryKeys.map((k) => [k.getName(), k.columns.map((c) => c.name)])).toEqual([
      ["authority_id_pkey", ["authority", "external_id"]],
    ]);
    expect(config.uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)])).toEqual([
      ["authority_id_node", ["node_id", "authority"]],
    ]);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
  });

  it("defaults the name, and takes a schema", () => {
    const config = getTableConfig(makeExternalIdTable({ identity: node }));
    expect([config.name, config.schema]).toEqual(["external_id", undefined]);
    const named = getTableConfig(
      makeExternalIdTable({ identity: node, schema: pgSchema("kb"), name: "authority_id" }),
    );
    expect([named.name, named.schema]).toEqual(["authority_id", "kb"]);
  });
});

describe("makeExternalIdStore", () => {
  it("refuses a table without the columns", () => {
    expect(() =>
      makeExternalIdStore({ table: pgTable("other", { id: text("id") }), CurrentTransaction }),
    ).toThrow(DerivationError);
  });
});
