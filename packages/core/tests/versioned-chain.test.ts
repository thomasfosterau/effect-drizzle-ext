/**
 * Canary for the opt-in versioned-chain interpreter: `makeSubtypeTables` emits
 * the stable + version pair with the composite FK chain (and injected
 * discriminator constraints), and `makeCurrentVersionView` builds the
 * fail-closed current-version view.
 *
 * @module tests/versioned-chain
 */

import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  bigint,
  type AnyPgColumn,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type DiscriminatorColumns,
  makeCurrentVersionView,
  makeSubtypeTables,
} from "../src/versioned-chain.ts";

const app = pgSchema("app");

const node = app.table("node", {
  id: uuid("node_id").primaryKey(),
  slug: text("slug"),
  type: text("type").notNull(),
});
const nodeVersion = app.table("node_version", {
  id: uuid("node_id")
    .notNull()
    .references((): AnyPgColumn => node.id),
  version: bigint("version", { mode: "bigint" }).notNull().default(0n),
  action: text("action").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});
const entity = app.table("entity", {
  id: uuid("id")
    .primaryKey()
    .references((): AnyPgColumn => node.id),
  type: text("type"),
});
const entityVersion = app.table("entity_version", {
  id: uuid("id").notNull(),
  version: bigint("version", { mode: "bigint" }).notNull(),
});
/** An optional 6NF fact table: row-absence at a version encodes NULL, so it's LEFT JOINed. */
const factVersion = app.table("fact_version", {
  id: uuid("id").notNull(),
  version: bigint("version", { mode: "bigint" }).notNull(),
  note: text("note"),
});

interface Discriminator {
  parent: DiscriminatorColumns;
  refinable?: boolean;
}

const defineSubtypeTables = makeSubtypeTables<Discriminator>((level, stable, { parent }) => [
  unique(`${level}_id_type_unique`).on(stable.id, stable.type),
  // reference `parent` so the hook is exercised end-to-end
  unique(`${level}_parent_ref`).on(parent.id),
]);

const currentVersionView = makeCurrentVersionView({
  rootVersion: nodeVersion,
  identity: node,
  merge: { slug: node.slug },
});

