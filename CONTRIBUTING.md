# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions are in [AGENTS.md](AGENTS.md).

Branch model, changesets and PR rules: [AGENTS.md → Branches and pull requests](AGENTS.md#branches-and-pull-requests).

## Dev container

Open in a Codespace or Dev Container: `.devcontainer/` provisions it with the same hook as agent sessions (the Vite+ image at the catalog's `vite-plus` pin, then `.claude/hooks/session-start.sh`). Its Docker-in-Docker feature gives `vp run test:integration` a Docker daemon, so the suite starts its own `pgvector/pgvector:pg17` server through Testcontainers, the same image as CI's service container. The image tag moves by hand with `vite-plus` on the toolchain PR. The `Dev Container` workflow (`.github/workflows/devcontainer.yml`) builds it in CI whenever its inputs change; to try a change locally, `pnpm dlx @devcontainers/cli@0.89.0 up --workspace-folder .` (needs Docker).

Editors with EditorConfig support pick up [.editorconfig](.editorconfig). Oxfmt reads the same file, so it holds Oxfmt's own settings; formatting changes start in the `fmt` block of `vite.config.ts`.

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one job: the gates listed in [AGENTS.md → Verification](AGENTS.md#verification), in that order, with `vp run test:integration` against the job's `pgvector/pgvector` service container. [release.yml](.github/workflows/release.yml) runs Changesets on `trunk` inside the protected `release` environment; the flow, its hardening and the owner's one-time setup are in [PUBLISHING.md](PUBLISHING.md). Vulnerability reports go through [SECURITY.md](SECURITY.md).

## Fallow baseline

There is none. `fallow dead-code`, health and duplication report no findings on `trunk`, so `fallow audit` compares a change against an empty set: fix a finding your change introduces rather than adding a baseline to absorb it. (The `message` getters on the pg package's tagged errors and the dist-consumer's imports of the two packages, which an earlier baseline carried, stopped being reported with fallow 3.34.1; effect-drizzle-ext#65.)

## Pre-PR checklist

1. The gates in [AGENTS.md → Verification](AGENTS.md#verification), in order, and the changeset and rebase rules in [AGENTS.md → Branches and pull requests](AGENTS.md#branches-and-pull-requests).
2. Docs: the export's doc comment and its entry's guide in `docs/<package>/` for any exported change, plus the README's entries table for a new subpath; the package `AGENTS.md` for a new term or invariant.

## Commands

- `vp install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files). There is no pre-push hook.
- `vp check` — format + lint (Oxfmt + Oxlint, type-aware through oxlint-tsgolint with `typeCheck` on, so it also reports TypeScript errors in the root configs no tsconfig covers); `vp check --fix` to autofix. `vp run check` — the type gate: both packages' `check` plus the dist-consumer declaration check (which builds `dist/` and asserts the emitted types). They are different commands.
- `vp run -r test:unit` — unit tests (pure code; no database).
- `vp run test:integration` (Docker or PostgreSQL) — one root task over `packages/pg`'s vitest project; provisions a fresh database per run through the pg package's own `provisionTestDatabase`: an explicit `DATABASE_URL_TEST` / `DATABASE_URL` (from the environment, then `.env`) is used as-is and must already hold the fixture chain; otherwise a reachable local PostgreSQL (`PG*` env), else a `pgvector/pgvector:pg17` container via Testcontainers, migrated with the committed fixture chain in `packages/pg/tests/fixtures/`. Filter with `--project pg-integration`.
- `vp run -r build` — emit `dist/` for both packages.
- `vp run docgen` — `@effect/docgen` over both packages: type-checks and runs every JSDoc `@example` (`runExamples`); output in the gitignored `packages/*/docs/`.
- `vp run test:coverage` — both unit suites under one Istanbul map at `coverage/coverage-final.json` (`vitest.coverage.config.ts`), which `fallow audit` reads for exact CRAP scores. The per-package thresholds run with `vp run -r test:coverage`.
- `pnpm changeset` — add a changeset.
- Toolchain moves are one set: `vite-plus` (and its `vite` / `vitest` / `@vitest/coverage-istanbul` pins), `@effect/tsgo` and `@typescript/native`, after checking `@effect/tsgo`'s `components` table (`pnpm-workspace.yaml`'s comments say how); Dependabot's `toolchain` group proposes them in one PR (`.github/dependabot.yml` groups only the lockstep sets: `toolchain`, `effect` with `@effect/docgen`, and `drizzle`; everything else, `@enfect/oxlint` and each GitHub Action included, gets a PR of its own). By hand, on that PR's branch, because Dependabot can't move them: the npm-alias entries `vite` (always the vite-plus version; `pnpm exec vp migrate` re-pins it, then drop the `minimumReleaseAgeExclude` entries it adds), `typescript` and `@typescript/native`. The `overrides` literals in `pnpm-workspace.yaml` are by hand too: the `@grpc/grpc-js` security override is a transitive pin to revisit whenever `@testcontainers/postgresql` moves, and the `undici` / `launch-editor` floors come out once their comments' conditions hold. `minimumReleaseAge` holds a new version for 8 hours; Dependabot's `cooldown` is 1 day (its smallest unit).

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). CI installs as `pnpm install --frozen-lockfile`.

Single checks:

```sh
vp check                                 # format + lint (oxfmt + oxlint); --fix to autofix
vp lint                                  # oxlint only
vp fmt                                   # oxfmt (format only)
vp run check                             # the whole type gate (includes building dist/)
vp run --filter ./packages/core check    # one package's type check
vp run -r test:unit                      # unit tests
vp run test:coverage                     # both unit suites under one coverage map (coverage/coverage-final.json, read by fallow)
vp test run tests/some.test.ts           # single file (from inside the package)
vp run test:integration                  # integration tests (fresh local DB per run)
vp run test:integration -- --project pg-integration
vp run -r build                          # emit dist/
vp run fallow:audit                      # change-set review (not a CI gate; run test:coverage first)
```
