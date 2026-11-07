---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

New subpath `./chain`: the version-chain discipline, written directly over the tables `makeTreeTables` derives (effect-drizzle-ext#117). `makeVersionChain({ tree, tables, CurrentTransaction })` returns a `LeafChain` per leaf with seven operations:

- `create`: never an upsert. A taken id fails `NodeAlreadyExists`.
- `update`: a tri-state carry-forward patch, written at `N_max + 1` on every level.
- `delete`: a tombstone that carries the state forward. Idempotent.
- `restore`: the only plain write over a tombstone.
- `restoreVersion`: reads every level first, and fails `VersionNotFound` before writing.
- `getVersion`
- `history`: bounded by `MAX_HISTORY_LIMIT`.

Every write to an existing node takes an `expectedVersion` precondition. A moved head fails `StaleVersion`. A writer that races between the read and the append loses the root `(id, version)` key and fails `VersionConflict`. The actor is a required `string | undefined`, and the root tables' injected columns ride along. Every operation requires the application's `CurrentTransaction`; the chain never opens a transaction itself. The error names and fields match pulpit's `version-chain`.
