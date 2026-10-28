# editor-core

The pure logic of Grimoire's live-preview Markdown editor, ported from the TS editor in
`multiplayer-notepad/src/client/editor` (parser, units, rules, reveal, navigation, history, plus the
DOM-free parts of view/input/render). It has no UI. The spec it implements is
`docs/04-editor-engine.md` in that repo.

## Index units

- **Every offset is a byte offset into the UTF-8 text, and always on a char boundary.** The TS
  uses UTF-16 offsets. AppKit (`NSString`, `NSTextInputClient`) also uses UTF-16, so convert at
  the boundary with `text::utf16_to_byte` / `text::byte_to_utf16`.
- `Sel { anchor, head }`: `head` is where the caret is. `anchor == head` is a caret.
- **Caret stops:** the caret never sits inside these atomic units:
  - block prefix tokens (`# `, `- `, `- [ ] `, `1. `, `> `, one token per indent level, an `---` rule)
  - escape pairs (`\*`)
  - **grapheme clusters**. The TS only treats surrogate pairs as atomic. Here `é` written as e plus
    a combining accent, or 👍🏽, is one step and is deleted as one unit. A cluster never crosses
    inline syntax (marker, escape pair or link URL edges), so a combining mark after `**` or `\*` is its
    own unit. Word motion and Cmd-B classify a cluster by its base char.
  - **collapsed links**: a link stays collapsed whatever the selection (the caret or a selection
    in it never reveals it), and its brackets, URL and the edges of its text are no stops: the
    caret steps through `[docs](url)` as through `docs` (before the link, inside its text, after
    the link). Words and Up/Down treat it as its text too. Typing inside the text edits it, at the
    edges outside the link. Backspace / Delete / word and line deletions at the caret delete only
    the link's text (never a nested style's markers for a character step); one that would leave
    none deletes the whole link. A selection deletes whatever syntax it covers, as elsewhere.
  - `Editor::expand_link(pos)` (the UI's pencil; `Command::ExpandLink` is the hook for a future
    key binding, unbound) expands the link at `pos`: its brackets and URL show and are ordinary
    text (every position a stop, typing edits the URL), the caret at the end of its text. At most
    one link is expanded (`Doc::expanded_link`, its `[`, mapped through every edit); it collapses
    once the selection leaves `[`…`)` or the link is gone (deleted locally, by undo or remotely).
    `Editor::expanded_link()` says which.
- The editor snaps every selection it sets. If you set selections from outside, use
  `Editor::set_selection`, which snaps for you.

## Driving the editor (`Editor`)

```rust
let mut ed = Editor::new(markdown);
ed.insert_text("x");             // typed text / IME commit (smart typing, conversions, "> " rules)
ed.key(key, mods, &layout);      // non-text keys and shortcuts through the keymap; returns the Command run
ed.paste(&clipboard_text);       // raw markdown, own undo step
let s = ed.cut(); let s = ed.copy();
ed.mouse_down(&layout, x, y, click_count, shift);  ed.mouse_drag(&layout, x, y);
ed.toggle_todo(line_index);      // a click on a todo checkbox token
ed.begin_composition(); ed.end_composition(&committed);   // IME: show the marked text yourself
ed.set_text(&remote_text);       // external replace: keeps the caret, clears undo (text kept as is, "\r" too)
ed.apply_remote(&[(range, text)]); // collaborator edits (byte ranges, in order): not undoable, history rebased
let lines = ed.render_lines();   // draw this
```

There are also direct commands:

- editing: `insert_paragraph`, `insert_line_break`, `delete_backward`, `delete_forward`,
  `delete_word_backward`, `delete_word_forward`, `delete_to_line_start`, `delete_to_line_end`,
  `tab(shift)`, `toggle_format(FormatType::{Bold, Italic, Underline, Strike, Highlight})`,
  `replace_range` (spelling corrections); the macOS text-system ones: `yank`, `transpose`,
  `open_line`, `delete_backward_decomposing`, `insert_char`, `delete_to_mark`
