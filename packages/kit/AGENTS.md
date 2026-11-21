# @thomasfosterau/effect-drizzle-ext-kit

`effect-drizzle-kit`, the bin over the pg package's `./Tooling`: `generate` (the extras migration) and `check` (extras drift, plus schema drift when the config names its schema module). The bin lives here so the pg package's `./Tooling` stays bin-less.

## Boundary

May import from `packages/pg` only (`.fallowrc.json` zone `kit`), and only from its `./Tooling` subpath. Every command is a thin wrapper: the planning, the state file and the drift rules live in pg's `./Tooling`, not here.

## Invariants

- **The config is a TypeScript module imported with Node's own type stripping**, never a bundler or a loader dependency (`engines` is Node 22.18+). `loadConfig` checks its default export against the typed `KitConfig` values (`Schema.toType` of pg's `Extension` / `Domain` / `CompositeType`), not an encoding.
- **Paths in the config resolve against the config file's directory**, and drizzle-kit runs there.
- **A handler failure reaches the user as one message**: the bin's handlers map every typed failure to `CliError.UserError` (the typed error is its `cause`), so `Command.run` prints the message and exits 1, not a stack trace. `generate` and `check` (the exported Effects) keep the typed errors.
- `bin.ts` only wires the runtime: `cli` + `Command.run` + `NodeServices.layer` + `NodeRuntime.runMain`. Its `#!` line survives `vp pack`; `publishConfig.bin` points at `dist/bin.js`, built from the workspace `bin` of the same name (`vite.package.ts`).

## Terms

- **Config module**: `effect-drizzle-kit.config.ts`, whose default export is `defineConfig({ migrationsDir, drizzleKit, extras?, schema?, command? })`.
- **Extras**: as in [pg's AGENTS.md](../pg/AGENTS.md#terms).
