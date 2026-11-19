#!/usr/bin/env bash
#
# Publishes every workspace package whose version is not on npm yet, then
# runs `changeset tag`. Per package because npm trusted publishing mints a
# token per package; `pnpm pack` first so `catalog:` / `workspace:` specifiers
# are resolved in the tarball. Core, pg, kit: dependency order. Re-runnable.
set -euo pipefail

PACKAGES=(packages/core packages/pg packages/kit)

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
  npm publish "$tarball" --access public ${RELEASE_DRY_RUN:+--dry-run}
done

# `RELEASE_DRY_RUN=1 pnpm run release` exercises everything above locally
# (npm's dry run skips the registry write and the OIDC exchange) and stops here.
if [ -n "${RELEASE_DRY_RUN:-}" ]; then
  exit 0
fi

# Emits the `New tag:` lines changesets/action parses to push the tags and
# create the GitHub releases.
pnpm changeset tag
