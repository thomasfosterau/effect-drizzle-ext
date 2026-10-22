/**
 * Pins the `?sort=` resolution seam: which fields a view exposes, what SQL
 * each becomes, that an unknown field is refused rather than ignored, and —
 * the property `LIMIT` / `OFFSET` pagination depends on — that every
 * resolved ordering is total (website #972, #1231).
 *
 * Ported from the website application's `apps/api/tests/sort.test.ts`; the
 * fixture is a small version chain built with this library's own
 * `makeCurrentVersionView` in place of the application's schema.
 *
 * **Assertions are on rendered SQL, never on the term objects.** Drizzle
 * returns a fresh alias proxy on every view-column access, so two references
 * to the same column are neither identical nor deep-equal. The statement
 * text is also the thing that actually has to be right.
 *
 * @module packages/core/tests/sort
 */

import { desc, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  jsonb,
  PgDialect,
  pgSchema,
  QueryBuilder,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import {
  chronologicalOrder,
  type OrderTerm,
  type ResolveSortOrderOptions,
  resolveSortOrder,
  type SortKey,
  sortableColumnsFor,
  UnsupportedSortError,
} from "../src/sort.ts";
import { makeCurrentVersionView } from "../src/versioned-chain.ts";
import { runSync } from "./harness.ts";

// ── fixture: a two-level chain and its current-version view ──────────────

const app = pgSchema("app");

const entry = app.table("entry", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull(),
});

