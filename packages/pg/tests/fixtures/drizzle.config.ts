import { defineConfig } from "drizzle-kit";

/** Regenerates `migrations/` from `schema.ts`; see that file's module doc. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./tests/fixtures/schema.ts",
  out: "./tests/fixtures/migrations",
});
