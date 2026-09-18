/**
 * Ephemeral local database provisioning for the integration suite — the
 * approach the consuming applications use (their
 * `packages/integration-harness/local-database.ts`), minus migrations: this
 * library owns no schema, so each spec creates the `TEMPORARY` tables it
 * needs inside its rolled-back transaction.
 *
 * When no `DATABASE_URL_TEST` / `DATABASE_URL` is supplied, the suite runs
 * against a PostgreSQL server resolved in this order:
 *
 * 1. **A reachable local server** — CI's `pgvector/pgvector` service
 *    container, or anything the standard `PG*` variables (`PGHOST`, `PGPORT`,
 *    `PGUSER`, `PGPASSWORD`) point at; the default is a trust-auth
 *    `postgres@127.0.0.1:5432`. Each run gets a freshly created database on
 *    it: drop, create.
 * 2. **A Testcontainers-launched `pgvector/pgvector` container** when nothing
 *    is listening and no `PG*` variable was set explicitly. Needs a Docker
 *    daemon. The container stops in the suite's global teardown.
 *
 * Explicit `PG*` config that is unreachable is a hard error, not a silent
 * fallback — if you pointed the suite somewhere, it should not quietly run
 * elsewhere.
 *
 * Not published: this file is test infrastructure for this repository only.
 */

import { createHash } from "node:crypto";
import pg from "pg";

/** Matches CI's service container (ci.yml) and the applications'; pinned tag, not `latest`. */
const CONTAINER_IMAGE = "pgvector/pgvector:pg17";

export interface ProvisionedDatabase {
  readonly url: string;
  /** Stops the Testcontainers server when one was started; a no-op otherwise. */
  readonly teardown: () => Promise<void>;
}

/** One `PG*` variable, or its loopback default. */
const envOr = (name: string, fallback: string): string => process.env[name] ?? fallback;

/** Where a local server is expected, honouring the standard `PG*` vars. */
function serverConfig() {
  return {
    host: envOr("PGHOST", "127.0.0.1"),
    port: Number(envOr("PGPORT", "5432")),
    user: envOr("PGUSER", "postgres"),
    password: envOr("PGPASSWORD", ""),
  };
}

/** Was a server location explicitly configured (vs. the loopback default)? */
function serverExplicitlyConfigured(): boolean {
  return ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD"].some((name) => process.env[name]);
}

function connectionUrl(database: string): string {
  const { host, port, user, password } = serverConfig();
  const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
  return `postgresql://${auth}@${host}:${port}/${database}`;
}

/**
 * Deterministic per-checkout database name, so concurrent runs from different
 * worktrees never collide and a stale database self-heals on the next run.
 */
function testDatabaseName(): string {
  const digest = createHash("sha256")
    .update(import.meta.dirname)
    .digest("hex")
    .slice(0, 8);
  return `effect_drizzle_ext_test_${digest}`;
}

/** Drop and recreate this checkout's test database on the reachable server. */
async function provisionOnLocalServer(admin: pg.Client): Promise<ProvisionedDatabase> {
  const database = testDatabaseName();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
  return { url: connectionUrl(database), teardown: async () => {} };
}

/**
 * Start a fresh `pgvector/pgvector` server via Testcontainers. The import is
 * dynamic so runs that found a reachable server never load the library or
 * talk to Docker at all.
 */
async function provisionContainer(): Promise<ProvisionedDatabase> {
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  try {
    const container = await new PostgreSqlContainer(CONTAINER_IMAGE).start();
    return {
      url: container.getConnectionUri(),
      teardown: async () => {
        await container.stop();
      },
    };
  } catch (cause) {
    throw new Error(
      [
        `integration global-setup: no PostgreSQL server at ${connectionUrl("postgres")}, and`,
        `starting a ${CONTAINER_IMAGE} container via Testcontainers failed — is a Docker`,
        "daemon available? The suite needs one of:",
        "  - a Docker daemon, or",
        "  - PGHOST/PGPORT/PGUSER/PGPASSWORD pointing at any PostgreSQL server, or",
        "  - DATABASE_URL_TEST set to a database the suite may create temporary tables in.",
      ].join("\n"),
      { cause },
    );
  }
}

/**
 * Provision this run's fresh database — on the reachable local server if
 * there is one, otherwise on a Testcontainers-launched server — returning its
 * connection URL and a teardown hook.
 */
/**
 * Probe the local server. Unreachable is a plain `false` — unless `PG*` was set
 * explicitly, in which case it is a hard error: if you pointed the suite
 * somewhere, it should not quietly run elsewhere.
 */
async function probeLocalServer(admin: pg.Client): Promise<boolean> {
  try {
    await admin.connect();
    await admin.query("select 1");
    return true;
  } catch (cause) {
    await admin.end().catch(() => {});
    if (!serverExplicitlyConfigured()) return false;
    throw new Error(
      [
        `integration global-setup: no PostgreSQL server at ${connectionUrl("postgres")}.`,
        "PG* variables are set, so this run will not fall back to Testcontainers —",
        "fix the PG* target, unset it to let the suite start its own server, or set",
        "DATABASE_URL_TEST to a database the suite may use.",
      ].join("\n"),
      { cause },
    );
  }
}

export async function provisionLocalDatabase(): Promise<ProvisionedDatabase> {
  const started = performance.now();
  const admin = new pg.Client({
    connectionString: connectionUrl("postgres"),
    connectionTimeoutMillis: 10_000,
  });
  const reachable = await probeLocalServer(admin);
  const provisioned = reachable ? await provisionOnLocalServer(admin) : await provisionContainer();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stderr.write(
    `integration global-setup: provisioned ${
      reachable ? `'${testDatabaseName()}'` : `a ${CONTAINER_IMAGE} container`
    } (${seconds}s)\n`,
  );
  return provisioned;
}
