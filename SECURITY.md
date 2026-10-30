# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-drizzle-ext/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected package and version.

## Supply-chain hardening

Both packages are published by an automated pipeline built to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC trusted publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** Once the source repository is public, npm attaches [provenance](https://docs.npmjs.com/generating-provenance-statements) to every version the release workflow publishes, linking the artifact to the exact source commit and workflow. It is never forced, because forcing it fails from a private repository.
- **Install scripts disabled in the release job.** The release workflow installs with `pnpm install --frozen-lockfile --ignore-scripts` and turns off pnpm 11's `verify-deps-before-run` for that job, so a later `pnpm run` can't silently re-install with scripts, and a compromised (transitive) dependency can't run install hooks in the privileged publish job. CI runs the workspace's own `prepare` (the `@effect/tsgo` patch the type gate needs) but only ever holds read permissions.
- **Pinned actions.** Every GitHub Action is pinned to a full commit SHA, so a hijacked tag can't inject workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies with a cooling-off period.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; `minimumReleaseAge` holds newly published third-party versions for 8 hours before pnpm installs them; Dependabot proposes updates for review after a 1-day cooldown (its smallest unit, so never a version pnpm would still refuse). CI runs `pnpm audit --audit-level high` on every PR.

## Release pipeline

The publishing pipeline and its one-time maintainer setup are documented in [PUBLISHING.md](./PUBLISHING.md).
