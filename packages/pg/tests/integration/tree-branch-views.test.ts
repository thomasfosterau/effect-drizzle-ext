/**
 * The branch views `makeTreeViews` derives, as one SELECT driven from the
 * branch level's own version table instead of a `UNION ALL` of per-leaf arms
 * (effect-drizzle-ext#200), failing closed with a `CASE` on `type` over
 * `EXISTS` probes instead of a LEFT JOIN per leaf (effect-drizzle-ext#204),
 * proven against PostgreSQL.
 *
 * - **Equivalence.** Over mixed histories (multi-version nodes, deleted
 *   heads, a head that skipped its leaf, a head that skipped the marker
 *   between the branch and its leaf, a stale `type`, a `type` naming no
 *   subtree leaf), every fixture branch view (`work`, `collection`, `series`)
 *   returns exactly the rows, columns and column types its `UNION ALL`
 *   definition did, less the stale- and unknown-type rows that form showed.
 *   The oracle is each view's last `CREATE VIEW` in the fixture chain before
 *   the single-driver migration, read from the committed migrations. Two
 *   generated branches (12 and 30 leaves under two marker levels) are checked
 *   the same way against a `UNION ALL` of their leaf views. Branch views have
 *   no as-of form (`asOf` reads a leaf), so the head is the only point.
 * - **Fail closed.** A head with the branch row but no leaf row, a head
 *   whose marker below the branch is missing, a node whose `type` names a
 *   leaf with no row at the head while another leaf's row is there (a kept
 *   old row), and a node whose `type` names no subtree leaf (the `CASE`'s
 *   `ELSE false`) all yield no row.
 * - **Projection.** `collection`'s per-leaf `label` (a `CASE` on `type`)
 *   equals each leaf view's own `label`, row for row.
 * - **Plans.** The fixture `work_view` and a generated twelve-leaf branch
 *   page through an index on the branch level with no Sort, no aggregate and
 *   no join to any table below the branch (the `EXISTS` probes are subplans),
 *   and the wide branch reads one node by id without a sequential scan of the
 *   root version table.
 *
 * @module packages/pg/tests/integration/tree-branch-views
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import {
  makeTreeTables,
  makeTreeViews,
  type AnyTreeTables,
} from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { getTableName, sql, type SQL } from "drizzle-orm";
import { pgSchema, text, type PgSchema, type PgTable, type PgView } from "drizzle-orm/pg-core";
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
const { difference, execAll, explain, explainJoined } = viewOracle(database);

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
const UNKNOWN = idOf(12); // type names no work leaf; a full book chain at the head

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

/**
 * A node whose `type` names no leaf of `work` (`'pamphlet'`, a collection
 * leaf) over a complete book chain. The `(id, type)` arcs forbid the work and
 * book rows under that type, so they go in unchecked. `node.type` is
 * `NOT NULL`, so a NULL `type` can't be written; it reaches the same
 * `ELSE false` (`CASE NULL WHEN …` matches no arm).
 */
const seedUnknown = execAll([
  `INSERT INTO ontology.node (id, type) VALUES ('${UNKNOWN}', 'pamphlet')`,
  ...unchecked([
    `INSERT INTO ontology.work (id, type) VALUES ('${UNKNOWN}', 'book')`,
    `INSERT INTO ontology.book (id, type) VALUES ('${UNKNOWN}', 'book')`,
  ]),
  ...workAt(UNKNOWN, "book", 0, "create"),
]);

const BRANCH_VIEWS = ["work_view", "collection_view", "series_view"] as const;

