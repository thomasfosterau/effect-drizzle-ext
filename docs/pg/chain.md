# `./Chain`

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
| `head(id)` / `load(id)` | The head's entry; `load` adds its state (and `keyed`), read with the version in one statement (a keyed leaf adds one for its keyed level). `Option.none()` for an id with no versions of this leaf. A tombstone's is its `delete` snapshot. |
| `setPointer({ pointer, id, version, at?, actor, expectedVersion? })` | Appends a fact to a named pointer's log (core's `root.pointers`): from `at` (now when absent) the pointer names `version`, or nothing for `Option.none()`. Never appends a version. Fails `NodeNotFound`, `VersionNotFound` for a version the node doesn't have, and `StaleVersion` under the precondition. |
| `getVersion(id, n)` / `history(id, limit?)` | One version's `{ version, action, timestamp, state }`. The chain oldest first, capped at `MAX_HISTORY_LIMIT` (1000). |

**A keyed leaf** (core's `keyed: { name, columns }`, such as a localised leaf's locales) also writes its keyed level on every append. `create` takes `keyed`, the whole level. `update` / `restore` take `keyed`, a per-key tri-state patch: a patch updates a key, `null` drops it, and an absent key carries it forward. `delete` and `restoreVersion` carry or restore every key, and `getVersion` returns them as `keyed`, keyed by key (`{}` for none).

**Stable columns** (core's `levels[name].stableColumns`, such as an external key unique across a leaf's nodes) are written once. `create` takes `stable`, keyed by field across the leaf's path, as `identity` is for the root. `update`, `restore`, `delete` and `restoreVersion` never touch a stable row, and there is no `setStable`; `refine` changes their `type` and adds the new levels' rows. A duplicate key fails the insert with the driver's error, which `./Errors` classifies as a `UniqueViolation` under your constraint's name.

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

## As an aggregate repository

A leaf is an aggregate type and its head version the concurrency token. Load, decide, then write with the version you loaded:

```ts
const rename = (id: string, title: string) =>
  transact(
    Effect.gen(function* () {
      const loaded = yield* chain.book.load(id);
      if (Option.isNone(loaded) || loaded.value.action === "delete") {
        return yield* new NodeNotFound({ type: "book", id });
      }
      return yield* chain.book.update({
        id,
        patch: { title },
        actor: userId,
        expectedVersion: loaded.value.version,
      });
    }),
  );
```

| Command | Write |
| --- | --- |
| Create (expected version: none) | `create`, which lands at version `0` and fails `NodeAlreadyExists` on a taken id, the "expected new" precondition. |
| Edit, tombstone, restore | `update`, `delete`, `restore`, `restoreVersion` with `expectedVersion`. A stale read fails `StaleVersion`; a race past the check fails `VersionConflict`. `delete` on a tombstone is a no-op that ignores the precondition. |
| Publish, schedule, unpublish | `setPointer`, with `expectedVersion` when the command was decided against the head. |
| One locale (a keyed fact) | `update({ id, patch: {}, keyed: { fr: { abstract } } })`: one version of the whole node, other keys carried forward. |

History and as-of reads stay plain reads (`history`, `getVersion`, core's views). A flat table that needs a version column but no history is [`./VersionedRow`](versioned-row.md).
