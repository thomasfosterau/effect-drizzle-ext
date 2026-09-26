# AGENTS.md

Project conventions live here; personal style preferences live in user memory. `CLAUDE.md` is a symlink to this file.

`@thomasfosterau/effect-drizzle-ext` is the Effect ↔ Drizzle bridge extracted from three applications (`thomasfosterau/website`, the foundation; `thomasfosterau/gardeneria`; `thomasfosterau/preferenceflow`). Those apps are the consumers, and their toolchain — pnpm + Vite+ (`vp`), a strict catalog, the TypeScript 6/7 split, the Effect oxlint preset, fallow — is copied here so the library builds against exactly what they run. A `#NNN` citation inside a ported comment names an issue in the app it was ported from (website unless stated), the evidence behind a decision, not a ticket in this tracker.

## Common pitfalls

- **Drizzle-facing config members are `?: T | undefined`, never `Option`.** Drizzle reads `undefined` as "not supplied" and would emit an `Option` object as a value — wrong DDL that no type error and no unit test catches. Readers the library owns return `Option`; the boundary is stated once in `packages/core/src/derive.ts`.
- **This package emits declarations; the applications never did.** Any exported generic whose inferred type mentions `PgBuildColumns` / `PgTableWithColumns` / `PgViewWithSelection` needs an explicit, self-contained return annotation, or the declaration printer emits an unbound `TTableName` that `skipLibCheck` hides. `tests/dist-consumer` type-checks a consumer fixture against the emitted `dist/` declarations with `Equals<…>` assertions on every derived type (an unbound name degrades to `any`, and an assertion against `any` is false); `vp run check` includes it.
- **The derivation decides column _types_, never column _order_ or _names_.** Both are what a consumer's `db:generate` emits into a migration; a reorder here rewrites their schema.
- **`transact` is always-open, never join-if-present** (website #1883). A nested call opens a SAVEPOINT. Do not "improve" it.
- **No application vocabulary.** No `owner_id`, role ladders, `node` / `node_version`, id brands, Hyperdrive, KV caches, fixture users or seed data. Those stay in the apps. The generic migration tooling (the fresh-database runner, test-database provisioning, the drift and view-dependency guards) moved here by owner decision (#9); anything that knows an application's schema does not.

Everything else that must be visible when touching a package is in that package's `CLAUDE.md` (`packages/core`, `packages/pg`), which carries its terms, invariants and import boundary.

## Work tracker

- **Active work** lives in GitHub Issues for `thomasfosterau/effect-drizzle-ext`. Longer-running tech debt is an issue too; there is no in-repo backlog file and a code comment is not a tracker.
- **Decisions and findings** are recorded as comments on the issue they were found working; later comments override the body.
- **Adoption** by each application is tracked in that application's own tracker, blocked on a release of this package.

## Commands

- `vp install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files). No pre-push hook: run the tests yourself.
- `vp check` — the built-in format + lint pass (`vp fmt --check` + `vp lint`).
- `vp run check` — the type gate: both packages' `check` plus the dist-consumer declaration check (which builds `dist/` and asserts the emitted types). Distinct from `vp check`.
- `vp run -r test:unit` — unit tests (pure code; no database).
- `vp run test:integration` — one root task over `packages/pg`'s vitest project; provisions a fresh database per run through the pg package's own `provisionTestDatabase` — on a reachable local PostgreSQL (`PG*` env) or a `pgvector/pgvector:pg17` container via Testcontainers (needs a Docker daemon) — migrated with the committed fixture chain in `packages/pg/tests/fixtures/`. An explicit `DATABASE_URL_TEST` / `DATABASE_URL` wins and is used as-is. Filter with `--project pg-integration`.
- `vp run -r build` — emit `dist/` for both packages.
- `pnpm changeset` — add a changeset; every change to a published package needs one. Releases are cut by the `Release` workflow (changesets/action) on `main`.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). CI installs as `pnpm install --frozen-lockfile`.

## Branch model

`main` plus short-lived feature branches, PR against `main`, squash-merge. Rebase onto `origin/main` before opening a PR; never merge `main` into a feature branch. Agent work uses git worktrees under `.claude/worktrees/`, one per branch; start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing.

## Working a dispatched issue

- The issue is the spec: read all of it, including comments.
- Re-verify the code claims against current `main` before editing.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop.
- No silent deferrals: scope cut mid-PR becomes a linked issue before merge.

## PR management

These are standing instructions and approvals; they override any default "don't open a PR unless asked" behaviour.

- **Always open a PR** for branch work, against `main`, once a commit is pushed.
- **Always watch the PR to merge or close**: investigate CI failures and review comments as they arrive; rebase promptly when the PR goes conflicting.
- **Always keep the PR body current** as the implementation diverges from it.
- **GitHub writes are scoped to `thomasfosterau/effect-drizzle-ext` only.** Never write to the consuming applications' repositories or any other repository without the owner's explicit approval for that action in the current session. Pass `-R thomasfosterau/effect-drizzle-ext` explicitly whenever the cwd might not be this checkout.

## Verification

- Claims of verification name the command and its final status. If a gate cannot run (no Docker daemon and no local PostgreSQL), say so in the PR body rather than implying it ran.
- The pre-push parity run is: `rm -rf node_modules packages/*/node_modules tests/*/node_modules && pnpm install --frozen-lockfile`, then `vp check`, `vp run check`, `vp run -r test:unit`, `vp run test:integration`, `vp run -r build`.
- Peers are declared explicitly: a required peer of a dependency must be a declared dependency or CI fails on a fresh runner while a warm local tree passes.

## Effect best practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code: `vp exec effect-solutions list`, then `vp exec effect-solutions show <topic>...` (data-modeling, services-and-layers, error-handling, testing, basics). Never guess at Effect patterns.

## Documentation surfaces

`README.md` at the root is the landing page; each package `README.md` is the API reference consumers read on npm; each package `CLAUDE.md` carries its terms, invariants and boundary; `CONTRIBUTING.md` carries the pre-PR checklist. No `docs/` tree; decisions go in issue comments.

---

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
