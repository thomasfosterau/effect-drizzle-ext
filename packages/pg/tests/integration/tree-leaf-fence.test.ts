/**
 * The leaf, keyed, pointer and as-of views `makeTreeViews` derives with
 * their columnless levels, stable rows and facts (and any level `fenced`
 * names) in one fenced `CROSS JOIN LATERAL (… OFFSET 0)`, and every level
 * with columns of its own a plain join (effect-drizzle-ext#207), proven
 * against PostgreSQL.
 *
 * - **Equivalence.** Every fixture leaf, keyed and pointer view returns
 *   exactly the rows (`EXCEPT ALL` both ways) and the columns (names, order
 *   and types, from `information_schema.columns`) of its 0.4.0 definition,
 *   its last `CREATE VIEW` in the fixture chain before the fenced-tail
 *   migration; `asOf` matches that definition with its anti-join bounded the
 *   way `asOf` bounds it. Generated trees of one and three pure markers, and
 *   one of three markers with columns and `fenced: ["m2", "m3"]`, are checked
 *   the same way against the 0.4.0 form written out by hand (every level a
 *   plain INNER JOIN).
 * - **Fail closed.** A head that skipped a marker, a leaf, a spine row or a
 *   stable row the tail requires yields no row: the tail is an inner join,
 *   so a missing level drops the row rather than NULLing its columns.
 * - **Plans.** At three marker levels and 50,000 rows, after `ANALYZE`, for
 *   pure markers: a page walks the leaf's index with no Sort; `ORDER BY
 *   created_at DESC` walks the root version's timestamp index with no Sort
 *   node (an Incremental Sort on the `id` tiebreak only); a filter on an
 *   identity column and a join from another table on the view's `id` scan no
 *   table sequentially; and the planner joins at most five relations outside
 *   the tail, the tail's tables as one unit. With columns, the plain `m1`
 *   drives a page by its own index while the levels `fenced` names form the
 *   tail. The fixture's `work` (it has `title`) stays plain, so
 *   `tree-view-heads`' leaf-index page keeps its plan. Planning time is
 *   reported in the changeset as measurements, never asserted.
 *
 * @module packages/pg/tests/integration/tree-leaf-fence
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import {
  makeTreeTables,
  makeTreeViews,
  type AnyTreeTables,
} from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { sql, type SQL } from "drizzle-orm";
import { integer, pgSchema, text, type PgSchema } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { integrationDatabaseLayer } from "./database-url.ts";
import { joinedNodes, viewOracle, viewsBefore, type PlanNode } from "./view-oracle.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import { ontologyViews } from "../fixtures/schema.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;
const { difference, execAll, explain, explainRoot } = viewOracle(database);

const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction } = makeTestTransaction(database);

/** The migration that fenced the leaf views' tails. */
const FENCE_MIGRATION = "20261112222142_leaf-view-fenced-tail";

/** Each fixture view's 0.4.0 definition: its last `CREATE VIEW` before {@link FENCE_MIGRATION}. */
let releasedViews: Readonly<Record<string, string>> = {};

beforeAll(async () => {
  releasedViews = await viewsBefore(FENCE_MIGRATION);
});

afterAll(() => runtime.dispose());

/** A view's 0.4.0 definition; empty for one the chain never defined. */
const releasedView = (name: string): string =>
  Option.getOrElse(R.get(releasedViews, name), () => "");

/** One row of a raw query here: every column these specs read is a scalar. */
type Row = Readonly<Record<string, string | number>>;

const rowsOf = Effect.fn("leafFence.rowsOf")(function* (query: SQL) {
  const tx = yield* CurrentTransaction;
  return (yield* tx.execute<Row>(query)).rows;
});

/** How many rows `query` returns. */
const countOf = Effect.fn("leafFence.countOf")(function* (query: string) {
  const [row] = yield* rowsOf(sql.raw(`select count(*)::int as n from (${query}) q`));
  return Number(row?.["n"]);
});

/** A relation's columns as PostgreSQL sees them: name and type, in order. */
const columnsOf = Effect.fn("leafFence.columnsOf")(function* (schema: string, relation: string) {
  const rows = yield* rowsOf(
    sql.raw(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${relation}' ORDER BY ordinal_position`,
    ),
  );
  return Arr.map(rows, (r) => `${String(r["column_name"])} ${String(r["data_type"])}`);
});

/** The columns of `oracle`, created as a temporary view of its own. */
const oracleColumnsOf = Effect.fn("leafFence.oracleColumnsOf")(function* (
  name: string,
  oracle: string,
) {
  yield* execAll([`CREATE TEMPORARY VIEW ${name}_oracle AS ${oracle}`]);
  const [temp] = yield* rowsOf(
    sql.raw(`SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()`),
  );
  return yield* columnsOf(String(temp?.["nspname"]), `${name}_oracle`);
});

