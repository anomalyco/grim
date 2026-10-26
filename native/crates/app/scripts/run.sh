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
run triple-click-tab 32-triple-click-tab
run click-hidden-affinity 33-click-hidden-affinity
# Sidebar: a nested notes folder (tests/fixtures/notes, read only; new notes stay in memory).
F=crates/app/tests/fixtures/notes
N="$F/Loose ends.md"
side() { $B "$N" ${2:+--script $S/$2.json} --snap $O/$1.png --size ${4:-1100x800} --at ${3:-1.5}; }
side 40-sidebar
side 41-switch sidebar-switch 2
side 42-filter sidebar-filter 1.5
side 43-filter-esc sidebar-filter 3
side 44-cmd-p-enter sidebar-cmd-p 2
side 45-new-note sidebar-new-note 2.5
side 46-collapse sidebar-collapse
side 47-sidebar-off sidebar-toggle
side 48-narrow "" 1 680x800
side 49-narrow-toggle sidebar-toggle 1.5 680x800
side 50-hover sidebar-hover 1
# The narrowest window with the sidebar shown: the column squeezes beside it, clipped to its area.
side 55-narrowest-sidebar sidebar-toggle 1.5 420x800
$B crates/app/tests/fixtures/empty --snap $O/51-empty-folder.png --size 1100x600
# File drop: images hover a scrolled note (drop caret; a .pdf alone shows none), then drop and undo.
L=crates/app/scripts/long.md
$B $L --script $S/file-drop.json --snap $O/52-drop-hover.png --size 820x500 --at 1.6
$B $L --script $S/file-drop.json --snap $O/53-drop.png --size 820x500 --at 2.4
$B $L --script $S/file-drop.json --snap $O/54-drop-undo.png --size 820x500 --at 3
# Images: tests/fixtures/photos (PNGs beside the note and in images/, one missing).
P=crates/app/tests/fixtures/photos/Photos.md
$B $P --snap $O/60-images.png --size 1100x1500
$B $P --script $S/image-click.json --snap $O/61-image-caret.png --size 1100x1000 --at 1.0
$B $P --script $S/image-click.json --snap $O/62-image-inline-caret.png --size 1100x1000 --at 2
$B $P --script $S/image-updown.json --snap $O/63-image-down.png --size 1100x1000 --at 1.0
$B $P --script $S/image-updown.json --snap $O/64-image-past.png --size 1100x1000 --at 1.3
$B $P --script $S/image-drop.json --snap $O/65-image-drop.png --size 1100x1500 --at 1.5
$B $P --snap $O/66-image-narrow.png --size 420x1000
# Two badges on one line (double click selects the second's source), the linked badge without its
# chip, a click right of the narrow badge (its source, not the text above).
$B $P --snap $O/67-image-rows.png --size 1100x2000
$B $P --script $S/image-rows.json --snap $O/68-image-double-click.png --size 1100x2000 --at 0.8
$B $P --script $S/image-rows.json --snap $O/69-image-beside.png --size 1100x2000 --at 1.6
# Folding: the chevron on hover, a folded section (its "…" pill), unfolded by the pill, Cmd-Option-[ on
# the caret's heading, Enter at its end starting a heading after the folded section.
$B --sample --script $S/fold.json --snap $O/70-fold-hover.png --size 820x1000 --at 0.5
$B --sample --script $S/fold.json --snap $O/71-folded.png --size 820x1000 --at 1.0
$B --sample --script $S/fold.json --snap $O/72-unfolded.png --size 820x1000 --at 1.45
$B --sample --script $S/fold.json --snap $O/73-fold-key.png --size 820x1000 --at 2.0
$B --sample --script $S/fold.json --snap $O/74-enter-after-fold.png --size 820x1000 --at 3
