import { describe, expect, it } from "vite-plus/test";

/**
 * Every published subpath resolves and loads. A subpath that fails to import
 * (a missing file, a top-level throw, a circular import) fails here before it
 * fails in a consumer.
 */
describe("subpaths", () => {
  it("every export map entry loads", async () => {
    const modules = await Promise.all([
      import("@thomasfosterau/effect-drizzle-ext"),
      import("@thomasfosterau/effect-drizzle-ext/derive"),
      import("@thomasfosterau/effect-drizzle-ext/references"),
      import("@thomasfosterau/effect-drizzle-ext/constraints"),
      import("@thomasfosterau/effect-drizzle-ext/columns"),
      import("@thomasfosterau/effect-drizzle-ext/query"),
      import("@thomasfosterau/effect-drizzle-ext/errors"),
      import("@thomasfosterau/effect-drizzle-ext/database"),
      import("@thomasfosterau/effect-drizzle-ext/versioned-chain"),
      import("@thomasfosterau/effect-drizzle-ext/jsonapi"),
      import("@thomasfosterau/effect-drizzle-ext/jsonapi/derive"),
    ]);
    expect(modules).toHaveLength(11);
  });
});
