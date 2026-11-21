/**
 * External identifiers: one table linking a node to its id at each outside
 * authority (a Wikidata QID, an ISBN, a feed's own key), and the reads and
 * writes an import resolves against it. See the
 * [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/external-ids.md).
 *
 * @module ExternalIds
 */

import { and, eq, inArray, sql, type AnyRelations } from "drizzle-orm";
import {
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
  type AnyPgColumn,
  type PgSchema,
  type PgTable,
} from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PgTransaction } from "./PgDatabase.ts";
import { columnOf as tableColumnOf, type QueryError } from "./internal/table.ts";

/** The most external ids one {@link ExternalIdStore.lookup} reads. */
export const MAX_LOOKUP = 1000;

/**
 * The external-id table's columns: `authority`, `external_id` and `node_id`,
 * a reference to the tree's identity row, deleted with it. Spread them beside
 * columns of your own (an import baseline, a provenance) to extend the table.
 */
export const externalIdColumns = (identityId: AnyPgColumn) => ({
  authority: text("authority").notNull(),
  externalId: text("external_id").notNull(),
  nodeId: uuid("node_id")
    .notNull()
    .references((): AnyPgColumn => identityId, { onDelete: "cascade" }),
});

/**
 * The external-id table's keys, named from `name`: one node per
 * `(authority, external_id)` (`${name}_pkey`), and one id per authority per
 * node (`${name}_node`, on `(node_id, authority)`, so it also serves a
 * node's links), so an authority can't name a node twice.
 */
export const externalIdConstraints =
  (name: string) =>
  (table: {
    readonly authority: AnyPgColumn;
    readonly externalId: AnyPgColumn;
    readonly nodeId: AnyPgColumn;
  }) => [
    primaryKey({ name: `${name}_pkey`, columns: [table.authority, table.externalId] }),
    unique(`${name}_node`).on(table.nodeId, table.authority),
  ];

/**
 * The whole table: {@link externalIdColumns} and
 * {@link externalIdConstraints} under `name` (`external_id`), in `schema`
 * when given. For columns of your own, assemble the table from those two.
 */
export const makeExternalIdTable = (options: {
  readonly identity: { readonly id: AnyPgColumn };
  readonly schema?: PgSchema;
  readonly name?: string;
}) => {
  const name = options.name ?? "external_id";
  const columns = externalIdColumns(options.identity.id);
  return options.schema === undefined
    ? pgTable(name, columns, externalIdConstraints(name))
    : options.schema.table(name, columns, externalIdConstraints(name));
};

/** What {@link ExternalIdStore.link} found: a new link, the same link already there, or the id taken by another node. */
export type LinkResult = "linked" | "present" | "taken";

/** One link: a node's id at an authority. */
export interface ExternalIdLink {
  readonly authority: string;
  readonly externalId: string;
  readonly nodeId: string;
}

/** The operations {@link makeExternalIdStore} returns. */
export interface ExternalIdStore<E, I> {
  /**
   * The nodes `externalIds` name at `authority`, by external id; an id no node
   * carries is absent. More than {@link MAX_LOOKUP} ids read nothing.
   */
  readonly lookup: (
    authority: string,
    externalIds: ReadonlyArray<string>,
  ) => Effect.Effect<HashMap.HashMap<string, string>, E, I>;
  /** Every link of a node, by authority; an id that is no UUID has none. */
  readonly linksOf: (nodeId: string) => Effect.Effect<ReadonlyArray<ExternalIdLink>, E, I>;
  /**
   * Link `externalId` at `authority` to `nodeId`, never moving an existing
   * link. A node already linked at `authority` under another id is the
   * driver's unique violation on `${name}_node`.
   */
  readonly link: (link: ExternalIdLink) => Effect.Effect<LinkResult, E, I>;
}

const columnOf = tableColumnOf("makeExternalIdStore", "externalIdColumns");

/** A string PostgreSQL's `uuid` input takes; anything else names no node rather than failing the statement. */
const UUID = /^(?:\{[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(?:-?[0-9a-f]{4}){7})$/i;

const Link = Schema.Struct({
  authority: Schema.String,
  externalId: Schema.String,
  nodeId: Schema.String,
});
const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(Link));

/**
 * Bind an external-id store to a table built from {@link externalIdColumns},
 * in the caller's `CurrentTransaction`. Throws `DerivationError` at module
 * load for a table without the columns.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert";
 * import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
 * import { makeExternalIdStore, makeExternalIdTable } from "@thomasfosterau/effect-drizzle-ext-pg/ExternalIds";
 * import { pgTable, uuid } from "drizzle-orm/pg-core";
 *
 * const node = pgTable("node", { id: uuid("id").primaryKey() });
 * const externalIds = makeExternalIdTable({ identity: node });
 * const { CurrentTransaction } = makePgDatabase({ relations: {}, key: "Database" });
 * const store = makeExternalIdStore({ table: externalIds, CurrentTransaction });
 * strictEqual(typeof store.lookup, "function");
 * ```
 */
export const makeExternalIdStore = <I, Relations extends AnyRelations>(config: {
  readonly table: PgTable;
  readonly CurrentTransaction: Context.Service<I, PgTransaction<Relations>>;
}): ExternalIdStore<QueryError<PgTransaction<Relations>>, I> => {
  const { table, CurrentTransaction } = config;
  const authority = columnOf(table, "authority");
  const externalId = columnOf(table, "externalId");
  const nodeId = columnOf(table, "nodeId");
  const select = { authority, externalId, nodeId: sql<string>`${nodeId}::text` };

  return {
    lookup: Effect.fn("ExternalIds.lookup")(function* (
      at: string,
      externalIds: ReadonlyArray<string>,
    ) {
      const named = Arr.dedupe(externalIds);
      if (!Arr.isReadonlyArrayNonEmpty(named) || named.length > MAX_LOOKUP) {
        return HashMap.empty<string, string>();
      }
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select(select)
        .from(table)
        .where(and(eq(authority, at), inArray(externalId, [...named])));
      const links = yield* Effect.orDie(decodeLinks(rows));
      return HashMap.fromIterable(
        Arr.map(links, (link) => [link.externalId, link.nodeId] as const),
      );
    }),
    linksOf: Effect.fn("ExternalIds.linksOf")(function* (node: string) {
      if (!UUID.test(node)) return [];
      const tx = yield* CurrentTransaction;
      const rows = yield* tx
        .select(select)
        .from(table)
        .where(eq(nodeId, node))
        .orderBy(authority)
        .limit(MAX_LOOKUP);
      return yield* Effect.orDie(decodeLinks(rows));
    }),
    link: Effect.fn("ExternalIds.link")(function* (link: ExternalIdLink) {
      const tx = yield* CurrentTransaction;
      const inserted = yield* tx
        .insert(table)
        .values({ authority: link.authority, externalId: link.externalId, nodeId: link.nodeId })
        .onConflictDoNothing({ target: [authority, externalId] })
        .returning({ authority });
      if (Arr.isReadonlyArrayNonEmpty(inserted)) return "linked" as const;
      const stored = yield* tx
        .select({ nodeId: sql<string>`${nodeId}::text` })
        .from(table)
        .where(and(eq(authority, link.authority), eq(externalId, link.externalId)))
        .limit(1);
      return Option.exists(Arr.head(stored), (row) => row.nodeId === link.nodeId)
        ? ("present" as const)
        : ("taken" as const);
    }),
  };
};
