/**
 * A consumer's view of both packages: every subpath imported through its
 * EMITTED declarations (`paths` in tsconfig.json points the package names at
 * `dist/*.d.ts`, and `skipLibCheck` is off). Each block exercises the types a
 * real consumer depends on, so a declaration that degrades to `any` — the
 * hazard `versioned-chain.ts` documents — fails here rather than in an
 * application. Never executed; type-checked only.
 */

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { SqlError } from "effect/sql/SqlError";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import { sql, type SQL } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { boolean, integer, pgSchema, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  type DbColumnOf,
  dbColumn,
  dbColumnFor,
  dbTableFor,
  fieldColumns,
  readDbColumn,
  readDbTable,
  defineTree,
} from "@thomasfosterau/effect-drizzle-ext";
import {
  DerivationError,
  deriveFieldCheckConstraints,
  makeDeriveColumns,
} from "@thomasfosterau/effect-drizzle-ext/derive";
import { makeReferenceRegistry } from "@thomasfosterau/effect-drizzle-ext/references";
import {
  enumCheck,
  makeDiscriminatorConstraints,
} from "@thomasfosterau/effect-drizzle-ext/constraints";
import {
  bytea,
  byteaToHex,
  hexToBytea,
  jsonbSchema,
  timestamps,
  tsvector,
} from "@thomasfosterau/effect-drizzle-ext/columns";
import {
  boundedPagination,
  combineFilters,
  executeRows,
  pageOf,
  totalCountColumn,
} from "@thomasfosterau/effect-drizzle-ext/query";
import {
  type ClassifiedError,
  catchUniqueViolation,
  classifyError,
  findPgError,
  UniqueViolation,
} from "@thomasfosterau/effect-drizzle-ext/errors";
import { makeDatabaseServices } from "@thomasfosterau/effect-drizzle-ext/database";
import {
  chronologicalOrder,
  type OrderTerm,
  resolveSortOrder,
  type SortableColumns,
  sortableColumnsFor,
  UnsupportedSortError,
} from "@thomasfosterau/effect-drizzle-ext/sort";
import { insertValues, updateSetMap } from "@thomasfosterau/effect-drizzle-ext/update";
import {
  makeCurrentVersionView,
  makeSubtypeTables,
  makeTreeTables,
  makeTreeViews,
  type VersionChainEntry,
  type VersionSnapshot,
  versionTimestamps,
} from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import {
  resourceAttributeProjections,
  resourceColumns,
  dbTable,
} from "@thomasfosterau/effect-drizzle-ext/jsonapi";
import { makeDeriveResourceColumns } from "@thomasfosterau/effect-drizzle-ext/jsonapi/derive";
import * as Pg from "@thomasfosterau/effect-drizzle-ext-pg";
import * as PgChain from "@thomasfosterau/effect-drizzle-ext-pg/chain";
import * as PgMigrations from "@thomasfosterau/effect-drizzle-ext-pg/migrations";
import * as PgTesting from "@thomasfosterau/effect-drizzle-ext-pg/testing";
import * as PgTooling from "@thomasfosterau/effect-drizzle-ext-pg/tooling";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type { SqlClient } from "effect/sql/SqlClient";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

/** A compile-time assertion: `T` must be exactly `true`. */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

// ── annotation entry ──────────────────────────────────────────────────────

type PgKind = "text" | "integer" | "boolean" | "timestamp" | "uuid";
const column = dbColumnFor<PgKind>();
const table = dbTableFor<"work" | "agent">();

const fields = {
  title: column(Schema.String, { column: "title", pg: "text", notNull: true }),
  pages: column(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)), {
    column: "pages",
    pg: "integer",
    notNull: false,
  }),
  note: Schema.String,
} as const;

type TitleMeta = DbColumnOf<typeof fields.title>;

export const metas = fieldColumns(fields);
export const titleMeta: Option.Option<{ readonly column: string }> = readDbColumn(fields.title);
export const looseColumn = dbColumn(Schema.Boolean, {
  column: "flag",
  pg: "anything",
  notNull: true,
});

