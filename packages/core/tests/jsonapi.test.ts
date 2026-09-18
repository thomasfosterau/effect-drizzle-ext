/**
 * Canary for the JSON:API entries: `resourceColumns` / `resourceColumnBounds`
 * project a `Resource.make` definition's `dbColumn` annotations (seeing through
 * `Resource.attribute` descriptors and the `resource: "optional"` wrapper), the
 * table annotation round-trips on a resource, and `makeDeriveResourceColumns` /
 * `deriveCheckConstraints` produce exactly the DDL the equivalent
 * `Schema.Struct` produces through `./derive`.
 *
 * @module tests/jsonapi
 */

import { describe, expect, it } from "vite-plus/test";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { getTableConfig, integer, PgDialect, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { dbColumn, type DbColumn } from "../src/index.ts";
import {
  DerivationError,
  deriveFieldCheckConstraints,
  makeDeriveColumns,
  type ColumnBuilders,
} from "../src/derive.ts";
import {
  dbTable,
  dbTableFor,
  readDbTable,
  resourceColumnBounds,
  resourceColumns,
  type ResourceColumnsMetaOf,
} from "../src/jsonapi/index.ts";
import { deriveCheckConstraints, makeDeriveResourceColumns } from "../src/jsonapi/derive.ts";

const builders = {
  text: (c: string) => text(c),
  integer: (c: string) => integer(c),
  uuid: (c: string) => uuid(c),
} satisfies ColumnBuilders<"text" | "integer" | "uuid">;

const owner = pgTable("owner", { id: uuid("id").primaryKey() });

const WidgetResource = Resource.make("widgets", {
  attributes: {
    name: dbColumn(Schema.String, { column: "name", pg: "text", notNull: true }),
    size: dbColumn(Schema.Finite, { column: "size", pg: "integer", notNull: false, default: 0 }),
    ownerId: dbColumn(Schema.String, {
      column: "owner_id",
      pg: "uuid",
      notNull: false,
      references: { table: "owner", column: "id", onDelete: "restrict" },
    }),
    // A plain attribute with no `dbColumn` — must be dropped by `resourceColumns`.
    note: Schema.String,
  },
});

describe("resourceColumns", () => {
  it("projects every dbColumn-annotated attribute, dropping plain ones", () => {
    expect(resourceColumns(WidgetResource)).toEqual({
      name: { column: "name", pg: "text", notNull: true },
      size: { column: "size", pg: "integer", notNull: false, default: 0 },
      ownerId: {
        column: "owner_id",
        pg: "uuid",
        notNull: false,
        references: { table: "owner", column: "id", onDelete: "restrict" },
      },
    } satisfies Record<string, DbColumn>);
  });

  it("sees through a Resource.attribute descriptor and its resource: optional wrapper", () => {
    const Descriptored = Resource.make("descriptored", {
      attributes: {
        size: Resource.attribute(
          dbColumn(Schema.NullOr(Schema.Finite), { column: "size", pg: "integer", notNull: false }),
          { resource: "optional", create: false, update: false },
        ),
        slug: Resource.readOnlyAttribute(
          dbColumn(Schema.String, { column: "slug", pg: "text", notNull: true }),
        ),
      },
    });
    expect(resourceColumns(Descriptored)).toEqual({
      size: { column: "size", pg: "integer", notNull: false },
      slug: { column: "slug", pg: "text", notNull: true },
    });
  });

  it("returns an empty map for a resource with no annotated attribute", () => {
    expect(resourceColumns(Resource.make("bares", { attributes: {} }))).toEqual({});
  });
});

describe("resourceColumnBounds", () => {
  const Bounded = Resource.make("bounded", {
    attributes: {
      count: dbColumn(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), {
        column: "count",
        pg: "integer",
        notNull: false,
      }),
      year: dbColumn(Schema.Finite.check(Schema.isBetween({ minimum: -4000, maximum: 2100 })), {
        column: "year",
        pg: "integer",
        notNull: true,
      }),
      // Bounded but not column-backed — must be dropped.
      plain: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
      // Column-backed but unbounded — must be dropped.
      label: dbColumn(Schema.String, { column: "label", pg: "text", notNull: false }),
    },
  });

  it("recovers numeric bounds from checks, through a NullOr union", () => {
    expect(resourceColumnBounds(Bounded)).toEqual({
      count: { column: { column: "count", pg: "integer", notNull: false }, minimum: 0 },
      year: {
        column: { column: "year", pg: "integer", notNull: true },
        minimum: -4000,
        maximum: 2100,
      },
    });
  });

  it("recovers bounds from an attribute-descriptor-wrapped optional schema", () => {
    const Descriptored = Resource.make("descriptored-bounds", {
      attributes: {
        size: Resource.attribute(
          dbColumn(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), {
            column: "size",
            pg: "integer",
            notNull: false,
          }),
          { resource: "optional", create: false, update: false },
        ),
      },
    });
    expect(resourceColumnBounds(Descriptored)).toEqual({
      size: { column: { column: "size", pg: "integer", notNull: false }, minimum: 0 },
    });
  });
});

