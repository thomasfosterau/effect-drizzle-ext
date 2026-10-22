/**
 * @copyright Thomas Foster
 *
 * **The migration-drift gate**: fails when a committed Drizzle schema and its
 * committed drizzle-kit `migrations/` snapshots disagree, without a database
 * or a deployed stage. Ported from the applications'
 * `packages/database/scripts/check-migration-drift.ts` (website #1200,
 * #1471; preferenceflow's copy is the reference), as a bin-less Effect an
 * application's `db:migration-drift` task runs with its own schema module.
 *
 * Three checks, each guarding "snapshot history is a DAG, not a chain" from a
 * different side:
 *
 * 1. **DAG integrity.** drizzle-kit 1.0's snapshots chain via `prevIds`
 *    (plural — a migration generated after two branches merge names both
 *    tips), so history is a DAG. Divergence is normal while unmerged; it is
 *    broken when two branches both land without a later migration's
 *    `prevIds` reconverging them. Every snapshot id must be unique, every
 *    `prevIds` entry must resolve, and the lineage must have exactly one head
 *    from which everything is reachable, with no cycle.
 * 2. **Zero drift.** The exact drizzle-kit calls a deploy-time regeneration
 *    makes (`generateDrizzleJson` / `generateMigration` from
 *    `drizzle-kit/api-postgres`) against the schema module and the
 *    **lexicographically-latest** migration directory's snapshot — the same
 *    "latest by directory name" selection alchemy's
 *    `Drizzle.Schema.regenerate` uses, NOT a DAG-aware pick — must produce
 *    zero statements. A diff drizzle-kit can only resolve interactively
 *    (rename-or-recreate) is drift too.
 * 3. **Base ancestry (pull requests only).** A migration must be generated on
 *    a checkout whose snapshot chain descends from the base branch's CURRENT
 *    head; checks 1–2 are internal to the checkout, so a branch forked from
 *    week-old `main` passes both while carrying a migration whose regenerated
 *    constraints silently omit everything the base added since. Runs only
 *    when a base is supplied ({@link resolveBaseRef} reads one from
 *    `MIGRATION_BASE_REF` / `GITHUB_BASE_REF`), and only when the branch adds
 *    migration directories.
 *
 * Zero drift runs only on a structurally sound DAG (and a base-descended
 * one): with two heads the latest-by-name snapshot is an arbitrary pick of
 * one fork, so its diff would be noise next to the real report.
 *
 * @module tooling/migration-drift
 */

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

/**
 * drizzle-kit's sentinel for "no real parent" (its `originUUID`): the genesis
 * migration's `prevIds` names this instead of being empty.
 */
export const ROOT_SENTINEL_ID = "00000000-0000-0000-0000-000000000000";

/** The full snapshot shape drizzle-kit's API works with. */
type PostgresSnapshot = Awaited<ReturnType<typeof generateDrizzleJson>>;

/** The identity every snapshot must carry for the DAG checks. */
export interface Snapshot {
  readonly id: string;
  readonly prevIds: ReadonlyArray<string>;
}

/** One migration directory and its snapshot's identity. */
export interface SnapshotEntry {
  readonly dir: string;
  readonly snapshot: Snapshot;
}

const SnapshotIdentity = Schema.Struct({
  id: Schema.String,
  prevIds: Schema.optionalKey(Schema.Array(Schema.String)),
});

/**
 * The members of drizzle-kit's `PostgresSnapshot` the zero-drift diff relies
 * on beyond the identity: checked, not decoded — the snapshot is handed to
 * `generateMigration` unchanged.
 */
const PostgresSnapshotContract = Schema.Struct({
  version: Schema.Literal("8"),
  dialect: Schema.Literal("postgres"),
  ddl: Schema.Array(Schema.Unknown),
});

const isPostgresSnapshot = (raw: unknown): raw is PostgresSnapshot =>
  Schema.is(PostgresSnapshotContract)(raw);

/** A snapshot.json could not be read as a drizzle-kit snapshot. */
export class MalformedSnapshot extends Schema.TaggedError<MalformedSnapshot>()(
  "MalformedSnapshot",
  { file: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.file} is not a drizzle-kit snapshot (malformed JSON, or no string \`id\` / string[] \`prevIds\`) — never hand-edit migrations/.`;
  }
}

