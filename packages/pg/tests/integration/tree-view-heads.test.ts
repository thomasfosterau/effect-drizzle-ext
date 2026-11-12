/**
 * How the views `makeTreeViews` derives resolve a node's head, proven against
 * PostgreSQL (effect-drizzle-ext#199): every view keeps head rows with an
 * anti-join on the root version key (`NOT EXISTS` a newer root version), not
 * a grouped `max(version)`.
 *
 * - **Equivalence.** Over mixed histories (multi-version nodes, a head moved
 *   to another leaf, deleted, restored-after-delete, and gaps at a level),
 *   every view kind (leaf, branch, keyed, pointer) and `asOf` at several
 *   versions and times return exactly the rows the previous definitions did.
 *   The oracle is those definitions themselves: each view's last
 *   `CREATE VIEW` in the fixture chain before the anti-join migration, read
 *   from the committed migrations, and for `asOf` that leaf view with its
 *   `max` head bounded the way the old `asOf` bounded it.
 * - **Behaviour.** A head moved to another leaf leaves the old leaf's view and
 *   joins the new one; a deleted head shows with `action = 'delete'` on the
 *   leaf, branch, keyed and pointer views; `asOf` before the move or delete
 *   returns the old row.
 * - **Plans.** A leaf view's paged list uses the leaf's index with no
 *   aggregate over the root version table; a branch view's paged list uses
 *   the branch level's index with no Sort (effect-drizzle-ext#200), and it and
 *   a keyed lookup run no aggregate either.
 *
 * The branch views' own single-driver equivalence (against their `UNION ALL`
 * form) is `tree-branch-views.test.ts`.
 *
 * @module packages/pg/tests/integration/tree-view-heads
 */

import { sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { integrationDatabaseLayer } from "./database-url.ts";
import { aggregates, viewOracle, viewsBefore } from "./view-oracle.ts";
import { makePgDatabase } from "../../src/index.ts";
import { makeTestTransaction } from "../../src/testing.ts";
import { ontologyViews } from "../fixtures/schema.ts";

const database = makePgDatabase({ relations: {}, key: "Database" });
const { CurrentTransaction } = database;
const { difference, execAll, explain } = viewOracle(database);

const runtime = ManagedRuntime.make(integrationDatabaseLayer(database));
const { runInTestTransaction } = makeTestTransaction(database);

/** The migration that replaced the `max` head with the anti-join. */
const ANTI_JOIN_MIGRATION = "20261112160706_view-head-antijoin";

/** The `max` head every pre-#199 view drove its FROM from. */
const MAX_HEAD = `from "ontology"."node_version" group by "ontology"."node_version"."id"`;

/**
 * Each fixture view's definition as it stood before the anti-join: its last
 * `CREATE VIEW` in the chain before {@link ANTI_JOIN_MIGRATION}, as the
 * `(select …)` body. Read once from the committed migrations.
 */
let trunkViews: Readonly<Record<string, string>> = {};

beforeAll(async () => {
  trunkViews = await viewsBefore(ANTI_JOIN_MIGRATION);
});

afterAll(() => runtime.dispose());

/**
 * A view's pre-#199 definition; empty for a view the chain never defined, which
 * the specs' `toContain` on the old `max` head then reports.
 */
const trunkView = (name: string): string => Option.getOrElse(R.get(trunkViews, name), () => "");

/** The pre-#199 `asOf`: the trunk leaf view with its `max` head bounded by `where`. */
const trunkAsOf = (leaf: string, where: string): string => {
  const view = trunkView(`${leaf}_view`);
  expect(view).toContain(MAX_HEAD);
  return Str.replace(
    MAX_HEAD,
    `from "ontology"."node_version" where ${where} group by "ontology"."node_version"."id"`,
  )(view);
};

/** `n`th id of this file's fixed nodes (`…-8000-0000000003nn`), clear of the other specs'. */
const idOf = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;

const B1 = idOf(1); // book, three versions
const B2 = idOf(2); // book, deleted head
const B3 = idOf(3); // book, deleted then restored
const B4 = idOf(4); // book, v1 skips the leaf (fails closed)
const B5 = idOf(5); // book, v1 skips the work spine and the leaf
const E1 = idOf(6); // essay, two locales then one
const E2 = idOf(7); // essay, no locale; its pointer cleared
const E3 = idOf(8); // essay, deleted head carrying a locale
const ED1 = idOf(9); // edition, isbn fact then none
const P1 = idOf(10); // person refined to organisation (old leaf rows cascade away)
const P2 = idOf(11); // person moved to organisation, old leaf rows surviving
const P3 = idOf(12); // person, plain
const O1 = idOf(13); // organisation, plain
const B6 = idOf(14); // book, v1 and v2 share one timestamp
const B7 = idOf(15); // book, v1 backdated to before v0

/** Version `v`'s timestamp: the first of month `v + 1` of 2026. */
const at = (v: number) => `2026-${String(v + 1).padStart(2, "0")}-01T00:00:00Z`;

const node = (id: string, type: string, stable: ReadonlyArray<string>) => [
  `INSERT INTO ontology.node (id, type) VALUES ('${id}', '${type}')`,
  ...Arr.map(
    stable,
    (table) => `INSERT INTO ontology.${table} (id, type) VALUES ('${id}', '${type}')`,
  ),
];

const root = (id: string, v: number, action: string, when = at(v)) =>
  `INSERT INTO ontology.node_version (id, version, action, timestamp) VALUES ('${id}', ${v}, '${action}', '${when}')`;

const row = (table: string, id: string, v: number, extra = "") => {
  const [columns, values] = Str.isNonEmpty(extra) ? extra.split("|") : ["", ""];
  return `INSERT INTO ontology.${table} (id, version${columns ? `, ${columns}` : ""}) VALUES ('${id}', ${v}${values ? `, ${values}` : ""})`;
};

/** A full book version: the root, the work spine and the leaf. */
const bookAt = (id: string, v: number, action: string, when = at(v)) => [
  root(id, v, action, when),
  row("work_version", id, v, `title|'b${v}'`),
  row("book_version", id, v, `pages|${100 + v}`),
];

const essayAt = (id: string, v: number, action: string, locales: ReadonlyArray<string>) => [
  root(id, v, action),
  row("work_version", id, v, `title|'e${v}'`),
  row("essay_version", id, v),
  ...Arr.map(locales, (locale) =>
    row("essay_locale", id, v, `locale, abstract|'${locale}', '${locale}${v}'`),
  ),
];

const agentAt = (id: string, v: number, action: string, leaf: string) => [
  root(id, v, action),
  row("agent_version", id, v),
  row(`${leaf}_version`, id, v),
];

const pointAt = (id: string, version: string, when = "now()") =>
  `INSERT INTO ontology.live_pointer (id, version, at) VALUES ('${id}', ${version}, ${when})`;

/** The timestamp B6's v1 and v2 share. */
const TIE = "2026-02-10T00:00:00Z";
/** B7's v0, and its v1 backdated to before it. */
const BACKDATED_V0 = "2026-02-20T00:00:00Z";
const BACKDATED_V1 = "2026-01-10T00:00:00Z";

/** The mixed histories every equivalence check reads. */
const seedHistories = execAll([
  ...node(B1, "book", ["work", "book"]),
  ...bookAt(B1, 0, "create"),
  ...bookAt(B1, 1, "update"),
  ...bookAt(B1, 2, "update"),
  ...node(B2, "book", ["work", "book"]),
  ...bookAt(B2, 0, "create"),
  ...bookAt(B2, 1, "delete"),
  ...node(B3, "book", ["work", "book"]),
  ...bookAt(B3, 0, "create"),
  ...bookAt(B3, 1, "delete"),
  ...bookAt(B3, 2, "update"),
  ...node(B4, "book", ["work", "book"]),
  ...bookAt(B4, 0, "create"),
  root(B4, 1, "update"),
  row("work_version", B4, 1, `title|'b1'`),
  ...node(B5, "book", ["work", "book"]),
  ...bookAt(B5, 0, "create"),
  root(B5, 1, "update"),
  // Timestamps that do not rise with the version: the head is the highest
  // version among those at or before the point, not the latest timestamp.
  ...node(B6, "book", ["work", "book"]),
  ...bookAt(B6, 0, "create"),
  ...bookAt(B6, 1, "update", TIE),
  ...bookAt(B6, 2, "update", TIE),
  ...node(B7, "book", ["work", "book"]),
  ...bookAt(B7, 0, "create", BACKDATED_V0),
  ...bookAt(B7, 1, "update", BACKDATED_V1),
  ...node(E1, "essay", ["work", "essay"]),
  ...essayAt(E1, 0, "create", ["en", "fr"]),
  ...essayAt(E1, 1, "update", ["en"]),
  ...node(E2, "essay", ["work", "essay"]),
  ...essayAt(E2, 0, "create", []),
  ...node(E3, "essay", ["work", "essay"]),
  ...essayAt(E3, 0, "create", ["en"]),
  ...essayAt(E3, 1, "delete", ["en"]),
  ...node(ED1, "edition", ["manifestation", "edition"]),
  root(ED1, 0, "create"),
  row("manifestation_version", ED1, 0),
  row("manifestation_isbn", ED1, 0, `isbn|'978-0'`),
  row("edition_version", ED1, 0),
  root(ED1, 1, "update"),
  row("manifestation_version", ED1, 1),
  row("edition_version", ED1, 1),
  // A refine through the schema: the person stable row (and, cascading,
  // its versions) goes, the root type flips down the refinable agent
  // branch, and the next version is the organisation's.
  ...node(P1, "person", ["agent", "person"]),
  ...agentAt(P1, 0, "create", "person"),
  `DELETE FROM ontology.person WHERE id = '${P1}'`,
  `UPDATE ontology.node SET type = 'organisation' WHERE id = '${P1}'`,
  `INSERT INTO ontology.organisation (id, type) VALUES ('${P1}', 'organisation')`,
  ...agentAt(P1, 1, "update", "organisation"),
  // A head moved to another leaf with the old leaf's rows surviving: the
  // shape a refine leaves where the old leaf's rows are kept. The fixture's
  // `(id, type)` arcs forbid it, so the one stable row that breaks them is
  // written with foreign-key triggers off for that statement.
  ...node(P2, "person", ["agent", "person"]),
  ...agentAt(P2, 0, "create", "person"),
  `SET LOCAL session_replication_role = replica`,
  `INSERT INTO ontology.organisation (id, type) VALUES ('${P2}', 'organisation')`,
  `SET LOCAL session_replication_role = origin`,
  ...agentAt(P2, 1, "update", "organisation"),
  ...node(P3, "person", ["agent", "person"]),
  ...agentAt(P3, 0, "create", "person"),
  ...node(O1, "organisation", ["agent", "organisation"]),
  ...agentAt(O1, 0, "create", "organisation"),
  // The live pointer: lagging, at a deleted / restored / gapped head, a
  // keyed leaf, a cleared fact, and a fact whose `at` has not arrived.
  pointAt(B1, "1"),
  pointAt(B1, "2", "now() + interval '1 day'"),
  pointAt(B2, "0"),
  pointAt(B3, "0"),
  pointAt(B3, "2"),
  pointAt(B4, "0"),
  pointAt(B5, "0"),
  pointAt(E1, "0"),
  pointAt(E2, "0"),
  pointAt(E2, "NULL"),
  pointAt(E3, "0"),
]);

/** Every view the fixture derives, by its database name. */
const VIEWS = [
  "book_view",
  "essay_view",
  "edition_view",
  "person_view",
  "organisation_view",
  "work_view",
  "essay_locale_view",
  "book_live_view",
  "essay_live_view",
  "essay_locale_live_view",
] as const;

const LEAVES = ["book", "essay", "edition", "person", "organisation"] as const;

type Leaf = (typeof LEAVES)[number];

/**
 * `asOf` points: before any version, at each version, past the last; and times
 * between them, at the tied timestamp and after the backdated ones. Each names
 * the leaves it must return rows for; every other leaf must return none.
 */
const VERSION_POINTS: ReadonlyArray<{
  readonly version: bigint;
  readonly nonEmpty: ReadonlyArray<Leaf>;
}> = [
  { version: 0n, nonEmpty: LEAVES },
  { version: 1n, nonEmpty: LEAVES },
  { version: 2n, nonEmpty: LEAVES },
  { version: 5n, nonEmpty: LEAVES },
];
const TIME_POINTS: ReadonlyArray<{ readonly iso: string; readonly nonEmpty: ReadonlyArray<Leaf> }> =
  [
    { iso: "2025-12-31T00:00:00Z", nonEmpty: [] }, // before any version
    { iso: "2026-01-15T00:00:00Z", nonEmpty: LEAVES }, // B7's backdated v1 only
    { iso: "2026-02-01T00:00:00Z", nonEmpty: LEAVES },
    { iso: TIE, nonEmpty: LEAVES }, // exactly B6's tied v1 and v2
    { iso: "2026-02-15T00:00:00Z", nonEmpty: LEAVES },
    { iso: "2026-02-25T00:00:00Z", nonEmpty: LEAVES }, // B7 has both versions, v0 later in time
    { iso: "2026-03-15T00:00:00Z", nonEmpty: LEAVES },
  ];

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

describe("view heads: the anti-join returns exactly the max head's rows", () => {
  it("for every view kind at the head", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        const results = yield* Effect.forEach(
          VIEWS,
          (view) =>
            Effect.map(
              difference(sql.raw(`select * from ontology.${view}`), trunkView(view)),
              (result) => [view, result] as const,
            ),
          { concurrency: 1 },
        );
        Arr.forEach(results, ([view, { rows, missing, extra }]) => {
          // The oracle really is the old, grouped-max form; the view is not.
          expect(trunkView(view)).toContain(`max("version") as "head_version"`);
          expect({ view, missing, extra }).toEqual({ view, missing: 0, extra: 0 });
          expect(rows, `${view} is non-empty, so the check is not vacuous`).toBeGreaterThan(0);
        });
      }),
    );
  });

  it("for asOf at several versions and times", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        const byVersion = Arr.flatMap(LEAVES, (leaf) =>
          Arr.map(VERSION_POINTS, ({ version, nonEmpty }) => ({
            expectNonEmpty: Arr.contains(nonEmpty, leaf),
            label: `${leaf} at version ${version}`,
            query: sql`select * from ${ontologyViews.asOf(leaf, { version })}`,
            oracle: trunkAsOf(leaf, `"ontology"."node_version"."version" <= ${version}`),
          })),
        );
        const byTime = Arr.flatMap(LEAVES, (leaf) =>
          Arr.map(TIME_POINTS, ({ iso, nonEmpty }) => ({
            expectNonEmpty: Arr.contains(nonEmpty, leaf),
            label: `${leaf} at ${iso}`,
            query: sql`select * from ${ontologyViews.asOf(leaf, { at: date(iso) })}`,
            oracle: trunkAsOf(leaf, `"ontology"."node_version"."timestamp" <= '${iso}'`),
          })),
        );
        const results = yield* Effect.forEach(
          [...byVersion, ...byTime],
          ({ label, query, oracle, expectNonEmpty }) =>
            Effect.map(difference(query, oracle), (result) => ({
              label,
              expectNonEmpty,
              ...result,
            })),
          { concurrency: 1 },
        );
        Arr.forEach(results, ({ label, rows, missing, extra, expectNonEmpty }) => {
          expect({ label, missing, extra }).toEqual({ label, missing: 0, extra: 0 });
          // Per point, so an empty == empty comparison cannot pass silently.
          expect({ label, nonEmpty: (rows ?? 0) > 0 }).toEqual({ label, nonEmpty: expectNonEmpty });
        });
        // Tied versions: both are at the point, the higher is the head.
        expect(yield* asOfHeads("book", { at: date(TIE) }, B6)).toEqual([[2, "update"]]);
        // Backdated: v1 alone is visible, then both, and v1 is the head either way.
        expect(yield* asOfHeads("book", { at: date("2026-01-15T00:00:00Z") }, B7)).toEqual([
          [1, "update"],
        ]);
        expect(yield* asOfHeads("book", { at: date("2026-02-25T00:00:00Z") }, B7)).toEqual([
          [1, "update"],
        ]);
      }),
    );
  });
});