describe("dbTable on a resource", () => {
  it("round-trips its metadata, preserving resource identity", () => {
    const Gadget = Resource.make("gadgets", { attributes: { name: Schema.String } });
    const annotated = dbTable(Gadget, { name: "gadget", level: "work" });
    // Same object — the annotation attaches in place (Resource.make's assigned
    // properties and referential identity both survive).
    expect(annotated).toBe(Gadget);
    expect(annotated.type).toBe("gadgets");
    expect(readDbTable(annotated)).toEqual(Option.some({ name: "gadget", level: "work" }));
  });

  it("returns none for an un-annotated resource", () => {
    expect(readDbTable(Resource.make("unannotated", { attributes: {} }))).toEqual(Option.none());
  });

  it("dbTableFor pins the level union and annotates identically", () => {
    const pinned = dbTableFor<"work" | "manifestation">();
    const Thing = Resource.make("things", { attributes: {} });
    expect(readDbTable(pinned(Thing, { name: "thing", level: "manifestation" }))).toEqual(
      Option.some({ name: "thing", level: "manifestation" }),
    );
  });
});

describe("makeDeriveResourceColumns", () => {
  it("derives one builder per annotated attribute, applying notNull and default", () => {
    const derive = makeDeriveResourceColumns(builders, {
      resolveReference: () => () => owner.id,
    });
    const columns = getTableConfig(pgTable("widget", derive(WidgetResource) as never)).columns;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(["name", "owner_id", "size"]);
    expect(byName.name.notNull).toBe(true);
    expect(byName.size.hasDefault).toBe(true);
    expect(byName.size.default).toBe(0);
  });

  it("produces the same DDL as fromFields over the equivalent Struct fields", () => {
    const fields = {
      name: dbColumn(Schema.String, { column: "name", pg: "text", notNull: true }),
      size: dbColumn(Schema.Finite, { column: "size", pg: "integer", notNull: false, default: 0 }),
      ownerId: dbColumn(Schema.String, {
        column: "owner_id",
        pg: "uuid",
        notNull: false,
        references: { table: "owner", column: "id", onDelete: "restrict" },
      }),
      note: Schema.String,
    };
    const options = { resolveReference: () => () => owner.id };
    const shape = (columns: Record<string, unknown>) =>
      getTableConfig(pgTable("widget", columns as never)).columns.map((c) => ({
        name: c.name,
        type: c.getSQLType(),
        notNull: c.notNull,
        hasDefault: c.hasDefault,
      }));
    expect(shape(makeDeriveResourceColumns(builders, options)(WidgetResource))).toEqual(
      shape(makeDeriveColumns(builders, options).fromFields(fields)),
    );
  });

  it("throws a DerivationError for a kind the registry has no builder for", () => {
    const Bad = Resource.make("bad", {
      attributes: {
        value: dbColumn(Schema.String, { column: "value", pg: "json", notNull: false }),
      },
    });
    expect(() => makeDeriveResourceColumns(builders)(Bad)).toThrow(DerivationError);
  });

  it("throws a DerivationError when a reference has no resolver", () => {
    expect(() => makeDeriveResourceColumns(builders)(WidgetResource)).toThrow(
      /no resolveReference/,
    );
  });
});

