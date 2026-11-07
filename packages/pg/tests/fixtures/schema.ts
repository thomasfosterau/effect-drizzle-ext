/**
 * The fixture schema the migration tooling is proven against: a small
 * stable + version table pair and one view over them, in its own `fixture`
 * Postgres schema so nothing collides with the `TEMPORARY` tables the other
 * integration specs create; and an ontology tree's derived tables
 * (`makeTreeTables`) and read views (`makeTreeViews`) in an `ontology`
 * schema, which the tree integration specs exercise.
 *
 * `migrations/` beside this file is drizzle-kit's output for it, generated
 * with `drizzle.config.ts` (`vp exec drizzle-kit generate --config
 * tests/fixtures/drizzle.config.ts --name <slug>` from `packages/pg`) and
 * never hand-edited: the integration suite's global setup provisions its
 * database by applying it through `provisionTestDatabase`, and the
 * `./tooling` guards assert zero drift and no view-on-view edge against it.
 *
 * @module packages/pg/tests/fixtures/schema
 */

import { dbColumn, defineTree } from "@thomasfosterau/effect-drizzle-ext";
import type { ColumnBuilders } from "@thomasfosterau/effect-drizzle-ext/derive";
import { makeTreeTables, makeTreeViews } from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { eq } from "drizzle-orm";
import { bigint, integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import * as Schema from "effect/Schema";

export const fixture = pgSchema("fixture");

export const widget = fixture.table("widget", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

export const widgetVersion = fixture.table("widget_version", {
  id: uuid("id")
    .notNull()
    .references(() => widget.id),
  version: bigint("version", { mode: "bigint" }).notNull(),
  name: text("name").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export const widgetView = fixture.view("widget_view").as((qb) =>
  qb
    .select({
      id: widget.id,
      slug: widget.slug,
      name: widgetVersion.name,
      timestamp: widgetVersion.timestamp,
    })
    .from(widget)
    .innerJoin(widgetVersion, eq(widget.id, widgetVersion.id)),
);

// ── An ontology tree (effect-drizzle-ext#112) ─────────────────────────

const ontologyBuilders = {
  text: (column: string) => text(column),
  integer: (column: string) => integer(column),
} satisfies ColumnBuilders<"text" | "integer">;

/**
 * A small tree with the shapes the version-chain slices need: a work spine
 * whose level column reaches two leaves, a fact-scoped level, and a
 * refinable agent branch.
 */
export const ontologyTree = defineTree({
  work: {
    columns: { title: dbColumn(Schema.String, { column: "title", pg: "text", notNull: true }) },
  },
  book: {
    parent: "work",
    leaf: { pages: dbColumn(Schema.Finite, { column: "pages", pg: "integer", notNull: false }) },
  },
  essay: { parent: "work", leaf: {} },
  manifestation: {
    kind: "fact-scoped",
    columns: { isbn: dbColumn(Schema.String, { column: "isbn", pg: "text", notNull: false }) },
  },
  edition: { parent: "manifestation", leaf: {} },
  agent: {},
  person: { parent: "agent", leaf: {} },
  organisation: { parent: "agent", leaf: {} },
});

/** The tree's own Postgres schema, exported so drizzle-kit creates it. */
export const ontology = pgSchema("ontology");

/** Every table the tree derives, in the `ontology` schema. */
export const ontologyTables = makeTreeTables(ontologyTree, {
  schema: ontology,
  builders: ontologyBuilders,
  levels: { agent: { refinable: true } },
});

export const node = ontologyTables.root.identity;
export const nodeVersion = ontologyTables.root.version;
export const work = ontologyTables.levels.work.stable;
export const workVersion = ontologyTables.levels.work.version;
export const book = ontologyTables.levels.book.stable;
export const bookVersion = ontologyTables.levels.book.version;
export const essay = ontologyTables.levels.essay.stable;
export const essayVersion = ontologyTables.levels.essay.version;
export const manifestation = ontologyTables.levels.manifestation.stable;
export const manifestationVersion = ontologyTables.levels.manifestation.version;
export const manifestationIsbn = ontologyTables.facts.manifestation.isbn;
export const edition = ontologyTables.levels.edition.stable;
export const editionVersion = ontologyTables.levels.edition.version;
export const agent = ontologyTables.levels.agent.stable;
export const agentVersion = ontologyTables.levels.agent.version;
export const person = ontologyTables.levels.person.stable;
export const personVersion = ontologyTables.levels.person.version;
export const organisation = ontologyTables.levels.organisation.stable;
export const organisationVersion = ontologyTables.levels.organisation.version;

/** Every view the tree derives: a view per leaf, and the `work` branch. */
export const ontologyViews = makeTreeViews(ontologyTree, ontologyTables, {
  schema: ontology,
  branches: { work: true },
});

export const bookView = ontologyViews.leaves.book;
export const essayView = ontologyViews.leaves.essay;
export const editionView = ontologyViews.leaves.edition;
export const personView = ontologyViews.leaves.person;
export const organisationView = ontologyViews.leaves.organisation;
export const workView = ontologyViews.branches.work;
