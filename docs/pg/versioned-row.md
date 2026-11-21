# `./VersionedRow`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

Optimistic concurrency over a flat table: one mutable row per id and a `version` column every write bumps. Use it for an aggregate that needs a concurrency token but no history; for history, use [`./chain`](chain.md).

## The table

Spread `versionColumn()` beside your columns; the table needs an `id` primary key (`${name}_pkey`, drizzle-kit's default name).

```ts
import { versionColumn } from "@thomasfosterau/effect-drizzle-ext-pg/VersionedRow";

export const account = pgTable("account", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  ...versionColumn(), // version bigint NOT NULL DEFAULT 0
});
```

## Operations

`makeVersionedRow({ table, CurrentTransaction, type? })` returns four operations. Each requires `CurrentTransaction`, and none opens a transaction. `type` names the table in the errors (default: its name), which are `./chain`'s classes, so a repository maps both the same way.

| Operation | What it does |
| --- | --- |
| `load(id)` | The row, version included. `Option.none()` for an unknown id. |
| `insert(id, values)` | Inserts at version `0`. A taken id fails `NodeAlreadyExists` (never an upsert); another unique key fails `UniqueViolation`. Either aborts the transaction. |
| `update({ id, patch, expectedVersion? })` | One `UPDATE … SET …, version = version + 1 WHERE id = … [AND version = …] RETURNING version`. Returns the new version. A moved version fails `StaleVersion { expected, current }` and writes nothing; an unknown id fails `NodeNotFound`. |
| `delete(id, { expectedVersion? })` | A hard delete under the same precondition. Returns the version the row had. |

A writer racing another on the same row waits on its row lock, then finds the version moved and fails `StaleVersion`, so neither write is lost.

```ts
const accounts = makeVersionedRow({ table: account, CurrentTransaction });

const rename = (id: string, name: string) =>
  transact(
    Effect.gen(function* () {
      const loaded = yield* accounts.load(id);
      if (Option.isNone(loaded)) return yield* new NodeNotFound({ type: "account", id });
      return yield* accounts.update({ id, patch: { name }, expectedVersion: loaded.value.version });
    }),
  );
```