/** Writes the `(id, version)` and `(id, type)` foreign keys forbid, with their triggers off. */
const unchecked = (statements: ReadonlyArray<string>) => [
  `SET LOCAL session_replication_role = replica`,
  ...statements,
  `SET LOCAL session_replication_role = origin`,
];

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

// ── The fixture views ────────────────────────────────────────────────────

/** `n`th id of this file's fixture nodes (`…-8000-0000000005nn`), clear of the other specs'. */
const idOf = (n: number) => `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`;

const B1 = idOf(1); // book, three versions
const B2 = idOf(2); // book, deleted head
const B3 = idOf(3); // book, v1 has the book row but no work row (fails closed)
const E1 = idOf(4); // essay, two locales then one
const E2 = idOf(5); // essay, v1 has no work row (fails closed), live at v0
const ED1 = idOf(6); // edition, isbn fact then none
const ED2 = idOf(7); // edition, v1 has no manifestation row (fails closed)
const P1 = idOf(8); // person with a wikidata id
const P2 = idOf(9); // person with no person stable row (fails closed)
const O1 = idOf(10); // organisation
const V1 = idOf(11); // volume, two versions
const V2 = idOf(12); // volume, v1 has no series row (fails closed)
const S1 = idOf(13); // supplement, deleted head
const PA1 = idOf(14); // pamphlet

/** The nodes whose head misses a row the tail requires. */
const GAPPED = [B3, E2, ED2, P2, V2] as const;

/** Version `v`'s timestamp: the first of month `v + 1` of 2026. */
const at = (v: number) => `2026-${String(v + 1).padStart(2, "0")}-01T00:00:00Z`;

const node = (id: string, type: string, stable: ReadonlyArray<string>) => [
  `INSERT INTO ontology.node (id, type) VALUES ('${id}', '${type}')`,
  ...Arr.map(
    stable,
    (table) => `INSERT INTO ontology.${table} (id, type) VALUES ('${id}', '${type}')`,
  ),
];

const rootAt = (id: string, v: number, action: string) =>
  `INSERT INTO ontology.node_version (id, version, action, timestamp) VALUES ('${id}', ${v}, '${action}', '${at(v)}')`;

const row = (table: string, id: string, v: number, columns = "", values = "") =>
  `INSERT INTO ontology.${table} (id, version${columns ? `, ${columns}` : ""}) VALUES ('${id}', ${v}${values ? `, ${values}` : ""})`;

const bookAt = (id: string, v: number, action: string) => [
  rootAt(id, v, action),
  row("work_version", id, v, "title", `'b${v}'`),
  row("book_version", id, v, "pages", `${100 + v}`),
];

const essayAt = (id: string, v: number, action: string, locales: ReadonlyArray<string>) => [
  rootAt(id, v, action),
  row("work_version", id, v, "title", `'e${v}'`),
  row("essay_version", id, v),
  ...Arr.map(locales, (locale) =>
    row("essay_locale", id, v, "locale, abstract", `'${locale}', '${locale}${v}'`),
  ),
];

const editionAt = (id: string, v: number, isbn: Option.Option<string>) => [
  rootAt(id, v, v === 0 ? "create" : "update"),
  row("manifestation_version", id, v),
  ...Arr.fromOption(
    Option.map(isbn, (value) => row("manifestation_isbn", id, v, "isbn", `'${value}'`)),
  ),
  row("edition_version", id, v),
];

const agentAt = (id: string, v: number, leaf: string) => [
  rootAt(id, v, "create"),
  row("agent_version", id, v),
  row(`${leaf}_version`, id, v),
];

const collectionAt = (id: string, leaf: string, v: number, action: string) => [
  rootAt(id, v, action),
  row("collection_version", id, v, "name", `'${leaf}${v}'`),
  ...(leaf === "pamphlet" ? [] : [row("series_version", id, v, "cadence", `'c${v}'`)]),
  row(`${leaf}_version`, id, v, "label", `'l${v}'`),
];

const pointAt = (id: string, version: string, when = "now()") =>
  `INSERT INTO ontology.live_pointer (id, version, at) VALUES ('${id}', ${version}, ${when})`;

