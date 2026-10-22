---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

`dist/` is now built with `vp pack` (tsdown) instead of a per-module `tsc` emit. Every `exports` subpath and its `.js` / `.d.ts` path are unchanged. Code shared between subpaths is now bundled into the subpath files or into content-hashed declaration chunks, so `dist/` no longer has one file per source module: deep imports of files outside the exports map (for example `dist/provisioning.js` in the pg package) no longer resolve. The source maps omit `sourcesContent` and point at the `src/` files that ship beside `dist/`.
