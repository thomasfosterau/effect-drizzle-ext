/**
 * @copyright Thomas Foster
 *
 * Canary for the annotation entry: the `dbColumn` annotation round-trips, keeps
 * decode behaviour intact, pins column kinds via `dbColumnFor`, carries FK
 * metadata; `dbTable` annotates any object in place; and the struct-field
 * readers project a `Schema.Struct`'s fields through the `optional` / `NullOr`
 * wrappers a model applies.
 *
 * @module tests/annotation
 */

import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  type ColumnBounds,
  type DbColumn,
  DB_COLUMN_KEY,
  dbColumn,
  dbColumnFor,
  dbTable,
  dbTableFor,
  type FieldColumnsMetaOf,
  fieldColumnBounds,
  fieldColumns,
  numericBounds,
  readDbColumn,
  readDbTable,
  type UnwrapColumn,
} from "../src/index.ts";

/** What a hostile `toJsonSchema` hook throws: the walker must swallow it. */
class WalkerContextError extends Schema.TaggedError<WalkerContextError>()("WalkerContextError", {
  message: Schema.String,
}) {}

type PgKind = "text" | "integer" | "boolean";
const pinned = dbColumnFor<PgKind>();

/** The struct fixture the field readers project: one field of every shape. */
const WidgetFields = {
  name: dbColumn(Schema.String, { column: "name", pg: "text", notNull: true }),
  size: Schema.optional(
    dbColumn(Schema.Finite, { column: "size", pg: "integer", notNull: false, default: 0 }),
  ),
  ownerRef: Schema.NullOr(
    dbColumn(Schema.String, {
      column: "owner_ref",
      pg: "text",
      notNull: false,
      references: { table: "owner", column: "id", onDelete: "restrict" },
    }),
  ),
  nickname: Schema.optional(
    Schema.NullOr(dbColumn(Schema.String, { column: "nickname", pg: "text", notNull: false })),
  ),
  // A plain field with no `dbColumn` — must be dropped by `fieldColumns`.
  note: Schema.String,
} satisfies Schema.Struct.Fields;

describe("dbColumn annotation", () => {
  it("round-trips its metadata via readDbColumn", () => {
    const annotated = dbColumn(Schema.String, { column: "name", pg: "text", notNull: true });
    expect(readDbColumn(annotated)).toEqual(
      Option.some({ column: "name", pg: "text", notNull: true }),
    );
  });

  it("stores the metadata under the namespaced annotation key", () => {
    const annotated = dbColumn(Schema.String, { column: "name", pg: "text", notNull: true });
    expect(DB_COLUMN_KEY).toBe("effect-drizzle-ext/dbColumn");
    expect(Schema.resolveAnnotations(annotated)?.[DB_COLUMN_KEY]).toEqual({
      column: "name",
      pg: "text",
      notNull: true,
    });
  });

  it("does not change the schema's decode behaviour", () => {
    const annotated = dbColumn(Schema.String, { column: "name", pg: "text", notNull: true });
    expect(Schema.decodeSync(annotated)("hello")).toBe("hello");
    expect(() => Schema.decodeUnknownSync(annotated)(42)).toThrow("Expected string");
  });

  it("returns none for an un-annotated schema", () => {
    expect(readDbColumn(Schema.String)).toStrictEqual(Option.none());
  });

  it("does not see through a wrapper (the field readers peel, readDbColumn does not)", () => {
    const annotated = dbColumn(Schema.String, { column: "name", pg: "text", notNull: true });
    expect(readDbColumn(Schema.optional(annotated))).toStrictEqual(Option.none());
    expect(readDbColumn(Schema.NullOr(annotated))).toStrictEqual(Option.none());
  });

  it("carries foreign-key reference metadata", () => {
    const annotated = dbColumn(Schema.String, {
      column: "owner_ref",
      pg: "text",
      notNull: false,
      references: { table: "owner", column: "id", onDelete: "restrict", onUpdate: "cascade" },
    });
    expect(Option.getOrUndefined(readDbColumn(annotated))?.references).toEqual({
      table: "owner",
      column: "id",
      onDelete: "restrict",
      onUpdate: "cascade",
    });
  });
});

describe("dbColumnFor", () => {
  it("annotates the same metadata as dbColumn, pinned to a kind union", () => {
    const annotated = pinned(Schema.String, { column: "name", pg: "text", notNull: true });
    expect(readDbColumn(annotated)).toEqual(
      Option.some({ column: "name", pg: "text", notNull: true }),
    );
    expect(Schema.decodeSync(annotated)("ok")).toBe("ok");
  });

  it("recovers the pinned kind in the phantom", () => {
    const annotated = pinned(Schema.String, { column: "name", pg: "text", notNull: true });
    const kind: UnwrapColumn<typeof annotated>["pg"] = "text";
    expect(kind).toBe("text");
  });
});