/** `view`'s `(id, version, action)` rows for `id`, ordered. */
const headsOf = Effect.fn("viewHeads.headsOf")(function* (view: string, id: string) {
  const tx = yield* CurrentTransaction;
  const result = yield* tx.execute<{ readonly version: string; readonly action: string }>(
    sql.raw(
      `SELECT version::text AS version, action FROM ontology.${view} WHERE id = '${id}' ORDER BY version`,
    ),
  );
  return Arr.map(result.rows, (r) => [Number(r.version), r.action] as const);
});

/** `asOf(leaf, point)`'s `(version, action)` rows for `id`. */
const asOfHeads = Effect.fn("viewHeads.asOfHeads")(function* (
  leaf: (typeof LEAVES)[number],
  point: Parameters<typeof ontologyViews.asOf>[1],
  id: string,
) {
  const tx = yield* CurrentTransaction;
  const result = yield* tx.execute<{ readonly version: string; readonly action: string }>(
    sql`select version::text as version, action from ${ontologyViews.asOf(leaf, point)} where id = ${id}`,
  );
  return Arr.map(result.rows, (r) => [Number(r.version), r.action] as const);
});

describe("view heads: behaviour", () => {
  it("drops a node whose head moved to another leaf from the old leaf's view, and shows it in the new", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        // Old leaf rows surviving at v0: a newer root version supersedes them.
        expect(yield* headsOf("person_view", P2)).toEqual([]);
        expect(yield* headsOf("organisation_view", P2)).toEqual([[1, "update"]]);
        // A refine through the schema.
        expect(yield* headsOf("person_view", P1)).toEqual([]);
        expect(yield* headsOf("organisation_view", P1)).toEqual([[1, "update"]]);
        // asOf before the move returns the old leaf's row.
        expect(yield* asOfHeads("person", { version: 0n }, P2)).toEqual([[0, "create"]]);
        expect(yield* asOfHeads("person", { at: date("2026-01-15T00:00:00Z") }, P2)).toEqual([
          [0, "create"],
        ]);
        expect(yield* asOfHeads("organisation", { version: 0n }, P2)).toEqual([]);
      }),
    );
  });

  it("shows a deleted head with action 'delete' on the leaf, branch, keyed and pointer views", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        expect(yield* headsOf("book_view", B2)).toEqual([[1, "delete"]]);
        expect(yield* headsOf("work_view", B2)).toEqual([[1, "delete"]]);
        expect(yield* headsOf("work_view", E3)).toEqual([[1, "delete"]]);
        expect(yield* headsOf("essay_locale_view", E3)).toEqual([[1, "delete"]]);
        // The pointer names v0; `action` is the head's, so the tombstone shows.
        expect(yield* headsOf("book_live_view", B2)).toEqual([[0, "delete"]]);
        expect(yield* headsOf("essay_live_view", E3)).toEqual([[0, "delete"]]);
        expect(yield* headsOf("essay_locale_live_view", E3)).toEqual([[0, "delete"]]);
        // Restored after the delete: the head is an update again.
        expect(yield* headsOf("book_view", B3)).toEqual([[2, "update"]]);
        expect(yield* headsOf("book_live_view", B3)).toEqual([[2, "update"]]);
        // asOf before the delete returns the live row.
        expect(yield* asOfHeads("book", { version: 0n }, B2)).toEqual([[0, "create"]]);
        expect(yield* asOfHeads("book", { at: date("2026-01-15T00:00:00Z") }, B2)).toEqual([
          [0, "create"],
        ]);
        expect(yield* asOfHeads("book", { version: 1n }, B3)).toEqual([[1, "delete"]]);
      }),
    );
  });

  it("fails closed on a head that skipped a level, and resolves the version before it with asOf", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedHistories;
        expect(yield* headsOf("book_view", B4)).toEqual([]);
        expect(yield* headsOf("book_view", B5)).toEqual([]);
        expect(yield* headsOf("work_view", B5)).toEqual([]);
        // B4's v1 reached the work spine, but each arm joins its leaf too.
        expect(yield* headsOf("work_view", B4)).toEqual([]);
        // The pointer at v0 still resolves, `action` read off the gapped head.
        expect(yield* headsOf("book_live_view", B4)).toEqual([[0, "update"]]);
        expect(yield* asOfHeads("book", { version: 0n }, B4)).toEqual([[0, "create"]]);
      }),
    );
  });
});