/**
 * drizzle-kit itself failed while generating or diffing a snapshot — broken
 * input (a schema module drizzle-kit cannot read) rather than drift.
 */
export class SchemaDiffError extends Schema.TaggedError<SchemaDiffError>()("SchemaDiffError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "drizzle-kit failed to generate or diff the schema snapshot";
  }
}

/** Run one drizzle-kit API call, its rejection a {@link SchemaDiffError}. */
export const drizzleKit = <A>(run: () => Promise<A>): Effect.Effect<A, SchemaDiffError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new SchemaDiffError({ cause }) });

/** The gate found problems; `issues` holds one human-readable report per violation. */
export class MigrationDriftError extends Schema.TaggedError<MigrationDriftError>()(
  "MigrationDriftError",
  { issues: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Migration snapshot drift check failed (${this.issues.length} issue(s)):\n\n${this.issues.join("\n\n")}`;
  }
}

// ── 1. DAG integrity (pure) ─────────────────────────────────────────────

/** Snapshots not named in any other snapshot's `prevIds` — the DAG's tips. */
export const findHeads = (entries: ReadonlyArray<SnapshotEntry>): ReadonlyArray<SnapshotEntry> => {
  const referenced = HashSet.fromIterable(entries.flatMap((entry) => entry.snapshot.prevIds));
  return entries.filter((entry) => !HashSet.has(referenced, entry.snapshot.id));
};

const findDuplicateIds = (entries: ReadonlyArray<SnapshotEntry>): ReadonlyArray<SnapshotEntry> =>
  entries.filter(
    (entry, index) =>
      entries.findIndex((other) => other.snapshot.id === entry.snapshot.id) !== index,
  );

const findDanglingParents = (
  entries: ReadonlyArray<SnapshotEntry>,
): ReadonlyArray<{ readonly dir: string; readonly prevId: string }> => {
  const ids = HashSet.fromIterable(entries.map((entry) => entry.snapshot.id));
  return entries.flatMap((entry) =>
    entry.snapshot.prevIds
      .filter((prevId) => prevId !== ROOT_SENTINEL_ID && !HashSet.has(ids, prevId))
      .map((prevId) => ({ dir: entry.dir, prevId })),
  );
};

/** What {@link traverse} found: every id reached, and the first cycle (as directory labels). */
interface Traversal {
  readonly reachable: ReadonlySet<string>;
  readonly cycle: Option.Option<ReadonlyArray<string>>;
}

/**
 * DFS from `starts` backward through `prevIds`, three-state (visiting /
 * done) so a back-edge (a cycle) is told apart from ordinary convergence.
 * Returns everything reached and the first cycle found, as directory labels.
 */
const traverse = (
  starts: ReadonlyArray<SnapshotEntry>,
  entries: ReadonlyArray<SnapshotEntry>,
): Traversal => {
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- an id → entry index built once for the walk; never escapes
  const byId = new Map(entries.map((entry) => [entry.snapshot.id, entry]));
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- the DFS colouring, shared across successive starts so a node left `done` stays done
  const state = new Map<string, "visiting" | "done">();
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- accumulated across the walk and returned partially filled when a cycle stops it
  const reachable = new Set<string>();
  const label = (id: string): string => byId.get(id)?.dir ?? id;

  const visit = (id: string, path: ReadonlyArray<string>): Option.Option<ReadonlyArray<string>> => {
    if (state.get(id) === "visiting") return Option.some([...path, label(id)]);
    if (state.get(id) === "done") return Option.none();
    state.set(id, "visiting");
    reachable.add(id);
    const next = [...path, label(id)];
    // oxlint-disable-next-line effect/imperative-loops -- stops the whole recursive walk at the first cycle, leaving this node `visiting`; a fold can neither short-circuit nor leave that state behind
    for (const prevId of byId.get(id)?.snapshot.prevIds ?? []) {
      const cycle = visit(prevId, next);
      if (Option.isSome(cycle)) return cycle;
    }
    state.set(id, "done");
    return Option.none();
  };

  // oxlint-disable-next-line effect/imperative-loops -- as above: stop at the first start whose walk finds a cycle
  for (const start of starts) {
    const cycle = visit(start.snapshot.id, []);
    if (Option.isSome(cycle)) return { reachable, cycle };
  }
  return { reachable, cycle: Option.none() };
};

/**
 * Every snapshot id is unique, every `prevIds` reference resolves (or is
 * {@link ROOT_SENTINEL_ID}), the lineage has exactly one head and no cycle,
 * and every snapshot is reachable from that head. One human-readable report
 * per violation; empty when clean.
 */
export const checkDagIntegrity = (entries: ReadonlyArray<SnapshotEntry>): ReadonlyArray<string> => {
  const issues: Array<string> = [];

  const duplicates = findDuplicateIds(entries);
  if (Arr.isReadonlyArrayNonEmpty(duplicates)) {
    issues.push(
      `${duplicates.length} migration snapshot(s) share an \`id\` with an earlier snapshot — every ` +
        `snapshot must have a unique id: ${duplicates.map((d) => d.dir).join(", ")}.\n` +
        "`drizzle-kit generate` never produces this; check for a copied or hand-edited snapshot.json.",
    );
  }

  const dangling = findDanglingParents(entries);
  if (Arr.isReadonlyArrayNonEmpty(dangling)) {
    issues.push(
      `${dangling.length} \`prevIds\` entry(ies) name a parent snapshot id that no committed ` +
        `snapshot has: ${dangling.map((d) => `${d.dir} -> ${d.prevId}`).join(", ")}.\n` +
        "The migrations directory may be missing a file, or a snapshot.json was hand-edited.",
    );
  }

  const heads = findHeads(entries);
  if (heads.length !== 1) {
    issues.push(
      `Expected exactly 1 head in the migration snapshot DAG, found ${heads.length}` +
        (Arr.isReadonlyArrayNonEmpty(heads) ? `: ${heads.map((h) => h.dir).join(", ")}` : "") +
        ".\n" +
        (Arr.isReadonlyArrayNonEmpty(heads)
          ? "Two or more migrations were generated from the same parent snapshot and both merged " +
            "without a later migration's `prevIds` reconverging them (a snapshot-chain fork). " +
            "Fix: rebase and regenerate, so the new migration's `prevIds` lists every outstanding head."
          : "Every snapshot is named as some other snapshot's parent: the lineage has no real root " +
            "(see any reported cycle)."),
    );
  }

  const { reachable } = traverse(heads, entries);
  // From every entry, not just the heads, so a cycle isolated in its own
  // component (whose nodes all reference each other, so none is a head) still
  // gets its own report instead of folding into the orphan one.
  const { cycle } = traverse(entries, entries);
  if (Option.isSome(cycle)) {
    issues.push(
      `The migration snapshot DAG contains a cycle in its \`prevIds\` lineage: ${cycle.value.join(" -> ")}.\n` +
        "History can never legitimately cycle back to an ancestor — this means corrupted or " +
        "hand-edited snapshot.json files.",
    );
  }

  const orphaned = entries.filter((entry) => !reachable.has(entry.snapshot.id));
  if (Arr.isReadonlyArrayNonEmpty(orphaned)) {
    issues.push(
      `${orphaned.length} migration snapshot(s) are not reachable from the DAG head(s) via ` +
        `\`prevIds\`: ${orphaned.map((o) => o.dir).join(", ")}.\n` +
        "A deploy that regenerates against the lexicographically-latest snapshot would silently " +
        "drop these branches' schema changes.",
    );
  }

  return issues;
};

