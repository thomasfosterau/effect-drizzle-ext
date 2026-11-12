---
"@thomasfosterau/effect-drizzle-ext": minor
---

Three plain factories drop their `make*` prefix, which in Effect names service constructors; these build no service:

| Before                         | After                         | Entry              |
| ------------------------------ | ----------------------------- | ------------------ |
| `makeDeriveColumns`            | `deriveColumnsWith`           | `./derive`         |
| `makeDeriveResourceColumns`    | `deriveResourceColumnsWith`   | `./jsonapi/derive` |
| `makeDiscriminatorConstraints` | `discriminatorConstraintsFor` | `./constraints`    |

Their signatures and behaviour are unchanged.

**Migration:** rename the imports and calls, for example `const { fromFields } = deriveColumnsWith(builders, { resolveReference })`.
