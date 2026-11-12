---
"@thomasfosterau/effect-drizzle-ext": patch
---

`BuilderFor` (and with it `DerivedColumns` / `DerivedResourceColumns`) now applies Drizzle's `HasDefault` when a `dbColumn` annotation declares a `default`, matching the `.default(value)` the derivation applies at runtime. A defaulted column is optional on the table's `$inferInsert`. An app carrying a local `WithDefaults` workaround can drop it.
