#!/usr/bin/env bash
# Publishes the experimental Mac app (docs/mac-download.md): uploads a zipped Grim.app to the "mac" GitHub prerelease
# on anomalyco/grim, replacing the last one. https://grimnotes.app/download/Grim-macos.zip redirects there.
#
#   scripts/publish-mac.sh Grim-macos.zip
#
# Build the zip on a Mac, in grimoire-native:
#   scripts/bundle.sh && ditto -c -k --keepParent dist/Grim.app Grim-macos.zip
set -euo pipefail

zip="${1:?usage: scripts/publish-mac.sh path/to/Grim-macos.zip}"
repo=anomalyco/grim
tag=mac

[[ "$(basename "$zip")" == Grim-macos.zip ]] || { echo "error: the file must be named Grim-macos.zip (the download URL names it)" >&2; exit 1; }
unzip -l "$zip" | grep -q ' Grim.app/Contents/MacOS/Grim$' || { echo "error: $zip doesn't contain Grim.app/Contents/MacOS/Grim" >&2; exit 1; }

notes="Experimental, unsigned and not notarised: macOS warns the first time you open it (right-click → Open → Open, or System Settings → Privacy & Security → Open Anyway). macOS 13+ on Apple Silicon. Download: https://grimnotes.app/download/Grim-macos.zip"
if gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  gh release upload "$tag" "$zip" -R "$repo" --clobber
  gh release edit "$tag" -R "$repo" --notes "$notes (updated $(date -u +%Y-%m-%d))"
else
  gh release create "$tag" "$zip" -R "$repo" --prerelease --target main --title "Grim for Mac (experimental)" --notes "$notes"
fi
curl -sSI -L "https://github.com/$repo/releases/download/$tag/Grim-macos.zip" | grep -iE '^(HTTP|content-length|content-type)' | tail -3