/** Mixed histories over every leaf of the fixture, with a gapped head per kind of tail row. */
const seedFixture = execAll([
  ...node(B1, "book", ["work", "book"]),
  ...bookAt(B1, 0, "create"),
  ...bookAt(B1, 1, "update"),
  ...bookAt(B1, 2, "update"),
  ...node(B2, "book", ["work", "book"]),
  ...bookAt(B2, 0, "create"),
  ...bookAt(B2, 1, "delete"),
  ...node(B3, "book", ["work", "book"]),
  ...bookAt(B3, 0, "create"),
  rootAt(B3, 1, "update"),
  // The leaf row references the work row it skips, so it goes in unchecked.
  ...unchecked([row("book_version", B3, 1, "pages", "7")]),
  ...node(E1, "essay", ["work", "essay"]),
  ...essayAt(E1, 0, "create", ["en", "fr"]),
  ...essayAt(E1, 1, "update", ["en"]),
  ...node(E2, "essay", ["work", "essay"]),
  ...essayAt(E2, 0, "create", ["en"]),
  rootAt(E2, 1, "update"),
  ...unchecked([row("essay_version", E2, 1)]),
  ...node(ED1, "edition", ["manifestation", "edition"]),
  ...editionAt(ED1, 0, Option.some("978-0")),
  ...editionAt(ED1, 1, Option.none()),
  ...node(ED2, "edition", ["manifestation", "edition"]),
  ...editionAt(ED2, 0, Option.some("978-1")),
  rootAt(ED2, 1, "update"),
  ...unchecked([row("edition_version", ED2, 1)]),
  ...node(P1, "person", ["agent", "person"]),
  `UPDATE ontology.person SET wikidata_id = 'Q1' WHERE id = '${P1}'`,
  ...agentAt(P1, 0, "person"),
  ...node(P2, "person", ["agent"]),
  ...unchecked(agentAt(P2, 0, "person")),
  ...node(O1, "organisation", ["agent", "organisation"]),
  ...agentAt(O1, 0, "organisation"),
  ...node(V1, "volume", ["collection", "series", "volume"]),
  ...collectionAt(V1, "volume", 0, "create"),
  ...collectionAt(V1, "volume", 1, "update"),
  ...node(V2, "volume", ["collection", "series", "volume"]),
  ...collectionAt(V2, "volume", 0, "create"),
  rootAt(V2, 1, "update"),
  row("collection_version", V2, 1, "name", `'volume1'`),
  ...unchecked([row("volume_version", V2, 1, "label", `'l1'`)]),
  ...node(S1, "supplement", ["collection", "series", "supplement"]),
  ...collectionAt(S1, "supplement", 0, "create"),
  ...collectionAt(S1, "supplement", 1, "delete"),
  ...node(PA1, "pamphlet", ["collection", "pamphlet"]),
  ...collectionAt(PA1, "pamphlet", 0, "create"),
  // The live pointer: lagging, at a gapped version, cleared, and not yet arrived.
  pointAt(B1, "1"),
  pointAt(B1, "2", "now() + interval '1 day'"),
  pointAt(B2, "0"),
  pointAt(B3, "1"),
  pointAt(E1, "0"),
  pointAt(E2, "1"),
  pointAt(E2, "0"),
  pointAt(ED1, "NULL"),
]);

/** Every fixture leaf, keyed and pointer view (the fenced-tail migration rewrote seven of them). */
const FENCED_VIEWS = [
  "book_view",
  "essay_view",
  "edition_view",
  "person_view",
  "organisation_view",
  "volume_view",
  "supplement_view",
  "pamphlet_view",
  "essay_locale_view",
  "book_live_view",
  "essay_live_view",
  "essay_locale_live_view",
] as const;

const FIXTURE_LEAVES = [
  "book",
  "essay",
  "edition",
  "person",
  "organisation",
  "volume",
  "supplement",
  "pamphlet",
] as const;

/** The 0.4.0 head a leaf view keeps: `NOT EXISTS` a newer root version of its driver row. */
const releasedHead = (leaf: string) =>
  `where not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."${leaf}_version"."id") and ("newer"."version" > "ontology"."${leaf}_version"."version")))`;

/** The 0.4.0 `asOf`: its leaf view with the head bounded by `within` on the root row and on `newer`. */
const releasedAsOf = (leaf: string, within: (table: string) => string): string => {
  const view = releasedView(`${leaf}_view`);
  const head = releasedHead(leaf);
  expect(view).toContain(head);
  return Str.replace(
    head,
    `where (${within(`"ontology"."node_version"`)} and not exists (select 1 from "ontology"."node_version" "newer" where (("newer"."id" = "ontology"."${leaf}_version"."id") and ("newer"."version" > "ontology"."${leaf}_version"."version") and ${within(`"newer"`)})))`,
  )(view);
};

