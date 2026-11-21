/**
 * **The `effect-drizzle-kit` commands**: `generate` writes drizzle-kit's
 * migration between the two extras migrations, and `check` gates extras
 * drift (and schema drift, when the config names its schema module) in one run. Each is an Effect over a
 * {@link LoadedConfig} ({@link generate}, {@link check}) and a subcommand of
 * {@link cli}, which `bin.ts` runs.
 *
 * @module commands
 */

import {
  checkExtrasDrift,
  checkMigrationDrift,
  type ExtrasRename,
  generateMigrations,
  type GitBase,
  resolveBaseRef,
} from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Str from "effect/String";
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

/** The one-off choices a `generate` run takes beside its config. */
export interface GenerateOptions {
  /** Renames to apply in the before migration in place of a drop and a create, as `generateMigrations` takes them. */
  readonly renames?: ReadonlyArray<ExtrasRename>;
  /** Record the before migration's state with a `migration.sql` to write by hand. */
  readonly recordOnly?: boolean;
}

/**
 * Generate the whole change a config's declarations and schema need, as
 * `generateMigrations` does: the before-phase extras migration, drizzle-kit's
 * own, then the after-phase extras migration, with drizzle-kit run in the
 * config's directory. `name` is drizzle-kit's slug, and prefixes the extras ones.
 */
export const generate = Effect.fn("Commands.generate")(function* (
  loaded: LoadedConfig,
  name: Option.Option<string>,
  options: GenerateOptions = {},
) {
  const path = yield* Path.Path;
  return yield* generateMigrations({
    extras: loaded.config.extras ?? {},
    migrationsDir: migrationsDirOf(loaded, path),
    ...Option.match(name, { onNone: () => ({}), onSome: (slug) => ({ name: slug }) }),
    drizzleKit: loaded.config.drizzleKit,
    cwd: loaded.dir,
    command: loaded.config.command ?? ["drizzle-kit"],
    renames: options.renames ?? [],
    recordOnly: options.recordOnly ?? false,
  });
});

/**
 * A `--rename` value as a rename hint: `domain:<from>:<to>`,
 * `compositeType:<from>:<to>` or `attribute:<type>:<from>:<to>`, each name
 * non-empty. `none` for anything else.
 */
export const parseRename = (text: string): Option.Option<ExtrasRename> => {
  const parts = text.split(":");
  if (!Arr.every(parts, Str.isNonEmpty)) return Option.none();
  const [kind, first, second, third] = parts;
  if (parts.length === 3 && (kind === "domain" || kind === "compositeType")) {
    return Option.some([kind, first, second] as const);
  }
  if (parts.length === 4 && kind === "attribute") {
    return Option.some([kind, first, second, third] as const);
  }
  return Option.none();
};

/**
 * The base branch a pull request's ancestry check runs against
 * (`resolveBaseRef` over `MIGRATION_BASE_REF` / `GITHUB_BASE_REF`), with the
 * migrations path made relative to the repository root `git` reports.
 */
const pullRequestBase = Effect.fn("Commands.pullRequestBase")(function* (
  migrationsDir: string,
  cwd: string,
) {
  const ref = resolveBaseRef({
    MIGRATION_BASE_REF: Option.getOrUndefined(
      yield* Config.option(Config.String("MIGRATION_BASE_REF")),
    ),
    GITHUB_BASE_REF: Option.getOrUndefined(yield* Config.option(Config.String("GITHUB_BASE_REF"))),
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
export const check = Effect.fn("Commands.check")(function* (loaded: LoadedConfig) {
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
      Flag.withDescription(
        "drizzle-kit's migration slug; the extras migrations are <name>-extras-before and -after",
      ),
      Flag.optional,
    ),
    renames: Flag.String("rename").pipe(
      Flag.withDescription(
        "Rename instead of drop and create: domain:<from>:<to>, compositeType:<from>:<to> or attribute:<type>:<from>:<to> (repeatable)",
      ),
      Flag.filterMap(
        parseRename,
        () => "domain:<from>:<to>, compositeType:<from>:<to> or attribute:<type>:<from>:<to>",
      ),
      Flag.atLeast(0),
    ),
    recordOnly: Flag.Boolean("record-only").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Record the before migration's state and leave its migration.sql to write by hand, for a change the generator refuses",
      ),
    ),
  },
  Effect.fn("effect-drizzle-kit generate")(function* ({ config, name, renames, recordOnly }) {
    const written = yield* asUserError(
      Effect.flatMap(loadConfig(config), (loaded) =>
        generate(loaded, name, { renames, recordOnly }),
      ),
    );
    const extras = Arr.getSomes([written.before, written.after]);
    yield* Arr.isReadonlyArrayNonEmpty(extras)
      ? Effect.forEach(
          extras,
          (migration) =>
            Console.log(
              migration.recordOnly
                ? `Wrote ${migration.dir}: write its migration.sql by hand.`
                : `Wrote ${migration.dir}`,
            ),
          { concurrency: 1, discard: true },
        )
      : Console.log("No extras changes.");
  }),
).pipe(
  Command.withDescription(
    "Write the extras the config declares around drizzle-kit's own migration: extensions, domains and composite types before it, functions and triggers after it. Run it instead of drizzle-kit generate.",
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