describe("makeSubtypeTables", () => {
  it("builds the stable + version pair with the composite FK chain", () => {
    const { stable, version } = defineSubtypeTables(app, {
      name: "widget",
      parentId: entity.id,
      parentVersion: entityVersion,
      columns: { label: text("label") },
    });
    const stableCfg = getTableConfig(stable);
    const versionCfg = getTableConfig(version);
    expect(stableCfg.name).toBe("widget");
    expect(versionCfg.name).toBe("widget_version");
    expect(stableCfg.columns.map((c) => c.name).sort()).toEqual(["id", "type"]);
    expect(versionCfg.columns.map((c) => c.name).sort()).toEqual(["id", "label", "version"]);
    // stable `type` is nullable without a discriminator
    expect(stableCfg.columns.find((c) => c.name === "type")?.notNull).toBe(false);
    // primary key + parent-version FK
    expect(versionCfg.primaryKeys[0]?.getName()).toBe("widget_version_pkey");
    expect(
      versionCfg.foreignKeys.some((fk) => fk.getName() === "widget_version_entity_version_fk"),
    ).toBe(true);
    // the stable row's own `id` → parent stable `id` FK — resolving its name
    // forces the lazily-deferred `.references()` callback to run, not just
    // be declared.
    expect(stableCfg.foreignKeys[0]?.getName()).toBe("widget_id_entity_id_fk");
  });

  it("applies the injected discriminator, versionDefault, and constraint-name overrides", () => {
    const { stable, version } = defineSubtypeTables(app, {
      name: "gadget",
      parentId: entity.id,
      parentVersion: entityVersion,
      parentUpdateCascade: true,
      versionDefault: 0n,
      constraintNames: { pk: "gadget_version_pk", parentFk: "gadget_version_parent_fk" },
      columns: { label: text("label") },
      discriminator: { parent: { id: entity.id, type: entity.type }, refinable: true },
      extraConstraints: (t) => [unique("gadget_version_label_unique").on(t.label)],
    });
    const stableCfg = getTableConfig(stable);
    const versionCfg = getTableConfig(version);
    // discriminator makes `type` NOT NULL and appends the injected constraints
    expect(stableCfg.columns.find((c) => c.name === "type")?.notNull).toBe(true);
    expect(stableCfg.uniqueConstraints.some((u) => u.getName() === "gadget_id_type_unique")).toBe(
      true,
    );
    // version default + overridden constraint names + extra constraint
    expect(versionCfg.columns.find((c) => c.name === "version")?.hasDefault).toBe(true);
    expect(versionCfg.primaryKeys[0]?.getName()).toBe("gadget_version_pk");
    expect(versionCfg.foreignKeys.some((fk) => fk.getName() === "gadget_version_parent_fk")).toBe(
      true,
    );
    expect(
      versionCfg.uniqueConstraints.some((u) => u.getName() === "gadget_version_label_unique"),
    ).toBe(true);
  });

  // `SubtypeTables` exists so declaration emit can *name* what this builder
  // returns (website #1579); the hazard is that a future edit keeps it nameable while
  // quietly widening it, which no runtime assertion would catch and which
  // `skipLibCheck: true` would hide in the emitted `.d.ts`. These pin the row
  // types the annotation has to keep producing. They are compile-time
  // assertions — the `expect` is only there to give the block a runtime body.
  it("keeps the annotated return type as precise as the tables it builds", () => {
    const { stable, version } = defineSubtypeTables(app, {
      name: "sprocket",
      parentId: entity.id,
      parentVersion: entityVersion,
      columns: { label: text("label"), size: bigint("size", { mode: "bigint" }).notNull() },
    });

    /** Exact type identity, not mutual assignability. */
    type Eq<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const exact =
      <Expected>() =>
      <Actual>(_: Actual & (Eq<Expected, Actual> extends true ? unknown : never)) => {};

    /*
     * These three assertions restate Drizzle's OWN `$inferSelect` /
     * `$inferInsert` row types, which are what a query actually returns and
     * accepts. `Eq<Expected, Actual>` is exact type identity, so `Option` here
     * would not be a modelling improvement — it would simply stop matching and
     * destroy the website #1579 regression guard these exist to be.
     */
    /* oxlint-disable effect/prefer-option-over-null -- exact-identity assertions against Drizzle's own inferred row types */
    // `id` NOT NULL (never `string | null` — the exact degradation website #1579 found),
    // `type` nullable without a discriminator.
    exact<{ id: string; type: string | null }>()(stable.$inferSelect);
    // Generated key columns keep their nullability, and the caller's own
    // columns keep theirs: `label` nullable, `size` NOT NULL.
    exact<{ id: string; version: bigint; label: string | null; size: bigint }>()(
      version.$inferSelect,
    );
    // `version` has no default here, so it is required on insert.
    // `exactOptionalPropertyTypes` is on, so the optional key's `| undefined`
    // is part of the type and has to be spelled out.
    exact<{ id: string; version: bigint; size: bigint; label?: string | null | undefined }>()(
      version.$inferInsert,
    );
    /* oxlint-enable effect/prefer-option-over-null */

    expect(getTableConfig(version).name).toBe("sprocket_version");
  });
});

