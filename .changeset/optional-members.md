---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Options bags the library reads itself now spell optional members `readonly x?: T` instead of `?: T | undefined` (effect-drizzle-ext#105):

- core: `SortableColumnsOptions`, `ResolveSortOrderOptions`, `ChronologicalOrderOptions`, `NumericBounds`, `DiscriminatorNames` and `typeConstraints`' `refinable`, and `defineTree`'s `LevelSpec`.
- -pg: `DatabaseSourceOptions.probe`, `ProvisionOptions.applyMigrations`, and `MigrationDriftOptions.base` (now `base?: Option.Option<GitBase>`).

`ResolutionEnvironment` and `BaseRefEnvironment` are now `Readonly<NodeJS.ProcessEnv>`, so `process.env` passes as before.

Config handed to Drizzle (`DbColumn`, `DeriveOptions`, `./versioned-chain`'s builder config) and to `PgPoolConfig` (`pgClientFromUrl` / `pgClientFromPool` / `testDatabaseLayer`) keeps `?: T | undefined`.

**Migration:** under `exactOptionalPropertyTypes`, omit an absent member instead of passing `undefined`. For example, `resolveSortOrder({ view, sort: query.sort })` with a possibly-undefined `query.sort` becomes `resolveSortOrder({ view, ...(query.sort === undefined ? {} : { sort: query.sort }) })`, or forward the whole optional with a rest spread (`const { direction, ...rest } = options`).
