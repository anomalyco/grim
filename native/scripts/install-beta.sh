#!/usr/bin/env bash
# Builds Grim Beta (scripts/bundle.sh --beta), installs it as ~/Applications/Grim Beta.app and relaunches it in the
# background. Only Grim Beta is quit and reopened (by its bundle id); Grim.app is left alone and keeps running.
# --no-launch: install only.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/dist/Grim Beta.app"
dest="$HOME/Applications"
bundle_id=co.anoma.grimoire.beta

"$root/scripts/bundle.sh" --beta

running=0
if pgrep -x "Grim Beta" >/dev/null; then
  running=1
  echo "==> quitting Grim Beta"
  osascript -e "quit app id \"$bundle_id\"" || true
  for _ in $(seq 50); do pgrep -x "Grim Beta" >/dev/null || break; sleep 0.2; done
  pgrep -x "Grim Beta" >/dev/null && { echo "error: Grim Beta didn't quit; quit it and re-run" >&2; exit 1; }
fi

mkdir -p "$dest"
rm -rf "$dest/Grim Beta.app"
cp -R "$app" "$dest/"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$lsregister" ]] && "$lsregister" -f "$dest/Grim Beta.app" || true
echo "installed $dest/Grim Beta.app"

if [[ "${1:-}" != --no-launch ]]; then
  open -g "$dest/Grim Beta.app"
  echo "$( ((running)) && echo re)launched Grim Beta"
fi
