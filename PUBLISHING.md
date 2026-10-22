# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets) and published to npm through [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers): there is no `NPM_TOKEN`. [SECURITY.md](./SECURITY.md) gives the security rationale behind the pipeline.

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the packages and the bump (`patch` / `minor` / `major`), write a user-facing summary, and commit the generated file with the change. Which changes need one is set out in [AGENTS.md](AGENTS.md#branches-and-pull-requests); a doc-comment change that reaches the emitted `.d.ts` takes a `patch`. The two packages are `linked` in `.changeset/config.json`, so they share a version line.
2. **Merge to `trunk`.** The [`Release`](./.github/workflows/release.yml) workflow runs and, while changesets are pending, opens or updates the **"chore: version packages"** PR. Its version step is `pnpm run version`: `changeset version` with Changesets' own formatter off (`"format": false` in `.changeset/config.json`, because the `oxfmt` bin Vite+ installs is an IDE-only wrapper that exits 1 on `--write`), then `vp fmt` on the generated changelogs and `pnpm install --lockfile-only`.
3. **Merge the "Version Packages" PR.** With no changesets left, the workflow builds both packages and runs [`scripts/release.sh`](scripts/release.sh): `pnpm pack` per package (which resolves the `catalog:` / `workspace:` specifiers and applies `publishConfig`), then `npm publish <tarball>` per package under OIDC, core before pg, skipping a version already on the registry; then `changeset tag`, whose `New tag:` lines the Changesets action turns into tags and GitHub releases. Provenance is left to npm (attached where the repository supports it, never forced, which fails from a private repository).

`RELEASE_DRY_RUN=1 pnpm run release` exercises the pack and publish steps locally without writing to the registry.

The job installs with `pnpm install --frozen-lockfile --ignore-scripts` and sets `pnpm_config_verify_deps_before_run: "false"`, so no dependency's install script runs while the job holds `id-token: write`. The build doesn't need the root `prepare` step: `vp pack` builds the same `dist/` with the unpatched native compiler (the Effect patch only adds diagnostics).

## Maintainer setup (owner, one-time)

1. **Allow Actions to open the Version Packages PR:** Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests". (Done: the Release workflow opened #46 on 2026-10-04.)
2. **Protect the `release` environment:** Settings → Environments → `release` → required reviewers, deployments restricted to `trunk`.
3. **Bind the trusted publisher for each package** on npmjs.com (package → Settings → Trusted Publisher): GitHub Actions, repository `thomasfosterau/effect-drizzle-ext`, workflow `release.yml`, environment `release`. Both `@thomasfosterau/effect-drizzle-ext` and `@thomasfosterau/effect-drizzle-ext-pg` need their own binding. npm only offers the binding for a package that exists, so a package's very first publish may need a one-off manual `npm publish` of the `0.0.0` bootstrap (as effect-jsonapi's was) before the workflow can take over.
4. **Remove** any classic automation token and the `NPM_TOKEN` secret once the bindings exist.
5. **Protect `trunk`:** require pull requests and the passing `ci` check before merge, so a release can only be triggered by merging the reviewed "Version Packages" PR.
