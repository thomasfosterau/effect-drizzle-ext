import { defineConfig, type TestUserConfig } from "vite-plus";
import { packageTasks } from "../../vite.package.ts";

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

/** The unit-test config: this package's tests, timeout and coverage gate. */
const test: TestUserConfig = {
  include: ["tests/**/*.test.ts"],
  testTimeout: 30_000,
  coverage: {
    provider: "istanbul",
    reporter: ["text-summary", "json-summary"],
    reportsDirectory: "./coverage",
    include: ["src/**/*.ts"],
    exclude: ["**/*.d.ts"],
    thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
  },
};
// `VITEST_MAX_WORKERS` caps the worker pool only when set; unset, the key stays
// absent and Vitest picks its own default.
if (process.env.VITEST_MAX_WORKERS) test.maxWorkers = Number(process.env.VITEST_MAX_WORKERS);

export default defineConfig({
  run: { tasks: packageTasks(cacheInputs) },
  test,
});
