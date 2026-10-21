#!/usr/bin/env bash
#
# Verify the built Pallet DMG before a release is created.
#
# Usage: bash scripts/verify-release.sh vX.Y.Z

set -euo pipefail

usage() {
  printf 'usage: bash scripts/verify-release.sh vX.Y.Z\n' >&2
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  usage
  exit 1
fi

tag="$1"
case "$tag" in
  v*) version="${tag#v}" ;;
  *) die "tag '$tag' must start with v (for example v0.4.2)" ;;
esac
[ -n "$version" ] || die "tag '$tag' has no version"

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

pkg="$root/package.json"
[ -f "$pkg" ] || die "no package.json at $root"
current=$(plutil -extract version raw "$pkg")
[ "$current" = "$version" ] || die "package.json version is $current, expected $version"

dmg="$root/dist/pallet-${version}.dmg"
[ -f "$dmg" ] || die "missing $dmg"

printf '==> hdiutil verify %s\n' "$dmg"
if ! hdiutil verify "$dmg"; then
  die "hdiutil could not verify $dmg"
fi

plist="$root/dist/mac-arm64/Pallet.app/Contents/Info.plist"
[ -f "$plist" ] || die "missing $plist"
app_version=$(plutil -extract CFBundleShortVersionString raw "$plist")
[ "$app_version" = "$version" ] || die "Pallet.app CFBundleShortVersionString is $app_version, expected $version"

if command -v shasum >/dev/null 2>&1; then
  checksum=$(shasum -a 256 "$dmg" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  checksum=$(sha256sum "$dmg" | awk '{print $1}')
else
  die "neither shasum nor sha256sum is available"
fi
[ -n "$checksum" ] || die "could not compute the SHA-256 of $dmg"

printf '%s  %s\n' "$checksum" "$(basename "$dmg")" >"$root/dist/checksums.txt"
printf 'checksum: %s  %s\n' "$checksum" "$(basename "$dmg")"
printf 'verified %s\n' "$tag"
