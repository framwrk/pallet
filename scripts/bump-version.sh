#! /usr/bin/env bash
#
# Bump the version in package.json, commit the bump, and create an annotated
# tag. Stops before pushing, so the artifact can be built and checked while the
# release is still local.
#
# Versions are strictly MAJOR.MINOR.PATCH. Anything else is rejected rather
# than interpreted.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bump-version.sh --tag <major|minor|patch|MAJOR.MINOR.PATCH> [--dry-run]

  --tag       the component to increment, or an explicit version to set
  --dry-run   run every check and print each action, but change nothing
EOF
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

step() {
  printf '==> %s\n' "$1"
}

# Print the command instead of running it under --dry-run.
run() {
  if [ "$dry_run" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

tag_arg=""
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      [ $# -ge 2 ] || die "--tag requires an argument"
      tag_arg="$2"
      shift 2
      ;;
    --tag=*)
      tag_arg="${1#*=}"
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

if [ -z "$tag_arg" ]; then
  usage >&2
  die "--tag is required"
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  die "not a git repository"
fi
root=$(git rev-parse --show-toplevel)
pkg="$root/package.json"
[ -f "$pkg" ] || die "no package.json at $root"

# The release branch is whatever origin points HEAD at, falling back to the
# usual names for repos where origin/HEAD was never set.
default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
if [ -z "$default_branch" ]; then
  if git show-ref --verify --quiet refs/heads/main; then
    default_branch=main
  elif git show-ref --verify --quiet refs/heads/master; then
    default_branch=master
  else
    die "cannot determine the default branch"
  fi
fi

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "$default_branch" ] || die "on branch '$branch'; releases are cut from '$default_branch'"
[ -z "$(git status --porcelain)" ] || die "working tree has uncommitted changes"

version_re='^([0-9]+)\.([0-9]+)\.([0-9]+)$'
current=$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ {print $4; exit}' "$pkg")
[ -n "$current" ] || die "no \"version\" field in $pkg"
[[ $current =~ $version_re ]] || die "current version '$current' is not MAJOR.MINOR.PATCH"
major=${BASH_REMATCH[1]}
minor=${BASH_REMATCH[2]}
patch=${BASH_REMATCH[3]}

# 10# forces base 10 so a zero-padded component is not read as octal.
case "$tag_arg" in
  major) next="$((10#$major + 1)).0.0" ;;
  minor) next="${major}.$((10#$minor + 1)).0" ;;
  patch) next="${major}.${minor}.$((10#$patch + 1))" ;;
  *)
    [[ $tag_arg =~ $version_re ]] || die "--tag must be major, minor, patch, or MAJOR.MINOR.PATCH (got '$tag_arg')"
    next="$tag_arg"
    next_major=${BASH_REMATCH[1]}
    next_minor=${BASH_REMATCH[2]}
    next_patch=${BASH_REMATCH[3]}
    if ((10#$next_major < 10#$major ||
      (10#$next_major == 10#$major && (10#$next_minor < 10#$minor ||
      (10#$next_minor == 10#$minor && 10#$next_patch <= 10#$patch))))); then
      die "$next is not newer than the current version $current"
    fi
    ;;
esac

tag="v$next"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  die "tag $tag already exists locally"
fi
if git remote get-url origin >/dev/null 2>&1; then
  if remote_tag=$(git ls-remote --tags origin "refs/tags/$tag" 2>/dev/null); then
    [ -z "$remote_tag" ] || die "tag $tag already exists on origin"
  else
    printf 'warning: could not reach origin to check whether %s is taken\n' "$tag" >&2
  fi
fi

# Matches the exact key, so a dependency sharing the name does not count.
has_script() {
  grep -q "\"$1\"[[:space:]]*:" "$pkg"
}

checks=()
for script in typecheck lint; do
  if has_script "$script"; then
    checks+=("$script")
  fi
done
if [ ${#checks[@]} -gt 0 ]; then
  command -v bun >/dev/null 2>&1 || die "bun is required to run ${checks[*]}"
  for script in "${checks[@]}"; do
    step "bun run $script"
    bun run "$script"
  done
fi

step "$current -> $next"
if [ "$dry_run" -eq 1 ]; then
  printf '[dry-run] write version %s to %s\n' "$next" "$pkg"
else
  tmp="$pkg.bump.tmp"
  trap 'rm -f "$tmp"' EXIT
  line=$(awk '/^[[:space:]]*"version"[[:space:]]*:/ {print NR; exit}' "$pkg")
  sed "${line}s/\"${current}\"/\"${next}\"/" "$pkg" >"$tmp"
  mv "$tmp" "$pkg"
fi

run git commit -m "Bump version to $next" -- "$pkg"
run git tag -a "$tag" -m "$tag"

if [ "$dry_run" -eq 1 ]; then
  printf '\nDry run: nothing was changed.\n'
else
  printf '\n%s is committed and tagged locally. Nothing has been pushed.\n' "$tag"
  printf 'Build and check the artifact, then:\n'
  printf '  git push origin %s && git push origin %s\n' "$default_branch" "$tag"
fi
