import { getTableName, type SQL } from "drizzle-orm";
import {
  getTableConfig,
  getViewConfig,
  integer,
  PgDialect,
  pgSchema,
  text,
  type PgTable,
  type PgView,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as R from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import type { ColumnBuilders } from "../src/Derive.ts";
import { makeTreeTables, makeTreeViews } from "../src/VersionedChain.ts";
import { bfoTree, diamondTree, flatTree, frbrTree } from "./fixtures/trees.ts";

const builders = {
  text: (c: string) => text(c),
  integer: (c: string) => integer(c),
} satisfies ColumnBuilders<"text" | "integer">;

const schema = pgSchema("ontology");
const dialect = new PgDialect();

/** A SQL fragment as one line: its text, then its parameters. */
const sqlLine = (fragment: SQL): string => {
  const { sql, params } = dialect.sqlToQuery(fragment);
  return Arr.isReadonlyArrayEmpty(params) ? sql : `${sql} -- ${params.map(String).join(", ")}`;
};

const names = (columns: ReadonlyArray<{ readonly name: string }>) =>
  columns.map((c) => c.name).join(", ");

/** One table's DDL-bearing config, as drizzle-kit reads it, one line per item. */
const tableLines = (table: PgTable): ReadonlyArray<string> => {
  const config = getTableConfig(table);
  return [
    `table ${getTableName(table)}`,
    ...Arr.map(
      config.columns,
      (c) => `  column ${c.name} ${c.getSQLType()}${c.notNull ? " not null" : ""}`,
    ),
    ...Arr.map(config.primaryKeys, (pk) => `  primary key ${pk.getName()} (${names(pk.columns)})`),
    ...Arr.map(config.foreignKeys, (fk) => {
      const ref = fk.reference();
      return `  foreign key ${fk.getName()} (${names(ref.columns)}) → ${getTableName(ref.foreignTable)} (${names(ref.foreignColumns)}) on update ${fk.onUpdate ?? "no action"} on delete ${fk.onDelete ?? "no action"}`;
    }),
    ...Arr.map(config.uniqueConstraints, (u) => `  unique ${u.name} (${names(u.columns)})`),
    ...Arr.map(config.checks, (c) => `  check ${c.name}: ${sqlLine(c.value)}`),
  ];
};

/** One view's name and SQL. */
const viewLines = (view: PgView): ReadonlyArray<string> => {
  const { name, query } = getViewConfig(view);
  return [`view ${name}`, `  ${query === undefined ? "" : sqlLine(query)}`];
};

/** The tables and views a tree derives, as `makeTreeTables` and `makeTreeViews` key them. */
interface Derived {
  readonly tables: {
    readonly root: { readonly identity: PgTable; readonly version: PgTable };
    readonly levels: Readonly<
      Record<string, { readonly stable: PgTable; readonly version: PgTable }>
    >;
    readonly facts: Readonly<Record<string, Readonly<Record<string, PgTable>>>>;
    readonly keyed: Readonly<Record<string, PgTable>>;
    readonly pointers: Readonly<Record<string, PgTable>>;
  };
  readonly views: {
    readonly leaves: Readonly<Record<string, PgView>>;
    readonly branches: Readonly<Record<string, PgView>>;
    readonly keyed: Readonly<Record<string, PgView>>;
    readonly pointers: Readonly<
      Record<
        string,
        {
          readonly leaves: Readonly<Record<string, PgView>>;
          readonly keyed: Readonly<Record<string, PgView>>;
        }
      >
    >;
  };
}

/** Every derived table's DDL and every view's SQL, in derivation order. */
const ddlOf = ({ tables, views }: Derived): string =>
  [
    ...tableLines(tables.root.identity),
    ...tableLines(tables.root.version),
    ...Arr.flatMap(R.values(tables.levels), ({ stable, version }) => [
      ...tableLines(stable),
      ...tableLines(version),
    ]),
    ...Arr.flatMap(R.values(tables.facts), (facts) => Arr.flatMap(R.values(facts), tableLines)),
    ...Arr.flatMap(R.values(tables.keyed), tableLines),
    ...Arr.flatMap(R.values(tables.pointers), tableLines),
    ...Arr.flatMap(R.values(views.leaves), viewLines),
    ...Arr.flatMap(R.values(views.branches), viewLines),
    ...Arr.flatMap(R.values(views.keyed), viewLines),
    ...Arr.flatMap(R.values(views.pointers), (pointer) => [
      ...Arr.flatMap(R.values(pointer.leaves), viewLines),
      ...Arr.flatMap(R.values(pointer.keyed), viewLines),
    ]),
    "",
  ].join("\n");

const linesWith = (lines: ReadonlyArray<string>, word: string) =>
  Arr.filter(lines, (line) => line.startsWith(`  ${word}`));

describe("tree DDL: single-parent trees", () => {
  it("emits the FRBR spine's tables and views unchanged", async () => {
    const tables = makeTreeTables(frbrTree, {
      schema,
      builders,
      levels: { agent: { refinable: true } },
      root: { pointers: ["live"] },
    });
    const views = makeTreeViews(frbrTree, tables, {
      schema,
      branches: { work: true, agent: true },
      pointers: { live: ["book", "person"] },
    });
    await expect(ddlOf({ tables, views })).toMatchFileSnapshot("./__snapshots__/tree-ddl.frbr.txt");
  });

  it("emits the BFO branches' tables and views unchanged", async () => {
    const tables = makeTreeTables(bfoTree, {
      schema,
      builders,
      levels: { occurrent: { refinable: true } },
    });
    const views = makeTreeViews(bfoTree, tables, {
      schema,
      branches: { continuant: true, material_entity: true, process: true },
    });
    await expect(ddlOf({ tables, views })).toMatchFileSnapshot("./__snapshots__/tree-ddl.bfo.txt");
  });

  it("emits the flat family's tables and views unchanged", async () => {
    const tables = makeTreeTables(flatTree, { schema, builders });
    const views = makeTreeViews(flatTree, tables, { schema, branches: { works: true } });
    await expect(ddlOf({ tables, views })).toMatchFileSnapshot("./__snapshots__/tree-ddl.flat.txt");
  });
});

describe("tree DDL: a diamond", () => {
  const tables = makeTreeTables(diamondTree, {
    schema,
    builders,
    levels: { artefact: { refinable: true } },
  });
  const views = makeTreeViews(diamondTree, tables, { schema, branches: { artefact: true } });

  it("arcs a level with two parents to both, the first under the single-parent names", () => {
    expect(tableLines(tables.levels.ebook.stable)).toEqual([
      "table ebook",
      "  column id uuid not null",
      "  column type text not null",
      "  foreign key ebook_id_printed_id_fk (id) → printed (id) on update no action on delete cascade",
      "  foreign key ebook_id_type_fk (id, type) → printed (id, type) on update cascade on delete no action",
      "  foreign key ebook_id_digital_id_fkey (id) → digital (id) on update no action on delete cascade",
      "  foreign key ebook_id_type_digital_fk (id, type) → digital (id, type) on update cascade on delete no action",
      "  unique ebook_id_type_unique (id, type)",
      `  check ebook_type_valid: "ontology"."ebook"."type" IN ($1) -- ebook`,
    ]);
    expect(linesWith(tableLines(tables.levels.ebook.version), "foreign key")).toEqual([
      "  foreign key ebook_version_id_ebook_id_fk (id) → ebook (id) on update cascade on delete cascade",
      "  foreign key ebook_version_printed_version_fk (id, version) → printed_version (id, version) on update no action on delete cascade",
      "  foreign key ebook_version_digital_version_fk (id, version) → digital_version (id, version) on update no action on delete cascade",
    ]);
    expect(linesWith(tableLines(tables.levels.digital.stable), "check")).toEqual([
      `  check digital_type_valid: "ontology"."digital"."type" IN ($1, $2) -- digital, ebook`,
    ]);
  });

  it("joins every level on the leaf's path in its view, and probes both parents in the branch arm", () => {
    const leaf = viewLines(views.leaves.ebook).join("\n");
    expect(leaf).toContain(`inner join "ontology"."printed_version"`);
    expect(leaf).toContain(`inner join "ontology"."digital_version"`);
    expect(leaf).toContain(`inner join "ontology"."artefact_version"`);
    const branch = viewLines(views.branches.artefact).join("\n");
    const ebookArm = branch.slice(
      branch.indexOf("when 'ebook' then"),
      branch.indexOf("else false"),
    );
    expect(ebookArm).toContain(`"ontology"."printed_version"`);
    expect(ebookArm).toContain(`"ontology"."digital_version"`);
    expect(ebookArm).toContain(`"ontology"."ebook_version"`);
  });

  it("emits the whole diamond's tables and views", async () => {
    await expect(ddlOf({ tables, views })).toMatchFileSnapshot(
      "./__snapshots__/tree-ddl.diamond.txt",
    );
  });
});