// ── derive ────────────────────────────────────────────────────────────────

const builders = {
  text: (name: string) => text(name),
  integer: (name: string) => integer(name),
  boolean: (name: string) => boolean(name),
  timestamp: (name: string) => timestamp(name, { withTimezone: true }),
  uuid: (name: string) => uuid(name),
};
const references = makeReferenceRegistry();
const derive = makeDeriveColumns(builders, { resolveReference: references.resolve });

export const book = pgTable(
  "book",
  { id: uuid("id").primaryKey(), ...derive.fromFields(fields), ...timestamps() },
  (t) => deriveFieldCheckConstraints(fields, "book")(t),
);
references.register(book);

type BookRow = typeof book.$inferSelect;

// ── constraints ───────────────────────────────────────────────────────────

const discriminator = makeDiscriminatorConstraints<"work" | "agent">({
  leaves: (level) => (level === "work" ? ["books", "films"] : []),
});
export const branch = pgTable(
  "work_branch",
  { id: uuid("id").primaryKey(), type: text("type").notNull(), kind: text("kind") },
  (t) => [
    discriminator.typeUnique("work", t),
    enumCheck("work_branch_kind_valid", t.kind, ["fiction", "non_fiction"]),
  ],
);

// ── columns ───────────────────────────────────────────────────────────────

const Payload = Schema.Struct({ a: Schema.Finite });
export const blob = pgTable("blob", {
  hash: bytea("hash").notNull(),
  search: tsvector("search"),
  payload: jsonbSchema(Payload)("payload").notNull(),
});
type BlobRow = typeof blob.$inferSelect;
export const roundTrip: Uint8Array = hexToBytea(byteaToHex(new Uint8Array([1, 2])));

// ── query ─────────────────────────────────────────────────────────────────

export const where: SQL | undefined = combineFilters(sql`1 = 1`, undefined);
// A type-level fixture: only the `Page` type `pageOf` infers from a `BookRow`
// is asserted, so the row is declared, never built.
declare const bookRow: BookRow;
export const page = pageOf([{ ...bookRow, [`__totalCount`]: 3 }], (row) => row.title);
export const total = totalCountColumn;
const pagination = boundedPagination({ maxLimit: 100, defaultLimit: 20 });
export const rows: Effect.Effect<
  ReadonlyArray<{ readonly one: number }>,
  EffectDrizzleQueryError | Schema.SchemaError
> = executeRows(
  { execute: () => Effect.succeed([{ one: 1 }]) },
  sql`select 1 as one`,
  Schema.Struct({ one: Schema.Finite }),
);

// ── errors ────────────────────────────────────────────────────────────────

/** An arbitrary failure value for the classifiers, which accept any. */
class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  message: Schema.String,
}) {}

export const classified: Option.Option<ClassifiedError> = classifyError(
  new ProbeError({ message: "x" }),
);
export const facts = findPgError(new ProbeError({ message: "x" }));
export const recovered = Effect.fail(
  new UniqueViolation({
    constraint: Option.some("book_pkey"),
    table: Option.none(),
    detail: Option.none(),
    cause: new ProbeError({ message: "dup" }),
  }),
).pipe(catchUniqueViolation((violation) => Effect.succeed(violation.constraint)));

// ── database ──────────────────────────────────────────────────────────────

