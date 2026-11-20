# Publishing

[Changesets](https://github.com/changesets/changesets) manages versions and changelogs; publishing is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) from the protected `release` environment. There is no `NPM_TOKEN`.

## Release flow

1. A PR with a changeset merges into `trunk`.
2. The Release workflow ([release.yml](../.github/workflows/release.yml)) opens or updates the `chore: version packages` PR (`vp run changeset:version`) and assigns it to the owner.
3. Merging that PR makes the next run build every package and run `pnpm run release` after the `release` environment's approval: `pnpm -r publish` (which resolves `catalog:` / `workspace:`, applies `publishConfig`, publishes in dependency order, skips versions already on npm and does the OIDC exchange itself), then `changeset tag`.

After `vp run -r build`, `pnpm -r --filter './packages/*' publish --access public --no-git-checks --ignore-scripts --dry-run` exercises the publish step locally. Under trusted publishing pnpm attaches provenance on its own for a public repository.

Every release job first needs `verify-lockfile` (`gh actions-lock --verify`). The jobs install with `--ignore-scripts`, set `pnpm_config_verify_deps_before_run: "false"` and use no cache, so no dependency script or cached artefact reaches a job holding `id-token: write`. The build needs no `prepare`: the Effect patch only adds diagnostics.

## One-time owner setup

1. Settings → Actions → General: allow GitHub Actions to create and approve pull requests.
2. Settings → Environments → `release`: required reviewers, deployments restricted to `trunk`.
3. On npmjs.com, for each of `@thomasfosterau/effect-drizzle-ext`, `-pg` and `-kit`: Settings → Trusted Publisher → GitHub Actions, repository `thomasfosterau/effect-drizzle-ext`, workflow `release.yml`, environment `release`. npm offers the binding only for an existing package, so a first publish may need a one-off manual `pnpm publish`.
