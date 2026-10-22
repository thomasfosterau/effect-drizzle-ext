/**
 * @copyright Thomas Foster
 *
 * **Ephemeral test-database provisioning** — the half of an integration
 * suite's global setup every consuming application carried as
 * `packages/integration-harness/local-database.ts`. Re-exported from
 * `./testing`; the reference is the preferenceflow application's copy.
 *
 * A suite's database is resolved in this order ({@link resolveDatabaseSource}):
 *
 * 0. **An explicit `DATABASE_URL_TEST` / `DATABASE_URL`** wins and is used
 *    as-is: it must already be migrated — the escape hatch for pointing the
 *    suite at a deployed stage's database or any other prepared server.
 *    Nothing is provisioned and nothing is torn down.
 * 1. **A reachable local server** — a CI service container, a devcontainer's
 *    PostgreSQL, or anything the standard `PG*` variables (`PGHOST`,
 *    `PGPORT`, `PGUSER`, `PGPASSWORD`) point at; the default is a trust-auth
 *    `postgres@127.0.0.1:5432`. Each run gets a **freshly created database**
 *    on it: drop, create, apply every migration.
 * 2. **A Testcontainers-launched container** when nothing is listening and
 *    no `PG*` variable was set explicitly. Needs a Docker daemon and the
 *    optional peer `@testcontainers/postgresql`, which is imported only on
 *    this path. The container is brand new, so migrations apply directly, and
 *    it stops when the provisioning scope closes.
 *
 * Explicit `PG*` config that is unreachable is a hard error
 * ({@link DatabaseUnreachable}), not a silent fallback: if you pointed the
 * suite somewhere, it should not quietly run elsewhere.
 *
 * Either way run N's verdict is independent of run N−1: no state survives
 * between runs. The per-checkout database name
 * `<prefix>_test_<sha256(migrationsDir)[:8]>` keeps parallel worktrees
 * sharing one server from dropping each other's database mid-run — pass the
 * migrations directory as an absolute path, which is per-checkout.
 *
 * What stays with the application: fixture users and seed data (website
 * #1847 keeps the harness → database edge one-way), and the container image
 * and database-name prefix, which are parameters here.
 *
 * @module provisioning
 */

import * as PgClient from "@effect/sql-pg/PgClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { SqlError } from "effect/sql/SqlError";
import { applyMigrations, type MigrationError } from "./migrations.ts";

/**
 * The environment the resolution reads — the shape of `process.env`, taken
 * as a parameter so the order is testable against a fake.
 */
export interface ResolutionEnvironment {
  // oxlint-disable-next-line effect/prefer-option-over-null -- this IS `process.env`'s shape (an index signature whose unset variables are missing keys); the real environment is passed straight in
  readonly [name: string]: string | undefined;
}

/** The variables that count as "explicitly pointed at a server". */
const SERVER_VARIABLES = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD"] as const;

/** How long one connection attempt against the admin database may take. */
const CONNECT_TIMEOUT = Duration.seconds(10);

/** Where a local server is expected, honouring the standard `PG*` variables. */
const serverConfig = (env: ResolutionEnvironment) => ({
  host: env.PGHOST ?? "127.0.0.1",
  port: Number(env.PGPORT ?? "5432"),
  user: env.PGUSER ?? "postgres",
  password: env.PGPASSWORD ?? "",
});

/** Was a server location explicitly configured (vs. the loopback default)? */
const serverExplicitlyConfigured = (env: ResolutionEnvironment): boolean =>
  SERVER_VARIABLES.some((name) => (env[name] ?? "") !== "");

/** The connection URL for `database` on the configured local server. */
export const connectionUrl = (
  env: ResolutionEnvironment,
  database: string,
): Redacted.Redacted<string> => {
  const { host, port, user, password } = serverConfig(env);
  const auth = password === "" ? user : `${user}:${encodeURIComponent(password)}`;
  return Redacted.make(`postgresql://${auth}@${host}:${port}/${database}`);
};

