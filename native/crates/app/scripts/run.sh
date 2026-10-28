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
# Rune: click counts (Drag::clicks), Shift-click (Tx::mods), IME (App::on_ime), window size, italic, scroll requests.
run shift-click 20-shift-click
run double-click 21-double-click
run triple-click 22-triple-click
# Rune's scripts have no IME events: scenes compose through input::on_ime (" caf", then ´ marked; é committed).
$B --sample --scene ime-preedit --snap $O/23-ime-preedit.png --size 820x700
$B --sample --scene ime-commit --script $S/ime.json --snap $O/24-ime-commit.png --size 820x700 --at 3
$B --sample --snap $O/25-narrow.png --size 420x1000
$B $S/italic.md --snap $O/26-italic.png --size 820x400
$B $S/long.md --script $S/type-at-bottom.json --snap $O/27-type-at-bottom.png --size 820x500 --at 3
$B $S/long.md --script $S/home-end.json --snap $O/28-end.png --size 820x500 --at 1.2
$B $S/long.md --script $S/home-end.json --snap $O/29-home.png --size 820x500 --at 3
$B $S/long.md --script $S/page-down.json --snap $O/30-page-down.png --size 820x500 --at 1.0
$B $S/long.md --script $S/page-down.json --snap $O/31-page-up-shift.png --size 820x500 --at 3
run triple-click-tab 32-triple-click-tab
run click-hidden-affinity 33-click-hidden-affinity
# Links: a click on a link's text opens it (headless: printed, "grimoire: link: open …"), the
# caret stays; the pencil (hovered, then pressed) reveals it; a drag from link text selects;
# relative links open the note (sidebar row, title), with its #heading; a missing note's toast.
K=crates/app/tests/fixtures/links/Home.md
lk() { $B $K --script $S/$2.json --snap $O/$1.png --size 1100x600 --at ${3:-1}; }
lk 34-link-click link-click
lk 35-link-pencil-hover link-pencil 0.6
lk 36-link-revealed link-pencil 1.2
lk 37-link-drag link-drag
lk 38-link-note link-note
lk 39-link-missing link-missing
lk 56-link-deep link-deep
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
# An untitled note named after its H1 on Enter (once): Untitled.md becomes "Trip ideas.md" (sidebar, title).
side 135-auto-name autoname 2
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
# macOS text-system keys (editor-core macos_keys): Ctrl-A/P/E/N move by paragraph ends and lines (goal
# x), Ctrl-K kills, Ctrl-Y yanks, Ctrl-T transposes, Ctrl-Shift-E selects to the paragraph end;
# Cmd-Right/Left go to the visual line ends of a wrapped paragraph, Ctrl-E to its end.
$B --sample --scene empty --script $S/ctrl-keys.json --snap $O/75-ctrl-move.png --size 820x300 --at 1.3
$B --sample --scene empty --script $S/ctrl-keys.json --snap $O/76-ctrl-kill-yank.png --size 820x300 --at 2.0
$B --sample --scene empty --script $S/ctrl-keys.json --snap $O/77-ctrl-shift-e.png --size 820x300 --at 3
$B --sample --scene empty --script $S/line-ends.json --snap $O/78-cmd-right-row.png --size 420x400 --at 1.4
$B --sample --scene empty --script $S/line-ends.json --snap $O/79-cmd-shift-left-row.png --size 420x400 --at 1.8
$B --sample --scene empty --script $S/line-ends.json --snap $O/80-ctrl-e-paragraph.png --size 420x400 --at 3
# Ctrl-V pages down as PageDown does (81 is 30), Ctrl-L then centres the caret's line.
$B $S/long.md --script $S/ctrl-v-l.json --snap $O/81-ctrl-v.png --size 820x500 --at 1.0
$B $S/long.md --script $S/ctrl-v-l.json --snap $O/82-ctrl-l.png --size 820x500 --at 3
# A user's DefaultKeyBinding.dict (scripts/DefaultKeyBinding.dict): Option-F twice moves two words
# (Rune passes Option+letter's own letter), Ctrl-W deletes the word before; without it Option-F types ƒ.
$B --sample --scene empty --key-bindings=$S/DefaultKeyBinding.dict --script $S/user-keys.json --snap $O/83-user-keys.png --size 820x200 --at 1.5
$B --sample --scene empty --script $S/user-keys.json --snap $O/84-no-user-keys.png --size 820x200 --at 1.5
# An image in the middle of a line (tests/fixtures/inline): the line splits around it, collapsed
# and revealed (a click on it, Down to the text after it, Up back), a drop mid-line, a narrow window
# wrapping the text before an image.
I=crates/app/tests/fixtures/inline/Inline.md
$B $I --snap $O/85-inline-image.png --size 1100x800
$B $I --script $S/inline-image.json --snap $O/86-inline-image-revealed.png --size 1100x800 --at 0.8
$B $I --script $S/inline-image.json --snap $O/87-inline-image-down.png --size 1100x800 --at 1.3
$B $I --script $S/inline-image.json --snap $O/88-inline-image-up.png --size 1100x800 --at 2.5
$B $I --script $S/inline-image-drop.json --snap $O/89-inline-drop-hover.png --size 1100x800 --at 0.5
$B $I --script $S/inline-image-drop.json --snap $O/90-inline-drop.png --size 1100x800 --at 1.5
$B $I --snap $O/91-inline-image-narrow.png --size 420x900
# Code highlighting (@pierre/highlights in Wasmi): ts, rust, python, json, sh, diff and patch blocks
# (tests/fixtures/code), a block without a language left plain; typing in the ts block: "/* " opens a
# comment that runs to the doc comment's end, " */" closes it, a new typed line, then undo.
C=crates/app/tests/fixtures/code/Code.md
$B $C --snap $O/92-code-blocks.png --size 1100x1700
$B $C --script $S/code-type.json --snap $O/93-code-comment-open.png --size 1100x700 --at 1.0
$B $C --script $S/code-type.json --snap $O/94-code-typed.png --size 1100x700 --at 2.3
$B $C --script $S/code-type.json --snap $O/95-code-undo.png --size 1100x700 --at 3.2
$B $C --snap $O/96-code-narrow.png --size 420x2300
# Folders (workspaces in the code): the switcher at the top left of the sidebar, open (recent folders from a
# support folder fixture, the folders joined on a connected server, Open…), the Open dialog's remote folder
# URL, and a remote folder on the in-process mock server with another user's caret.
W=--support-dir=crates/app/tests/fixtures/support
$B "$N" $W --script $S/switcher.json --snap $O/97-switcher.png --size 1100x800 --at 1
$B "$N" $W --script $S/switcher-add.json --snap $O/98-switcher-add-remote.png --size 1100x800 --at 1.6
$B --remote-demo --snap $O/99-remote-cursor.png --size 1100x700
# The × on a local folder: "Remove <name> from your list?" first (forgets it here; the open one has no ×).
$B "$N" $W --script $S/switcher-remove.json --snap $O/100-switcher-remove.png --size 1100x800 --at 1.3
# Remote problems instead of an endless Loading… (mock server): no such folder, a revoked token, the server
# out of reach (retrying), not a Grimoire server, deleted while open, loading.
for p in missing signedout offline notgrimoire gone loading; do
  $B --remote-demo=$p --snap $O/101-remote-$p.png --size 1100x600
