/**
 * Bin-less schema and migration guards for a drizzle-kit `migrations/`
 * directory, and the extras generator. None needs a database. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/tooling.md).
 *
 * @module tooling
 */

export {
  checkExtrasDrift,
  CompositeType,
  type CompositeTypeOptions,
  compositeType,
  Domain,
  type DomainOptions,
  domain,
  DrizzleKitError,
  type DrizzleKitTarget,
  emptyExtrasState,
  Extension,
  type ExtensionOptions,
  extension,
  EXTRAS_STATE_FILE,
  ExtrasDriftError,
  type ExtrasDriftOptions,
  ExtrasError,
  type Extras,
  type ExtrasPlan,
  type ExtrasRename,
  ExtrasState,
  type GeneratedExtrasMigration,
  type GenerateExtrasOptions,
  generateExtrasMigration,
  MalformedExtrasState,
  planExtras,
  readExtrasState,
  type RecordedExtras,
  renderExtrasMigration,
  renderRecordOnlyMigration,
  toExtrasState,
} from "./extras.ts";
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
  type SchemaModule,
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
