# `./chain`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

The version-chain discipline, Drizzle-concrete, over the tables core's `makeTreeTables` derives (effect-drizzle-ext#112, decision 5). `makeVersionChain({ tree, tables, CurrentTransaction })` returns one `LeafChain` per leaf. Every operation requires the application's `CurrentTransaction`, so the chain never opens a transaction itself, and is traced as `${leaf}.<operation>`.

| Operation | What it does |
| --- | --- |
| `create({ id?, state, actor, identity?, root? })` | The identity row, every level's stable row, then version 0 at the root and every level (and each non-null fact). **Never an upsert**: a taken id fails `NodeAlreadyExists`. The id is minted with `gen_random_uuid()` when absent. |
| `update({ id, patch, actor, expectedVersion?, root? })` | Appends version `N_max + 1` at every level, carrying the patch over the head: a value sets, `null` clears, an absent or `undefined` key carries forward. An unknown id, another leaf's node or a tombstone fails `NodeNotFound` (a plain update never resurrects). |
| `restore(...)` | `update`, but allowed over a tombstone: the explicit resurrection surface. |
| `delete(id, { actor, expectedVersion?, root? })` | A tombstone carrying every column forward. Idempotent: on a tombstone it returns `alreadyDeleted: true` and writes nothing. |
| `restoreVersion(id, n, { actor, ... })` | Reads the whole snapshot at `n` (every level) first, and fails `VersionNotFound` before writing anything if any level is missing. Then it appends that snapshot as an `update`. |
| `getVersion(id, n)` / `history(id, limit?)` | One version's `{ version, action, timestamp, state }`. The chain oldest first, capped at `MAX_HISTORY_LIMIT` (1000). |

**A keyed leaf** (core's `keyed: { name, columns }`, such as a localised leaf's locales) also writes its keyed level on every append. `create` takes `keyed`, the whole level. `update` / `restore` take `keyed`, a per-key tri-state patch: a patch updates a key, `null` drops it, and an absent key carries it forward. `delete` and `restoreVersion` carry or restore every key, and `getVersion` returns them as `keyed`, keyed by key (`{}` for none).

**The expected-version precondition.** Every write to an existing node takes `expectedVersion`, the head its caller last read. A moved head fails `StaleVersion { expected, current }` and nothing is written. A writer racing between its read and its append loses the root's `(id, version)` primary key and fails `VersionConflict`; the transaction is aborted for the caller to roll back. `actor` is a required `string | undefined`, so every caller states it. State is keyed by field across the leaf's whole path. The error classes (`NodeNotFound`, `VersionNotFound`, `NodeAlreadyExists`, `VersionConflict`, `StaleVersion`, and `BrokenChain` as a defect) carry pulpit's names and fields.

```ts
const chain = makeVersionChain({ tree, tables, CurrentTransaction });

const edit = transact(
  Effect.gen(function* () {
    const { id } = yield* chain.book.create({
      state: { title: "Dune", pages: 412 },
      actor: userId,
    });
    return yield* chain.book.update({
      id,
      patch: { pages: 256 },
      actor: userId,
      expectedVersion: 0n,
    });
  }),
);
```
