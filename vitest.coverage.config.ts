/**
 * @copyright Thomas Foster
 *
 * The root `test:coverage` run: both packages' unit suites as vitest projects
 * under ONE Istanbul map at `coverage/coverage-final.json`, which
 * `fallow audit` reads (`.fallowrc.json` → `health.coverage`) for exact
 * per-function CRAP scores. Without the map fallow scores every function as
 * uncovered, and any function with cyclomatic complexity ≥ 5 fails its gate.
 *
 * A separate file because the root `vite.config.ts`'s `test` block is the
 * integration run (its global setup provisions a database). The per-package
 * thresholds stay on each package's own `test:coverage` task.
 */

import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    projects: ["packages/core/vite.config.ts", "packages/pg/vite.config.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
