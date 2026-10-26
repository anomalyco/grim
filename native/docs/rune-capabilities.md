# Rune capabilities for the Grimoire editor (Phase 0a)

Researched against `~/projects/rune` at `960f2c3` (Rune 0.0.1, parley 0.12, winit 0.30.13, taffy 0.15).
Paths below are relative to `~/projects/rune/crates/rune/src/` unless they say otherwise.
The spike in `spikes/rune-editor-spike/` proves each point; its PNGs are in `docs/img/rune-spike/`.

> **Update:** the gaps below are closed on the Rune branch `grimoire-patches` (worktree
> `~/projects/worktrees/rune-grimoire`), which the spike now depends on. See
> [Patched Rune (grimoire-patches)](#patched-rune-grimoire-patches) at the end. Sections 1–8
> describe upstream Rune at `960f2c3`.

**Short version:** Rune can paint a Bear-style editor today, but it doesn't give us an editor
widget. `TextEdit`/`text_input` is a single-field model. It owns focus, IME and paste, and keeps
its Parley layout private. The approach that works is: **our code owns the model and computes
geometry with Parley itself, using the same fonts and parameters Rune uses. Rune paints rich
spans and rects and passes us keys and drags.** The spike does this and the pixels line up. There
are three real gaps, and each needs a small Rune patch: **IME/dead keys without a focused
`text_input`**, **drag coordinates inside a scroll viewport**, and **mouse modifiers, click count
and the viewport size**.

---

## 1. App skeleton

```rust
rune::run(AppSpec {                       // tooling.rs:17 (struct), tooling.rs:186 (run)
    title: "Grimoire", size: (760.0, 560.0), min_size: Some((520.0, 400.0)),
    init,                                 // fn() -> S
    view,                                 // fn(&S, &mut Cx<S>) -> El   (a plain fn pointer, no captures)
    scenes: &[("default", |_| {})],       // named states for --snap/--scene
    fonts, families: ("Inter", "Menlo"),  // see Fonts
    setup: Some(setup),                   // fn(&mut S, Waker), once (spawn threads here)
    poll: None,                           // fn(&mut S, secs, &mut Tx) -> bool, at the start of each frame
    on_key: Some(on_key),                 // fn(&mut S, &KeyEvent, &mut Tx) -> bool, before any text field
});
```

- **State** is any `S: 'static`. It doesn't need to be `Clone`. The view gets `&S` and handlers get
  `&mut S`. Every view element is keyed (`.key("line3")`) and Rune diffs the tree.
- **Re-render:** every handler (`on_key`, `on_drag`, `on_press`, `on_hover`) commits after it
  returns, so the view runs again. From other threads, use `App::new(spec).handle()` →
  `AppHandle::update(|s, tx| ..)` (app.rs:193), or the `Waker` passed to `setup`. `Live<T>`
  (live.rs:54, `Live::new`, `.set()` from any thread) repaints a bound property **without running
  the view** (`El::live_opacity/offset/fill/rect`, el.rs:398). The spike blinks its caret this way.
  The window only draws while something animates or an event arrives (window.rs:1), so a timer
  has to go through `Live`, `AppHandle` or the `Waker`.
- **Animation:** every layout and colour change springs by default. An editor should call
  `tx.instant()` (el.rs:62) in every handler. The spike does, so the caret jumps instead of
  sliding.
- **Window:** `AppSpec::title/size/min_size`. There's no API to change the title or size at
  runtime. `Cx` (runtime.rs:64) only exposes `env()` (`scale`, `system_dark`), `reduced_motion`
  and `time_scale`. **The view can't read the window size** (see Gaps).
- **Fonts:** `AppSpec::fonts: &'static [&'static [u8]]` **replaces** the embedded Inter
  (Regular/Medium/SemiBold, text.rs:25) when it's non-empty. `families: (sans, mono)` names the
  two families that exist. A span can only switch to the mono family. The fonts are registered
  with fontique (`system_fonts: false`, text.rs:410), so output is deterministic. CJK fallbacks
  come from system files (text.rs:46).
  - Inter plus a system monospace works (the spike does it). Pass the Inter bytes yourself, plus
    one file read at runtime and leaked, e.g. `Box::leak(std::fs::read("/System/Library/Fonts/Menlo.ttc")?.into_boxed_slice())`,
    with `families: ("Inter", "Menlo")`. `SFNSMono.ttf` also exists on macOS 15.
  - **There's no italic and no 700 weight.** The embedded Inter has no italic face, and `Span`
    has no italic/style field (text.rs:129). Shipping an Inter variable font with its italic file
    gives us weights, but **italic needs a Rune patch** (add `italic: bool` to `Span` →
    `StyleProperty::FontStyle` in `layout_rich`).

## 2. Text rendering

- `text(s)` (el.rs:334) is one line without wrapping. `rich(s, spans)` (el.rs:351) wraps at the
  element's width. `.font(TextStyle)`, `.color()`, `.wrap()`, `.truncate()`, `.align()`.
- `TextStyle { size, weight, family: Family::{Sans,Mono}, line_height, tracking }` (tok.rs:33);
  `TextStyle::new(16.0, 400.0).lh(24.0)`, `.mono()`.
- **Rich spans: yes.** `Span { start, end (byte offsets), weight, mono, size, color, bg, bg_pad,
  underline }` (text.rs:129), `Span::new(a, b)`. You get per-span colour, size, weight, mono, a
  rounded background (inline code) and an underline (links). **There's no italic or
  strikethrough** (strikethrough can be drawn as our own 1pt rect).
- **One element per paragraph works.** The spike renders each Markdown line as one `rich()`
  element, `.w(col_width).absolute(x, y)`, at a y we computed.
- **Hidden markers: leave them out of the display string and map indices ourselves.** No span
  property can make text zero-width. `color: TRANSPARENT` still takes up the advance. The spike
  builds `display(raw, reveal) -> { text, spans, d2r, r2d }`. Hidden bytes map to the display
  position where they would be. This is cheap and exact, and the click → raw-index mapping is
  verified in `03`/`06` (e.g. raw 10 in `Some **bold**` lands between `bol|d`).
- Decorations (span bg/underline) draw with the text element, so they sit **above** any sibling
  drawn earlier, such as our selection rects. Use translucent code backgrounds, or draw the
  selection after the text with alpha.

## 3. Hit testing, caret and glyph positions

- **Rune doesn't expose layout to the app.** `Node::text_layout` is `pub(crate)` (runtime.rs:97).
  `Runtime::text: TextSystem` is public (runtime.rs:230), but handlers and views never see the
  `Runtime`. `rt.elements()`/`--tree` only give rects.
- **Do it ourselves with Parley 0.12, mirroring `TextSystem::layout_rich` (text.rs:439):**
  `Collection::new(CollectionOptions{shared:false, system_fonts:false})` + `register_fonts(Blob::new(Arc::new(bytes)), None)`
  for the **same byte list** → `FontContext { collection, source_cache }` →
  `ranged_builder(&mut fcx, text, scale, true)`. Then apply the same `push_default` calls
  (family, size, weight, `LineHeight::Absolute(style.line_px())`, tracking), per span
  `Brush(Ink(i+1))`/mono family/weight/size, `break_all_lines(Some(width * scale))`, and
  `align(Start)`. Build it at **device scale** (`cx.env().scale`, saved in a thread-local for
  handlers) and divide by the scale. Paragraph height is
  `max(layout.height(), line_px*scale).ceil()/scale` (text.rs:652). Pin `parley = "0.12"` with
  `default-features=false, features=["std"]` so Cargo unifies it with Rune's copy. The spike's
  `Measurer` is about 50 lines, and the carets and selections in the PNGs sit exactly on the
  glyphs.
- Then use `parley::editing`:
  - x/y → index: `Cursor::from_point(&layout, x*s, y*s).index()`
  - caret rect: `Cursor::from_byte_index(&l, i, Affinity::Downstream).geometry(&l, 2.0*s)`
  - selection rects: `Selection::new(a, b).geometry(&l) -> Vec<(BoundingBox, usize)>`
  - also `next_line`, `line_start`, `word_from_point`, `next_visual_word`. Per-glyph positions
    come from `layout.lines() → items() → GlyphRun`, the same way Rune does it (text.rs:515).
- Up/down across paragraphs: the spike keeps a sticky `goal_x` and hits at
  `caret_bottom + gap + 1` or `caret_top - 1` in document space (`vertical()` in the spike).
  This covers moving within wrapped lines and across paragraphs, as shown in `04`.

## 4. Keyboard, IME and focus

- **Raw keys: `AppSpec::on_key`** runs before the focused text field. Return `true` to consume
  the key (runtime.rs:699). With no `text_input` on screen, we get every key.
- `KeyEvent { key: Key, mods: Mods }` (edit.rs:87). `Mods { shift, cmd (⌘ on macOS), alt (⌥),
  ctrl, logo }` (edit.rs:57). `Key` is one of `Text(String)`, `Enter`, `Backspace`, `Delete`,
  `Left/Right/Up/Down`, `Home`, `End`, `Escape`, `Tab`, `Command(char)` (any ⌘+character,
  lowercased, shift kept in `mods`) or `Function(u8)` (edit.rs:68). The mapping is
  `map_key` (window.rs:132). Repeats arrive (there's no `repeat` flag) and releases don't.
  **PageUp/PageDown, Insert and modifier-only presses are dropped.** ⌥+letter arrives as the
  composed `Text("å")`.
- **What edit.rs gives us:** `TextEdit { text, anchor, focus, preedit, focused }` plus
  `key()`, `ime()`, `paste()`, `undo/redo` (128 steps, typing groups) and `display()`. It
  handles one string with byte offsets, and up/down/line edges use the field's own layout. It's
  only useful as reference code (word movement, undo grouping). **Bypass it completely.** The
  spike doesn't use it.
- **IME / dead keys: a gap.** The window enables IME (`set_ime_allowed(true)`, window.rs:327),
  but `WindowEvent::Ime` is routed **only to the focused `text_input`**
  (`Action::Ime → with_focused`, runtime.rs:710). There's no app-level hook, and the IME
  candidate-window position (`rt.ime_area`) is also only set from a focused field
  (runtime.rs:2092). Plain typing comes through `KeyboardInput` → `Key::Text`, which is fine. But
  **dead-key accents (⌥E E), the press-and-hold accent picker and CJK input won't reach our
  editor.** This can't be checked headless and wasn't verified in a live window. Fix with a small
  patch: `AppSpec::on_ime: Option<fn(&mut S, &Ime, &mut Tx) -> bool>`, and a way for the app to
  set `ime_area` (e.g. a `Tx::ime_area(rect)`). A hack without the patch: keep an invisible,
  focused `text_input` and diff its `TextEdit`. It's fragile, because focus only comes from a
  pointer-down on it.
- **Focus:** only `text_input` elements take focus, and only by click. A pointer-down elsewhere
  blurs them. For one editor surface that doesn't matter, since `on_key` is global.

## 5. Mouse

- `.on_drag(|s, d: &mut Drag, tx| ..)` (el.rs:848): `Drag { phase: Down|Move|Up, x, y, w, h,
  start_x, start_y, data }` (el.rs:90), in points **relative to the element's layout rect**.
  `data` is scratch that lasts across one gesture. The element captures the pointer while the
  button is down. `.on_press` fires on release inside the element, and `.cursor(Cursor::Text)`
  sets the pointer shape.
- Only elements with handlers are hit targets (runtime.rs:2174), so text and rect children don't
  steal events. One `on_drag` on the editor surface gets everything.
- **No click count, no modifiers, left button only** (window.rs:545). The spike counts clicks
  with `Instant::now()` in `Phase::Down` (400 ms, same line → 2 = word, 3 = line). Headless
  scripts run on a virtual clock, so multi-click can't be scripted. **Shift-click and
  ⌘-click aren't possible** because `ModifiersChanged` stays inside the shell (window.rs:506).
  This needs a patch, e.g. `Drag::mods`/`Drag::clicks`.
- `pointer_up` also sends a final `Move` at the release point. Because revealing markers moves
  text under a pointer that hasn't moved, the spike only extends on a `Move` when
  `(x,y) != (start_x,start_y)`. Without that, a click on a hidden-marker line jumped the caret.

## 6. Scroll, clipboard, custom rects and overlays

- **Rects:** any `el().absolute(x, y).size(w, h).fill(c).radius(r).border(w, c)` (el.rs:601,
  642–659). Caret, selection, checkbox, code-block background and quote bar are all plain
  rects. `.shape(Shape::new().stroke(points, w, color).fill(..))` (shape.rs:53) draws vector
  marks; the spike's checkmark uses it. `.pin()`, `.anchored(key, Side, Align, gap)` (el.rs:608,
  623) handle overlays and popovers (link previews, slash menus). Children paint in order.
- **Scroll:** `.scroll(ScrollSpec { stick_bottom })` (el.rs:776) is a vertical viewport over its
  first child. It handles wheel and trackpad input and has a `virtualize()` option for growth
  stacks. It **doesn't clip unless you add `.clip_soft(fade)`** (el.rs:700). **Bug/gap:**
  `Drag.x/y` are measured against the element's *unscrolled* layout rect (`let r = n.target`,
  runtime.rs:1620; text inputs use the scrolled `drawn` rect just above). So an `on_drag` inside a
  scrolled viewport gets wrong y values. Spike `--scroll` / `07-scroll-click.png` shows this: the
  click visually lands on line 4 but hits line 2. The scroll offset isn't exposed either, and
  there are no wheel events for the app. **A long document needs a patch**: either a one-line fix
  to use the drawn rect in `pointer_down`/`pointer_move`, or expose the scroll offset/wheel. With
  that fix, the natural setup is `scroll viewport > surface (on_drag) > absolute lines`.
