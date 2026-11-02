#!/usr/bin/env bash
# Builds packaging/AppIcon.icns from the Grim icon (three jagged scratches on a dark squircle): AppIcon-1024.png (the
# master on Apple's grid: 824 px continuous-corner body, transparent around it, a light drop shadow) for 64 px and up,
# and AppIcon-16.png / AppIcon-32.png (the same scratches redrawn bolder and smooth, legible at that size) for 16 and 32 px.
# The PNGs come from the web repo: assets/icon/make-icons.py writes grim-icon-mac-1024.png, grim-icon-16.png, grim-icon-32.png.
# --beta: AppIcon-Beta.icns (Grim Beta's) from AppIcon-Beta-*.png, which `swift make-beta-icon.swift` makes from those.
set -euo pipefail
cd "$(dirname "$0")"
name=AppIcon
[[ "${1:-}" == --beta ]] && name=AppIcon-Beta

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
set_dir="$work/AppIcon.iconset"
mkdir -p "$set_dir"
cp $name-16.png "$set_dir/icon_16x16.png"
cp $name-32.png "$set_dir/icon_16x16@2x.png"
cp $name-32.png "$set_dir/icon_32x32.png"
sips -z 64 64 $name-1024.png --out "$set_dir/icon_32x32@2x.png" >/dev/null
for s in 128 256 512; do
  sips -z $s $s $name-1024.png --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d $name-1024.png --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o $name.icns
echo "wrote $(pwd)/$name.icns"