// ── 3. Base ancestry (pure) ─────────────────────────────────────────────

/** The base branch's migration state: its directory names and its latest-by-name snapshot. */
export interface BaseMigrations {
  readonly ref: string;
  readonly dirs: ReadonlyArray<string>;
  readonly head: Option.Option<SnapshotEntry>;
}

/**
 * Every migration this branch ADDS must descend from the base's current
 * head. Presence of the base head's snapshot id in this checkout's entries is
 * sufficient: {@link checkDagIntegrity} separately proves the local DAG has a
 * single head from which everything is reachable, so containing the base head
 * means the new tail grew on top of it. A branch that adds no migration
 * directory passes.
 */
export const checkBaseAncestry = (
  entries: ReadonlyArray<SnapshotEntry>,
  base: BaseMigrations,
): ReadonlyArray<string> => {
  const baseDirs = HashSet.fromIterable(base.dirs);
  const added = entries.filter((entry) => !HashSet.has(baseDirs, entry.dir));
  if (Arr.isReadonlyArrayEmpty(added) || Option.isNone(base.head)) return [];
  const head = base.head.value;
  if (entries.some((entry) => entry.snapshot.id === head.snapshot.id)) return [];
  return [
    `New migration(s) ${added.map((entry) => entry.dir).join(", ")} were generated on a checkout ` +
      `that predates ${base.ref}'s current migration head (${head.dir}, snapshot id ` +
      `${head.snapshot.id}) — the base head is not an ancestor of this branch's snapshot chain, so ` +
      "the generated DDL was computed from a stale schema (a regenerated CHECK constraint silently " +
      `reverting members the base added since the fork). Fix: rebase onto ${base.ref}, delete the ` +
      "stale migration directory, and regenerate it.",
  ];
};

