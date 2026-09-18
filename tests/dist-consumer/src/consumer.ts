/**
 * A consumer's view of both packages: every subpath imported through its
 * EMITTED declarations (`paths` in tsconfig.json points the package names at
 * `dist/*.d.ts`, and `skipLibCheck` is off). Each block exercises the types a
 * real consumer depends on, so a declaration that degrades to `any` — the
 * hazard `versioned-chain.ts` documents — fails here rather than in an
 * application. Never executed; type-checked only.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import { sql, type SQL } from "drizzle-orm";
import { boolean, integer, pgSchema, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  type DbColumnOf,
  dbColumn,
  dbColumnFor,
  dbTableFor,
  fieldColumns,
  readDbColumn,
  readDbTable,
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
  makeCurrentVersionView,
  makeSubtypeTables,
} from "@thomasfosterau/effect-drizzle-ext/versioned-chain";
import { resourceColumns, dbTable } from "@thomasfosterau/effect-drizzle-ext/jsonapi";
import { makeDeriveResourceColumns } from "@thomasfosterau/effect-drizzle-ext/jsonapi/derive";
import * as Pg from "@thomasfosterau/effect-drizzle-ext-pg";
import * as PgTesting from "@thomasfosterau/effect-drizzle-ext-pg/testing";

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
  pages: column(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)), {
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

const Payload = Schema.Struct({ a: Schema.Number });
export const blob = pgTable("blob", {
  hash: bytea("hash").notNull(),
  search: tsvector("search"),
  payload: jsonbSchema(Payload)("payload").notNull(),
});
type BlobRow = typeof blob.$inferSelect;
export const roundTrip: Uint8Array = hexToBytea(byteaToHex(new Uint8Array([1, 2])));

// ── query ─────────────────────────────────────────────────────────────────

// oxlint-disable-next-line effect/prefer-option-over-null -- `combineFilters` yields the `SQL | undefined` Drizzle's `.where()` reads
export const where: SQL | undefined = combineFilters(sql`1 = 1`, undefined);
export const page = pageOf([{ ...({} as BookRow), [`__totalCount`]: 3 }], (row) => row.title);
export const total = totalCountColumn;
const pagination = boundedPagination({ maxLimit: 100, defaultLimit: 20 });
export const rows = executeRows<{ readonly one: number }>(
  { execute: () => Effect.succeed([{ one: 1 }] as unknown) },
  sql`select 1 as one`,
);

// ── errors ────────────────────────────────────────────────────────────────

export const classified: Option.Option<ClassifiedError> = classifyError(new Error("x"));
export const facts = findPgError(new Error("x"));
export const recovered = Effect.fail(
  new UniqueViolation({
    constraint: Option.some("book_pkey"),
    table: Option.none(),
    detail: Option.none(),
    cause: new Error("dup"),
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
export const inTx = services.transact(Effect.map(services.readHandle, () => 1));

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
export const appWrite = appDatabase.transact(Effect.map(appDatabase.readHandle, () => "written"));
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
export const retryable: boolean = PgTesting.isRetryableConnectFailure(new Error("x"));
export const testLayer: Layer.Layer<"AppDb", SqlError> = PgTesting.testDatabaseLayer(appDatabase, {
  url: Redacted.make("postgresql://postgres@127.0.0.1:5432/test"),
});

/**
 * Every compile-time assertion, exported so `noUnusedLocals` keeps them and a
 * failing one names itself in the error.
 */
export type Checks = [
  /** _titleMetaIsPrecise */ Assert<Equals<TitleMeta["pg"], "text">>,
  /** _titleNotNull */ Assert<Equals<TitleMeta["notNull"], true>>,
  /** _bookTitleIsString */ Assert<Equals<BookRow["title"], string>>,
  // oxlint-disable-next-line effect/prefer-option-over-null -- asserts Drizzle's own nullable row shape
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
  // oxlint-disable-next-line effect/prefer-option-over-null -- asserts Drizzle's own nullable row shape
  /** _filmRuntime */ Assert<Equals<FilmVersionRow["runtime"], number | null>>,
  /** _viewId */ Assert<Equals<FilmViewRow["id"], string>>,
  /** _viewType */ Assert<Equals<FilmViewRow["type"], string>>,
  /** _appDbKey */ Assert<Equals<AppDb, "AppDb">>,
  /** _appTxKey */ Assert<
    Equals<typeof appDatabase.CurrentTransaction.Identifier, "AppDb/CurrentTransaction">
  >,
  /** _appWriteRequiresDb */ Assert<Equals<Effect.Services<typeof appWrite>, "AppDb">>,
  /** _savepointRequiresTx */ Assert<
    Equals<Effect.Services<typeof savepointed>, "AppDb/CurrentTransaction">
  >,
  /** _personName */ Assert<Equals<(typeof person.$inferSelect)["name"], string>>,
];
