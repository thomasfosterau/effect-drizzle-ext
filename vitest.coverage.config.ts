/**
 * The root `test:coverage` run: every unit suite under one Istanbul map, which
 * `fallow audit` reads. Separate from vite.config.ts, whose `test` block is
 * the integration run.
 */

import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    projects: [
      "packages/core/vite.config.ts",
      "packages/pg/vite.config.ts",
      "packages/kit/vite.config.ts",
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