describe("dbTable annotation", () => {
  it("annotates a plain object in place, preserving identity", () => {
    const target = { kind: "plain" };
    const annotated = dbTable(target, { name: "gadget" });
    // Same object — the annotation attaches in place, so every assigned
    // property and the referential identity both survive.
    expect(annotated).toBe(target);
    expect(annotated.kind).toBe("plain");
    expect(readDbTable(annotated)).toEqual(Option.some({ name: "gadget" }));
  });

  it("annotates a Schema.Struct in place (annotate would rebuild it)", () => {
    const Gadget = Schema.Struct({ name: Schema.String });
    const annotated = dbTable(Gadget, { name: "gadget", level: "work" });
    expect(annotated).toBe(Gadget);
    // The schema still works, and `annotate` would have returned a new object.
    expect(Schema.decodeSync(annotated)({ name: "g" })).toEqual({ name: "g" });
    expect(Gadget.annotate({})).not.toBe(Gadget);
    expect(readDbTable(annotated)).toEqual(Option.some({ name: "gadget", level: "work" }));
  });

  it("attaches the metadata non-enumerably", () => {
    const target = { kind: "plain" };
    dbTable(target, { name: "gadget" });
    expect(R.keys(target)).toEqual(["kind"]);
    expect(Object.getOwnPropertySymbols(target)).toEqual([
      Symbol.for("effect-drizzle-ext/dbTable"),
    ]);
    expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(target)).toBe(
      '{"kind":"plain"}',
    );
  });

  it("accepts the bare TableMeta a flat consumer needs (no level)", () => {
    const annotated = dbTable({}, { name: "flat" });
    expect(readDbTable(annotated)).toEqual(Option.some({ name: "flat" }));
  });

  it("returns none for an un-annotated target", () => {
    expect(readDbTable({})).toStrictEqual(Option.none());
    expect(readDbTable(Schema.Struct({}))).toStrictEqual(Option.none());
  });

  it("dbTableFor pins the level union and annotates identically", () => {
    const pinnedTable = dbTableFor<"work" | "manifestation">();
    const Thing = { id: 1 };
    const annotated = pinnedTable(Thing, { name: "thing", level: "manifestation" });
    expect(annotated).toBe(Thing);
    expect(readDbTable(annotated)).toEqual(Option.some({ name: "thing", level: "manifestation" }));
  });
});

describe("numericBounds", () => {
  it("recovers a two-sided inclusive bound", () => {
    expect(
      numericBounds(Schema.Finite.check(Schema.isBetween({ minimum: -4000, maximum: 2100 }))),
    ).toEqual(Option.some({ minimum: -4000, maximum: 2100 }));
  });

  it("recovers a one-sided bound", () => {
    expect(numericBounds(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))).toEqual(
      Option.some({ minimum: 0 }),
    );
  });

  it("reads through one union level (the NullOr shape)", () => {
    expect(
      numericBounds(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))),
    ).toEqual(Option.some({ minimum: 0 }));
  });

  it("returns none for an unbounded schema", () => {
    expect(numericBounds(Schema.String)).toStrictEqual(Option.none());
    expect(numericBounds(Schema.Finite)).toStrictEqual(Option.none());
  });

  it("returns none for a non-numeric check whose fragment carries no bound keys", () => {
    expect(numericBounds(Schema.String.check(Schema.isMinLength(3)))).toStrictEqual(Option.none());
  });

  it("skips a filter whose toJsonSchema needs a context the walker cannot give", () => {
    // The walker hands every filter a neutral `CheckInput` (no outer type, no
    // member schemas). A filter that insists on real context throws; the walk
    // must swallow that one fragment and keep the bounds of its siblings.
    const hostile = Schema.Finite.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(10, {
        toJsonSchema: () => {
          throw new WalkerContextError({
            message: "this filter needs a CheckInput the walker cannot give",
          });
        },
      }),
      // SAFETY: a filter whose compiler yields no fragment at all. Cast because
      // effect's own `ToJsonSchema.Check` promises an object; the walker
      // guards against `null` because an annotation is foreign data, not
      // because the type admits it.
      Schema.isLessThanOrEqualTo(20, { toJsonSchema: (() => null) as never }),
    );
    expect(numericBounds(hostile)).toEqual(Option.some({ minimum: 0 }));
  });
});

