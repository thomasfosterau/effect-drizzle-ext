/**
 * @copyright Thomas Foster
 *
 * **Typed PostGIS helpers** that sit beside Drizzle's `eq` / `and`: spatial
 * predicates (`ST_Intersects`, `ST_DWithin`, …), measures (`ST_Distance`,
 * `ST_Area`, the `<->` KNN distance), constructors (`ST_Point`,
 * `ST_GeomFromGeoJSON`, …) and outputs (`ST_AsGeoJSON`, `ST_X`, …), each
 * returning a typed Drizzle `SQL` value to drop into `where`, `orderBy` or a
 * select map.
 *
 * ## What the types enforce
 *
 * A spatial operand is a {@link Geometry} or a {@link Geography}, never a bare
 * `SQL`: a column built by {@link geometryColumn} / {@link geographyColumn},
 * a Drizzle `geometry()` point column (geometry), or an expression one of
 * these helpers returns. A binary helper takes two operands of the **same**
 * kind, so `ST_Distance(geometry, geography)` is a type error rather than a
 * silent implicit cast. Functions PostGIS defines for geometry only
 * (`ST_Contains`, `ST_X`, `ST_Transform`, …) accept geometry only; cross
 * with {@link asGeography} / {@link asGeometry}. An expression the helpers
 * don't cover joins in as `sql<Geometry>` / `sql<Geography>` (Drizzle infers
 * that type argument from the parameter, so a bare `sql` template written in
 * the second operand's position is taken at its word).
 *
 * Predicates are `SQL<boolean>`, measures and coordinates `SQL<number>`
 * (PostGIS returns `float8`, which the driver parses), text outputs
 * `SQL<string>`. Numbers are bound as parameters cast to `double precision`
 * (an SRID to `integer`) so Postgres resolves PostGIS's overloads without
 * guessing; a per-row number can be a numeric column or `sql<number>`.
 *
 * ## Units
 *
 * Geography distances, areas and lengths are metres on the spheroid.
 * Geometry ones are in the units of the operand's SRID (degrees for 4326),
 * which is why a radius search over lon/lat data usually wants geography.
 *
 * ## Values
 *
 * A geometry or geography value read from the driver is PostGIS's hex EWKB
 * text, typed {@link Geometry} / {@link Geography}: opaque, writable back
 * unchanged. Read coordinates or GeoJSON with {@link stX} / {@link stAsGeoJSON}
 * in the select map; write with a constructor in the insert values.
 *
 * The extension is the application's to declare, next to its other extras:
 * `extension("postgis")` from `@thomasfosterau/effect-drizzle-ext-pg/tooling`.
 *
 * @module postgis
 */
