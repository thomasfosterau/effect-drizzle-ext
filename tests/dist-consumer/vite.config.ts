import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // Type-checks the emitted declarations, then walks the root entry's
      // built module graph for a `drizzle-orm` import (scripts/
      // root-entry-graph.ts). The builds are named explicitly: this package
      // resolves the others through tsconfig `paths`, not a workspace
      // dependency, and without fresh `dist/` the check would fall back to
      // `src/`.
      check: {
        command: "tsc -p tsconfig.json && node scripts/root-entry-graph.ts",
        dependsOn: [
          "@thomasfosterau/effect-drizzle-ext#build",
          "@thomasfosterau/effect-drizzle-ext-pg#build",
        ],
        cache: {
          input: [
            { auto: true },
            "!node_modules/**",
            // As in packages/pg/vite.config.ts.
            { pattern: "!packages/core/node_modules", base: "workspace" as const },
            { pattern: "packages/*/dist/**", base: "workspace" as const },
            { pattern: "pnpm-lock.yaml", base: "workspace" as const },
          ],
          output: [],
        },
      },
    },
  },
});