describe("makeCurrentVersionView", () => {
  it("builds a current-version view merging the identity slug", () => {
    const { version } = defineSubtypeTables(app, {
      name: "sprocket",
      parentId: entity.id,
      parentVersion: entityVersion,
      columns: { label: text("label") },
    });
    const view = currentVersionView(app, "sprocket_view", {
      leaf: version,
      through: [entityVersion],
      on: [entity],
      columns: { id: version.id, action: nodeVersion.action },
    });
    expect(view).toBeDefined();
    // the view carries a real Drizzle view symbol config
    expect(Object.getOwnPropertySymbols(view).length).toBeGreaterThan(0);
  });

  it("builds a view LEFT JOINing an optional fact table", () => {
    const { version } = defineSubtypeTables(app, {
      name: "sprocket2",
      parentId: entity.id,
      parentVersion: entityVersion,
      columns: { label: text("label") },
    });
    const view = currentVersionView(app, "sprocket2_view", {
      leaf: version,
      through: [entityVersion],
      optional: [factVersion],
      on: [entity],
      columns: { id: version.id, action: nodeVersion.action, note: factVersion.note },
    });
    expect(view).toBeDefined();
    expect(Object.getOwnPropertySymbols(view).length).toBeGreaterThan(0);
  });

  it("builds a view with no through / on joins", () => {
    const { version } = defineSubtypeTables(app, {
      name: "cog",
      parentId: entity.id,
      parentVersion: entityVersion,
      columns: { label: text("label") },
    });
    const view = currentVersionView(app, "cog_view", {
      leaf: version,
      columns: { id: version.id, action: nodeVersion.action, timestamp: nodeVersion.timestamp },
    });
    expect(view).toBeDefined();
  });

  // A function `merge` additionally joins a `version = 0` alias of
  // `rootVersion` and hands it to the callback (website #1223) — a plain-object
  // `merge` (the two tests above) never adds that join, so a view whose
  // definition must stay byte-identical (website #1228) can opt out just by not
  // passing a function.
  it("builds a view merging a version-zero-derived column via a function merge", () => {
    const currentVersionViewWithCreatedAt = makeCurrentVersionView({
      rootVersion: nodeVersion,
      identity: node,
      merge: (versionZero) => ({ slug: node.slug, createdAt: versionZero.timestamp }),
    });
    const { version } = defineSubtypeTables(app, {
      name: "widget2",
      parentId: entity.id,
      parentVersion: entityVersion,
      columns: { label: text("label") },
    });
    const view = currentVersionViewWithCreatedAt(app, "widget2_view", {
      leaf: version,
      through: [entityVersion],
      on: [entity],
      columns: { id: version.id, action: nodeVersion.action },
    });
    expect(view).toBeDefined();
    expect(Object.getOwnPropertySymbols(view).length).toBeGreaterThan(0);
  });
});

// A consumer reading only the emitted `.d.ts` (not this source file) is what
// the `SubtypeTables` / `CurrentVersionViewResult` annotations exist to keep
// precise (website #1579) — `tests/dist-consumer` is the real gate for that,
// but these type-level checks pin the same shape at the source level so a
// regression here shows up before a `dist/` rebuild is even needed.
describe("dist-consumer-style type checks", () => {
  it("types a subtype version table's generated `id` column concretely, never `any`", () => {
    const { version } = defineSubtypeTables(app, {
      name: "widget3",
      parentId: entity.id,
      parentVersion: entityVersion,
      columns: { label: text("label") },
    });
    type Id = (typeof version.$inferSelect)["id"];
    // `[Id] extends [string]` (and the reverse) only both hold for `Id`
    // exactly `string` — an unbound `TTableName` widening `Id` to `any` would
    // still satisfy a plain `extends` check one-directionally, so this pins
    // both directions.
    const _check: [Id] extends [string] ? ([string] extends [Id] ? true : never) : never = true;
    expect(_check).toBe(true);
    expectTypeOf<Id>().toEqualTypeOf<string>();
  });

  it("types a current-version view's explicit column selection concretely, never `any`", () => {
    const { version } = defineSubtypeTables(app, {
      name: "widget4",
      parentId: entity.id,
      parentVersion: entityVersion,
      columns: { label: text("label") },
    });
    const view = currentVersionView(app, "widget4_view", {
      leaf: version,
      through: [entityVersion],
      on: [entity],
      columns: { id: version.id, action: nodeVersion.action },
    });
    type Action = (typeof view.$inferSelect)["action"];
    const _check: [Action] extends [string] ? ([string] extends [Action] ? true : never) : never =
      true;
    expect(_check).toBe(true);
    expectTypeOf<Action>().toEqualTypeOf<string>();
    // the injected `merge` column (`slug`, nullable on `node`) rides along too.
    /* oxlint-disable-next-line effect/prefer-option-over-null -- exact-identity assertion against Drizzle's own inferred row type */
    expectTypeOf<(typeof view.$inferSelect)["slug"]>().toEqualTypeOf<string | null>();
  });
});
