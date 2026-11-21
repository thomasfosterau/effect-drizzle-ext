---
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

Chain writes shaped for aggregate repositories: `LeafChain.load` reads the head's state and version together, `LeafChain.setPointer` moves a named pointer (publish, schedule, clear) as a write of its own, and the new `./VersionedRow` entry gives a flat table optimistic concurrency (`versionColumn`, `makeVersionedRow`).
