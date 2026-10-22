/**
 * @copyright Thomas Foster
 *
 * The task graph both published packages share (`check`, `build`,
 * `test:unit`, `test:coverage`). Each `packages/<name>/vite.config.ts` passes
 * its own cache fingerprint (the inputs differ per package; each config says
 * why) and keeps its own vitest block.
 */

import type { defineConfig } from "vite-plus";

type RunTasks = NonNullable<NonNullable<Parameters<typeof defineConfig>[0]["run"]>["tasks"]>;
type CacheInputs = ReadonlyArray<
  | string
  | { readonly pattern: string; readonly base: "workspace" | "package" }
  | { readonly auto: boolean }
>;

/**
 * The four package tasks over `cacheInputs`. A sibling workspace package is
 * consumed through its `exports`, so `check` and `build` depend on the same
 * task in every workspace dependency (an empty edge for a package with none).
 */
export const packageTasks = (cacheInputs: CacheInputs): RunTasks => {
  const input = [...cacheInputs];
  const testEnv = ["VITEST_MAX_WORKERS", "NODE_OPTIONS"];
  return {
    check: {
      command: "tsc -p tsconfig.json",
      dependsOn: [{ task: "check", from: "dependencies" }],
      cache: { input, output: [] },
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
  };
};