import { Column, is, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import type { ConvertCustomConfig, PgCustomColumnBuilder } from "drizzle-orm/pg-core";
import type * as Brand from "effect/Brand";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

// ── Values and operands ─────────────────────────────────────────────────

/** A PostGIS `geometry` value as the driver returns it: hex EWKB text, opaque to the application. */
export type Geometry = Brand.Branded<string, "PostGIS/Geometry">;

/** A PostGIS `geography` value as the driver returns it: hex EWKB text, opaque to the application. */
export type Geography = Brand.Branded<string, "PostGIS/Geography">;

/** Either spatial kind. */
export type Spatial = Geometry | Geography;

/** A column of Drizzle's own `geometry()` point type, in either of its modes. */
type DrizzlePointColumn =
  | AnyColumn<{ dataType: "array geometry" }>
  | AnyColumn<{ dataType: "object geometry" }>;

/**
 * A geometry expression: a {@link geometryColumn}, a Drizzle `geometry()`
 * point column, or an `SQL<Geometry>` (a helper's result, or
 * `sql<Geometry>` for an expression the helpers don't cover).
 */
export type GeometryOperand =
  | SQLWrapper<Geometry>
  | AnyColumn<{ data: Geometry }>
  | DrizzlePointColumn;

/** A geography expression: a {@link geographyColumn} or an `SQL<Geography>`. */
export type GeographyOperand = SQLWrapper<Geography> | AnyColumn<{ data: Geography }>;

/** An expression of either kind; a helper over it reads the kind off its first operand. */
export type SpatialOperand = GeometryOperand | GeographyOperand;

/** The kind of a spatial operand: {@link Geometry} or {@link Geography}. */
export type SpatialKindOf<O extends SpatialOperand> = O extends GeometryOperand
  ? Geometry
  : Geography;

/** The operands of the same kind as `O`, which a binary helper's second argument must be. */
export type SameKindOperand<O extends SpatialOperand> = O extends GeometryOperand
  ? GeometryOperand
  : GeographyOperand;

/** A number: a literal bound as a `double precision` parameter, or a numeric column or `sql<number>`. */
export type NumberOperand = number | SQLWrapper<number> | AnyColumn<{ data: number }>;

/** A GeoJSON position: longitude, latitude and an optional altitude (RFC 7946 §3.1.1). */
export type GeoJsonPosition = readonly [number, number] | readonly [number, number, number];

/** A GeoJSON geometry object (RFC 7946 §3.1). */
export type GeoJsonGeometry =
  | { readonly type: "Point"; readonly coordinates: GeoJsonPosition }
  | {
      readonly type: "MultiPoint" | "LineString";
      readonly coordinates: ReadonlyArray<GeoJsonPosition>;
    }
  | {
      readonly type: "MultiLineString" | "Polygon";
      readonly coordinates: ReadonlyArray<ReadonlyArray<GeoJsonPosition>>;
    }
  | {
      readonly type: "MultiPolygon";
      readonly coordinates: ReadonlyArray<ReadonlyArray<ReadonlyArray<GeoJsonPosition>>>;
    }
  | { readonly type: "GeometryCollection"; readonly geometries: ReadonlyArray<GeoJsonGeometry> };

/** A GeoJSON geometry: its JSON text, or the object, which is serialised. */
export type GeoJsonInput = string | GeoJsonGeometry;

/** A column renders as itself; any other expression is parenthesised so an operator or cast binds to all of it. */
const operand = (value: SQLWrapper): SQL | SQLWrapper =>
  is(value, Column) ? value : sql`(${value})`;

const float = (value: NumberOperand): SQL | SQLWrapper =>
  P.isNumber(value) ? sql`${value}::double precision` : operand(value);

const srid = (value: number): SQL => sql`${value}::integer`;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const text = (value: string): SQL => sql`${value}::text`;

// ── Columns ─────────────────────────────────────────────────────────────

/** A PostGIS geometry subtype, with its optional `Z` / `M` / `ZM` dimension suffix. */
export type GeometrySubtype = `${
  | "Geometry"
  | "Point"
  | "LineString"
  | "Polygon"
  | "MultiPoint"
  | "MultiLineString"
  | "MultiPolygon"
  | "GeometryCollection"}${"" | "Z" | "M" | "ZM"}`;

/** The options {@link geometryColumn} and {@link geographyColumn} take. */
export interface SpatialColumnOptions {
  /** The subtype the column is constrained to; any subtype when absent. */
  readonly type?: GeometrySubtype;
  /** The SRID the column is constrained to; unconstrained (geometry) or 4326 (geography) when absent. */
  readonly srid?: number;
}

const typeModifier = (kind: "geometry" | "geography", options?: SpatialColumnOptions): string => {
  const subtype = options?.type;
  const id = options?.srid;
  if (subtype === undefined && id === undefined) return kind;
  return `${kind}(${subtype ?? "Geometry"}${id === undefined ? "" : `,${id}`})`;
};

/**
 * A `geometry` custom column, any subtype and SRID, or the ones `options`
 * names (`geometry(Point,4326)`). Unlike Drizzle's own `geometry()`, which
 * is point-only and decodes to coordinates, its value is the opaque
 * {@link Geometry}; read coordinates with the output helpers.
 *
 * @example
 * ```ts
 * import { pgTable, uuid } from "drizzle-orm/pg-core";
 * import { geometryColumn } from "@thomasfosterau/effect-drizzle-ext/postgis";
 *
 * export const parcel = pgTable("parcel", {
 *   id: uuid("id").primaryKey(),
 *   boundary: geometryColumn("boundary", { type: "MultiPolygon", srid: 4326 }).notNull(),
 * });
 * ```
 */
export const geometryColumn = (
  name: string,
  options?: SpatialColumnOptions,
): PgCustomColumnBuilder<ConvertCustomConfig<{ data: Geometry; driverData: string }>> =>
  customType<{ data: Geometry; driverData: string }>({
    dataType() {
      return typeModifier("geometry", options);
    },
  })(name);

/**
 * A `geography` custom column, any subtype, or the subtype and SRID
 * `options` names (`geography(Point,4326)`). Drizzle ships no geography
 * column; its value is the opaque {@link Geography}.
 *
 * @example
 * ```ts
 * import { pgTable, uuid } from "drizzle-orm/pg-core";
 * import { geographyColumn } from "@thomasfosterau/effect-drizzle-ext/postgis";
 *
 * export const venue = pgTable("venue", {
 *   id: uuid("id").primaryKey(),
 *   location: geographyColumn("location", { type: "Point", srid: 4326 }).notNull(),
 * });
 * ```
 */
export const geographyColumn = (
  name: string,
  options?: SpatialColumnOptions,
): PgCustomColumnBuilder<ConvertCustomConfig<{ data: Geography; driverData: string }>> =>
  customType<{ data: Geography; driverData: string }>({
    dataType() {
      return typeModifier("geography", options);
    },
  })(name);

// ── Constructors ────────────────────────────────────────────────────────

/**
 * `ST_Point(x, y[, srid])`: a point geometry, with the SRID set when given
 * (longitude first for 4326). PostGIS 3.2 or newer for the SRID form.
 *
 * @example
 * ```ts
 * import { stPoint } from "@thomasfosterau/effect-drizzle-ext/postgis";
 *
 * export const sydney = stPoint(151.2093, -33.8688, 4326);
 * ```
 */
export const stPoint = (x: NumberOperand, y: NumberOperand, sridValue?: number): SQL<Geometry> =>
  sridValue === undefined
    ? sql<Geometry>`ST_Point(${float(x)}, ${float(y)})`
    : sql<Geometry>`ST_Point(${float(x)}, ${float(y)}, ${srid(sridValue)})`;

/** `ST_MakeEnvelope(xmin, ymin, xmax, ymax[, srid])`: the rectangular polygon a bounding box is. */
export const stMakeEnvelope = (
  xmin: NumberOperand,
  ymin: NumberOperand,
  xmax: NumberOperand,
  ymax: NumberOperand,
  sridValue?: number,
): SQL<Geometry> =>
  sridValue === undefined
    ? sql<Geometry>`ST_MakeEnvelope(${float(xmin)}, ${float(ymin)}, ${float(xmax)}, ${float(ymax)})`
    : sql<Geometry>`ST_MakeEnvelope(${float(xmin)}, ${float(ymin)}, ${float(xmax)}, ${float(ymax)}, ${srid(sridValue)})`;

/** `ST_GeomFromText(wkt[, srid])`: a geometry from Well-Known Text; a malformed WKT fails the query. */
export const stGeomFromText = (wkt: string, sridValue?: number): SQL<Geometry> =>
  sridValue === undefined
    ? sql<Geometry>`ST_GeomFromText(${text(wkt)})`
    : sql<Geometry>`ST_GeomFromText(${text(wkt)}, ${srid(sridValue)})`;

/** `ST_GeogFromText(wkt)`: a geography from (E)WKT, SRID 4326 unless the EWKT names one. */
export const stGeogFromText = (wkt: string): SQL<Geography> =>
  sql<Geography>`ST_GeogFromText(${text(wkt)})`;

/**
 * `ST_GeomFromGeoJSON(json)`: a geometry from a GeoJSON geometry, its text
 * or the object (serialised here). SRID 4326, GeoJSON's own, is set by
 * PostGIS. Invalid GeoJSON fails the query.
 *
 * @example
 * ```ts
 * import { stGeomFromGeoJSON } from "@thomasfosterau/effect-drizzle-ext/postgis";
 *
 * export const point = stGeomFromGeoJSON({ type: "Point", coordinates: [151.2093, -33.8688] });
 * ```
 */
export const stGeomFromGeoJSON = (json: GeoJsonInput): SQL<Geometry> =>
  sql<Geometry>`ST_GeomFromGeoJSON(${text(P.isString(json) ? json : encodeJsonText(json))})`;

/** `ST_SetSRID(geometry, srid)`: the same coordinates, labelled with another SRID (no reprojection). */
export const stSetSRID = (geometry: GeometryOperand, sridValue: number): SQL<Geometry> =>
  sql<Geometry>`ST_SetSRID(${geometry}, ${srid(sridValue)})`;

/** `ST_Transform(geometry, srid)`: the geometry reprojected into another SRID; fails the query if it has none. */
export const stTransform = (geometry: GeometryOperand, sridValue: number): SQL<Geometry> =>
  sql<Geometry>`ST_Transform(${geometry}, ${srid(sridValue)})`;

/** `geometry::geography`: the geometry as a geography (SRID 4326 when it has none). */
export const asGeography = (geometry: GeometryOperand): SQL<Geography> =>
  sql<Geography>`${operand(geometry)}::geography`;

/** `geography::geometry`: the geography as a geometry, keeping its SRID. */
export const asGeometry = (geography: GeographyOperand): SQL<Geometry> =>
  sql<Geometry>`${operand(geography)}::geometry`;

/** `ST_Buffer(value, radius)`: the area within `radius` (metres for geography, SRID units for geometry). */
export const stBuffer = <O extends SpatialOperand>(
  value: O,
  radius: NumberOperand,
): SQL<SpatialKindOf<O>> => sql<SpatialKindOf<O>>`ST_Buffer(${value}, ${float(radius)})`;

/** `ST_Centroid(value)`: the geometric centre, as a point of the same kind. */
export const stCentroid = <O extends SpatialOperand>(value: O): SQL<SpatialKindOf<O>> =>
  sql<SpatialKindOf<O>>`ST_Centroid(${value})`;

// ── Predicates ──────────────────────────────────────────────────────────

const binaryPredicate =
  (fn: string) =>
  <L extends SpatialOperand>(left: L, right: SameKindOperand<L>): SQL<boolean> =>
    sql<boolean>`${sql.raw(fn)}(${left}, ${right})`;

const geometryPredicate =
  (fn: string) =>
  (left: GeometryOperand, right: GeometryOperand): SQL<boolean> =>
    sql<boolean>`${sql.raw(fn)}(${left}, ${right})`;

/**
 * `ST_Intersects(a, b)`: whether the two share any point. Index-assisted.
 *
 * @example
 * ```ts
 * import { pgTable, uuid } from "drizzle-orm/pg-core";
 * import { geometryColumn, stIntersects, stMakeEnvelope } from "@thomasfosterau/effect-drizzle-ext/postgis";
 *
 * const parcel = pgTable("parcel", { id: uuid("id"), boundary: geometryColumn("boundary") });
 * export const inView = stIntersects(parcel.boundary, stMakeEnvelope(151.1, -33.95, 151.3, -33.8, 4326));
 * ```
 */
export const stIntersects = binaryPredicate("ST_Intersects");

/** `ST_Covers(a, b)`: whether no point of `b` lies outside `a`. Index-assisted. */
export const stCovers = binaryPredicate("ST_Covers");

/** `ST_CoveredBy(a, b)`: whether no point of `a` lies outside `b`. Index-assisted. */
export const stCoveredBy = binaryPredicate("ST_CoveredBy");

/** `ST_Contains(a, b)`: whether `b` lies in `a` and touches its interior (geometry only). Index-assisted. */
export const stContains = geometryPredicate("ST_Contains");

/** `ST_Within(a, b)`: whether `a` lies in `b` and touches its interior (geometry only). Index-assisted. */
export const stWithin = geometryPredicate("ST_Within");

/** `ST_Touches(a, b)`: whether the two meet only at their boundaries (geometry only). */
export const stTouches = geometryPredicate("ST_Touches");

/** `ST_Crosses(a, b)`: whether the two share some but not all interior points (geometry only). */
export const stCrosses = geometryPredicate("ST_Crosses");

/** `ST_Overlaps(a, b)`: whether the two, of the same dimension, partly overlap (geometry only). */
export const stOverlaps = geometryPredicate("ST_Overlaps");

/** `ST_Equals(a, b)`: whether the two are the same set of points, whatever their vertex order (geometry only). */
export const stEquals = geometryPredicate("ST_Equals");

/** `ST_Disjoint(a, b)`: whether the two share no point (geometry only). Never index-assisted; prefer `NOT` {@link stIntersects}. */
export const stDisjoint = geometryPredicate("ST_Disjoint");

/**
 * `ST_DWithin(a, b, distance)`: whether the two are within `distance`
 * (metres for geography, SRID units for geometry). The index-assisted
 * radius search; prefer it to comparing {@link stDistance}.
 *
 * @example
 * ```ts
 * import { pgTable, uuid } from "drizzle-orm/pg-core";
 * import { asGeography, geographyColumn, stDWithin, stPoint } from "@thomasfosterau/effect-drizzle-ext/postgis";
 *
 * const venue = pgTable("venue", { id: uuid("id"), location: geographyColumn("location") });
 * export const nearby = stDWithin(venue.location, asGeography(stPoint(151.2093, -33.8688, 4326)), 5_000);
 * ```
 */
export const stDWithin = <L extends SpatialOperand>(
  left: L,
  right: SameKindOperand<L>,
  distance: NumberOperand,
): SQL<boolean> => sql<boolean>`ST_DWithin(${left}, ${right}, ${float(distance)})`;

/** `a && b`: whether the two bounding boxes intersect. The cheapest index-assisted spatial filter. */
export const bboxIntersects = <L extends SpatialOperand>(
  left: L,
  right: SameKindOperand<L>,
): SQL<boolean> => sql<boolean>`${operand(left)} && ${operand(right)}`;

// ── Measures ────────────────────────────────────────────────────────────

/** `ST_Distance(a, b)`: the minimum distance (metres for geography, SRID units for geometry). */
export const stDistance = <L extends SpatialOperand>(
  left: L,
  right: SameKindOperand<L>,
): SQL<number> => sql<number>`ST_Distance(${left}, ${right})`;

/**
 * `a <-> b`: the KNN distance operator, for `ORDER BY … LIMIT n` nearest
 * neighbour queries an index can drive. Metres for geography; for geometry
 * the distance in SRID units.
 *
 * @example
 * ```ts
 * import { pgTable, uuid } from "drizzle-orm/pg-core";
 * import { asGeography, geographyColumn, knnDistance, stPoint } from "@thomasfosterau/effect-drizzle-ext/postgis";
 *
 * const venue = pgTable("venue", { id: uuid("id"), location: geographyColumn("location") });
 * export const nearestFirst = knnDistance(venue.location, asGeography(stPoint(151.2093, -33.8688, 4326)));
 * ```
 */
export const knnDistance = <L extends SpatialOperand>(
  left: L,
  right: SameKindOperand<L>,
): SQL<number> => sql<number>`${operand(left)} <-> ${operand(right)}`;

/** `ST_Area(value)`: the area (square metres for geography, square SRID units for geometry). */
export const stArea = <O extends SpatialOperand>(value: O): SQL<number> =>
  sql<number>`ST_Area(${value})`;

/** `ST_Length(value)`: the length of a linear value (metres for geography, SRID units for geometry); 0 for an area. */
export const stLength = <O extends SpatialOperand>(value: O): SQL<number> =>
  sql<number>`ST_Length(${value})`;

/** `ST_Perimeter(value)`: the boundary length of an area (metres for geography, SRID units for geometry). */
export const stPerimeter = <O extends SpatialOperand>(value: O): SQL<number> =>
  sql<number>`ST_Perimeter(${value})`;

// ── Outputs ─────────────────────────────────────────────────────────────

/**
 * `ST_AsGeoJSON(value[, maxDecimalDigits])`: the value as GeoJSON geometry
 * text (decode it with a Schema of the shape you expect). PostGIS's default
 * is 9 decimal digits.
 */
export const stAsGeoJSON = <O extends SpatialOperand>(
  value: O,
  maxDecimalDigits?: number,
): SQL<string> =>
  maxDecimalDigits === undefined
    ? sql<string>`ST_AsGeoJSON(${value})`
    : sql<string>`ST_AsGeoJSON(${value}, ${maxDecimalDigits}::integer)`;

/** `ST_AsText(value)`: the value as Well-Known Text. */
export const stAsText = <O extends SpatialOperand>(value: O): SQL<string> =>
  sql<string>`ST_AsText(${value})`;

/** `ST_X(point)`: a point's X coordinate (longitude for 4326); `NULL` for a non-point (geometry only). */
export const stX = (point: GeometryOperand): SQL<number> => sql<number>`ST_X(${point})`;

/** `ST_Y(point)`: a point's Y coordinate (latitude for 4326); `NULL` for a non-point (geometry only). */
export const stY = (point: GeometryOperand): SQL<number> => sql<number>`ST_Y(${point})`;

/** `ST_SRID(geometry)`: the geometry's SRID, 0 when it has none (geometry only). */
export const stSRID = (geometry: GeometryOperand): SQL<number> => sql<number>`ST_SRID(${geometry})`;
