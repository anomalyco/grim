# The app crate (`crates/app`, package `grimoire`)

Phase 1 of the native port: `editor-core` drawn with Rune. Built against the **main** Rune
checkout (`../../../rune/crates/rune`), not the `grimoire-patches` worktree yet.

```sh
cargo build --release -p grimoire
target/release/grimoire path/to/note.md      # opens it, creating it if missing
target/release/grimoire                      # ~/Documents/Grimoire/Untitled.md (starts as the sample)
sh crates/app/scripts/run.sh                 # headless snapshots → crates/app/out/*.png
cargo test --release -p grimoire             # autosave test
```

Headless runs (`--snap`, `--script`, `--tree`) never write to disk. `--sample` loads the
built-in sample note (`crates/app/sample.md`), and scenes (`--scene empty|caret-in-bold|selection|in-table|in-code`)
set up states.

## Modules

| file | what it does |
|---|---|
| `main.rs` | `App` state (the `Editor`, path, caret blink `Live`, saver, input state), fonts (the Inter 4.1 faces in `assets/fonts` plus Menlo read from `/System/Library/Fonts`), `AppSpec` with the file name in the window title, scenes, autosave on close |
| `layout.rs` | Parley layout mirroring Rune's `TextSystem::layout_rich` (same fonts and parameters, device scale, a cache keyed like Rune's). Turns each `LineView` into a `LineGeo` of `Piece`s (one per line, one per cell in tables), whose display text leaves hidden segments out, with `d2r`/`r2d` byte maps. Block tokens become gutter slots (`Tok`). Implements editor-core's `Layout` (`caret_rect`, `hit_test`, `bounds`, `table_cell_at`, `line_mid_y`), plus selection rects and the input bands |
| `render.rs` | The view: code block backgrounds, quote bars, table rules, hr, input strips, bullets, numbers, checkboxes (clickable → `toggle_todo`), `H1`…`H6` labels on the active heading, one `rich()` per piece, strikethrough rules, the translucent selection, and the blinking caret, inside a centred column in a Rune scroll viewport |
| `input.rs` | `on_key` → `insert_text` / `Editor::key` through the keymap, plus Cmd-C/X/V (arboard), Cmd-S. Mouse via per-line strips → `mouse_down`/`mouse_drag`. Every current Rune workaround lives here |
| `doc.rs` | Picking and opening the file, atomic writes, a debounced (1 s) background saver, and a flush on Cmd-S or when the window closes |
| `theme.rs` | Colours and metrics from the web editor's `editor.css` (paper `#fcfcfb`, ink `#1d1e22`, markers `#62626a`, links `#296d9a`, code `#f1f1f2`, 33 pt gutter, heading sizes) |

## Styling compared with the web editor

- Same fonts, sizes, paddings, colours, bullets (5 pt squares), checkboxes, quote bar, code
  block, table rules and hr. Bold is Inter Bold (700), and the H1 is 700.
- **Italic** has no Rune span flag yet. It's drawn in a muted indigo (`ITALIC_FALLBACK`).
- A link URL is a chip: `↗` in a light grey at 0.85 em, which is atomic.
- A tab character is drawn as four spaces.
- The text column has a fixed width (660 pt), because the view can't read the window size.

## Workarounds to replace when the patched Rune lands

All of these are in `input.rs` unless a file is named.

1. **Scroll-correct drag coordinates.** Each visual line has its own transparent strip with its
   own `on_drag`. Rune hit-tests against the scrolled rects, so the line is always right, and a
   drag moves by the exact pointer delta. When the view is scrolled, only the y inside the first
   line is approximate (it's clamped to the strip). **Replace with:** one `on_drag` on the
   surface, using `d.x`/`d.y` directly (`render::strips` goes away).
2. **Click count.** It's counted with the wall clock (400 ms, 4 pt) and disabled headless.
   **Replace with:** `Drag::clicks`.
3. **Shift-click.** It isn't possible yet: `mouse_down(.., shift = false)`. **Replace with:**
   `Drag::mods.shift`. With `Drag::button`, add a right-click menu later.
4. **IME / dead keys / accent picker.** They aren't wired. **Replace with:** `AppSpec::on_ime`
   → `Editor::begin_composition` / `end_composition`. Draw the preedit as an underlined span
   spliced in at the caret, and add `El::ime_cursor()` on the caret element (`render.rs`).
5. **Window size.** The column is fixed at `TEXT_W` (`theme.rs`), and `min_size` keeps it on
   screen. **Replace with:** `Cx::viewport()` → column width clamped to about 660 pt, stored in a
   thread-local like `SCALE`.
6. **Italic.** The colour fallback in `layout::seg_span`. **Replace with:** `Span::italic`. The
   Inter Italic faces are already registered.
7. **PageUp/PageDown.** These keys aren't delivered. Once they are, map them in `on_key`.
8. **Not covered by the current patch set:** setting the scroll offset. It's needed for keeping
   the caret in view after keyboard moves and for Home/End (`Command::ScrollToStart/End`, which
   is ignored today). Wheel and trackpad scrolling work. A Rune API such as
   `Tx::scroll_to(key, y)` or "keep this rect visible" would be needed.

## Known gaps

- Link chips don't open anything yet (that needs ⌘-click modifiers).
- Every event rebuilds the geometry for all lines. Shaped layouts are cached, but very long
  notes will want virtualization.
- A window narrower than the column clips it on the left (prevented by `min_size`).