/** The environment {@link resolveBaseRef} reads — the shape of `process.env`. */
export interface BaseRefEnvironment {
  // oxlint-disable-next-line effect/prefer-option-over-null -- `process.env`'s shape (unset variables are missing keys), passed straight in
  readonly [name: string]: string | undefined;
}

/**
 * The base ref for the ancestry check, when one is knowable: an explicit
 * `MIGRATION_BASE_REF` wins (local use: `MIGRATION_BASE_REF=origin/main`),
 * else `origin/$GITHUB_BASE_REF` — which GitHub Actions sets only on
 * `pull_request` events, so pushes and local runs skip the check.
 */
export const resolveBaseRef = (env: BaseRefEnvironment): Option.Option<string> => {
  const explicit = env.MIGRATION_BASE_REF ?? "";
  if (explicit !== "") return Option.some(explicit);
  const base = env.GITHUB_BASE_REF ?? "";
  return base === "" ? Option.none() : Option.some(`origin/${base}`);
};

// ── Reading ─────────────────────────────────────────────────────────────

/** A migration directory name: drizzle-kit's all-digit prefix and a slug. */
const MIGRATION_DIR = /^\d+_/;

/**
 * A parsed `snapshot.json`, checked (not decoded) against
 * {@link SnapshotIdentity}: the value is the whole parsed document, every
 * member drizzle-kit reads included, so it can be handed on unchanged.
 */
type ParsedSnapshot = typeof SnapshotIdentity.Type;

const parseSnapshot = (
  file: string,
  text: string,
): Effect.Effect<ParsedSnapshot, MalformedSnapshot> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.filterOrFail(Schema.is(SnapshotIdentity), (raw) => raw),
    Effect.mapError((cause) => new MalformedSnapshot({ file, cause })),
  );

/** A parsed snapshot and its identity; `raw` is handed to drizzle-kit unchanged. */
interface ReadSnapshot extends SnapshotEntry {
  readonly raw: unknown;
}

const toEntry = (dir: string, raw: ParsedSnapshot): ReadSnapshot => ({
  dir,
  raw,
  snapshot: { id: raw.id, prevIds: raw.prevIds ?? [] },
});

/**
 * Every migration directory under `migrationsDir` (sorted by name) and the
 * snapshot of each that has one. A directory without a snapshot (a
 * hand-written bootstrap) is listed but carries no entry — exactly like
 * alchemy's `readLatestSnapshot`.
 */
const readLocal = (
  migrationsDir: string,
): Effect.Effect<
  { readonly dirs: ReadonlyArray<string>; readonly entries: ReadonlyArray<ReadSnapshot> },
  MalformedSnapshot | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = Arr.sort(
      (yield* fs.readDirectory(migrationsDir)).filter((name) => MIGRATION_DIR.test(name)),
      Order.String,
    );
    const dirs = yield* Effect.filter(names, (name) =>
      Effect.map(fs.stat(path.join(migrationsDir, name)), (info) => info.type === "Directory"),
    );
    const entries = yield* Effect.forEach(
      dirs,
      (dir) =>
        Effect.gen(function* () {
          const file = path.join(migrationsDir, dir, "snapshot.json");
          if (!(yield* fs.exists(file))) return [];
          const raw = yield* parseSnapshot(file, yield* fs.readFileString(file));
          return [toEntry(dir, raw)];
        }),
      { concurrency: 1 },
    );
    return { dirs, entries: entries.flat() };
  });

