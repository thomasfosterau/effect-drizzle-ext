# `./tooling`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

Two schema guards for a drizzle-kit `migrations/` directory, and a generator for what drizzle-kit doesn't manage ([below](#extras-what-drizzle-kit-doesnt-manage)). The guards need no database. Both are **bin-less** Effects: an application's own `db:migration-drift` / `db:view-dependencies` task runs them with its schema module and reports the typed error. They are ported from the applications' `packages/database/scripts/check-*.ts` (website #1200, #1471, #1228). `drizzle-kit` is an optional peer that only this subpath imports, through `drizzle-kit/api-postgres`.

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
import { checkMigrationDrift, resolveBaseRef } from "@thomasfosterau/effect-drizzle-ext-pg/tooling";
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

drizzle-kit's postgres diff has no extensions, domains or composite types. Its escape hatch is a custom migration (`drizzle-kit generate --custom`), an empty `migration.sql` that drizzle-kit never reads, so nothing records what the migration created (effect-drizzle-ext#212). **`generateExtrasMigration`** fills that hole. The application declares the extras next to its schema, and the generator writes the SQL that moves the database from the recorded state to the declared one into a custom migration. **`checkExtrasDrift`** is the CI gate.

```ts
// packages/database/src/extras.ts
import { compositeType, domain, extension } from "@thomasfosterau/effect-drizzle-ext-pg/tooling";

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
};
```

```ts
// packages/database/scripts/generate-extras.ts — run by the `db:generate-extras` task
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { generateExtrasMigration } from "@thomasfosterau/effect-drizzle-ext-pg/tooling";
import * as Effect from "effect/Effect";
import { extras } from "../src/extras.ts";

generateExtrasMigration({
  extras,
  migrationsDir: "migrations",
  name: process.argv[2] ?? "extras",
  drizzleKit: { config: "drizzle.config.ts" }, // or { schema: "src/schema.ts" }
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
```

How it works:

- **The state.** Each migration it writes carries an `extras.json` beside `migration.sql` and `snapshot.json`, holding the whole declared state after that migration. The recorded state is the one in the latest-by-name directory that has the file. drizzle-kit (`check`, `generate`), `./migrations` and `checkMigrationDrift` all ignore the file.
- **The directory is drizzle-kit's.** The generator runs `drizzle-kit generate --custom --name <slug> --output json` (`command` overrides how drizzle-kit is started; the default is `drizzle-kit` on `PATH`, which a package script has), so the folder name, its order and the snapshot's `prevIds` stay drizzle-kit's. It then replaces the placeholder `migration.sql`, with `--> statement-breakpoint` between statements. With nothing to migrate it writes nothing and returns `Option.none()`.
- **Order.** Creates and alters come first: extensions, then domains, then composite types, each in declaration order. Drops follow in the reverse order. An extension or type must exist before the drizzle-kit migration whose table first uses it, so run the generator **before** `drizzle-kit generate`.
- **Alters.** An extension's schema (`SET SCHEMA`) and pinned version (`UPDATE TO`); a domain's default, `NOT NULL` and named checks; a composite type's attributes (`ADD` / `DROP` / `ALTER ATTRIBUTE … TYPE`). A domain's base type can't be altered, so changing it is an `ExtrasError` naming the domain. Renames read as a drop plus a create (rename hints are effect-drizzle-ext#218).
- **The gate.** `checkExtrasDrift({ extras, migrationsDir })` fails with `ExtrasDriftError { recordedIn, statements }` when a declaration changed without a migration. It needs no database and no drizzle-kit.

Type names, defaults and check expressions are SQL, emitted as written. Identifiers are quoted, and an extension version is a string literal.
