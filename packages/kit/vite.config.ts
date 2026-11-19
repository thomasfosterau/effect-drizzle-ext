import { defineConfig, type TestUserConfig } from "vite-plus";
import manifest from "./package.json" with { type: "json" };
import { packageConfig } from "../../vite.package.ts";

/**
 * Same fingerprint shape and rationale as packages/pg/vite.config.ts: the
 * bare package directory and the sibling packages' `node_modules` are
 * excluded so `check` and `build` hit after a test run, and the lockfile
 * catches a real dependency change.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  { pattern: "!packages/kit", base: "workspace" as const },
  { pattern: "!packages/core/node_modules", base: "workspace" as const },
  { pattern: "!packages/pg/node_modules", base: "workspace" as const },
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

/** The unit-test config: this package's tests, timeout and coverage gate. */
const test: TestUserConfig = {
  include: ["tests/**/*.test.ts"],
  exclude: ["**/node_modules/**", "**/dist/**"],
  testTimeout: 30_000,
  coverage: {
    provider: "istanbul",
    reporter: ["text-summary", "json-summary"],
    reportsDirectory: "./coverage",
    include: ["src/**/*.ts"],
    exclude: ["**/*.d.ts"],
    // `bin.ts` only wires the runtime; the commands and the config loader are
    // covered end to end against a scratch migrations directory.
    thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
  },
};
// `VITEST_MAX_WORKERS` caps the worker pool only when set; unset, the key stays
// absent and Vitest picks its own default.
if (process.env.VITEST_MAX_WORKERS) test.maxWorkers = Number(process.env.VITEST_MAX_WORKERS);

export default defineConfig({ ...packageConfig(cacheInputs, manifest), test });