// ── Plans ────────────────────────────────────────────────────────────────

const PROBE_INDEX = "work_version_title_probe";

/**
 * A few thousand nodes, generated in SQL so the planner sees a table worth
 * an index: 3,000 books at two versions, 500 essays with two locales each,
 * the ordering index a consumer's paged list would add, and fresh stats.
 */
const seedVolume = execAll([
  `CREATE TEMPORARY TABLE probe_ids ON COMMIT DROP AS SELECT g, ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid AS id, CASE WHEN g <= 3000 THEN 'book' ELSE 'essay' END AS leaf FROM generate_series(1, 3500) g`,
  `INSERT INTO ontology.node (id, type) SELECT id, leaf FROM probe_ids`,
  `INSERT INTO ontology.node_version (id, version, action) SELECT id, v, CASE v WHEN 0 THEN 'create' ELSE 'update' END FROM probe_ids, generate_series(0, 1) v`,
  `INSERT INTO ontology.work (id, type) SELECT id, leaf FROM probe_ids`,
  `INSERT INTO ontology.work_version (id, version, title) SELECT id, v, 'title ' || lpad(g::text, 6, '0') || '-' || v FROM probe_ids, generate_series(0, 1) v`,
  `INSERT INTO ontology.book (id, type) SELECT id, leaf FROM probe_ids WHERE leaf = 'book'`,
  `INSERT INTO ontology.book_version (id, version, pages) SELECT id, v, g FROM probe_ids, generate_series(0, 1) v WHERE leaf = 'book'`,
  `INSERT INTO ontology.essay (id, type) SELECT id, leaf FROM probe_ids WHERE leaf = 'essay'`,
  `INSERT INTO ontology.essay_version (id, version) SELECT id, v FROM probe_ids, generate_series(0, 1) v WHERE leaf = 'essay'`,
  `INSERT INTO ontology.essay_locale (id, version, locale, abstract) SELECT id, v, l, l FROM probe_ids, generate_series(0, 1) v, unnest(ARRAY['en', 'fr']) l WHERE leaf = 'essay'`,
  `CREATE INDEX ${PROBE_INDEX} ON ontology.work_version (title, id)`,
  `ANALYZE ontology.node, ontology.node_version, ontology.work, ontology.work_version, ontology.book, ontology.book_version, ontology.essay, ontology.essay_version, ontology.essay_locale`,
]);

