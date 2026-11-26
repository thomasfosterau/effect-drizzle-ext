/**
 * `effect-drizzle-kit` end to end: the config loader's failures, then the
 * `generate` and `check` subcommands run through `Command.runWith` against a
 * scratch copy of the pg package's fixture chain, with a config module
 * written beside it and the real drizzle-kit binary.
 *
 * The scratch directory sits inside this package (not the OS temp dir) so
 * the config module it holds resolves `@thomasfosterau/effect-drizzle-ext-*`
 * from this package's `node_modules`, as an application's config would.
 *
 * @module packages/kit/tests/kit
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ExtrasDriftError,
  MigrationDriftError,
} from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { CliError, Command } from "effect/cli";
import { afterAll, assert, describe, expect, it } from "vite-plus/test";
import {
  check,
  cli,
  defineConfig,
  generate,
  KitConfigError,
  loadConfig,
  parseRename,
  version,
} from "../src/index.ts";

const PG_FIXTURES = `${import.meta.dirname}/../../pg/tests/fixtures`;

/** drizzle-kit's own bin, run with this Node: the package has no `.bin` of its own under pnpm's hoisting. */
const DRIZZLE_KIT = [
  process.execPath,
  decodeURIComponent(new URL("bin.js", import.meta.resolve("drizzle-kit")).pathname),
];

const runtime = ManagedRuntime.make(NodeServices.layer);
afterAll(() => runtime.dispose());

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
): Promise<A> => runtime.runPromise(Effect.scoped(effect));

/**
 * A scratch directory holding a copy of the fixture chain under `migrations/`
 * and `effect-drizzle-kit.config.ts` with `body` as its default export's
 * extra members; returns the config's path.
 */
const scratchProject = Effect.fn("scratchProject")(function* (body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({
    directory: import.meta.dirname,
    prefix: ".scratch-",
  });
  yield* fs.copy(`${PG_FIXTURES}/migrations`, path.join(dir, "migrations"));
  const file = path.join(dir, "effect-drizzle-kit.config.ts");
  yield* fs.writeFileString(
    file,
    [
      'import { defineConfig } from "@thomasfosterau/effect-drizzle-ext-kit";',
      'import { domain, extension, fn, trigger } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";',
      `import * as schema from "${PG_FIXTURES}/schema.ts";`,
      "",
      "export default defineConfig({",
      '  migrationsDir: "migrations",',
      `  drizzleKit: { schema: "${PG_FIXTURES}/schema.ts" },`,
      `  command: [${DRIZZLE_KIT.map((part) => `"${part}"`).join(", ")}],`,
      body,
      "});",
      "",
    ].join("\n"),
  );
  return file;
});

const EXTRAS = `  extras: {
    extensions: [extension("citext")],
    domains: [domain("email", "citext")],
    functions: [
      fn({ schema: "fixture", name: "noop", returns: "trigger", language: "plpgsql", body: "BEGIN RETURN NEW; END;" }),
    ],
    triggers: [
      trigger({ schema: "fixture", table: "widget", name: "widget_noop", timing: "BEFORE", events: ["INSERT"], fn: { schema: "fixture", name: "noop" } }),
    ],
  },`;

describe("defineConfig", () => {
  it("returns the config unchanged", () => {
    const config = { migrationsDir: "m", drizzleKit: { config: "drizzle.config.ts" } };
    expect(defineConfig(config)).toBe(config);
  });
});

describe("loadConfig", () => {
  it("fails with KitConfigError when the file is missing", async () => {
    const error = await run(Effect.flip(loadConfig("does-not-exist.config.ts")));
    expect(error).toBeInstanceOf(KitConfigError);
    expect(error.message).toMatch(/does-not-exist\.config\.ts: no config file/);
  });

  it("fails with KitConfigError when the default export has the wrong shape", async () => {
    const error = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          directory: import.meta.dirname,
          prefix: ".scratch-",
        });
        const file = path.join(dir, "bad.config.ts");
        yield* fs.writeFileString(file, "export default { migrationsDir: 1 };\n");
        return yield* Effect.flip(loadConfig(file));
      }),
    );
    expect(error).toBeInstanceOf(KitConfigError);
    expect(error.message).toMatch(/isn't a defineConfig/);
  });

  it("fails with KitConfigError when importing the module throws", async () => {
    const error = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          directory: import.meta.dirname,
          prefix: ".scratch-",
        });
        const file = path.join(dir, "throws.config.ts");
        yield* fs.writeFileString(file, 'throw new Error("boom");\n');
        return yield* Effect.flip(loadConfig(file));
      }),
    );
    expect(error).toBeInstanceOf(KitConfigError);
    expect(error.message).toMatch(/failed to import: boom/);
  });

  it("resolves the config's directory", async () => {
    const loaded = await run(
      Effect.gen(function* () {
        const file = yield* scratchProject("");
        const path = yield* Path.Path;
        return { loaded: yield* loadConfig(file), dir: path.dirname(file) };
      }),
    );
    expect(loaded.loaded.dir).toBe(loaded.dir);
    expect(loaded.loaded.config.migrationsDir).toBe("migrations");
  });
});