- **Clipboard:** write with `tx.copy(text)` (el.rs:47). The shell sets it through arboard
  (window.rs:413). For reading, the shell only reads arboard for ⌘V **when a `text_input` is
  focused** (window.rs:509). Otherwise `Key::Command('v')` reaches `on_key`, and we read
  `arboard::Clipboard::new()?.get_text()` ourselves (the spike does). Script `paste` events only
  go to focused fields.

## 7. Headless tooling (same renderer, virtual clock)

```sh
B=spikes/rune-editor-spike/target/release/rune-editor-spike
$B --snap out.png --size 760x560 [--scale 2] [--theme dark|light] [--scene NAME] [--at SECS]
$B --script s.json --snap out.png --size 760x560      # replay input, snapshot at end
$B --script s.json --tree tree.json                   # JSON: key, role, text, rect for every element
$B --script s.json --frames 60 --out dir/ | --strip strip.png --crop x,y,w,h | --trace t.jsonl
$B --list-scenes ; unknown args → rune::extra_args() (the spike uses --scroll)
```

Script format (tooling.rs:256): `{"events":[...]}`, where each event has `t` (seconds) and
`type`:
- `tap`/`click` (`x,y` or `key`, `hold`)
- `down`, `move`, `up`
- `drag` (`dx,dy,dur`)
- `type` (`text`, `every`) → `Key::Text` per char
- `key` (`name`: Enter/Backspace/Delete/Left/Right/Up/Down/Home/End/Escape/Tab/F1–F24 or a
  single char; `shift/cmd/alt/ctrl/logo`; cmd+letter → `Command`)
