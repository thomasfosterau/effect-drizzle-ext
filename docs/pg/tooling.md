# `./Tooling`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

Two schema guards for a drizzle-kit `migrations/` directory, and a generator for what drizzle-kit doesn't manage ([below](#extras-what-drizzle-kit-doesnt-manage)). The guards need no database. Both are **bin-less** Effects: an application's own `db:migration-drift` / `db:view-dependencies` task runs them with its schema module and reports the typed error. They are ported from the applications' `packages/database/scripts/check-*.ts`. `drizzle-kit` is an optional peer that only this subpath imports, through `drizzle-kit/api-postgres`.

**`checkMigrationDrift({ schema, migrationsDir, base? })`** runs three checks, each guarding "snapshot history is a DAG, not a chain" from a different side. All three problems are reported together as one `MigrationDriftError { issues }`.

1. **DAG integrity** (`checkDagIntegrity`, pure):
   - every snapshot id is unique;
   - every `prevIds` entry resolves, or is drizzle-kit's all-zero root sentinel;
   - there is exactly one head, and everything is reachable from it;
   - there is no cycle.
2. **Zero drift.** The schema is diffed against the **lexicographically-latest** snapshot with `generateDrizzleJson` / `generateMigration`: the same "latest by directory name" pick alchemy's `Drizzle.Schema.regenerate` makes at deploy time, not a DAG-aware one. The result must be zero statements. A diff drizzle-kit could only resolve interactively (rename or recreate) counts as drift too. This check runs only on a structurally sound DAG.
3. **Base ancestry**, when `base` is `Some`. Every migration the branch adds must descend from the base branch's current head. `readBaseMigrations` reads the base through `git ls-tree` / `git show` (fetching it into a shallow checkout if needed). `resolveBaseRef(env)` takes the ref from `MIGRATION_BASE_REF`, else from `origin/$GITHUB_BASE_REF`, which GitHub Actions sets only on pull requests.

**`checkViewDependencies({ schema })`** fails with `ViewDependencyError { edges }` when any view selects from another view (`DB-VIEW-001`). drizzle-kit emits `DROP VIEW` / `CREATE VIEW` with no topological order and no cascade, so a migration touching either end of such an edge is one PostgreSQL rejects. It reads the graph out of drizzle-kit's own `CREATE VIEW` DDL.

```ts
export const checkMigrationDrift: (options: {
  readonly schema: Record<string, unknown>;
  readonly migrationsDir: string;
  readonly base?: Option.Option<GitBase> | undefined; // { ref, migrationsPath, cwd }
}) => Effect.Effect<
  MigrationDriftReport, // { snapshots, baseRef }
  MigrationDriftError | MalformedSnapshot | SchemaDiffError | PlatformError,
  FileSystem | Path | ChildProcessSpawner
>;
export const checkViewDependencies: (options: {
  readonly schema: Record<string, unknown>;
}) => Effect.Effect<{ readonly viewCount: number }, ViewDependencyError | SchemaDiffError>;
// Pure pieces, for a caller composing its own report:
export const checkDagIntegrity: (entries: ReadonlyArray<SnapshotEntry>) => ReadonlyArray<string>;
export const checkBaseAncestry: (
  entries: ReadonlyArray<SnapshotEntry>,
  base: BaseMigrations,
) => ReadonlyArray<string>;
export const findViewEdges: (views: ReadonlyArray<ViewDefinition>) => ReadonlyArray<ViewEdge>;
```

An application's script:

```ts
// packages/database/scripts/check-migration-drift.ts — run by the `db:migration-drift` task
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { checkMigrationDrift, resolveBaseRef } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
import * as schema from "../src/schema.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
checkMigrationDrift({
  schema,
  migrationsDir: path.join(repoRoot, "packages/database/migrations"),
  base: Option.map(resolveBaseRef(process.env), (ref) => ({
    ref,
    migrationsPath: "packages/database/migrations",
    cwd: repoRoot,
  })),
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
```

This repository proves both guards against a committed fixture chain, `packages/pg/tests/fixtures/` (a schema module plus the drizzle-kit migrations generated from it), in the unit suite CI runs. The integration suite provisions its database from the same chain.

## Extras: what drizzle-kit doesn't manage

drizzle-kit's postgres diff has no extensions, domains, composite types, functions or triggers. Its escape hatch is a custom migration (`drizzle-kit generate --custom`), an empty `migration.sql` that drizzle-kit never reads, so nothing records what the migration created. **`generateMigrations`** fills that hole. The application declares the extras next to its schema, and the generator writes the SQL that moves the database from the recorded state to the declared one into two custom migrations around drizzle-kit's own. **`checkExtrasDrift`** is the CI gate.

