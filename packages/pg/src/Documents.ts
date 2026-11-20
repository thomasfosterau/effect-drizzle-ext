/**
 * A content-addressed document store: JSON documents in a table of the
 * application's own, keyed by the SHA-256 Postgres derives from each
 * document's canonical `jsonb` text, and never rewritten. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/documents.md).
 *
 * @module Documents
 */

import { bytea } from "@thomasfosterau/effect-drizzle-ext/columns";
import { DerivationError } from "@thomasfosterau/effect-drizzle-ext/derive";
import { getTableColumns, getTableName, sql, type AnyRelations, type SQL } from "drizzle-orm";
import { jsonb, type AnyPgColumn, type PgTable } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import type { PgTransaction } from "./index.ts";

/**
 * A document's hash: its SHA-256 as 64 lowercase hex characters, the form
 * {@link makeDocumentStore} reads and writes.
 */
export const DocumentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("DocumentHash"),
);

/** A {@link DocumentHash}'s type. */
export type DocumentHash = typeof DocumentHash.Type;

/**
 * The document table's columns: `hash`, the generated
 * `digest(document::text, 'sha256')` and primary key, and `document`, the
 * `jsonb` document. Needs `pgcrypto` (`CREATE EXTENSION pgcrypto`) for
 * `digest`. Build the table in your schema so `drizzle-kit generate`
 * migrates it: `pgTable("document", documentColumns())`.
 */
export const documentColumns = () => ({
  hash: bytea("hash")
    .primaryKey()
    .generatedAlwaysAs(sql`digest(document::text, 'sha256')`),
  document: jsonb("document").notNull(),
});

/** What `put` answers: the document's hash, and whether this call stored it. */
export interface PutResult {
  readonly hash: DocumentHash;
  readonly inserted: boolean;
}

/** The operations {@link makeDocumentStore} returns. */
export interface DocumentStore<Document, E, I> {
  /**
   * Store a document unless one equal under `jsonb`'s canonical text is
   * stored already; either way, answer its hash. Never rewrites a row.
   */
  readonly put: (document: Document) => Effect.Effect<PutResult, E, I>;
  /** The document a hash names, if stored. */
  readonly get: (hash: string) => Effect.Effect<Option.Option<Document>, E, I>;
  /** The stored documents among `hashes`, in one read, by hash. */
  readonly getMany: (
    hashes: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<DocumentHash, Document>, E, I>;
}

/** The query failure a Drizzle `CurrentTransaction` reports. */
type QueryError<Tx> = Tx extends {
  readonly select: () => { readonly from: (table: never) => infer Q };
}
  ? Q extends Effect.Effect<unknown, infer E, unknown>
    ? E
    : never
  : never;

const columnOf = (table: PgTable, key: string): AnyPgColumn =>
  Option.getOrElse(R.get(getTableColumns(table), key), () => {
    throw new DerivationError({
      message: `makeDocumentStore: table "${getTableName(table)}" has no "${key}" column; was it built from documentColumns()?`,
    });
  });

const isDocumentHash = Schema.is(DocumentHash);
const decodeHash = Schema.decodeEffect(DocumentHash);
const HashRows = Schema.Array(Schema.Struct({ hash: DocumentHash }));
const decodeHashRows = Schema.decodeUnknownEffect(HashRows);

/** The document's JSON text, bound as `jsonb`: Drizzle's encoder writes a JSON `null` as SQL `NULL`. */
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const asJsonb = (text: string): SQL => sql`(${text})::jsonb`;
const hashKey = (hash: DocumentHash): SQL => sql`decode(${hash}, 'hex')`;

/**
 * Bind a document store to a table built from {@link documentColumns}, in
 * the caller's `CurrentTransaction`. `document` is the documents' schema:
 * `put` encodes through it, and a stored document that fails to decode is a
 * defect (a row written outside the store). A string that is no
 * {@link DocumentHash} names no document, and reads nothing.
 *
 * Throws `DerivationError` at module load for a table without the columns.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";
 * import { documentColumns, makeDocumentStore } from "@thomasfosterau/effect-drizzle-ext-pg/Documents";
 * import { pgTable } from "drizzle-orm/pg-core";
 * import * as Schema from "effect/Schema";
 *
 * const { CurrentTransaction } = makePgDatabase({ relations: {}, key: "Database" });
 * const documents = pgTable("document", documentColumns());
 * const store = makeDocumentStore({
 *   table: documents,
 *   document: Schema.Struct({ title: Schema.String }),
 *   CurrentTransaction,
 * });
 * strictEqual(typeof store.put, "function");
 * ```
 */
export const makeDocumentStore = <Document, I, Relations extends AnyRelations>(config: {
  readonly table: PgTable;
  readonly document: Schema.Codec<Document, Schema.Json>;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): DocumentStore<Document, QueryError<PgTransaction<Relations>>, I> => {
  const { table, CurrentTransaction } = config;
  const hash = columnOf(table, "hash");
  const document = columnOf(table, "document");
  const hashText = sql<string>`encode(${hash}, 'hex')`;
  const encode = Schema.encodeEffect(config.document);
  const decode = Schema.decodeUnknownEffect(config.document);

  const getMany = Effect.fn("Documents.getMany")(function* (hashes: ReadonlyArray<string>) {
    const valid = Arr.dedupe(Arr.filter(hashes, isDocumentHash));
    if (!Arr.isReadonlyArrayNonEmpty(valid)) return HashMap.empty<DocumentHash, Document>();
    const tx = yield* CurrentTransaction;
    const rows = yield* tx
      .select({ hash: hashText, document })
      .from(table)
      .where(sql`${hash} IN (${sql.join(Arr.map(valid, hashKey), sql`, `)})`)
      .limit(valid.length);
    const entries = yield* Effect.forEach(
      rows,
      (row) =>
        Effect.orDie(
          Effect.all([decodeHash(row.hash), decode(row.document)] as const, { concurrency: 1 }),
        ),
      { concurrency: 1 },
    );
    return HashMap.fromIterable(entries);
  });

  return {
    put: Effect.fn("Documents.put")(function* (value: Document) {
      const tx = yield* CurrentTransaction;
      const json = yield* Effect.orDie(encode(value));
      const text = yield* Effect.orDie(encodeJson(json));
      const inserted = yield* tx
        .insert(table)
        .values({ document: asJsonb(text) })
        .onConflictDoNothing()
        .returning({ hash: hashText });
      const fresh = yield* Effect.orDie(decodeHashRows(inserted));
      if (Arr.isReadonlyArrayNonEmpty(fresh)) return { hash: fresh[0].hash, inserted: true };
      const seen = yield* tx.execute(
        sql`SELECT encode(digest(${asJsonb(text)}::text, 'sha256'), 'hex') AS hash`,
      );
      const [row] = yield* Effect.orDie(decodeHashRows(seen.rows));
      if (row === undefined) return yield* Effect.die("Documents.put: digest returned no row");
      return { hash: row.hash, inserted: false };
    }),
    get: (key) =>
      Effect.map(getMany([key]), (found) =>
        isDocumentHash(key) ? HashMap.get(found, key) : Option.none(),
      ),
    getMany,
  };
};