describe("view heads: plans", () => {
  // The integration suite runs in CI's single `ci` job, against its
  // `pgvector/pgvector:pg17` service container (`.github/workflows/ci.yml`).
  it("pages a leaf view through the leaf's index, with no aggregate over the root version table", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedVolume;
        const nodes = yield* explain(
          "SELECT * FROM ontology.book_view ORDER BY title, id LIMIT 20",
        );
        expect(aggregates(nodes)).toEqual([]);
        expect(Arr.some(nodes, (n) => n["Index Name"] === PROBE_INDEX)).toBe(true);
        // Nothing sorts: the index supplies the order, so the LIMIT stops early.
        expect(Arr.some(nodes, (n) => n["Node Type"] === "Sort")).toBe(false);
      }),
    );
  });

  it("pages a branch view through the branch level's index, and looks up a keyed view, with no aggregate", async () => {
    await runInTestTransaction(
      runtime,
      Effect.gen(function* () {
        yield* seedVolume;
        // One SELECT driven from `work_version` (effect-drizzle-ext#200), so
        // the index on the branch level supplies the order and the LIMIT
        // stops early; the UNION ALL of per-leaf arms sorted every row.
        const branch = yield* explain(
          "SELECT * FROM ontology.work_view ORDER BY title, id LIMIT 20",
        );
        expect(aggregates(branch)).toEqual([]);
        expect(Arr.some(branch, (n) => n["Index Name"] === PROBE_INDEX)).toBe(true);
        expect(Arr.some(branch, (n) => n["Node Type"] === "Sort")).toBe(false);
        const keyed = yield* explain(
          "SELECT * FROM ontology.essay_locale_view WHERE id = '00000000-0000-4000-9000-000000003100'",
        );
        expect(aggregates(keyed)).toEqual([]);
        expect(
          Arr.some(
            keyed,
            (n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "node_version",
          ),
        ).toBe(false);
      }),
    );
  });
});