```ts
// packages/database/src/extras.ts
import {
  compositeType,
  domain,
  extension,
  fn,
  trigger,
} from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";

const touchUpdatedAt = fn({
  name: "touch_updated_at",
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN NEW.updated_at := now(); RETURN NEW; END;",
});

export const extras = {
  extensions: [extension("citext"), extension("vector", { version: "0.8.0" })],
  domains: [
    domain("email", "citext", {
      notNull: true,
      checks: { email_has_at: "position('@' in VALUE) > 1" },
    }),
  ],
  compositeTypes: [
    compositeType("money_amount", { amount: "numeric(12, 2)", currency: "char(3)" }),
  ],
  functions: [touchUpdatedAt],
  triggers: [
    trigger({
      table: "article",
      name: "article_touch_updated_at",
      timing: "BEFORE",
      events: ["UPDATE"],
      fn: touchUpdatedAt,
    }),
  ],
};
```

```ts
// packages/database/scripts/generate.ts — run by the `db:generate` task, instead of drizzle-kit generate
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { generateMigrations } from "@thomasfosterau/effect-drizzle-ext-pg/Tooling";
import * as Effect from "effect/Effect";
import { extras } from "../src/extras.ts";

generateMigrations({
  extras,
  migrationsDir: "migrations",
  ...(process.argv[2] === undefined ? {} : { name: process.argv[2] }),
  drizzleKit: { config: "drizzle.config.ts" }, // or { schema: "src/schema.ts" }
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
```

How it works:

- **Two phases around drizzle-kit's migration.** An extension or type must exist before the table migration that first uses it, but a trigger needs its table. So `generateMigrations` writes a **before** extras migration (creates and alters of extensions, domains and composite types, then drops of triggers and functions), runs `drizzle-kit generate` with the terminal attached (its rename prompts work), then writes an **after** extras migration (creates and replaces of functions, then triggers, then drops of composite types, domains and extensions, once drizzle-kit has dropped the columns that used them). Each list is in declaration order; drops are newest first. The extras migrations are `<name>-extras-before` and `<name>-extras-after`, and either is skipped when it has nothing to do. `generateExtrasMigration({ phase })` writes one phase on its own, and refuses the after phase while the before one is pending.
- **The state.** Each extras migration carries an `extras.json` beside `migration.sql` and `snapshot.json`, holding the whole state after that migration: the before migration records the intermediate state (`intermediateExtrasState`), so `checkExtrasDrift` fails until the after migration exists. The recorded state is the one in the latest-by-name directory that has the file. drizzle-kit (`check`, `generate`), `./Migrations` and `checkMigrationDrift` all ignore the file. A version 1 file, written before functions and triggers, reads as having neither.
- **The directories are drizzle-kit's.** The generator runs `drizzle-kit generate --custom --name <slug> --output json` (`command` overrides how drizzle-kit is started; the default is `drizzle-kit` on `PATH`, which a package script has), so the folder name, its order and the snapshot's `prevIds` stay drizzle-kit's. drizzle-kit stamps folders to the second, so the generator waits for the next second when the latest folder is that recent. It then replaces the placeholder `migration.sql`, with `--> statement-breakpoint` between statements.
- **Alters.** An extension's schema (`SET SCHEMA`) and pinned version (`UPDATE TO`); a domain's default, `NOT NULL` and named checks; a composite type's attributes (`ADD` / `DROP` / `ALTER ATTRIBUTE … TYPE`). A domain's base type can't be altered, so changing it is an `ExtrasError` naming the domain. Postgres refuses attribute changes to a composite type while a table column uses it.
- **Renames.** Without a hint, a renamed domain or composite type reads as a drop plus a create, and the drop fails once a column uses it. `renames` resolves it the way drizzle-kit's prompt does: `[["domain", "email", "contact_email"], ["compositeType", "app.money", "price"], ["attribute", "price", "amount", "value"]]` emits `ALTER DOMAIN … RENAME TO`, `ALTER TYPE … RENAME TO` (plus `SET SCHEMA` when the schema changed) and `ALTER TYPE … RENAME ATTRIBUTE`, in the before migration, ahead of that kind's alters. Names are `schema.name`, or bare for `public`; an attribute hint names its type by the new name. A hint is for one run: one that doesn't match a recorded and a declared object is an `ExtrasError`, so leave it out afterwards. `checkExtrasDrift` takes none.
- **Hand-written changes.** `recordOnly: true` records the before phase's state in its custom migration but leaves its `migration.sql` to you: a comment block listing what the generator refused and what it would have run. Use it for a change it refuses (a domain's base type) or SQL it can't express, then write the statements, with `--> statement-breakpoint` between them. Duplicate declarations and bad rename hints still fail.
- **Functions and triggers.** A function is keyed on its schema, name and argument types, as Postgres keys it, and emitted as `CREATE OR REPLACE FUNCTION` with its body in a dollar quote; a changed body, language or volatility is one statement. A changed return type or argument name is a drop (before) and a create (after), and so is every trigger that calls the function. A trigger (`CREATE OR REPLACE TRIGGER`, Postgres 14+) is keyed on its table and name; any other change is replaced in place. A trigger calling a declared function that doesn't return `trigger` is an `ExtrasError`.
- **The gate.** `checkExtrasDrift({ extras, migrationsDir })` fails with `ExtrasDriftError { recordedIn, statements }` when a declaration changed without a migration. It needs no database and no drizzle-kit.

Type names, defaults, check expressions, function bodies and `WHEN` conditions are SQL, emitted as written. Identifiers are quoted, and an extension version is a string literal.
