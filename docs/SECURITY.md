# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's [Report a vulnerability](https://github.com/thomasfosterau/effect-drizzle-ext/security/advisories/new) button, or to Thomas Foster at me@thomasfoster.au, not through public issues. Include a description, reproduction steps, and the affected package and version.

## Supply chain

- Releases use npm trusted publishing; there is no long-lived npm token. Publishing waits for approval in the protected `release` environment and for `.github/workflows/actions.lock` to verify.
- Release jobs install with `--ignore-scripts` and no cache. Workflows default to `permissions: {}`, never persist checkout credentials, and pin actions by `.github/workflows/actions.lock`.
- `minimumReleaseAge` holds new third-party versions for 24 hours; Dependabot waits 1 day. CI runs `pnpm audit --audit-level high`.