/** `user@host:port` — the configured server, printable (no password). */
const serverLabel = (env: ResolutionEnvironment): string => {
  const { host, port, user } = serverConfig(env);
  return `${user}@${host}:${port}`;
};

/** A database-name prefix is spliced into DDL unquoted-safe, so it is restricted to an identifier. */
const DATABASE_PREFIX = /^[a-z_][a-z0-9_]*$/;

/** The prefix is not a lower-case SQL identifier. */
export class InvalidDatabasePrefix extends Schema.TaggedError<InvalidDatabasePrefix>()(
  "InvalidDatabasePrefix",
  { prefix: Schema.String },
) {
  override get message(): string {
    return `database-name prefix '${this.prefix}' must match ${DATABASE_PREFIX.source}`;
  }
}

/**
 * The deterministic per-checkout database name
 * `<prefix>_test_<sha256(migrationsDir)[:8]>`: concurrent runs from different
 * worktrees never collide, and a stale database self-heals on the next run.
 */
export const testDatabaseName = (options: {
  readonly prefix: string;
  readonly migrationsDir: string;
}): Effect.Effect<string, InvalidDatabasePrefix> =>
  Effect.gen(function* () {
    if (!DATABASE_PREFIX.test(options.prefix)) {
      return yield* new InvalidDatabasePrefix({ prefix: options.prefix });
    }
    // oxlint-disable-next-line effect/effect-promise-vs-trypromise -- SHA-256 over a byte array cannot reject; a rejection would be a platform defect, not an error a caller could handle
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.migrationsDir)),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 8);
    return `${options.prefix}_test_${hex}`;
  });

/** One connection attempt against a server's admin database failed. */
export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()(
  "ServerUnreachable",
  { cause: Schema.Defect() },
) {}

/**
 * One connection attempt against a server's admin (`postgres`) database.
 * Injected into {@link resolveDatabaseSource} so the resolution order can be
 * exercised without a server; {@link probeServer} is the real one.
 */
export type ServerProbe = (
  adminUrl: Redacted.Redacted<string>,
) => Effect.Effect<void, ServerUnreachable>;

/** A `SELECT 1` over one short-lived connection. */
export const probeServer: ServerProbe = (adminUrl) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`SELECT 1`;
  }).pipe(
    Effect.provide(
      PgClient.layer({ url: adminUrl, maxConnections: 1, connectTimeout: CONNECT_TIMEOUT }),
    ),
    Effect.mapError((cause) => new ServerUnreachable({ cause })),
  );

/** An explicit but unreachable `PG*` target: this run will not fall back to a container. */
export class DatabaseUnreachable extends Schema.TaggedError<DatabaseUnreachable>()(
  "DatabaseUnreachable",
  { server: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return [
      `no PostgreSQL server at ${this.server}.`,
      "PG* variables are set, so this run will not fall back to Testcontainers —",
      "fix the PG* target, unset it to let the suite start its own server, or set",
      "DATABASE_URL_TEST to an already-migrated database.",
    ].join("\n");
  }
}

/** Where a run's database comes from — the resolved decision, before anything is provisioned. */
export type DatabaseSource =
  /** An explicit, already-migrated database: used as-is, never provisioned or torn down. */
  | { readonly _tag: "Explicit"; readonly url: Redacted.Redacted<string> }
  /** A reachable local server: this checkout's database is dropped, recreated and migrated on it. */
  | {
      readonly _tag: "LocalServer";
      readonly adminUrl: Redacted.Redacted<string>;
      readonly database: string;
      readonly url: Redacted.Redacted<string>;
    }
  /** No explicit config and nothing listening: a fresh container is started via Testcontainers. */
  | { readonly _tag: "Container"; readonly image: string };

