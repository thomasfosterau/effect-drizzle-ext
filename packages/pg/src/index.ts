/**
 * The `@effect/sql-pg` binding, as one namespace per module. `Tooling` is the
 * exception: it needs the optional `drizzle-kit` peer, so it is reachable only
 * through its `./Tooling` subpath. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/overview.md).
 *
 * @module index
 */

/** Chain writes over `@effect/sql-pg`; the same module as the `./Chain` subpath. */
export * as Chain from "./Chain.ts";

/** The document store; the same module as the `./Documents` subpath. */
export * as Documents from "./Documents.ts";

/** External-id mappings; the same module as the `./ExternalIds` subpath. */
export * as ExternalIds from "./ExternalIds.ts";

/** The migration runner; the same module as the `./Migrations` subpath. */
export * as Migrations from "./Migrations.ts";

/** The transactional outbox; the same module as the `./Outbox` subpath. */
export * as Outbox from "./Outbox.ts";

/**
 * `makePgDatabase` and the `PgClient` layers; the same module as the
 * `./PgDatabase` subpath.
 */
export * as PgDatabase from "./PgDatabase.ts";

/** The test runner and database provisioning; the same module as the `./Testing` subpath. */
export * as Testing from "./Testing.ts";

/**
 * The typed Drizzle helpers for PlanetScale's TIN full-text search; the same
 * module as the `./Tin` subpath.
 */
export * as Tin from "./Tin.ts";

/** Optimistic concurrency over a flat table; the same module as the `./VersionedRow` subpath. */
export * as VersionedRow from "./VersionedRow.ts";