/** The distinct ids `query` returns, ordered. */
const idsOf = Effect.fn("branchViews.idsOf")(function* (query: string) {
  const rows = yield* rowsOf(
    sql.raw(`select distinct id::text as id from (${query}) q order by id`),
  );
  return Arr.map(rows, (r) => String(r["id"]));
});

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
        yield* seedStale;
        yield* seedUnknown;
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
                extraIds: yield* idsOf(`(${oracle}) except all select * from ontology.${view}`),
              };
            }),
          { concurrency: 1 },
        );
        Arr.forEach(results, (result) => {
          const { view, rows, missing, extra } = result;
          // The oracle really is the union of per-leaf arms; the view is not.
          expect(result.oracle, `${view}: the oracle`).toContain(") union all (");
          expect(result.definition, `${view}: the definition`).not.toContain("UNION ALL");
          // The single driver's tightening (effect-drizzle-ext#200), kept by
          // the CASE (effect-drizzle-ext#204): the union showed work's
          // stale-type and unknown-type rows, the view shows neither; every
          // other row is equal both ways.
          const tightened = view === "work_view" ? [STALE, UNKNOWN] : [];
          expect({ view, missing, extra, ids: result.extraIds }).toEqual({
            view,
            missing: 0,
            extra: tightened.length,
            ids: tightened,
          });
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

  it("yields no row for a node whose type names no subtree leaf: the CASE's ELSE false", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedUnknown;
        expect(yield* headsOf("ontology.work_view", UNKNOWN)).toEqual([]);
        // The union's book arm showed the book row under the foreign type.
        expect(yield* headsOf(`(${unionView("work_view")})`, UNKNOWN)).toEqual([
          [0, "create", "pamphlet"],
        ]);
        // The CASE's last arm is `ELSE false`, not a fall-through to NULL.
        const [definition] = yield* rowsOf(
          sql.raw(`SELECT pg_get_viewdef('ontology.work_view') AS d`),
        );
        expect(String(definition?.["d"])).toContain("ELSE false");
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

// ── Plans on the fixture ─────────────────────────────────────────────────

const WORK_INDEX = "work_title_probe";
const WORK_NODES = 4000;
const workId = (g: string) => `('00000000-0000-4000-b000-' || lpad(${g}::text, 12, '0'))::uuid`;

/** 4,000 works at two versions, alternating book and essay, and an index on the branch level. */
const seedWorks = execAll([
  `CREATE TEMPORARY TABLE work_ids ON COMMIT DROP AS SELECT g, ${workId("g")} AS id, CASE g % 2 WHEN 0 THEN 'book' ELSE 'essay' END AS leaf FROM generate_series(1, ${WORK_NODES}) g`,
  `INSERT INTO ontology.node (id, type) SELECT id, leaf FROM work_ids`,
  `INSERT INTO ontology.work (id, type) SELECT id, leaf FROM work_ids`,
  `INSERT INTO ontology.book (id, type) SELECT id, leaf FROM work_ids WHERE leaf = 'book'`,
  `INSERT INTO ontology.essay (id, type) SELECT id, leaf FROM work_ids WHERE leaf = 'essay'`,
  `INSERT INTO ontology.node_version (id, version, action) SELECT id, v, CASE v WHEN 0 THEN 'create' ELSE 'update' END FROM work_ids, generate_series(0, 1) v`,
  `INSERT INTO ontology.work_version (id, version, title) SELECT id, v, 'title ' || lpad(g::text, 6, '0') || '-' || v FROM work_ids, generate_series(0, 1) v`,
  `INSERT INTO ontology.book_version (id, version, pages) SELECT id, v, g FROM work_ids, generate_series(0, 1) v WHERE leaf = 'book'`,
  `INSERT INTO ontology.essay_version (id, version) SELECT id, v FROM work_ids, generate_series(0, 1) v WHERE leaf = 'essay'`,
  `CREATE INDEX ${WORK_INDEX} ON ontology.work_version (title, id)`,
  `ANALYZE`,
]);

describe("branch views: the fixture page plan", () => {
  it("pages work_view through the branch level's index, joining no leaf (effect-drizzle-ext#204)", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedWorks;
        expect(yield* countOf(`select * from ontology.work_view`)).toBe(WORK_NODES);
        const query = "SELECT * FROM ontology.work_view ORDER BY title, id LIMIT 20";
        const page = yield* explain(query);
        expect(aggregates(page)).toEqual([]);
        expect(Arr.some(page, (n) => n["Index Name"] === WORK_INDEX)).toBe(true);
        expect(Arr.some(page, (n) => n["Node Type"] === "Sort")).toBe(false);
        // The leaves are probed by the CASE's EXISTS subplans, never joined.
        const joined = Arr.flatMap(yield* explainJoined(query), (n) =>
          Arr.fromNullishOr(n["Relation Name"]),
        );
        expect(joined).toContain("work_version");
        expect(Arr.intersection(joined, ["book_version", "essay_version"])).toEqual([]);
      }),
    );
  });
});

// ── Generated wide branches ──────────────────────────────────────────────

