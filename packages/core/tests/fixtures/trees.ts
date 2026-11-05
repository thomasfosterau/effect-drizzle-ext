/**
 * Tree declarations with the shape of each consuming application, the fixtures
 * the versioned-ontology slices (effect-drizzle-ext#112) build on. Column kinds
 * are the generic `text` / `integer` / `boolean` / `timestamp` set; no
 * application's own vocabulary or schema is copied.
 */
import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Schema from "effect/Schema";
import { dbColumn, defineTree } from "../../src/index.ts";
import { defineResourceTree } from "../../src/jsonapi/index.ts";

const text = <const C extends string>(column: C) =>
  dbColumn(Schema.String, { column, pg: "text", notNull: false });
const requiredText = <const C extends string>(column: C) =>
  dbColumn(Schema.String, { column, pg: "text", notNull: true });
const integer = <const C extends string>(column: C) =>
  dbColumn(Schema.Finite, { column, pg: "integer", notNull: false });

/**
 * A FRBR-style spine (website): a `work` level whose `title` / `url` reach
 * every work leaf's view, a fact-scoped `manifestation` level, and an agent
 * branch.
 */
export const frbrTree = defineTree({
  work: { columns: { title: requiredText("title"), url: text("url") } },
  book: { parent: "work", leaf: { pages: integer("pages") } },
  essay: { parent: "work", leaf: { abstract: text("abstract") } },
  manifestation: {
    kind: "fact-scoped",
    columns: { format: text("format"), isbn: text("isbn") },
  },
  edition: { parent: "manifestation", leaf: { printRun: integer("print_run") } },
  agent: { columns: { name: requiredText("name") } },
  person: { parent: "agent", leaf: { born: integer("born") } },
  organisation: { parent: "agent", leaf: {} },
});

/**
 * BFO-style branches (gardeneria): `continuant` / `occurrent` roots with marker
 * levels nested two deep before the concrete leaves.
 */
export const bfoTree = defineTree({
  continuant: { columns: { label: requiredText("label") } },
  independent_continuant: { parent: "continuant" },
  material_entity: { parent: "independent_continuant", columns: { mass: integer("mass") } },
  plant: { parent: "material_entity", leaf: { species: text("species") } },
  bed: { parent: "material_entity", leaf: { area: integer("area") } },
  dependent_continuant: { parent: "continuant" },
  document: { parent: "dependent_continuant", leaf: { body: text("body") } },
  occurrent: { columns: { startsAt: text("starts_at") } },
  process: { parent: "occurrent" },
  sowing: { parent: "process", leaf: { depth: integer("depth") } },
  harvest: { parent: "process", leaf: { yieldGrams: integer("yield_grams") } },
});

const Novel = Resource.make("novel", {
  attributes: { wordCount: integer("word_count") },
});
const Story = Resource.make("story", { attributes: { anthology: text("anthology") } });
const Poem = Resource.make("poem", { attributes: { form: text("form") } });
const Author = Resource.make("author", { attributes: { penName: text("pen_name") } });

/**
 * A flat discriminated family (in-the-dark): one `works` marker over several
 * resource leaves, and an `agents` family beside it.
 */
export const flatTree = defineResourceTree({
  works: { columns: { title: requiredText("title") } },
  novel: { parent: "works", leaf: Novel },
  story: { parent: "works", leaf: Story },
  poem: { parent: "works", leaf: Poem },
  agents: {},
  author: { parent: "agents", leaf: Author },
});
