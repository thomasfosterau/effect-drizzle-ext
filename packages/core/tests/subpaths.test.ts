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
      import("@thomasfosterau/effect-drizzle-ext/Derive"),
      import("@thomasfosterau/effect-drizzle-ext/References"),
      import("@thomasfosterau/effect-drizzle-ext/Constraints"),
      import("@thomasfosterau/effect-drizzle-ext/Columns"),
      import("@thomasfosterau/effect-drizzle-ext/Query"),
      import("@thomasfosterau/effect-drizzle-ext/QueryFunctions"),
      import("@thomasfosterau/effect-drizzle-ext/Sort"),
      import("@thomasfosterau/effect-drizzle-ext/Update"),
      import("@thomasfosterau/effect-drizzle-ext/Errors"),
      import("@thomasfosterau/effect-drizzle-ext/Database"),
      import("@thomasfosterau/effect-drizzle-ext/VersionedChain"),
      import("@thomasfosterau/effect-drizzle-ext/PostGis"),
      import("@thomasfosterau/effect-drizzle-ext/JsonApi"),
      import("@thomasfosterau/effect-drizzle-ext/JsonApiDerive"),
      import("@thomasfosterau/effect-drizzle-ext/Predicate"),
      import("@thomasfosterau/effect-drizzle-ext/Where"),
      import("@thomasfosterau/effect-drizzle-ext/Search"),
    ]);
    expect(modules).toHaveLength(18);
  });
});
