/**
 * The migration runner's reading half (`src/migrations.ts`), against the
 * committed fixture chain and a scratch directory: apply order, the
 * statement split, and what is skipped. Applying them is the integration
 * suite's job — its global setup provisions through the runner.
 *
 * @module packages/pg/tests/migrations
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";
import { MigrationError, readMigrations, splitStatements } from "../src/migrations.ts";

const FIXTURE_MIGRATIONS = `${import.meta.dirname}/fixtures/migrations`;

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("splitStatements", () => {
  it("splits on drizzle-kit's breakpoint, trimming and dropping empty chunks", () => {
    expect(
      splitStatements(
        "CREATE SCHEMA a;\n--> statement-breakpoint\nCREATE TABLE a.b (x int);--> statement-breakpoint\n",
      ),
    ).toEqual(["CREATE SCHEMA a;", "CREATE TABLE a.b (x int);"]);
  });

  it("keeps a single-statement file whole, and an empty file empty", () => {
    expect(splitStatements("SELECT 1;")).toEqual(["SELECT 1;"]);
    expect(splitStatements("  \n")).toEqual([]);
  });
});

describe("readMigrations", () => {
  it("reads the fixture chain in directory-name order", async () => {
    const migrations = await run(readMigrations(FIXTURE_MIGRATIONS));
    expect(migrations.map((m) => m.name)).toEqual([
      "20260925111534_widget",
      "20260925111541_widget-retired-at",
    ]);
    expect(migrations[0]?.statements[0]).toBe('CREATE SCHEMA "fixture";');
    expect(migrations[0]?.statements).toHaveLength(5);
    expect(migrations[1]?.statements).toHaveLength(1);
  });

  it("orders by name, skips loose files and directories without migration.sql", async () => {
    const migrations = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(path.join(dir, "0002_second"));
          yield* fs.writeFileString(path.join(dir, "0002_second", "migration.sql"), "SELECT 2;");
          yield* fs.makeDirectory(path.join(dir, "0001_first"));
          yield* fs.writeFileString(path.join(dir, "0001_first", "migration.sql"), "SELECT 1;");
          yield* fs.makeDirectory(path.join(dir, "0003_snapshot_only"));
          yield* fs.writeFileString(path.join(dir, "0003_snapshot_only", "snapshot.json"), "{}");
          yield* fs.writeFileString(path.join(dir, "0000_loose.sql"), "SELECT 0;");
          return yield* readMigrations(dir);
        }),
      ),
    );
    expect(migrations).toEqual([
      { name: "0001_first", statements: ["SELECT 1;"] },
      { name: "0002_second", statements: ["SELECT 2;"] },
    ]);
  });
});

describe("MigrationError", () => {
  it("names the migration that failed", () => {
    const error = new MigrationError({ migration: "0002_second", cause: new Error("boom") });
    expect(error._tag).toBe("MigrationError");
    expect(error.message).toBe("migration '0002_second' failed");
  });
});
