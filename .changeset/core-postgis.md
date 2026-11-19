---
"@thomasfosterau/effect-drizzle-ext": minor
---

New `./postgis` entry: typed PostGIS helpers that sit beside Drizzle's `eq`. `geometryColumn` and `geographyColumn` are custom columns for any subtype and SRID (Drizzle's own `geometry()` is point-only, and it has no geography column). The predicates (`stIntersects`, `stDWithin`, `stContains`, …), measures (`stDistance`, `knnDistance`, `stArea`, …), constructors (`stPoint`, `stGeomFromGeoJSON`, `stMakeEnvelope`, …) and outputs (`stAsGeoJSON`, `stX`, …) return typed `SQL`, take only geometry or geography operands, refuse a geometry and a geography in one call, and accept geometry only where PostGIS does.
