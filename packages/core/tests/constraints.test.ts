/**
 * Canary for the table-level constraint helpers: `enumCheck` renders a literal
 * `IN (...)` CHECK, and `makeDiscriminatorConstraints` emits the three
 * constraints that thread a `type` discriminator up a hierarchy — including
 * `CHECK (false)` for a childless level, `ON UPDATE CASCADE` for a refinable
 * branch, and the custom name templates.
 *
 * No database: the constraints are materialised into a real `pgTable` and
 * inspected through `getTableConfig` / `PgDialect`.
 *
 * @module tests/constraints
 */

import { describe, expect, it } from "vite-plus/test";
import { getTableConfig, PgDialect, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { enumCheck, makeDiscriminatorConstraints } from "../src/constraints.ts";

const dialect = new PgDialect();

const parent = pgTable("parent", { id: uuid("id").primaryKey(), type: text("type").notNull() });

/** The subtree leaves of a small three-level ontology, plus one childless marker. */
type Level = "root" | "branch" | "leaf" | "marker";
const leaves = (level: Level): ReadonlyArray<string> =>
  ({
    root: ["article", "note"],
    branch: ["article", "note"],
    leaf: ["article"],
    marker: [],
  })[level];

describe("enumCheck", () => {
  it("renders the values as literal SQL text, not bind parameters", () => {
    const table = pgTable("post", { status: text("status") }, (t) => [
      enumCheck("post_status_valid", t.status, ["draft", "published"]),
    ]);
    const checks = getTableConfig(table).checks;
    expect(checks.map((c) => c.name)).toEqual(["post_status_valid"]);
    const query = dialect.sqlToQuery(checks[0].value);
    expect(query.sql).toBe(`"post"."status" IN ('draft', 'published')`);
    expect(query.params).toEqual([]);
  });

  it("emits an empty IN list unchanged for an empty vocabulary", () => {
    const table = pgTable("empty", { status: text("status") }, (t) => [
      enumCheck("empty_status_valid", t.status, []),
    ]);
    expect(dialect.sqlToQuery(getTableConfig(table).checks[0].value).sql).toBe(
      `"empty"."status" IN ()`,
    );
  });
});

describe("makeDiscriminatorConstraints", () => {
  const toolkit = makeDiscriminatorConstraints<Level>({ leaves });

  /**
   * Materialise a level's constraints onto a real stable table. `refinable` is
   * `?: boolean | undefined` for the same reason the source spells it that way:
   * it is config handed to a Drizzle-emitting factory.
   */
  /* oxlint-disable-next-line effect/prefer-option-over-null -- mirrors the config type under test */
  const tableFor = (level: Level, options?: { readonly refinable?: boolean | undefined }) =>
    getTableConfig(
      pgTable("child", { id: uuid("id").primaryKey(), type: text("type").notNull() }, (t) =>
        toolkit.typeConstraints(level, t, parent, options),
      ),
    );

  it("emits UNIQUE(id, type) with the default name", () => {
    const config = tableFor("branch");
    expect(config.uniqueConstraints.map((u) => u.name)).toEqual(["branch_id_type_unique"]);
    expect(config.uniqueConstraints[0].columns.map((c) => c.name)).toEqual(["id", "type"]);
  });

  it("emits the composite (id, type) -> parent (id, type) foreign key", () => {
    const config = tableFor("branch");
    expect(config.foreignKeys.length).toBe(1);
    const reference = config.foreignKeys[0].reference();
    expect(reference.name).toBe("branch_id_type_fk");
    expect(reference.columns.map((c) => c.name)).toEqual(["id", "type"]);
    expect(reference.foreignColumns.map((c) => c.name)).toEqual(["id", "type"]);
    // Drizzle materialises an unspecified referential action as "no action".
    expect(config.foreignKeys[0].onUpdate).toBe("no action");
  });

  it("gives the composite FK ON UPDATE CASCADE when the branch is refinable", () => {
    expect(tableFor("branch", { refinable: true }).foreignKeys[0].onUpdate).toBe("cascade");
  });

  it("narrows type to the level's subtree leaves, parameterised", () => {
    const checks = tableFor("branch").checks;
    expect(checks.map((c) => c.name)).toEqual(["branch_type_valid"]);
    const query = dialect.sqlToQuery(checks[0].value);
    expect(query.sql).toBe(`"child"."type" IN ($1, $2)`);
    expect(query.params).toEqual(["article", "note"]);
  });

  it("pins a leaf level to its own single type", () => {
    const query = dialect.sqlToQuery(tableFor("leaf").checks[0].value);
    expect(query.sql).toBe(`"child"."type" IN ($1)`);
    expect(query.params).toEqual(["article"]);
  });

  it("emits CHECK (false) for a childless level rather than an empty IN list", () => {
    const checks = tableFor("marker").checks;
    expect(checks.map((c) => c.name)).toEqual(["marker_type_valid"]);
    expect(dialect.sqlToQuery(checks[0].value).sql).toBe("false");
  });

  it("typeUnique takes a plain level name, for a root above the ontology", () => {
    const config = getTableConfig(
      pgTable("node", { id: uuid("id").primaryKey(), type: text("type").notNull() }, (t) => [
        toolkit.typeUnique("node", t),
      ]),
    );
    expect(config.uniqueConstraints.map((u) => u.name)).toEqual(["node_id_type_unique"]);
    expect(config.checks).toEqual([]);
    expect(config.foreignKeys).toEqual([]);
  });

  it("typeConstraints emits all three, in order", () => {
    const config = tableFor("branch");
    expect(config.uniqueConstraints.length).toBe(1);
    expect(config.foreignKeys.length).toBe(1);
    expect(config.checks.length).toBe(1);
  });

  it("honours custom name templates", () => {
    const custom = makeDiscriminatorConstraints<Level>({
      leaves,
      names: {
        unique: (level) => `uq_${level}`,
        parentFk: (level) => `fk_${level}`,
        check: (level) => `ck_${level}`,
      },
    });
    const config = getTableConfig(
      pgTable("child", { id: uuid("id").primaryKey(), type: text("type").notNull() }, (t) =>
        custom.typeConstraints("branch", t, parent),
      ),
    );
    expect(config.uniqueConstraints[0].name).toBe("uq_branch");
    expect(config.foreignKeys[0].reference().name).toBe("fk_branch");
    expect(config.checks[0].name).toBe("ck_branch");
  });

  it("falls back to the default template for a name the options omit", () => {
    const partial = makeDiscriminatorConstraints<Level>({
      leaves,
      names: { check: (level) => `ck_${level}` },
    });
    const config = getTableConfig(
      pgTable("child", { id: uuid("id").primaryKey(), type: text("type").notNull() }, (t) =>
        partial.typeConstraints("branch", t, parent),
      ),
    );
    expect(config.uniqueConstraints[0].name).toBe("branch_id_type_unique");
    expect(config.foreignKeys[0].reference().name).toBe("branch_id_type_fk");
    expect(config.checks[0].name).toBe("ck_branch");
  });

  it("typeParentFk declares no referential action unless asked for cascade", () => {
    const config = getTableConfig(
      pgTable("child", { id: uuid("id").primaryKey(), type: text("type").notNull() }, (t) => [
        toolkit.typeParentFk("branch", t, parent),
      ]),
    );
    expect(config.foreignKeys[0].onUpdate).toBe("no action");
    expect(config.foreignKeys[0].onDelete).toBe("no action");
  });
});
