/**
 * Canary for the reference registry: a registered table resolves to the target
 * column, resolution is lazy (the registry is read when the thunk is FORCED,
 * not when it is built), and an unresolvable name pair throws
 * `DerivationError` at that point.
 *
 * @module tests/references
 */

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { getTableConfig, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { dbColumn } from "../src/index.ts";
import { DerivationError, makeDeriveColumns, type ColumnBuilders } from "../src/derive.ts";
import { makeReferenceRegistry } from "../src/references.ts";

const builders = {
  text: (c: string) => text(c),
  uuid: (c: string) => uuid(c),
} satisfies ColumnBuilders<"text" | "uuid">;

const owner = pgTable("owner", { id: uuid("id").primaryKey(), slug: text("slug") });

describe("makeReferenceRegistry", () => {
  it("resolves a registered table's column", () => {
    const registry = makeReferenceRegistry();
    registry.register(owner);
    expect(registry.resolve({ table: "owner", column: "id" })()).toBe(owner.id);
  });

  it("is lazy: resolve before register, force after", () => {
    const registry = makeReferenceRegistry();
    // Built while the target table module has not loaded — this must not throw.
    const thunk = registry.resolve({ table: "owner", column: "slug" });
    registry.register(owner);
    expect(thunk()).toBe(owner.slug);
  });

  it("throws a DerivationError only when FORCED against an unregistered table", () => {
    const registry = makeReferenceRegistry();
    const thunk = registry.resolve({ table: "absent", column: "id" });
    expect(() => thunk()).toThrow(/no FK-reference target registered for table 'absent'/);
    expect(() => thunk()).toThrow(DerivationError);
  });

  it("throws a DerivationError when the registered table has no such column", () => {
    const registry = makeReferenceRegistry();
    registry.register(owner);
    const thunk = registry.resolve({ table: "owner", column: "nope" });
    expect(() => thunk()).toThrow(/table 'owner' has no column 'nope'/);
    expect(() => thunk()).toThrow(DerivationError);
  });

  it("is idempotent: registering the same table twice keeps one entry", () => {
    const registry = makeReferenceRegistry();
    registry.register(owner);
    registry.register(owner);
    expect(registry.resolve({ table: "owner", column: "id" })()).toBe(owner.id);
  });

  it("each registry owns its own name space", () => {
    const a = makeReferenceRegistry();
    const b = makeReferenceRegistry();
    a.register(owner);
    expect(a.resolve({ table: "owner", column: "id" })()).toBe(owner.id);
    expect(() => b.resolve({ table: "owner", column: "id" })()).toThrow(DerivationError);
  });

  it("wires into the derivation as resolveReference and materialises the FK", () => {
    const registry = makeReferenceRegistry();
    registry.register(owner);
    const derive = makeDeriveColumns(builders, { resolveReference: registry.resolve });
    const columns = derive.fromFields({
      ownerId: dbColumn(Schema.String, {
        column: "owner_id",
        pg: "uuid",
        notNull: true,
        references: { table: "owner", column: "id", onDelete: "cascade" },
      }),
    });
    const config = getTableConfig(pgTable("widget", columns as never));
    expect(config.foreignKeys.length).toBe(1);
    const reference = config.foreignKeys[0].reference();
    expect(reference.foreignColumns.map((c) => c.name)).toEqual(["id"]);
    expect(config.foreignKeys[0].onDelete).toBe("cascade");
  });
});