- `paste`
- `scroll` (`dy,dur,fling`)
- `fling`

Keys go through `on_key` headless too, so editor tests can be fully scripted. For assertions,
dump `--tree` and read a status text, or the rects of `caret`/`sel*`. Multi-click and IME can't
be scripted (wall clock; no IME event type).

## 8. Gaps, risks and the recommended architecture

**Architecture (what the spike does):**
1. **Model** (editor-core): `Vec<String>` lines (or a rope), and a selection as `(line, byte)`
   anchor/focus in **raw** Markdown. Rune is never the source of truth.
2. **Per-line display pass:** `display(raw, reveal) -> { text, spans, d2r, r2d, x_indent, kind }`.
   Reveal markers (dimmed) on the caret line/selection, and leave them out elsewhere. Heading `#`
   is always dimmed. Block markers like `- [ ]` become drawn widgets (a checkbox rect) plus an
   indent.
3. **Geometry pass (ours):** Parley `Measurer` mirroring `layout_rich` at device scale, giving
   per-line `y`, `h` and `Layout`. Cache per line by `(text, spans, reveal, width, scale)`; Rune
   also caches its own copy by hash (text.rs:447).
4. **View:** one surface `el()` with `.on_drag` and `.cursor(Text)`. Children are, in order:
   block backgrounds (code block, quote bar), selection rects, checkboxes, one
   `rich(text, spans).font(style).w(col_w - indent).absolute(x, y)` per line, and finally the
   caret rect with `.live_opacity(&blink)`.
