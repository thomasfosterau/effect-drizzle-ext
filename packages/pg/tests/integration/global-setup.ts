/**
 * Vitest global setup for the integration suite: provision this run's
 * database through the package's own export, `provisionTestDatabase` from
 * `./testing` — an explicit `DATABASE_URL_TEST` / `DATABASE_URL` (from the
 * environment, then `.env`) wins and is used as-is; otherwise a fresh
 * database on a reachable local server, or a `pgvector/pgvector:pg17`
 * container via Testcontainers, migrated with the committed fixture chain
 * (`tests/fixtures/migrations`) by `./migrations`' `applyMigrations`.
 *
 * This runs ONCE in vitest's main process, before any project's worker forks
 * spawn, so the `DATABASE_URL_TEST` set here is inherited by every fork. The
 * provisioning scope is held open across the run and closed by the returned
 * teardown, which stops a container if one was started.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { existsSync } from "node:fs";
import { provisionTestDatabase } from "../../src/testing.ts";

/** The committed fixture chain; an absolute path, so the database name is per-checkout. */
const MIGRATIONS_DIR = `${import.meta.dirname}/../fixtures/migrations`;

/** Matches CI's service container (ci.yml) and the website / gardeneria applications'. */
const CONTAINER_IMAGE = "pgvector/pgvector:pg17";

export default async function setup(): Promise<() => Promise<void>> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const scope = Effect.runSync(Scope.make());
  const database = await Effect.runPromise(
    provisionTestDatabase({
      env: process.env,
      migrationsDir: MIGRATIONS_DIR,
      dbNamePrefix: "effect_drizzle_ext",
      image: CONTAINER_IMAGE,
    }).pipe(Scope.provide(scope), Effect.provide(NodeServices.layer)),
  );
  process.env.DATABASE_URL_TEST = Redacted.value(database.url);
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
}