- selection and history: `select_all`, `select_word`, `select_paragraph`, `set_mark`,
  `swap_with_mark`, `select_to_mark`, `undo`, `redo`, `expand_link(pos)` (a link's pencil)
- movement: `move_horizontal(dir, extend, HUnit::{Char, Word, Line, Doc})`,
  `move_paragraph`, `move_line_edge(&layout, dir, extend)`, `move_vertical(&layout, dir, extend)`,
  `hit_test(&layout, x, y)`
- keys: `set_key_table(Some(Arc<KeyTable>))` (see Keymap), `kill_buffer` / `set_kill_buffer`, `mark`

State accessors: `text()`, `selection()`, `selected_text()`, `doc()` (the parsed lines),
`reveal()`, `expanded_link()`, `goal_x()`, `can_undo()`, `can_redo()`, `set_read_only()`, `store()`.

After any call, re-run `render_lines()` and redraw. Draw lines whose `LineView` is unchanged from
the previous frame from cache: `LineView` implements `PartialEq`, so you can diff old against new.

## Text storage and remote edits

`Editor<S: TextStore = StringStore>`: the editor parses its own copy of the text and mirrors every
change into a `TextStore` (`text`, `len`, `slice`, `replace(range, &str)`, `replace_remote`), so a
collaborative store (yrs) can plug in. `Editor::new(text)` uses `StringStore`;
`Editor::with_store(store)` takes any store, `store()` reads it back. A store sees local changes
(edits, undo/redo, `set_text`) through `replace` and `apply_remote`'s through `replace_remote`
(default: `replace`; a CRDT-backed store that already holds them just updates its copy).

`apply_remote(&[(Range<usize>, String)])` applies edits made elsewhere, each a byte range of the
text as left by the edits before it (clamped to char boundaries). Like Y.UndoManager's
local-origin tracking:

- nothing is recorded for undo, the current undo group goes on, read-only editors apply them too
- the selection maps like the TS relative positions (a caret at an insertion point stays before
  the inserted text; a selection's edges stay outside text inserted at them), and so do the IME
  composition range, literal lines and the click state; the goal x is kept
- every undo/redo item is rebased onto them (operational transform, `History::map_remote`): undo
  still reverts exactly the local change, never remote text. Text inserted remotely inside a
  range an undo deletes stays; local text deleted remotely isn't restored by redo or deleted
  again by undo; text an undo restores at a remote insertion point goes before the remote text.

## Layout trait (you implement it)

Up/Down, clicks and table hits need geometry from the **current** drawing, meaning the layout
built from the latest `render_lines()` with markers collapsed or revealed as they are on screen.
The engine hit-tests the target line *before* it reveals anything. That ordering keeps the caret
moving predictably near formatting (a click or Up/Down lands where the line was drawn).

```rust
trait Layout {
    fn caret_rect(&self, pos: usize) -> Rect;            // {left, top, bottom}; hidden segments have zero width
    fn hit_test(&self, x: f64, y: f64) -> Option<usize>; // native hit: nearer edge of the glyph under x on the visual line under y
    fn bounds(&self) -> Bounds;                          // whole laid-out document
    fn table_cell_at(&self, line: usize, x: f64, y: f64) -> Option<usize> { None } // cell under x (clamped to first/last)
    fn line_mid_y(&self, line: usize) -> Option<f64> { None }
    fn image_at(&self, x: f64, y: f64) -> Option<(usize, usize)> { None } // source range of the image under a point
    fn adjacent_line_y(&self, pos: usize, dir: i32) -> Option<f64> { None } // middle of the visual line above/below pos
    fn adjacent_line(&self, pos: usize, dir: i32) -> Adjacent { /* adjacent_line_y: None -> Unknown */ } // Y(mid) | Edge | Unknown
    fn probe_step(&self) -> f64 { 4.0 }                  // Up/Down probe step in y
}
```

- `hit_test` should return a raw offset at a glyph edge. Tokens resolve to their
  start or end. The engine applies the line-edge fixes itself: a click past hidden closing markers
  goes to the line end, and a click before hidden opening markers goes to the text start.
- Up/Down keeps a goal x across wrapped lines. Implement visual lines in your layout and the
  engine handles the rest. With `adjacent_line` (`Adjacent::Y`) it hit-tests once at the adjacent
  visual line's middle (stepping on by `probe_step` only when that isn't a stop, e.g. an image below
  text); `Adjacent::Edge` (no visual line that way) sends the caret to the document's start / end
  without probing; `Adjacent::Unknown` probes from the caret box in `probe_step`s. The default
  `adjacent_line` wraps the older `adjacent_line_y` (None = unknown); layouts that know the edge
  implement `adjacent_line`. Both must land the same:
  return the row a probe from just outside the caret box would reach first. Image rows count
  as visual lines.
- `hit_test` results go through `hit_test_adjusted`, which always returns a char boundary.
- Shift-click and drag extend to the raw `hit_test` without the edge fixes, like the TS (where the
  browser extends the native selection); only a plain click's caret is adjusted.
- **Hit affinity:** a text engine that drops hidden markers from its drawn string can map a hit
  back with `layout::DisplayMap`: push each drawn unit (`push(raw_from, raw_to, display_len)`), then
  `raw_at(display, upstream)`. Upstream (the right half of the glyph before) keeps the caret on
  that glyph's side of hidden markers: in collapsed `plain **bold** text` the right half of `d` is
  12 (before `**`, typing stays bold) and the left half of the space is 14, as `caretPositionFromPoint`
  + `domToRaw` give in the TS. `DisplayMap::from_line` builds one for a `LineView` drawn as is.
- `MonoLayout` is a monospace, no-wrap implementation used by the tests (it answers
  `adjacent_line`; `tests/vertical.rs` checks it against the probing fallback):
  - 10 px columns and 20 px rows
  - two-column tokens (heading tokens have zero width)
  - one column of padding between table cells

## What to draw (`render_lines() -> Vec<LineView>`)

Each source line produces one `LineView`:

| field | meaning |
|---|---|
| `index`, `from`, `to`, `text_from` | line index, raw range (`to` excludes the `\n`), where the content starts after the prefix tokens |
| `kind: BlockType` | `Paragraph, Heading, Bullet, Todo, Numbered, Quote, Hr, Fence, Code, TableHead, TableDelim, TableRow` |
| `level`, `checked`, `number`, `indent` | heading level, todo state (checked todo text: gray, no strikethrough), item number, indent levels |
| `gutter_levels` | content indent in gutter widths (indent levels, +1 for a list or quote token) |
| `active` | holds the caret. The heading token shows its `H1`…`H6` label only on the active line |
| `revealed` | the code fences or table syntax on this line are revealed |
| `collapsed` | a code fence or table delimiter row that isn't revealed: draw it collapsed (the TS uses 8 px / 0 px) |
| `code: Option<CodeView{first,last}>` | the line is inside a fenced block |
| `table: Option<TableView{align, cells, columns}>` | table row info. Rows with fewer cells get placeholder cells |
| `segments: Vec<SegView>` | the runs to draw, in order |

`SegView { kind, from, to, styles: Vec<InlineType>, hidden, token, cell, el }`:

- `Token`: a block prefix (`token: TokenKind::{Indent, Heading, Bullet, Todo, Numbered, Quote, Hr}`).
  It is atomic, and you draw it as a gutter glyph:
  - Bullet: •
  - Todo: a checkbox, filled when `checked`
  - Numbered: the raw text trimmed (`1.`)
  - Heading: `H{level}`, shown only when `active`
  - Hr: a rule
  - Indent and Quote: blank (Quote also gets a bar on the line)
- `Text`: draw the raw text with `styles`:
  - `Bold`, `Italic`, `Strike`, `Underline` (`~x~`)
  - `Highlight` (`==`)
  - `Code` (pill)
  - `Link`
  - `Tag` (`#tag`)
- `Marker`: inline syntax (`**`, `[`, `](`, `)`, backticks…). When `hidden`, draw it at zero width.
  Otherwise draw it in the element's font and the marker color. `el` is the element index.
- `Escape`: an escape backslash. Always hidden.
- `Chip`: a link URL (open it via `url::safe_url`). Ordinary text, its segments carrying the
  link's `el`: hidden while the link is collapsed (the UI draws its pencil there, right after the
  link text), shown as text (in the marker color) when the link is expanded.
