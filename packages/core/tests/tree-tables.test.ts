import { getTableName } from "drizzle-orm";
import {
  getTableConfig,
  index,
  integer,
  PgDialect,
  pgSchema,
  text,
  uuid,
  type ExtraConfigColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type { ColumnBuilders } from "../src/derive.ts";
import { makeTreeTables } from "../src/versioned-chain.ts";
import { bfoTree, flatTree, frbrTree } from "./fixtures/trees.ts";

const builders = {
  text: (c: string) => text(c),
  integer: (c: string) => integer(c),
} satisfies ColumnBuilders<"text" | "integer">;

const schema = pgSchema("ontology");
const dialect = new PgDialect();

const checksOf = (table: PgTable) =>
  Arr.map(getTableConfig(table).checks, (c) => [c.name, dialect.sqlToQuery(c.value)] as const);
const fkNamesOf = (table: PgTable) =>
  Arr.map(getTableConfig(table).foreignKeys, (fk) => fk.getName());
const columnNamesOf = (table: PgTable) => Arr.map(getTableConfig(table).columns, (c) => c.name);

/** Every level's version columns and stable FK names, in declaration order. */
const derivedDdlOf = (tree: typeof frbrTree) => {
  const { levels } = makeTreeTables(tree, { schema, builders });
  return Arr.map(tree.names, (name) => [
    columnNamesOf(levels[name].version),
    fkNamesOf(levels[name].stable),
  ]);
};

describe("makeTreeTables: the root", () => {
  const { root } = makeTreeTables(frbrTree, {
    schema,
    builders,
    root: {
      identityColumns: { slug: text("slug") },
      versionColumns: { proposedBy: uuid("proposed_by") },
    },
  });

  it("derives the identity table with its injected columns and UNIQUE (id, type)", () => {
    expect(getTableName(root.identity)).toBe("node");
    expect(columnNamesOf(root.identity)).toEqual(["id", "type", "slug"]);
    expect(Arr.map(getTableConfig(root.identity).uniqueConstraints, (u) => u.name)).toEqual([
      "node_id_type_unique",
    ]);
  });

  it("derives the version table: (id, version) key, the action CHECK, timestamp and actor", () => {
    expect(getTableName(root.version)).toBe("node_version");
    expect(columnNamesOf(root.version)).toEqual([
      "id",
      "version",
      "action",
      "timestamp",
      "actor",
      "proposed_by",
    ]);
    expect(getTableConfig(root.version).primaryKeys[0]?.getName()).toBe("node_version_pkey");
    expect(checksOf(root.version)).toEqual([
      [
        "node_version_action_valid",
        { sql: `"ontology"."node_version"."action" IN ('create', 'update', 'delete')`, params: [] },
      ],
    ]);
  });

  it("takes injected table names and actor column", () => {
    const tables = makeTreeTables(frbrTree, {
      schema,
      builders,
      root: { identity: "entity", actorColumn: "author_id" },
    });
    expect(getTableName(tables.root.version)).toBe("entity_version");
    expect(columnNamesOf(tables.root.version)).toContain("author_id");
  });
});

describe("makeTreeTables: the levels", () => {
  const tables = makeTreeTables(bfoTree, { schema, builders });

  it("derives a stable + version pair per level, in the canonical names", () => {
    expect(getTableName(tables.levels.material_entity.stable)).toBe("material_entity");
    expect(getTableName(tables.levels.material_entity.version)).toBe("material_entity_version");
  });

  it("arcs the discriminator up every level, the CHECK narrowing to the subtree's leaves", () => {
    const stable = tables.levels.material_entity.stable;
    expect(Arr.map(getTableConfig(stable).uniqueConstraints, (u) => u.name)).toEqual([
      "material_entity_id_type_unique",
    ]);
    expect(fkNamesOf(stable)).toContain("material_entity_id_type_fk");
    expect(checksOf(stable)).toEqual([
      [
        "material_entity_type_valid",
        { sql: `"ontology"."material_entity"."type" IN ($1, $2)`, params: ["plant", "bed"] },
      ],
    ]);
    expect(checksOf(tables.levels.continuant.stable)[0]?.[1].params).toEqual([
      "plant",
      "bed",
      "document",
    ]);
    expect(checksOf(tables.levels.plant.stable)[0]?.[1].params).toEqual(["plant"]);
  });

  it("references the parent's version (id, version), or the root's for a branch root", () => {
    expect(fkNamesOf(tables.levels.plant.version)).toContain(
      "plant_version_material_entity_version_fk",
    );
    expect(fkNamesOf(tables.levels.continuant.version)).toContain(
      "continuant_version_node_version_fk",
    );
  });

  it("puts level columns on the level's own version table and leaf columns on the leaf's", () => {
    expect(columnNamesOf(tables.levels.continuant.version)).toEqual(["id", "version", "label"]);
    expect(columnNamesOf(tables.levels.material_entity.version)).toEqual(["id", "version", "mass"]);
    expect(columnNamesOf(tables.levels.plant.version)).toEqual(["id", "version", "species"]);
    expect(columnNamesOf(tables.levels.independent_continuant.version)).toEqual(["id", "version"]);
  });

  it("carries no action column below the root", () => {
    Arr.forEach(bfoTree.names, (name) => {
      expect(columnNamesOf(tables.levels[name].version)).not.toContain("action");
    });
  });

  it("types every table from the tree", () => {
    type Plant = typeof tables.levels.plant.version.$inferSelect;
    expectTypeOf<keyof Plant>().toEqualTypeOf<"id" | "version" | "species">();
    expectTypeOf<Plant["version"]>().toEqualTypeOf<bigint>();
    expectTypeOf<Plant["species"]>().toBeNullable();
    type Continuant = typeof tables.levels.continuant.version.$inferSelect;
    expectTypeOf<Continuant["label"]>().toEqualTypeOf<string>();
    expectTypeOf<typeof tables.root.version.$inferSelect.action>().toEqualTypeOf<string>();
  });
});

describe("makeTreeTables: fact-scoped levels, resource leaves and hooks", () => {
  it("splits a fact-scoped level into a spine and one fact table per column", () => {
    const { levels, facts } = makeTreeTables(frbrTree, { schema, builders });
    expect(columnNamesOf(levels.manifestation.version)).toEqual(["id", "version"]);
    expect(getTableName(facts.manifestation.isbn)).toBe("manifestation_isbn");
    expect(columnNamesOf(facts.manifestation.isbn)).toEqual(["id", "version", "isbn"]);
    expect(getTableConfig(facts.manifestation.isbn).primaryKeys[0]?.getName()).toBe(
      "manifestation_isbn_pkey",
    );
    const [fk] = getTableConfig(facts.manifestation.isbn).foreignKeys;
    expect(fk?.getName()).toBe("manifestation_isbn_manifestation_version_fk");
    expect(fk?.onDelete).toBe("cascade");
    expect(facts.work).toEqual({});
    type Format = typeof facts.manifestation.format.$inferSelect;
    expectTypeOf<keyof Format>().toEqualTypeOf<"id" | "version" | "format">();
    expectTypeOf<Format["format"]>().toBeNullable();
  });

  it("derives a resource leaf's columns from its attributes", () => {
    const { levels } = makeTreeTables(flatTree, { schema, builders });
    expect(columnNamesOf(levels.novel.version)).toEqual(["id", "version", "word_count"]);
    type Novel = typeof levels.novel.version.$inferSelect;
    expectTypeOf<NonNullable<Novel["wordCount"]>>().toEqualTypeOf<number>();
    expectTypeOf<Novel["wordCount"]>().toBeNullable();
  });

  it("adds hook columns and constraints, and makes a refinable arc cascade", () => {
    const { levels } = makeTreeTables(frbrTree, {
      schema,
      builders,
      levels: {
        book: {
          columns: { publisherId: uuid("publisher_id") },
          extraConstraints: (table: Record<string, ExtraConfigColumn>) =>
            Arr.map(Arr.filter([table.publisherId], P.isNotUndefined), (column) =>
              index("book_version_publisher_idx").on(column),
            ),
        },
        agent: { refinable: true },
      },
    });
    expect(columnNamesOf(levels.book.version)).toEqual(["id", "version", "pages", "publisher_id"]);
    expect(Arr.map(getTableConfig(levels.book.version).indexes, (i) => i.config.name)).toEqual([
      "book_version_publisher_idx",
    ]);
    expectTypeOf<
      NonNullable<typeof levels.book.version.$inferSelect.publisherId>
    >().toEqualTypeOf<string>();
    const arc = Arr.findFirst(
      getTableConfig(levels.agent.stable).foreignKeys,
      (fk) => fk.getName() === "agent_id_type_fk",
    );
    expect(Option.map(arc, (fk) => fk.onUpdate)).toStrictEqual(Option.some("cascade"));
    const below = Arr.findFirst(
      getTableConfig(levels.person.stable).foreignKeys,
      (fk) => fk.getName() === "person_id_type_fk",
    );
    expect(Option.map(below, (fk) => fk.onUpdate)).toStrictEqual(Option.some("cascade"));
    const elsewhere = Arr.findFirst(
      getTableConfig(levels.book.stable).foreignKeys,
      (fk) => fk.getName() === "book_id_type_fk",
    );
    expect(Option.map(elsewhere, (fk) => fk.onUpdate)).not.toStrictEqual(Option.some("cascade"));
  });

  it("emits the same tables, in the same order, for the same tree", () => {
    expect(derivedDdlOf(frbrTree)).toEqual(derivedDdlOf(frbrTree));
  });
});

describe("makeTreeTables: a column key two sources share (effect-drizzle-ext#169)", () => {
  it("throws for a level hook column shadowing a tree column", () => {
    expect(() =>
      makeTreeTables(frbrTree, {
        schema,
        builders,
        levels: { book: { columns: { pages: text("page_count") } } },
      }),
    ).toThrow(
      /table "book" gets "pages" from both level "book"'s tree columns and levels\.book\.columns/,
    );
  });

  it("throws for a level hook column shadowing the chain's id or version", () => {
    expect(() =>
      makeTreeTables(frbrTree, {
        schema,
        builders,
        levels: { work: { columns: { version: text("v") } } },
      }),
    ).toThrow(/gets "version" from both level "work"'s tree columns and levels\.work\.columns/);
  });

  it("throws for an identity or version extra shadowing a fixed root column", () => {
    expect(() =>
      makeTreeTables(frbrTree, {
        schema,
        builders,
        root: { identityColumns: { type: text("t") } },
      }),
    ).toThrow(
      /table "node" gets "type" from both the identity table's own columns and root\.identityColumns/,
    );
    expect(() =>
      makeTreeTables(frbrTree, {
        schema,
        builders,
        root: { versionColumns: { timestamp: text("ts") } },
      }),
    ).toThrow(
      /gets "timestamp" from both the root version table's own columns and root\.versionColumns/,
    );
  });

  it("passes for extras under fresh keys", () => {
    const { root, levels } = makeTreeTables(frbrTree, {
      schema,
      builders,
      root: { identityColumns: { slug: text("slug") } },
      levels: { book: { columns: { publisherId: uuid("publisher_id") } } },
    });
    expect(columnNamesOf(root.identity)).toEqual(["id", "type", "slug"]);
    expect(columnNamesOf(levels.book.version)).toEqual(["id", "version", "pages", "publisher_id"]);
  });
});
