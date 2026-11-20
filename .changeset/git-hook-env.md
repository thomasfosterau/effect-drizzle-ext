---
"@thomasfosterau/effect-drizzle-ext-pg": patch
"@thomasfosterau/effect-drizzle-ext-kit": patch
---

`./tooling`'s base-migration reads and `effect-drizzle-kit`'s repository lookup clear `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_WORK_TREE` before running `git`, so the checkout named by `cwd` is the one read even when called from a git hook in a linked worktree.