const entryVersion = app.table("entry_version", {
  id: uuid("id").notNull(),
  version: bigint("version", { mode: "bigint" }).notNull(),
  action: text("action").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

const postVersion = app.table("post_version", {
  id: uuid("id").notNull(),
  version: bigint("version", { mode: "bigint" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  draft: boolean("draft").notNull(),
  content: jsonb("content"),
  embedding: vector("embedding", { dimensions: 3 }),
});

const currentVersionView = makeCurrentVersionView({
  rootVersion: entryVersion,
  identity: entry,
  merge: (versionZero) => ({
    slug: entry.slug,
    createdAt: sql<Date>`${versionZero.timestamp}`.as("created_at"),
  }),
});

const postView = currentVersionView(app, "post_view", {
  leaf: postVersion,
  columns: {
    id: postVersion.id,
    name: postVersion.name,
    description: postVersion.description,
    publishedAt: postVersion.publishedAt,
    draft: postVersion.draft,
    content: postVersion.content,
    embedding: postVersion.embedding,
    action: entryVersion.action,
    timestamp: entryVersion.timestamp,
  },
});

/** A view with no `createdAt` merge, for the "one derivation per view" case. */
const plainView = makeCurrentVersionView({
  rootVersion: entryVersion,
  identity: entry,
  merge: { slug: entry.slug },
})(app, "plain_view", {
  leaf: postVersion,
  columns: { id: postVersion.id, draft: postVersion.draft, timestamp: entryVersion.timestamp },
});

// ── rendering helpers ────────────────────────────────────────────────────

/** A driverless query builder and dialect: nothing executes, statements only render. */
const db = new QueryBuilder();
const dialect = new PgDialect();

/** The `order by …` clause a resolved ordering produces on a real list query. */
const orderClause = (order: ReadonlyArray<OrderTerm>): string => {
  const query = db
    .select({ id: postView.id })
    .from(postView)
    .orderBy(...order)
    .limit(10)
    .offset(0);
  const text = dialect.sqlToQuery(query.getSQL()).sql;
  return text.slice(text.indexOf("order by"), text.indexOf(" limit"));
};

/** Resolve then render, the way a list operation does. */
const orderByFor = (options: Omit<ResolveSortOrderOptions, "view">): string =>
  orderClause(runSync(resolveSortOrder({ view: postView, ...options })));

/** Resolve and return the failure, if any. */
const failureOf = (options: Omit<ResolveSortOrderOptions, "view">): UnsupportedSortError =>
  // `flip` turns an unexpected success into the failure `runSync` throws.
  runSync(Effect.flip(resolveSortOrder({ view: postView, ...options })));

const keys = (...fields: string[]): ReadonlyArray<SortKey> =>
  fields.map((field) =>
    field.startsWith("-")
      ? { field: field.slice(1), direction: "desc" as const }
      : { field, direction: "asc" as const },
  );

// ── sortableColumnsFor ───────────────────────────────────────────────────

describe("sortableColumnsFor", () => {
  const sortable = sortableColumnsFor(postView);

  it("publishes the view's own scalar columns under their keys", () => {
    expect(R.keys(sortable)).toEqual(
      expect.arrayContaining(["id", "name", "description", "publishedAt", "draft", "slug"]),
    );
  });

  it("publishes `createdAt` and `updatedAt`", () => {
    // `createdAt` is the view's `SQL.Aliased` birth-row timestamp; `updatedAt`
    // is the current version's `timestamp` under its resource-facing name.
    expect(R.keys(sortable)).toEqual(expect.arrayContaining(["createdAt", "updatedAt"]));
  });

  it("withholds the version-chain internals", () => {
    expect(sortable).not.toHaveProperty("action");
    expect(sortable).not.toHaveProperty("timestamp");
  });

  it("withholds columns with no useful scalar order", () => {
    expect(sortable).not.toHaveProperty("content");
    expect(sortable).not.toHaveProperty("embedding");
  });

  it("derives the same set for a view it has already seen", () => {
    // Memoised per view: a module-scope value walked once, not per request.
    expect(sortableColumnsFor(postView)).toBe(sortable);
  });

  it("derives exactly the scalar set of a view without an aliased merge", () => {
    expect(R.keys(sortableColumnsFor(plainView)).toSorted()).toEqual([
      "draft",
      "id",
      "slug",
      "updatedAt",
    ]);
  });

  it("takes the version-chain names as options", () => {
    const custom = sortableColumnsFor(postView, {
      internal: ["draft"],
      aliased: [],
      renamed: { modifiedAt: "timestamp" },
    });
    expect(custom).not.toHaveProperty("draft");
    expect(custom).not.toHaveProperty("createdAt");
    expect(custom).not.toHaveProperty("updatedAt");
    expect(custom).toHaveProperty("modifiedAt");
    // Not in the custom `internal` list, and a timestamp: sortable as itself.
    expect(custom).toHaveProperty("timestamp");
    // No longer internal either, and a text column: sortable as itself.
    expect(custom).toHaveProperty("action");
  });
});

// ── resolveSortOrder without a client sort ───────────────────────────────

describe("resolveSortOrder without a client sort", () => {
  it("keeps the resource's own order and closes it with the `id` tiebreak", () => {
    expect(orderByFor({ sort: undefined, fallback: [postView.publishedAt] })).toBe(
      `order by "post_view"."published_at", "post_view"."id"`,
    );
  });

  it("does not double the tiebreak when the fallback already ends in `id`", () => {
    // Drizzle hands back a fresh proxy per column access, so this is matched
    // by column name — an identity check would silently never fire.
    expect(orderByFor({ sort: undefined, fallback: [postView.publishedAt, postView.id] })).toBe(
      `order by "post_view"."published_at", "post_view"."id"`,
    );
  });

  it("mirrors the tiebreak direction for a newest-first fallback", () => {
    expect(
      orderByFor({ sort: undefined, fallback: [desc(postView.timestamp)], tiebreak: "desc" }),
    ).toBe(`order by "post_view"."timestamp" desc, "post_view"."id" desc`);
  });

  it("treats an empty sort list as no sort at all", () => {
    expect(orderByFor({ sort: [], fallback: [] })).toBe(`order by "post_view"."id"`);
  });
});

// ── resolveSortOrder with a client sort ──────────────────────────────────

describe("resolveSortOrder with a client sort", () => {
  it("replaces the resource's order and appends a mirrored `id` tiebreak", () => {
    expect(
      orderByFor({
        sort: keys("-publishedAt"),
        fallback: [desc(postView.timestamp)],
        tiebreak: "desc",
      }),
    ).toBe(`order by "post_view"."published_at" desc, "post_view"."id" desc`);
  });

  it("preserves key order and per-key direction across several keys", () => {
    expect(orderByFor({ sort: keys("-publishedAt", "name"), fallback: [] })).toBe(
      `order by "post_view"."published_at" desc, "post_view"."name" asc, "post_view"."id" asc`,
    );
  });

  it("resolves `updatedAt` onto the current version's timestamp", () => {
    expect(orderByFor({ sort: keys("-updatedAt") })).toBe(
      `order by "post_view"."timestamp" desc, "post_view"."id" desc`,
    );
  });

  it("renders the aliased `createdAt` against the view, not its inner expression", () => {
    // The ordering must name the view's own output column, or the statement
    // would reference a table alias that doesn't exist in this query.
    expect(orderByFor({ sort: keys("createdAt") })).toBe(
      `order by "post_view"."created_at" asc, "post_view"."id" asc`,
    );
  });

  it("does not append a second `id` term when the caller sorted by `id`", () => {
    expect(orderByFor({ sort: keys("-id") })).toBe(`order by "post_view"."id" desc`);
  });

  it("honours an explicit `sortable` override instead of the derived set", () => {
    expect(orderByFor({ sort: keys("headline"), sortable: { headline: postView.name } })).toBe(
      `order by "post_view"."name" asc, "post_view"."id" asc`,
    );
  });

  it("keeps the page window bounded — sorting never removes the LIMIT", () => {
    const order = runSync(resolveSortOrder({ view: postView, sort: keys("-publishedAt") }));
    const query = db
      .select({ id: postView.id })
      .from(postView)
      .orderBy(...order)
      .limit(10)
      .offset(0);
    expect(dialect.sqlToQuery(query.getSQL()).sql).toContain("limit");
  });
});

// ── resolveSortOrder rejects what a resource does not expose ─────────────

describe("resolveSortOrder rejects what a resource does not expose", () => {
  it("refuses an unknown field", () => {
    expect(failureOf({ sort: keys("nonesuch") })).toBeInstanceOf(UnsupportedSortError);
  });

  it("refuses a version-chain internal", () => {
    expect(failureOf({ sort: keys("action") }).message).toMatch(/unsupported\.sort-field/);
  });

  it("refuses a column that has no useful order", () => {
    expect(failureOf({ sort: keys("content") }).message).toMatch(/unsupported\.sort-field/);
  });

  it("names the offending field and the fields it could have asked for", () => {
    const error = failureOf({ sort: keys("nonesuch") });
    expect(error._tag).toBe("UnsupportedSortError");
    expect(error.field).toBe("nonesuch");
    expect(error.code).toBe("unsupported.sort-field");
    expect(error.allowed).toContain("createdAt");
    expect(error.allowed).toEqual(error.allowed.toSorted());
    expect(error.message).toContain("nonesuch");
  });

  it("rejects the whole request when only one key is bad, never half-applying it", () => {
    expect(failureOf({ sort: keys("-publishedAt", "nonesuch") }).field).toBe("nonesuch");
  });

  it("refuses every field for a resource that declares an empty sortable set", () => {
    const error = failureOf({ sort: keys("name"), sortable: {} });
    expect(error.allowed).toEqual([]);
    expect(error.message).toContain("(none)");
  });

  it("is not fooled by an inherited object property", () => {
    // `constructor` / `toString` are on every object's prototype; the
    // allow-list check is an own-property test, so they are not sort fields.
    expect(failureOf({ sort: keys("constructor") }).field).toBe("constructor");
  });
});

// ── chronologicalOrder ───────────────────────────────────────────────────

describe("chronologicalOrder", () => {
  const render = (options: Omit<Parameters<typeof chronologicalOrder>[0], "view">): string =>
    orderClause(runSync(chronologicalOrder({ view: postView, ...options })));

  it("defaults to newest first with a mirrored tiebreak", () => {
    expect(render({})).toBe(`order by "post_view"."timestamp" desc, "post_view"."id" desc`);
  });

  it("takes an oldest-first direction", () => {
    expect(render({ direction: "asc" })).toBe(
      `order by "post_view"."timestamp" asc, "post_view"."id" asc`,
    );
  });

  it("yields to a client sort", () => {
    expect(render({ sort: keys("name") })).toBe(
      `order by "post_view"."name" asc, "post_view"."id" asc`,
    );
  });
});
