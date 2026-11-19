/**
 * Resolves the names a Postgres error carries (`table`, `schema`, `column`,
 * `constraint`, the `DETAIL` key) back to the Drizzle table and columns an
 * application declared, through its `relations` graph. Internal: the public
 * surface is `makePgDatabase`'s `locate` and the types re-exported from the
 * package root.
 *
 * @module locate
 */

import { findPgError, type PgErrorFacts } from "@thomasfosterau/effect-drizzle-ext/errors";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, IndexedColumn, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";

/** Every column of a Drizzle table, as a union. */
export type ColumnOf<Table extends PgTable> = Table["_"]["columns"][keyof Table["_"]["columns"]];

/**
 * Where a Postgres error happened, for one table of the relations graph:
 * the relations `key` the table is declared under (a string literal, so it
 * narrows the union), the Drizzle `table` itself, and the `columns` at fault.
 *
 * `columns` is, in order of preference: the column Postgres names (a NOT
 * NULL violation); the columns of the constraint Postgres names, matched
 * against the table's primary key, foreign keys, unique constraints, named
 * unique indexes and column-level `.unique()` by their explicit name or, for
 * an unnamed one, the default drizzle-kit or Postgres gives it; or, for a
 * unique violation, the columns in the `DETAIL` line's `Key (…)=(…)`. Empty
 * when none applies, as for a CHECK violation.
 */
export interface PgErrorTableLocation<Key extends string, Table extends PgTable> {
  readonly key: Key;
  readonly table: Table;
  readonly columns: ReadonlyArray<ColumnOf<Table>>;
}

/**
 * {@link PgErrorTableLocation} over every table of an application's
 * relations graph: a union discriminated by `key`, so checking
 * `location.key === "users"` narrows `table` to `users` and `columns` to its
 * columns.
 */
export type PgErrorLocation<Relations extends AnyRelations> = {
  readonly [Key in keyof Relations & string]: Relations[Key]["table"] extends infer Table extends
    PgTable
    ? PgErrorTableLocation<Key, Table>
    : never;
}[keyof Relations & string];

/** The schema Postgres reports for a table Drizzle declared without one. */
const DEFAULT_SCHEMA = "public";

/** A lookup table keyed by a Postgres identifier. */
type ByName<A> = R.ReadonlyRecord<string, A>;

/** One declared table, with what the lookup needs precomputed. */
interface TableEntry {
  readonly key: string;
  readonly table: PgTable;
  readonly name: string;
  readonly schema: Option.Option<string>;
  readonly columnsByName: ByName<PgColumn>;
  readonly constraints: ByName<ReadonlyArray<string>>;
}

