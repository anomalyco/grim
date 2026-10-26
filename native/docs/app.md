# The app crate (`crates/app`, package `grimoire`)

Phase 1 of the native port: `editor-core` drawn with Rune. Built against the `grimoire-patches`
branch of Rune, checked out as the worktree `~/projects/worktrees/rune-grimoire`
(`rune = { path = "../../../worktrees/rune-grimoire/crates/rune" }`). Its APIs are described in
`docs/rune-capabilities.md`, "Patched Rune", plus `Tx::scroll_to` / `Tx::scroll_into_view` (below).

```sh
cargo build --release -p grimoire
target/release/grimoire path/to/note.md      # opens it, creating it if missing
target/release/grimoire                      # ~/Documents/Grimoire/Untitled.md (starts as the sample)
sh crates/app/scripts/run.sh                 # headless snapshots → crates/app/out/*.png
cargo test --release -p grimoire             # autosave test
scripts/bundle.sh                            # dist/Grimoire.app (gitignored)
```

Headless runs (`--snap`, `--script`, `--tree`) never write to disk. `--sample` loads the
built-in sample note (`crates/app/sample.md`), and scenes (`--scene empty|caret-in-bold|selection|in-table|in-code`)
set up states. `crates/app/scripts/long.md` and `italic.md` are fixtures for the scroll and
italic snapshots.

## Modules

| file | what it does |
|---|---|
| `main.rs` | `App` state (the `Editor`, path, caret blink `Live`, saver, IME marked text), fonts (the Inter 4.1 faces in `assets/fonts`, italics included, plus Menlo read from `/System/Library/Fonts`), `AppSpec` with the file name in the window title, scenes, autosave on close, and `ApplePressAndHoldEnabled = NO` registered at startup |
| `layout.rs` | Parley layout mirroring Rune's `TextSystem::layout_rich` (same fonts and parameters, italic included, device scale, a cache keyed like Rune's). Turns each `LineView` into a `LineGeo` of `Piece`s (one per line, one per cell in tables), whose display text leaves hidden segments out, with display ↔ raw byte maps (`DisplayMap` from editor-core for hits, resolving the click's affinity next to hidden markers; `r2d` for carets). Block tokens become gutter slots (`Tok`). Implements editor-core's `Layout` (`caret_rect`, `hit_test`, `bounds`, `table_cell_at`, `line_mid_y`), plus selection rects and `splice_marked` (IME text drawn into the caret's piece). Holds the column width and viewport height of the last view (`set_viewport`, `col_w`, `view_h`) |
| `render.rs` | The view: code block backgrounds, quote bars, table rules, hr, bullets, numbers, checkboxes (clickable → `toggle_todo`), `H1`…`H6` labels on the active heading, one `rich()` per piece, strikethrough rules, the translucent selection, and the blinking caret (`ime_cursor()`, kept transparent under a selection), inside a centred column in a Rune scroll viewport (`scroll`). The surface element takes the mouse |
| `input.rs` | `on_key` → `insert_text` / `Editor::key` through the keymap, plus Cmd-C/X/V (arboard), Cmd-S, PageUp/PageDown, Home/End scrolling and keeping the caret in view. `on_ime` → marked text / `end_composition`. `surface_drag` → `mouse_down` (click count, Shift) / `mouse_drag` |
| `doc.rs` | Picking and opening the file, atomic writes, a debounced (1 s) background saver, and a flush on Cmd-S or when the window closes |
| `theme.rs` | Colours and metrics from the web editor's `editor.css` (paper `#fcfcfb`, ink `#1d1e22`, markers `#62626a`, links `#296d9a`, code `#f1f1f2`, 33 pt gutter, heading sizes) |

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

## Known gaps

- Link chips don't open anything yet (`Drag::mods.cmd` is now available for ⌘-click).
- Every event rebuilds the geometry for all lines. Shaped layouts are cached, but very long
  notes will want virtualization.
- No autoscroll while drag-selecting past the top or bottom edge.
- Dragging after a double/triple click doesn't extend by words/lines (needs editor-core).
- IME, the press-and-hold setting and the candidate window position haven't been tried in a
  real window, only headless (`ime` script events, `ime_area` in `--tree`).
- Marked text that wraps onto a new visual line overlaps the line below until it commits.