/** The inputs {@link resolveDatabaseSource} reads. */
export interface DatabaseSourceOptions {
  /** The environment — `process.env` in a global setup. */
  readonly env: ResolutionEnvironment;
  /** The migrations directory, as an absolute path: the per-checkout key of the database name. */
  readonly migrationsDir: string;
  /** The database-name prefix, a lower-case SQL identifier (the application's name, say). */
  readonly dbNamePrefix: string;
  /** The container image the Testcontainers fallback starts (`pgvector/pgvector:pg17`, `postgres:17`, …). */
  readonly image: string;
  /** The server probe: {@link probeServer} when absent or `undefined`. A test substitutes its own. */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the `?: T | undefined` spelling (AGENTS.md → Conventions) lets a caller under `exactOptionalPropertyTypes` forward its own optional; read through `??`, so `undefined` means absent
  readonly probe?: ServerProbe | undefined;
}

/**
 * Resolve where a run's database comes from, in the order the module doc
 * describes: an explicit URL, then a reachable local server (an explicit but
 * unreachable `PG*` target is a {@link DatabaseUnreachable}), then the
 * Testcontainers fallback. Pure apart from the one probe, which only runs
 * when no explicit URL is set.
 */
export const resolveDatabaseSource = (
  options: DatabaseSourceOptions,
): Effect.Effect<DatabaseSource, DatabaseUnreachable | InvalidDatabasePrefix> =>
  Effect.gen(function* () {
    const { env } = options;
    const explicit = env.DATABASE_URL_TEST ?? env.DATABASE_URL ?? "";
    if (explicit !== "") return { _tag: "Explicit", url: Redacted.make(explicit) } as const;

    const database = yield* testDatabaseName({
      prefix: options.dbNamePrefix,
      migrationsDir: options.migrationsDir,
    });
    const adminUrl = connectionUrl(env, "postgres");
    const probe = options.probe ?? probeServer;
    const reachable = yield* probe(adminUrl).pipe(
      Effect.as(true),
      Effect.catchTag("ServerUnreachable", (unreachable) =>
        serverExplicitlyConfigured(env)
          ? Effect.fail(
              new DatabaseUnreachable({ server: serverLabel(env), cause: unreachable.cause }),
            )
          : Effect.succeed(false),
      ),
    );
    if (reachable) {
      return {
        _tag: "LocalServer",
        adminUrl,
        database,
        url: connectionUrl(env, database),
      } as const;
    }
    return { _tag: "Container", image: options.image } as const;
  });

/** Starting the Testcontainers fallback failed — most often, no Docker daemon. */
export class ContainerStartFailed extends Schema.TaggedError<ContainerStartFailed>()(
  "ContainerStartFailed",
  { image: Schema.String, server: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return [
      `no PostgreSQL server at ${this.server}, and starting a ${this.image} container via`,
      "Testcontainers failed — is a Docker daemon available (and `@testcontainers/postgresql`",
      "installed)? The suite needs one of:",
      "  - a Docker daemon, or",
      "  - a local PostgreSQL server, with PGHOST/PGPORT/PGUSER/PGPASSWORD pointing at it, or",
      "  - DATABASE_URL_TEST set to an already-migrated database to skip provisioning.",
    ].join("\n");
  }
}

/** A provisioned database: its URL, and the source it was resolved from. */
export interface ProvisionedDatabase {
  readonly url: Redacted.Redacted<string>;
  readonly source: DatabaseSource;
}

/**
 * How a provisioned database is migrated: handed the new database's URL,
 * returns how many migrations ran. The default applies the migrations under
 * {@link ProvisionOptions.migrationsDir} with `./migrations`'
 * `applyMigrations` over a one-connection `PgClient`.
 */
export type MigrationRunner<E, R> = (url: Redacted.Redacted<string>) => Effect.Effect<number, E, R>;

