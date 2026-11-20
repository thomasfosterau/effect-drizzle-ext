/**
 * The migration runner for a brand-new database: applies a drizzle-kit
 * `migrations/` directory in name order, one transaction per migration, with no
 * ledger. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/migrations.md).
 *
 * @module Migrations
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import * as Str from "effect/String";

/** drizzle-kit's statement separator inside a `migration.sql`. */
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/** One migration as the runner applies it: its directory name and its statements, in order. */
export interface Migration {
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

/**
 * A migration failed to apply. `migration` names the directory — a bare
 * driver error says only which statement broke, not which file it came from
 * — and `cause` is the driver's `SqlError`. The migration's transaction has
 * been rolled back; the ones before it stay applied.
 */
export class MigrationError extends Schema.TaggedError<MigrationError>()("MigrationError", {
  migration: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `migration '${this.migration}' failed`;
  }
}

/**
 * Split one `migration.sql` into its statements on
 * {@link STATEMENT_BREAKPOINT}, dropping the empty chunks a trailing marker
 * or blank file leaves behind.
 */
export const splitStatements = (sql: string): ReadonlyArray<string> =>
  sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Str.isNonEmpty);

/**
 * Every migration under `dir`, in apply order (directory-name order). Only
 * directories count; one with no `migration.sql` is skipped.
 */
export const readMigrations = Effect.fn("Migrations.readMigrations")(function* (
  dir: string,
): Effect.fn.Return<ReadonlyArray<Migration>, PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = Arr.sort(yield* fs.readDirectory(dir), Order.String);
  const read = yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(path.join(dir, name));
        if (info.type !== "Directory") return [];
        const file = path.join(dir, name, "migration.sql");
        if (!(yield* fs.exists(file))) return [];
        const sql = yield* fs.readFileString(file);
        return [{ name, statements: splitStatements(sql) }];
      }),
    { concurrency: 1 },
  );
  return read.flat();
});

/**
 * Apply `migrations` in order on the ambient `SqlClient`, each inside its own
 * transaction, returning how many ran. Stops at the first failure with a
 * {@link MigrationError} naming the migration.
 */
export const applyMigrationList = Effect.fn("Migrations.applyMigrationList")(function* (
  migrations: ReadonlyArray<Migration>,
): Effect.fn.Return<number, MigrationError, SqlClient> {
  const sql = yield* SqlClient;
  yield* Effect.forEach(
    migrations,
    (migration) =>
      sql
        .withTransaction(
          // In order, one at a time: a migration's statements depend on each other.
          Effect.forEach(migration.statements, (statement) => sql.unsafe(statement), {
            concurrency: 1,
            discard: true,
          }),
        )
        .pipe(Effect.mapError((cause) => new MigrationError({ migration: migration.name, cause }))),
    // Strictly sequential: a later migration may depend on an earlier one.
    { concurrency: 1, discard: true },
  );
  return migrations.length;
});

/**
 * Apply every migration under `dir` to the (brand-new) database behind the
 * ambient `SqlClient` — {@link readMigrations} then {@link applyMigrationList}
 * — returning how many ran.
 *
 * @example
 * ```ts
 * import * as NodeServices from "@effect/platform-node/NodeServices";
 * import * as PgClient from "@effect/sql-pg/PgClient";
 * import { applyMigrations } from "@thomasfosterau/effect-drizzle-ext-pg/Migrations";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 *
 * const url = Redacted.make("postgres://postgres@localhost:5432/app_test");
 *
 * // Building the Effect connects to nothing; running it applies the chain.
 * export const applied = applyMigrations("packages/database/migrations").pipe(
 *   Effect.provide(PgClient.layer({ url, maxConnections: 1 })),
 *   Effect.provide(NodeServices.layer),
 * );
 * ```
 */
export const applyMigrations = (
  dir: string,
): Effect.Effect<
  number,
  MigrationError | PlatformError,
  SqlClient | FileSystem.FileSystem | Path.Path
> => Effect.flatMap(readMigrations(dir), applyMigrationList);
