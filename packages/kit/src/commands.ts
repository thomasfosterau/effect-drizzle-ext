/**
 * **The `effect-drizzle-kit` commands**: `generate` writes the extras
 * migration, and `check` gates extras drift (and schema drift, when the
 * config names its schema module) in one run. Each is an Effect over a
 * {@link LoadedConfig} ({@link generate}, {@link check}) and a subcommand of
 * {@link cli}, which `bin.ts` runs.
 *
 * @module commands
 */

import {
  checkExtrasDrift,
  checkMigrationDrift,
  generateExtrasMigration,
  type GitBase,
  resolveBaseRef,
} from "@thomasfosterau/effect-drizzle-ext-pg/tooling";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { CliError, Command, Flag } from "effect/cli";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import manifest from "../package.json" with { type: "json" };
import { DEFAULT_CONFIG_FILE, loadConfig, type LoadedConfig } from "./config.ts";

/**
 * A handler failure as the user-facing `CliError.UserError` `Command.run`
 * prints as one message (the typed error stays its `cause`), instead of the
 * runtime's stack trace.
 */
const asUserError = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CliError.UserError, R> =>
  Effect.mapError(effect, (cause) => new CliError.UserError({ cause, userMessage: cause.message }));

/** The absolute migrations directory a config names. */
const migrationsDirOf = (loaded: LoadedConfig, path: Path.Path): string =>
  path.resolve(loaded.dir, loaded.config.migrationsDir);

/**
 * Write the extras migration a config's declarations need, as
 * `generateExtrasMigration` does, with drizzle-kit run in the config's
 * directory. Succeeds with the directory written, or `Option.none()` when
 * there was nothing to migrate.
 */
export const generate = (loaded: LoadedConfig, name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const written = yield* generateExtrasMigration({
      extras: loaded.config.extras ?? {},
      migrationsDir: migrationsDirOf(loaded, path),
      name,
      drizzleKit: loaded.config.drizzleKit,
      cwd: loaded.dir,
      command: loaded.config.command ?? ["drizzle-kit"],
    });
    return Option.map(written, (migration) => migration.dir);
  });

/**
 * The base branch a pull request's ancestry check runs against
 * (`resolveBaseRef` over `MIGRATION_BASE_REF` / `GITHUB_BASE_REF`), with the
 * migrations path made relative to the repository root `git` reports.
 */
const pullRequestBase = (migrationsDir: string, cwd: string) =>
  Effect.gen(function* () {
    const ref = resolveBaseRef({
      MIGRATION_BASE_REF: Option.getOrUndefined(
        yield* Config.option(Config.String("MIGRATION_BASE_REF")),
      ),
      GITHUB_BASE_REF: Option.getOrUndefined(
        yield* Config.option(Config.String("GITHUB_BASE_REF")),
      ),
    });
    if (Option.isNone(ref)) return Option.none<GitBase>();
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const root = (yield* spawner.string(
      ChildProcess.make("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        // A git hook exports these; cleared, `cwd` alone picks the repository.
        env: { GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined },
        extendEnv: true,
      }),
    )).trim();
    return Option.some<GitBase>({
      ref: ref.value,
      migrationsPath: path.relative(root, migrationsDir),
      cwd: root,
    });
  });

/** What a passing {@link check} looked at. */
export interface CheckReport {
  /** The directory holding the recorded extras state; none before the first extras migration. */
  readonly extrasRecordedIn: Option.Option<string>;
  /** How many snapshots the schema drift check read; none when the config names no schema module. */
  readonly snapshots: Option.Option<number>;
}

/**
 * Fail when the config's extras differ from the recorded state
 * (`checkExtrasDrift`), then, when the config names its schema module, run
 * `checkMigrationDrift` over the same directory (with base ancestry in a pull
 * request). Needs no database.
 */
export const check = (loaded: LoadedConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const migrationsDir = migrationsDirOf(loaded, path);
    const extrasRecordedIn = yield* checkExtrasDrift({
      extras: loaded.config.extras ?? {},
      migrationsDir,
    });
    const schema = loaded.config.schema;
    if (schema === undefined) {
      return { extrasRecordedIn, snapshots: Option.none() } satisfies CheckReport;
    }
    const report = yield* checkMigrationDrift({
      schema,
      migrationsDir,
      base: yield* pullRequestBase(migrationsDir, loaded.dir),
    });
    return { extrasRecordedIn, snapshots: Option.some(report.snapshots) } satisfies CheckReport;
  });

const configFlag = Flag.String("config").pipe(
  Flag.withAlias("c"),
  Flag.withDescription(
    `The config module; ${DEFAULT_CONFIG_FILE} in the working directory when absent`,
  ),
  Flag.withDefault(DEFAULT_CONFIG_FILE),
);

const generateCommand = Command.make(
  "generate",
  {
    config: configFlag,
    name: Flag.String("name").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("The migration's slug, drizzle-kit's --name"),
      Flag.withDefault("extras"),
    ),
  },
  Effect.fn("effect-drizzle-kit generate")(function* ({ config, name }) {
    const written = yield* asUserError(
      Effect.flatMap(loadConfig(config), (loaded) => generate(loaded, name)),
    );
    yield* Option.match(written, {
      onNone: () => Console.log("No extras changes: nothing to migrate."),
      onSome: (dir) => Console.log(`Wrote ${dir}`),
    });
  }),
).pipe(
  Command.withDescription(
    "Write the extensions, domains and composite types the config declares into a drizzle-kit custom migration. Run it before drizzle-kit generate.",
  ),
);

const checkCommand = Command.make(
  "check",
  { config: configFlag },
  Effect.fn("effect-drizzle-kit check")(function* ({ config }) {
    const report = yield* asUserError(Effect.flatMap(loadConfig(config), check));
    const extras = Option.match(report.extrasRecordedIn, {
      onNone: () => "no extras recorded yet, none declared",
      onSome: (dir) => `extras match ${dir}`,
    });
    const schema = Arr.fromOption(
      Option.map(report.snapshots, (n) => `schema matches the latest of ${n} snapshot(s)`),
    );
    yield* Console.log(`OK: ${Arr.join([extras, ...schema], "; ")}.`);
  }),
).pipe(
  Command.withDescription(
    "Fail when the declared extras, or the schema module when the config names one, drifted from the committed migrations.",
  ),
);

/**
 * The `effect-drizzle-kit` command: `generate` and `check`, each taking
 * `--config`. Run it with `Command.run` (as `bin.ts` does) or `Command.runWith`.
 */
export const cli = Command.make("effect-drizzle-kit").pipe(
  Command.withDescription(
    "A companion to drizzle-kit: migrate what it doesn't manage, and gate drift in one check.",
  ),
  Command.withSubcommands([generateCommand, checkCommand]),
);

/** The version `--version` prints: this package's own. */
export const version: string = manifest.version;
