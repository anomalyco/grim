#!/usr/bin/env bash
# Builds packaging/AppIcon.icns from packaging/AppIcon-1024.png (regenerating the PNG with
# make-icon.swift when it is missing or REGEN=1).
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f AppIcon-1024.png || "${REGEN:-0}" == 1 ]]; then
  swift make-icon.swift AppIcon-1024.png
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
set_dir="$work/AppIcon.iconset"
mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s AppIcon-1024.png --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d AppIcon-1024.png --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o AppIcon.icns
echo "wrote $(pwd)/AppIcon.icns"
