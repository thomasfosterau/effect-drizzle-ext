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
import { provisionLocalDatabase } from "./local-database.ts";

function loadDotenv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

async function resolveDatabase(): Promise<{ url: string; teardown: () => Promise<void> }> {
  const noTeardown = async () => {};
  const preset = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (preset) return { url: preset, teardown: noTeardown };

  loadDotenv();
  const fromDotenv = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (fromDotenv) return { url: fromDotenv, teardown: noTeardown };

  const provisioned = await provisionLocalDatabase();
  process.env.DATABASE_URL_TEST = provisioned.url;
  return provisioned;
}

export default async function setup(): Promise<() => Promise<void>> {
  const { teardown } = await resolveDatabase();
  return teardown;
}
