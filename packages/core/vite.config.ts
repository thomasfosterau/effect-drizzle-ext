import { defineConfig, type TestUserConfig } from "vite-plus";
import manifest from "./package.json" with { type: "json" };
import { packageConfig } from "../../vite.package.ts";

/**
 * Cache fingerprint: auto tracking minus node_modules churn, plus the
 * lockfile. The exact-path `!packages/core` drops this directory's listing,
 * which `tsc` reads to expand `include`, so a gitignored `coverage/` or
 * `node_modules/.vite` appearing beside `src/` doesn't miss `check` and
 * `build`.
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

export default defineConfig({ ...packageConfig(cacheInputs, manifest), test });
