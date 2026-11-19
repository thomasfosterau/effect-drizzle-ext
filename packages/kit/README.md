# `@thomasfosterau/effect-drizzle-ext-kit`

`effect-drizzle-kit`, a command-line companion to drizzle-kit. It migrates the Postgres objects drizzle-kit doesn't manage (extensions, domains and composite types) into drizzle-kit's own custom migrations, and gates extras drift and schema drift in one `check`.

[![npm version](https://img.shields.io/npm/v/@thomasfosterau/effect-drizzle-ext-kit.svg)](https://www.npmjs.com/package/@thomasfosterau/effect-drizzle-ext-kit)

**Disclaimer:** This repository and package have been created using Claude Code. The package's API and functionality is in flux, so expect churn and breaking changes.

## Install

```bash
pnpm add --save-dev @thomasfosterau/effect-drizzle-ext-kit @thomasfosterau/effect-drizzle-ext-pg drizzle-kit drizzle-orm effect @effect/sql-pg @effect/platform-node
```

`effect` (`^4.0.0`), `@effect/platform-node` (`^4.0.0`), `@effect/sql-pg` (`^4.0.0`, the pg package's peer), `drizzle-orm` and `drizzle-kit` (`>=1.0.0-rc.5`) are peer dependencies. `@thomasfosterau/effect-drizzle-ext-pg` is a regular dependency: the commands are its `./tooling` generator and guards. Node.js 22.18 or newer is required, because the config module is loaded with Node's own type stripping.

## Example

```ts
// effect-drizzle-kit.config.ts, beside drizzle.config.ts
import { defineConfig } from "@thomasfosterau/effect-drizzle-ext-kit";
import { domain, extension } from "@thomasfosterau/effect-drizzle-ext-pg/tooling";
import * as schema from "./src/schema.ts";

export default defineConfig({
  migrationsDir: "migrations",
  drizzleKit: { config: "drizzle.config.ts" },
  extras: {
    extensions: [extension("citext")],
    domains: [domain("email", "citext", { notNull: true })],
  },
  schema, // optional: `check` then also runs the migration-drift gate
});
```

```bash
effect-drizzle-kit generate --name email-domain   # then: drizzle-kit generate
effect-drizzle-kit check                          # in CI
```

The [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/kit/overview.md) covers the config module, both commands and using them as a library.

## Entries

| Subpath | Contents | Guide |
| --- | --- | --- |
| `.` | `defineConfig`, `loadConfig`, the `generate` / `check` Effects and the `cli` command. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/kit/overview.md) |
| bin `effect-drizzle-kit` | `generate` and `check`, each taking `--config`. | [guide](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/kit/overview.md) |

## Links

- The [extras generator](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/docs/pg/tooling.md#extras-what-drizzle-kit-doesnt-manage) these commands run, in the pg package's `./tooling` guide.
- The [pg package](https://github.com/thomasfosterau/effect-drizzle-ext/blob/trunk/packages/pg/README.md), and the [changelog](CHANGELOG.md).

## License

MIT © Thomas Foster. Repository: [github.com/thomasfosterau/effect-drizzle-ext](https://github.com/thomasfosterau/effect-drizzle-ext), package directory `packages/kit`.
