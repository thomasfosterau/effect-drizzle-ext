import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as R from "effect/Record";
import {
  DerivationError,
  dbColumn,
  defineTree,
  defineTreeFor,
  fieldColumns,
  type CheckedTreeSpec,
  type LevelSpec,
  type LeafName,
  type LevelName,
  type MarkerName,
} from "../src/index.ts";
import { DerivationError as DeriveDerivationError } from "../src/derive.ts";
import {
  defineResourceTree,
  defineResourceTreeFor,
  type CheckedResourceTreeSpec,
} from "../src/jsonapi/index.ts";
import { buildTree } from "../src/tree.ts";
import { bfoTree, flatTree, frbrTree } from "./fixtures/trees.ts";

const text = (column: string) => dbColumn(Schema.String, { column, pg: "text", notNull: false });

describe("defineTree: the application-shaped fixtures", () => {
  it("derives the FRBR spine's levels, ancestors and subtree leaves", () => {
    expect(frbrTree.names).toEqual([
      "work",
      "book",
      "essay",
      "manifestation",
      "edition",
      "agent",
      "person",
      "organisation",
    ]);
    expect(frbrTree.leaves).toEqual(["book", "essay", "edition", "person", "organisation"]);
    expect(frbrTree.branchRoots).toEqual(["work", "manifestation", "agent"]);
    const work = frbrTree.level("work");
    expect(work.parent).toStrictEqual(Option.none());
    expect(work.children).toEqual(["book", "essay"]);
    expect(work.subtreeLeaves).toEqual(["book", "essay"]);
    expect(R.keys(work.levelColumns)).toEqual(["title", "url"]);
    const book = frbrTree.level("book");
    expect(book.parent).toStrictEqual(Option.some("work"));
    expect(book.ancestors).toEqual(["work"]);
    expect(book.isLeaf).toBe(true);
    expect(book.subtreeLeaves).toEqual(["book"]);
    expect(book.branch).toBe("work");
    expect(book.leafColumns.pages?.column).toBe("pages");
    expect(frbrTree.level("manifestation").kind).toBe("fact-scoped");
    expect(frbrTree.level("work").kind).toBe("plain");
  });

  it("derives the BFO branches two marker levels deep", () => {
    expect(bfoTree.branchRoots).toEqual(["continuant", "occurrent"]);
    const plant = bfoTree.level("plant");
    expect(plant.ancestors).toEqual(["continuant", "independent_continuant", "material_entity"]);
    expect(plant.branch).toBe("continuant");
    expect(bfoTree.level("continuant").descendants).toEqual([
      "independent_continuant",
      "material_entity",
      "plant",
      "bed",
      "dependent_continuant",
      "document",
    ]);
    expect(bfoTree.level("continuant").subtreeLeaves).toEqual(["plant", "bed", "document"]);
    expect(bfoTree.level("independent_continuant").isLeaf).toBe(false);
  });

  it("derives the flat resource family, with the resource's columns as the leaf's", () => {
    expect(flatTree.level("works").subtreeLeaves).toEqual(["novel", "story", "poem"]);
    expect(flatTree.level("novel").leafColumns.wordCount?.column).toBe("word_count");
    expect(flatTree.level("agents").levelColumns).toEqual({});
  });

  it("hands each entry back, extension flags included", () => {
    const defineFlagged = defineTreeFor<{ readonly owned: boolean }>();
    const tree = defineFlagged({
      work: { owned: false },
      book: { parent: "work", leaf: {}, owned: true },
    });
    expect(tree.level("book").entry.owned).toBe(true);
    expect(tree.level("work").entry.owned).toBe(false);
  });
});

/**
 * The interpreter over a widened declaration: what a consumer reaches when the
 * spec's type can no longer name its levels (a spread, a computed key, a
 * registry built at run time), so the runtime checks are the only ones left.
 */
const buildWide = (spec: Readonly<Record<string, LevelSpec<string, Schema.Struct.Fields>>>) =>
  buildTree(spec, { levelColumns: fieldColumns, leafColumns: fieldColumns });