describe("deriveCheckConstraints", () => {
  const BoundedResource = Resource.make("bounded-widgets", {
    attributes: {
      count: dbColumn(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), {
        column: "count",
        pg: "integer",
        notNull: false,
      }),
      year: dbColumn(Schema.Finite.check(Schema.isBetween({ minimum: -4000, maximum: 2100 })), {
        column: "year",
        pg: "integer",
        notNull: true,
      }),
      legacy: dbColumn(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), {
        column: "legacy_column",
        pg: "integer",
        notNull: false,
        checkName: "bounded_widget_version_legacy_non_negative",
      }),
      label: dbColumn(Schema.String, { column: "label", pg: "text", notNull: false }),
    },
  });

  const checksOf = () => {
    const derive = makeDeriveResourceColumns(builders);
    return getTableConfig(
      pgTable(
        "bounded_widget_version",
        derive(BoundedResource) as never,
        deriveCheckConstraints(BoundedResource, "bounded_widget_version") as never,
      ),
    ).checks;
  };

  it("emits one CHECK per bounded column with the canonical name, honouring checkName", () => {
    expect(checksOf().map((c) => c.name)).toEqual([
      "bounded_widget_version_count_non_negative",
      "bounded_widget_version_year_range",
      "bounded_widget_version_legacy_non_negative",
    ]);
  });

  it("guards nullable columns with IS NULL OR and renders the bound expressions", () => {
    const dialect = new PgDialect();
    const rendered = checksOf().map((c) => dialect.sqlToQuery(c.value).sql);
    const t = '"bounded_widget_version"';
    expect(rendered[0]).toBe(`${t}."count" IS NULL OR ${t}."count" >= 0`);
    expect(rendered[1]).toBe(`${t}."year" BETWEEN -4000 AND 2100`);
  });

  it("matches deriveFieldCheckConstraints over the equivalent Struct fields", () => {
    const fields = {
      count: dbColumn(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), {
        column: "count",
        pg: "integer",
        notNull: false,
      }),
      year: dbColumn(Schema.Finite.check(Schema.isBetween({ minimum: -4000, maximum: 2100 })), {
        column: "year",
        pg: "integer",
        notNull: true,
      }),
    };
    const dialect = new PgDialect();
    const fieldChecks = getTableConfig(
      pgTable(
        "bounded_widget_version",
        makeDeriveColumns(builders).fromFields(fields) as never,
        deriveFieldCheckConstraints(fields, "bounded_widget_version") as never,
      ),
    ).checks;
    expect(fieldChecks.map((c) => [c.name, dialect.sqlToQuery(c.value).sql])).toEqual(
      checksOf()
        .slice(0, 2)
        .map((c) => [c.name, dialect.sqlToQuery(c.value).sql]),
    );
  });

  it("throws a DerivationError when a bounded attribute has no column on the table", () => {
    const constraints = deriveCheckConstraints(BoundedResource, "bounded_widget_version");
    expect(() => constraints({})).toThrow(/no column for it/);
    expect(() => constraints({})).toThrow(DerivationError);
  });
});

describe("type-level precision", () => {
  it("recovers each attribute's column phantom through the descriptor (compile-time)", () => {
    const Descriptored = Resource.make("typed", {
      attributes: {
        slug: dbColumn(Schema.String, { column: "slug", pg: "text", notNull: true }),
        size: Resource.attribute(
          dbColumn(Schema.NullOr(Schema.Finite), { column: "size", pg: "integer", notNull: false }),
          { resource: "optional", create: false, update: false },
        ),
        note: Schema.String,
      },
    });
    type Meta = ResourceColumnsMetaOf<typeof Descriptored>;
    const _slug: Meta["slug"]["pg"] = "text";
    const _size: Meta["size"]["pg"] = "integer";
    const _absent: "note" extends keyof Meta ? false : true = true;

    const derived = makeDeriveResourceColumns(builders)(Descriptored);
    const _notNull: (typeof derived)["slug"]["_"]["notNull"] = true;
    expect([_slug, _size, _absent, _notNull]).toEqual(["text", "integer", true, true]);
  });
});
