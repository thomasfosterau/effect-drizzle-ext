# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions are in [AGENTS.md](AGENTS.md).

Branch model, changesets and PR rules: [AGENTS.md → Branches and pull requests](AGENTS.md#branches-and-pull-requests).

## Dev container

[.devcontainer/](.devcontainer/) reproduces CI's job: Node at the major CI's `latest` currently resolves to, pnpm at the `packageManager` version through corepack, and a `pgvector/pgvector:pg17` server sharing the workspace's network, so `vp run test:integration` runs inside it with no Docker daemon. Its database environment is CI's (`PGPASSWORD=postgres`, server at `127.0.0.1:5432`), and `node_modules/.bin` is on `PATH`, so `vp` and `fallow` work as in CI. Creating it runs `pnpm install --frozen-lockfile`, whose `prepare` step installs the git hooks. Each workspace package's `node_modules` is a named volume, so the container's Linux install and a host install don't overwrite each other's platform-specific binaries; add a volume in compose.yaml when a workspace package is added. The container suggests the EditorConfig and Oxc VS Code extensions. When CI's Node moves to a new major, move the workspace image tag in [compose.yaml](.devcontainer/compose.yaml) with it.

Editors with EditorConfig support pick up [.editorconfig](.editorconfig). Oxfmt reads the same file, so it holds Oxfmt's own settings; formatting changes start in the `fmt` block of `vite.config.ts`.

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one job: the gates listed in [AGENTS.md → Verification](AGENTS.md#verification), in that order, with `vp run test:integration` against the job's `pgvector/pgvector` service container. [release.yml](.github/workflows/release.yml) runs Changesets on `trunk` inside the protected `release` environment; the flow, its hardening and the owner's one-time setup are in [PUBLISHING.md](PUBLISHING.md). Vulnerability reports go through [SECURITY.md](SECURITY.md).

## Fallow baseline

[fallow-baselines/dead-code.json](fallow-baselines/dead-code.json) lists the dead-code findings already on `trunk` (the `message` getters on the pg package's tagged errors, which fallow reports as unused class members, and the dist-consumer's imports of the two packages, which it reports as unlisted dependencies; effect-drizzle-ext#65 tracks fixing them at the source). `.fallowrc.json` points `audit.deadCodeBaseline` at it, so `fallow audit` stops reporting those findings in files a change touches. A finding that is not in the file still counts. Health and duplication have no findings on `trunk`, so they have no baseline.

The file only shrinks. After fixing a listed finding, regenerate it from a tree without built `dist/` output and without fallow's cache, and commit the result. The two dist-consumer entries only appear while `packages/*/dist` is absent (its tsconfig `paths` point at `dist/*.d.ts`), and the `.fallow/` cache can return a result from an earlier tree:

```sh
rm -rf packages/*/dist .fallow
vp exec fallow dead-code --format json --quiet --no-cache --save-baseline fallow-baselines/dead-code.json
```

The command exits 1 while any error-severity finding remains, and writes the file anyway. Never regenerate it to absorb a finding your change introduces: fix the finding instead.

## Pre-PR checklist

1. The gates in [AGENTS.md → Verification](AGENTS.md#verification), in order, and the changeset and rebase rules in [AGENTS.md → Branches and pull requests](AGENTS.md#branches-and-pull-requests).
2. Docs: the package `README.md` for any exported change; the package `CLAUDE.md` for a new term or invariant.

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
