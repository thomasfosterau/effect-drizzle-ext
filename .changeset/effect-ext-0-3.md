---
"@thomasfosterau/effect-drizzle-ext": patch
---

Accept `@thomasfosterau/effect-ext` `^0.2.0 || ^0.3.0`, so an app on effect-ext 0.3 installs one copy instead of a nested 0.2. The `./Ast` predicates and `LiteralExact.tuple` this package uses are unchanged in 0.3.0. (0.3.0 of this package shipped `^0.2.0` alone; its changelog's `^0.1.0 || ^0.2.0` was wrong about the 0.1 line, which isn't accepted.)
