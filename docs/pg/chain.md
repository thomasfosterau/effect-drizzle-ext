# `./chain`

_A guide to [`@thomasfosterau/effect-drizzle-ext-pg`](../../packages/pg/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

The version-chain discipline, Drizzle-concrete, over the tables core's `makeTreeTables` derives. `makeVersionChain({ tree, tables, CurrentTransaction })` returns one `LeafChain` per leaf. Every operation requires the application's `CurrentTransaction`, so the chain never opens a transaction itself, and is traced as `${leaf}.<operation>`.

| Operation | What it does |
| --- | --- |
| `create({ id?, state, actor, identity?, stable?, root? })` | The identity row, every level's stable row (with its `stableColumns` from `stable`), then version 0 at the root and every level (and each non-null fact). **Never an upsert**: a taken id fails `NodeAlreadyExists`. The id is minted with `gen_random_uuid()` when absent. |
| `update({ id, patch, actor, expectedVersion?, root? })` | Appends version `N_max + 1` at every level, carrying the patch over the head: a value sets, `null` clears, an absent or `undefined` key carries forward. An unknown id, another leaf's node or a tombstone fails `NodeNotFound` (a plain update never resurrects). |
| `restore(...)` | `update`, but allowed over a tombstone: the explicit resurrection surface. |
| `delete(id, { actor, expectedVersion?, root? })` | A tombstone carrying every column forward. Idempotent: on a tombstone it returns `alreadyDeleted: true` and writes nothing. |
| `refine({ id, from, patch, actor, keyed?, stable?, expectedVersion?, root? })` | On the target leaf: refines a node of `from`, a leaf above it on its path, to the target. It reads `from`'s head and checks `expectedVersion` there, sets the identity row's `type` (the arcs cascade it), inserts the stable rows of the levels the target adds (with `stable`), and appends an `update` at every level carrying `from`'s state with `patch` applied. An unknown, tombstoned or already-refined node fails `NodeNotFound`. See [Refining a node](#refining-a-node). |
| `restoreVersion(id, n, { actor, ... })` | Reads the whole snapshot at `n` (every level) first, and fails `VersionNotFound` before writing anything if any level is missing. Then it appends that snapshot as an `update`. |
| `getVersion(id, n)` / `history(id, limit?)` | One version's `{ version, action, timestamp, state }`. The chain oldest first, capped at `MAX_HISTORY_LIMIT` (1000). |

**A keyed leaf** (core's `keyed: { name, columns }`, such as a localised leaf's locales) also writes its keyed level on every append. `create` takes `keyed`, the whole level. `update` / `restore` take `keyed`, a per-key tri-state patch: a patch updates a key, `null` drops it, and an absent key carries it forward. `delete` and `restoreVersion` carry or restore every key, and `getVersion` returns them as `keyed`, keyed by key (`{}` for none).

**Stable columns** (core's `levels[name].stableColumns`, such as an external key unique across a leaf's nodes) are written once. `create` takes `stable`, keyed by field across the leaf's path, as `identity` is for the root. `update`, `restore`, `delete` and `restoreVersion` never touch a stable row, and there is no `setStable`; `refine` changes their `type` and adds the new levels' rows. A duplicate key fails the insert with the driver's error, which `./errors` classifies as a `UniqueViolation` under your constraint's name.

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

## Refining a node

A leaf with children (core's `defineTree` lets a leaf be a parent) is a type of its own whose nodes can later become one of its descendants: a bare `party` that turns out to be a `member`. Declare a level at or above it `refinable` in `makeTreeTables`, so every `(id, type)` arc below cascades a changed `type`, then call `refine` on the target leaf:

```ts
yield *
  chain.member.refine({
    id,
    from: "party",
    patch: { rank: 3 }, // must supply every required column the member levels add
    stable: { badge: "gold" },
    actor: userId,
    expectedVersion: 1n,
  });
```

It is the one chain write that changes a stable row. Without a cascading arc, the identity update fails with the driver's foreign-key violation. Versions before the refinement have no row at the added levels, so the target leaf reads none of them: `getVersion` fails `VersionNotFound` and its views fail closed. `history` lists them, and `from`'s view keeps showing the node, now under the target's `type`. A keyed level of `from` does not carry over; `keyed` is the target's own.
