/**
 * The task graph every published package shares (`check`, `build`,
 * `test:unit`, `test:coverage`, `docgen`) and the `vp pack` config `build`
 * runs. Each `packages/<name>/vite.config.ts` passes its own cache
 * fingerprint (the inputs differ per package; each config says why) and its
 * manifest, and keeps its own vitest block.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as R from "effect/Record";
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
    // One command, so one cached task: Vite+ caches each `&&` part
    // separately. A cache hit restores `dist/**` but never prunes stray files;
    // `vp run -r --no-cache build` clears them.
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
      command: 'PATH="$(cd ../../scripts/bin && pwd):$PATH" docgen',
      cache: { input: [...input, "!docs/**"], output: ["docs/**"] },
    },
  };
};

/** The slice of a package's `package.json` the bundle's entries come from. */
interface PackageManifest {
  readonly exports: { readonly [subpath: string]: string };
  /** Each bin's workspace source (the kit package's `effect-drizzle-kit`). */
  readonly bin?: { readonly [name: string]: string };
  readonly publishConfig: {
    readonly exports: {
      readonly [subpath: string]: { readonly types: string; readonly default: string };
    };
    /** Each bin's published `dist/` file, built from the workspace `bin` of the same name. */
    readonly bin?: { readonly [name: string]: string };
  };
}

/** A `dist/` target's entry name: its path under `dist/`, without the extension. */
const entryName = (target: string): string =>
  target.replace(/^\.\/dist\//, "").replace(/\.js$/, "");

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
 * The `vp pack` config for a package: one entry per `publishConfig.exports`
 * subpath and `publishConfig.bin`, named after its `dist/` path and built from
 * the workspace export (or `bin`) of the same name. Declarations come from the native compiler over
 * `tsconfig.build.json` and are then bundled, so the dist-consumer check
 * (`tests/dist-consumer`) asserts the bundled output.
 */
const packageBuild = (manifest: PackageManifest): PackUserConfig => ({
  entry: R.fromEntries([
    ...R.toEntries(manifest.publishConfig.exports).map(
      ([subpath, target]) => [entryName(target.default), manifest.exports[subpath]] as const,
    ),
    ...R.toEntries(manifest.publishConfig.bin ?? {}).flatMap(([name, target]) => {
      const source = manifest.bin?.[name];
      return source === undefined ? [] : [[entryName(target), source] as const];
    }),
  ]),
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
