---
"@thomasfosterau/effect-drizzle-ext": patch
---

`makeSubtypeTables` (and so `makeTreeTables`) now gives each version table's `(id, version)` → parent-version foreign key `ON DELETE CASCADE` (effect-drizzle-ext#145). Before this, deleting a node whose leaf sits two or more levels deep failed on that FK, because its NO ACTION check ran before the stable-table cascade reached the level's version rows. So erasing a node's whole chain (`DELETE` of its identity row) only worked for a leaf directly under the root. Regenerating a consumer's migrations emits one `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT … ON DELETE CASCADE` per level version table.