/** The inputs {@link provisionTestDatabase} takes. */
export interface ProvisionOptions<E = never, R = never> extends DatabaseSourceOptions {
  /**
   * Replaces the default runner (for a harness whose migrations are not a
   * drizzle-kit directory); absent or `undefined` keeps the default.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the `?: T | undefined` spelling (AGENTS.md → Conventions) lets a caller under `exactOptionalPropertyTypes` forward its own optional; read through `??`, so `undefined` means absent
  readonly applyMigrations?: MigrationRunner<E, R> | undefined;
}

/** The default {@link MigrationRunner}: `./migrations` over a one-connection client. */
const defaultRunner =
  (
    migrationsDir: string,
  ): MigrationRunner<
    MigrationError | PlatformError | SqlError,
    FileSystem.FileSystem | Path.Path
  > =>
  (url) =>
    applyMigrations(migrationsDir).pipe(Effect.provide(PgClient.layer({ url, maxConnections: 1 })));

/** Drop and recreate this checkout's database on the reachable server. */
const recreateDatabase = (
  source: Extract<DatabaseSource, { readonly _tag: "LocalServer" }>,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const admin = yield* PgClient.PgClient;
    // Quoted identifiers; `database` is `<prefix>_test_<hex>` with the prefix
    // restricted to an identifier, so nothing here can close the quote.
    yield* admin.unsafe(`DROP DATABASE IF EXISTS "${source.database}" WITH (FORCE)`);
    yield* admin.unsafe(`CREATE DATABASE "${source.database}"`);
  }).pipe(
    Effect.provide(
      PgClient.layer({ url: source.adminUrl, maxConnections: 1, connectTimeout: CONNECT_TIMEOUT }),
    ),
  );

/**
 * Start a fresh server via Testcontainers, stopped when the scope closes. The
 * import is dynamic so a run that found a reachable server never loads the
 * library or talks to Docker at all.
 */
const startContainer = (
  image: string,
  server: string,
): Effect.Effect<Redacted.Redacted<string>, ContainerStartFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
        return new PostgreSqlContainer(image).start();
      },
      catch: (cause) => new ContainerStartFailed({ image, server, cause }),
    }),
    // oxlint-disable-next-line effect/effect-promise-vs-trypromise -- an `acquireRelease` finalizer must have `never` in its error channel, so a failed stop has to be a defect
    (container) => Effect.promise(() => container.stop()),
  ).pipe(Effect.map((container) => Redacted.make(container.getConnectionUri())));

/**
 * Provision a run's fresh, fully-migrated database — resolve the source,
 * then drop / create / migrate on a reachable server, or start and migrate a
 * container — and return its URL. An explicit source is returned as-is.
 *
 * Scoped: a started container stops when the scope closes. From a vitest
 * global setup, hold a `Scope` across the run and close it in the returned
 * teardown:
 *
 * @example
 * ```ts
 * export default async function setup() {
 *   const scope = Effect.runSync(Scope.make());
 *   const database = await Effect.runPromise(
 *     provisionTestDatabase({
 *       env: process.env,
 *       migrationsDir: MIGRATIONS_DIR,
 *       dbNamePrefix: "website",
 *       image: "pgvector/pgvector:pg17",
 *     }).pipe(Scope.provide(scope), Effect.provide(NodeServices.layer)),
 *   );
 *   process.env.DATABASE_URL_TEST = Redacted.value(database.url);
 *   return () => Effect.runPromise(Scope.close(scope, Exit.void));
 * }
 * ```
 */
export const provisionTestDatabase = <
  E = MigrationError | PlatformError | SqlError,
  R = FileSystem.FileSystem | Path.Path,
>(
  options: ProvisionOptions<E, R>,
): Effect.Effect<
  ProvisionedDatabase,
  | E
  | DatabaseUnreachable
  | InvalidDatabasePrefix
  | ContainerStartFailed
  | SqlError
  | MigrationError
  | PlatformError,
  R | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const source = yield* resolveDatabaseSource(options);
    if (Predicate.isTagged(source, "Explicit")) return { url: source.url, source };

    const url = Predicate.isTagged(source, "LocalServer")
      ? yield* recreateDatabase(source).pipe(Effect.as(source.url))
      : yield* startContainer(source.image, serverLabel(options.env));

    const migrate = options.applyMigrations ?? defaultRunner(options.migrationsDir);
    const applied = yield* migrate(url);
    yield* Effect.logInfo(
      `provisioned ${
        Predicate.isTagged(source, "LocalServer")
          ? `'${source.database}'`
          : `a ${source.image} container`
      } (${applied} migrations)`,
    );
    return { url, source };
  }).pipe(Effect.withLogSpan("provisionTestDatabase"));
