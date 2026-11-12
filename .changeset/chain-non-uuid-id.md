---
"@thomasfosterau/effect-drizzle-ext-pg": patch
---

`./chain` now treats an id that isn't a UUID as an unknown node, without querying. `head` returns `Option.none()`. `update`, `restore`, `delete` and `history` fail `NodeNotFound`, and `getVersion` and `restoreVersion` fail `VersionNotFound`. Previously PostgreSQL rejected the id (`22P02`), which surfaced as a `SqlError` (a 500) and aborted the caller's transaction. Any spelling PostgreSQL's `uuid` input accepts (upper case, braces, no hyphens) still finds the node.
