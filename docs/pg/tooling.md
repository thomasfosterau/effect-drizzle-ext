# `./tooling`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

Two schema guards for a drizzle-kit `migrations/` directory. Neither needs a database. Both are **bin-less** Effects: an application's own `db:migration-drift` / `db:view-dependencies` task runs them with its schema module and reports the typed error. They are ported from the applications' `packages/database/scripts/check-*.ts` (website #1200, #1471, #1228). `drizzle-kit` is an optional peer that only this subpath imports, through `drizzle-kit/api-postgres`.

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
