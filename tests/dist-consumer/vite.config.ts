import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // Type-checks the emitted declarations; depends on both packages' builds
      // so `vp run check` at the root always exercises fresh `dist/` output.
      //
      // Named explicitly: this package declares no workspace dependency (the
      // `paths` mapping in tsconfig.json is the whole resolution), so a
      // `from: "dependencies"` edge resolves to nothing and no build ran. On a
      // fresh runner `dist/` then did not exist, the `paths` entries missed,
      // and TypeScript fell back to the hoisted workspace symlink — whose
      // `exports` point at `src/` — so the check passed against the SOURCES,
      // never the emitted declarations it exists to gate.
      check: {
        command: "tsc -p tsconfig.json",
        dependsOn: [
          "@thomasfosterau/effect-drizzle-ext#build",
          "@thomasfosterau/effect-drizzle-ext-pg#build",
        ],
        input: [
          { auto: true },
          "!node_modules/**",
          // `tsc` probes for `packages/core/node_modules` while resolving
          // the emitted declarations' imports; vitest creates it (`.vite`),
          // so without this exact-path exclusion the check missed once after
          // every `test:unit` (effect-drizzle-ext#81, ported from pulpit#66).
          // Only the directory entry is dropped. When the cache was recorded
          // without that directory, the entry was the only signal of a
          // package appearing in it, so the exclusion relies on the lockfile
          // input below to catch a dependency change.
          { pattern: "!packages/core/node_modules", base: "workspace" as const },
          { pattern: "packages/*/dist/**", base: "workspace" as const },
          { pattern: "pnpm-lock.yaml", base: "workspace" as const },
        ],
        output: [],
      },
    },
  },
});