/** The names of a list of Drizzle columns. */
const columnNames = (columns: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<string> =>
  Arr.map(columns, (column) => column.name);

/** The column names an index lists, skipping SQL expressions. */
const indexColumnNames = (columns: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  Arr.map(
    Arr.filter(columns, (column) => column instanceof IndexedColumn),
    (column) => column.name,
  );

/** Postgres truncates an identifier to 63 bytes (`NAMEDATALEN - 1`). */
const MAX_IDENTIFIER_LENGTH = 63;

/** A constraint as the lookup sees it: every name it may carry in the database, and its column names. */
type NamedColumns = readonly [ReadonlyArray<string>, ReadonlyArray<string>];

/**
 * The names a constraint may carry in the database: its explicit name when it
 * was declared with one, else every default a migration could have given it
 * (`defaults`: drizzle-kit's, Drizzle's own `getName()`, and Postgres'
 * `_pkey` / `_key` / `_fkey` for an inline constraint).
 */
const candidateNames = (
  explicit: Option.Option<string>,
  defaults: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Option.match(explicit, { onSome: (name) => [name], onNone: () => defaults });

/**
 * Every constraint of `table` the lookup can name, with its column names.
 * An unnamed unique index is left out (its generated name is not
 * predictable), as is any constraint whose name the database chose some
 * other way; a unique violation on one falls back to the `DETAIL` key.
 */
const namedConstraints = (table: PgTable): ByName<ReadonlyArray<string>> => {
  const config = getTableConfig(table);
  const prefix = (columns: ReadonlyArray<string>) => `${config.name}_${columns.join("_")}`;
  const pairs: ReadonlyArray<NamedColumns> = [
    ...Arr.map(config.primaryKeys, (pk): NamedColumns => [
      candidateNames(
        Option.filter(Option.fromNullishOr(pk.name), () => pk.isNameExplicit),
        [`${config.name}_pkey`, pk.getName()],
      ),
      columnNames(pk.columns),
    ]),
    ...Arr.map(config.foreignKeys, (fk): NamedColumns => {
      const { columns, foreignColumns, foreignTable } = fk.reference();
      const own = columnNames(columns);
      const kit = `${prefix(own)}_${getTableConfig(foreignTable).name}_${columnNames(foreignColumns).join("_")}_fkey`;
      return [
        candidateNames(fk.isNameExplicit() ? Option.some(fk.getName()) : Option.none(), [
          kit,
          fk.getName(),
          `${prefix(own)}_fkey`,
        ]),
        own,
      ];
    }),
    ...Arr.map(config.uniqueConstraints, (unique): NamedColumns => {
      const own = columnNames(unique.columns);
      return [
        candidateNames(Option.fromNullishOr(unique.getName()), [
          `${prefix(own)}_unique`,
          `${prefix(own)}_key`,
        ]),
        own,
      ];
    }),
    ...Arr.map(
      Arr.filter(config.indexes, (index) => index.config.unique && index.isNameExplicit),
      (index): NamedColumns => [
        Arr.fromOption(Option.fromNullishOr(index.config.name)),
        indexColumnNames(index.config.columns),
      ],
    ),
    ...Arr.flatMap(config.columns, (column): ReadonlyArray<NamedColumns> => [
      ...(column.primary ? [[[`${config.name}_pkey`], [column.name]] as const] : []),
      ...(column.isUnique
        ? [
            [
              candidateNames(Option.fromNullishOr(column.uniqueName), [
                `${prefix([column.name])}_key`,
                `${prefix([column.name])}_unique`,
              ]),
              [column.name],
            ] as const,
          ]
        : []),
    ]),
  ];
  return R.fromEntries(
    Arr.flatMap(pairs, ([names, columns]) =>
      Arr.map(names, (name) => [name.slice(0, MAX_IDENTIFIER_LENGTH), columns] as const),
    ),
  );
};

/** The table a relations entry holds, when it is a Postgres table (not a view). */
const pgTableOf = (config: { readonly table: unknown }): Option.Option<PgTable> =>
  is(config.table, PgTable) ? Option.some(config.table) : Option.none();

/** One table's lookups. */
const tableEntry = (key: string, table: PgTable): TableEntry => {
  const { name, schema } = getTableConfig(table);
  const columns: ByName<PgColumn> = getTableColumns(table);
  return {
    key,
    table,
    name,
    schema: Option.fromNullishOr(schema),
    columnsByName: R.fromEntries(
      Arr.map(R.values(columns), (column) => [column.name, column] as const),
    ),
    constraints: namedConstraints(table),
  };
};

/** The tables of a relations graph, with their lookups. */
const tableEntries = (relations: AnyRelations): ReadonlyArray<TableEntry> =>
  Arr.flatMap(R.toEntries(relations), ([key, config]) =>
    Arr.fromOption(Option.map(pgTableOf(config), (table) => tableEntry(key, table))),
  );

/**
 * True when a declared table is the one the error names: same name, and the
 * same schema when the error reports one. A table declared without a schema
 * matches `public` only, so a temporary table (`pg_temp_N`) or another
 * schema's table of the same name never resolves to it.
 */
const isNamedBy = (entry: TableEntry, facts: PgErrorFacts, table: string): boolean =>
  entry.name === table &&
  Option.match(facts.schema, {
    onNone: () => true,
    onSome: (schema) => schema === Option.getOrElse(entry.schema, () => DEFAULT_SCHEMA),
  });

/** A quoted identifier in a `DETAIL` line, unquoted; `""` is an escaped quote. */
const unquote = (identifier: string): string =>
  identifier.startsWith('"') && identifier.endsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier;

/**
 * The column list in a `DETAIL` line's `Key (a, b)=(…)`, the form Postgres
 * gives unique and foreign key violations. The word `Key` is translated under
 * a non-English `lc_messages`, so only the parenthesised list is read.
 */
const KEY_COLUMNS = /^[^(]*\(([^)]*)\)=\(/;

/** The column names a `DETAIL` line's key lists, or none. */
const detailColumnNames = (detail: Option.Option<string>): ReadonlyArray<string> =>
  Option.match(
    Option.flatMap(detail, (line) => Option.fromNullishOr(KEY_COLUMNS.exec(line)?.[1])),
    {
      onNone: () => [],
      onSome: (list) => Arr.map(list.split(", "), (name) => unquote(name.trim())),
    },
  );

/** SQLSTATE `23505`, the one class whose `DETAIL` key always lists the reported table's columns. */
const UNIQUE_VIOLATION = "23505";

/**
 * The column names at fault, by the preference {@link PgErrorTableLocation}
 * documents. The `DETAIL` fallback is a unique violation's only: a foreign
 * key violation raised by deleting a referenced row reports the referencing
 * table but lists the referenced table's key.
 */
const faultColumnNames = (entry: TableEntry, facts: PgErrorFacts): ReadonlyArray<string> =>
  Option.match(facts.column, {
    onSome: (column) => [column],
    onNone: () =>
      Option.getOrElse(
        Option.flatMap(facts.constraint, (name) => R.get(entry.constraints, name)),
        () => (facts.code === UNIQUE_VIOLATION ? detailColumnNames(facts.detail) : []),
      ),
  });

/** The location of an error in one table, its column names resolved to that table's columns. */
const locationIn = (
  entry: TableEntry,
  facts: PgErrorFacts,
): PgErrorTableLocation<string, PgTable> => ({
  key: entry.key,
  table: entry.table,
  columns: Arr.flatMap(faultColumnNames(entry, facts), (name) =>
    Arr.fromOption(R.get(entry.columnsByName, name)),
  ),
});

/**
 * Builds the `locate` function for one relations graph: the table lookups
 * are computed once, when `makePgDatabase` runs.
 */
export const errorLocator = <Relations extends AnyRelations>(
  relations: Relations,
): ((cause: unknown) => Option.Option<PgErrorLocation<Relations>>) => {
  const entries = tableEntries(relations);
  return (cause) =>
    Option.flatMap(findPgError(cause), (facts) =>
      Option.flatMap(facts.table, (tableName) =>
        Option.map(
          Arr.findFirst(entries, (entry) => isNamedBy(entry, facts, tableName)),
          // SAFETY: `entry` was built from `relations[entry.key].table` and
          // every column came from that table's own columns, so this is the
          // `PgErrorTableLocation` of `entry.key`; the mapped union can't be
          // named from a runtime key.
          (entry) => locationIn(entry, facts) as PgErrorLocation<Relations>,
        ),
      ),
    );
};
