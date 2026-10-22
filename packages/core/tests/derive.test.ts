/**
 * Canary for the derivation entry: `makeDeriveColumns` builds Drizzle column
 * builders from a `Schema.Struct`'s `dbColumn` annotations, honouring the
 * injected builder registry, notNull / default, the reference-resolver seam,
 * and its failure modes; `deriveCheckConstraintsFrom` /
 * `deriveFieldCheckConstraints` turn numeric bounds into named CHECKs.
 *
 * No database: the builders are materialised into a real `pgTable` and
 * inspected through `getTableConfig` / `PgDialect`.
 *
 * @module tests/derive
 */

import { describe, expect, it } from "vite-plus/test";
import type { ColumnBuilderBase } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  boolean,
  getTableConfig,
  integer,
  PgDialect,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { dbColumn } from "../src/index.ts";
import {
  DerivationError,
  deriveCheckConstraintsFrom,
  deriveFieldCheckConstraints,
  makeDeriveColumns,
  type ColumnBuilders,
} from "../src/derive.ts";

const builders = {
  text: (c: string) => text(c),
  integer: (c: string) => integer(c),
  boolean: (c: string) => boolean(c),
  uuid: (c: string) => uuid(c),
} satisfies ColumnBuilders<"text" | "integer" | "boolean" | "uuid">;

const owner = pgTable("owner", { id: uuid("id").primaryKey() });

const widgetFields = {
  name: dbColumn(Schema.String, { column: "name", pg: "text", notNull: true }),
  size: dbColumn(Schema.Finite, { column: "size", pg: "integer", notNull: false, default: 7 }),
  active: dbColumn(Schema.Boolean, { column: "active", pg: "boolean", notNull: false }),
  note: Schema.String,
};

/** Materialise a set of derived column builders into a real table to inspect the DDL shape. */
const columnsOf = (cols: Readonly<Record<string, ColumnBuilderBase>>) =>
  // SAFETY: every builder in `builders` is a pg-core builder, so each derived
  // `ColumnBuilderBase` is a pg column builder at runtime; the derivation's
  // return type is the dialect-neutral base, which `pgTable` does not accept.
  getTableConfig(pgTable("widget", cols as never)).columns;

describe("makeDeriveColumns.fromFields", () => {
  it("derives one builder per annotated field, dropping plain ones", () => {
    const derived = makeDeriveColumns(builders).fromFields(widgetFields);
    expect(Arr.sort(R.keys(derived), Order.String)).toEqual(["active", "name", "size"]);
  });

  it("applies notNull and default from the annotation", () => {
    const derived = makeDeriveColumns(builders).fromFields(widgetFields);
    const byName = R.fromEntries(columnsOf(derived).map((c) => [c.name, c]));
    expect(byName.name.notNull).toBe(true);
    expect(byName.size.notNull).toBe(false);
    expect(byName.size.hasDefault).toBe(true);
    expect(byName.size.default).toBe(7);
    expect(byName.active.notNull).toBe(false);
  });

  it("peels the optional / NullOr wrappers a field applies", () => {
    const derived = makeDeriveColumns(builders).fromFields({
      label: Schema.optional(
        dbColumn(Schema.NullOr(Schema.String), { column: "label", pg: "text", notNull: false }),
      ),
    });
    expect(columnsOf(derived).map((c) => c.name)).toEqual(["label"]);
  });

  it("resolves a foreign-key reference via the resolveReference hook", () => {
    const fkFields = {
      ownerId: dbColumn(Schema.String, {
        column: "owner_id",
        pg: "uuid",
        notNull: true,
        references: { table: "owner", column: "id", onDelete: "cascade" },
      }),
    };
    const derive = makeDeriveColumns(builders, {
      resolveReference: (ref) => {
        expect(ref).toEqual({ table: "owner", column: "id", onDelete: "cascade" });
        return () => owner.id;
      },
    });
    expect(columnsOf(derive.fromFields(fkFields)).map((c) => c.name)).toContain("owner_id");
    // SAFETY: `uuid` in `builders` is pg-core's, so the derived builder is a pg
    // column builder at runtime behind the dialect-neutral return type.
    const config = getTableConfig(pgTable("gadget", derive.fromFields(fkFields) as never));
    expect(config.foreignKeys.length).toBe(1);
    expect(config.foreignKeys[0].onDelete).toBe("cascade");
  });

  it("throws a DerivationError when a column names a kind the registry has no builder for", () => {
    // 'json' is a valid `pg` string at this layer (see dbColumn's doc) — the
    // registry rejection is a runtime check, not a compile-time one.
    const badFields = {
      value: dbColumn(Schema.String, { column: "value", pg: "json", notNull: false }),
    };
    expect(() => makeDeriveColumns(builders).fromFields(badFields)).toThrow(
      /no builder registered/,
    );
    expect(() => makeDeriveColumns(builders).fromFields(badFields)).toThrow(DerivationError);
  });

  it("throws a DerivationError when a column declares a reference but no resolver is provided", () => {
    const fkFields = {
      ownerId: dbColumn(Schema.String, {
        column: "owner_id",
        pg: "uuid",
        notNull: true,
        references: { table: "owner", column: "id" },
      }),
    };
    expect(() => makeDeriveColumns(builders).fromFields(fkFields)).toThrow(/no resolveReference/);
    expect(() => makeDeriveColumns(builders).fromFields(fkFields)).toThrow(DerivationError);
    expect(() => makeDeriveColumns(builders).fromFields(fkFields)).toThrow(
      expect.objectContaining({ _tag: "DerivationError" }),
    );
  });
});

