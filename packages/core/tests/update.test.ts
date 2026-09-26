/**
 * The update tri-state seam (`src/update.ts`), ported from the preferenceflow
 * application's `apps/api/tests/update-fields.test.ts`.
 *
 * **Nothing here migrates to `Option`.** The nullable values in this file are
 * the tri-state the function under test implements — an absent key (or an
 * explicit `undefined`) carries the stored value forward, `null` clears it,
 * a value overwrites.
 *
 * @module packages/core/tests/update
 */

import * as HashSet from "effect/HashSet";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { insertValues, type UpdateSet, updateSetMap } from "../src/update.ts";

const writable = HashSet.make("name", "summary", "birthPlaceId", "slug");

describe("updateSetMap", () => {
  it("sets a present value", () => {
    expect(updateSetMap({ id: "x", name: "Next" }, writable)).toEqual({ name: "Next" });
  });

  it("clears a clearable column on a present null", () => {
    // oxlint-disable-next-line effect/prefer-option-over-null -- update tri-state: `summary: null` IS the "clear it" arm this case pins
    expect(updateSetMap({ id: "x", summary: null, birthPlaceId: null }, writable)).toEqual({
      summary: null,
      birthPlaceId: null,
    });
  });

  it("carries an absent key forward by leaving it out of the map", () => {
    expect(updateSetMap({ id: "x" }, writable)).toEqual({});
  });

  it("treats an explicit undefined as absent, not as a clear", () => {
    expect(updateSetMap({ id: "x", summary: undefined, name: "N" }, writable)).toEqual({
      name: "N",
    });
  });

  it("never writes the routing id, a server-owned column, or an unknown key", () => {
    expect(updateSetMap({ id: "x", createdAt: "now", nope: 1, slug: "s" }, writable)).toEqual({
      slug: "s",
    });
  });

  it("keeps the input's own key order", () => {
    expect(Object.keys(updateSetMap({ slug: "s", name: "n", summary: "t" }, writable))).toEqual([
      "slug",
      "name",
      "summary",
    ]);
  });

  it("accepts any iterable of writable keys", () => {
    expect(updateSetMap({ id: "x", name: "N" }, ["name"])).toEqual({ name: "N" });
    expect(updateSetMap({ id: "x", name: "N" }, new Set(["name"]))).toEqual({ name: "N" });
  });

  it("types the map as the writable keys, optional, without `undefined`", () => {
    /* oxlint-disable effect/prefer-option-over-null -- the tri-state input shape under test */
    type Input = {
      readonly id: string;
      readonly name?: string | undefined;
      readonly summary?: string | null | undefined;
    };
    /* oxlint-enable effect/prefer-option-over-null */
    const set = updateSetMap({ id: "x" } as Input, ["name", "summary"] as const);
    // oxlint-disable-next-line effect/prefer-option-over-null -- the tri-state output shape under test
    expectTypeOf(set).toEqualTypeOf<{ readonly name?: string; readonly summary?: string | null }>();
    expectTypeOf(set).toEqualTypeOf<UpdateSet<Input, "name" | "summary">>();
  });
});

describe("insertValues", () => {
  it("projects a create input onto the writable columns, leaving absent optionals to defaults", () => {
    expect(
      insertValues({ name: "N", slug: "n", registered: undefined, extra: 1 }, writable),
    ).toEqual({ name: "N", slug: "n" });
  });
});