5. **Input:** `on_key` handles every editing command; `on_drag` maps local x/y → line by `y`,
   then `Cursor::from_point` → `d2r`. Call `tx.instant()` everywhere.
6. Keep the reveal state frozen while the pointer hasn't moved, or during a drag.

**Gaps, roughly in order of how much they hurt** (none are big; all are a few lines in Rune,
best done as a vendored patch/fork or upstream PR, since we must not edit `~/projects/rune` in
place):

| Gap | Impact | Fix / workaround |
|---|---|---|
| IME/dead keys only reach a focused `text_input`; no app-level `ime_area` | Accents via ⌥E, the press-and-hold picker and CJK are broken | Patch: `AppSpec::on_ime` + `Tx::ime_area`. Hack: hidden focused `text_input` |
| `Drag` coords ignore scroll offset; offset not exposed | Long notes can't scroll and click correctly | Patch `pointer_down/move` to use the drawn rect (runtime.rs:1620) |
| No mouse modifiers or click count; left button only | No shift-click extend, ⌘-click links or right-click menu | Patch `Drag { mods, clicks, button }`; multi-click via wall clock works now |
| View can't read the window size (`Cx` has only scale/dark) | Wrap width must be known to us | Fixed column width (Bear-like ~600–700pt) + `min_size`; patch `Cx::viewport()` |
| No italic in `Span`; embedded Inter lacks italic/bold 700 | `*em*` can't render as italic | Patch `Span::italic` + ship Inter variable + italic files via `AppSpec::fonts` |
| Span decorations draw above earlier siblings | Selection hidden under the code bg | Translucent bg, or selection drawn above text |
| Only two families (sans + mono) | Fine for us | — |
| PageUp/Down, key release, modifier-only events dropped | Minor | Patch `map_key` |
| Double shaping (ours + Rune's) | CPU, fine for notes | Cache; virtualize visible lines once scroll works |

**What the spike shows** (`spikes/rune-editor-spike`, about 700 lines in one file):
- styled spans: a big bold heading with a dimmed `# `, `**bold**` and inline `code` with dimmed
  markers on the caret line, and hidden markers elsewhere
- drawn checkboxes for `- [ ]`/`- [x]`, which toggle on click
- a blinking `Live` caret, placed by click hit-testing (raw ↔ display mapping)
- ←→↑↓ with a sticky x across wrapped lines and paragraphs; ⌥ moves by word, ⌘ to line or
  document edges
- typing, Backspace/Delete across lines, Enter (continues task lists)
- shift+arrow and drag selection across lines, double/triple click
- ⌘A/C/X/V
- PNGs (`docs/img/rune-spike/`):
  - `01-default`
  - `02-click-type`: click on a hidden-marker line, type, Backspace
  - `03-shift-select`
  - `04-nav-checkbox-enter`: Down/Down/Up×3 through a wrapped paragraph, checkbox toggle,
    Enter in a task
  - `05-drag-select`
  - `06-scene-selection`
  - `07-scroll-click`: shows the scroll bug

Build and run on the laptop:
`cd spikes/rune-editor-spike && cargo build --release && target/release/rune-editor-spike`
(a window) or use the tooling commands above (`scripts/*.json`).

---

## Patched Rune (grimoire-patches)

Branch `grimoire-patches` in `~/projects/rune` is checked out as a worktree at
`~/projects/worktrees/rune-grimoire`. It has six small commits on top of `960f2c3`, one per gap:

| Commit | Change |
|---|---|
| `89e9f6f` | `Key::PageUp` / `Key::PageDown` |
| `9bfe824` | `Drag` coordinates account for scroll offsets |
| `2450d71` | `Drag::{button, mods, clicks}`, `Button`, `Runtime::{set_mods, pointer_down_with, pointer_up_with, double_click}`; script taps take modifiers/button/clicks |
| `fcf1220` | `Cx::viewport()` |
| `702ea58` | `Span::italic`, `text::DEFAULT_FONTS` |
| `aa5f127` | `AppSpec::on_ime`, `Ime::{Enabled, Disabled}`, `El::ime_cursor()`; script `ime` events and `ime_area` in `--tree` |

The spike uses it with `rune = { path = "../../../worktrees/rune-grimoire/crates/rune" }`.
`cargo test --workspace --exclude keylog` passes in the worktree, including five new runtime tests
and one text test. `examples/keylog` already failed to build at `960f2c3` because it's missing
`min_size`; that's unrelated to this branch.

**Breaking for apps:** `AppSpec` has a new field, so add `on_ime: None` (or a handler) to every
`AppSpec { .. }` literal. All the in-repo examples are updated. `Drag`, `Key` and `Ime` gained
fields or variants. Apps that build `Drag` literals or match `Key`/`Ime` exhaustively need
updating, though no in-repo code does either.

### 1. IME and composed text without a focused `text_input`

```rust
// tooling.rs (AppSpec)
pub on_ime: Option<fn(&mut S, &Ime, &mut Tx) -> bool>,   // before the focused field; true consumes
// edit.rs
pub enum Ime {
    Preedit(String, Option<(usize, usize)>), // composing text + IME cursor/selection (bytes in it); "" ends it
    Commit(String),                          // insert at caret, replacing the selection and any preedit
    Enabled,                                 // new
    Disabled,                                // new: drop any preedit
}
// el.rs
pub fn ime_cursor(self) -> El   // put this on the app-drawn caret
```

```rust
fn on_ime(ed: &mut Ed, ev: &Ime, tx: &mut Tx) -> bool {
    match ev {
        Ime::Preedit(p, cur) => ed.preedit = (!p.is_empty()).then(|| (p.clone(), cur.map_or(p.len(), |c| c.1))),
        Ime::Commit(s) => { ed.preedit = None; ed.insert(s); }
        Ime::Enabled => {}
        Ime::Disabled => ed.preedit = None,
    }
    tx.instant();
    true
}
// view: the caret rect; the candidate/accent window opens beside its drawn (scrolled) rect
el().key("caret").absolute(x, y).size(2.0, h).fill(accent).live_opacity(&blink).ime_cursor()
// AppSpec { .., on_key: Some(on_key), on_ime: Some(on_ime) }
```

- The window already called `set_ime_allowed(true)`. Now `WindowEvent::Ime`
  Preedit/Commit/Enabled/Disabled go to `Runtime::on_ime` first and to the focused
  `text_input` only when it returns `false`.
- `ime_cursor()` → in `build`, `rt.ime_area = drawn rect` of the marked element (a focused
  `text_input` wins; if several are marked, the last one drawn wins). The shell already passes
  `ime_area` to `window.set_ime_cursor_area` every frame.
- **Which path delivers what (macOS, winit 0.30.13 `view.rs`):** ordinary typing, including
  ⌥+letter that types a character directly (⌥A → `å`), arrives **once**, as `Key::Text` through
  `on_key`. winit's `insertText` emits `Ime::Commit` only while there is marked text, so a plain
  key is never also an IME commit. Composition goes only through `on_ime`. A dead key (⌥E) gives
  `Preedit("´", Some((2,2)))`. The next key (E) gives `Preedit("", None)` then `Commit("é")`. The
  keys pressed while composing (the E, and Backspace/Enter/arrows inside a CJK composition) are
  *not* sent as `KeyboardInput`, so they don't reach `on_key`. CJK works the same way, with
  several preedits and then a commit.
- **Not verified live:** none of this could be exercised headless against a real NSTextInputClient,
  and nothing was tested in a real window. The press-and-hold accent picker is a known weak spot.
  The held key's first character arrives as `Key::Text("e")`. If macOS then replaces it through
  `insertText:replacementRange:` without marked text, winit drops the replacement (it ignores
  `replacementRange`; see the `TODO` in winit's `insert_text`). If macOS marks it first, we get
  `Preedit("e")` + `Commit("é")` while the plain `e` is already in the document, so the result is
  `eé`. Check this in a window. If it's broken, the fix belongs in winit, not Rune. A workaround
  is `defaults write <bundle-id> ApplePressAndHoldEnabled -bool false`, which turns held keys into
  key repeat.
- On Linux/Windows, IMEs (IBus, fcitx, text-input-v3) may send `Commit` for ordinary characters as
  well as `KeyboardInput`. Rune's own `TextEdit` already had this behaviour. It wasn't changed or
  tested here.
- Script: `{"t":0.5,"type":"ime","preedit":"´"}` (optional `"cursor":[a,b]`, defaults to the end),
  `{"type":"ime","commit":"é"}`, `{"type":"ime","enabled":true|false}`. `--tree` JSON now has a
  top-level `"ime_area": [x,y,w,h] | null`.

### 2. Drags inside scroll viewports

`pointer_down`/`pointer_move`/`pointer_up` measure `Drag.x/y` from a private `Runtime::gesture_rect(i)`.
That's the layout target shifted by the `dy` of the scroll viewports (and growth rows) above it,
taken from the last build, which is the same offset hit-testing uses. In-flight layout motion is
still ignored, as before. Nothing changes in the API. `scroll viewport > surface (on_drag) >
absolute lines` now works. See `12-scroll-click-fixed.png`, where the caret lands under the
pointer (line 4) after scrolling 64 pt. Before, it landed on line 2.

### 3. Mouse button, modifiers and click count

```rust
// el.rs
pub enum Button { Left /* default */, Right, Middle }
pub struct Drag {
    pub phase: Phase, pub x: f32, pub y: f32, pub w: f32, pub h: f32,
    pub start_x: f32, pub start_y: f32, pub data: f32,
    pub button: Button,   // new
    pub mods: Mods,       // new: held at this phase (Down/Move/Up each report the current ones)
    pub clicks: u32,      // new: 1, 2, 3, ... for the whole gesture
}
// runtime.rs
pub double_click: f64                                   // seconds; NSEvent.doubleClickInterval on macOS, 0.4 elsewhere/headless
pub fn set_mods(&mut self, mods: Mods)                  // the shell calls this on ModifiersChanged
pub fn pointer_down_with(&mut self, x: f32, y: f32, button: Button)
pub fn pointer_up_with(&mut self, x: f32, y: f32, button: Button)
// pointer_down/pointer_up(x, y) are unchanged (= Left)
```

```rust
fn on_drag(ed: &mut Ed, d: &mut Drag, tx: &mut Tx) {
    let p = hit(d.x, d.y);
    if d.phase == Phase::Down {
        match (d.button, d.clicks.min(3)) {
            (Button::Right, _) => open_context_menu(p),
            (_, 1) => ed.set(p, d.mods.shift),       // shift-click extends
            (_, 2) => ed.select_word(p),
            _ => ed.select_line(p),
        }
    }
    tx.instant();
}
```

- Clicks count when presses of the same button are within `double_click` seconds and 4 pt of
  the previous press. Time comes from the wall clock in a window and from the virtual clock
  headless.
- Only the left button focuses fields, blurs and fires `on_press`. Right and middle presses go
  only to `on_drag`, and only on elements that have one. A second button pressed during a capture
  is ignored. `on_press` stays `Fn(&mut S)`, with no modifiers or count; use `on_drag`'s `Down`
  when you need them.
- Script: `tap`/`click`/`down`/`drag` take `"shift"|"cmd"|"alt"|"ctrl"|"logo": true` (held from
  the press to its release) and `"button": "left"|"right"|"middle"`. `tap` also takes
  `"clicks": N`, which sends N presses 0.12 s apart, e.g.
  `{"t":0.8,"type":"tap","x":400,"y":287,"shift":true}` or `{"type":"tap","x":290,"y":255,"clicks":2}`.

### 4. Window size in the view

```rust
impl<S> Cx<S> { pub fn viewport(&self) -> (f32, f32) }   // logical points; the --size viewport headless
```

```rust
fn view(ed: &Ed, cx: &mut Cx<Ed>) -> El {
    let col_w = (cx.viewport().0 - 48.0 - 2.0 * PAD).clamp(200.0, 600.0);
    COL_W.set(col_w);   // handlers/measurer read the same width
    ...
}
```

Resizing already reruns the view (`set_viewport` → relayout commit). See `17-narrow-window-wrap.png`
(`--size 520x560`).

### 5. Italic

```rust
pub struct Span { /* … */ pub italic: bool }   // new
pub const rune::text::DEFAULT_FONTS: [&[u8]; 3]  // now public: built-in Inter Regular/Medium/SemiBold
```

- `layout_rich` pushes `StyleProperty::FontStyle(FontStyle::Italic)` for the span. Fontique picks
  the family's italic face if one is registered. If not, it reports `synthesis().skew() == 14°`, and
  Rune rasterizes those glyphs with a swash skew transform. The angle is part of the glyph atlas
  key and the span is part of the layout hash.
- To get real Inter Italic, list it with the built-in faces (they register as the same family, so
  `families` stays `("Inter", ..)`):
  `fonts: &[DEFAULT_FONTS[0], DEFAULT_FONTS[1], DEFAULT_FONTS[2], include_bytes!("Inter-Italic.ttf")]`.
  `Inter-Italic.ttf` is `extras/ttf/Inter-Italic.ttf` from the Inter 4.1 release (OFL). The spike
  loads it from `spikes/rune-editor-spike/fonts/` (gitignored) when run with `--italic-font`.
- Our own measurer has to push the same `FontStyle::Italic` (the spike's `Measurer` does).
  Synthesized oblique doesn't change advances. A real italic face does.
- Usage: `Span { italic: true, ..Span::new(a, b) }`. Compare `10-italic-synth.png` with
  `11-italic-real.png`.

### 6. PageUp / PageDown

`Key::PageUp` and `Key::PageDown` (from `NamedKey::PageUp/PageDown`) now reach `on_key`.
`text_input` treats them as Home/End. Script: `{"type":"key","name":"PageDown","shift":true}`.

### Spike changes and PNGs

The spike (`spikes/rune-editor-spike`) now uses all of these:
- `on_ime` with an underlined inline preedit spliced in at the caret
- `.ime_cursor()` on the caret
- `d.clicks` instead of its own `Instant` timing, and shift-click to extend
- `Cx::viewport` for the column width (at most 600 pt)
- `*italic*` spans
- PageUp/PageDown to jump to the document start/end
- `rune::text::DEFAULT_FONTS` instead of `include_bytes!` paths into the Rune checkout

New scripts are `scripts/shift-click.json`, `scripts/ime.json` and `scripts/double-click.json`.
The PNGs are in `docs/img/rune-patches/`:

| PNG | Command (from the spike dir, `B=target/release/rune-editor-spike`) | Shows |
|---|---|---|
| `10-italic-synth` | `$B --snap … --size 760x560` | `*interesting case*` in synthesized oblique |
| `11-italic-real` | `$B --italic-font --snap …` | the same with the real Inter Italic face |
| `12-scroll-click-fixed` | `$B --scroll --script scripts/scroll-click.json --snap …` | after scrolling 64 pt, the click lands on the line under the pointer (`caret 4:21`, `ime_area` y 147 for tap y 159) |
| `13-shift-click` | `$B --script scripts/shift-click.json --snap …` | a click at 2:26, then a shift-click in the paragraph extends the selection to 5:122 |
| `14-ime-preedit` | `$B --script scripts/ime.json --at 0.8 --snap …` | dead-key preedit `´` underlined at the caret |
| `15-ime-commit` | `$B --script scripts/ime.json --snap …` | `Commit("é")` then typing `t ` gives `this is ét bold` |
| `16-double-click` | `$B --script scripts/double-click.json --snap …` | `clicks: 2` selects the word `across` |
| `17-narrow-window-wrap` | `$B --snap … --size 520x560` | the column wraps to the window |

