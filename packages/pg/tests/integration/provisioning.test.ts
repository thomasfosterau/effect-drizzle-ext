import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { applyMigrations, MigrationError } from "../../src/migrations.ts";

/**
 * The global setup provisioned this run's database through the exported
 * `provisionTestDatabase`, which applied the committed fixture chain with
 * `applyMigrations`: the smallest proof that both ran, that every other spec
 * can trust `DATABASE_URL_TEST`, and that a failing migration is named.
 */
const url = Redacted.make(process.env.DATABASE_URL_TEST ?? "");

/** The suite's runtime: one single-connection pool on `DATABASE_URL_TEST`, plus the Node services. */
const runtime = ManagedRuntime.make(
  Layer.merge(PgClient.layer({ url, maxConnections: 1 }), NodeServices.layer),
);
afterAll(() => runtime.dispose());

const run = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient | SqlClient | FileSystem.FileSystem | Path.Path>,
): Promise<A> => runtime.runPromise(effect);

describe("provisioning", () => {
  it("answers a query on DATABASE_URL_TEST", async () => {
    expect(Redacted.value(url)).not.toBe("");
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ one: number }>`select 1::int as one`;
      }),
    );
    expect(rows[0]?.one).toBe(1);
  });

  it("applied both fixture migrations, in order", async () => {
    const columns = await run(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ column_name: string }>`
          select column_name from information_schema.columns
          where table_schema = 'fixture' and table_name = 'widget' order by ordinal_position`;
      }),
    );
    // `retired_at` is the second migration's column.
    expect(columns.map((c) => c.column_name)).toEqual(["id", "slug", "retired_at"]);
  });

  it("rolls back and names the migration that fails", async () => {
    const outcome = await run(
      Effect.scoped(
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
          return { error, tables: tables.map((t) => t.table_name) };
        }),
      ),
    );
    expect(outcome.error).toBeInstanceOf(MigrationError);
    expect(outcome.error.message).toBe("migration '0002_broken' failed");
    // The first migration committed; the broken one's own CREATE rolled back with it.
    expect(outcome.tables).toEqual(["t"]);
  });
});
