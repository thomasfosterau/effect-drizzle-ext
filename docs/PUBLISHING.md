# Publishing

[Changesets](https://github.com/changesets/changesets) manages versions and changelogs; publishing is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) from the protected `release` environment. There is no `NPM_TOKEN`.

## Release flow

1. A PR with a changeset merges into `trunk`.
2. The Release workflow ([release.yml](../.github/workflows/release.yml)) opens or updates the `chore: version packages` PR (`vp run changeset:version`) and assigns it to the owner.
3. Merging that PR makes the next run, after the `release` environment's approval, run `vp run release`: every package's build, then `vp pm publish -r --access public --no-git-checks -- --ignore-scripts` (pnpm resolves `catalog:` / `workspace:`, applies `publishConfig`, publishes in dependency order, skips versions already on npm and does the OIDC exchange itself), then `changeset git-tag`, which tags each untagged version and reports the tags to the Changesets action, which pushes them and creates the GitHub releases. A failed publish stops before tagging. There is no publish script.

`vp run release:dry-run` builds and lists what `vp pm publish` would publish, without publishing or tagging. Under trusted publishing pnpm attaches provenance on its own for a public repository.

Every release job first needs `verify-lockfile` (`gh actions-lock --verify`). The jobs install with `--ignore-scripts`, set `pnpm_config_verify_deps_before_run: "false"` and use no cache, so no dependency script or cached artefact reaches a job holding `id-token: write`. The build needs no `prepare`: the Effect patch only adds diagnostics.

## One-time owner setup

1. Settings → Actions → General: allow GitHub Actions to create and approve pull requests.
2. Settings → Environments → `release`: required reviewers, deployments restricted to `trunk`.
3. On npmjs.com, for each of `@thomasfosterau/effect-drizzle-ext`, `-pg` and `-kit`: Settings → Trusted Publisher → GitHub Actions, repository `thomasfosterau/effect-drizzle-ext`, workflow `release.yml`, environment `release`. npm offers the binding only for an existing package, so a first publish is by hand, from a clean `trunk` as `thomasfosterau`: `vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run release`, then `git push origin --tags` (never from a package directory).
