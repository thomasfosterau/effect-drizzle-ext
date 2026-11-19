/**
 * Unit tests for `./postgis` — the typed spatial helpers. No database: SQL
 * is rendered through `PgDialect` and its text and parameters inspected, and
 * the kind rules (no geometry/geography mix, geometry-only functions) are
 * pinned on the operand types.
 *
 * @module tests/PostGis
 */

import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { and, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  doublePrecision,
  geometry,
  getTableConfig,
  PgDialect,
  pgTable,
  uuid,
} from "drizzle-orm/pg-core";
import {
  asGeography,
  asGeometry,
  bboxIntersects,
  geographyColumn,
  geometryColumn,
  knnDistance,
  stArea,
  stAsGeoJSON,
  stAsText,
  stBuffer,
  stCentroid,
  stContains,
  stCoveredBy,
  stCovers,
  stCrosses,
  stDisjoint,
  stDistance,
  stDWithin,
  stEquals,
  stGeogFromText,
  stGeomFromGeoJSON,
  stGeomFromText,
  stIntersects,
  stLength,
  stMakeEnvelope,
  stOverlaps,
  stPerimeter,
  stPoint,
  stSetSRID,
  stSRID,
  stTouches,
  stTransform,
  stWithin,
  stX,
  stY,
  type GeographyOperand,
  type Geography,
  type GeometryOperand,
  type Geometry,
  type SameKindOperand,
  type SpatialKindOf,
  type SpatialOperand,
} from "../src/PostGis.ts";
import * as Arr from "effect/Array";
import * as R from "effect/Record";

const dialect = new PgDialect();
const render = (value: SQLWrapper) => dialect.sqlToQuery(value.getSQL());

const place = pgTable("place", {
  id: uuid("id").primaryKey(),
  area: geometryColumn("area", { type: "MultiPolygon", srid: 4326 }).notNull(),
  outline: geometryColumn("outline"),
  location: geographyColumn("location", { type: "Point", srid: 4326 }).notNull(),
  anywhere: geographyColumn("anywhere"),
  pin: geometry("pin", { srid: 4326 }),
  pinXy: geometry("pin_xy", { mode: "xy", srid: 4326 }),
  radius: doublePrecision("radius").notNull(),
});

describe("columns", () => {
  it("emit the typmod each option set names", () => {
    const types = R.fromEntries(
      Arr.map(getTableConfig(place).columns, (column) => [column.name, column.getSQLType()]),
    );
    expect(types).toMatchObject({
      area: "geometry(MultiPolygon,4326)",
      outline: "geometry",
      location: "geography(Point,4326)",
      anywhere: "geography",
    });
    const more = pgTable("more", {
      projected: geometryColumn("projected", { srid: 3857 }),
      track: geographyColumn("track", { type: "LineStringZ" }),
    });
    expect(Arr.map(getTableConfig(more).columns, (column) => column.getSQLType())).toEqual([
      "geometry(Geometry,3857)",
      "geography(LineStringZ)",
    ]);
  });

  it("type their values as the opaque spatial brands", () => {
    type Row = typeof place.$inferSelect;
    expectTypeOf<Row["area"]>().toEqualTypeOf<Geometry>();
    expectTypeOf<NonNullable<Row["outline"]>>().toEqualTypeOf<Geometry>();
    expectTypeOf<Row["location"]>().toEqualTypeOf<Geography>();
  });
});