/** Where the base branch's migrations are read from, through `git`. */
export interface GitBase {
  /** The base ref, e.g. `origin/main` — from {@link resolveBaseRef}. */
  readonly ref: string;
  /** The migrations directory relative to the repository root, e.g. `packages/database/migrations`. */
  readonly migrationsPath: string;
  /** The repository checkout to run `git` in. */
  readonly cwd: string;
}

const git = (
  base: GitBase,
  args: ReadonlyArray<string>,
): Effect.Effect<string, PlatformError, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return yield* spawner.string(ChildProcess.make("git", [...args], { cwd: base.cwd }));
  });

/**
 * The latest-by-name base directory carrying a readable snapshot — the same
 * selection the zero-drift check makes locally. A directory without one (a
 * hand-written bootstrap) is passed over.
 */
const findBaseHead = (
  base: GitBase,
  dirs: ReadonlyArray<string>,
): Effect.Effect<Option.Option<SnapshotEntry>, never, ChildProcessSpawner> =>
  // Newest first, stopping at the first readable snapshot: one `git show` per
  // directory until then, not one per directory.
  Effect.findFirstFilter(dirs.toReversed(), (dir) =>
    Effect.result(
      Effect.flatMap(
        git(base, ["show", `${base.ref}:${base.migrationsPath}/${dir}/snapshot.json`]),
        (text) => Effect.map(parseSnapshot(dir, text), (raw): SnapshotEntry => toEntry(dir, raw)),
      ),
    ),
  );

/**
 * The base branch's migration state, read with `git ls-tree` / `git show` so
 * it reflects the base's CURRENT tip. Fetches the base first when the
 * checkout lacks it (a shallow pull-request checkout does).
 */