describe("makeDeriveColumns.fromMeta", () => {
  it("derives from an already-projected metadata map", () => {
    const derived = makeDeriveColumns(builders).fromMeta({
      title: { column: "title", pg: "text", notNull: true },
    });
    const columns = columnsOf(derived);
    expect(columns.map((c) => c.name)).toEqual(["title"]);
    expect(columns[0].notNull).toBe(true);
  });

  it("shares the failure modes with fromFields", () => {
    expect(() =>
      makeDeriveColumns(builders).fromMeta({
        value: { column: "value", pg: "json", notNull: false },
      }),
    ).toThrow(DerivationError);
  });
});

describe("deriveFieldCheckConstraints", () => {
  const boundedFields = {
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
    ceiling: dbColumn(Schema.NullOr(Schema.Finite.check(Schema.isLessThanOrEqualTo(10))), {
      column: "ceiling",
      pg: "integer",
      notNull: false,
    }),
    floor: dbColumn(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)), {
      column: "floor",
      pg: "integer",
      notNull: true,
    }),
    strict: dbColumn(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThan(100)), {
      column: "strict",
      pg: "integer",
      notNull: true,
    }),
    legacy: dbColumn(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), {
      column: "legacy_column",
      pg: "integer",
      notNull: false,
      checkName: "bounded_widget_legacy_non_negative",
    }),
    label: dbColumn(Schema.String, { column: "label", pg: "text", notNull: false }),
  };

  /** Materialise the derived checks by building a real table around them. */
  const checksOf = () => {
    const derive = makeDeriveColumns(builders);
    // SAFETY: the builders are pg-core's and the checks are pg-core `check`s;
    // both derivations return dialect-neutral types `pgTable` does not accept.
    const table = pgTable(
      "bounded_widget",
      derive.fromFields(boundedFields) as never,
      deriveFieldCheckConstraints(boundedFields, "bounded_widget") as never,
    );
    return getTableConfig(table).checks;
  };

  it("emits one CHECK per bounded column with the canonical name, honouring checkName", () => {
    expect(checksOf().map((c) => c.name)).toEqual([
      "bounded_widget_count_non_negative",
      "bounded_widget_year_range",
      "bounded_widget_ceiling_max",
      "bounded_widget_floor_min",
      "bounded_widget_strict_range",
      "bounded_widget_legacy_non_negative",
    ]);
  });

  it("guards nullable columns with IS NULL OR and renders the bound expressions", () => {
    const dialect = new PgDialect();
    const rendered = checksOf().map((c) => dialect.sqlToQuery(c.value).sql);
    const t = '"bounded_widget"';
    expect(rendered[0]).toBe(`${t}."count" IS NULL OR ${t}."count" >= 0`);
    expect(rendered[1]).toBe(`${t}."year" BETWEEN -4000 AND 2100`);
    expect(rendered[2]).toBe(`${t}."ceiling" IS NULL OR ${t}."ceiling" <= 10`);
    expect(rendered[3]).toBe(`${t}."floor" >= 1`);
    expect(rendered[4]).toBe(`${t}."strict" > 0 AND ${t}."strict" < 100`);
  });

  it("inlines the bound numbers rather than binding them as parameters", () => {
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(checksOf()[1].value).params).toEqual([]);
  });

  it("throws a DerivationError when a bounded attribute has no column on the table", () => {
    const constraints = deriveFieldCheckConstraints(boundedFields, "bounded_widget");
    expect(() => constraints({})).toThrow(/no column for it/);
    expect(() => constraints({})).toThrow(DerivationError);
  });
});

describe("deriveCheckConstraintsFrom", () => {
  it("emits nothing for an empty bounds map", () => {
    expect(deriveCheckConstraintsFrom({}, "widget")({})).toEqual([]);
  });

  it("renders an exclusive-minimum-only bound as a bare comparison named min", () => {
    // SAFETY: the derived checks are pg-core `check`s behind a dialect-neutral
    // return type `pgTable`'s extra-config parameter does not accept.
    const table = pgTable(
      "gauge",
      { reading: integer("reading").notNull() },
      deriveCheckConstraintsFrom(
        {
          reading: {
            column: { column: "reading", pg: "integer", notNull: true },
            exclusiveMinimum: 5,
          },
        },
        "gauge",
      ) as never,
    );
    const checks = getTableConfig(table).checks;
    expect(checks.map((c) => c.name)).toEqual(["gauge_reading_min"]);
    expect(new PgDialect().sqlToQuery(checks[0].value).sql).toBe('"gauge"."reading" > 5');
  });
});

describe("type-level precision", () => {
  it("keeps each derived column's builder type (compile-time)", () => {
    const derived = makeDeriveColumns(builders).fromFields(widgetFields);
    // `name` is notNull, so its builder is the `.notNull()` form; `note` is not
    // a column at all and must not appear in the map.
    type Derived = typeof derived;
    const _notNull: Derived["name"]["_"]["notNull"] = true;
    const _nullable: "notNull" extends keyof Derived["size"]["_"] ? false : true = true;
    const _absent: "note" extends keyof Derived ? false : true = true;
    expect([_notNull, _nullable, _absent]).toEqual([true, true, true]);
  });
});