describe("constructors", () => {
  it("bind numbers as double precision and an SRID as integer", () => {
    expect(render(stPoint(151.2, -33.8))).toEqual({
      sql: "ST_Point($1::double precision, $2::double precision)",
      params: [151.2, -33.8],
    });
    expect(render(stPoint(151.2, -33.8, 4326))).toEqual({
      sql: "ST_Point($1::double precision, $2::double precision, $3::integer)",
      params: [151.2, -33.8, 4326],
    });
    expect(render(stMakeEnvelope(0, 1, 2, 3, 4326)).sql).toBe(
      "ST_MakeEnvelope($1::double precision, $2::double precision, $3::double precision, $4::double precision, $5::integer)",
    );
    expect(render(stMakeEnvelope(0, 1, 2, 3)).params).toEqual([0, 1, 2, 3]);
  });

  it("bind text inputs as text, serialising a GeoJSON object", () => {
    expect(render(stGeomFromText("POINT(1 2)"))).toEqual({
      sql: "ST_GeomFromText($1::text)",
      params: ["POINT(1 2)"],
    });
    expect(render(stGeomFromText("POINT(1 2)", 4326)).sql).toBe(
      "ST_GeomFromText($1::text, $2::integer)",
    );
    expect(render(stGeogFromText("POINT(1 2)")).sql).toBe("ST_GeogFromText($1::text)");
    expect(render(stGeomFromGeoJSON({ type: "Point", coordinates: [1, 2] }))).toEqual({
      sql: "ST_GeomFromGeoJSON($1::text)",
      params: ['{"type":"Point","coordinates":[1,2]}'],
    });
    expect(render(stGeomFromGeoJSON('{"type":"Point","coordinates":[1,2]}')).params).toEqual([
      '{"type":"Point","coordinates":[1,2]}',
    ]);
  });

  it("take a per-row number from a numeric column", () => {
    expect(render(stBuffer(place.location, place.radius)).sql).toBe(
      'ST_Buffer("place"."location", "place"."radius")',
    );
  });

  it("reproject, relabel and cross between the kinds", () => {
    expect(render(stSetSRID(place.outline, 4326)).sql).toBe(
      'ST_SetSRID("place"."outline", $1::integer)',
    );
    expect(render(stTransform(place.area, 3857)).sql).toBe(
      'ST_Transform("place"."area", $1::integer)',
    );
    expect(render(asGeography(place.area)).sql).toBe('"place"."area"::geography');
    expect(render(asGeography(stPoint(1, 2))).sql).toBe(
      "(ST_Point($1::double precision, $2::double precision))::geography",
    );
    expect(render(asGeometry(place.location)).sql).toBe('"place"."location"::geometry');
    expect(render(stCentroid(place.area)).sql).toBe('ST_Centroid("place"."area")');
  });
});

describe("predicates", () => {
  it("render each function over its two operands", () => {
    const cases: ReadonlyArray<readonly [SQL<boolean>, string]> = [
      [stIntersects(place.area, place.outline), "ST_Intersects"],
      [stCovers(place.location, place.anywhere), "ST_Covers"],
      [stCoveredBy(place.area, place.outline), "ST_CoveredBy"],
      [stContains(place.area, place.pin), "ST_Contains"],
      [stWithin(place.pinXy, place.area), "ST_Within"],
      [stTouches(place.area, place.outline), "ST_Touches"],
      [stCrosses(place.area, place.outline), "ST_Crosses"],
      [stOverlaps(place.area, place.outline), "ST_Overlaps"],
      [stEquals(place.area, place.outline), "ST_Equals"],
      [stDisjoint(place.area, place.outline), "ST_Disjoint"],
    ];
    expect(Arr.map(cases, ([expression]) => render(expression).sql.split("(")[0])).toEqual(
      Arr.map(cases, ([, fn]) => fn),
    );
    expect(render(stContains(place.area, place.pin)).sql).toBe(
      'ST_Contains("place"."area", "place"."pin")',
    );
  });

  it("bind a radius, and compose with Drizzle's own operators", () => {
    const where = and(
      stDWithin(place.location, asGeography(stPoint(151.2, -33.8, 4326)), 5000),
      bboxIntersects(place.area, stMakeEnvelope(0, 0, 1, 1, 4326)),
    );
    expect(where === undefined ? undefined : render(where)).toEqual({
      sql:
        '((ST_DWithin("place"."location", (ST_Point($1::double precision, $2::double precision, $3::integer))::geography, $4::double precision))' +
        ' and ("place"."area" && (ST_MakeEnvelope($5::double precision, $6::double precision, $7::double precision, $8::double precision, $9::integer))))',
      params: [151.2, -33.8, 4326, 5000, 0, 0, 1, 1, 4326],
    });
  });

  it("are typed boolean", () => {
    expectTypeOf(stIntersects(place.area, place.outline)).toEqualTypeOf<SQL<boolean>>();
    expectTypeOf(stDWithin(place.location, place.anywhere, place.radius)).toEqualTypeOf<
      SQL<boolean>
    >();
  });
});

