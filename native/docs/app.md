# The app crate (`crates/app`, package `grimoire`)

Phase 1 of the native port: `editor-core` drawn with Rune. Built against the `grimoire-patches`
branch of Rune, checked out as the worktree `~/projects/worktrees/rune-grimoire`
(`rune = { path = "../../../worktrees/rune-grimoire/crates/rune" }`). Its APIs are described in
`docs/rune-capabilities.md`, "Patched Rune", plus `Tx::scroll_to` / `Tx::scroll_into_view` and
`Tx::set_title` (below).

```sh
cargo build --release -p grimoire
target/release/grimoire path/to/folder       # the folder's notes in the sidebar, its newest note open
target/release/grimoire path/to/note.md      # its folder, with the note open (created if missing)
target/release/grimoire                      # ~/Documents/Grimoire (created, and seeded with Welcome.md, when it has no notes)
sh crates/app/scripts/run.sh                 # headless snapshots → crates/app/out/*.png
cargo test --release -p grimoire             # autosave, folder scan, filter, note switching, reload
scripts/bundle.sh                            # dist/Grimoire.app (gitignored)
```

Headless runs (`--snap`, `--script`, `--tree`) never write to disk: they read the folder, and a
new note only exists in memory. `--sample` (or no argument) loads the built-in sample note
(`crates/app/sample.md`) with no folder and so no sidebar, and scenes (`--scene empty|caret-in-bold|selection|in-table|in-code`)
set up states. `crates/app/scripts/long.md` and `italic.md` are fixtures for the scroll and
italic snapshots; `crates/app/tests/fixtures/notes` (nested folders, plus a hidden folder,
`node_modules` and non-Markdown files that must not show) and `fixtures/empty` are the sidebar's.

## Modules

| file | what it does |
|---|---|
| `main.rs` | `App` state (the `Editor`, path, caret blink `Live`, saver, IME marked text; the notes folder, its tree, collapsed folders, the filter `TextEdit`, the sidebar choice), `open_note` / `new_note` / `refreshed`, the 2 s refresh thread, fonts (the Inter 4.1 faces in `assets/fonts`, italics included, plus Menlo read from `/System/Library/Fonts`), `AppSpec` with the note's name in the window title, scenes, autosave on close, and `ApplePressAndHoldEnabled = NO` registered at startup |
| `layout.rs` | Parley layout mirroring Rune's `TextSystem::layout_rich` (same fonts and parameters, italic included, device scale, a cache keyed like Rune's). Turns each `LineView` into a `LineGeo` of `Piece`s (one per line, one per cell in tables), whose display text leaves hidden segments out, with display ↔ raw byte maps (`DisplayMap` from editor-core for hits, resolving the click's affinity next to hidden markers; `r2d` for carets). Block tokens become gutter slots (`Tok`). Implements editor-core's `Layout` (`caret_rect`, `hit_test`, `bounds`, `table_cell_at`, `line_mid_y`), plus selection rects and `splice_marked` (IME text drawn into the caret's piece). Holds the column width and viewport height of the last view (`set_viewport`, `col_w`, `view_h`) |
| `files.rs` | Scanning the folder (`.md`/`.markdown`, skipping hidden folders and `node_modules`, folders without notes left out; folders first, then by name) with a fingerprint of paths, sizes and mtimes; the tree's rows (collapsed folders, filter); the filter match (the web app's: each term in the path, or loosely in order in the name); `Untitled N.md` names |
| `sidebar.rs` | The sidebar view (below) and its handlers: row presses, Cmd-\ toggle, filter focus and Esc, Enter opens the first match |
| `render.rs` | The view: the sidebar (when shown) over the left 240 pt, the page in the rest. Code block backgrounds, quote bars, table rules, hr, bullets, numbers, checkboxes (clickable → `toggle_todo`), `H1`…`H6` labels on the active heading, one `rich()` per piece, strikethrough rules, the translucent selection, and the blinking caret (`ime_cursor()`, kept transparent under a selection), inside a centred column in a Rune scroll viewport (`scroll`). The surface element takes the mouse |
| `input.rs` | `on_key` → `insert_text` / `Editor::key` through the keymap, plus Cmd-C/X/V (arboard), Cmd-S, PageUp/PageDown, Home/End scrolling and keeping the caret in view. `on_ime` → marked text / `end_composition`. `surface_drag` → `mouse_down` (click count, Shift) / `mouse_drag` |
| `drop.rs` | Image files dragged in from Finder (below): the surface's `on_file_drop`, the drop caret position, the link for each image (relative path, copy into `images/`, de-dupe, URL encoding) |
| `doc.rs` | Picking the folder and note from the argument (`locate`), opening the file, atomic writes, a debounced (1 s) background saver, and a flush on Cmd-S or when the window closes |
| `theme.rs` | Colours and metrics from the web editor's `editor.css` (paper `#fcfcfb`, ink `#1d1e22`, markers `#62626a`, links `#296d9a`, code `#f1f1f2`, 33 pt gutter, heading sizes) and the sidebar's from `app.css` (`#f4f4f5`, hover `#ececee`, active `#e4e4e7`, `#3f3f46` folders, 240 pt wide, hidden below 700 pt) |

## Sidebar

Styled after the web app's sidebar (`src/client/app.css` in multiplayer-notepad: `.sidebar`,
`.sb-actions`, `.sb-filter`, `.repo-row`, `.folder-row`, `.file-row`):

