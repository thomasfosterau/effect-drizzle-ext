# `./constraints`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

`enumCheck(name, column, values)` emits `CHECK (column IN ('a', 'b', …))` — a vocabulary declared once as a model's `Schema.Literals` also constrains the database, with no Postgres enum type (so growing the vocabulary is one `ALTER … DROP/ADD CONSTRAINT`, not an `ALTER TYPE … ADD VALUE` that cannot run inside a transaction). A `NULL` in the column **passes**: `NULL IN (...)` is unknown, which CHECK accepts, so the same constraint serves a nullable vocabulary with no extra `IS NULL OR` guard — nullability is the column's own `NOT NULL` to declare.

`discriminatorConstraintsFor({ leaves, names? })` builds a `DiscriminatorToolkit<Level>` for one hierarchy: the three constraints that thread a `type` discriminator up a tree of stable tables and make a sibling-subtype chimera unrepresentable.

- `typeUnique` — `UNIQUE(id, type)`, the target every child's composite FK points at.
- `typeParentFk` — the composite `(id, type)` → parent `(id, type)` foreign key (a child can only exist under a parent carrying the same `type`); `onUpdate: "cascade"` (via `typeConstraints`' `refinable: true`) makes a bare parent row **refinable** — a `type` flip cascades down the pre-existing chain before the concrete rows are inserted, with no `DEFERRABLE` constraint needed.
- `typeCheck` — the per-level `type` CHECK, narrowing to the level's own subtree (`options.leaves(level)`). A childless marker level — no concrete leaf beneath it yet — has an empty leaf set and gets `CHECK (false)`: `type IN ()` is a syntax error, and `false` correctly marks the level uninstantiable.
- `typeConstraints` — all three for a non-root level in one call.

```ts
export const enumCheck: (
  name: string,
  column: ExtraConfigColumn,
  values: readonly string[],
) => PgTableExtraConfigValue;
export const discriminatorConstraintsFor: <Level extends string>(options: {
  readonly leaves: (level: Level) => ReadonlyArray<string>;
  readonly names?: DiscriminatorNames | undefined;
}) => DiscriminatorToolkit<Level>;
```
