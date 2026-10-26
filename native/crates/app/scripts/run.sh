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
# Patched Rune: mouse modifiers and click counts, IME, viewport, italic, scroll requests.
run shift-click 20-shift-click
run double-click 21-double-click
run triple-click 22-triple-click
$B --sample --script $S/ime.json --snap $O/23-ime-preedit.png --size 820x700 --at 1.2
$B --sample --script $S/ime.json --snap $O/24-ime-commit.png --size 820x700 --at 3
$B --sample --snap $O/25-narrow.png --size 420x1000
$B $S/italic.md --snap $O/26-italic.png --size 820x400
$B $S/long.md --script $S/type-at-bottom.json --snap $O/27-type-at-bottom.png --size 820x500 --at 3
$B $S/long.md --script $S/home-end.json --snap $O/28-end.png --size 820x500 --at 1.2
$B $S/long.md --script $S/home-end.json --snap $O/29-home.png --size 820x500 --at 3
$B $S/long.md --script $S/page-down.json --snap $O/30-page-down.png --size 820x500 --at 1.0
$B $S/long.md --script $S/page-down.json --snap $O/31-page-up-shift.png --size 820x500 --at 3
