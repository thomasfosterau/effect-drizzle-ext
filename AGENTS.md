# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; this file adds only what is specific to agents. Each package's `AGENTS.md` ([core](packages/core/AGENTS.md), [pg](packages/pg/AGENTS.md), [kit](packages/kit/AGENTS.md)) holds its boundary and invariants: read it before changing that package.

## Process

- You may open pull requests in this repository, with the GitHub MCP tools or `gh`, whichever is available. GitHub writes go to `thomasfosterau/effect-drizzle-ext` only.
- When you spot work outside your task, file an issue and move on.
- Write idiomatic Effect (see docs/CONTRIBUTING.md). Non-idiomatic code you find: fix it if trivial, otherwise file an issue naming the sites and the idiomatic replacement.
- Before reporting work as done, run the gates in docs/CONTRIBUTING.md and say which passed and which couldn't run (`vp run test:integration` needs PostgreSQL or Docker).

## Pitfalls

- **No application vocabulary.** The consuming applications' owners, roles, id brands, caches, fixtures and level names stay in the apps; the generic versioned-ontology vocabulary (trees, levels, leaves, chains) is the library's.
- **Emitted declarations are the product.** An inferred type that mentions Drizzle's table or view types can emit as `any`; `tests/dist-consumer` (run by `vp run check`) is the gate.
- **Derived SQL is a migration for every consumer.** Changing the emitted DDL or view SQL recreates objects in their next `drizzle-kit generate`; see core's `AGENTS.md`.
- **`effect-tsgo patch` is version-locked.** `@effect/tsgo`, `@typescript/native` and `vite-plus` move together, or `vp install` fails.
- **Publish only through the Release workflow** (`vp run release`: `vp pm publish -r`, then `changeset git-tag`). Release-path registry calls go through `vp pm`, never `npm` / `pnpm` directly, and `release` depends only on the builds.
- **Declare every required peer of a dependency.** A missing one passes on a warm tree and fails on a fresh CI runner.

## Pull requests

- **Write the PR body with the `pr` skill** from Matt Pocock's skills (`mattpocock-skills:pr`), filling in the repository's pull request template where there is one.
- **Resolve merge conflicts before you hand a PR over.** Rebase onto `origin/trunk` and push; a PR that conflicts with `trunk` isn't finished.
- **Mark the PR ready for review as soon as the initial draft is finished.** Don't wait for CI to run, for reviews, or for the owner to do it. Keep fixing CI failures and review findings on the ready PR.

## Fallow

The `fallow` agent skill is linked into `.claude/skills/` from the installed `fallow` package after `vp install`, and drizzle-kit's `drizzle` skill is linked the same way; repository-specific rules (the pre-commit audit, tracing before deleting) are in docs/CONTRIBUTING.md.
