/**
 * **`effect-drizzle-kit`, as a library**: the config module's
 * {@link defineConfig} and {@link loadConfig}, the `generate` / `check`
 * Effects the bin's subcommands run, and the {@link cli} command itself, for
 * a script that runs it with its own runtime. The bin is `bin.ts`.
 *
 * @module index
 */

export {
  DEFAULT_CONFIG_FILE,
  defineConfig,
  type KitConfig,
  KitConfigError,
  type LoadedConfig,
  loadConfig,
} from "./config.ts";
export {
  check,
  type CheckReport,
  cli,
  generate,
  type GenerateOptions,
  parseRename,
  version,
} from "./commands.ts";
