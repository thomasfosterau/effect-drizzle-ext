/**
 * The two schema guards (`src/tooling/`), run against the committed fixture
 * chain (`tests/fixtures/`): the fixture passes both, and each failure mode
 * the applications' scripts were written for is reproduced — a schema that
 * drifted from its latest snapshot, a view that selects from a view, a forked
 * / dangling / cyclic snapshot lineage, and a branch whose new migration does
 * not descend from the base head (read out of a scratch git repository).
 *
 * @module packages/pg/tests/tooling
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import { eq } from "drizzle-orm";
import { text, uuid } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";
import * as fixtureSchema from "./fixtures/schema.ts";
import {
  checkBaseAncestry,
  checkDagIntegrity,
  checkMigrationDrift,
  checkViewDependencies,
  findHeads,
  findViewEdges,
  MigrationDriftError,
  parseViewDefinitions,
  readBaseMigrations,
  referencesView,
  resolveBaseRef,
  ROOT_SENTINEL_ID,
  type SnapshotEntry,
  ViewDependencyError,
} from "../src/tooling/index.ts";

const FIXTURE_MIGRATIONS = `${import.meta.dirname}/fixtures/migrations`;

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const entry = (dir: string, id: string, ...prevIds: string[]): SnapshotEntry => ({
  dir,
  snapshot: { id, prevIds },
});

// ── checkMigrationDrift ──────────────────────────────────────────────────

describe("checkMigrationDrift", () => {
  it("passes on the committed fixture chain", async () => {
    const report = await run(
      checkMigrationDrift({ schema: fixtureSchema, migrationsDir: FIXTURE_MIGRATIONS }),
    );
    expect(report).toEqual({ snapshots: 2, baseRef: Option.none() });
  });

  it("reports drift when the schema moved past the latest snapshot", async () => {
    const drifted = {
      ...fixtureSchema,
      gadget: fixtureSchema.fixture.table("gadget", { id: uuid("id").primaryKey() }),
    };
    const error = await run(
      Effect.flip(checkMigrationDrift({ schema: drifted, migrationsDir: FIXTURE_MIGRATIONS })),
    );
    expect(error).toBeInstanceOf(MigrationDriftError);
    if (!(error instanceof MigrationDriftError)) throw error;
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatch(/Schema drift detected/);
    expect(error.issues[0]).toMatch(/20260925111541_widget-retired-at\/snapshot\.json/);
    expect(error.issues[0]).toMatch(/CREATE TABLE "fixture"\."gadget"/);
  });

  it("reports a fork instead of diffing an arbitrary head", async () => {
    const error = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped();
          yield* fs.copy(FIXTURE_MIGRATIONS, dir, { overwrite: true });
          // A second child of the genesis snapshot: two heads.
          const fork = path.join(dir, "20260925111550_fork");
          yield* fs.makeDirectory(fork);
          yield* fs.writeFileString(
            path.join(fork, "snapshot.json"),
            JSON.stringify({
              version: "8",
              dialect: "postgres",
              id: "11111111-1111-4111-8111-111111111111",
              prevIds: ["0146b7f6-2933-4d88-b8d7-75d7217534ab"],
              ddl: [],
              renames: [],
            }),
          );
          return yield* Effect.flip(
            checkMigrationDrift({ schema: fixtureSchema, migrationsDir: dir }),
          );
        }),
      ),
    );
    expect(error).toBeInstanceOf(MigrationDriftError);
    if (!(error instanceof MigrationDriftError)) throw error;
    expect(error.issues.join("\n")).toMatch(/Expected exactly 1 head .* found 2/);
    expect(error.issues.join("\n")).not.toMatch(/Schema drift detected/);
  });
});

// ── checkDagIntegrity ────────────────────────────────────────────────────

describe("checkDagIntegrity", () => {
  it("accepts a linear chain rooted at drizzle-kit's sentinel", () => {
    expect(
      checkDagIntegrity([entry("1_a", "a", ROOT_SENTINEL_ID), entry("2_b", "b", "a")]),
    ).toEqual([]);
  });

  it("accepts a fork that a later merge migration reconverges", () => {
    const entries = [
      entry("1_a", "a", ROOT_SENTINEL_ID),
      entry("2_b", "b", "a"),
      entry("2_c", "c", "a"),
      entry("3_d", "d", "b", "c"),
    ];
    expect(findHeads(entries).map((e) => e.dir)).toEqual(["3_d"]);
    expect(checkDagIntegrity(entries)).toEqual([]);
  });

  it("reports an unreconverged fork", () => {
    const issues = checkDagIntegrity([
      entry("1_a", "a", ROOT_SENTINEL_ID),
      entry("2_b", "b", "a"),
      entry("2_c", "c", "a"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/found 2: 2_b, 2_c/);
  });

  it("reports a duplicate id and a dangling parent", () => {
    const issues = checkDagIntegrity([
      entry("1_a", "a", ROOT_SENTINEL_ID),
      entry("2_a", "a", "a"),
      entry("3_b", "b", "missing"),
    ]).join("\n");
    expect(issues).toMatch(/share an `id`/);
    expect(issues).toMatch(/3_b -> missing/);
  });

  it("reports a cycle, even one isolated from the head", () => {
    const issues = checkDagIntegrity([
      entry("1_a", "a", ROOT_SENTINEL_ID),
      entry("2_x", "x", "y"),
      entry("3_y", "y", "x"),
    ]).join("\n");
    expect(issues).toMatch(/cycle/);
    expect(issues).toMatch(/not reachable from the DAG head/);
  });
});

// ── base ancestry ────────────────────────────────────────────────────────

describe("checkBaseAncestry", () => {
  const base = {
    ref: "origin/main",
    dirs: ["1_a"],
    head: Option.some(entry("1_a", "a", ROOT_SENTINEL_ID)),
  };

  it("passes when the new migration descends from the base head", () => {
    expect(
      checkBaseAncestry([entry("1_a", "a", ROOT_SENTINEL_ID), entry("2_b", "b", "a")], base),
    ).toEqual([]);
  });

  it("passes when the branch adds no migration", () => {
    expect(
      checkBaseAncestry([entry("0_z", "z", ROOT_SENTINEL_ID)], { ...base, dirs: ["0_z"] }),
    ).toEqual([]);
  });

  it("fails when the new migration was generated on a checkout predating the base head", () => {
    const issues = checkBaseAncestry(
      [entry("0_z", "z", ROOT_SENTINEL_ID), entry("2_b", "b", "z")],
      {
        ...base,
        dirs: ["0_z", "1_a"],
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/2_b were generated on a checkout that predates origin\/main/);
  });
});

describe("resolveBaseRef", () => {
  it("prefers MIGRATION_BASE_REF, then origin/$GITHUB_BASE_REF, else none", () => {
    expect(resolveBaseRef({ MIGRATION_BASE_REF: "main", GITHUB_BASE_REF: "x" })).toEqual(
      Option.some("main"),
    );
    expect(resolveBaseRef({ GITHUB_BASE_REF: "main" })).toEqual(Option.some("origin/main"));
    expect(resolveBaseRef({})).toEqual(Option.none());
  });
});

describe("readBaseMigrations", () => {
  it("reads the base's directories and latest snapshot out of git", async () => {
    const base = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner;
          const repo = yield* fs.makeTempDirectoryScoped();
          const git = (...args: string[]) =>
            spawner.string(
              ChildProcess.make(
                "git",
                ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
                { cwd: repo },
              ),
            );
          yield* git("init", "--quiet", "--initial-branch=main");
          yield* fs.copy(FIXTURE_MIGRATIONS, path.join(repo, "db", "migrations"));
          yield* git("add", ".");
          yield* git("commit", "--quiet", "-m", "base");
          return yield* readBaseMigrations({
            ref: "main",
            migrationsPath: "db/migrations",
            cwd: repo,
          });
        }),
      ),
    );
    expect(base.dirs).toEqual(["20260925111534_widget", "20260925111541_widget-retired-at"]);
    expect(Option.map(base.head, (h) => h.snapshot.id)).toEqual(
      Option.some("fa7acbdc-ec40-469b-bbdd-82348f947ba3"),
    );
  });
});

// ── checkViewDependencies ────────────────────────────────────────────────

describe("checkViewDependencies", () => {
  it("passes on the fixture schema's one view", async () => {
    expect(await Effect.runPromise(checkViewDependencies({ schema: fixtureSchema }))).toEqual({
      viewCount: 1,
    });
  });

  it("fails on a view that selects from another view", async () => {
    const { fixture, widget, widgetView } = fixtureSchema;
    const layered = {
      ...fixtureSchema,
      label: fixture.table("label", { id: uuid("id").primaryKey(), text: text("text") }),
      labelledView: fixture
        .view("labelled_view")
        .as((qb) =>
          qb
            .select({ id: widgetView.id, slug: widgetView.slug })
            .from(widgetView)
            .innerJoin(widget, eq(widget.id, widgetView.id)),
        ),
    };
    const error = await Effect.runPromise(Effect.flip(checkViewDependencies({ schema: layered })));
    expect(error).toBeInstanceOf(ViewDependencyError);
    if (!(error instanceof ViewDependencyError)) throw error;
    expect(error.edges).toEqual([{ from: "fixture.labelled_view", to: "fixture.widget_view" }]);
    expect(error.message).toMatch(/fixture\.labelled_view selects from fixture\.widget_view/);
  });
});

describe("view definition parsing", () => {
  const views = parseViewDefinitions([
    'CREATE TABLE "app"."t" (x int);',
    'CREATE VIEW "app"."a_view" AS (select * from "app"."t");',
    'CREATE MATERIALIZED VIEW "b_view" AS (select * from app.a_view);',
    'CREATE VIEW "app"."c_view" AS (select * from (select 1) a_view);',
  ]);

  it("reads schema-qualified, public and materialized views", () => {
    expect(views.map((v) => `${v.schema}.${v.name}`)).toEqual([
      "app.a_view",
      "public.b_view",
      "app.c_view",
    ]);
  });

  it("matches quoted and bare qualified references, never an unqualified alias", () => {
    const [a, b, c] = views;
    if (a === undefined || b === undefined || c === undefined) throw new Error("three views");
    expect(referencesView(b, a)).toBe(true);
    expect(referencesView(c, a)).toBe(false);
    expect(referencesView(a, a)).toBe(false);
    expect(findViewEdges(views).map((e) => `${e.from.name}->${e.to.name}`)).toEqual([
      "b_view->a_view",
    ]);
  });
});
