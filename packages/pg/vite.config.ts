import { defineConfig } from "vite-plus";

/** Same fingerprint shape and rationale as packages/core/vite.config.ts. */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

export default defineConfig({
  run: {
    tasks: {
      check: {
        command: "tsc -p tsconfig.json",
        dependsOn: [{ task: "check", from: "dependencies" }],
        input: cacheInputs,
        output: [],
      },
      // One subshell plus `!dist/**`, for the reasons on core's `build`
      // (effect-drizzle-ext#79).
      build: {
        command: "(rm -rf dist && tsc -p tsconfig.build.json)",
        dependsOn: [{ task: "build", from: "dependencies" }],
        input: [...cacheInputs, "!dist/**"],
        output: ["dist/**"],
      },
      "test:unit": {
        command: "vp test run tests",
        env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
        input: cacheInputs,
        output: [],
      },
      "test:coverage": {
        command: "vp test run tests --coverage",
        env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
        input: cacheInputs,
        output: ["coverage/**"],
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // `tests/integration/` is this package's slice of the ROOT
    // `test:integration` run — a vitest project registered in the root
    // config, not part of the unit suite. Without this exclusion the
    // `tests/**` include above sweeps those specs into `test:unit`, where
    // they would run with no provisioned database and no global setup.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
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
      // Most of this package only does something against a live database; the
      // unit gate covers the pure surface (connect-retry classification, the
      // rollback-signal walk, layer composition). Ratchet upward as it grows.
      thresholds: { statements: 40, branches: 30, functions: 40, lines: 40 },
    },
  },
});
