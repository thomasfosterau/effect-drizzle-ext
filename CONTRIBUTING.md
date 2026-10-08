# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions are in [AGENTS.md](AGENTS.md).

Branch model, changesets and PR rules: [AGENTS.md → Branches and pull requests](AGENTS.md#branches-and-pull-requests).

## Dev container

[.devcontainer/](.devcontainer/) reproduces CI's job: Node at the major CI's `latest` currently resolves to, pnpm at the `packageManager` version through corepack, and a `pgvector/pgvector:pg17` server sharing the workspace's network, so `vp run test:integration` runs inside it with no Docker daemon. Its environment is CI's (`PGPASSWORD=postgres`, server at `127.0.0.1:5432`), and `node_modules/.bin` is on `PATH`, so `vp` and `fallow` work as in CI. Creating it runs `pnpm install --frozen-lockfile`, whose `prepare` step installs the git hooks. When CI's Node moves to a new major, move the workspace image tag in [compose.yaml](.devcontainer/compose.yaml) with it.

Editors without the dev container pick up [.editorconfig](.editorconfig). Oxfmt reads the same file, so it holds Oxfmt's own settings; formatting changes start in the `fmt` block of `vite.config.ts`.

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one job: the gates listed in [AGENTS.md → Verification](AGENTS.md#verification), in that order, with `vp run test:integration` against the job's `pgvector/pgvector` service container. [release.yml](.github/workflows/release.yml) runs changesets/action (v2.1.2, SHA-pinned) on `trunk` inside the protected `release` environment: it opens the "Version Packages" PR while unreleased changesets exist (`pnpm run version`: `changeset version` with its auto-formatter disabled — `"format": false` in `.changeset/config.json`, because the `oxfmt` bin Vite+ installs is an IDE-only wrapper that exits 1 on `--write` — then `vp fmt` on the generated changelogs) and, once that PR merges, runs [`scripts/release.sh`](scripts/release.sh) — `pnpm pack` then `npm publish <tarball>` per package under npm OIDC trusted publishing (no `NPM_TOKEN`; provenance left to npm, never forced), then `changeset tag`. `RELEASE_DRY_RUN=1 pnpm run release` exercises the pack and publish steps locally without writing to the registry.

## Fallow baseline

[fallow-baselines/dead-code.json](fallow-baselines/dead-code.json) lists the dead-code findings already on `trunk` (the `message` getters on the pg package's tagged errors, which fallow reports as unused class members, and the dist-consumer's imports of the two packages, which it reports as unlisted dependencies; effect-drizzle-ext#65 tracks fixing them at the source). `.fallowrc.json` points `audit.deadCodeBaseline` at it, so `fallow audit` stops reporting those findings in files a change touches. A finding that is not in the file still counts. Health and duplication have no findings on `trunk`, so they have no baseline.

The file only shrinks. After fixing a listed finding, regenerate it and commit the result:

```sh
vp exec fallow dead-code --format json --quiet --save-baseline fallow-baselines/dead-code.json
```

The command exits 1 while any error-severity finding remains, and writes the file anyway. Never regenerate it to absorb a finding your change introduces: fix the finding instead.

## Release setup (owner, one-time)

1. **Allow Actions to open the Version Packages PR:** Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests".
2. **Protect the `release` environment:** Settings → Environments → `release` → required reviewers, deployments restricted to `trunk`.
3. **Bind the trusted publisher for each package** on npmjs.com (package → Settings → Trusted Publisher): GitHub Actions, repository `thomasfosterau/effect-drizzle-ext`, workflow `release.yml`, environment `release`. Both `@thomasfosterau/effect-drizzle-ext` and `@thomasfosterau/effect-drizzle-ext-pg` need their own binding. npm only offers the binding for a package that exists, so a package's very first publish may need a one-off manual `npm publish` of the `0.0.0` bootstrap (as effect-jsonapi's was) before the workflow can take over.
4. Remove any classic automation token and the `NPM_TOKEN` secret once the bindings exist.

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
vp test run tests/some.test.ts           # single file (from inside the package)
vp run test:integration                  # integration tests (fresh local DB per run)
vp run test:integration -- --project pg-integration
vp run -r build                          # emit dist/
vp run fallow:audit                      # change-set review (not a CI gate)
```