describe("fenced leaf views: the fixture returns exactly the 0.4.0 rows and columns", () => {
  it("for every rewritten leaf, keyed and pointer view at the head", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedFixture;
        const results = yield* Effect.forEach(
          FENCED_VIEWS,
          (view) =>
            Effect.gen(function* () {
              const oracle = releasedView(view);
              return {
                view,
                oracle,
                columns: yield* columnsOf("ontology", view),
                oracleColumns: yield* oracleColumnsOf(view, oracle),
                gapped: yield* countOf(
                  `select * from ontology.${view} where id in (${GAPPED.map((id) => `'${id}'`).join(", ")}) and version = 1`,
                ),
                ...(yield* difference(sql.raw(`select * from ontology.${view}`), oracle)),
              };
            }),
          { concurrency: 1 },
        );
        Arr.forEach(results, (result) => {
          const { view, rows, missing, extra } = result;
          // The oracle is the plain-join form; the view is the fenced one.
          expect(result.oracle, `${view}: the oracle`).not.toContain("lateral");
          expect({ view, missing, extra }).toEqual({ view, missing: 0, extra: 0 });
          expect(rows, `${view} is non-empty, so the check is not vacuous`).toBeGreaterThan(0);
          expect(result.columns, `${view}: the columns`).toEqual(result.oracleColumns);
          expect(result.gapped, `${view}: no gapped head shows`).toBe(0);
        });
      }),
    );
  });

  it("for asOf at several versions and times", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedFixture;
        const points = [
          ...Arr.map([0n, 1n, 2n], (version) => ({
            label: `version ${version}`,
            point: { version },
            within: (table: string) => `(${table}."version" <= ${version})`,
          })),
          ...Arr.map(["2026-01-15T00:00:00Z", "2026-02-15T00:00:00Z"], (iso) => ({
            label: iso,
            point: { at: date(iso) },
            within: (table: string) => `(${table}."timestamp" <= '${iso}')`,
          })),
        ];
        const results = yield* Effect.forEach(
          Arr.flatMap(FIXTURE_LEAVES, (leaf) =>
            Arr.map(points, ({ label, point, within }) => ({
              label: `${leaf} at ${label}`,
              query: sql`select * from ${ontologyViews.asOf(leaf, point)}`,
              oracle: releasedAsOf(leaf, within),
            })),
          ),
          ({ label, query, oracle }) =>
            Effect.map(difference(query, oracle), (result) => ({ label, ...result })),
          { concurrency: 1 },
        );
        Arr.forEach(results, ({ label, missing, extra }) => {
          expect({ label, missing, extra }).toEqual({ label, missing: 0, extra: 0 });
        });
        const rows = Arr.reduce(results, 0, (total, result) => total + (result.rows ?? 0));
        expect(rows, "asOf returns rows, so the check is not vacuous").toBeGreaterThan(0);
      }),
    );
  });
});

describe("fenced leaf views: fail closed", () => {
  it("drops, never NULLs, a head missing a marker, a leaf's spine row or a stable row", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedFixture;
        // Each gapped node has a complete version before the gap, so the
        // asOf just before it is a row and the head is none.
        expect(yield* countOf(`select * from ontology.book_view where id = '${B3}'`)).toBe(0);
        expect(yield* countOf(`select * from ontology.essay_view where id = '${E2}'`)).toBe(0);
        expect(yield* countOf(`select * from ontology.edition_view where id = '${ED2}'`)).toBe(0);
        expect(yield* countOf(`select * from ontology.person_view where id = '${P2}'`)).toBe(0);
        expect(yield* countOf(`select * from ontology.volume_view where id = '${V2}'`)).toBe(0);
        // The pointer at the gapped version shows nothing; at the version before, the row.
        expect(yield* countOf(`select * from ontology.book_live_view where id = '${B3}'`)).toBe(0);
        expect(yield* countOf(`select * from ontology.essay_live_view where id = '${E2}'`)).toBe(1);
        const [before] = yield* rowsOf(
          sql`select count(*)::int as n from ${ontologyViews.asOf("book", { version: 0n })} where id = ${B3}`,
        );
        expect(Number(before?.["n"])).toBe(1);
      }),
    );
  });
});

// ── Generated trees: one and three marker levels ─────────────────────────

const builders = { text: (column: string) => text(column) };
const optionalText = (column: string) =>
  dbColumn(Schema.String, { column, pg: "text", notNull: false });
const leafColumns = {
  title: dbColumn(Schema.String, { column: "title", pg: "text", notNull: true }),
};
const keyed = { name: "locale", columns: { abstract: optionalText("abstract") } };

/** Pure markers: no columns of their own, so every level is fenced by default. */
const k1Tree = defineTree({
  m1: {},
  item: { parent: "m1", leaf: leafColumns, keyed },
});

const k3Tree = defineTree({
  m1: {},
  m2: { parent: "m1" },
  m3: { parent: "m2" },
  item: { parent: "m3", leaf: leafColumns, keyed },
});

/** Markers with columns: plain joins by default, fenced when `fenced` names them. */
const k3ColumnsTree = defineTree({
  m1: { columns: { c1: optionalText("c1") } },
  m2: { parent: "m1", columns: { c2: optionalText("c2") } },
  m3: { parent: "m2", columns: { c3: optionalText("c3") } },
  item: { parent: "m3", leaf: leafColumns, keyed },
});

/** What drizzle-kit diffs: a schema module's exports, by name. */
type DrizzleModule = Parameters<typeof generateDrizzleJson>[0];

/** A generated tree: its schema, its marker levels root-most first, and the module drizzle-kit diffs. */
interface FencedTree {
  readonly schema: string;
  readonly markers: ReadonlyArray<string>;
  /** Whether marker `m<i>` carries a column `c<i>`. */
  readonly columns: boolean;
  /** The markers a leaf view joins in its fenced tail. */
  readonly tail: ReadonlyArray<string>;
  readonly module: DrizzleModule;
  readonly asOf: (point: { readonly version: bigint } | { readonly at: Date }) => SQL;
}

