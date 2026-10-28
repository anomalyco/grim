#!/usr/bin/env bash
# Builds grimoire in release mode and assembles an ad-hoc signed dist/Grimoire.app.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export PATH="$HOME/.cargo/bin:$PATH"

[[ "$(uname)" == Darwin ]] || { echo "error: bundle.sh must run on macOS" >&2; exit 1; }
command -v cargo >/dev/null || { echo "error: cargo not found (install rustup)" >&2; exit 1; }

echo "==> cargo build --release -p grimoire"
if ! cargo build --release -p grimoire; then
  echo "error: release build of grimoire failed; fix the build and re-run scripts/bundle.sh" >&2
  exit 1
fi

target_dir="$(cargo metadata --format-version 1 --no-deps 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])' 2>/dev/null \
  || echo "$root/target")"
bin="$target_dir/release/grimoire"
[[ -x "$bin" ]] || { echo "error: expected binary not found at $bin" >&2; exit 1; }

version="$(cargo metadata --format-version 1 --no-deps 2>/dev/null \
  | python3 -c 'import json,sys; print(next(p["version"] for p in json.load(sys.stdin)["packages"] if p["name"]=="grimoire"))' 2>/dev/null \
  || echo 0.1.0)"

if [[ ! -f packaging/AppIcon.icns ]]; then
  echo "==> building AppIcon.icns"
  packaging/make-icns.sh
fi

app="$root/dist/Grimoire.app"
echo "==> assembling $app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/grimoire"
sed "s/__VERSION__/$version/g" packaging/Info.plist > "$app/Contents/Info.plist"
cp packaging/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
printf 'APPL????' > "$app/Contents/PkgInfo"
plutil -lint "$app/Contents/Info.plist" >/dev/null

echo "==> codesign (ad-hoc)"
codesign --force --deep -s - "$app"
codesign --verify --deep "$app"

# Make Finder/Launch Services pick up the document types and icon right away.
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$lsregister" ]] && "$lsregister" -f "$app" || true

echo "$app"
