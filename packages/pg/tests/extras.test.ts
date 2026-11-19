/**
 * The extras generator (`src/tooling/extras.ts`): the pure plan (create,
 * alter and drop order; what it refuses), the recorded state, and the
 * generator and drift gate end to end against a scratch copy of the fixture
 * chain, with the real drizzle-kit binary writing the custom migration.
 *
 * @module packages/pg/tests/extras
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { afterAll, assert, describe, expect, it } from "vite-plus/test";
import { readMigrations } from "../src/migrations.ts";
import {
  checkExtrasDrift,
  checkMigrationDrift,
  compositeType,
  domain,
  DrizzleKitError,
  emptyExtrasState,
  extension,
  EXTRAS_STATE_FILE,
  ExtrasDriftError,
  ExtrasError,
  generateExtrasMigration,
  MalformedExtrasState,
  planExtras,
  readExtrasState,
  renderExtrasMigration,
  toExtrasState,
} from "../src/tooling/index.ts";
import * as fixtureSchema from "./fixtures/schema.ts";

const PACKAGE_DIR = `${import.meta.dirname}/..`;
const FIXTURE_MIGRATIONS = `${import.meta.dirname}/fixtures/migrations`;
/** drizzle-kit's own bin, run with this Node: the package has no `.bin` of its own under pnpm's hoisting. */
const DRIZZLE_KIT = [
  process.execPath,
  decodeURIComponent(new URL("bin.cjs", import.meta.resolve("drizzle-kit")).pathname),
] as const;

const runtime = ManagedRuntime.make(NodeServices.layer);
afterAll(() => runtime.dispose());

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner>,
): Promise<A> => runtime.runPromise(effect);

/** A scratch copy of the fixture chain, removed when the scope closes. */
const scratchChain = Effect.fn("scratchChain")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  yield* fs.copy(FIXTURE_MIGRATIONS, dir, { overwrite: true });
  return dir;
});

const vector = extension("vector", { version: "0.8.0" });
const email = domain("email", "text", {
  notNull: true,
  checks: { email_has_at: "position('@' in VALUE) > 1" },
});
const money = compositeType(
  "money_amount",
  { amount: "numeric(12, 2)", currency: "char(3)" },
  { schema: "fixture" },
);

// ── planExtras ──────────────────────────────────────────────────────────

