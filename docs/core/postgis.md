# `./postgis`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

Typed [PostGIS](https://postgis.net) helpers that sit beside Drizzle's `eq` and `and`. Each one returns a typed Drizzle `SQL` value for a `where`, an `orderBy`, a select map or an insert's values.

## What Drizzle already ships, and what this adds

Drizzle's `geometry()` column (`drizzle-orm/pg-core`) is point-only and decodes to `[x, y]` or `{ x, y }`. It has no geography column and no spatial functions. This entry adds:

- `geometryColumn(name, { type?, srid? })` and `geographyColumn(name, { type?, srid? })`: custom columns for any subtype (`geometry(MultiPolygon,4326)`, `geography(Point,4326)`, `LineStringZ`, …). Their value is PostGIS's hex EWKB text, branded `Geometry` / `Geography`: opaque, and writable back unchanged.
- Predicates (`SQL<boolean>`): `stIntersects`, `stCovers`, `stCoveredBy`, `stDWithin` and `bboxIntersects` (`&&`) for either kind; `stContains`, `stWithin`, `stTouches`, `stCrosses`, `stOverlaps`, `stEquals` and `stDisjoint` for geometry.
- Measures (`SQL<number>`): `stDistance`, `knnDistance` (`<->`, for nearest-neighbour `ORDER BY … LIMIT`), `stArea`, `stLength`, `stPerimeter`.
- Constructors: `stPoint`, `stMakeEnvelope`, `stGeomFromText`, `stGeogFromText`, `stGeomFromGeoJSON` (text or a typed GeoJSON geometry object), `stSetSRID`, `stTransform`, `stBuffer`, `stCentroid`, and the casts `asGeography` / `asGeometry`.
- Outputs: `stAsGeoJSON` and `stAsText` (`SQL<string>`); `stX`, `stY` and `stSRID` (`SQL<number>`).

A Drizzle `geometry()` point column is accepted wherever a geometry is.

## The kind rule

Every spatial operand is a geometry or a geography: a column of that kind, or an `SQL<Geometry>` / `SQL<Geography>`. A plain `SQL` or a non-spatial column is a type error. A binary helper takes two operands of the **same** kind (its second parameter is `SameKindOperand` of its first), so `stDistance(geometry, geography)` fails to compile instead of casting implicitly. Functions PostGIS defines for geometry only accept geometry only. Cross with `asGeography` / `asGeometry`, and bring in an expression the helpers don't cover as `sql<Geometry>` / `sql<Geography>`.

Numbers are bound as parameters cast to `double precision` (an SRID to `integer`, text to `text`), so Postgres picks PostGIS's overload without guessing. A per-row number (a radius column, say) can be a numeric column or `sql<number>`.

## Units

Geography distances, areas and lengths are metres on the spheroid. Geometry ones are in the units of the SRID: degrees for 4326. A radius search over longitude/latitude data therefore usually wants geography, and `stDWithin` rather than `stDistance` in a `where`, because only `stDWithin` can use a GiST index.

## Example

```ts
import { asc } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import {
  asGeography,
  geographyColumn,
  knnDistance,
  stAsGeoJSON,
  stDWithin,
  stPoint,
} from "@thomasfosterau/effect-drizzle-ext/postgis";

export const venue = pgTable("venue", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  location: geographyColumn("location", { type: "Point", srid: 4326 }).notNull(),
});

const here = asGeography(stPoint(151.2093, -33.8688, 4326));

// db.select(nearby).from(venue).where(within5km).orderBy(nearestFirst).limit(10)
export const nearby = { name: venue.name, location: stAsGeoJSON(venue.location) };
export const within5km = stDWithin(venue.location, here, 5_000);
export const nearestFirst = asc(knnDistance(venue.location, here));
```

## The extension

PostGIS must be installed before the first table that uses it. Declare it with the pg package's extras, `extension("postgis")` from `@thomasfosterau/effect-drizzle-ext-pg/tooling` ([guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/tooling.md)), and generate that migration before `drizzle-kit generate`. `stPoint`'s SRID form needs PostGIS 3.2 or newer.

```ts
export type Geometry = Brand.Branded<string, "PostGIS/Geometry">;
export type Geography = Brand.Branded<string, "PostGIS/Geography">;
export type GeometryOperand = SQLWrapper<Geometry> | AnyColumn<{ data: Geometry }> | /* Drizzle geometry() */;
export type GeographyOperand = SQLWrapper<Geography> | AnyColumn<{ data: Geography }>;
export type SpatialOperand = GeometryOperand | GeographyOperand;
export const geometryColumn: (name: string, options?: SpatialColumnOptions) => PgCustomColumnBuilder<…>;
export const geographyColumn: (name: string, options?: SpatialColumnOptions) => PgCustomColumnBuilder<…>;
export const stIntersects: <L extends SpatialOperand>(left: L, right: SameKindOperand<L>) => SQL<boolean>;
export const stDWithin: <L extends SpatialOperand>(left: L, right: SameKindOperand<L>, distance: NumberOperand) => SQL<boolean>;
export const stDistance: <L extends SpatialOperand>(left: L, right: SameKindOperand<L>) => SQL<number>;
export const stContains: (left: GeometryOperand, right: GeometryOperand) => SQL<boolean>;
export const stPoint: (x: NumberOperand, y: NumberOperand, srid?: number) => SQL<Geometry>;
export const stAsGeoJSON: <O extends SpatialOperand>(value: O, maxDecimalDigits?: number) => SQL<string>;
```