/** A generated tree's schema module: its tables and every view, keyed for drizzle-kit. */
const fencedTree = (
  schema: PgSchema,
  levels: Pick<FencedTree, "markers" | "columns" | "tail">,
  tables: AnyTreeTables,
  views: ReadonlyArray<readonly [string, DrizzleModule[string]]>,
  asOf: FencedTree["asOf"],
): FencedTree => ({
  schema: schema.schemaName,
  ...levels,
  module: {
    schema,
    identity: tables.root.identity,
    version: tables.root.version,
    ...R.fromEntries(R.toEntries(tables.pointers)),
    ...R.fromEntries(
      Arr.map(R.toEntries(tables.keyed), ([leaf, table]) => [`${leaf}Keyed`, table] as const),
    ),
    ...R.fromEntries(
      Arr.flatMap(R.toEntries(tables.levels), ([level, pair]) => [
        [`${level}Stable`, pair.stable] as const,
        [`${level}Version`, pair.version] as const,
      ]),
    ),
    ...R.fromEntries(views),
  },
  asOf,
});

/** The root config both generated trees share: an identity column to filter on, a `live` pointer. */
const rootConfig = { identityColumns: { scope: integer("scope") }, pointers: ["live"] } as const;

const k1Schema = pgSchema("fence_k1");
const k1Tables = makeTreeTables(k1Tree, { schema: k1Schema, builders, root: rootConfig });
const k1Views = makeTreeViews(k1Tree, k1Tables, { schema: k1Schema, pointers: { live: ["item"] } });
const K1 = fencedTree(
  k1Schema,
  { markers: ["m1"], columns: false, tail: ["m1"] },
  k1Tables,
  [
    ["itemView", k1Views.leaves.item],
    ["itemKeyedView", k1Views.keyed.item],
    ["itemLiveView", k1Views.pointers.live.leaves.item],
    ["itemKeyedLiveView", k1Views.pointers.live.keyed.item],
  ],
  (point) => sql`select * from ${k1Views.asOf("item", point)}`,
);

const k3Schema = pgSchema("fence_k3");
const k3Tables = makeTreeTables(k3Tree, { schema: k3Schema, builders, root: rootConfig });
const k3Views = makeTreeViews(k3Tree, k3Tables, { schema: k3Schema, pointers: { live: ["item"] } });
const K3 = fencedTree(
  k3Schema,
  { markers: ["m1", "m2", "m3"], columns: false, tail: ["m1", "m2", "m3"] },
  k3Tables,
  [
    ["itemView", k3Views.leaves.item],
    ["itemKeyedView", k3Views.keyed.item],
    ["itemLiveView", k3Views.pointers.live.leaves.item],
    ["itemKeyedLiveView", k3Views.pointers.live.keyed.item],
  ],
  (point) => sql`select * from ${k3Views.asOf("item", point)}`,
);

const k3cSchema = pgSchema("fence_k3c");
const k3cTables = makeTreeTables(k3ColumnsTree, { schema: k3cSchema, builders, root: rootConfig });
const k3cViews = makeTreeViews(k3ColumnsTree, k3cTables, {
  schema: k3cSchema,
  pointers: { live: ["item"] },
  fenced: ["m2", "m3"],
});
const K3C = fencedTree(
  k3cSchema,
  { markers: ["m1", "m2", "m3"], columns: true, tail: ["m2", "m3"] },
  k3cTables,
  [
    ["itemView", k3cViews.leaves.item],
    ["itemKeyedView", k3cViews.keyed.item],
    ["itemLiveView", k3cViews.pointers.live.leaves.item],
    ["itemKeyedLiveView", k3cViews.pointers.live.keyed.item],
  ],
  (point) => sql`select * from ${k3cViews.asOf("item", point)}`,
);

/** The 0.4.0 shape of a generated tree's view, written out: every level a plain INNER JOIN. */
const releasedForm = (
  tree: FencedTree,
  options: {
    readonly keyed?: boolean;
    readonly pointer?: boolean;
    readonly within?: (table: string) => string;
  },
): string => {
  const s = tree.schema;
  const levels = [...tree.markers];
  const key = (alias: string, on: string) =>
    `${alias}.id = ${on}.id and ${alias}.version = ${on}.${options.pointer === true ? "pointer_version" : "version"}`;
  const driver = options.pointer === true ? "p" : "lv";
  const from =
    options.pointer === true
      ? `(select distinct on (id) id, version as pointer_version, at from ${s}.live_pointer where at <= now() order by id, seq desc) p join ${s}.item_version lv on ${key("lv", "p")}`
      : `${s}.item_version lv`;
  const within = options.within ?? (() => "true");
  const head = options.pointer === true ? "h" : "lv";
  return [
    `select nv.id, nv.version, ${options.pointer === true ? "h" : "nv"}.action, n.scope,`,
    ...(tree.columns ? Arr.map(levels, (level, i) => `${level}.c${i + 1},`) : []),
    `lv.title,`,
    options.keyed === true ? `k.locale, k.abstract,` : "",
    `nv."timestamp", v0."timestamp" as created_at`,
    options.pointer === true ? `, p.at as live_at` : "",
    `from ${from}`,
    `join ${s}.node_version nv on ${key("nv", driver)}`,
    `join ${s}.node n on n.id = ${driver}.id`,
    ...Arr.map(levels, (level) => `join ${s}.${level}_version ${level} on ${key(level, driver)}`),
    options.keyed === true ? `left join ${s}.item_locale k on ${key("k", driver)}` : "",
    options.pointer === true ? `join ${s}.node_version h on h.id = p.id` : "",
    `join ${s}.node_version v0 on v0.id = ${driver}.id and v0.version = 0`,
    `where ${within("nv")} and not exists (select 1 from ${s}.node_version newer where newer.id = ${head}.id and newer.version > ${head}.version and ${within("newer")})`,
  ].join(" ");
};

