#!/usr/bin/env bash
#
# Preview the GitHub-generated notes for a release.
#
# Usage: bash scripts/preview-release-notes.sh [X.Y.Z]
#
# Requires an authenticated GitHub CLI (`gh auth login`). The notes reflect
# what is already on GitHub (`origin/main`), not unpushed local commits. This
# script only prints the generated body; it does not create or change anything.

set -euo pipefail

usage() {
  printf 'usage: bash scripts/preview-release-notes.sh [X.Y.Z]\n' >&2
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

if [ "$#" -gt 1 ]; then
  usage
  exit 1
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

if [ "$#" -eq 1 ]; then
  version="$1"
else
  version=$(plutil -extract version raw package.json)
fi

semver_re='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ $version =~ $semver_re ]] || die "version '$version' is not X.Y.Z"
tag="v$version"

command -v gh >/dev/null 2>&1 || die "gh is required; install the GitHub CLI and run 'gh auth login'"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  prev=$(git describe --tags --abbrev=0 "$tag^") || die "could not find the tag before $tag"
else
  prev=$(git describe --tags --abbrev=0 HEAD) || die "could not find a tag reachable from HEAD"
fi

gh api "repos/$repo/releases/generate-notes" \
  -f tag_name="$tag" \
  -f target_commitish=main \
  -f previous_tag_name="$prev" \
  -q .body
