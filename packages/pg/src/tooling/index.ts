/**
 * @copyright Thomas Foster
 *
 * **Schema and migration guards for a drizzle-kit `migrations/` directory**,
 * as bin-less Effects an application's own `db:*` tasks run with its schema
 * module: {@link checkMigrationDrift} (DAG integrity, zero drift against the
 * latest snapshot, base ancestry) and {@link checkViewDependencies} (no view
 * selects from another view). Neither needs a database.
 *
 * `drizzle-kit` is an optional peer that only this subpath imports
 * (`drizzle-kit/api-postgres`). The file-system and `git` access go through
 * the `FileSystem` / `Path` / `ChildProcessSpawner` services — a Node script
 * provides `@effect/platform-node`'s `NodeServices.layer`.
 *
 * @module tooling
 */

export {
  type BaseMigrations,
  type BaseRefEnvironment,
  checkBaseAncestry,
  checkDagIntegrity,
  checkMigrationDrift,
  findHeads,
  type GitBase,
  MalformedSnapshot,
  MigrationDriftError,
  type MigrationDriftOptions,
  type MigrationDriftReport,
  readBaseMigrations,
  resolveBaseRef,
  ROOT_SENTINEL_ID,
  SchemaDiffError,
  type Snapshot,
  type SnapshotEntry,
} from "./migration-drift.ts";
export {
  checkViewDependencies,
  findViewEdges,
  parseViewDefinitions,
  referencesView,
  type ViewDefinition,
  ViewDependencyError,
  type ViewEdge,
  viewKey,
} from "./view-dependencies.ts";