/** drizzle-kit could not diff a generated tree's schema module. */
class FencedSchemaError extends Schema.TaggedError<FencedSchemaError>()("FencedSchemaError", {
  cause: Schema.Defect(),
}) {}

const fencedId = (g: string) => `('00000000-0000-4000-b000-' || lpad((${g})::text, 12, '0'))::uuid`;

/** `n`th of a generated tree's irregular nodes, clear of the generated ones. */
const oddId = (n: number) => `00000000-0000-4000-b000-1000000000${String(n).padStart(2, "0")}`;
const NO_MARKER = oddId(1); // v1 skips the bottom marker (the top one at K = 1)
const NO_LEAF = oddId(3); // v1 skips the leaf

const TITLE_INDEX = "fence_item_title";
const CREATED_INDEX = "fence_node_version_timestamp";
const SCOPE_INDEX = "fence_node_scope";
const MARKER_INDEX = "fence_m1_c1";

/**
 * A generated tree's DDL, then `nodes` nodes at two versions (every tenth
 * deleted at its head), locales on some, the `live` pointer on most, the
 * irregular nodes above, a parent table of 10,000 rows pointing at the
 * items, the three indexes the plan specs read, and `ANALYZE`.
 */
const seedTree = Effect.fn("leafFence.seedTree")(function* (tree: FencedTree, nodes: number) {
  const ddl = yield* Effect.tryPromise({
    try: async () =>
      generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(tree.module)),
    catch: (cause) => new FencedSchemaError({ cause }),
  });
  const s = tree.schema;
  const levels = [...tree.markers, "item"];
  const bottom = tree.markers[tree.markers.length - 1] ?? "m1";
  const levelRow = (level: string, id: string, v: number) =>
    level === "item"
      ? `INSERT INTO ${s}.item_version (id, version, title) VALUES ('${id}', ${v}, 'odd${v}')`
      : `INSERT INTO ${s}.${level}_version (id, version) VALUES ('${id}', ${v})`;
  const odd = (id: string, stable: ReadonlyArray<string>, atOne: ReadonlyArray<string>) => [
    `INSERT INTO ${s}.node (id, type, scope) VALUES ('${id}', 'item', 1)`,
    ...Arr.map(stable, (level) => `INSERT INTO ${s}.${level} (id, type) VALUES ('${id}', 'item')`),
    `INSERT INTO ${s}.node_version (id, version, action) VALUES ('${id}', 0, 'create'), ('${id}', 1, 'update')`,
    ...Arr.map(levels, (level) => levelRow(level, id, 0)),
    ...Arr.map(atOne, (level) => levelRow(level, id, 1)),
    `INSERT INTO ${s}.live_pointer (id, version) VALUES ('${id}', 1)`,
  ];
  yield* execAll([
    ...ddl,
    `CREATE TEMPORARY TABLE fence_ids ON COMMIT DROP AS SELECT g, ${fencedId("g")} AS id FROM generate_series(1, ${nodes}) g`,
    `INSERT INTO ${s}.node (id, type, scope) SELECT id, 'item', g % 100 FROM fence_ids`,
    ...Arr.map(
      levels,
      (level) => `INSERT INTO ${s}.${level} (id, type) SELECT id, 'item' FROM fence_ids`,
    ),
    `INSERT INTO ${s}.node_version (id, version, action, timestamp) SELECT id, v, CASE WHEN v = 0 THEN 'create' WHEN g % 10 = 0 THEN 'delete' ELSE 'update' END, timestamptz '2026-01-01' + (g * 2 + v) * interval '1 second' FROM fence_ids, generate_series(0, 1) v`,
    ...Arr.map(tree.markers, (level, i) =>
      tree.columns
        ? `INSERT INTO ${s}.${level}_version (id, version, c${i + 1}) SELECT id, v, CASE WHEN g % 7 = 0 THEN NULL ELSE '${level}-' || lpad(((g * 31) % ${nodes})::text, 6, '0') || '-' || v END FROM fence_ids, generate_series(0, 1) v`
        : `INSERT INTO ${s}.${level}_version (id, version) SELECT id, v FROM fence_ids, generate_series(0, 1) v`,
    ),
    `INSERT INTO ${s}.item_version (id, version, title) SELECT id, v, 'title ' || lpad(((g * 7919) % ${nodes})::text, 6, '0') || '-' || v FROM fence_ids, generate_series(0, 1) v`,
    `INSERT INTO ${s}.item_locale (id, version, locale, abstract) SELECT id, 1, l, l || g FROM fence_ids, unnest(ARRAY['en', 'fr']) l WHERE g % 3 = 0`,
    `INSERT INTO ${s}.item_locale (id, version, locale, abstract) SELECT id, 0, 'en', NULL FROM fence_ids WHERE g % 3 = 1`,
    `INSERT INTO ${s}.live_pointer (id, version, at) SELECT id, CASE WHEN g % 4 = 2 THEN NULL ELSE g % 2 END, now() - interval '1 day' FROM fence_ids WHERE g % 4 <> 3`,
    `INSERT INTO ${s}.live_pointer (id, version, at) SELECT id, 1, now() + interval '1 day' FROM fence_ids WHERE g % 8 = 0`,
    ...unchecked([
      ...odd(
        NO_MARKER,
        levels,
        Arr.filter(levels, (level) => level !== bottom),
      ),
      ...odd(NO_LEAF, levels, tree.markers),
    ]),
    `CREATE TEMPORARY TABLE fence_parent ON COMMIT DROP AS SELECT g AS id, ${fencedId(`1 + (g * 13) % ${nodes}`)} AS item_id FROM generate_series(1, 10000) g`,
    `ALTER TABLE fence_parent ADD PRIMARY KEY (id)`,
    `CREATE INDEX ${TITLE_INDEX} ON ${s}.item_version (title, id)`,
    `CREATE INDEX ${CREATED_INDEX} ON ${s}.node_version (timestamp)`,
    `CREATE INDEX ${SCOPE_INDEX} ON ${s}.node (scope)`,
    ...(tree.columns ? [`CREATE INDEX ${MARKER_INDEX} ON ${s}.m1_version (c1, id)`] : []),
    `ANALYZE`,
  ]);
});