done
$B --remote-demo=missing --script $S/switcher.json --snap $O/102-remote-missing-switcher.png --size 1100x700 --at 1
# The switcher's menu like the web app's (menu::items): a local folder (no server items), a remote folder
# made by us (Remove folder…), by someone else, and a read-only GitHub copy (on the mock server with its REST
# stand-in); then the dialogs: Change name, Remove / Sign out confirmations; then the Open and New dialogs.
$B "$N" $W --script $S/switcher.json --snap $O/103-menu-local.png --size 1100x900 --at 1
for r in owner editor viewer; do
  $B --remote-demo=$r $W --script $S/switcher.json --snap $O/104-menu-remote-$r.png --size 1100x1100 --at 1
done
dlg() { $B --remote-demo=${3:-owner} $W --script $S/$2.json --snap $O/$1.png --size ${4:-1100x900} --at ${5:-1}; }
# The pointer over a folder row (Team): its × shows; the other rows' stay hidden.
dlg 130-menu-row-hover switcher-hover owner 1100x1100 1
# A remote row's × (Design reviews): "Remove Design reviews from your list?" first; the × on the only folder in
# the list: "Can't remove your only folder".
dlg 131-dialog-remove-from-list switcher-x-remote owner 1100x900 1.4
$B --remote-demo=single --script $S/switcher-x-only.json --snap $O/132-dialog-only-folder.png --size 1100x800 --at 1.4
# The sidebar's "Share with an agent" card after Copy ("Copied"): a remote folder (owner), a local one.
dlg 127-agent-card-remote agent-card-copy owner 1100x900 1
# The account row at the bottom of the sidebar (the open folder server's account) with its menu open (upward);
# a local folder has no account row (128).
dlg 129-account-menu account-menu owner 1100x900 1
dlg 110-dialog-change-name menu-change-name
dlg 112-dialog-remove menu-remove
dlg 113-dialog-sign-out menu-sign-out
# Open… (Folder / Remote folder / GitHub repo) and New… (Folder / Remote folder): each form, a bad folder
# link, Folder's Open (headless: the path dialog instead of the system picker); New → Remote folder with a bad
# address, and waiting for the connect flow to a server it isn't connected to.
dlg 115-dialog-open-folder open-folder owner 1100x900 1.2
dlg 116-dialog-open-remote open-remote owner 1100x900 1.2
dlg 121-dialog-open-remote-error open-remote-error owner 1100x900 1.6
# Open → URL with a note's link: the folder opens at that note (ideas/Names.md); a note that isn't there:
# the folder, and the toast "No note at “nope/Missing.md”".
dlg 133-open-url-note open-url-note owner 1100x900 2
dlg 134-open-url-missing-note open-url-missing owner 1100x900 2
dlg 114-dialog-open-github open-github owner 1100x900 1.2
dlg 109-dialog-open-new-remote open-new-remote owner 1100x900 1.2
dlg 119-dialog-open-new-folder open-new-folder owner 1100x900 1.2
dlg 122-dialog-open-folder-path open-folder-path owner 1100x900 1.4
dlg 124-dialog-new-remote-bad-url new-remote-bad-url owner 1100x900 1.8
dlg 125-dialog-new-remote-connecting new-remote-connecting owner 1100x900 1.8
$B "$N" $W --script $S/open-folder.json --snap $O/118-dialog-open-folder-local.png --size 1100x800 --at 1.2
# A local folder with no server connected: GitHub repo asks for a server first; a new
# folder where one of that name exists.
$B "$N" --script $S/open-github.json --snap $O/120-dialog-open-github-no-server.png --size 1100x800 --at 1.2
$B "$N" --script $S/open-new-folder-taken.json --snap $O/123-dialog-open-new-folder-taken.png --size 1100x800 --at 1.6
# New → Remote folder from a local folder with no server connected: the Server field says grimoire.exe.xyz.
$B "$N" --script $S/new-remote-local.json --snap $O/126-dialog-new-remote-local.png --size 1100x800 --at 1.2
$B "$N" --script $S/agent-card-copy.json --snap $O/128-agent-card-local.png --size 1100x800 --at 1