- 40 pt clear at the top for the traffic lights, then "+ New note" (a drawn 10 pt plus, Inter
  Medium 13.5) as a row with a hover tint, the filter field (32 pt, paper, 1 pt hairline, blue
  when focused, "Filter notes" placeholder, a `⌘P` hint while empty), the folder's name as a
  12 pt semibold label, and the tree in its own scroll viewport.
- Rows are 28 pt, inset 8 pt with 6 pt corners, Inter 14. A folder has a 1.5 pt chevron
  (right when closed, down when open) and the name in `#3f3f46`; each level indents 14 pt; note
  names drop the extension and are cut with "…". The open note's row is `#e4e4e7` and semibold;
  other rows tint `#ececee` under the pointer.
- **Press a note:** the open note is flushed (`save_now`), the new one is read and gets its own
  saver, its folders open, the page scrolls to the top and the window title becomes its name
  (`Tx::set_title`). **Press a folder:** it opens or closes (kept in memory in
  `App::collapsed`; all open by default) and becomes where new notes go until a note is pressed.
- **New note** (the row or Cmd-N): `Untitled.md` (`Untitled 2.md`… when taken) in that folder or
  the root, written empty, opened with the caret at the start; the filter clears.
- **Filter** (click it, or Cmd-P / Cmd-K, which also shows a hidden sidebar): a Rune
  `text_input` bound to `App::filter`. While it has focus `on_key` returns `false` for everything
  but the app shortcuts, so keys reach the field and not the editor, and the editor's caret
  hides; `on_ime` declines too. Esc clears it, a second Esc leaves it; Enter opens the first
  match. Pressing the page (or a row) takes the focus back. Matching notes show with their
  folders, all open.
