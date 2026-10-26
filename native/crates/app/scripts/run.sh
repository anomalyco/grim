#!/bin/sh
# Headless snapshots: crates/app/scripts/run.sh (from the workspace root, after a release build).
set -e
B=target/release/grimoire
O=crates/app/out
S=crates/app/scripts
mkdir -p $O
$B --sample --snap $O/01-sample.png --size 820x1000
$B --sample --scene caret-in-bold --snap $O/02-caret-in-bold.png --size 820x1000
$B --sample --scene selection --snap $O/03-scene-selection.png --size 820x600
$B --sample --scene in-table --snap $O/04-in-table.png --size 820x1000
$B --sample --scene in-code --snap $O/05-in-code.png --size 820x1000
run() { $B --sample ${3:+--scene $3} --script $S/$1.json --snap $O/$2.png --size 820x1000 --at 3; }
run heading 10-heading empty
run list-enter 11-list-enter empty
run bold 12-bold empty
run click-hidden 13-click-hidden
run shift-select 14-shift-select
run todo 15-todo
run undo 16-undo empty
run drag 17-drag
$B --sample --scene empty --script $S/tab.json --snap $O/18-tab.png --size 820x160 --at 2
$B --sample --script $S/scroll-click.json --snap $O/19-scroll-click.png --size 820x500 --at 3
