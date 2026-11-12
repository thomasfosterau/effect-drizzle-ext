/**
 * The branch views `makeTreeViews` derives, as one SELECT driven from the
 * branch level's own version table instead of a `UNION ALL` of per-leaf arms
 * (effect-drizzle-ext#200), proven against PostgreSQL.
 *
 * - **Equivalence.** Over mixed histories (multi-version nodes, deleted
 *   heads, a head that skipped its leaf, a head that skipped the marker
 *   between the branch and its leaf), every fixture branch view (`work`,
 *   `collection`, `series`) returns exactly the rows, columns and column types
 *   its previous definition did. The oracle is that definition: each view's
 *   last `CREATE VIEW` in the fixture chain before the single-driver
 *   migration, read from the committed migrations. Branch views have no
 *   as-of form (`asOf` reads a leaf), so the head is the only point.
 * - **Fail closed.** A head with the branch row but no leaf row, a head
 *   whose marker below the branch is missing, and a node whose `type` names a
 *   leaf with no row at the head while another leaf's row is there (a kept old
 *   row) all yield no row.
 * - **Projection.** `collection`'s per-leaf `label` (a `CASE` on `type`)
 *   equals each leaf view's own `label`, row for row.
 * - **Plans.** A generated twelve-leaf branch, its leaves under two marker
 *   levels, pages through an index on the branch level with no Sort and no
 *   aggregate, and reads one node by id without a sequential scan of the root
 *   version table.
 *
 * @module packages/pg/tests/integration/tree-branch-views
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import { makeTreeTables, makeTreeViews } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { getTableName, sql, type SQL } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { integrationDatabaseLayer } from "./database-url.ts";
import { aggregates, viewOracle, viewsBefore } from "./view-oracle.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;
const { difference, execAll, explain } = viewOracle(database);

const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction } = makeTestTransaction(database);

/** The migration that replaced each branch view's `UNION ALL` with one driver. */
const SINGLE_DRIVER_MIGRATION = "20261112164138_branch-view-single-driver";

/** Each fixture view's definition before {@link SINGLE_DRIVER_MIGRATION}. */
let unionViews: Readonly<Record<string, string>> = {};

beforeAll(async () => {
  unionViews = await viewsBefore(SINGLE_DRIVER_MIGRATION);
});

afterAll(() => runtime.dispose());

/** A branch view's `UNION ALL` definition; empty for one the chain never defined. */
const unionView = (name: string): string => Option.getOrElse(R.get(unionViews, name), () => "");

/** One row of a raw query here: every column these specs read is a non-null scalar. */
type Row = Readonly<Record<string, string | number>>;

/** The rows one query returns, as plain records. */
const rowsOf = Effect.fn("branchViews.rowsOf")(function* (query: SQL) {
  const tx = yield* CurrentTransaction;
  return (yield* tx.execute<Row>(query)).rows;
});

/** One integer a query returns as `n`. */
const countOf = Effect.fn("branchViews.countOf")(function* (query: string) {
  const [row] = yield* rowsOf(sql.raw(`select count(*)::int as n from (${query}) q`));
  return Number(row?.["n"]);
});

/** `n`th id of this file's fixed nodes (`…-8000-0000000004nn`), clear of the other specs'. */
const idOf = (n: number) => `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`;

const W1 = idOf(1); // book, three versions
const W2 = idOf(2); // book, deleted head
const W3 = idOf(3); // essay, two versions
const W4 = idOf(4); // book, v1 has the work row but no book row (fails closed)
const C1 = idOf(5); // volume, two versions
const C2 = idOf(6); // supplement, deleted head
const C3 = idOf(7); // pamphlet, two versions
const C4 = idOf(8); // volume, v1 has its leaf row but no series row (fails closed)
const C5 = idOf(9); // supplement, v1 has the series row but no leaf row (fails closed)
const C6 = idOf(10); // volume, no label
const STALE = idOf(11); // type says book; only an essay row at the head

/** Version `v`'s timestamp: the first of month `v + 1` of 2026. */
const at = (v: number) => `2026-${String(v + 1).padStart(2, "0")}-01T00:00:00Z`;

