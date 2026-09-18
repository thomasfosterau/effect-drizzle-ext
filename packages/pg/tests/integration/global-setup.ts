/**
 * Vitest global setup for the integration suite: resolve `DATABASE_URL_TEST`,
 * provisioning an ephemeral local database when none is supplied.
 *
 * An explicit `DATABASE_URL_TEST` / `DATABASE_URL` (from the environment,
 * then `.env`) always wins and is used as-is. This runs ONCE in vitest's main
 * process, before any project's worker forks spawn, so the env set here is
 * inherited by every fork of every project.
 */

import { existsSync } from "node:fs";
import * as Option from "effect/Option";
import { provisionLocalDatabase } from "./local-database.ts";

function loadDotenv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

/** The explicit database, from the environment first and `.env` second. */
function explicitDatabaseUrl(): Option.Option<string> {
  const fromEnvironment = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (fromEnvironment) return Option.some(fromEnvironment);
  loadDotenv();
  return Option.fromNullishOr(process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL);
}

async function resolveDatabase(): Promise<{ url: string; teardown: () => Promise<void> }> {
  const explicit = explicitDatabaseUrl();
  if (Option.isSome(explicit)) return { url: explicit.value, teardown: async () => {} };

  const provisioned = await provisionLocalDatabase();
  process.env.DATABASE_URL_TEST = provisioned.url;
  return provisioned;
}

export default async function setup(): Promise<() => Promise<void>> {
  const { teardown } = await resolveDatabase();
  return teardown;
}
