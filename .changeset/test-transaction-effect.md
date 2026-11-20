---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

`./testing`: `makeTestTransaction` also returns `inTestTransaction(effect)`, the always-rollback runner as an Effect for `@effect/vitest`'s `it.effect` inside a `layer(...)` block. It re-raises the spec's own failure in the error channel and makes a harness-transaction failure a defect. `runInTestTransaction` now runs through it, with the same rejections.