const node = (id: string, type: string, stable: ReadonlyArray<string>) => [
  `INSERT INTO ontology.node (id, type) VALUES ('${id}', '${type}')`,
  ...Arr.map(
    stable,
    (table) => `INSERT INTO ontology.${table} (id, type) VALUES ('${id}', '${type}')`,
  ),
];

const root = (id: string, v: number, action: string) =>
  `INSERT INTO ontology.node_version (id, version, action, timestamp) VALUES ('${id}', ${v}, '${action}', '${at(v)}')`;

const row = (table: string, id: string, v: number, columns = "", values = "") =>
  `INSERT INTO ontology.${table} (id, version${columns ? `, ${columns}` : ""}) VALUES ('${id}', ${v}${values ? `, ${values}` : ""})`;

/** A full work-leaf version: the root, the work spine and the leaf. */
const workAt = (id: string, leaf: string, v: number, action: string) => [
  root(id, v, action),
  row("work_version", id, v, "title", `'${leaf}${v}'`),
  row(
    `${leaf}_version`,
    id,
    v,
    leaf === "book" ? "pages" : "",
    leaf === "book" ? `${100 + v}` : "",
  ),
];

/** A full collection-leaf version: the root, the collection spine, `series` when on the path, the leaf. */
const collectionAt = (id: string, leaf: string, v: number, action: string, label = `'l${v}'`) => [
  root(id, v, action),
  row("collection_version", id, v, "name", `'${leaf}${v}'`),
  ...(leaf === "pamphlet" ? [] : [row("series_version", id, v, "cadence", `'c${v}'`)]),
  row(`${leaf}_version`, id, v, "label", label),
];

const seriesLeaf = (leaf: string) => ["collection", "series", leaf];

/** Writes the fixture's `(id, type)` arcs forbid, with foreign-key triggers off for them. */
const unchecked = (statements: ReadonlyArray<string>) => [
  `SET LOCAL session_replication_role = replica`,
  ...statements,
  `SET LOCAL session_replication_role = origin`,
];

/** The mixed histories every check reads. */
const seedHistories = execAll([
  ...node(W1, "book", ["work", "book"]),
  ...workAt(W1, "book", 0, "create"),
  ...workAt(W1, "book", 1, "update"),
  ...workAt(W1, "book", 2, "update"),
  ...node(W2, "book", ["work", "book"]),
  ...workAt(W2, "book", 0, "create"),
  ...workAt(W2, "book", 1, "delete"),
  ...node(W3, "essay", ["work", "essay"]),
  ...workAt(W3, "essay", 0, "create"),
  ...workAt(W3, "essay", 1, "update"),
  ...node(W4, "book", ["work", "book"]),
  ...workAt(W4, "book", 0, "create"),
  root(W4, 1, "update"),
  row("work_version", W4, 1, "title", `'book1'`),
  ...node(C1, "volume", seriesLeaf("volume")),
  ...collectionAt(C1, "volume", 0, "create"),
  ...collectionAt(C1, "volume", 1, "update"),
  ...node(C2, "supplement", seriesLeaf("supplement")),
  ...collectionAt(C2, "supplement", 0, "create"),
  ...collectionAt(C2, "supplement", 1, "delete"),
  ...node(C3, "pamphlet", ["collection", "pamphlet"]),
  ...collectionAt(C3, "pamphlet", 0, "create"),
  ...collectionAt(C3, "pamphlet", 1, "update"),
  ...node(C4, "volume", seriesLeaf("volume")),
  ...collectionAt(C4, "volume", 0, "create"),
  root(C4, 1, "update"),
  row("collection_version", C4, 1, "name", `'volume1'`),
  // The leaf row references the series row it skips, so it goes in unchecked.
  ...unchecked([row("volume_version", C4, 1, "label", `'l1'`)]),
  ...node(C5, "supplement", seriesLeaf("supplement")),
  ...collectionAt(C5, "supplement", 0, "create"),
  root(C5, 1, "update"),
  row("collection_version", C5, 1, "name", `'supplement1'`),
  row("series_version", C5, 1, "cadence", `'c1'`),
  ...node(C6, "volume", seriesLeaf("volume")),
  ...collectionAt(C6, "volume", 0, "create", "NULL"),
]);

