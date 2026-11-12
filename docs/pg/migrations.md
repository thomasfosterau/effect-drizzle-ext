# `./migrations`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

The ordered runner for a **brand-new** database. It reads a drizzle-kit `migrations/` directory (one `<digits>_<slug>/` per migration, each holding a `migration.sql`) and applies every migration in directory-name order, each in its own transaction, with no ledger. It mirrors the apply order and transaction shape of alchemy's deploy-time runner, minus the bookkeeping table: the database is always fresh, so every migration applies unconditionally. A directory without a `migration.sql` is skipped. The first failure stops the run with a `MigrationError` naming the migration directory; that migration's transaction rolls back and the ones before it stay applied.

`@effect/sql-pg` speaks the extended query protocol, which refuses more than one statement per query. So each `migration.sql` is split on drizzle-kit's `--> statement-breakpoint` marker, exactly as drizzle's own migrator does, and the statements run in order inside the migration's transaction. A hand-written migration must keep that marker between its statements.

The directory is read through the `FileSystem` / `Path` services (a Node program provides `@effect/platform-node`'s `NodeServices.layer`), and the statements run on the ambient `SqlClient`.

```ts
export class MigrationError /* Schema.TaggedError: migration, cause */ {}
export interface Migration {
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}
export const STATEMENT_BREAKPOINT: "--> statement-breakpoint";
export const splitStatements: (sql: string) => ReadonlyArray<string>;
export const readMigrations: (
  dir: string,
) => Effect.Effect<ReadonlyArray<Migration>, PlatformError, FileSystem | Path>;
export const applyMigrationList: (
  migrations: ReadonlyArray<Migration>,
) => Effect.Effect<number, MigrationError, SqlClient>;
export const applyMigrations: (
  dir: string,
) => Effect.Effect<number, MigrationError | PlatformError, SqlClient | FileSystem | Path>;
```

```ts
const applied = applyMigrations(MIGRATIONS_DIR).pipe(
  Effect.provide(PgClient.layer({ url, maxConnections: 1 })),
  Effect.provide(NodeServices.layer),
);
```
