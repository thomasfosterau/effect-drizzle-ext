---
"@thomasfosterau/effect-drizzle-ext": patch
---

The versioned-chain declarations now typecheck against the published `drizzle-orm@1.0.0-rc.5`: `SubtypeTables`' table configs carry `isAlias: false`, and `makeCurrentVersionView`'s view type passes `PgViewWithSelection` its single `ViewConfig` object. Types only; no runtime change. The `1.0.0-rc.5-ab785fc` commit build, which has the older shapes, no longer matches these declarations.
