import { defineConfig, type TestUserConfig } from "vite-plus";
import manifest from "./package.json" with { type: "json" };
import { packageConfig } from "../../vite.package.ts";

/**
 * As in packages/core/vite.config.ts; `packages/core/node_modules` is also
 * excluded because vitest creates it while `tsc` probes it.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  { pattern: "!packages/pg", base: "workspace" as const },
  { pattern: "!packages/core/node_modules", base: "workspace" as const },
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

/** The unit-test config: this package's tests (integration excluded), timeout and coverage gate. */
const test: TestUserConfig = {
  include: ["tests/**/*.test.ts"],
  // `tests/integration/` runs under the root `test:integration` task.
  exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
  testTimeout: 30_000,
  coverage: {
    provider: "istanbul",
    reporter: ["text-summary", "json-summary"],
    reportsDirectory: "./coverage",
    include: ["src/**/*.ts"],
    exclude: ["**/*.d.ts"],
    // Most of this package only does something against a live database; the
    // unit gate covers the pure surface (connect-retry classification, the
    // rollback-signal walk, layer composition). Ratchet upward as it grows.
    thresholds: { statements: 40, branches: 30, functions: 40, lines: 40 },
  },
};
// `VITEST_MAX_WORKERS` caps the worker pool only when set; unset, the key stays
// absent and Vitest picks its own default.
if (process.env.VITEST_MAX_WORKERS) test.maxWorkers = Number(process.env.VITEST_MAX_WORKERS);

export default defineConfig({ ...packageConfig(cacheInputs, manifest), test });
