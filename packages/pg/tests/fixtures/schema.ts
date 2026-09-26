/**
 * The fixture schema the migration tooling is proven against: a small
 * stable + version table pair and one view over them, in its own `fixture`
 * Postgres schema so nothing collides with the `TEMPORARY` tables the other
 * integration specs create.
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

import { eq } from "drizzle-orm";
import { bigint, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
