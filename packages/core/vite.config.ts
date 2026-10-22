import { defineConfig } from "vite-plus";

/**
 * Input fingerprint for this package's cached tasks: auto tracking minus
 * node_modules bookkeeping churn (pnpm rewrites `.modules.yaml` on every
 * install), with the lockfile back explicitly so a dependency upgrade still
 * invalidates a type-check or a test run.
 *
 * The bare `packages/core` exclusion drops one auto-tracked entry, the listing
 * of this directory, which `tsc` reads to expand the tsconfig `include`
 * (effect-drizzle-ext#81, ported from pulpit#66). Without it, a gitignored
 * directory appearing beside `src/` (vitest's `node_modules/.vite`,
 * `coverage/`) misses `check` and `build` once, and in CI misses `build`,
 * since `test:unit` runs between them. A `!x/**` glob never matches the entry
 * `x` itself, so this takes the exact path. The listings of `src/` and
 * `tests/` are their own entries and stay tracked, so adding, renaming or
 * deleting a file there still misses; a new file at the top level is outside
 * `include`. The files vitest looks up by path at the top level
 * (`vitest.config.ts`, `.env*`) stay tracked as specific-path lookups.
 *
 * The dropped listing was also the only signal that `packages/core/
 * node_modules` appeared when the cache was recorded without it, as it is
 * under the hoisted install. A real install that nests a package there
 * changes `pnpm-lock.yaml`, which is tracked; a hand-made nested directory is
 * not caught, which is accepted.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  { pattern: "!packages/core", base: "workspace" as const },
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

export default defineConfig({
  run: {
    tasks: {
      check: {
        command: "tsc -p tsconfig.json",
        cache: { input: cacheInputs, output: [] },
      },
      // Emits `dist/` (JavaScript + declarations) with the native, Effect-
      // patched `tsc`. `rm -rf` first so a renamed module leaves no stale file.
      //
      // The parentheses keep the clean and the emit ONE cached task
      // (effect-drizzle-ext#79, ported from pulpit#63). Vite+ splits a
      // top-level `&&` into sub-tasks cached separately, and then each saw the
      // other's change to `dist/` as an input change, so the build never hit;
      // excluding `dist/**` from a split pair would instead let the `rm` hit
      // and be skipped while `tsc` re-emitted over the old tree, leaving a
      // renamed module's files behind. As one task, every miss cleans, and a
      // hit restores `dist/**` from the cache, so a deleted `dist/` comes back.
      // A restore writes the cached files (adding missing ones, overwriting
      // edited ones) but never prunes, so a stray file in `dist/` survives a
      // hit: one written by hand or by a bare `tsc`, or left by a different
      // task config on another branch. `tsconfig.build.json` sets
      // `noEmitOnError`, so a failed build writes nothing for the next hit to
      // keep. `vp run -r --no-cache build` clears a stray.
      build: {
        command: "(rm -rf dist && tsc -p tsconfig.build.json)",
        cache: { input: [...cacheInputs, "!dist/**"], output: ["dist/**"] },
      },
      "test:unit": {
        command: "vp test run tests",
        cache: { env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"], input: cacheInputs, output: [] },
      },
      "test:coverage": {
        command: "vp test run tests --coverage",
        cache: {
          env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
          input: cacheInputs,
          output: ["coverage/**"],
        },
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    ...(process.env.VITEST_MAX_WORKERS
      ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) }
      : {}),
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
