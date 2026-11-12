---
"@thomasfosterau/effect-drizzle-ext": minor
---

`executeRows` (`./query`) now decodes the rows with a Schema instead of trusting a caller-asserted row type. Its error channel gains `Schema.SchemaError`, which it fails with when a row doesn't match, or when the result is neither a rows array nor a result object (several statements' results, for one).

**Migration:** replace the type argument with a schema argument.

```ts
// before
executeRows<{ n: number }>(db, sql`SELECT n FROM t`);
// after
executeRows(db, sql`SELECT n FROM t`, Schema.Struct({ n: Schema.Finite }));
```

Also new: `isDbColumn`, the guard `readDbColumn` and `resourceColumns` now read an annotation through. A value under the annotation key that isn't db-column metadata reads as no column.
