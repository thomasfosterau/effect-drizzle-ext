/**
 * The `effect-drizzle-kit` config module: what `defineConfig` types, and how
 * `loadConfig` finds, imports (with Node's type stripping) and checks it. See
 * the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/kit/overview.md).
 *
 * @module config
 */

import type {
  DrizzleKitTarget,
  Extras,
  SchemaModule,
} from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
import { CompositeType, Domain, Extension } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
import type * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

/** The config file {@link loadConfig} reads when none is named. */
export const DEFAULT_CONFIG_FILE = "effect-drizzle-kit.config.ts";

/** What an `effect-drizzle-kit.config.ts` exports by default. Paths are relative to the config file. */
export interface KitConfig {
  /** The drizzle-kit migrations directory. */
  readonly migrationsDir: string;
  /** How drizzle-kit is configured: a `drizzle.config.ts` whose `out` is `migrationsDir`, or a schema path. */
  readonly drizzleKit: DrizzleKitTarget;
  /** The extensions, domains and composite types drizzle-kit doesn't manage. */
  readonly extras?: Extras;
  /**
   * The Drizzle schema module (`import * as schema from "./src/schema.ts"`);
   * when present, `check` also runs `checkMigrationDrift` against it.
   */
  readonly schema?: SchemaModule;
  /** The command that runs drizzle-kit; `["drizzle-kit"]` on `PATH` when absent. */
  readonly command?: Arr.NonEmptyReadonlyArray<string>;
}

/**
 * Type an `effect-drizzle-kit.config.ts`'s default export; returns it unchanged.
 *
 * @example
 * ```ts
 * import { defineConfig } from "@thomasfosterau/effect-drizzle-ext-kit";
 * import { domain, extension } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
 *
 * export default defineConfig({
 *   migrationsDir: "migrations",
 *   drizzleKit: { config: "drizzle.config.ts" },
 *   extras: {
 *     extensions: [extension("citext")],
 *     domains: [domain("email", "citext", { notNull: true })],
 *   },
 * });
 * ```
 */
export const defineConfig = (config: KitConfig): KitConfig => config;

/** The shape {@link loadConfig} checks the default export against: the typed values, not an encoding. */
const CheckedKitConfig = Schema.Struct({
  migrationsDir: Schema.String,
  drizzleKit: Schema.Union([
    Schema.Struct({ config: Schema.String }),
    Schema.Struct({ schema: Schema.String }),
  ]),
  extras: Schema.optionalKey(
    Schema.Struct({
      extensions: Schema.optionalKey(Schema.Array(Schema.toType(Extension))),
      domains: Schema.optionalKey(Schema.Array(Schema.toType(Domain))),
      compositeTypes: Schema.optionalKey(Schema.Array(Schema.toType(CompositeType))),
    }),
  ),
  schema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  command: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
});

const ConfigModule = Schema.Struct({ default: CheckedKitConfig });

/** The config file is missing, failed to import, or its default export isn't a {@link KitConfig}. */
export class KitConfigError extends Schema.TaggedError<KitConfigError>()("KitConfigError", {
  file: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `${this.file}: ${this.reason}`;
  }
}

/** A loaded config: the checked {@link KitConfig} and the directory its paths are relative to. */
export interface LoadedConfig {
  /** The config file's absolute path. */
  readonly file: string;
  /** Its directory: where drizzle-kit runs, and what relative paths resolve against. */
  readonly dir: string;
  readonly config: KitConfig;
}

/**
 * Import the config module at `file` (relative to the process's directory)
 * and check its default export. Fails with {@link KitConfigError} naming the
 * file when it is missing, throws while importing, or exports the wrong shape.
 */
export const loadConfig = Effect.fn("KitConfig.loadConfig")(function* (
  file: string,
): Effect.fn.Return<
  LoadedConfig,
  KitConfigError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(file);
  if (!(yield* fs.exists(absolute))) {
    return yield* new KitConfigError({
      file: absolute,
      reason: `no config file; create one whose default export is defineConfig({ … }), or pass --config.`,
      cause: undefined,
    });
  }
  const url = yield* path
    .toFileUrl(absolute)
    .pipe(
      Effect.mapError(
        (cause) => new KitConfigError({ file: absolute, reason: "not a file path", cause }),
      ),
    );
  const imported: unknown = yield* Effect.tryPromise({
    try: () => import(url.href),
    catch: (cause) =>
      new KitConfigError({
        file: absolute,
        reason: `failed to import: ${P.isError(cause) ? cause.message : String(cause)}`,
        cause,
      }),
  });
  const loaded = yield* Schema.decodeUnknownEffect(ConfigModule)(imported).pipe(
    Effect.mapError(
      (cause) =>
        new KitConfigError({
          file: absolute,
          reason: `its default export isn't a defineConfig({ … }) config:\n${cause.message}`,
          cause,
        }),
    ),
  );
  return { file: absolute, dir: path.dirname(absolute), config: loaded.default };
});
