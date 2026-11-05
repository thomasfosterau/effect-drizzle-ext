---
"@thomasfosterau/effect-drizzle-ext-pg": patch
---

`checkMigrationDrift` (`./tooling`) reads the snapshot chains drizzle-kit 1.0.0-rc.5 writes. Its snapshots are version `"9"`: a `base` and then `diff`s over it, with no full `ddl`. The guard used to reject every one as "doesn't match the drizzle-kit snapshot contract", so any migration generated with the pinned drizzle-kit failed the zero-drift check. It now rebuilds the latest state with drizzle-kit's own `reconstruct` over the whole chain, and still reads a full version `"8"` snapshot as-is.