/**
 * A node whose `type` says book, with a book stable row but no book row, and
 * an essay stable and version row kept at the head: the shape a move to
 * another leaf leaves when the old leaf's rows survive. The arcs forbid the
 * essay stable row, so it goes in unchecked.
 */
const seedStale = execAll([
  ...node(STALE, "book", ["work", "book"]),
  ...unchecked([`INSERT INTO ontology.essay (id, type) VALUES ('${STALE}', 'essay')`]),
  root(STALE, 0, "create"),
  row("work_version", STALE, 0, "title", `'stale'`),
  row("essay_version", STALE, 0),
]);

const BRANCH_VIEWS = ["work_view", "collection_view", "series_view"] as const;

/** `view`'s `(version, action, type)` rows for `id`, ordered. */
const headsOf = Effect.fn("branchViews.headsOf")(function* (from: string, id: string) {
  const rows = yield* rowsOf(
    sql.raw(
      `SELECT version::text AS version, action, type FROM ${from} v WHERE id = '${id}' ORDER BY version`,
    ),
  );
  return Arr.map(rows, (r) => [Number(r["version"]), r["action"], r["type"]] as const);
});

/** A view's columns as PostgreSQL sees them: name and type, in order. */
const columnsOf = Effect.fn("branchViews.columnsOf")(function* (schema: string, view: string) {
  const rows = yield* rowsOf(
    sql.raw(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${view}' ORDER BY ordinal_position`,
    ),
  );
  return Arr.map(rows, (r) => `${String(r["column_name"])} ${String(r["data_type"])}`);
});

describe("branch views: one driver returns exactly the UNION ALL form's rows", () => {
  it("for every fixture branch view at the head, with the same columns in the same order", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        const results = yield* Effect.forEach(
          BRANCH_VIEWS,
          (view) =>
            Effect.gen(function* () {
              const oracle = unionView(view);
              const definition = yield* rowsOf(
                sql.raw(`SELECT pg_get_viewdef('ontology.${view}') AS d`),
              );
              // The oracle as a view of its own, for its column names and types.
              yield* execAll([`CREATE TEMPORARY VIEW ${view}_oracle AS ${oracle}`]);
              const [oracleSchema] = yield* rowsOf(
                sql.raw(`SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()`),
              );
              return {
                view,
                oracle,
                definition: String(definition[0]?.["d"]),
                columns: yield* columnsOf("ontology", view),
                oracleColumns: yield* columnsOf(
                  String(oracleSchema?.["nspname"]),
                  `${view}_oracle`,
                ),
                ...(yield* difference(sql.raw(`select * from ontology.${view}`), oracle)),
              };
            }),
          { concurrency: 1 },
        );
        Arr.forEach(results, (result) => {
          const { view, rows, missing, extra } = result;
          // The oracle really is the union of per-leaf arms; the view is not.
          expect(result.oracle, `${view}: the oracle`).toContain(") union all (");
          expect(result.definition, `${view}: the definition`).not.toContain("UNION ALL");
          expect({ view, missing, extra }).toEqual({ view, missing: 0, extra: 0 });
          expect(rows, `${view} is non-empty, so the check is not vacuous`).toBeGreaterThan(0);
          expect(result.columns, `${view}: the columns`).toEqual(result.oracleColumns);
        });
      }),
    );
  });
});

