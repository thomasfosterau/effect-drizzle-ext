#!/usr/bin/env bash
#
# The `release` script the Release workflow's changesets/action runs once the
# "Version Packages" PR has merged: publish every workspace package whose
# current version is not on npm yet, then `changeset tag`.
#
# ## Why per-package `npm publish`, not `pnpm -r publish`
#
# npm OIDC trusted publishing exchanges the workflow's GitHub OIDC token for a
# short-lived publish token scoped to ONE package, and the trusted-publisher
# binding is configured per package on npmjs.com. `npm publish` (npm >= 11.5.1)
# is the client npm documents for that exchange: it mints the token for the
# package it is publishing and attaches the provenance statement itself. The
# 2026-09-18 tooling survey (issue #10) found the old recursive
# `pnpm -r publish` could not take this path, so each package is published by
# its own `npm publish` call.
#
# ## Why `pnpm pack` first
#
# The manifests carry `catalog:peers` / `catalog:` / `workspace:^` specifiers
# that only pnpm understands; `npm publish` from the package directory would
# publish them literally. `pnpm pack` writes the tarball with every specifier
# resolved (the `catalogs.peers` ranges, the sibling's real version) and
# `publishConfig` applied (the `dist/` exports map), and `npm publish
# <tarball>` publishes exactly that file.
#
# Packages are published in dependency order (core before pg), so the pg
# package's `@thomasfosterau/effect-drizzle-ext` dependency always resolves.
# A version already on the registry is skipped, which makes a re-run after a
# partial failure safe.
set -euo pipefail

PACKAGES=(packages/core packages/pg)

npm_version="$(npm --version)"
# Only the real publish needs the OIDC-capable client.
if [ -z "${RELEASE_DRY_RUN:-}" ] && ! node -e '
  const [a, b, c] = process.argv[1].split(".").map(Number);
  process.exit(a > 11 || (a === 11 && (b > 5 || (b === 5 && c >= 1))) ? 0 : 1);
' "$npm_version"; then
  echo "::error::npm ${npm_version} cannot publish with OIDC trusted publishing (needs >= 11.5.1)"
  exit 1
fi

pack_dir="$(mktemp -d)"
trap 'rm -rf "$pack_dir"' EXIT

for dir in "${PACKAGES[@]}"; do
  name="$(node -p "require('./${dir}/package.json').name")"
  version="$(node -p "require('./${dir}/package.json').version")"

  if npm view "${name}@${version}" version >/dev/null 2>&1; then
    echo "${name}@${version} is already published; skipping"
    continue
  fi

  tarball="$(cd "$dir" && pnpm pack --json --pack-destination "$pack_dir" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => console.log(JSON.parse(input).filename));
  ')"

  echo "publishing ${name}@${version} from ${tarball}"
  npm publish "$tarball" --access public --provenance ${RELEASE_DRY_RUN:+--dry-run}
done

# `RELEASE_DRY_RUN=1 pnpm run release` exercises everything above locally
# (npm's dry run skips the registry write and the OIDC exchange) and stops here.
if [ -n "${RELEASE_DRY_RUN:-}" ]; then
  exit 0
fi

# Emits the `New tag:` lines changesets/action parses to push the tags and
# create the GitHub releases.
pnpm changeset tag