describe("planExtras", () => {
  it("creates extensions, then domains, then composite types, in declaration order", () => {
    const plan = planExtras(
      emptyExtrasState,
      toExtrasState({
        compositeTypes: [money],
        domains: [email],
        extensions: [vector, extension("pg_trgm", { schema: "extensions" })],
      }),
    );
    expect(plan.issues).toEqual([]);
    expect(plan.statements).toEqual([
      `CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public" VERSION '0.8.0';`,
      `CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";`,
      `CREATE DOMAIN "public"."email" AS text NOT NULL CONSTRAINT "email_has_at" CHECK (position('@' in VALUE) > 1);`,
      `CREATE TYPE "fixture"."money_amount" AS ("amount" numeric(12, 2), "currency" char(3));`,
    ]);
  });

  it("plans nothing when the declarations match the recorded state", () => {
    const state = toExtrasState({
      extensions: [vector],
      domains: [email],
      compositeTypes: [money],
    });
    expect(planExtras(state, state)).toEqual({ statements: [], issues: [] });
  });

  it("drops composite types, then domains, then extensions, newest first", () => {
    const prev = toExtrasState({
      extensions: [vector, extension("citext")],
      domains: [email, domain("slug", "text")],
      compositeTypes: [money],
    });
    expect(planExtras(prev, emptyExtrasState).statements).toEqual([
      `DROP TYPE "fixture"."money_amount";`,
      `DROP DOMAIN "public"."slug";`,
      `DROP DOMAIN "public"."email";`,
      `DROP EXTENSION IF EXISTS "citext";`,
      `DROP EXTENSION IF EXISTS "vector";`,
    ]);
  });

  it("alters an extension's schema and version, and ignores an un-pinned version", () => {
    const prev = toExtrasState({ extensions: [vector] });
    expect(
      planExtras(
        prev,
        toExtrasState({ extensions: [extension("vector", { schema: "ext", version: "0.8.1" })] }),
      ).statements,
    ).toEqual([
      `ALTER EXTENSION "vector" SET SCHEMA "ext";`,
      `ALTER EXTENSION "vector" UPDATE TO '0.8.1';`,
    ]);
    expect(
      planExtras(prev, toExtrasState({ extensions: [extension("vector")] })).statements,
    ).toEqual([]);
  });

  it("alters a domain's default, nullability and checks in place", () => {
    const prev = toExtrasState({ domains: [email] });
    const next = toExtrasState({
      domains: [
        domain("email", "text", {
          default: "''",
          checks: {
            email_has_at: "position('@' in VALUE) > 0",
            email_short: "length(VALUE) < 255",
          },
        }),
      ],
    });
    expect(planExtras(prev, next).statements).toEqual([
      `ALTER DOMAIN "public"."email" SET DEFAULT '';`,
      `ALTER DOMAIN "public"."email" DROP NOT NULL;`,
      `ALTER DOMAIN "public"."email" DROP CONSTRAINT "email_has_at";`,
      `ALTER DOMAIN "public"."email" ADD CONSTRAINT "email_has_at" CHECK (position('@' in VALUE) > 0);`,
      `ALTER DOMAIN "public"."email" ADD CONSTRAINT "email_short" CHECK (length(VALUE) < 255);`,
    ]);
    expect(planExtras(next, prev).statements[0]).toBe(
      `ALTER DOMAIN "public"."email" DROP DEFAULT;`,
    );
  });

  it("refuses a domain whose base type changed", () => {
    const plan = planExtras(
      toExtrasState({ domains: [email] }),
      toExtrasState({ domains: [domain("email", "citext")] }),
    );
    expect(plan.statements).toEqual([]);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]).toMatch(/domain 'public\.email' changes its base type .* can't ALTER/);
  });

  it("adds, drops and retypes composite type attributes", () => {
    const next = compositeType(
      "money_amount",
      { amount: "numeric(14, 2)", minor_units: "integer" },
      { schema: "fixture" },
    );
    expect(
      planExtras(
        toExtrasState({ compositeTypes: [money] }),
        toExtrasState({ compositeTypes: [next] }),
      ).statements,
    ).toEqual([
      `ALTER TYPE "fixture"."money_amount" DROP ATTRIBUTE "currency";`,
      `ALTER TYPE "fixture"."money_amount" ALTER ATTRIBUTE "amount" TYPE numeric(14, 2);`,
      `ALTER TYPE "fixture"."money_amount" ADD ATTRIBUTE "minor_units" integer;`,
    ]);
  });

  it("reports duplicate declarations", () => {
    const plan = planExtras(
      emptyExtrasState,
      toExtrasState({ extensions: [vector, extension("vector")], domains: [email, email] }),
    );
    expect(plan.statements).toEqual([]);
    expect(plan.issues).toEqual([
      "extension 'vector' is declared more than once.",
      "domain 'public.email' is declared more than once.",
    ]);
  });

  it("quotes identifiers and literals", () => {
    expect(
      planExtras(
        emptyExtrasState,
        toExtrasState({ extensions: [extension('we"ird', { version: "1'0" })] }),
      ).statements,
    ).toEqual([`CREATE EXTENSION IF NOT EXISTS "we""ird" WITH SCHEMA "public" VERSION '1''0';`]);
  });
});

describe("renderExtrasMigration", () => {
  it("separates statements with drizzle-kit's breakpoint, which the runner splits on", async () => {
    const sql = renderExtrasMigration(["SELECT 1;", "SELECT 2;"]);
    expect(sql).toMatch(/^-- Generated by generateExtrasMigration/);
    expect(sql).toContain("SELECT 1;\n--> statement-breakpoint\nSELECT 2;\n");
  });
});

// ── readExtrasState ─────────────────────────────────────────────────────

describe("readExtrasState", () => {
  it("is empty when no migration directory records a state", async () => {
    const recorded = await run(readExtrasState(FIXTURE_MIGRATIONS));
    expect(Option.isNone(recorded.dir)).toBe(true);
    expect(recorded.state).toEqual(emptyExtrasState);
  });

  it("fails with MalformedExtrasState on a file it can't decode", async () => {
    const error = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* scratchChain();
          yield* fs.writeFileString(
            path.join(dir, "20261112222142_leaf-view-fenced-tail", EXTRAS_STATE_FILE),
            '{"version":2}',
          );
          return yield* Effect.flip(readExtrasState(dir));
        }),
      ),
    );
    expect(error).toBeInstanceOf(MalformedExtrasState);
    expect(error.message).toMatch(
      /leaf-view-fenced-tail\/extras\.json is not an extras state file/,
    );
  });
});

