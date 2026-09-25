import { describe, expect, it } from "vite-plus/test";

/** Every published subpath resolves and loads (see packages/core/tests/subpaths.test.ts). */
describe("subpaths", () => {
  it("every export map entry loads", async () => {
    const modules = await Promise.all([
      import("@thomasfosterau/effect-drizzle-ext-pg"),
      import("@thomasfosterau/effect-drizzle-ext-pg/migrations"),
      import("@thomasfosterau/effect-drizzle-ext-pg/testing"),
      import("@thomasfosterau/effect-drizzle-ext-pg/tooling"),
    ]);
    expect(modules).toHaveLength(4);
  });
});
