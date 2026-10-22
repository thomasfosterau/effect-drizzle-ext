import { defineConfig, type TestUserConfig } from "vite-plus";
import manifest from "./package.json" with { type: "json" };
import { packageConfig } from "../../vite.package.ts";

/**
 * Same fingerprint shape and rationale as packages/core/vite.config.ts,
 * including the bare-directory exclusion (here `packages/pg`; e.g. a
 * `coverage/` beside `src/` otherwise missed `check` and `build`).
 *
 * `packages/core/node_modules` is a different entry: `tsc` probes it while
 * resolving core's imports through the workspace link, and vitest creates it
 * (`.vite`) when it runs core's tests, so without this exact-path exclusion
 * `check` and `build` missed once after every `test:unit`
 * (effect-drizzle-ext#81). This package's own `node_modules/` already exists
 * when the cache is recorded (it holds the workspace link), so its listing
 * isn't lost. As in core, the lockfile input catches a real dependency change
 * that nests a package under either directory.
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
  // `tests/integration/` is this package's slice of the ROOT
  // `test:integration` run — a vitest project registered in the root
  // config, not part of the unit suite. Without this exclusion the
  // `tests/**` include above sweeps those specs into `test:unit`, where
  // they would run with no provisioned database and no global setup.
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
