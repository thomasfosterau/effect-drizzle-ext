import { defineProject } from "vite-plus";

/**
 * This package's slice of the integration suite, as a vitest **project** the
 * root `test:integration` task lists under `test.projects`. The lifecycle
 * (provisioning, teardown) stays at the root's `globalSetup`; the files live
 * here with the package whose behaviour they pin. Run just this slice with
 * `--project pg-integration`.
 */
export default defineProject({
  test: {
    name: "pg-integration",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
