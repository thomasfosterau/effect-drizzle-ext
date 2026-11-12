# `./derive`

_A guide to [`@thomasfosterau/effect-drizzle-ext`](../../packages/core/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

Reads the `DbColumn` metadata a schema declaration carries — via `fieldColumns`, or any other projection yielding a `Record<string, DbColumn>` (the `./jsonapi/derive` entry is one) — and emits the matching Drizzle column builders. `deriveColumnsWith(builders, options)` binds a derivation to a consumer's own kind → builder registry and returns `{ fromFields, fromMeta }`: `fromFields` takes a `Schema.Struct`'s fields directly, `fromMeta` an already-projected metadata map.

Failures here are **thrown**, never Effect failures — this module runs at _module load_, while a consumer's table modules are being evaluated, before any Effect runtime exists to fail an Effect in. A missing builder, a `references` annotation with no `resolveReference` hook, or numeric bounds on a column the table does not carry each throw `DerivationError`, a `Schema.TaggedError`. Runtime query failures are the opposite and are never thrown: see `./errors`.

`deriveCheckConstraintsFrom` / `deriveFieldCheckConstraints` turn a bounds map into `check()` constraints, named `${tableName}_${column}_${suffix}` unless the column annotation pins a `checkName`:

| Bounds                      | Suffix         | Expression                 |
| --------------------------- | -------------- | -------------------------- |
| both sides                  | `range`        | `col BETWEEN min AND max`  |
| `minimum: 0` only           | `non_negative` | `col >= 0`                 |
| one-sided minimum (nonzero) | `min`          | `col >= min` / `col > min` |
| one-sided maximum           | `max`          | `col <= max` / `col < max` |

A nullable column's expression is guarded with `col IS NULL OR …`.

```ts
export class DerivationError extends Schema.TaggedError<DerivationError>()("DerivationError", {
  message: Schema.String,
}) {}
export const deriveColumnsWith: <B extends ColumnBuilders>(
  builders: B,
  options?: DeriveOptions,
) => {
  readonly fromMeta: <Meta extends Record<string, DbColumn>>(
    metas: Meta,
  ) => DerivedColumns<Meta, B>;
  readonly fromFields: <F extends Schema.Struct.Fields>(
    fields: F,
  ) => DerivedColumns<FieldColumnsMetaOf<F>, B>;
};
export const deriveCheckConstraintsFrom: (
  bounds: Record<string, ColumnBounds>,
  tableName: string,
) => (table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[];
export const deriveFieldCheckConstraints: (
  fields: Schema.Struct.Fields,
  tableName: string,
) => (table: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[];
```