interface FakeTx {
  readonly select: unknown;
  readonly selectDistinct: unknown;
  readonly selectDistinctOn: unknown;
  readonly with: unknown;
  readonly $count: unknown;
  readonly transaction: <A, E, R>(
    f: (tx: FakeTx) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}
const services = makeDatabaseServices<FakeTx, FakeTx>()({ key: "Database" });
export type Database = typeof services.Database.Identifier;
export const inTx = services.transact(Effect.as(services.readHandle, 1));

// ── versioned-chain ───────────────────────────────────────────────────────

const core = pgSchema("core");
const node = core.table("node", { id: uuid("id").primaryKey(), type: text("type").notNull() });
const nodeVersion = core.table("node_version", {
  id: uuid("id").notNull(),
  version: integer("version").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});
const defineSubtypeTables = makeSubtypeTables<undefined>(() => []);
const film = defineSubtypeTables(core, {
  name: "film",
  parentId: node.id,
  parentVersion: nodeVersion,
  columns: { title: text("title").notNull(), runtime: integer("runtime") },
});
type FilmVersionRow = typeof film.version.$inferSelect;

const currentVersionView = makeCurrentVersionView({
  rootVersion: nodeVersion,
  identity: node,
  merge: { type: node.type },
});
export const filmView = currentVersionView(core, "film_view", {
  leaf: film.version,
  columns: { id: film.version.id, title: film.version.title },
});
type FilmViewRow = typeof filmView.$inferSelect;

export const filmTimestamps = versionTimestamps({
  timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
});
type Snapshot = VersionSnapshot<"create", { readonly draft?: boolean }>;

// ── tree views ────────────────────────────────────────────────────────────

const ontologyTree = defineTree({
  work: {
    columns: { title: dbColumn(Schema.String, { column: "title", pg: "text", notNull: true }) },
  },
  novel: {
    parent: "work",
    leaf: { words: dbColumn(Schema.Finite, { column: "words", pg: "integer", notNull: false }) },
    keyed: {
      name: "locale",
      columns: { blurb: dbColumn(Schema.String, { column: "blurb", pg: "text", notNull: false }) },
    },
  },
});
const ontology = pgSchema("ontology");
const ontologyTables = makeTreeTables(ontologyTree, {
  schema: ontology,
  builders: { text: (c: string) => text(c), integer: (c: string) => integer(c) },
  root: { pointers: ["live"] },
});
export const ontologyViews = makeTreeViews(ontologyTree, ontologyTables, {
  schema: ontology,
  branches: { work: true },
  pointers: { live: ["novel"] },
});
type NovelViewRow = typeof ontologyViews.leaves.novel.$inferSelect;
type WorkViewRow = typeof ontologyViews.branches.work.$inferSelect;
type NovelLocaleRow = typeof ontologyViews.keyed.novel.$inferSelect;
type NovelLiveRow = typeof ontologyViews.pointers.live.leaves.novel.$inferSelect;
type NovelLocaleLiveRow = typeof ontologyViews.pointers.live.keyed.novel.$inferSelect;
type NovelLocaleTableRow = typeof ontologyTables.keyed.novel.$inferSelect;
type LivePointerRow = typeof ontologyTables.pointers.live.$inferSelect;
export const novelAsOf = ontologyViews.asOf("novel", { version: 0n });

// ── chain ─────────────────────────────────────────────────────────────────

const chainDatabase = Pg.makePgDatabase({ relations: {}, key: "ChainDb" });
export const chain = PgChain.makeVersionChain({
  tree: ontologyTree,
  tables: ontologyTables,
  CurrentTransaction: chainDatabase.CurrentTransaction,
});
export const novelCreated = chain.novel.create({
  state: { title: "Dune", words: 1 },
  actor: undefined,
});
export const novelUpdated = chain.novel.update({ id: "x", patch: { words: null }, actor: "a" });
export const novelSnapshot = chain.novel.getVersion("x", 0n);
type NovelState = Effect.Success<typeof novelSnapshot>["state"];

// ── sort ──────────────────────────────────────────────────────────────────

export const filmSortable: SortableColumns = sortableColumnsFor(filmView);
export const filmOrder = resolveSortOrder({
  view: filmView,
  sort: [{ field: "title", direction: "desc" }],
});
export const bookOrder = chronologicalOrder({ view: { ...book, timestamp: book.createdAt } });
export const sortRejected = Effect.fail(new UnsupportedSortError({ field: "x", allowed: [] }));

// ── update ────────────────────────────────────────────────────────────────

declare const bookUpdate: {
  readonly id: string;
  readonly title?: string;
  readonly pages?: number | null | undefined;
};
export const bookSet = updateSetMap(bookUpdate, ["title", "pages"] as const);
export const bookValues = insertValues(bookUpdate, ["title"] as const);

// ── jsonapi ───────────────────────────────────────────────────────────────

const PersonResource = dbTable(
  Resource.make("people", {
    attributes: {
      name: Resource.attribute(
        column(Schema.String, { column: "name", pg: "text", notNull: true }),
      ),
    },
  }),
  { name: "person", level: "agent" },
);
export const personColumns = resourceColumns(PersonResource);
export const personProjections = resourceAttributeProjections(PersonResource);
export const personTable = table(PersonResource, { name: "person", level: "agent" });
export const personTableMeta = readDbTable(PersonResource);
const deriveResource = makeDeriveResourceColumns(builders);
export const person = pgTable("person", {
  id: uuid("id").primaryKey(),
  ...deriveResource(PersonResource),
});

// ── pg ────────────────────────────────────────────────────────────────────

const appDatabase = Pg.makePgDatabase({ relations: {}, key: "AppDb" });
export type AppDb = typeof appDatabase.Database.Identifier;
export const appWrite = appDatabase.transact(Effect.as(appDatabase.readHandle, "written"));
export const appLayer: Layer.Layer<"AppDb", never, PgClient.PgClient> = appDatabase.layer;
export const pooled: Layer.Layer<PgClient.PgClient, SqlError> = Pg.pgClientFromPool({
  connectionString: Redacted.make("postgresql://postgres@127.0.0.1:5432/app"),
});
export const pinged: Layer.Layer<PgClient.PgClient, SqlError> = Pg.pgClientFromUrl({
  url: Redacted.make("postgresql://postgres@127.0.0.1:5432/app"),
  maxConnections: 1,
});
const testTransaction = PgTesting.makeTestTransaction(appDatabase);
export const savepointed = testTransaction.attemptInSavepoint(Effect.succeed(1));
export const retryable: boolean = PgTesting.isRetryableConnectFailure(
  new ProbeError({ message: "x" }),
);
export const testLayer: Layer.Layer<"AppDb", SqlError> = PgTesting.testDatabaseLayer(appDatabase, {
  url: Redacted.make("postgresql://postgres@127.0.0.1:5432/test"),
});

// ── pg: migrations, provisioning, tooling ─────────────────────────────────

export const migrated = PgMigrations.applyMigrations("/app/migrations");
export const migrations = PgMigrations.readMigrations("/app/migrations");
export const provisioned = PgTesting.provisionTestDatabase({
  env: {},
  migrationsDir: "/app/migrations",
  dbNamePrefix: "app",
  image: "postgres:17",
});
export const source = PgTesting.resolveDatabaseSource({
  env: {},
  migrationsDir: "/app/migrations",
  dbNamePrefix: "app",
  image: "postgres:17",
});
export const drift = PgTooling.checkMigrationDrift({
  schema: {},
  migrationsDir: "/app/migrations",
});

/**
 * A caller forwarding its own optional into Drizzle-facing config under
 * `exactOptionalPropertyTypes`: compiles only while that member is spelled
 * `?: T | undefined` (effect-drizzle-ext#29, #57). Options bags the library
 * reads itself take a bare `?: T` (effect-drizzle-ext#105), so a caller omits
 * an absent member there instead.
 */
export const forwardOptionals = (forwarded: { readonly versionDefault?: bigint }) =>
  defineSubtypeTables(core, {
    name: "short",
    parentId: node.id,
    parentVersion: nodeVersion,
    columns: {},
    versionDefault: forwarded.versionDefault,
  });

export const views = PgTooling.checkViewDependencies({ schema: {} });
export const dagIssues: ReadonlyArray<string> = PgTooling.checkDagIntegrity([]);

/**
 * Every compile-time assertion, exported so `noUnusedLocals` keeps them and a
 * failing one names itself in the error.
 */
export type Checks = [
  /** _titleMetaIsPrecise */ Assert<Equals<TitleMeta["pg"], "text">>,
  /** _titleNotNull */ Assert<Equals<TitleMeta["notNull"], true>>,
  /** _bookTitleIsString */ Assert<Equals<BookRow["title"], string>>,
  /** _bookPagesIsNullable */ Assert<Equals<BookRow["pages"], number | null>>,
  /** _bookCreatedAt */ Assert<Equals<BookRow["createdAt"], Date>>,
  /** _derivationErrorIsTagged */ Assert<Equals<DerivationError["_tag"], "DerivationError">>,
  /** _hashIsBytes */ Assert<Equals<BlobRow["hash"], Uint8Array>>,
  /** _payloadIsDecoded */ Assert<Equals<BlobRow["payload"], { readonly a: number }>>,
  /** _pageItems */ Assert<Equals<(typeof page)["items"], readonly string[]>>,
  /** _limitIsNumber */ Assert<Equals<(typeof pagination.Limit)["Type"], number>>,
  /** _recoveredSucceeds */ Assert<Equals<Effect.Success<typeof recovered>, Option.Option<string>>>,
  /** _databaseKey */ Assert<Equals<Database, "Database">>,
  /** _txKey */ Assert<
    Equals<typeof services.CurrentTransaction.Identifier, "Database/CurrentTransaction">
  >,
  /** _transactRequiresDatabase */ Assert<Equals<Effect.Services<typeof inTx>, "Database">>,
  /** _filmId */ Assert<Equals<FilmVersionRow["id"], string>>,
  /** _filmVersion */ Assert<Equals<FilmVersionRow["version"], bigint>>,
  /** _filmTitle */ Assert<Equals<FilmVersionRow["title"], string>>,
  /** _filmRuntime */ Assert<Equals<FilmVersionRow["runtime"], number | null>>,
  /** _viewId */ Assert<Equals<FilmViewRow["id"], string>>,
  /** _viewType */ Assert<Equals<FilmViewRow["type"], string>>,
  /** _novelViewId */ Assert<Equals<NovelViewRow["id"], string>>,
  /** _novelViewVersion */ Assert<Equals<NovelViewRow["version"], bigint>>,
  /** _novelViewTitle */ Assert<Equals<NovelViewRow["title"], string>>,
  /** _novelViewCreatedAt */ Assert<Equals<NovelViewRow["createdAt"], Date>>,
  /** _workViewType */ Assert<Equals<WorkViewRow["type"], string>>,
  /** _workViewTitle */ Assert<Equals<WorkViewRow["title"], string>>,
  /** _novelLocale */ Assert<Equals<NovelLocaleRow["locale"], string | null>>,
  /** _novelLocaleBlurb */ Assert<Equals<NovelLocaleRow["blurb"], string | null>>,
  /** _novelLiveAt */ Assert<Equals<NovelLiveRow["liveAt"], Date>>,
  /** _novelLiveVersion */ Assert<Equals<NovelLiveRow["version"], bigint>>,
  /** _novelLocaleLiveAt */ Assert<Equals<NovelLocaleLiveRow["liveAt"], Date>>,
  /** _keyedTableLocale */ Assert<Equals<NovelLocaleTableRow["locale"], string>>,
  /** _pointerVersion */ Assert<Equals<LivePointerRow["version"], bigint | null>>,
  /** _chainStateTitle */ Assert<Equals<NovelState["title"], string>>,
  /** _chainStateWords */ Assert<Equals<NovelState["words"], number | null>>,
  /** _chainCreateRequiresTx */ Assert<
    Equals<Effect.Services<typeof novelCreated>, "ChainDb/CurrentTransaction">
  >,
  /** _chainUpdateErrors */ Assert<
    Equals<
      Exclude<
        Effect.Error<typeof novelUpdated>,
        { readonly _tag: "EffectDrizzleQueryError" }
      >["_tag"],
      "NodeNotFound" | "StaleVersion" | "VersionConflict"
    >
  >,
  /** _novelAsOfAlias */ Assert<Equals<(typeof novelAsOf)["_"]["alias"], "novel_as_of">>,
  /** _appDbKey */ Assert<Equals<AppDb, "AppDb">>,
  /** _appTxKey */ Assert<
    Equals<typeof appDatabase.CurrentTransaction.Identifier, "AppDb/CurrentTransaction">
  >,
  /** _appWriteRequiresDb */ Assert<Equals<Effect.Services<typeof appWrite>, "AppDb">>,
  /** _savepointRequiresTx */ Assert<
    Equals<Effect.Services<typeof savepointed>, "AppDb/CurrentTransaction">
  >,
  /** _personName */ Assert<Equals<(typeof person.$inferSelect)["name"], string>>,
  /** _projectionColumn */ Assert<
    Equals<(typeof personProjections)[number]["column"], Option.Option<string>>
  >,
  /** _filmOrder */ Assert<
    Equals<typeof filmOrder, Effect.Effect<ReadonlyArray<OrderTerm>, UnsupportedSortError>>
  >,
  /** _bookOrder */ Assert<Equals<Effect.Error<typeof bookOrder>, UnsupportedSortError>>,
  /** _sortErrorTag */ Assert<
    Equals<Effect.Error<typeof sortRejected>["_tag"], "UnsupportedSortError">
  >,
  /** _sortErrorCode */ Assert<Equals<UnsupportedSortError["code"], "unsupported.sort-field">>,
  /** _bookSet */ Assert<
    Equals<typeof bookSet, { readonly title?: string; readonly pages?: number | null }>
  >,
  /** _bookValues */ Assert<Equals<typeof bookValues, { readonly title?: string }>>,
  /** _entryAction */ Assert<Equals<VersionChainEntry["action"], "create" | "update" | "delete">>,
  /** _snapshotDraft */ Assert<Equals<Snapshot["draft"], boolean | undefined>>,
  /** _snapshotVersion */ Assert<Equals<Snapshot["version"], bigint>>,
  /** _migrated */ Assert<
    Equals<
      typeof migrated,
      Effect.Effect<
        number,
        PgMigrations.MigrationError | PlatformError,
        SqlClient | FileSystem.FileSystem | Path.Path
      >
    >
  >,
  /** _migrationName */ Assert<Equals<Effect.Success<typeof migrations>[number]["name"], string>>,
  /** _provisionedUrl */ Assert<
    Equals<Effect.Success<typeof provisioned>["url"], Redacted.Redacted<string>>
  >,
  /** _provisionedScoped */ Assert<
    Equals<Effect.Services<typeof provisioned>, FileSystem.FileSystem | Path.Path | Scope.Scope>
  >,
  /** _sourceTags */ Assert<
    Equals<Effect.Success<typeof source>["_tag"], "Explicit" | "LocalServer" | "Container">
  >,
  /** _sourceErrors */ Assert<
    Equals<
      Effect.Error<typeof source>,
      PgTesting.DatabaseUnreachable | PgTesting.InvalidDatabasePrefix
    >
  >,
  /** _driftServices */ Assert<
    Equals<Effect.Services<typeof drift>, FileSystem.FileSystem | Path.Path | ChildProcessSpawner>
  >,
  /** _driftErrorTag */ Assert<
    Equals<PgTooling.MigrationDriftError["_tag"], "MigrationDriftError">
  >,
  /** _viewCount */ Assert<Equals<Effect.Success<typeof views>, { readonly viewCount: number }>>,
  /** _viewError */ Assert<
    Equals<Effect.Error<typeof views>, PgTooling.ViewDependencyError | PgTooling.SchemaDiffError>
  >,
  /** _timestamps */ Assert<
    Equals<typeof filmTimestamps, { readonly createdAt: Date; readonly updatedAt: Date }>
  >,
];
