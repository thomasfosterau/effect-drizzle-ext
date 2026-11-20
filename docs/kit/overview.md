# `effect-drizzle-kit`

_A guide to [`@thomasfosterau/effect-drizzle-ext-kit`](../../packages/kit/README.md). The API reference is the doc comments on each export (your editor's hover, or `vp run docgen`)._

drizzle-kit's postgres diff has no extensions, domains, composite types, functions or triggers. The pg package's `./Tooling` fills that gap with bin-less Effects ([guide](../pg/tooling.md#extras-what-drizzle-kit-doesnt-manage)). This package wraps them, together with the migration-drift gate, in a command an application runs next to `drizzle-kit`.

## The config module

`effect-drizzle-kit` reads `effect-drizzle-kit.config.ts` in the working directory, or the file `--config` / `-c` names. Its default export is a `defineConfig({ … })`:

| Member | What it is |
| --- | --- |
| `migrationsDir` | The drizzle-kit migrations directory. |
| `drizzleKit` | `{ config: "drizzle.config.ts" }` (its `out` must be `migrationsDir`) or `{ schema: "src/schema.ts" }`. |
| `extras` | Optional: `{ extensions, domains, compositeTypes, functions, triggers }`, built with `./Tooling`'s `extension`, `domain`, `compositeType`, `fn` and `trigger`. |
| `schema` | Optional: the Drizzle schema module (`import * as schema from "./src/schema.ts"`). When present, `check` also runs `checkMigrationDrift`. |
| `command` | Optional: how drizzle-kit is started, `["drizzle-kit"]` on `PATH` by default (which a package script has). |

Paths are relative to the config file's directory, and drizzle-kit runs there. The module is imported with Node's type stripping (Node 22.18+), so it and every module it imports must be erasable TypeScript whose relative imports carry their `.ts` extension, as this family's applications already write them. A missing file, a module that throws while importing, or a default export of the wrong shape is a `KitConfigError` naming the file.

## The commands

- **`effect-drizzle-kit generate [--name <slug>] [--rename <hint>]… [--record-only]`** runs **instead of** `drizzle-kit generate`. It plans the declared extras against the state recorded in `migrationsDir`, writes the before extras migration (extensions, domains, composite types; dropped triggers and functions), runs `drizzle-kit generate` with the terminal attached, then writes the after extras migration (functions and triggers; dropped types, domains and extensions), and prints each extras directory it wrote. `--name` is drizzle-kit's slug, and the extras migrations are `<slug>-extras-before` and `<slug>-extras-after`. A phase with nothing to do writes nothing. See the [guide](../pg/tooling.md#extras-what-drizzle-kit-doesnt-manage) for the order.
  - `--rename domain:<from>:<to>`, `compositeType:<from>:<to>` or `attribute:<type>:<from>:<to>` (repeatable) renames in place, in the before migration, instead of dropping and re-creating ([rename hints](../pg/tooling.md#extras-what-drizzle-kit-doesnt-manage)).
  - `--record-only` records the before migration's state and leaves its `migration.sql` for you to write, for a change the generator refuses, such as a domain's base type.
- **`effect-drizzle-kit check`** fails when the declared extras differ from the recorded state. When the config names `schema`, it then runs the migration-drift gate: DAG integrity, zero drift against the latest snapshot, and, in a pull request (`MIGRATION_BASE_REF`, or `GITHUB_BASE_REF` on GitHub Actions), base ancestry, with the migrations path taken relative to the repository root `git` reports. It needs no database.

A failure prints its message and exits 1. Both commands take `--help`, and the bin takes `--version`.

```jsonc
// package.json
{
  "scripts": {
    "db:generate": "effect-drizzle-kit generate",
    "db:check": "effect-drizzle-kit check",
  },
}
```

## As a library

The bin is `cli` run by `Command.run` over the Node services. A script that wants its own runtime, or a test, can run the pieces itself:

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { check, loadConfig } from "@thomasfosterau/effect-drizzle-ext-kit";
import * as Effect from "effect/Effect";

export const program = loadConfig("effect-drizzle-kit.config.ts").pipe(
  Effect.flatMap(check),
  Effect.provide(NodeServices.layer),
);
```

`Command.runWith(cli, { version })(["check", "--config", file])` runs the parsed command without the process's arguments. A handler failure then arrives as a `CliError.UserError` whose `cause` is the typed error (`ExtrasDriftError`, `MigrationDriftError`, `KitConfigError`, …).