describe("defineTree: construction-time checks", () => {
  it("throws the DerivationError class ./derive exports", () => {
    expect(DerivationError).toBe(DeriveDerivationError);
    expect(() => defineTree({})).toThrow(DerivationError);
  });

  it("rejects an empty tree", () => {
    expect(() => defineTree({})).toThrow(/at least one level/);
  });

  it("rejects a name an object would reorder, and an empty one", () => {
    expect(() => defineTree({ 7: { leaf: {} } })).toThrow(/array index/);
    expect(() => defineTree({ "": { leaf: {} } })).toThrow(/empty name/);
  });

  it("rejects a parent that names no level, in the types and at run time", () => {
    expectTypeOf<{ readonly book: { readonly parent: "work" } }>().not.toExtend<
      CheckedTreeSpec<{ readonly book: { readonly parent: "work" } }, Schema.Struct.Fields, object>
    >();
    expect(() => buildWide({ book: { parent: "work", leaf: {} } })).toThrow(
      /names parent "work", which is not a level/,
    );
  });

  it("rejects a level that is its own parent, and a longer cycle", () => {
    type SelfParent = { readonly work: { readonly parent: "work" } };
    expectTypeOf<SelfParent>().not.toExtend<
      CheckedTreeSpec<SelfParent, Schema.Struct.Fields, object>
    >();
    expect(() =>
      buildWide({ work: { parent: "work" }, book: { parent: "work", leaf: {} } }),
    ).toThrow(/cycle: work → work$/);
    expect(() =>
      defineTree({
        a: { parent: "b" },
        b: { parent: "a" },
        leaf: { parent: "a", leaf: {} },
      }),
    ).toThrow(/cycle: a → b → a$/);
  });

  it("rejects a leaf with children", () => {
    expect(() =>
      defineTree({
        book: { leaf: {} },
        chapter: { parent: "book", leaf: {} },
      }),
    ).toThrow(/leaf "book" has children \(chapter\)/);
  });

  it("rejects a marker with no leaf below it", () => {
    expect(() => defineTree({ work: {}, book: { parent: "work" } })).toThrow(
      /marker level "work" has no leaf below it/,
    );
  });

  it("rejects an unannotated level column", () => {
    expect(() =>
      defineTree({
        work: { columns: { title: Schema.String } },
        book: { parent: "work", leaf: {} },
      }),
    ).toThrow(/no dbColumn annotation \(title\)/);
  });

  it("rejects a reserved field key or column name", () => {
    expect(() =>
      defineTree({ work: { columns: { type: text("kind") } }, book: { parent: "work", leaf: {} } }),
    ).toThrow(/declares "type" \(column "kind"\).*reserved/);
    expect(() => defineTree({ book: { leaf: { revision: text("version") } } })).toThrow(
      /declares "revision" \(column "version"\).*reserved/,
    );
  });

  it("rejects a level column a descendant redeclares, by key or by column name", () => {
    expect(() =>
      defineTree({
        work: { columns: { title: text("title") } },
        book: { parent: "work", leaf: { title: text("book_title") } },
      }),
    ).toThrow(
      /"title" \(column "book_title"\) on level "book" collides with "title" \(column "title"\) on level "work"/,
    );
    expect(() =>
      defineTree({
        work: { columns: { title: text("title") } },
        group: { parent: "work", columns: { heading: text("title") } },
        book: { parent: "group", leaf: {} },
      }),
    ).toThrow(/"heading" \(column "title"\) on level "group" collides with "title"/);
  });

  it("lets sibling leaves reuse a column name", () => {
    const tree = defineTree({
      work: {},
      book: { parent: "work", leaf: { note: text("note") } },
      film: { parent: "work", leaf: { note: text("note") } },
    });
    expect(tree.leaves).toEqual(["book", "film"]);
  });

  it("rejects a resource leaf whose type is not its level's name, in the types and at run time", () => {
    const Film = Resource.make("film", { attributes: {} });
    type Misfiled = { readonly book: { readonly leaf: typeof Film } };
    expectTypeOf<Misfiled>().not.toExtend<CheckedResourceTreeSpec<Misfiled, object>>();
    // Widened, as a registry assembled at run time would be.
    const misfiled = R.fromEntries([["book", { leaf: Film }]]);
    expect(() => defineResourceTree(misfiled)).toThrow(/leaf "book" carries resource "film"/);
  });

  it("checks a resource leaf's columns like any other", () => {
    const Book = Resource.make("book", { attributes: { title: text("title") } });
    expect(() =>
      defineResourceTreeFor<Record<never, never>>()({
        work: { columns: { title: text("title") } },
        book: { parent: "work", leaf: Book },
      }),
    ).toThrow(/collides with "title"/);
  });

  it("rejects a lookup of a name the tree does not declare", () => {
    const tree = buildWide({ book: { leaf: {} } });
    expect(() => tree.level("film")).toThrow(/"film" is not a level/);
  });
});

describe("defineTree: the level-name types", () => {
  it("splits the level names into leaves and markers", () => {
    type Spec = typeof frbrTree.spec;
    expectTypeOf<LevelName<Spec>>().toEqualTypeOf<
      "work" | "book" | "essay" | "manifestation" | "edition" | "agent" | "person" | "organisation"
    >();
    expectTypeOf<LeafName<Spec>>().toEqualTypeOf<
      "book" | "essay" | "edition" | "person" | "organisation"
    >();
    expectTypeOf<MarkerName<Spec>>().toEqualTypeOf<"work" | "manifestation" | "agent">();
    expectTypeOf(frbrTree.leaves).toEqualTypeOf<
      ReadonlyArray<"book" | "essay" | "edition" | "person" | "organisation">
    >();
    expectTypeOf(frbrTree.level).parameter(0).toEqualTypeOf<LevelName<Spec>>();
  });

  it("requires the extension record on every entry", () => {
    type Flags = { readonly owned: boolean };
    type Unflagged = { readonly work: { readonly leaf: Schema.Struct.Fields } };
    expectTypeOf<Unflagged>().not.toExtend<
      CheckedTreeSpec<Unflagged, Schema.Struct.Fields, Flags>
    >();
    type Flagged = { readonly work: { readonly leaf: Schema.Struct.Fields; readonly owned: true } };
    expectTypeOf<Flagged>().toExtend<CheckedTreeSpec<Flagged, Schema.Struct.Fields, Flags>>();
  });
});
