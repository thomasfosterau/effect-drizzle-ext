/**
 * @copyright Thomas Foster
 *
 * **The ordered migration runner for a brand-new database.** Reads a
 * drizzle-kit `migrations/` directory and applies every migration in it, in
 * directory-name order, one transaction per migration, with no ledger.
 *
 * It is what an integration suite's provisioning runs against the database it
 * has just created ({@link ../testing.ts}'s `provisionTestDatabase` calls it by
 * default), and it mirrors the apply order and per-migration transaction
 * shape of alchemy's deploy-time `migrationsDir` runner, minus its ledger:
 * the database is **always** brand new, so every migration applies
 * unconditionally and no bookkeeping table is needed. A database that already
 * holds some of the migrations is not this runner's input — use the
 * deployment's own migrator there.
 *
 * ## The layout it reads
 *
 * drizzle-kit writes one directory per migration, `<digits>_<slug>/`,
 * holding `migration.sql` (and `snapshot.json`, which this runner ignores).
 * The all-digit, fixed-width prefixes make name order chronological. A
 * directory with no `migration.sql` is skipped rather than failing the run —
 * drizzle-kit writes the snapshot before the SQL, and a sanctioned
 * hand-written bootstrap directory may carry only SQL.
 *
 * ## Statements, not files
 *
 * `@effect/sql-pg` speaks the extended query protocol, which rejects more
 * than one statement per query ("cannot insert multiple commands into a
 * prepared statement"). drizzle-kit separates the statements of a migration
 * with a `--> statement-breakpoint` line, and drizzle's own migrator splits
 * on exactly that marker, so this runner does the same: each migration's
 * statements run in order inside that migration's one transaction. A
 * hand-written migration must keep the marker between statements.
 *
 * Idiomatic Effect: the directory is read through the `FileSystem` / `Path`
 * services (a Node consumer provides `@effect/platform-node`'s
 * `NodeServices.layer`), and the statements run on the ambient `SqlClient`.
 *
 * @module migrations
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
export const readMigrations = (
  dir: string,
): Effect.Effect<ReadonlyArray<Migration>, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
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
export const applyMigrationList = (
  migrations: ReadonlyArray<Migration>,
): Effect.Effect<number, MigrationError, SqlClient> =>
  Effect.gen(function* () {
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
          .pipe(
            Effect.mapError((cause) => new MigrationError({ migration: migration.name, cause })),
          ),
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
 * const applied = applyMigrations(MIGRATIONS_DIR).pipe(
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
