/**
 * @copyright Thomas Foster
 *
 * The task graph both published packages share (`check`, `build`,
 * `test:unit`, `test:coverage`, `docgen`) and the `vp pack` config `build`
 * runs. Each `packages/<name>/vite.config.ts` passes its own cache
 * fingerprint (the inputs differ per package; each config says why) and its
 * manifest, and keeps its own vitest block.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ViteUserConfig } from "vite-plus";
import type { PackUserConfig } from "vite-plus/pack";

type RunTasks = NonNullable<NonNullable<ViteUserConfig["run"]>["tasks"]>;
type CacheInputs = ReadonlyArray<
  | string
  | { readonly pattern: string; readonly base: "workspace" | "package" }
  | { readonly auto: boolean }
>;

/**
 * The five package tasks over `cacheInputs`. A sibling workspace package is
 * consumed through its `exports`, so `check` and `build` depend on the same
 * task in every workspace dependency (an empty edge for a package with none).
 */
const packageTasks = (cacheInputs: CacheInputs): RunTasks => {
  const input = [...cacheInputs];
  const testEnv = ["VITEST_MAX_WORKERS", "NODE_OPTIONS"];
  return {
    check: {
      command: "tsc -p tsconfig.json",
      dependsOn: [{ task: "check", from: "dependencies" }],
      cache: { input, output: [] },
    },
    // Emits `dist/` (JavaScript + declarations) with `vp pack` (tsdown); the
    // package's `pack` block is `packageBuild` below. tsdown cleans `dist/`
    // first, so a renamed module leaves no stale file.
    //
    // One command, so one cached task (effect-drizzle-ext#79, ported from
    // pulpit#63): Vite+ splits a top-level `&&` into sub-tasks cached
    // separately, and a separate clean and emit each saw the other's change
    // to `dist/` as an input change, so the build never hit. Every miss
    // cleans, and a hit restores `dist/**` from the cache, so a deleted
    // `dist/` comes back. A restore writes the cached files (adding missing
    // ones, overwriting edited ones) but never prunes, so a stray file in
    // `dist/` survives a hit: one written by hand or by a bare `tsc`, or left
    // by a different task config on another branch (a shared chunk's name
    // carries a content hash, so one from another branch is a stray too).
    // `vp run -r --no-cache build` clears a stray.
    build: {
      command: "vp pack",
      dependsOn: [{ task: "build", from: "dependencies" }],
      cache: { input: [...input, "!dist/**"], output: ["dist/**"] },
    },
    "test:unit": {
      command: "vp test run tests",
      cache: { env: testEnv, input, output: [] },
    },
    "test:coverage": {
      command: "vp test run tests --coverage",
      cache: { env: testEnv, input, output: ["coverage/**"] },
    },
    // Type-checks AND RUNS every JSDoc `@example` (docgen.json sets
    // `runExamples`). Examples import the packages by name, exactly as a
    // consumer would; the workspace `exports` resolve that name to `src/`, so
    // no build is needed first. `docs/` is generated and gitignored.
    docgen: {
      command: "docgen",
      cache: { input: [...input, "!docs/**"], output: ["docs/**"] },
    },
  };
};

/** The slice of a package's `package.json` the bundle's entries come from. */
interface PackageManifest {
  readonly exports: { readonly [subpath: string]: string };
  readonly publishConfig: {
    readonly exports: {
      readonly [subpath: string]: { readonly types: string; readonly default: string };
    };
  };
}

/**
 * The native TypeScript 7 binary (`@typescript/native`, the same compiler
 * `check` runs). The `typescript` package name is the TS6 alias, so left to
 * itself tsdown would emit declarations through TS6's JS API instead; the
 * binary isn't on the package's `exports`, so it is found the way tsdown finds
 * one itself, through the package's own `lib/getExePath.js`.
 */
const tsgoPath = (): string => {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@typescript/native/package.json"));
  const getExePath: () => string = require(join(root, "lib/getExePath.js")).default;
  return getExePath();
};

/**
 * The `vp pack` config for a package (effect-drizzle-ext#88): one entry per
 * `publishConfig.exports` subpath, named after its `dist/` path so the
 * published exports map stays as it was, and built from the workspace export
 * of the same subpath. Declarations come from the native compiler over
 * `tsconfig.build.json` and are then bundled, so the dist-consumer check
 * (`tests/dist-consumer`) asserts the bundled output.
 */
const packageBuild = (manifest: PackageManifest): PackUserConfig => ({
  // The root `package.json` lists `effect` as a dev dependency, and fallow
  // counts a value import from this file as production use of it.
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- build config: effect/Record here is a fallow dev-dependency-in-production finding
  entry: Object.fromEntries(
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- build config: effect/Record here is a fallow dev-dependency-in-production finding
    Object.entries(manifest.publishConfig.exports).map(([subpath, target]) => [
      target.default.replace(/^\.\/dist\//, "").replace(/\.js$/, ""),
      manifest.exports[subpath],
    ]),
  ),
  format: "esm",
  platform: "neutral",
  sourcemap: true,
  // `src/` ships in the tarball beside `dist/` (the maps' `sources` point at
  // it, as `tsc`'s did), so the maps carry no copy of it.
  outputOptions: { sourcemapExcludeSources: true },
  dts: {
    generator: "tsgo",
    tsgo: { path: tsgoPath() },
    tsconfig: "tsconfig.build.json",
    sourcemap: true,
  },
});

/**
 * A package's `run` and `pack` config: the shared tasks over its cache
 * fingerprint, and the `vp pack` config from its manifest. Each package's
 * `vite.config.ts` spreads it beside its own vitest block.
 */
export const packageConfig = (
  cacheInputs: CacheInputs,
  manifest: PackageManifest,
): Pick<ViteUserConfig, "run" | "pack"> => ({
  run: { tasks: packageTasks(cacheInputs) },
  pack: packageBuild(manifest),
});
