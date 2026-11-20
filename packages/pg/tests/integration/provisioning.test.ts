import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { expect } from "vite-plus/test";
import { applyMigrations, MigrationError } from "../../src/Migrations.ts";
import { testDatabaseUrl } from "./database-url.ts";

/**
 * The global setup provisioned this run's database through the exported
 * `provisionTestDatabase`, which applied the committed fixture chain with
 * `applyMigrations`: the smallest proof that both ran, that every other spec
 * can trust `DATABASE_URL_TEST`, and that a failing migration is named.
 */

/** The suite's layer: one single-connection pool on `DATABASE_URL_TEST`, plus the Node services. */
const suiteLayer = Layer.merge(
  Layer.unwrap(Effect.map(testDatabaseUrl, (url) => PgClient.layer({ url, maxConnections: 1 }))),
  NodeServices.layer,
);

layer(suiteLayer, { excludeTestServices: true })("provisioning", (it) => {
  it.effect("answers a query on DATABASE_URL_TEST", () =>
    Effect.gen(function* () {
      expect(Redacted.value(yield* testDatabaseUrl)).not.toBe("");
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ one: number }>`select 1::int as one`;
      expect(rows[0]?.one).toBe(1);
    }),
  );

  it.effect("applied both fixture migrations, in order", () =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const columns = yield* sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_schema = 'fixture' and table_name = 'widget' order by ordinal_position`;
      // `retired_at` is the second migration's column.
      expect(columns.map((c) => c.column_name)).toEqual(["id", "slug", "retired_at"]);
    }),
  );

  it.effect("rolls back and names the migration that fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(dir, "0001_ok"));
      yield* fs.writeFileString(
        path.join(dir, "0001_ok", "migration.sql"),
        "CREATE SCHEMA provisioning_probe;\n--> statement-breakpoint\nCREATE TABLE provisioning_probe.t (x int);",
      );
      yield* fs.makeDirectory(path.join(dir, "0002_broken"));
      yield* fs.writeFileString(
        path.join(dir, "0002_broken", "migration.sql"),
        "CREATE TABLE provisioning_probe.u (y int);\n--> statement-breakpoint\nSELECT * FROM provisioning_probe.nonesuch;",
      );
      const error = yield* Effect.flip(applyMigrations(dir));
      const sql = yield* PgClient.PgClient;
      const tables = yield* sql<{ table_name: string }>`
        select table_name from information_schema.tables
        where table_schema = 'provisioning_probe' order by table_name`;
      yield* sql`DROP SCHEMA provisioning_probe CASCADE`;
      expect(error).toBeInstanceOf(MigrationError);
      expect(error.message).toBe("migration '0002_broken' failed");
      // The first migration committed; the broken one's own CREATE rolled back with it.
      expect(tables.map((t) => t.table_name)).toEqual(["t"]);
    }),
  );
});
