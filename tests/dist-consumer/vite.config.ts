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
          { pattern: "packages/*/dist/**", base: "workspace" as const },
        ],
        output: [],
      },
    },
  },
});