describe("branch views: fail closed", () => {
  it("yields no row for a head with the branch row but no leaf row, as the union did", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        expect(yield* headsOf("ontology.work_view", W4)).toEqual([]);
        expect(yield* headsOf(`(${unionView("work_view")})`, W4)).toEqual([]);
        expect(yield* headsOf("ontology.collection_view", C5)).toEqual([]);
        expect(yield* headsOf("ontology.series_view", C5)).toEqual([]);
        expect(yield* headsOf(`(${unionView("collection_view")})`, C5)).toEqual([]);
        expect(yield* headsOf(`(${unionView("series_view")})`, C5)).toEqual([]);
        // The node's earlier, complete head is superseded, not resurfaced.
        expect(yield* countOf(`select id from ontology.book_view where id = '${W4}'`)).toBe(0);
      }),
    );
  });

  it("yields no row for a head whose marker below the branch is missing, as the union did", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        expect(yield* headsOf("ontology.collection_view", C4)).toEqual([]);
        expect(yield* headsOf(`(${unionView("collection_view")})`, C4)).toEqual([]);
        expect(yield* countOf(`select id from ontology.volume_view where id = '${C4}'`)).toBe(0);
        // A complete volume head does show.
        expect(yield* headsOf("ontology.collection_view", C1)).toEqual([[1, "update", "volume"]]);
      }),
    );
  });

  it("yields no row for a node whose type names a leaf with no row at the head", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedStale;
        expect(yield* headsOf("ontology.work_view", STALE)).toEqual([]);
        // The union's essay arm never read `type`, so it showed the essay row
        // under type book; the single driver requires the named leaf's row.
        expect(yield* headsOf(`(${unionView("work_view")})`, STALE)).toEqual([
          [0, "create", "book"],
        ]);
        // The leaf views are unchanged: the essay view still reads its own row.
        expect(yield* countOf(`select id from ontology.essay_view where id = '${STALE}'`)).toBe(1);
      }),
    );
  });
});

describe("branch views: per-leaf projection", () => {
  it("projects each leaf's own label through the CASE on type, for every row", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        const leaves = `select id, version, label from ontology.volume_view union all select id, version, label from ontology.supplement_view union all select id, version, label from ontology.pamphlet_view`;
        const branchRows = yield* countOf(`select * from ontology.collection_view`);
        expect(branchRows).toBeGreaterThan(0);
        expect(yield* countOf(leaves)).toBe(branchRows);
        // Every branch row matches its leaf view's row, label included: no
        // CASE arm falls through to NULL.
        expect(
          yield* countOf(
            `select c.id from ontology.collection_view c left join (${leaves}) l on l.id = c.id and l.version = c.version where l.id is null or c.label is distinct from l.label`,
          ),
        ).toBe(0);
        // The one NULL label is the leaf's own.
        expect(yield* countOf(`select id from ontology.collection_view where label is null`)).toBe(
          yield* countOf(`select id from (${leaves}) l where label is null`),
        );
        expect(yield* countOf(`select id from ontology.collection_view where label is null`)).toBe(
          1,
        );
      }),
    );
  });
});

// ── A wide branch ────────────────────────────────────────────────────────

const empty = {};
const wideBuilders = { text: (column: string) => text(column) };

/**
 * A twelve-leaf branch: `hub` over markers `ma` (with `maa` under it) and
 * `mb`; four leaves under `maa`, two under `ma`, six under `mb`.
 */
const wideTree = defineTree({
  hub: {
    columns: { title: dbColumn(Schema.String, { column: "title", pg: "text", notNull: true }) },
  },
  ma: { parent: "hub" },
  maa: { parent: "ma" },
  mb: { parent: "hub" },
  a1: { parent: "maa", leaf: empty },
  a2: { parent: "maa", leaf: empty },
  a3: { parent: "maa", leaf: empty },
  a4: { parent: "maa", leaf: empty },
  a5: { parent: "ma", leaf: empty },
  a6: { parent: "ma", leaf: empty },
  b1: { parent: "mb", leaf: empty },
  b2: { parent: "mb", leaf: empty },
  b3: { parent: "mb", leaf: empty },
  b4: { parent: "mb", leaf: empty },
  b5: { parent: "mb", leaf: empty },
  b6: { parent: "mb", leaf: empty },
});

const wide = pgSchema("wide_branch");
const wideTables = makeTreeTables(wideTree, { schema: wide, builders: wideBuilders });
const wideViews = makeTreeViews(wideTree, wideTables, { schema: wide, branches: { hub: true } });

/** The wide tree's schema, tables and branch view, as a schema module drizzle-kit reads. */
const wideModule = {
  wide,
  identity: wideTables.root.identity,
  version: wideTables.root.version,
  ...R.fromEntries(
    Arr.flatMap(R.toEntries(wideTables.levels), ([name, level]) => [
      [`${name}Stable`, level.stable] as const,
      [`${name}Version`, level.version] as const,
    ]),
  ),
  hubView: wideViews.branches.hub,
};

