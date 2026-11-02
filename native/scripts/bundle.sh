#!/usr/bin/env bash
# Builds grimoire in release mode and assembles an ad-hoc signed dist/Grim.app.
# --beta: Grim Beta instead (cargo feature `beta`, src/variant.rs): dist/Grim Beta.app, bundle id co.anoma.grimoire.beta,
# staging (https://staging.grimnotes.app), the orange BETA icon; it installs and runs beside Grim (scripts/install-beta.sh).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export PATH="$HOME/.cargo/bin:$PATH"

beta=0
[[ "${1:-}" == --beta ]] && beta=1
if ((beta)); then
  name="Grim Beta" bundle_id=co.anoma.grimoire.beta icon=AppIcon-Beta features=(--features beta)
else
  name=Grim bundle_id=co.anoma.grimoire icon=AppIcon features=()
fi

[[ "$(uname)" == Darwin ]] || { echo "error: bundle.sh must run on macOS" >&2; exit 1; }
command -v cargo >/dev/null || { echo "error: cargo not found (install rustup)" >&2; exit 1; }

echo "==> cargo build --release -p grimoire ${features[*]:-}"
if ! cargo build --release -p grimoire ${features[@]+"${features[@]}"}; then
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

if [[ ! -f "packaging/$icon.icns" ]]; then
  echo "==> building $icon.icns"
  packaging/make-icns.sh $( ((beta)) && echo --beta)
fi

app="$root/dist/$name.app"
echo "==> assembling $app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/$name"   # the app menu (About/Hide/Quit) is named after the process
plist="$app/Contents/Info.plist"
sed "s/__VERSION__/$version/g" packaging/Info.plist > "$plist"
if ((beta)); then
  plutil -replace CFBundleExecutable -string "$name" "$plist"
  plutil -replace CFBundleIdentifier -string "$bundle_id" "$plist"
  plutil -replace CFBundleName -string "$name" "$plist"
  plutil -replace CFBundleDisplayName -string "$name" "$plist"
  plutil -replace NSMicrophoneUsageDescription -string "$name uses the microphone for experimental voice sessions, only while one is on." "$plist"
fi
cp "packaging/$icon.icns" "$app/Contents/Resources/AppIcon.icns"
printf 'APPL????' > "$app/Contents/PkgInfo"
plutil -lint "$plist" >/dev/null

echo "==> codesign (ad-hoc)"
codesign --force --deep -s - "$app"
codesign --verify --deep "$app"

# Make Finder/Launch Services pick up the document types and icon right away.
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$lsregister" ]] && "$lsregister" -f "$app" || true

echo "$app"