const TREES = [K1, K3, K3C] as const;
const ODD = [NO_MARKER, NO_LEAF] as const;

describe("fenced leaf views: generated trees return exactly the 0.4.0 shape's rows and columns", () => {
  it.each(TREES)("$schema: leaf, keyed and pointer views at the head, and asOf", async (tree) => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedTree(tree, 300);
        const s = tree.schema;
        const odd = ODD.map((id) => `'${id}'`).join(", ");
        const cases = [
          { view: "item_view", oracle: releasedForm(tree, {}) },
          { view: "item_locale_view", oracle: releasedForm(tree, { keyed: true }) },
          { view: "item_live_view", oracle: releasedForm(tree, { pointer: true }) },
          {
            view: "item_locale_live_view",
            oracle: releasedForm(tree, { keyed: true, pointer: true }),
          },
        ];
        const results = yield* Effect.forEach(
          cases,
          ({ view, oracle }) =>
            Effect.gen(function* () {
              return {
                view,
                columns: yield* columnsOf(s, view),
                oracleColumns: yield* oracleColumnsOf(`${s}_${view}`, oracle),
                odd: yield* countOf(`select * from ${s}.${view} where id in (${odd})`),
                oracleOdd: yield* countOf(`select * from (${oracle}) o where id in (${odd})`),
                ...(yield* difference(sql.raw(`select * from ${s}.${view}`), oracle)),
              };
            }),
          { concurrency: 1 },
        );
        Arr.forEach(results, (result) => {
          const { view, rows, missing, extra } = result;
          expect({ view, missing, extra }).toEqual({ view, missing: 0, extra: 0 });
          expect(rows, `${view} is non-empty`).toBeGreaterThan(0);
          expect(result.columns, `${view}: the columns`).toEqual(result.oracleColumns);
          // Fail closed: the gapped heads show in neither form.
          expect({ view, odd: result.odd, oracleOdd: result.oracleOdd }).toEqual({
            view,
            odd: 0,
            oracleOdd: 0,
          });
        });
        const points = [
          {
            label: "version 0",
            point: { version: 0n },
            within: (t: string) => `${t}.version <= 0`,
          },
          {
            label: "version 1",
            point: { version: 1n },
            within: (t: string) => `${t}.version <= 1`,
          },
          {
            label: "a time between versions",
            point: { at: date("2026-01-01T00:05:00Z") },
            within: (t: string) => `${t}."timestamp" <= '2026-01-01T00:05:00Z'`,
          },
        ];
        const asOf = yield* Effect.forEach(
          points,
          ({ label, point, within }) =>
            Effect.map(difference(tree.asOf(point), releasedForm(tree, { within })), (result) => ({
              label,
              ...result,
            })),
          { concurrency: 1 },
        );
        Arr.forEach(asOf, ({ label, rows, missing, extra }) => {
          expect({ label, missing, extra }).toEqual({ label, missing: 0, extra: 0 });
          expect(rows, `asOf ${label} is non-empty`).toBeGreaterThan(0);
        });
      }),
    );
  });
});

