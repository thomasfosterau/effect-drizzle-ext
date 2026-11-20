---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
---

A leaf level may now have children. `defineTree` no longer throws for a leaf with children: its name joins its own subtree leaves (so its discriminator CHECK), it gets a leaf view like any leaf, and the branch views above it gain its `CASE` arm. A tree with no such leaf derives exactly the DDL and view SQL it did before. `LeafName` no longer counts a bare `{}` marker as a leaf, so such a marker drops out of `views.leaves` and the chain's types, where it never had a runtime value.

`-pg/chain` adds `LeafChain.refine({ id, from, patch, actor, keyed?, stable?, expectedVersion? })`: on the target leaf, it refines a node of `from` (a leaf above it on its path) to the target in one write. It reads `from`'s head and checks the precondition there, sets the identity row's `type` (the refinable arcs cascade it), inserts the stable rows of the levels the target adds, and appends an `update` at every level carrying `from`'s state with `patch` applied. Earlier versions have no row at the added levels, so the target reads none of them. A non-refinable arc makes the identity update fail with the driver's foreign-key violation.