describe("generate and check", () => {
  it("checks, generates, then checks clean, through the CLI", async () => {
    const result = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = yield* scratchProject(EXTRAS);
        const runCli = Command.runWith(cli, { version });
        const before = yield* Effect.flip(runCli(["check", "--config", file]));
        yield* runCli(["generate", "--config", file, "--name", "email"]);
        yield* runCli(["check", "--config", file]);
        const names = yield* fs.readDirectory(path.join(path.dirname(file), "migrations"));
        const again = yield* generate(yield* loadConfig(file), Option.some("again"));
        return { before, names, again };
      }),
    );
    expect(result.before).toBeInstanceOf(CliError.UserError);
    assert(result.before instanceof CliError.UserError);
    expect(result.before.cause).toBeInstanceOf(ExtrasDriftError);
    expect(result.before.message).toMatch(/Extras drift detected/);
    expect(result.names.filter((name) => /_email-extras-(before|after)$/.test(name))).toHaveLength(
      2,
    );
    expect(Option.isNone(result.again.before) && Option.isNone(result.again.after)).toBe(true);
  });

  it("also gates schema drift when the config names its schema module", async () => {
    const report = await run(
      Effect.gen(function* () {
        const file = yield* scratchProject("  schema,");
        return yield* check(yield* loadConfig(file));
      }),
    );
    expect(Option.isNone(report.extrasRecordedIn)).toBe(true);
    expect(Option.isSome(report.snapshots)).toBe(true);
  });

  it("fails check with MigrationDriftError when the schema moved past its snapshots", async () => {
    const error = await run(
      Effect.gen(function* () {
        const file = yield* scratchProject(
          '  schema: { ...schema, extra: (await import("drizzle-orm/pg-core")).pgTable("kit_extra", {}) },',
        );
        return yield* Effect.flip(check(yield* loadConfig(file)));
      }),
    );
    expect(error).toBeInstanceOf(MigrationDriftError);
  });

  it("renames with --rename, and records by hand with --record-only", async () => {
    const result = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = yield* scratchProject(EXTRAS);
        const runCli = Command.runWith(cli, { version });
        yield* runCli(["generate", "--config", file, "--name", "email"]);
        const config = yield* fs.readFileString(file);
        // A new file per step: Node caches a module by its path.
        const variant = Effect.fn("variant")(function* (name: string, from: string, to: string) {
          const variantFile = path.join(path.dirname(file), `${name}.config.ts`);
          yield* fs.writeFileString(variantFile, config.replace(from, to));
          return variantFile;
        });
        const renamed = yield* variant("renamed", 'domain("email"', 'domain("mail"');
        const badHint = yield* Effect.flip(
          runCli(["generate", "--config", renamed, "--rename", "domain:email"]),
        );
        yield* runCli([
          "generate",
          "-c",
          renamed,
          "--name",
          "rename",
          "--rename",
          "domain:email:mail",
        ]);
        yield* runCli(["check", "--config", renamed]);
        const retyped = yield* variant(
          "retyped",
          'domain("email", "citext")',
          'domain("mail", "text")',
        );
        const refused = yield* Effect.flip(
          runCli(["generate", "-c", retyped, "--name", "refused"]),
        );
        yield* runCli(["generate", "-c", retyped, "--name", "retype", "--record-only"]);
        const migrations = path.join(path.dirname(file), "migrations");
        const read = (suffix: string) =>
          Effect.flatMap(fs.readDirectory(migrations), (names) =>
            fs.readFileString(
              path.join(
                migrations,
                names.find((name) => name.endsWith(suffix)) ?? suffix,
                "migration.sql",
              ),
            ),
          );
        return {
          badHint,
          refused,
          renameSql: yield* read("_rename-extras-before"),
          retypeSql: yield* read("_retype-extras-before"),
        };
      }),
    );
    expect(result.badHint).not.toBeInstanceOf(CliError.UserError);
    expect(result.refused.message).toMatch(/recordOnly/);
    expect(result.renameSql).toContain(`ALTER DOMAIN "public"."email" RENAME TO "mail";`);
    expect(result.retypeSql).toMatch(/^-- Hand-written extras migration/);
  });
});

describe("parseRename", () => {
  it("reads each hint kind, and refuses anything else", () => {
    expect(parseRename("domain:email:mail")).toEqual(Option.some(["domain", "email", "mail"]));
    expect(parseRename("compositeType:app.money:price")).toEqual(
      Option.some(["compositeType", "app.money", "price"]),
    );
    expect(parseRename("attribute:price:amount:value")).toEqual(
      Option.some(["attribute", "price", "amount", "value"]),
    );
    expect(
      ["domain:email", "attribute:a:b", "table:a:b", "domain::mail", "domain:a:b:c"].map(
        parseRename,
      ),
    ).toEqual(Array.from({ length: 5 }, () => Option.none()));
  });
});