/** drizzle-kit could not diff the wide tree's schema module. */
class WideSchemaError extends Schema.TaggedError<WideSchemaError>()("WideSchemaError", {
  cause: Schema.Defect(),
}) {}

/** Level names as a SQL `IN` list. */
const inList = (names: ReadonlyArray<string>) => names.map((name) => `'${name}'`).join(", ");

const WIDE_INDEX = "wide_hub_title_probe";
const WIDE_NODES = 6000;
const wideId = (g: string) => `('00000000-0000-4000-a000-' || lpad(${g}::text, 12, '0'))::uuid`;

/** The wide tree's DDL from drizzle-kit, then 6,000 nodes at two versions over its leaves. */
const seedWide = Effect.fn("branchViews.seedWide")(function* () {
  const ddl = yield* Effect.tryPromise({
    try: async () =>
      generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(wideModule)),
    catch: (cause) => new WideSchemaError({ cause }),
  });
  const leaves = wideTree.leaves;
  const identity = getTableName(wideTables.root.identity);
  const rootVersion = getTableName(wideTables.root.version);
  yield* execAll([
    ...ddl,
    `CREATE TEMPORARY TABLE wide_ids ON COMMIT DROP AS SELECT g, ${wideId("g")} AS id, (ARRAY[${inList(leaves)}])[1 + g % ${leaves.length}] AS leaf FROM generate_series(1, ${WIDE_NODES}) g`,
    `INSERT INTO wide_branch.${identity} (id, type) SELECT id, leaf FROM wide_ids`,
    `INSERT INTO wide_branch.${rootVersion} (id, version, action) SELECT id, v, CASE v WHEN 0 THEN 'create' ELSE 'update' END FROM wide_ids, generate_series(0, 1) v`,
    ...Arr.flatMap(wideTree.levels, (level) => {
      const where = `WHERE leaf IN (${inList(level.subtreeLeaves)})`;
      const stable = getTableName(wideTables.levels[level.name].stable);
      const version = getTableName(wideTables.levels[level.name].version);
      return [
        `INSERT INTO wide_branch.${stable} (id, type) SELECT id, leaf FROM wide_ids ${where}`,
        level.name === "hub"
          ? `INSERT INTO wide_branch.${version} (id, version, title) SELECT id, v, 'title ' || lpad(g::text, 6, '0') || '-' || v FROM wide_ids, generate_series(0, 1) v ${where}`
          : `INSERT INTO wide_branch.${version} (id, version) SELECT id, v FROM wide_ids, generate_series(0, 1) v ${where}`,
      ];
    }),
    `CREATE INDEX ${WIDE_INDEX} ON wide_branch.hub_version (title, id)`,
    `ANALYZE`,
  ]);
});

describe("branch views: plans", () => {
  it("pages a twelve-leaf branch through the branch level's index, with no Sort and no aggregate", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWide();
        // Every node shows once, at its head: the fail-closed predicate
        // matches each one's own leaf.
        expect(yield* countOf(`select * from wide_branch.hub_view`)).toBe(WIDE_NODES);
        const page = yield* explain(
          "SELECT * FROM wide_branch.hub_view ORDER BY title, id LIMIT 20",
        );
        expect(aggregates(page)).toEqual([]);
        expect(Arr.some(page, (n) => n["Index Name"] === WIDE_INDEX)).toBe(true);
        expect(Arr.some(page, (n) => n["Node Type"] === "Sort")).toBe(false);
        const byId = yield* explain(
          `SELECT * FROM wide_branch.hub_view WHERE id = '00000000-0000-4000-a000-000000000042'`,
        );
        expect(aggregates(byId)).toEqual([]);
        expect(
          Arr.filter(
            byId,
            (n) =>
              n["Node Type"] === "Seq Scan" &&
              (n["Relation Name"] === "node_version" || n["Relation Name"] === "hub_version"),
          ),
        ).toEqual([]);
      }),
    );
  });
});
