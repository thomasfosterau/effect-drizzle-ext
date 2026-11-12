# AGENTS.md

Project conventions for every coding agent live here; Claude Code reads them through [`.claude/CLAUDE.md`](.claude/CLAUDE.md), which adds only what is specific to Claude Code (its hooks, settings, worktrees and session limits). Personal style preferences live in user memory.

This repo publishes the Effect ↔ Drizzle bridge as two npm packages, `@thomasfosterau/effect-drizzle-ext` (`packages/core`) and `@thomasfosterau/effect-drizzle-ext-pg` (`packages/pg`), extracted from three applications (`thomasfosterau/website`, the foundation; `thomasfosterau/gardeneria`; `thomasfosterau/preferenceflow`). Those apps are the consumers, and their toolchain — pnpm + Vite+ (`vp`), a strict catalog, the TypeScript 6/7 split, the Effect oxlint preset, fallow — is copied here so the library builds against exactly what they run. A `#NNN` citation inside a ported comment names an issue in the app it was ported from (website unless stated), the evidence behind a decision, not a ticket in this tracker; a reference to this tracker is written `effect-drizzle-ext#NNN`.

## Common pitfalls

- **No application vocabulary.** No `owner_id`, owner / viewer / role vocabulary, id brands, Hyperdrive, KV caches, fixture users or seed data, and no application's own level names. Those stay in the apps. The generic versioned-ontology vocabulary is the library's (effect-drizzle-ext#112, decision 2): a level tree (`defineTree`), its markers, leaves and level columns, and the node / node-version root a tree derives. The generic migration tooling (the fresh-database runner, test-database provisioning, the drift and view-dependency guards) moved here by owner decision (effect-drizzle-ext#9); anything that knows an application's schema does not.
- **Declare every required peer of a dependency.** A missing one passes on a warm local tree and fails CI on a fresh runner.

Package-local invariants, terms and import boundaries live only in each package's `AGENTS.md` ([`packages/core`](packages/core/AGENTS.md), [`packages/pg`](packages/pg/AGENTS.md)); read it before changing that package. Each package's `CLAUDE.md` is the one line `@AGENTS.md`.

## Conventions

- **Absence is `Option`; optional members are bare `?: T`, except at a Drizzle or driver boundary** (effect-drizzle-ext#105). A value that may be absent is an `Option`; an Option-valued optional property is `x?: Option.Option<T>`, an options-bag member `readonly x?: T` (no `| undefined`), an optional parameter `x?: T`. Under `exactOptionalPropertyTypes` a caller omits an absent member rather than passing `undefined`. The exception is config handed to Drizzle (core's `DbColumn`, `derive.ts`, `./versioned-chain`'s builder config) or to `@effect/sql-pg`'s `PgPoolConfig` (pg's client and test layers): it stays `?: T | undefined`, because both read `undefined` as "not supplied" and would emit an `Option` object as a value, which is wrong DDL or config that no type error and no unit test catches. Drizzle's own row types stay `T | null`. Those files sit under `prefer-option-over-null`'s scoped override in `vite.config.ts`. Readers the library owns return `Option`.
- **Relative imports carry their `.ts` extension** (`rewriteRelativeImportExtensions` in `tsconfig.base.json`).
- **Tests import from `vite-plus/test`**, never `vitest`; a test that runs an Effect is `@effect/vitest`'s `it.effect` (`import { it } from "@effect/vitest"`), never `Effect.runPromise` / `runSync` in a test body.
- **Every export has a doc comment** whose first sentence stands alone in a hover; say what fails and how (thrown at module load vs the Effect error channel).
- **Workspace `exports` point at `src/`; `publishConfig.exports` at `dist/`.** In-repo consumers see sources; only `tests/dist-consumer` (through tsconfig `paths`) checks what npm consumers get.
- **`dist/` is a `vp pack` (tsdown) bundle, one entry per `publishConfig.exports` subpath** (the family default; effect-drizzle-ext#88). `packageBuild` in `vite.package.ts` derives the entries from each `package.json`, so a new subpath is one `exports` entry plus one `publishConfig.exports` entry. Declarations come from the native TS7 compiler (`dts.generator: "tsgo"`, the same binary `check` runs) and are then bundled; shared code lands in content-hashed chunks. The dist-consumer gate asserts the bundled declarations, and the declaration-emit hazards core's `AGENTS.md` names are pinned against them.
- **Every `@example` compiles and runs** under `vp run docgen`: write it as a self-contained module (its imports included) that builds its Effect without touching a database, Docker or git.
- **Lint: the Effect preset at `error`.** `@enfect/oxlint`'s `recommended` (the `effect/*` rules, anti-slop included) and `@effect/tsgo`'s preset apply at their own severities, `effect/casting-awareness` and `typescript/no-unsafe-type-assertion` included; both are off only in the type-erasure seam files `vite.config.ts` lists, with the reason per site (effect-drizzle-ext#104). Namespace imports take the preset's canonical aliases (`Arr` for `effect/Array`, `P` for `effect/Predicate`, `R` for `effect/Record`; every other module under its own name, as in `import * as Option from "effect/Option"`). On top of them run oxlint's `correctness`, `suspicious` and `perf` categories over the `eslint`, `typescript`, `unicorn`, `oxc`, `import`, `promise`, `vitest` and `jsdoc` plugins, plus `vite-plus/prefer-vite-plus-imports`; each relaxed rule carries its reason in `vite.config.ts`. Fix a finding by changing the code to the Effect shape the rule names. **No inline `oxlint-disable` comments** (effect-drizzle-ext#105): a site that genuinely can't take the fix (a Drizzle or driver boundary, a documented type-erasure seam, a file that runs before any Effect runtime exists) goes in a scoped `overrides` entry in `vite.config.ts` that lists the files and gives the reason. fallow's audit reports a new inline suppression as `added-suppression`.

## Commands

The commands, what each gate covers and the single-check variants are in [CONTRIBUTING.md → Commands](CONTRIBUTING.md#commands). Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`).

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran.

1. From a clean install, which is what CI sees: `rm -rf node_modules packages/*/node_modules tests/*/node_modules && pnpm install --frozen-lockfile`.
2. `vp check`
3. `vp run check`
4. `vp run -r test:unit`
5. `vp run test:integration` (needs Docker or PostgreSQL; a session without either says so in the PR body and relies on CI)
6. `vp run -r build`
7. `vp run docgen`
8. `pnpm audit --audit-level high` (network)
9. `vp run test:coverage`, then `vp exec fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` (the fallow gate; not a CI step). The PreToolUse gate reads the coverage map on disk and never refreshes it, so run `test:coverage` first.

Steps 2–8 are CI's job, in CI's order ([ci.yml](.github/workflows/ci.yml)). CI holds a read-only token and no secrets or OIDC, so Dependabot PRs run it safely; every action is pinned to a commit SHA, checkout never persists credentials outside the Release job, and only the Release job holds `id-token: write` (never for Dependabot). `uvx zizmor .github` audits the workflows (config in `.github/zizmor.yml`). `CONTRIBUTING.md` and the PR template link here rather than restating the list.

## Branches and pull requests

- Branch off `trunk`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Every change to a published package's behaviour carries a changeset (`pnpm changeset`). Changes to doc comments that reach the emitted `.d.ts` (TSDoc) take a `patch` changeset; other docs-only changes (READMEs, guidance), CI and tooling need none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR (`chore: version packages`) and the owner merges it. Publishing is npm trusted publishing (OIDC) from the protected `release` environment; there is no `NPM_TOKEN`.
- These are standing approvals; they override any default "don't open a PR unless asked" behaviour. **Always open a PR** against `trunk` once a commit is pushed. **Watch it to merge or close**: investigate CI failures and review comments as they arrive, and rebase promptly when it goes conflicting. **Keep the PR body current** as the implementation diverges from it.
- GitHub writes go to `thomasfosterau/effect-drizzle-ext` only — never to the consuming applications' repositories or any other repository without the owner's explicit approval for that action in the current session. Pass `-R thomasfosterau/effect-drizzle-ext` whenever the cwd might be another checkout. Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available.

## Work tracker

- Issues in `thomasfosterau/effect-drizzle-ext` are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. There is no in-repo backlog file.
- The issue is the spec — read its comments; later comments override the body. Re-verify its code claims against current `trunk` before editing.
- Record decisions and findings as comments on the issue they were found working.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop.
- Scope cut mid-PR becomes a linked issue before merge.
- Adoption by each application is tracked in that application's own tracker, blocked on a release of this package.

## Effect

Read the installed package before writing Effect code: `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` (the pinned version ships both), then the declarations and sources (`node_modules/effect/dist/*.d.ts`, `node_modules/effect/src`). Never guess at an Effect API.

- The pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peers are under `catalogs.peers`. The `effect` (and `@effect/sql-pg`) peer is `^4.0.0`; raise it only when a dependency requires it, naming the dependency in the catalog comment.
- Tagged errors are `Schema.TaggedError<Self>()(tag, fields)` classes (the rc spelling; `Schema.TaggedErrorClass` was the beta-line name).
- Failures at module load (table derivation) are thrown `DerivationError`, never Effect failures, because no runtime exists yet; query-time failures travel in the Effect error channel.
- SQL modules are `effect/sql/*` (not `effect/unstable/sql/*`) since rc.118.

## Documentation surfaces

`README.md` at the root is the landing page; each package `README.md` is the API reference consumers read on npm (cross-package links are absolute GitHub URLs, so they work there); each package `AGENTS.md` carries its boundary, invariants and terms (it is not published; the package `CLAUDE.md` imports it); `.claude/CLAUDE.md` carries what is specific to Claude Code; `CONTRIBUTING.md` carries human setup, hooks, CI expectations and single-check commands; `PUBLISHING.md` the release flow and its one-time owner setup; `SECURITY.md` the reporting channel and supply-chain posture. No committed `docs/` tree (docgen's output is gitignored); decisions go in issue comments.

---

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
