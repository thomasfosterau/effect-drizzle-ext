/**
 * A consumer's view of both packages: every subpath imported through its
 * emitted declarations. Filled in per module as each implementation wave
 * lands; a module whose declarations degrade to `any` fails here.
 */

import * as Core from "@thomasfosterau/effect-drizzle-ext";
import * as Derive from "@thomasfosterau/effect-drizzle-ext/derive";
import * as References from "@thomasfosterau/effect-drizzle-ext/references";
import * as Constraints from "@thomasfosterau/effect-drizzle-ext/constraints";
import * as Columns from "@thomasfosterau/effect-drizzle-ext/columns";
import * as Query from "@thomasfosterau/effect-drizzle-ext/query";
import * as Errors from "@thomasfosterau/effect-drizzle-ext/errors";
import * as Database from "@thomasfosterau/effect-drizzle-ext/database";
import * as VersionedChain from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import * as Jsonapi from "@thomasfosterau/effect-drizzle-ext/jsonapi";
import * as JsonapiDerive from "@thomasfosterau/effect-drizzle-ext/jsonapi/derive";
import * as Pg from "@thomasfosterau/effect-drizzle-ext-pg";
import * as PgTesting from "@thomasfosterau/effect-drizzle-ext-pg/testing";

export const modules = {
  Core,
  Derive,
  References,
  Constraints,
  Columns,
  Query,
  Errors,
  Database,
  VersionedChain,
  Jsonapi,
  JsonapiDerive,
  Pg,
  PgTesting,
};