describe("fieldColumns", () => {
  it("projects every dbColumn-annotated field, peeling wrappers and dropping plain ones", () => {
    expect(fieldColumns(WidgetFields)).toEqual({
      name: { column: "name", pg: "text", notNull: true },
      size: { column: "size", pg: "integer", notNull: false, default: 0 },
      ownerRef: {
        column: "owner_ref",
        pg: "text",
        notNull: false,
        references: { table: "owner", column: "id", onDelete: "restrict" },
      },
      nickname: { column: "nickname", pg: "text", notNull: false },
    } satisfies Record<string, DbColumn>);
  });

  it("peels an optionalKey wrapper", () => {
    const columns = fieldColumns({
      tag: Schema.optionalKey(
        dbColumn(Schema.String, { column: "tag", pg: "text", notNull: false }),
      ),
    });
    expect(columns).toEqual({ tag: { column: "tag", pg: "text", notNull: false } });
  });

  it("skips the null arm of a union that declares it first", () => {
    const annotated = dbColumn(Schema.String, { column: "tag", pg: "text", notNull: false });
    expect(fieldColumns({ tag: Schema.Union([Schema.Null, annotated]) })).toEqual({
      tag: { column: "tag", pg: "text", notNull: false },
    });
  });

  it("keeps an annotation declared on the wrapper itself", () => {
    const columns = fieldColumns({
      count: dbColumn(Schema.NullOr(Schema.Finite), {
        column: "count",
        pg: "integer",
        notNull: false,
      }),
    });
    expect(columns).toEqual({ count: { column: "count", pg: "integer", notNull: false } });
  });

  it("gives up on a column buried deeper than the wrapper-depth cap", () => {
    // Slack above the deepest supported shape (`optional(NullOr(annotated))`,
    // three peels); past the cap the field drops rather than spinning the walk.
    const column: Schema.Top = dbColumn(Schema.String, {
      column: "deep",
      pg: "text",
      notNull: false,
    });
    const deep = Arr.reduce(Arr.range(1, 10), column, (wrapped) => Schema.NullOr(wrapped));
    expect(fieldColumns({ deep })).toEqual({});
  });

  it("returns an empty map for a struct with no columns", () => {
    expect(fieldColumns({ note: Schema.String, n: Schema.optional(Schema.Finite) })).toEqual({});
  });

  it("types the projection through FieldColumnsMetaOf", () => {
    // A compile-time assertion: annotated fields survive with their literal
    // metadata, `note` drops out of the map entirely.
    const meta: FieldColumnsMetaOf<typeof WidgetFields> = {
      name: { column: "name", pg: "text", notNull: true },
      size: { column: "size", pg: "integer", notNull: false, default: 0 },
      ownerRef: {
        column: "owner_ref",
        pg: "text",
        notNull: false,
        references: { table: "owner", column: "id", onDelete: "restrict" },
      },
      nickname: { column: "nickname", pg: "text", notNull: false },
    };
    expect(R.keys(meta)).not.toContain("note");
    expect(meta.name.pg).toBe("text");
  });
});

describe("fieldColumnBounds", () => {
  const BoundedFields = {
    count: dbColumn(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), {
      column: "count",
      pg: "integer",
      notNull: false,
    }),
    year: dbColumn(Schema.Finite.check(Schema.isBetween({ minimum: -4000, maximum: 2100 })), {
      column: "year",
      pg: "integer",
      notNull: true,
    }),
    ratio: Schema.optional(
      dbColumn(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)), {
        column: "ratio",
        pg: "integer",
        notNull: false,
      }),
    ),
    // Bounded but not column-backed — must be dropped.
    plain: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
    // Column-backed but unbounded — must be dropped.
    label: dbColumn(Schema.String, { column: "label", pg: "text", notNull: false }),
  } satisfies Schema.Struct.Fields;

  it("pairs bounds with column metadata, dropping unbounded and column-less fields", () => {
    expect(fieldColumnBounds(BoundedFields)).toEqual({
      count: { column: { column: "count", pg: "integer", notNull: false }, minimum: 0 },
      year: {
        column: { column: "year", pg: "integer", notNull: true },
        minimum: -4000,
        maximum: 2100,
      },
      ratio: { column: { column: "ratio", pg: "integer", notNull: false }, minimum: 0 },
    } satisfies Record<string, ColumnBounds>);
  });

  it("reads bounds off an optional(NullOr(...)) wrapped column", () => {
    expect(
      fieldColumnBounds({
        depth: Schema.optional(
          dbColumn(
            Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 9 }))),
            {
              column: "depth",
              pg: "integer",
              notNull: false,
            },
          ),
        ),
      }),
    ).toEqual({
      depth: { column: { column: "depth", pg: "integer", notNull: false }, minimum: 1, maximum: 9 },
    });
  });

  it("returns an empty map when nothing is both column-backed and bounded", () => {
    expect(fieldColumnBounds({ note: Schema.String })).toEqual({});
  });
});