- `Fence`: the text of a fence line. Hidden unless `revealed`.
- `Pipe`, `Pad`, `Delim`: table syntax (`cell` says which cell the segment belongs to). Hidden
  unless `revealed`.

Hidden segments still hold raw text. The engine guarantees the caret is never next to a hidden
character.

## Keymap (macOS)

There are two tables. `Editor::key` uses `keymap::bindings()` unless `set_key_table` gave it a
`macos_keys::KeyTable`:

- `keymap::bindings()`, in precedence order (first match wins, and each entry has a `doc`
  string; `keymap::resolve(key, mods)` looks a key up), is the web app's: the browser does the rest
  of the text system's keys there, and off macOS its shell turns Ctrl into Cmd. Printable
  characters are not in the keymap: send them to `insert_text`.
- `KeyTable::standard()` (the native app's) is the macOS text system's own table: AppKit's
  `StandardKeyBinding.dict` copied into `macos_keys::STANDARD`, selector by selector on the
  commands below (the next section). `KeyTable::add_dict(text)` puts a user's
  `~/Library/KeyBindings/DefaultKeyBinding.dict` over it. `KeyTable::resolve` takes the Cmd-character
  shortcuts of `bindings()` first (Cmd-B, Cmd-Z, folds: menu key equivalents win in Cocoa too),
  then the table (later dicts win), then `bindings()` for chords the dict doesn't name
  (Shift-Backspace, Cmd-Delete, Shift-Enter, Cmd-Option-arrows...).

| Key | Command |
|---|---|
| Cmd-Z / Cmd-Shift-Z | undo / redo |
| Cmd-A | select all |
| Cmd-B / Cmd-I / Cmd-U | bold / italic / underline (`~x~`). Wraps the selection or the word, or inserts an empty pair; pressing again toggles off |
| Left/Right | one unit; Shift extends; with a selection, collapses it |
| Option-Left/Right | word (passes over markers) |
| Cmd-Left / Cmd-Right | text start, then column 0 / line end |
| Ctrl-Left/Right | not handled (system) |
| Up/Down | visual line with goal x (needs the `Layout`) |
| Option-Up/Down | line start / previous line, line end / next line |
| Cmd-Up/Down | document start / end |
| Home / End | `ScrollToStart` / `ScrollToEnd`, which the UI scrolls; the caret doesn't move (Mac behaviour) |
| Tab / Shift-Tab | context-dependent: nest a list item, insert a literal tab, indent a paragraph, move to the next table cell / outdent |
| Enter / Shift-Enter | smart paragraph (list continue/exit, fence auto-close, table rows) / raw newline |
| Backspace, Option-, Cmd- | character (removes a whole token at text start) / word / to text start |
| Delete (fn-Backspace), Option-, Cmd- | forward character / word / to line end |
| Ctrl-H / Ctrl-D / Ctrl-K | backspace / forward delete / delete to line end |

### The macOS table (`macos_keys`)

Every selector of `StandardKeyBinding.dict`, and what it runs (`macos_keys::selector`; the
`AndModifySelection` forms extend the selection from its anchor, as Shift-arrows do):

| Keys | Selector | Command |
|---|---|---|
| ←/→, Ctrl-B/F (Shift) | `moveLeft/Right`, `moveBackward/Forward` | `Move Char` (a selection collapses to its start / end) |
| ↑/↓, Ctrl-P/N (Shift) | `moveUp/Down` | `MoveVertical` (goal x kept across them) |
| Option-←/→, Ctrl-Option-B/F (Shift) | `moveWordLeft/Right`, `moveWordBackward/Forward` | `Move Word` |
| Ctrl-A/E (Shift) | `moveToBeginningOfParagraph` / `moveToEndOfParagraph` | `Move Line`: the logical line's text start, then column 0 / its end (after hidden closing markers) |
| Cmd-←/→, Ctrl-←/→ (Shift) | `moveToLeftEndOfLine` / `moveToRightEndOfLine` | `MoveLineEdge`: the visual line's ends on a wrapped line (the caret goes before the space a row ends with), else as Ctrl-A/E |
| Option-↑/↓ (Shift) | `moveBackward` + `moveToBeginningOfParagraph`, `moveParagraphBackward…` | `MoveParagraph` |
| Cmd-↑/↓, Shift-Home/End | `moveToBeginningOfDocument` / `moveToEndOfDocument` | `Move Doc` |
| Home / End | `scrollToBeginningOfDocument` / `End` | `ScrollToStart` / `ScrollToEnd` (the UI scrolls; the caret stays) |
| PageUp/PageDown (Shift), Option-PageUp/PageDown, Ctrl-V (Shift) | `pageUp` / `pageDown` | `Page` (the UI moves the caret a page). Plain PageUp/PageDown are `scrollPageUp/Down` in Cocoa; Grimoire keeps them moving the caret (`macos_keys::GRIMOIRE`) |
| Ctrl-L | `centerSelectionInVisibleArea` | `CenterSelection` (the UI scrolls) |
| Backspace, Ctrl-H / Delete, Ctrl-D | `deleteBackward` / `deleteForward` | `DeleteBackward` / `DeleteForward` |
| Option-Backspace, Ctrl-Option-Backspace / Option-Delete | `deleteWordBackward` / `deleteWordForward` | `DeleteWordBackward` / `DeleteWordForward` (kills) |
| Cmd-Backspace | `deleteToBeginningOfLine` | `DeleteToLineStart` (a kill; to the start of the text, then the token, then joins lines) |
| Ctrl-K | `deleteToEndOfParagraph` | `DeleteToLineEnd` (a kill; at a line end it deletes the newline, at a folded heading's end it unfolds first) |
| Ctrl-Y | `yank` | `Yank`: the kill buffer, its own undo step |
| Ctrl-T | `transpose` | `Transpose` (below) |
| Ctrl-O | `insertNewlineIgnoringFieldEditor` + `moveBackward` | `OpenLine`: a raw newline after the caret |
| Ctrl-Backspace | `deleteBackwardByDecomposingPreviousCharacter` | `DeleteBackwardDecomposing`: é → e (feature `decompose`: Unicode decomposition, so precomposed é and Hangul syllables too; without it only clusters written decomposed) |
| Return, Option-Return / Ctrl-Return | `insertNewline…` / `insertLineBreak` | `InsertParagraph` (smart Enter) / `InsertLineBreak` (a raw newline, as Shift-Return) |
| Tab, Option-Tab / Shift-Tab | `insertTab…` / `insertBacktab` | `Tab` |
| Ctrl-Shift-' / Ctrl-' | `insert…QuoteIgnoringSubstitution` | `InsertChar` (no typing rules) |

Not implemented (an entry naming one is ignored, so the key falls through to `bindings()`):
`scrollPageUp/Down` (Ctrl-↑/↓: a relative scroll needs the view's offset, which Rune doesn't
expose; Mission Control takes these keys by default), `selectNextKeyView` / `selectPreviousKeyView`
(Ctrl-Tab), `cancelOperation` (Esc, Cmd-.), `complete` (Option-Esc, F5), the writing-direction
and input-source selectors, `insertRightToLeftSlash`, `delete` (the Clear key). User dicts can
also use `moveToBeginningOfLine/EndOfLine`, `deleteToEndOfLine`, `deleteToBeginningOfParagraph`,
`setMark`, `swapWithMark`, `selectToMark`, `deleteToMark`, `selectWord`, `selectParagraph`,
`selectAll`, `insertParagraphSeparator`, `undo`, `redo` and `noop` (the key does nothing); other
selectors (`capitalizeWord:`, `transposeWords:`, `yankAndSelect:`…) and multi-key sequences
(nested dicts) are skipped.

- **Kill buffer:** word, line and paragraph deletes, Ctrl-K and `deleteToMark` put what they delete
  there, separate from the clipboard. Kills in a row (no other command, the selection where the
  last one left it) add to it, after it for forward kills and before it for backward ones, as in
  TextEdit (Ctrl-K three times from `a|bc⏎def⏎ghi` holds `bc⏎def`). A selection is killed whole.
  The native app carries it from note to note (`set_kill_buffer`).
- **Transpose** (checked against `NSTextView`): it swaps the units on either side of the caret and
  moves past both; at a line end the two before it (the caret stays); at a line start the newline
  and the first character (plain paragraphs only); nothing at the document start or with a
  selection. Units are caret units (a grapheme cluster moves whole). Syntax never moves: nothing
  happens when a unit is a block token, a marker, an escape, a link URL or a table pipe, or the two
  are in different table cells.
- **Mark:** `setMark` keeps the caret's position (mapped through every edit); `swapWithMark` swaps
  them, `selectToMark` selects from it to the caret, `deleteToMark` kills that range.
- **Dict format** (`parse_dict`): old-style plist text (`{ "^a" = "sel:"; }`, `//` and `/* */`
  comments, quoted or bare strings, `\U` / `\u` / octal escapes, arrays in parentheses) or the JSON
  `plutil -convert json` writes (for XML or binary dicts). **Chords** (`parse_chord`): `^` Ctrl, `~`
  Option, `$` Shift, `@` Cmd (`#` ignored), then a character (an uppercase letter means Shift; a
  punctuation character matches with or without Shift) or a key code (`\UF700`–`\UF703` arrows,
  `\UF728` forward delete, `\UF729`/`\UF72B` Home/End, `\UF72C`/`\UF72D` PageUp/PageDown,
  `\U007F` Backspace, `\U000D` Return, `\U0009` Tab, `\U0019` Shift-Tab, `\U001B` Esc). Other
  function keys and the alternate control characters (`\U0003`, `\U0008`, `\U000A`) aren't keys
  the editor gets and are skipped.
- **Not like Cocoa:** Shift-extended line, paragraph and document moves pivot on the anchor
  (Shift-Cmd-← then Shift-Cmd-→ selects from the anchor to the line end, as the Shift-arrows here
  always did; Cocoa grows the selection to the whole line); `deleteToBeginningOfLine` and
  `deleteToEndOfLine` work on the logical line.

Tests: `tests/macos_keys.rs` (every selector, hidden markers, folds, undo groups, kill/yank,
transpose at line edges, Shift-extend, goal x, read-only, the dict and chord parsers, a user dict,
and a check that every key Grimoire already handled does the same through the table).

Clipboard keys (Cmd-C/X/V) are left to the UI. Call `copy`, `cut` and `paste`. PageUp/PageDown
aren't bound (paging needs the viewport): the UI pages. When read-only, `Editor::key` runs no
edit (movement still runs): Tab and the editing keys return None (left to the system, as in `input.ts`), the formatting
and undo shortcuts are swallowed.

## Undo grouping (as in the TS)

- Every edit joins the current group: typing, Backspace, Enter, and arrows that come back to the
  same spot. There is no time-based break.
- A new group starts when:
  - the caret jumps (an edit somewhere other than where the last edit left the caret)
  - the UI or program sets the selection (`set_selection`, clicks, select all)
  - a paste, cut, todo toggle or table row insertion happens (each is its own step)
- An auto-conversion (`- ` becoming a bullet) is its own step. Undoing it changes no text: the line
  is just shown literally until it's edited again.
- Undoing a deletion selects the restored text.

## Modules

| module | contents |
|---|---|
| `parser` | blocks, inline, tables |
| `units` | caret stops, words |
| `rules` | edits |
| `reveal` | which markers show |
| `render` | segments, `LineView` |
| `navigation` | moves, hit-test fixes |
| `history` | undo |
| `editor` | the state machine |
| `keymap` | key bindings (the web's) |
| `macos_keys` | the macOS text system's bindings, the dict and chord parsers |
| `layout` | the `Layout` trait and `MonoLayout` |
| `store` | `TextStore`, `StringStore` |
| `text` | char classes, UTF-16 conversion |
| `url` | `safe_url` |