const empty = {};
const wideBuilders = { text: (column: string) => text(column) };
const hubColumns = {
  title: dbColumn(Schema.String, { column: "title", pg: "text", notNull: true }),
};

/**
 * A twelve-leaf branch: `hub` over markers `ma` (with `maa` under it) and
 * `mb`; four leaves under `maa`, two under `ma`, six under `mb`.
 */
const wide12Tree = defineTree({
  hub: { columns: hubColumns },
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

/** A thirty-leaf branch of the same shape: ten leaves under `maa`, five under `ma`, fifteen under `mb`. */
const wide30Tree = defineTree({
  hub: { columns: hubColumns },
  ma: { parent: "hub" },
  maa: { parent: "ma" },
  mb: { parent: "hub" },
  a1: { parent: "maa", leaf: empty },
  a2: { parent: "maa", leaf: empty },
  a3: { parent: "maa", leaf: empty },
  a4: { parent: "maa", leaf: empty },
  a5: { parent: "maa", leaf: empty },
  a6: { parent: "maa", leaf: empty },
  a7: { parent: "maa", leaf: empty },
  a8: { parent: "maa", leaf: empty },
  a9: { parent: "maa", leaf: empty },
  a10: { parent: "maa", leaf: empty },
  a11: { parent: "ma", leaf: empty },
  a12: { parent: "ma", leaf: empty },
  a13: { parent: "ma", leaf: empty },
  a14: { parent: "ma", leaf: empty },
  a15: { parent: "ma", leaf: empty },
  b1: { parent: "mb", leaf: empty },
  b2: { parent: "mb", leaf: empty },
  b3: { parent: "mb", leaf: empty },
  b4: { parent: "mb", leaf: empty },
  b5: { parent: "mb", leaf: empty },
  b6: { parent: "mb", leaf: empty },
  b7: { parent: "mb", leaf: empty },
  b8: { parent: "mb", leaf: empty },
  b9: { parent: "mb", leaf: empty },
  b10: { parent: "mb", leaf: empty },
  b11: { parent: "mb", leaf: empty },
  b12: { parent: "mb", leaf: empty },
  b13: { parent: "mb", leaf: empty },
  b14: { parent: "mb", leaf: empty },
  b15: { parent: "mb", leaf: empty },
});

/** One generated wide branch: its schema, its levels, and the module drizzle-kit diffs. */
interface WideBranch {
  readonly schema: string;
  readonly leaves: ReadonlyArray<string>;
  readonly levels: ReadonlyArray<{
    readonly name: string;
    readonly subtreeLeaves: ReadonlyArray<string>;
  }>;
  readonly identity: string;
  readonly rootVersion: string;
  readonly module: Readonly<Record<string, PgSchema | PgTable | PgView>>;
}

/** A wide tree's tables, its branch view and every leaf view (the oracle's arms), as a schema module. */
const wideBranch = (
  schema: PgSchema,
  tree: Pick<WideBranch, "leaves" | "levels">,
  tables: AnyTreeTables,
  views: {
    readonly leaves: Readonly<Record<string, PgView>>;
    readonly branches: { readonly hub: PgView };
  },
): WideBranch => ({
  schema: schema.schemaName,
  leaves: tree.leaves,
  levels: tree.levels,
  identity: getTableName(tables.root.identity),
  rootVersion: getTableName(tables.root.version),
  module: {
    schema,
    identity: tables.root.identity,
    version: tables.root.version,
    ...R.fromEntries(
      Arr.flatMap(R.toEntries(tables.levels), ([level, pair]) => [
        [`${level}Stable`, pair.stable] as const,
        [`${level}Version`, pair.version] as const,
      ]),
    ),
    ...R.fromEntries(
      Arr.map(R.toEntries(views.leaves), ([leaf, view]) => [`${leaf}View`, view] as const),
    ),
    hubView: views.branches.hub,
  },
});

const wide12 = pgSchema("wide_branch");
const wide12Tables = makeTreeTables(wide12Tree, { schema: wide12, builders: wideBuilders });
const wide30 = pgSchema("wide_branch_30");
const wide30Tables = makeTreeTables(wide30Tree, { schema: wide30, builders: wideBuilders });

const WIDE_BRANCHES = [
  wideBranch(
    wide12,
    wide12Tree,
    wide12Tables,
    makeTreeViews(wide12Tree, wide12Tables, { schema: wide12, branches: { hub: true } }),
  ),
  wideBranch(
    wide30,
    wide30Tree,
    wide30Tables,
    makeTreeViews(wide30Tree, wide30Tables, { schema: wide30, branches: { hub: true } }),
  ),
] as const;

/** drizzle-kit could not diff a wide tree's schema module. */
class WideSchemaError extends Schema.TaggedError<WideSchemaError>()("WideSchemaError", {
  cause: Schema.Defect(),
}) {}

/** Level names as a SQL `IN` list. */
const inList = (names: ReadonlyArray<string>) => names.map((name) => `'${name}'`).join(", ");

const WIDE_INDEX = "wide_hub_title_probe";
const WIDE_NODES = 6000;
/**
 * The plan spec's node count. Below it the planner costs the hash joins'
 * fail-closed CASE as near free and prefers a full scan and a Sort (seen at
 * 6,000 nodes for twelve leaves and at 40,000 for thirty).
 */
const PLAN_NODES = 40000;
const wideId = (g: string) => `('00000000-0000-4000-a000-' || lpad(${g}::text, 12, '0'))::uuid`;

/** `n`th of a wide branch's irregular nodes, clear of the generated ones. */
const oddId = (n: number) => `00000000-0000-4000-a000-1000000000${String(n).padStart(2, "0")}`;
const WIDE_NO_LEAF = oddId(1); // a1: hub, ma, maa at the head, no a1 row
const WIDE_NO_MARKER = oddId(2); // a1: hub, ma, a1 at the head, no maa row
const WIDE_STALE = oddId(3); // type a1; only b1's chain at the head
const WIDE_UNKNOWN = oddId(4); // type names no level; b1's chain at the head

/**
 * A wide tree's DDL from drizzle-kit, then `nodes` nodes at two versions over
 * its leaves, the irregular nodes above (written unchecked, past the
 * `(id, type)` arcs), and an index on the branch level.
 */
const seedWide = Effect.fn("branchViews.seedWide")(function* (branch: WideBranch, nodes: number) {
  const ddl = yield* Effect.tryPromise({
    try: async () =>
      generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(branch.module)),
    catch: (cause) => new WideSchemaError({ cause }),
  });
  const { leaves, schema } = branch;
  const odd = (id: string, type: string, levels: ReadonlyArray<string>) => [
    `INSERT INTO ${schema}.${branch.identity} (id, type) VALUES ('${id}', '${type}')`,
    `INSERT INTO ${schema}.${branch.rootVersion} (id, version, action) VALUES ('${id}', 0, 'create')`,
    ...Arr.map(
      levels,
      (level) =>
        `INSERT INTO ${schema}.${level}_version (id, version${level === "hub" ? ", title" : ""}) VALUES ('${id}', 0${level === "hub" ? ", 'odd'" : ""})`,
    ),
  ];
  yield* execAll([
    ...ddl,
    `CREATE TEMPORARY TABLE wide_ids ON COMMIT DROP AS SELECT g, ${wideId("g")} AS id, (ARRAY[${inList(leaves)}])[1 + g % ${leaves.length}] AS leaf FROM generate_series(1, ${nodes}) g`,
    `INSERT INTO ${schema}.${branch.identity} (id, type) SELECT id, leaf FROM wide_ids`,
    `INSERT INTO ${schema}.${branch.rootVersion} (id, version, action) SELECT id, v, CASE v WHEN 0 THEN 'create' ELSE 'update' END FROM wide_ids, generate_series(0, 1) v`,
    ...Arr.flatMap(branch.levels, (level) => {
      const where = `WHERE leaf IN (${inList(level.subtreeLeaves)})`;
      return [
        `INSERT INTO ${schema}.${level.name} (id, type) SELECT id, leaf FROM wide_ids ${where}`,
        level.name === "hub"
          ? `INSERT INTO ${schema}.${level.name}_version (id, version, title) SELECT id, v, 'title ' || lpad(g::text, 6, '0') || '-' || v FROM wide_ids, generate_series(0, 1) v ${where}`
          : `INSERT INTO ${schema}.${level.name}_version (id, version) SELECT id, v FROM wide_ids, generate_series(0, 1) v ${where}`,
      ];
    }),
    ...unchecked([
      ...odd(WIDE_NO_LEAF, "a1", ["hub", "ma", "maa"]),
      ...odd(WIDE_NO_MARKER, "a1", ["hub", "ma", "a1"]),
      ...odd(WIDE_STALE, "a1", ["hub", "mb", "b1"]),
      ...odd(WIDE_UNKNOWN, "zz", ["hub", "mb", "b1"]),
    ]),
    `CREATE INDEX ${WIDE_INDEX} ON ${schema}.hub_version (title, id)`,
    `ANALYZE`,
  ]);
});

/**
 * The `UNION ALL` form of a wide branch view, from its leaf views: per leaf,
 * the leaf view's branch columns with the identity's `type`, as each
 * per-leaf arm was (the leaf views are unchanged, and fail closed alike).
 */
const wideOracle = Effect.fn("branchViews.wideOracle")(function* (branch: WideBranch) {
  const columns = Arr.map(yield* columnsOf(branch.schema, "hub_view"), (c) => c.split(" ")[0]);
  const select = Arr.map(columns, (c) => (c === "type" ? "n.type" : `l.${c}`)).join(", ");
  const arms = Arr.map(
    branch.leaves,
    (leaf) =>
      `(select ${select} from ${branch.schema}.${leaf}_view l join ${branch.schema}.${branch.identity} n on n.id = l.id)`,
  );
  return `select * from (${arms.join(" union all ")}) oracle`;
});

describe("branch views: generated wide branches", () => {
  it.each(WIDE_BRANCHES)(
    "$schema returns the UNION ALL form's rows, less the stale- and unknown-type ones",
    async (branch) => {
      await runInTestTransaction(
        runtime,
        Effect.gen(function* () {
          yield* seedWide(branch, WIDE_NODES);
          const view = `select * from ${branch.schema}.hub_view`;
          const oracle = yield* wideOracle(branch);
          expect(yield* countOf(view)).toBe(WIDE_NODES);
          expect(yield* difference(sql.raw(view), oracle)).toEqual({
            rows: WIDE_NODES,
            missing: 0,
            extra: 2,
          });
          // The tightening, explicitly: only the stale- and unknown-type
          // nodes are the union's alone; the missing leaf and marker show in
          // neither.
          expect(yield* idsOf(`${oracle} except all ${view}`)).toEqual([WIDE_STALE, WIDE_UNKNOWN]);
          expect(
            yield* countOf(
              `${view} where id in ('${WIDE_NO_LEAF}', '${WIDE_NO_MARKER}', '${WIDE_STALE}', '${WIDE_UNKNOWN}')`,
            ),
          ).toBe(0);
          expect(
            yield* countOf(
              `select * from (${oracle}) o where id in ('${WIDE_NO_LEAF}', '${WIDE_NO_MARKER}')`,
            ),
          ).toBe(0);
        }),
      );
    },
  );

  it.each([WIDE_BRANCHES[0]])(
    "$schema pages through the branch level's index with no Sort, no aggregate and no leaf join",
    async (branch) => {
      await runInTestTransaction(
        runtime,
        Effect.gen(function* () {
          yield* seedWide(branch, PLAN_NODES);
          const query = `SELECT * FROM ${branch.schema}.hub_view ORDER BY title, id LIMIT 20`;
          const page = yield* explain(query);
          expect(aggregates(page)).toEqual([]);
          expect(Arr.some(page, (n) => n["Index Name"] === WIDE_INDEX)).toBe(true);
          expect(Arr.some(page, (n) => n["Node Type"] === "Sort")).toBe(false);
          const joined = Arr.flatMap(yield* explainJoined(query), (n) =>
            Arr.fromNullishOr(n["Relation Name"]),
          );
          const below = Arr.filter(
            Arr.map(branch.levels, (level) => `${level.name}_version`),
            (table) => table !== "hub_version",
          );
          expect(joined).toContain("hub_version");
          expect(Arr.intersection(joined, below)).toEqual([]);
          const byId = yield* explain(
            `SELECT * FROM ${branch.schema}.hub_view WHERE id = '00000000-0000-4000-a000-000000000042'`,
          );
          expect(aggregates(byId)).toEqual([]);
          expect(
            Arr.filter(
              byId,
              (n) =>
                n["Node Type"] === "Seq Scan" &&
                (n["Relation Name"] === branch.rootVersion || n["Relation Name"] === "hub_version"),
            ),
          ).toEqual([]);
        }),
      );
    },
  );
});