// ── generateExtrasMigration / checkExtrasDrift ──────────────────────────

describe("generateExtrasMigration", () => {
  it("writes a chained custom migration with its state, then reports no drift", async () => {
    const result = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* scratchChain();
          const extras = { extensions: [vector], domains: [email] };
          const drift = yield* Effect.flip(checkExtrasDrift({ extras, migrationsDir: dir }));
          const written = yield* generateExtrasMigration({
            extras,
            migrationsDir: dir,
            name: "extras",
            drizzleKit: { schema: "tests/fixtures/schema.ts" },
            command: DRIZZLE_KIT,
            cwd: PACKAGE_DIR,
          });
          assert(Option.isSome(written));
          const again = yield* generateExtrasMigration({
            extras,
            migrationsDir: dir,
            name: "extras-again",
            drizzleKit: { schema: "tests/fixtures/schema.ts" },
            command: DRIZZLE_KIT,
            cwd: PACKAGE_DIR,
          });
          return {
            drift,
            written: written.value,
            again,
            dirName: path.basename(written.value.dir),
            recorded: yield* readExtrasState(dir),
            after: yield* checkExtrasDrift({ extras, migrationsDir: dir }),
            migrations: yield* readMigrations(dir),
            schemaDrift: yield* checkMigrationDrift({ schema: fixtureSchema, migrationsDir: dir }),
            stateFile: yield* fs.exists(path.join(written.value.dir, EXTRAS_STATE_FILE)),
          };
        }),
      ),
    );
    expect(result.drift).toBeInstanceOf(ExtrasDriftError);
    expect(result.drift.message).toMatch(/nothing recorded yet.*2 statement/s);
    expect(result.dirName).toMatch(/^\d{14}_extras$/);
    expect(result.written.statements).toHaveLength(2);
    expect(Option.isNone(result.again)).toBe(true);
    expect(result.recorded.dir).toEqual(Option.some(result.dirName));
    expect(result.after).toEqual(Option.some(result.dirName));
    // The runner applies it last, as two statements.
    expect(result.migrations.at(-1)).toEqual({
      name: result.dirName,
      statements: [
        expect.stringMatching(/CREATE EXTENSION IF NOT EXISTS "vector"/),
        expect.stringMatching(/^CREATE DOMAIN "public"\."email"/),
      ],
    });
    // drizzle-kit chained the snapshot, so the schema drift gate still passes.
    expect(result.schemaDrift.snapshots).toBe(result.migrations.length);
    expect(result.stateFile).toBe(true);
    expect(result.recorded.state).toEqual(
      toExtrasState({ extensions: [vector], domains: [email] }),
    );
  });

  it("fails with ExtrasError, and writes nothing, when the plan has issues", async () => {
    const result = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* scratchChain();
          const before = yield* fs.readDirectory(dir);
          const error = yield* Effect.flip(
            generateExtrasMigration({
              extras: { domains: [email, email] },
              migrationsDir: dir,
              name: "dupe",
              drizzleKit: { schema: "tests/fixtures/schema.ts" },
              command: DRIZZLE_KIT,
              cwd: PACKAGE_DIR,
            }),
          );
          return { error, same: (yield* fs.readDirectory(dir)).length === before.length };
        }),
      ),
    );
    expect(result.error).toBeInstanceOf(ExtrasError);
    expect(result.same).toBe(true);
  });

  it("fails with DrizzleKitError when drizzle-kit doesn't report ok", async () => {
    const error = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratchChain();
          return yield* Effect.flip(
            generateExtrasMigration({
              extras: { extensions: [vector] },
              migrationsDir: dir,
              name: "broken",
              drizzleKit: { config: "does-not-exist.config.ts" },
              command: DRIZZLE_KIT,
              cwd: PACKAGE_DIR,
            }),
          );
        }),
      ),
    );
    expect(error).toBeInstanceOf(DrizzleKitError);
    expect(error.message).toMatch(/drizzle-kit generate --custom failed/);
  });
});
