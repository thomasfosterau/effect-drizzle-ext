---
"@thomasfosterau/effect-drizzle-ext-pg": patch
"@thomasfosterau/effect-drizzle-ext-kit": patch
---

`./chain` writes no longer turn a unique violation of a constraint other than the chain's own (a consumer's unique external key on a stable table, say) into a defect: it stays the driver's error in the typed channel, as `create`'s documentation already said, so `classifyErrors` and `catchUniqueViolation` can recover it. Code that caught it as a defect (`Effect.catchDefect`, `Cause.hasDies`) should catch the failure instead.

The provisioning, migration and `./tooling` entry points, and kit's commands, are now `Effect.fn` functions, so each run is a tracing span (`Testing.*`, `Migrations.*`, `Tooling.*`, `Commands.*`). The test database name is hashed through `effect/crypto`'s `Digest`; the name is unchanged.
