---
"@thomasfosterau/effect-drizzle-ext": minor
"@thomasfosterau/effect-drizzle-ext-pg": minor
"@thomasfosterau/effect-drizzle-ext-kit": patch
---

**Breaking:** adopt Effect v4's export layout. Every module is a PascalCase subpath, and each package root re-exports modules as namespaces instead of flat names. Function and type names are unchanged; only their import paths move.

Upgrade by renaming subpaths:

| Package | Old subpath | New subpath |
| --- | --- | --- |
| core | `.` (flat `dbColumn`, `dbTable`, `defineTree`, `DerivationError`, `VersionChainEntry`, …) | `./Annotation`, or the root's `Annotation` namespace |
| core | `./derive`, `./references`, `./constraints`, `./columns`, `./query`, `./sort`, `./update`, `./errors`, `./database` | `./Derive`, `./References`, `./Constraints`, `./Columns`, `./Query`, `./Sort`, `./Update`, `./Errors`, `./Database` |
| core | `./query-functions`, `./versioned-chain`, `./postgis` | `./QueryFunctions`, `./VersionedChain`, `./PostGis` |
| core | `./jsonapi`, `./jsonapi/derive` | `./JsonApi`, `./JsonApiDerive` |
| pg | `.` (flat `makePgDatabase`, `pgClientFromUrl`, `pgClientFromPool`, `PgDatabase*` types) | `./PgDatabase`, or the root's `PgDatabase` namespace |
| pg | `./chain`, `./migrations`, `./testing`, `./tooling` | `./Chain`, `./Migrations`, `./Testing`, `./Tooling` |

```ts
// before
import { dbColumnFor } from "@thomasfosterau/effect-drizzle-ext";
import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/derive";
import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg";

// after
import { dbColumnFor } from "@thomasfosterau/effect-drizzle-ext/Annotation";
import { deriveColumnsWith } from "@thomasfosterau/effect-drizzle-ext/Derive";
import { makePgDatabase } from "@thomasfosterau/effect-drizzle-ext-pg/PgDatabase";
```

The core root stays Drizzle-free: it re-exports `Annotation`, `Errors`, `Predicate` and `Update`, plus the `PostGis` namespace as before. Modules that import Drizzle are subpaths only. The pg root re-exports every module except `Tooling`, which needs the optional `drizzle-kit` peer. `./Predicate`, `./Where`, `./Search`, `./Tin`, `./Outbox`, `./Documents` and `./ExternalIds` keep their paths.