describe("measures and outputs", () => {
  it("render", () => {
    expect(render(stDistance(place.location, place.anywhere)).sql).toBe(
      'ST_Distance("place"."location", "place"."anywhere")',
    );
    expect(render(knnDistance(place.pin, stPoint(1, 2, 4326))).sql).toBe(
      '"place"."pin" <-> (ST_Point($1::double precision, $2::double precision, $3::integer))',
    );
    expect(render(stArea(place.area)).sql).toBe('ST_Area("place"."area")');
    expect(render(stLength(place.anywhere)).sql).toBe('ST_Length("place"."anywhere")');
    expect(render(stPerimeter(place.area)).sql).toBe('ST_Perimeter("place"."area")');
    expect(render(stAsGeoJSON(place.location)).sql).toBe('ST_AsGeoJSON("place"."location")');
    expect(render(stAsGeoJSON(place.area, 6))).toEqual({
      sql: 'ST_AsGeoJSON("place"."area", $1::integer)',
      params: [6],
    });
    expect(render(stAsText(place.area)).sql).toBe('ST_AsText("place"."area")');
    expect(render(stX(place.pin)).sql).toBe('ST_X("place"."pin")');
    expect(render(stY(place.pin)).sql).toBe('ST_Y("place"."pin")');
    expect(render(stSRID(place.outline)).sql).toBe('ST_SRID("place"."outline")');
  });

  it("are typed by what PostGIS returns", () => {
    expectTypeOf(stDistance(place.area, place.outline)).toEqualTypeOf<SQL<number>>();
    expectTypeOf(stAsGeoJSON(place.location)).toEqualTypeOf<SQL<string>>();
    expectTypeOf(stBuffer(place.location, 10)).toEqualTypeOf<SQL<Geography>>();
    expectTypeOf(stCentroid(place.area)).toEqualTypeOf<SQL<Geometry>>();
  });
});

describe("kind rules", () => {
  it("class each column and helper result by kind", () => {
    expectTypeOf<SpatialKindOf<typeof place.area>>().toEqualTypeOf<Geometry>();
    expectTypeOf<SpatialKindOf<typeof place.pin>>().toEqualTypeOf<Geometry>();
    expectTypeOf<SpatialKindOf<typeof place.pinXy>>().toEqualTypeOf<Geometry>();
    expectTypeOf<SpatialKindOf<typeof place.location>>().toEqualTypeOf<Geography>();
    expectTypeOf<SpatialKindOf<ReturnType<typeof stPoint>>>().toEqualTypeOf<Geometry>();
    expectTypeOf<SpatialKindOf<ReturnType<typeof asGeography>>>().toEqualTypeOf<Geography>();
  });

  it("never mix geometry and geography in one call", () => {
    // A binary helper's second operand is `SameKindOperand` of its first.
    expectTypeOf<SameKindOperand<typeof place.area>>().toEqualTypeOf<GeometryOperand>();
    expectTypeOf<SameKindOperand<typeof place.location>>().toEqualTypeOf<GeographyOperand>();
    expectTypeOf<typeof place.location>().not.toExtend<GeometryOperand>();
    expectTypeOf<ReturnType<typeof stPoint>>().not.toExtend<GeographyOperand>();
    expectTypeOf<typeof place.area>().not.toExtend<GeographyOperand>();
    // So a geometry-only helper (ST_Contains, ST_X, …) refuses a geography.
    expectTypeOf<Parameters<typeof stX>[0]>().toEqualTypeOf<GeometryOperand>();
    expectTypeOf<Parameters<typeof stContains>>().toEqualTypeOf<
      [left: GeometryOperand, right: GeometryOperand]
    >();
  });

  it("refuse an untyped expression or a non-spatial column", () => {
    expectTypeOf<SQL>().not.toExtend<SpatialOperand>();
    expectTypeOf<typeof place.radius>().not.toExtend<SpatialOperand>();
    // A typed `sql` is the escape hatch for an expression the helpers don't cover.
    expect(render(stArea(sql<Geometry>`ST_Collect(${place.area})`)).sql).toBe(
      'ST_Area(ST_Collect("place"."area"))',
    );
  });
});
