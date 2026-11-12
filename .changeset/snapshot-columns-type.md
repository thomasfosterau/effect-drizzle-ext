---
"@thomasfosterau/effect-drizzle-ext": patch
---

`VersionSnapshot["columns"]` is spelled `Readonly<InferSelectModel<PgTable>>`, Drizzle's select row of an erased table, instead of a hand-written `Readonly<Record<string, unknown>>`. The two are assignable to each other, so no caller changes.