- **Show/hide:** Cmd-\ or Cmd-Shift-L. Until the user toggles, it shows when the window is at
  least 700 pt wide. The page column is centred in the width left over (`layout::set_viewport`
  gets the editor's width); hits need no offset because `Drag` is relative to the surface. The
  sidebar paints after the page, so in a narrow window with the sidebar forced on the column
  slides under it rather than over it.
- **Refresh:** a thread rescans the folder every 2 s (directory entries and metadata only) and,
  when the fingerprint changes, hands the new tree to `App::refreshed` through `AppHandle::update`.
  If the open note's file differs from what the editor last saved, the editor text equals that,
  and nothing was typed for 3 s, it reloads with `Editor::set_text` (the caret is mapped).
- A folder with no notes shows "No notes yet / Press ⌘N to start one." in place of the page, and
  keys don't reach the editor.

## Styling compared with the web editor

- Same fonts, sizes, paddings, colours, bullets (5 pt squares), checkboxes, quote bar, code
  block, table rules and hr. Bold is Inter Bold (700), and the H1 is 700.
- Italic is Inter Italic / Bold Italic (`Span::italic`). There's no SemiBold Italic face, so
  italic inside an H2–H6 (600) uses the nearest face.
- A link URL is a chip: `↗` in a light grey at 0.85 em, which is atomic.
- A tab character is drawn as four spaces.
- The text column follows the window: the width left after the gutter and margins, at most
  660 pt (`MAX_TEXT_W`) and at least 240 pt, centred. Narrower windows wrap. `min_size` is
  420×320.

## Input

- **Mouse:** one `on_drag` on the surface. `Drag` is measured from the scrolled rect, so the
  pointer maps straight to document space (`d.x - PAD_L`, `d.y - PAD_T`). `Drag::clicks` gives
  double-click (word) and triple-click (line), and `Drag::mods.shift` extends from the anchor.
  A drag after a double or triple click keeps the first selection: editor-core's `mouse_drag`
  has no word or line granularity. Checkboxes have their own `on_drag` on top.
- **Keys:** typing and every editing or moving key end with `tx.scroll_into_view("caret", 24)`,
  so the caret stays visible with the least scroll. Home/End are editor-core's `ScrollToStart`/
  `ScrollToEnd` → `tx.scroll_to("scroll", 0 | ∞)`; the caret stays. PageUp/PageDown aren't in
  editor-core's keymap: the caret moves by the viewport height less two lines, keeping its x
  (Shift extends), and scrolls into view.
- **IME:** `Ime::Preedit` keeps the marked text and the IME caret in `App::marked`; the view
  splices it into the caret's piece with an underline (`Geo::splice_marked`) and puts the caret
  inside it. `Ime::Commit` → `begin_composition` + `end_composition(text)`, which replaces the
  selection. Keys pressed while composing go to the IME and not to `on_key`, so the selection
  can't change mid-composition. `Ime::Disabled` drops the marked text. The caret element carries
  `ime_cursor()`, so the candidate window opens beside it (the caret element exists, transparent,
  even under a selection).
- **Press and hold:** `main.rs` registers `ApplePressAndHoldEnabled = NO` in the
  `NSUserDefaults` registration domain before the window opens, so held keys repeat instead of
  opening the accent picker (which winit can't deliver correctly). A user's own
  `defaults write` value still wins. It's done in code, not in `packaging/Info.plist`, because
  `NSUserDefaults` doesn't read Info.plist keys, and so it also covers the unbundled binary.

## Dropping images

Drag image files from Finder onto the page (Rune's `El::on_file_drop` on the surface, so points
are surface-local with the scroll included, like `Drag`; `AppSpec::on_file_drop` is `None`):

- Only images count: `png jpg jpeg gif webp heic svg tiff tif bmp`, any case. Other files are
  skipped, and when none of the hovered files is an image there's no drop caret.
- **Hover:** a 2 pt `#007aff` drop caret (`drop-caret`, `App::drop_at`) at the text position the
  pointer hit-tests to: the same `to_text` clamp and `Editor::hit_test` (with the hidden-marker
  affinity) as a click. It hides on `Cancel` and when the files move over the sidebar, which is a
  drop target that takes nothing, so it also wins where it covers the page. The page's side
  margins outside the surface aren't a target (as for clicks).
- **Drop:** one `![stem](url)` per image, joined by newlines, inserted at the drop point as is
  (mid-line stays inline, like Bear) with `Editor::set_selection(caret)` + `Editor::paste`: one
  undo step, the caret after the text, any selection collapsed, autosave as for typing. The
  filter loses focus and any IME marked text is dropped.
- **Where the link points:**
  - An image inside the notes folder (after `canonicalize`) is linked by its path relative to
    the note's folder (`shot.png`, `../../assets/logo.png`).
  - Anything else is copied into `images/` beside the note (created): `images/name.png`, or
    `name-2.png`, `name-3.png`… when a different file has that name. A file there with the same
    size and bytes is reused, not copied again.
  - Headless runs work out the same link but copy nothing. The built-in sample (no folder, no
    note path) links the absolute path.
  - The URL is percent-encoded where the editor's link parser would break: whitespace, `(`, `)`,
    `%`, `<`, `>` (`cat photo (1).png` → `cat%20photo%20%281%29.png`). editor-core's parser (like
    the TS one) ends a URL at whitespace and has no `<…>` form. `[`, `]` and `\` in the alt text
    are backslash-escaped.
- The editor draws an image link as a link (alt text and a `↗` chip), not the image.
- Tests: `drop::tests` (image extensions; relative links incl. `../`; copy, reuse and de-dupe in
  temp dirs; headless copies nothing; encoding; the link parses as one link). Script
  `file-drop.json` (`52`–`54` below).

## Rune API added for the app: scroll requests

On `grimoire-patches` (commit "Tx::scroll_to / scroll_into_view"):

```rust
impl Tx {
    /// Set the keyed scroll viewport's offset (points from the top, clamped; f32::INFINITY = end).
    pub fn scroll_to(&mut self, viewport: impl Into<String>, offset: f32);
    /// Scroll the nearest scroll viewport around the keyed element by the least amount that
    /// shows it with `margin` to spare above and below; nothing moves if it already shows.
    pub fn scroll_into_view(&mut self, key: impl Into<String>, margin: f32);
}
```

Requests are queued in the `Tx` and applied in `Runtime::frame` right after `step_scroll`, so
they see the commit's new layout and scroll extent (a line just typed at the bottom is already
measured). They stop any momentum. Offsets are in the viewport's content space, so they don't
account for virtualized stacks. Test: `runtime::tests::handlers_scroll_a_viewport_to_an_offset_or_an_element`.

## Rune API added for the app: window title

On `grimoire-patches` (commit "Tx::set_title"):

```rust
impl Tx {
    /// Set the window title after this handler (the latest request wins).
    pub fn set_title(&mut self, title: impl Into<String>);
}
```

Merged like the other `Tx` requests (from handlers and `AppHandle::update`), kept in
`Runtime::title_request` for the shell, which calls `Window::set_title`, and in `Runtime::title`,
which `--tree` prints as `"title"`. The macOS window hides its title text (full-size content
view), but the title still names the window in the Window menu, Mission Control and the Dock.
Test: `runtime::tests::handlers_and_updates_set_the_window_title`.

## Headless scripts

`crates/app/scripts/run.sh` writes `crates/app/out/NN-name.png`:

| PNG | Shows |
|---|---|
| `01`–`05` | the sample and the scenes |
| `10`–`19` | heading, list Enter, bold, click on hidden markers, shift+arrows, todo, undo, drag, tab, click and drag after scrolling (now exact) |
| `20-shift-click` | click, then shift-click two lines down: the selection runs from the first click |
| `21-double-click` | the word under a double click |
| `22-triple-click` | the whole list item (raw line) under a triple click |
| `23-ime-preedit` | a dead-key `´` underlined at the caret after `caf` |
| `24-ime-commit` | `Commit("é")` then typing: `café ok` |
| `25-narrow` | a 420 pt window: the column narrows and wraps |
| `26-italic` | `italic.md`: real italic, bold italic, italic in a heading and a quote |
| `27-type-at-bottom` | `long.md`: Cmd-Down, typing and Enter at the end; the view follows the caret |
| `28-end`, `29-home` | End scrolls to the bottom (caret stays at the top), Home scrolls back |
| `30-page-down`, `31-page-up-shift` | two PageDowns move the caret two pages, then Shift-PageUp selects a page back |
| `40-sidebar` | `tests/fixtures/notes/Loose ends.md`: the tree (nested folders, a truncated name, the open note highlighted; no hidden folder, `node_modules` or `.txt`) |
| `41-switch` | press `people/hiring`, click in its text and type: the caret lands under the pointer beside the sidebar |
| `42-filter`, `43-filter-esc` | click the filter and type `launch` (only matching notes and their folders; the editor gets none of the keys), then Esc clears it |
| `44-cmd-p-enter` | Cmd-P, `gra`, Enter opens `1-1 Grace`; the next key goes to the editor |
| `45-new-note` | Cmd-N and a heading (root `Untitled`), then press `people` and "New note": `people/Untitled` |
| `46-collapse` | `projects` and `archive` closed |
| `47-sidebar-off` | Cmd-\ hides it; the column centres in the whole window |
| `48-narrow`, `49-narrow-toggle` | a 680 pt window starts without it; Cmd-\ shows it and the column narrows |
| `50-hover` | the hover tint on a folder row |
| `51-empty-folder` | `tests/fixtures/empty`: the empty states |
| `52-drop-hover` | `long.md` scrolled; a `.pdf` alone hovers (no caret), then two images and a `.pdf`: the blue drop caret in "Paragraph 8: … fil‸l" under the pointer (over the sidebar it hides, back on the page it shows) |
| `53-drop` | dropped: `![cat photo (1)](images/cat%20photo%20%281%29.png)` and `![dog](images/dog.JPG)` on two lines at that point, the caret after them; nothing written |
| `54-drop-undo` | Cmd-Z removes both in one step |

The scripts that open a file (`26`–`31`) now show the sidebar with `crates/app/scripts`' notes.

## Known gaps

- The sidebar has no rename, delete or move, no keyboard navigation of the rows (arrow keys),
  and no full-text search (the web app's "In text" hits). The folder is rescanned on a 2 s timer,
  not when the window gains focus (Rune doesn't report focus changes).
- A note changed outside while it has unsaved edits isn't merged: the editor's text wins at the
  next autosave.

- Dropping images hasn't been tried with a real Finder drag (only `file_hover`/`file_drop`
  scripts). Images dragged from a browser as data (no file URL) don't arrive, and images aren't
  rendered inline. Undo after a drop leaves the caret at the drop point, not the earlier
  selection.
- Link chips don't open anything yet (`Drag::mods.cmd` is now available for ⌘-click).
- Every event rebuilds the geometry for all lines. Shaped layouts are cached, but very long
  notes will want virtualization.
- No autoscroll while drag-selecting past the top or bottom edge.
- Dragging after a double/triple click doesn't extend by words/lines (needs editor-core).
- IME, the press-and-hold setting and the candidate window position haven't been tried in a
  real window, only headless (`ime` script events, `ime_area` in `--tree`).
- Marked text that wraps onto a new visual line overlaps the line below until it commits.
