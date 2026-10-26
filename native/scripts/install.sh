#!/usr/bin/env bash
# Copies dist/Grimoire.app (from scripts/bundle.sh) into ~/Applications.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/dist/Grimoire.app"
dest="$HOME/Applications"

[[ -d "$app" ]] || { echo "error: $app not found; run scripts/bundle.sh first" >&2; exit 1; }

mkdir -p "$dest"
rm -rf "$dest/Grimoire.app"
cp -R "$app" "$dest/"

lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$lsregister" ]] && "$lsregister" -f "$dest/Grimoire.app" || true

echo "installed $dest/Grimoire.app"
