# Contributing

## Workflow

- The main branch is `trunk`. Branch off it and open a pull request into it; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk`; never merge `trunk` into your branch.
- Open a draft PR early, and keep one PR per change, however large.
- File an issue for anything out of scope rather than fixing it in passing or leaving a TODO. Keep issue bodies evergreen: edit the body as understanding improves.
- Dependabot keeps dependencies current (see [Dependencies](#dependencies)).

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node and pnpm and runs every task; use `vp exec <bin>`, not `npx`. `vp install` installs dependencies, the git hooks and, through `prepare`, the Effect-patched `tsc` and oxlint. A dev container (`.devcontainer/`) provides the same toolchain plus Docker for the integration suite.

| Command | What it does |
| --- | --- |
| `vp check` | Format (Oxfmt) and lint (Oxlint with the Effect presets, type-aware) |
| `vp run check` | Type gate: every package's `tsc`, plus `tests/dist-consumer` against the emitted declarations |
| `vp run -r test:unit` | Unit tests; `vp run -r test:coverage` adds the per-package thresholds |
| `vp run test:integration` | pg's integration suite on a fresh database: `PG*` → local server, else a Testcontainers `pgvector/pgvector:pg17`; an explicit `DATABASE_URL_TEST` / `DATABASE_URL` is used as-is |
| `vp run -r build` | `vp pack` → each package's `dist/` |
| `vp run docgen` | Type-checks and runs every JSDoc `@example` |
| `vp run ci` | Everything CI runs, in order |
| `vp test run tests/x.test.ts` | One test file, from inside its package |

[Fallow](https://docs.fallow.tools) reports dead code, boundaries, complexity and duplication; use it to polish your work, not as dogma. The pre-commit hook ([.vite-hooks/pre-commit](../.vite-hooks/pre-commit)) runs `vp staged` and then `vp run fallow:audit`, which refreshes the coverage map and fails only on findings your change introduces against `origin/trunk`. Before deleting "unused" code, trace it: `vp exec fallow dead-code --trace <file>:<export>`.

## Coding guidelines

- **Effect.** Use Effect v4 idioms throughout and prefer Effect's own modules (`Option`, `Array`, `Match`, `Schema`, `effect/sql`, …) over hand-rolled equivalents; convert existing code where practical. Exceptions: non-Effect APIs adapted at the edge (Drizzle, driver config) and hot paths where measurement shows plain code is needed. Read the installed `node_modules/effect` (it ships `AGENTS.md` and `ai-docs/`) rather than guessing at an API. Errors are `Schema.TaggedError` classes; module-load failures (table derivation) are thrown `DerivationError`, since no runtime exists yet.
- **Absence is `Option`**; optional members are `?: T`. The exception is config handed to Drizzle or `@effect/sql-pg`, which stays `?: T | undefined` because both read `undefined` as "not supplied".
- **Packages** depend on each other through their `exports`, in one direction: core ← pg ← kit (enforced by fallow's boundaries). No application vocabulary. Each package's `AGENTS.md` states its invariants.
- **Exports** follow Effect v4's layout: `index.ts` re-exports PascalCase module namespaces (`export * as Query from "./Query.ts"`), and each module is also importable through a PascalCase subpath (`./Query`). Older lowercase subpaths move to it in a breaking release.
- **Lint.** Fix findings in code. No inline disables; a site that genuinely can't take the fix gets a scoped override in `vite.config.ts` with its reason.
- **Comments.** A file-level comment only for real context, under 50 words. Doc comments where they add to IntelliSense, not restating the signature; every `@example` must compile and run under `vp run docgen`. Inline comments only for the non-obvious. No references to issues, PRs or history.
- **Tests** import from `vite-plus/test`; Effect tests use `@effect/vitest`'s `it.effect`. Test logic and edge cases, not what the type system or a lint enforces. Don't lower coverage thresholds.

## Before pushing

Run `vp run ci`, or one at a time: `vp check`, `vp run check`, `vp run -r test:unit`, `vp run test:integration` (PostgreSQL or Docker), `vp run -r build`, `vp run docgen`, `pnpm audit --audit-level high` (network). Say in the PR body which couldn't run.

CI ([ci.yml](../.github/workflows/ci.yml)) runs `vp run ci` on Node `lts` and `latest` against a PostgreSQL service container, with no secrets. Workflows pin actions by exact tag, locked to commits by `.github/workflows/actions.lock`: run `gh actions-lock` after changing a `uses:`. `uvx zizmor --offline .github` audits the workflows.

## Dependencies

Every external version lives in the `pnpm-workspace.yaml` catalog; package.json files use `catalog:`, `catalog:peers` or `workspace:`. After editing the catalog, run `vp install` and commit `pnpm-lock.yaml`.

Dependabot groups the sets that must move together (toolchain, effect, drizzle). On a toolchain PR, by hand: run `vp dlx --package=vite-plus@<v> vp migrate --no-interactive` to re-pin `vite` and `vitest`, then drop any `minimumReleaseAgeExclude` entries it adds; move `typescript` / `@typescript/native` only to a pair the new `@effect/tsgo` supports (see the catalog comment).

## Changesets

Every change to a published package's behaviour or its `.d.ts` (doc comments included, as a `patch`) needs a changeset: `vp exec changeset`. Docs-, CI- and tooling-only changes need none. The three packages are `linked`. Never version or publish by hand: see [PUBLISHING.md](PUBLISHING.md).
