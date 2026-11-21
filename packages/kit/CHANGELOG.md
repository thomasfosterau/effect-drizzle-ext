# @thomasfosterau/effect-drizzle-ext-kit

## 0.8.0

### Minor Changes

- [#252](https://github.com/thomasfosterau/effect-drizzle-ext/pull/252) [`1a3475d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1a3475d89d41f8554396e8d54752b38ebeae7f22) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The extras generator migrates functions (`fn`) and triggers (`trigger`), and splits its output into two custom migrations around drizzle-kit's own: extensions, domains and composite types (and dropped triggers and functions) before it, functions and triggers (and dropped types, domains and extensions) after it. `generateMigrations` runs the whole sequence, including `drizzle-kit generate`; `generateExtrasMigration` now takes a `phase`, and `ExtrasPlan` has `before` and `after` in place of `statements`. `extras.json` is version 2; version 1 files still read. Rename hints and `recordOnly` apply to the before migration. `effect-drizzle-kit generate` now runs instead of `drizzle-kit generate`, and its `--name` is drizzle-kit's slug.

- [#247](https://github.com/thomasfosterau/effect-drizzle-ext/pull/247) [`b887899`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b88789921ab5ec10767e23a4d00af956de72be44) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The extras generator takes rename hints and a record-only mode. `generateExtrasMigration({ renames })` (and `planExtras`'s third argument) turns a renamed domain, composite type or attribute into `ALTER … RENAME` instead of a drop plus a create; `recordOnly: true` writes the declared state into a custom migration whose SQL you write by hand, for a change the generator refuses. `effect-drizzle-kit generate` gains `--rename` and `--record-only`.

### Patch Changes

- [#251](https://github.com/thomasfosterau/effect-drizzle-ext/pull/251) [`8051a2d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/8051a2d7a456a9df240acae339178c418ccc8f9b) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./chain` writes no longer turn a unique violation of a constraint other than the chain's own (a consumer's unique external key on a stable table, say) into a defect: it stays the driver's error in the typed channel, as `create`'s documentation already said, so `classifyErrors` and `catchUniqueViolation` can recover it. Code that caught it as a defect (`Effect.catchDefect`, `Cause.hasDies`) should catch the failure instead.
  
  The provisioning, migration and `./tooling` entry points, and kit's commands, are now `Effect.fn` functions, so each run is a tracing span (`Testing.*`, `Migrations.*`, `Tooling.*`, `Commands.*`). The test database name is hashed through `effect/crypto`'s `Digest`; the name is unchanged.

- [#246](https://github.com/thomasfosterau/effect-drizzle-ext/pull/246) [`2bbc15f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2bbc15ff073d5847cc67c90765cecbaa1619ecd6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - **Breaking:** adopt Effect v4's export layout. Every module is a PascalCase subpath, and each package root re-exports modules as namespaces instead of flat names. Function and type names are unchanged; only their import paths move.
  
  Upgrade by renaming subpaths:
  
  | Package | Old subpath | New subpath |
  | --- | --- | --- |
  | core | `.` (flat `dbColumn`, `dbTable`, `defineTree`, `DerivationError`, `VersionChainEntry`, …) | `./Annotation`, or the root's `Annotation` namespace |
  | core | `./derive`, `./references`, `./constraints`, `./columns`, `./query`, `./sort`, `./update`, `./errors`, `./database` | `./Derive`, `./References`, `./Constraints`, `./Columns`, `./Query`, `./Sort`, `./Update`, `./Errors`, `./Database` |
  | core | `./query-functions`, `./versioned-chain`, `./postgis` | `./QueryFunctions`, `./VersionedChain`, `./PostGis` |
  | core | `./jsonapi`, `./jsonapi/derive` | `./JsonApi`, `./JsonApiDerive` |
  | pg | `.` (flat `makePgDatabase`, `pgClientFromUrl`, `pgClientFromPool`, `PgDatabase*` types) | `./PgDatabase`, or the root's `PgDatabase` namespace |
  | pg | `./chain`, `./migrations`, `./testing`, `./tooling` | `./Chain`, `./Migrations`, `./Testing`, `./Tooling` |
  
  ```ts
  // before
  import { dbColumnFor } from "@thomasfosterau/effect-drizzle-ext";
  import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/derive";
  import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
  
  // after
  import { dbColumnFor } from "@thomasfosterau/effect-drizzle-ext/Annotation";
  import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/Derive";
  import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
  ```
  
  The core root stays Drizzle-free: it re-exports `Annotation`, `Errors`, `Predicate` and `Update`, plus the `PostGis` namespace as before. Modules that import Drizzle are subpaths only. The pg root re-exports every module except `Tooling`, which needs the optional `drizzle-kit` peer. `./Predicate`, `./Where`, `./Search`, `./Tin`, `./Outbox`, `./Documents` and `./ExternalIds` keep their paths.

- [#244](https://github.com/thomasfosterau/effect-drizzle-ext/pull/244) [`5c40f4e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/5c40f4e56b390a681e2b2032be66fee3aa6e9020) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - `./tooling`'s base-migration reads and `effect-drizzle-kit`'s repository lookup clear `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_WORK_TREE` before running `git`, so the checkout named by `cwd` is the one read even when called from a git hook in a linked worktree.
- Updated dependencies [[`85396a0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/85396a0c6dd292ba72bffa0230359d4e0b35e8e9), [`8051a2d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/8051a2d7a456a9df240acae339178c418ccc8f9b), [`2bbc15f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2bbc15ff073d5847cc67c90765cecbaa1619ecd6), [`1a3475d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1a3475d89d41f8554396e8d54752b38ebeae7f22), [`b887899`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/b88789921ab5ec10767e23a4d00af956de72be44), [`5c40f4e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/5c40f4e56b390a681e2b2032be66fee3aa6e9020), [`1471ece`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/1471ece0f3ad12df7ec7c0237a049f23ed1a8138), [`ba20b3e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/ba20b3ec09e13e2ef0e60070944c3984920d1ad6)]:
  - @thomasfosterau/effect-drizzle-ext-pg@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [[`aeecce2`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/aeecce239c6f902d9f7ba183cc80975813ce1b71), [`20cf6a0`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/20cf6a0be085382d836ff73a9895afa780adb426)]:
  - @thomasfosterau/effect-drizzle-ext-pg@0.7.0

## 0.6.0

### Minor Changes

- [#221](https://github.com/thomasfosterau/effect-drizzle-ext/pull/221) [`ea1312f`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/ea1312f8b85fa47445e51c533db3acec22aa302d) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - New package: `effect-drizzle-kit`, a command-line companion to drizzle-kit (effect-drizzle-ext#216). `effect-drizzle-kit generate --name <slug>` writes the extensions, domains and composite types an `effect-drizzle-kit.config.ts` declares into a drizzle-kit custom migration, and `effect-drizzle-kit check` fails when they drifted from the committed migrations. When the config names its Drizzle schema module, `check` also runs the migration-drift gate. The library entry exports `defineConfig`, `loadConfig`, the `generate` / `check` Effects and the `cli` command.

### Patch Changes

- [#231](https://github.com/thomasfosterau/effect-drizzle-ext/pull/231) [`88acad6`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/88acad6f4177d898bfb9cae0f3cd0158f1578cc4) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Doc comments are shorter and no longer cite issues; module overviews link to the guides.
- Updated dependencies [[`2a12e8c`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/2a12e8c058feedee5b37278eed2590099acdd4f4), [`88acad6`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/88acad6f4177d898bfb9cae0f3cd0158f1578cc4), [`202a16d`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/202a16d3fddce7a88614a507b78f2fe69894b681), [`555f97e`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/555f97e0c88314bb25442f27e0aa3db88a963a2b), [`7ef6279`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/7ef62795d5747cb68a09dd3faef6df271395a484), [`47ffbce`](https://github.com/thomasfosterau/effect-drizzle-ext/commit/47ffbce833f5f8a2575dad9aaecce54066895533)]:
  - @thomasfosterau/effect-drizzle-ext-pg@0.6.0