// ── Plans ────────────────────────────────────────────────────────────────

const PLAN_NODES = 50000;

/** Every relation a plan node scans, by alias, in its subtree outside subplans. */
const aliasesUnder = (plan: PlanNode): ReadonlyArray<string> =>
  Arr.flatMap(joinedNodes(plan), (n) =>
    n["Relation Name"] === undefined ? [] : [n.Alias ?? n["Relation Name"]],
  );

/** Every node of a plan tree outside subplans. */
const subtrees = (plan: PlanNode): ReadonlyArray<PlanNode> => joinedNodes(plan);

/** A plan's sequential scans. */
const seqScans = (nodes: ReadonlyArray<PlanNode>) =>
  Arr.filter(nodes, (n) => n["Node Type"] === "Seq Scan");

/** A plan's full sorts (an Incremental Sort on a presorted prefix is not one). */
const sorts = (nodes: ReadonlyArray<PlanNode>) =>
  Arr.filter(nodes, (n) => n["Node Type"] === "Sort");

/** Whether a plan scans `index`. */
const uses = (nodes: ReadonlyArray<PlanNode>, index: string) =>
  Arr.some(nodes, (n) => n["Index Name"] === index);

/**
 * Whether the tail's tables form one subtree of `query`'s plan holding
 * nothing else, and the relations it joins outside that subtree: the
 * structural pin that keeps planning flat.
 */
const outsideTail = Effect.fn("leafFence.outsideTail")(function* (tree: FencedTree, query: string) {
  const tail = Arr.map(tree.tail, (level) => `${level}_version`);
  const [root] = yield* explainRoot(query);
  const plan = root ?? { "Node Type": "none" };
  const all = aliasesUnder(plan);
  const unit = Arr.findFirst(subtrees(plan), (n) => {
    const under = aliasesUnder(n);
    return under.length === tail.length && Arr.every(tail, (t) => Arr.contains(under, t));
  });
  return {
    unit: Option.isSome(unit),
    outside: Arr.filter(all, (alias) => !Arr.contains(tail, alias)),
  };
});

describe("fenced leaf views: plans at three marker levels and 50,000 rows", () => {
  it("are index-driven for a page, a created_at sort, an identity filter and a join on id, with the tail joined as one unit", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedTree(K3, PLAN_NODES);
        const view = `${K3.schema}.item_view`;
        // A page walks the leaf's own index: no Sort.
        const pageQuery = `SELECT * FROM ${view} ORDER BY title, id LIMIT 20`;
        const page = yield* explain(pageQuery);
        expect(uses(page, TITLE_INDEX)).toBe(true);
        expect(sorts(page)).toEqual([]);

        // created_at is the birth row's: version_zero stays a plain join, so
        // the root version's timestamp index drives the sort.
        const created = yield* explain(
          `SELECT * FROM ${view} ORDER BY created_at DESC, id LIMIT 20`,
        );
        expect(uses(created, CREATED_INDEX)).toBe(true);
        expect(sorts(created)).toEqual([]);

        // An identity column filter and a join from another table on id: no sequential scan.
        expect(
          seqScans(
            yield* explain(`SELECT * FROM ${view} WHERE scope = 42 ORDER BY title, id LIMIT 20`),
          ),
        ).toEqual([]);
        const join = yield* explain(
          `SELECT p.id AS parent, v.* FROM fence_parent p JOIN ${view} v ON v.id = p.item_id WHERE p.id BETWEEN 1 AND 20`,
        );
        expect(Arr.filter(seqScans(join), (n) => n["Relation Name"] !== "fence_parent")).toEqual(
          [],
        );

        // The structural pin that keeps planning flat: the tail's tables
        // form one subtree holding nothing else, and outside it the planner
        // joins at most the driver, the root version, the identity, the
        // birth row and the anti-join's `newer`.
        const pin = yield* outsideTail(K3, pageQuery);
        expect(pin.unit, `the tail is one subtree; outside: ${pin.outside.join(", ")}`).toBe(true);
        expect(pin.outside.length).toBeLessThanOrEqual(5);
      }),
    );
  });

  it("keep a column-bearing marker a plain join that drives a page, and fence only the levels `fenced` names", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedTree(K3C, PLAN_NODES);
        const query = `SELECT * FROM ${K3C.schema}.item_view ORDER BY c1, id LIMIT 20`;
        const page = yield* explain(query);
        expect(uses(page, MARKER_INDEX)).toBe(true);
        expect(sorts(page)).toEqual([]);
        // The driver, root version, identity, birth row, newer and m1.
        const pin = yield* outsideTail(K3C, query);
        expect(pin.unit, `the tail is one subtree; outside: ${pin.outside.join(", ")}`).toBe(true);
        expect(pin.outside.length).toBeLessThanOrEqual(6);
      }),
    );
  });
});
