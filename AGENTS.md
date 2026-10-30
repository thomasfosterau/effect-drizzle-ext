# AGENTS.md

`CLAUDE.md` is a symlink to this file. Project conventions live here; personal style preferences live in user memory.

This repo publishes the Effect ↔ Drizzle bridge as two npm packages, `@thomasfosterau/effect-drizzle-ext` (`packages/core`) and `@thomasfosterau/effect-drizzle-ext-pg` (`packages/pg`), extracted from three applications (`thomasfosterau/website`, the foundation; `thomasfosterau/gardeneria`; `thomasfosterau/preferenceflow`). Those apps are the consumers, and their toolchain — pnpm + Vite+ (`vp`), a strict catalog, the TypeScript 6/7 split, the Effect oxlint preset, fallow — is copied here so the library builds against exactly what they run. A `#NNN` citation inside a ported comment names an issue in the app it was ported from (website unless stated), the evidence behind a decision, not a ticket in this tracker; a reference to this tracker is written `effect-drizzle-ext#NNN`.

## Common pitfalls

- **No application vocabulary.** No `owner_id`, role ladders, `node` / `node_version`, id brands, Hyperdrive, KV caches, fixture users or seed data. Those stay in the apps. The generic migration tooling (the fresh-database runner, test-database provisioning, the drift and view-dependency guards) moved here by owner decision (effect-drizzle-ext#9); anything that knows an application's schema does not.
- **Declare every required peer of a dependency.** A missing one passes on a warm local tree and fails CI on a fresh runner.

Package-local invariants, terms and import boundaries live only in each package's `CLAUDE.md` ([`packages/core`](packages/core/CLAUDE.md), [`packages/pg`](packages/pg/CLAUDE.md)); read it before changing that package.

## Conventions

- **Optional members are `?: T | undefined`, never bare `?: T`, and never `Option` at a Drizzle or driver boundary.** `exactOptionalPropertyTypes` is on, so a bare `?:` rejects a caller forwarding its own optional. Config handed to Drizzle (core's `derive.ts`) or to `@effect/sql-pg`'s `PgPoolConfig` (pg's client and test layers) stays `?: T | undefined` because both read `undefined` as "not supplied" and would emit an `Option` object as a value — wrong DDL or config that no type error and no unit test catches. Readers the library owns return `Option`.
- **Relative imports carry their `.ts` extension** (`rewriteRelativeImportExtensions` in `tsconfig.base.json`).
- **Tests import from `vite-plus/test`**, never `vitest`.
- **Every export has a doc comment** whose first sentence stands alone in a hover; say what fails and how (thrown at module load vs the Effect error channel).
- **Workspace `exports` point at `src/`; `publishConfig.exports` at `dist/`.** In-repo consumers see sources; only `tests/dist-consumer` (through tsconfig `paths`) checks what npm consumers get.
- **`dist/` is a `vp pack` (tsdown) bundle, one entry per `publishConfig.exports` subpath** (the family default; effect-drizzle-ext#88). `packageBuild` in `vite.package.ts` derives the entries from each `package.json`, so a new subpath is one `exports` entry plus one `publishConfig.exports` entry. Declarations come from the native TS7 compiler (`dts.generator: "tsgo"`, the same binary `check` runs) and are then bundled; shared code lands in content-hashed chunks. The dist-consumer gate asserts the bundled declarations, and the declaration-emit hazards core's `CLAUDE.md` names are pinned against them.
- **Every `@example` compiles and runs** under `vp run docgen`: write it as a self-contained module (its imports included) that builds its Effect without touching a database, Docker or git.
- **Lint: the Effect preset at `error`.** `@enfect/oxlint`'s `recommended` (the `effect/*` rules, anti-slop included) and `@effect/tsgo`'s preset apply at their own severities, apart from `casting-awareness` (a warning by design) and `prefer-namespace-imports` (off); `vite.config.ts` says why. On top of them run oxlint's `correctness`, `suspicious` and `perf` categories over the `eslint`, `typescript`, `unicorn`, `oxc`, `import`, `promise`, `vitest` and `jsdoc` plugins, plus `vite-plus/prefer-vite-plus-imports`; each relaxed rule carries its reason in `vite.config.ts`. Fix a finding by changing the code to the Effect shape the rule names. An `oxlint-disable-next-line effect/<rule> -- <reason>` is for a site that can't take that fix (a Drizzle, drizzle-kit or driver boundary, `process.env`'s shape, a public signature that can't change compatibly), and the reason is specific.

## Commands

- `vp install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files). There is no pre-push hook.
- `vp check` — format + lint (Oxfmt + Oxlint, type-aware through oxlint-tsgolint with `typeCheck` on, so it also reports TypeScript errors in the root configs no tsconfig covers); `vp check --fix` to autofix. `vp run check` — the type gate: both packages' `check` plus the dist-consumer declaration check (which builds `dist/` and asserts the emitted types). They are different commands.
- `vp run -r test:unit` — unit tests (pure code; no database).
- `vp run test:integration` (Docker or PostgreSQL) — one root task over `packages/pg`'s vitest project; provisions a fresh database per run through the pg package's own `provisionTestDatabase`: an explicit `DATABASE_URL_TEST` / `DATABASE_URL` (from the environment, then `.env`) is used as-is and must already hold the fixture chain; otherwise a reachable local PostgreSQL (`PG*` env), else a `pgvector/pgvector:pg17` container via Testcontainers, migrated with the committed fixture chain in `packages/pg/tests/fixtures/`. Filter with `--project pg-integration`.
- `vp run -r build` — emit `dist/` for both packages.
- `vp run docgen` — `@effect/docgen` over both packages: type-checks and runs every JSDoc `@example` (`runExamples`); output in the gitignored `packages/*/docs/`.
- `vp run test:coverage` — both unit suites under one Istanbul map at `coverage/coverage-final.json` (`vitest.coverage.config.ts`), which `fallow audit` reads for exact CRAP scores. The per-package thresholds run with `vp run -r test:coverage`.
- `pnpm changeset` — add a changeset.
- Toolchain moves are one set: `vite-plus` (and its `vite` / `vitest` / `@vitest/coverage-istanbul` pins), `@effect/tsgo`, `@typescript/native` and `@enfect/oxlint`, after checking `@effect/tsgo`'s `components` table (`pnpm-workspace.yaml`'s comments say how); Dependabot's `toolchain` group proposes them in one PR (`.github/dependabot.yml` groups every lockstep set: `toolchain`, `effect`, `docgen`, `drizzle`, `testcontainers`, `changesets`, `fallow`, `github-actions`). By hand, on that PR's branch, because Dependabot can't move them: the npm-alias entries `vite` (always the vite-plus version; `pnpm exec vp migrate` re-pins it, then drop the `minimumReleaseAgeExclude` entries it adds), `typescript` and `@typescript/native`. The `overrides` literals in `pnpm-workspace.yaml` are by hand too: the `@grpc/grpc-js` security override is a transitive pin to revisit whenever the `testcontainers` group moves, and the `undici` / `launch-editor` floors come out once their comments' conditions hold. `minimumReleaseAge` holds a new version for 8 hours; Dependabot's `cooldown` is 1 day (its smallest unit).

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). CI installs as `pnpm install --frozen-lockfile`. Single-check variants are in [CONTRIBUTING.md](CONTRIBUTING.md#running-individual-checks).

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran.

1. From a clean install, which is what CI sees: `rm -rf node_modules packages/*/node_modules tests/*/node_modules && pnpm install --frozen-lockfile`.
2. `vp check`
3. `vp run check`
4. `vp run -r test:unit`
5. `vp run test:integration` (needs Docker or PostgreSQL; see [Agent sessions](#agent-sessions))
6. `vp run -r build`
7. `vp run docgen`
8. `pnpm audit --audit-level high` (network)
9. `vp run test:coverage`, then `fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` (the fallow gate below; not a CI step). The PreToolUse gate reads the coverage map on disk and never refreshes it, so run `test:coverage` first.

Steps 2–8 are CI's job, in CI's order ([ci.yml](.github/workflows/ci.yml)). CI holds a read-only token and no secrets or OIDC, so Dependabot PRs run it safely; every action is pinned to a commit SHA, checkout never persists credentials outside the Release job, and only the Release job holds `id-token: write` (never for Dependabot). `uvx zizmor .github` audits the workflows (config in `.github/zizmor.yml`). `CONTRIBUTING.md` and the PR template link here rather than restating the list.

## Branches and pull requests

- Branch off `trunk`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Agent work uses git worktrees under `.claude/worktrees/`, one per branch, named `issue-<n>-<slug>` for issue-linked work. Start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing.
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

- The pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peer floor is under `catalogs.peers`.
- Tagged errors are `Schema.TaggedError<Self>()(tag, fields)` classes (the rc spelling; `Schema.TaggedErrorClass` was the beta-line name).
- Failures at module load (table derivation) are thrown `DerivationError`, never Effect failures, because no runtime exists yet; query-time failures travel in the Effect error channel.
- SQL modules are `effect/sql/*` (not `effect/unstable/sql/*`) since rc.118.

## Agent sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile and puts `vp` (a re-exec shim that prefers the nearest worktree's `node_modules`) and `fallow` on PATH for non-interactive shells. It hydrates no secrets; none are needed. `.claude/settings.json` enables the `@enfect/claude` plugin (Effect guidance, skills and post-write pattern checks), pinned to a reviewed `mpsuesser/enfect` commit. A worktree needs its own `pnpm install` before `vp` runs in it; without one, `describe()` throws `Cannot read properties of undefined (reading 'config')`.
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`, generated by `fallow hooks install --target agent --agent claude` with marked local edits for the base, the audit directory, how it reports a skipped audit and the one-line version (effect-drizzle-ext#73), all re-applied by hand after a `fallow hooks install --force`) blocks `git commit` / `git push`, including with git global options such as `git -C dir commit` or `git --no-pager push`, when `fallow audit` against the default branch (`FALLOW_AUDIT_BASE` if set, else `origin/HEAD` when it resolves, else `origin/trunk`) returns `fail`. When no base ref resolves locally it blocks too, naming the fix: `git fetch origin trunk:refs/remotes/origin/trunk`, `git remote set-head origin --auto` for a stale `origin/HEAD`, or a `FALLOW_AUDIT_BASE` that exists (effect-drizzle-ext#61). The exception is a checkout with no `origin` remote (a scratch `git init` repo), which has nothing to fetch: there it skips the audit with a notice, wherever the base is resolved (the directory Claude Code runs it in, a `cd` / `-C` target, or either half of a both-audits run). That exception doesn't cover this project: a checkout that shares its git directory (`git rev-parse --path-format=absolute --git-common-dir` equal to the one in `$CLAUDE_PROJECT_DIR`, so the primary checkout and its worktrees) still blocks after its `origin` is renamed or removed, and names `git remote add origin …` or a `FALLOW_AUDIT_BASE` set in Claude Code's environment as the fix (effect-drizzle-ext#71). `FALLOW_AUDIT_BASE` is read from the hook's environment, which is Claude Code's, so set it there (exported before Claude Code starts); a `FALLOW_AUDIT_BASE=… git commit` prefix on the command doesn't reach the hook. It fails open on a runtime error (jq or fallow missing, fallow's own error JSON, an unexpected exit code) or outside a git checkout, and every fail-open or fallback notice reaches both the user (`systemMessage`) and the agent (`additionalContext`) as hook JSON; a passing audit and a command that isn't a `git commit` / `git push` print nothing, except without jq: the hook can't parse the command then, so any Bash call whose hook input (the command, its description, the cwd, the transcript path) contains `commit` or `push` (`echo push`, or `git log` described as "Show recent commits", included) prints the jq-missing notice. A notice means the write went through without a full audit, so run the audit yourself in the checkout it targets (see [Verification](#verification)). It audits the checkout the command targets (effect-drizzle-ext#58). For the one shape it models (leading `cd <dir>` segments, then plain `git` commands, then the `git commit` / `git push` with any `-C <dir>`, joined by `&&`, `;` or newlines) it audits only the top level of that target, so `cd .claude/worktrees/<name> && git commit` or `git -C .claude/worktrees/<name> commit` run from the primary checkout is gated on the worktree's changes alone. When that target is another checkout and the command has anything else (a subshell, `||`, a pipe, a lone `&`, a heredoc, `$` or a backtick, a backslash, a comment, a separator inside quotes, `pushd` / `popd`, a `GIT_*` variable, `--git-dir`, `--work-tree` or `-c`, a `cd` with several operands, another command before the write, or a `cd` or differently targeted write after it), it audits both the target and the directory Claude Code runs it in and blocks if either fails. With such a target, a `GIT_DIR` / `GIT_WORK_TREE` in the hook's environment also triggers both audits, as does any `(`, `)` or `$` in a quoted message, so `cd <worktree> && git commit -m "feat(core): …"` or one with a `-m "$(cat <<'EOF' …)"` message gets both. A target it can't follow (`cd -`, a `$VAR`, `~user`, `~` with `HOME` unset, a `cd` option other than `-L` / `-P`, or an `-L` after a `-P`) or one that isn't a directory inside a git checkout falls back to the directory Claude Code runs it in, with a notice, so step 9 of [Verification](#verification) in the worktree stays the real check. A PostToolUse hook runs `vp fmt` on every source, JSON, CSS or Markdown file you write or edit.
- Won't run in an agent session: `vp run test:integration`, which needs a Docker daemon or a reachable PostgreSQL server. A cloud session normally has neither, so its global setup fails. Say so in the PR body and rely on CI, which runs it against a `pgvector/pgvector:pg17` service container. Every other gate runs offline.

## Documentation surfaces

`README.md` at the root is the landing page; each package `README.md` is the API reference consumers read on npm (cross-package links are absolute GitHub URLs, so they work there); each package `CLAUDE.md` carries its boundary, invariants and terms (it is not published); `CONTRIBUTING.md` carries human setup, hooks, CI expectations and single-check commands; `PUBLISHING.md` the release flow and its one-time owner setup; `SECURITY.md` the reporting channel and supply-chain posture. No committed `docs/` tree (docgen's output is gitignored); decisions go in issue comments.

---

## Fallow local gate

Before any `git commit` or `git push`, run `vp run test:coverage`, then `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
