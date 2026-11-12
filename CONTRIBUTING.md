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
2. Docs: the export's doc comment and its entry's guide in `docs/<package>/` for any exported change, plus the README's entries table for a new subpath; the package `CLAUDE.md` for a new term or invariant.

## Running individual checks

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