export const readBaseMigrations = (
  base: GitBase,
): Effect.Effect<BaseMigrations, PlatformError, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const present = yield* spawner.exitCode(
      ChildProcess.make("git", ["rev-parse", "--verify", "--quiet", `${base.ref}^{commit}`], {
        cwd: base.cwd,
      }),
    );
    if (present !== 0) {
      yield* git(base, ["fetch", "--depth=1", "origin", base.ref.replace(/^origin\//, "")]);
    }
    const listing = yield* git(base, [
      "ls-tree",
      "--name-only",
      base.ref,
      `${base.migrationsPath}/`,
    ]);
    const dirs = Arr.sort(
      listing
        .split("\n")
        .map((line) => line.trim().split("/").at(-1) ?? "")
        .filter((name) => MIGRATION_DIR.test(name)),
      Order.String,
    );
    return { ref: base.ref, dirs, head: yield* findBaseHead(base, dirs) };
  });

// ── 2. Zero drift ───────────────────────────────────────────────────────

/**
 * drizzle-kit's resolvers throw `… was called without a HintsHandler` when
 * the diff holds a created+deleted pair it would interactively ask about
 * (rename or recreate). That is proof of a non-empty diff, reported as drift;
 * every other failure is broken input and stays a defect.
 */
const isAmbiguousDiff = (cause: unknown): boolean =>
  Predicate.isError(cause) && cause.message.includes("was called without a HintsHandler");

const checkZeroDrift = (
  schema: MigrationDriftOptions["schema"],
  latest: Option.Option<ReadSnapshot>,
  label: string,
): Effect.Effect<ReadonlyArray<string>, SchemaDiffError> =>
  Effect.gen(function* () {
    const where = Option.match(latest, {
      onNone: () => `${label} (no snapshot yet)`,
      onSome: (entry) => `${label}/${entry.dir}/snapshot.json`,
    });
    if (Option.isSome(latest) && !isPostgresSnapshot(latest.value.raw)) {
      return [
        `${where} doesn't match the drizzle-kit snapshot contract \`generateMigration\` expects ` +
          '(`version: "8"`, `dialect: "postgres"`, a `ddl` array): a stale (pre-v8) or hand-edited snapshot.',
      ];
    }
    const cur = yield* drizzleKit(() =>
      generateDrizzleJson(
        schema,
        Option.getOrUndefined(Option.map(latest, (entry) => entry.snapshot.id)),
      ),
    );
    const prev = yield* Option.match(latest, {
      onNone: () => drizzleKit(() => generateDrizzleJson({})),
      // SAFETY: `isPostgresSnapshot` held for this value above.
      onSome: (entry) => Effect.succeed(entry.raw as PostgresSnapshot),
    });
    return yield* drizzleKit(() => generateMigration(prev, cur)).pipe(
      Effect.map((statements) =>
        Arr.isReadonlyArrayNonEmpty(statements)
          ? [
              `Schema drift detected against the latest committed migration snapshot (${where}): ` +
                `${statements.length} statement(s) would be generated:\n\n` +
                statements.map((statement) => `  ${statement}`).join("\n") +
                "\n\nFix: generate a migration (`drizzle-kit generate --name <slug>`) and commit it with its snapshot.",
            ]
          : [],
      ),
      Effect.catchTag("SchemaDiffError", ({ cause }) =>
        isAmbiguousDiff(cause)
          ? Effect.succeed([
              `Schema drift detected against the latest committed migration snapshot (${where}), and ` +
                "the diff is ambiguous: drizzle-kit found a created+deleted pair it would interactively " +
                "ask to resolve as rename-or-recreate. An ambiguous diff is still a non-empty diff.\n" +
                "Fix: generate a migration (`drizzle-kit generate --name <slug>`) and commit it with its snapshot.",
            ])
          : Effect.fail(new SchemaDiffError({ cause })),
      ),
    );
  });

// ── The gate ────────────────────────────────────────────────────────────

/** The inputs {@link checkMigrationDrift} takes. */
export interface MigrationDriftOptions {
  /** The schema module (`import * as schema from "./schema.ts"`), as drizzle-kit's `generateDrizzleJson` takes it. */
  // oxlint-disable-next-line effect/no-unsafe-dictionary-type -- drizzle-kit's boundary: `generateDrizzleJson(imports: Record<string, unknown>)` takes a module namespace of arbitrary exports, which it sorts itself; this is that parameter, forwarded unchanged
  readonly schema: Record<string, unknown>;
  /** The committed drizzle-kit migrations directory. */
  readonly migrationsDir: string;
  /**
   * The base branch to check ancestry against — `Option.none()` (or absent,
   * or `undefined`) on pushes and local runs, which is what mapping
   * {@link resolveBaseRef} gives outside a pull request.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the `?: T | undefined` spelling (AGENTS.md → Conventions) lets a caller under `exactOptionalPropertyTypes` forward its own optional; read through `??`, so `undefined` means absent
  readonly base?: Option.Option<GitBase> | undefined;
}

/** What a passing run checked. */
export interface MigrationDriftReport {
  readonly snapshots: number;
  readonly baseRef: Option.Option<string>;
}

/**
 * Run the three checks. Succeeds with a {@link MigrationDriftReport};
 * fails with a {@link MigrationDriftError} carrying every issue found.
 *
 * @example
 * ```ts
 * // packages/database/scripts/check-migration-drift.ts
 * import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
 * import * as NodeServices from "@effect/platform-node/NodeServices";
 * import * as schema from "../src/schema.ts";
 *
 * const repoRoot = path.resolve(import.meta.dirname, "../../..");
 * const base = Option.map(resolveBaseRef(process.env), (ref) => ({
 *   ref,
 *   migrationsPath: "packages/database/migrations",
 *   cwd: repoRoot,
 * }));
 * checkMigrationDrift({
 *   schema,
 *   migrationsDir: path.join(repoRoot, "packages/database/migrations"),
 *   base,
 * }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
 * ```
 */
export const checkMigrationDrift = (
  options: MigrationDriftOptions,
): Effect.Effect<
  MigrationDriftReport,
  MigrationDriftError | MalformedSnapshot | SchemaDiffError | PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const { dirs, entries } = yield* readLocal(options.migrationsDir);
    const base = yield* Effect.transposeOption(
      Option.map(options.base ?? Option.none(), readBaseMigrations),
    );
    const structural = [
      ...checkDagIntegrity(entries),
      ...Option.match(base, { onNone: () => [], onSome: (b) => checkBaseAncestry(entries, b) }),
    ];
    const latest = Arr.findFirst(entries.toReversed(), (entry) => dirs.includes(entry.dir));
    const issues = Arr.isReadonlyArrayNonEmpty(structural)
      ? structural
      : yield* checkZeroDrift(options.schema, latest, options.migrationsDir);
    if (Arr.isReadonlyArrayNonEmpty(issues)) return yield* new MigrationDriftError({ issues });
    return { snapshots: entries.length, baseRef: Option.map(base, (b) => b.ref) };
  });
