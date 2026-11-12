---
"@thomasfosterau/effect-drizzle-ext": minor
---

`makeTreeTables` now throws `DerivationError` at module load when an injected column shares a key with one its table already has, naming the key and both sources. Previously the injected column silently replaced the other. The check covers:

- `root.identityColumns` against `id` / `type`;
- `root.versionColumns` against `id` / `version` / `action` / `timestamp` / `actor`;
- a level's `columns` hook against that level's tree columns and `id` / `version`.

Trees without a clash emit the same DDL.

**Migration:** rename the injected key.
