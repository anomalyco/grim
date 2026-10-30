#!/usr/bin/env bash
# Copies dist/Grim.app (from scripts/bundle.sh) into ~/Applications, replacing the old Grimoire.app (the app's name
# before the rename). The bundle id, Keychain service and Application Support/Caches folders didn't change, so sign-in,
# workspaces and caches carry over.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/dist/Grim.app"
dest="$HOME/Applications"

[[ -d "$app" ]] || { echo "error: $app not found; run scripts/bundle.sh first" >&2; exit 1; }

mkdir -p "$dest"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [[ -d "$dest/Grimoire.app" ]]; then
  # quit it first (same bundle id as Grim.app, so ask by path), then remove it and drop it from Launch Services
  pkill -f "$dest/Grimoire.app/Contents/MacOS/" 2>/dev/null || true
  [[ -x "$lsregister" ]] && "$lsregister" -u "$dest/Grimoire.app" 2>/dev/null || true
  rm -rf "$dest/Grimoire.app"
  echo "removed $dest/Grimoire.app"
fi

rm -rf "$dest/Grim.app"
cp -R "$app" "$dest/"

[[ -x "$lsregister" ]] && "$lsregister" -f "$dest/Grim.app" || true

echo "installed $dest/Grim.app"
