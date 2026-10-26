# Editor Engine: Bear-style live markdown, built from scratch

Goal: a browser/HTML editor whose **interactions** match Bear 2.8.1 exactly. That means how the caret moves, when typed syntax flips to rendered style, Enter/Backspace/Tab, and undo. Visual styling comes second (theme tokens are already in `reference/bear/red-graphite.theme.json`). No editor libraries: model, parser, renderer, input handling, navigation and history are all ours.

Part 1 is the observed spec, measured from Bear by driving it through the macOS Accessibility API and checked against screenshots (harness in `reference/bear/probes/`, screenshot client `tools/bearshot`). Part 2 is the architecture. Part 3 is the phased plan. Part 4 is verification status and what remains unprobed.

---

## Part 1: Observed Bear interaction spec

### 1.1 Core model
- **The raw markdown is the document.** Bear never removes syntax characters. Every `*`, `~`, `==`, `` ` ``, `[`, `](`, `#` stays in the text storage.
- **Collapsed markers:** inline markers of an element the caret isn't touching are rendered at 0.01pt (zero width, invisible) but still exist.
- **Reveal rule:** an inline element's markers are revealed when the caret is anywhere in `[elementStart, elementEnd]`, **inclusive of both outer edges**. Measured on `**bold**`: caret just before the opening `**` → revealed; caret just after the closing `**` → revealed; one character further → collapsed. Only the touched element reveals. Others on the same line stay collapsed.
- **Revealed markers** render at full size in the *element's own font* (bold `**` is bold, italic `*` is oblique), in the marker color `#D8D8D8`. Highlight `==` uses the highlight text color at 40% alpha.
- **Consequence (key invariant):** the caret is never adjacent to an invisible character, so every keystroke acts on visible text.
- **Block prefixes are atomic tokens:** `# `/`## `/`### `, `- `, `- [ ] `, `> `, list indentation (one token per level), and `---` are each rendered as a single glyph in a left gutter (33pt; list content is indented 33pt per level). The caret has exactly **one stop before the token** (column 0, in the gutter) and one after it. It can never be inside `## `.
- **Numbered lists** are the exception: `1. ` stays visible as text (accent red), with a gutter token in front. The whole `1. ` prefix is still one caret unit, and the first stop in the text is after `1. `.
- **Code blocks:** the ```` ``` ```` fences and the language tag are collapsed when the caret is outside the block. When the caret is anywhere in the block, both fences reveal (in code font, marker color).
- **Links:** `[text](url)`: the URL is an **atomic chip token**: one caret unit, drawn as a pencil icon after the link text and always visible. With the caret inside, `[` and `](`…`)` reveal around the chip, never the URL text. Editing the URL happens through the chip (UI not probed).
- **Selections:** every element that **intersects the selection** reveals its markers. A selection to the end of the line reveals all of them (verified by screenshot).
- **Nesting:** revealing an element also reveals all markers *inside* it. Caret in the outer part of `**bold *nested* inside**` → `**` and the inner `*` both reveal. `***x***` reveals as `*`+`**`, bold-italic.
- **Escapes:** in `\*x\*` the backslash is collapsed and the `*` is shown as a literal. The caret inside doesn't reveal the backslashes.
- **Visual extras:** a highlight shows a color-picker chip at its start when the caret is inside it. Inline code gets a gray pill. A checked todo's text turns gray (#878787) with no strikethrough.

### 1.2 Typing: when it flips to rendered
- **The text is re-parsed after every keystroke.** No debounce.
- **No auto-pairing:** typing `*`, `(`, `[`, `` ` `` inserts just that character.
- **Unclosed syntax is literal plain text:** `**abc` shows as normal text, not dimmed and not bold.
- **Styling applies the instant the element becomes valid.** Typing `**abc*` gives italic `*abc*` with a literal leading `*`, and the next `*` turns it into bold `**abc**`. The just-closed element is revealed, because the caret touches it.
- **Typing a character after the element** (e.g. a space) moves the caret off the edge, so the markers collapse and the text reflows. The caret's x jumps left by the markers' width.
- **Block conversions** (triggered by the keystroke that completes the prefix):

| Typed | Result |
|---|---|
| `#` then space | heading token (H1; `##`, `###` analogous). Caret after token |
| `-` then space | bullet token |
| `1.` then space | numbered item (`1. ` stays visible) |
| `[ ]` then space, inside a bullet | todo (unchecked) token |
| `>` | quote token **immediately**, no space needed |
| `---` (third dash) | horizontal rule token immediately |
| ```` ``` ```` then Enter | code block opens. Caret on first code line (indented, code font) |
| closing ```` ``` ```` then Enter | code block closes, caret on new plain line |
| `#`/`- `/`####`+space at the **start of an existing paragraph** | converts that line in place (H4 works too) |
| `#` directly before a word | becomes a **tag** first (`#existing`). The following space then makes it a heading |
| `#` typed right after an existing heading token | literal `#` (a tag if a word follows). It does **not** raise the heading level |
| `[a](http://x.y` then `)` | literal until `)`, then instantly a link. The URL collapses to the chip and the caret jumps (the URL is now one unit) |

- **Cmd-B / Cmd-I:**
  - On a selection: wraps it in `**`/`*` and keeps the inner text selected; pressing it again unwraps (toggle).
  - With no selection, inside a word: wraps the whole word, and the caret keeps its place in the word.
  - With no selection on empty space: inserts an empty marker pair with the caret between.
- **Paste:** inserts raw markdown and re-parses it. Multiline pastes become real blocks (bullets, headings). A `- ` mid-line stays literal. The whole paste undoes in one step.
- **Typing over a selection** replaces the raw text. Inside bold, the replacement stays bold.

### 1.3 Enter
- **In a list item:** a new item of the same kind. Bullet → bullet, todo → *unchecked* todo, numbered → auto-incremented (`2. `), quote → quote. Indent level is kept.
- **On an empty list/quote item:** the token is removed and the line becomes a plain empty paragraph. No new line is created.
- **After a heading:** a plain paragraph.
- **Inside a code block:** a literal newline within the block. **No auto-indent** (a new line after `  indented` starts at column 0).
- **Mid-text in a heading:** splits. The tail becomes a **plain paragraph**.
- **Mid-text in a bullet:** splits into two bullets.
- **At the start of a heading's or bullet's text** (after the token): inserts an empty line above (an empty bullet for lists, a plain empty line for headings). The caret stays with the text.
- **At column 0, before a token:** inserts a plain empty line above.
- **Numbered items are never renumbered.** Numbers are raw text. Removing item 1's prefix leaves `2. two`, `3. three` unchanged.

### 1.4 Backspace / Tab
- **Raw deletion, one character at a time,** including revealed markers. Deleting a closing `*` instantly re-parses (bold → italic → literal).
- **At the start of a block's content** (caret right after the token): removes the **whole token**. Heading → paragraph, bullet → plain line, numbered (`2. ` included) → plain line, quote → plain line. Verified by screenshot.
- **At column 0** (before the token, or a plain line): joins with the previous line. The merged content takes the *previous* line's block type: `• one` + `two` → `• onetwo`, `1. first` + `second` → `1. firstsecond`.
- **Option-Backspace** deletes a raw word backwards and can leave orphan markers: `word **bold** tail` with the caret before `tail` → `word **tail`.
- **Cmd-Backspace** deletes to the line start.
- **Forward Delete:**
  - At the end of a line: joins the next line **raw**. Its prefix becomes literal text: `• alpha beta` + `- second` → `• alpha beta- second`.
  - Before a bullet token: removes the token.
- **In a code block:** Backspace at the start of a code line joins it raw with the previous line. At the start of the *first* code line it merges into the fence line (```` ```  indented code ````), which breaks the block.
- **Tab** depends on context:
  - At the start of a list item's text: nests by one level, at most one level deeper than the item above (a further Tab does nothing).
  - In the middle of list text: inserts a literal `\t`.
  - Anywhere in a plain paragraph: indents the whole paragraph (adds an indent token at line start).
  - Inside a code block: inserts a literal `\t`.
- **Shift-Tab** outdents.

### 1.5 Left / Right
- **The caret steps one raw character per press,** including each revealed marker character. Collapsed markers are never stepped over silently, because they reveal first on approach.
- **Reveal/collapse changes layout,** so the caret's x visibly jumps when entering or leaving an element. Measured: leaving `**bold**` moves the caret x from 631 to 608.
- **A block token counts as exactly one step.** From the start of a bullet's text, Left goes to column 0 (gutter), and Left again goes to the end of the previous line.
- **Cmd-Left** first goes to the start of the text (after the block token, and after both tokens for a nested bullet). A second press goes to column 0, before the token. **Cmd-Right** goes to the end of the line.
- **Home/End** do nothing in the text (Mac default).
- **Option-Left/Right** jump to word boundaries and pass over markers (`Alpha **bold words**` stops at `Alpha|`, `**bold|`, `words|`).
- **Shift-arrows** extend the selection one raw character at a time, markers included (`a *`, `a **`). Shift-Option and Shift-Cmd follow the same rules as without Shift.
- **Left with a selection** collapses it to its start.
- **Mouse clicks** are hit-tested on the *current* layout, where the target's markers are collapsed. Clicking the right half of the last letter of `bold` puts the caret before the hidden closing `**`. Clicking the left half of the following space puts it after them. The markers then reveal.
- **Double-click** selects the word without its markers (`bold`). **Triple-click** selects the whole raw line including markers and the newline.
- **Clicking a todo checkbox** toggles it (`- [ ]` ↔ `- [x]`) and puts the caret at the start of the task text.

### 1.6 Up / Down
- **The caret moves by visual (wrapped) line,** not source line. A wrapped paragraph takes several presses.
- **A goal x-position in pixels is kept** across the whole run, whatever the font size (H1 30pt, H2 24, H3 19, body 15, code 13.9), indent, list nesting, quote, or code block. Measured: caret x stays at about 510–518 from H1 down through every element.
- **Short or empty lines clamp** (e.g. column 0 on an empty line, end of a ```` ``` ```` fence line). The goal x survives and is restored on the next longer line.
- **The HR line** has a single caret stop.
- **Movement away from formatting is symmetric:** 20× Down then 20× Up returns to the identical offset.
- **Near formatting it is not.** The target line is hit-tested in its *collapsed* layout, because the caret isn't there yet. Reveal happens after placement, which shifts text. Measured: caret at c12 inside `**bold**` (revealed, x=512), Up then Down lands at **c14**. At c10/c11 (before the element) it returns exactly. Reproduce this: hit-test the target line before toggling reveal.
- **The goal x resets** on any horizontal move or edit (standard text-view behavior).

### 1.7 Undo / Redo
- **Undo coalesces aggressively.** A continuous editing burst is one step even across a 2.5 s pause, arrow keys that return to the same spot, Backspaces, and Enter. Measured: `xy`, Enter, `zw` undid in one Cmd-Z, and so did `ab` + 3× Backspace.
- **Group boundaries** come from caret *jumps* (clicks / programmatic selection changes), paste (its own step), and auto-format conversions (see the next bullet). One early probe split Enter from typing, so check this edge with real keyboard timing during P0.
- **Auto-formatting is its own undo step:** after `- ` converts to a bullet, the first Cmd-Z restores the literal `- `, and the second removes the typing.
- **Inline styling is not an undo step,** since it's just a re-parse. Undo reverts the text and the style follows.
- **Redo is Cmd-Shift-Z.**

---

## Part 2: Architecture

**Where it lives now:** the engine (model, parser, reveal, rules, navigation, history, key map, folding) is Rust:
`crates/editor-core` in the grimoire-native repo (`parser.rs`, `rules.rs`, `reveal.rs`, `units.rs`,
`navigation.rs`, `history.rs`, `keymap.rs`, `fold.rs`; tests in `crates/editor-core/tests/`), shared with the native
Mac app and compiled to WebAssembly for the web (`crates/editor-wasm`). The web shell in `src/client/editor-rs/`
does the browser side of the layers below: the renderer (3), the offset map (4), the input bridge (6: `beforeinput`
and keys go to the engine) and the DOM geometry the engine's navigation asks for (8). The first implementation was
TypeScript (`src/client/editor/`); it was removed once the Rust engine passed the same tests and the Bear parity
rig (docs/rust-engine/PLAN.md). The design below is unchanged.

### 2.1 Layers
1. **Document model:** a single raw markdown string (source of truth, sent to and from the lock API in `02-architecture.md`) plus a selection `{anchor, head}` in raw UTF-16 offsets. Lines are kept as an array with stable IDs for incremental rendering.
2. **Parser (ours):**
   - **Block pass**, line by line with code-fence state. Each line gets a type (paragraph / heading n / bullet / todo / numbered / quote / hr / code / fence) plus the raw range of its prefix token.
   - **Inline pass** per block, producing elements `{type, start, end, openMarker:[a,b], closeMarker:[c,d]}` for bold, italic, underline `~`, strike `~~`, highlight `==`, code, link, wiki link, and tag.
   - Delimiter rules must reproduce Bear's partial-parse behavior (`**abc*` → literal `*` + italic). Re-parsing the whole document per keystroke is fine at notepad sizes; dirty-line re-parse is an optimization.
3. **Renderer:** one `<div>` per line inside a single `contenteditable` root.
   - Text is in spans per run.
   - Markers are `<span class="mk">` with collapsed (`font-size:0`, or `display:none`; to be decided by caret-rect testing) and revealed states toggled by a class.
   - Block tokens are a `contenteditable=false` gutter element mapped to the prefix's raw range.
   - Only re-render lines whose text changed. Reveal changes only toggle classes.
4. **Offset map:** for each line, a map between raw offsets and (DOM node, offset), and back. Atomic units, each a single caret step: block prefixes (including `2. `), list indent levels, and **link URLs** (the pencil chip). Collapsed markers have no caret positions, which is safe because of the key invariant.
5. **Reveal engine:** `revealed = elements whose [start,end] contains the caret (inclusive) or intersect the selection, plus all their descendant elements`, plus the whole code block's fences when the caret is inside it. Escape backslashes are always collapsed. Recomputed on every selection change, then the class diff is applied.
6. **Input controller:** listens to `beforeinput` and calls `preventDefault` on everything except IME composition (`insertCompositionText`, which is let through and then reconciled from the DOM). Each intent (`insertText`, `insertParagraph`, `deleteContentBackward`/`Forward`, `insertFromPaste`, `historyUndo`/`Redo`) becomes a model transaction. Then the rules engine runs, followed by parse, render, selection restore, and reveal.
7. **Rules engine (pure functions over model + caret):** covers:
   - block conversions, including in-place conversion of existing lines and tag-vs-heading for `#` (1.2)
   - Enter at each position: in text, at text start, at column 0, mid-heading, code (1.3)
   - Backspace / Option-Backspace / Cmd-Backspace / forward-Delete semantics, including raw joins (1.4)
   - context-dependent Tab
   - Cmd-B/I wrap/unwrap/word/empty-pair
   - checkbox toggle

   Conversions emit a **separate transaction** after the triggering keystroke so that undo reverts formatting first (1.7).
8. **Navigation controller:** owns the arrow keys (with and without Shift), Cmd/Option variants, clicks, and double/triple clicks rather than trusting native contenteditable behavior.
   - **Left/Right:** step one raw unit (atomic units count as one).
   - **Cmd-Left:** two-stage (text start, then column 0).
   - **Option-arrows:** word boundaries that ignore markers.
   - **Double-click:** the word without markers. **Triple-click:** the raw line.
   - **Up/Down:** keep `goalX`. Get the caret rect (`Range.getClientRects`), find the next visual line box, hit-test at `(goalX, lineMidY)` via `document.caretPositionFromPoint` **in the current layout (target still collapsed)**, and clamp. Then place the caret and reveal. This reproduces Bear's asymmetry (1.6).
   - **Clicks:** use the same hit-test-then-reveal order.
   - Reset `goalX` on horizontal moves and edits.
9. **History:** transactions `{changes, selBefore, selAfter, kind}`.
   - Coalesce *all* contiguous editing (typing, Backspace, Enter, arrows that don't jump) into one group, with no time-based break.
   - Break on caret jumps (click, programmatic selection), paste, and auto-conversions (separate entries). Redo stack.
10. **Theme:** CSS variables generated from `red-graphite.theme.json` (15px text, ×1.5 line height, heading scale 1.125 with top/bottom padding ×0.5/×0.3, 33px gutter, code 13.9px). BearSansUI fonts are proprietary to Bear, so use an open substitute (e.g. Inter/system-ui). RobotoMono (Apache-2.0) can be used directly.

### 2.2 Why model-driven `contenteditable` rather than a fully custom caret
A fully custom surface (hidden textarea + our own caret drawing, like Monaco) gives total control, but means rebuilding hit-testing, selection painting, IME, spellcheck and accessibility. A model-driven contenteditable keeps the native caret, IME, spellcheck and screen reader support while every mutation and caret move goes through our controllers. The key invariant (the caret never sits next to invisible markers) removes the classic contenteditable pain point. Fallback: if browsers misplace the caret around collapsed spans, switch markers to `display:none` and rely on the offset map.

### 2.3 Integration with the lock-based workspace
The editor works on the raw string. It's read-only until the human acquires the write lock (via the API in `02-architecture.md`). On save it writes with `epoch` + `expectedVersion`. Remote updates arriving while not editing replace the model and keep the caret by raw offset.

---

## Part 3: Phased implementation plan

- **P0. Finish the spec (0.5–1 day).** Run the Part 4 probes and record **conformance traces** as JSON: `{doc, caret, keys[], expected: [{raw, caret, revealed, line}]}`. These come from the Bear harness, so they're ground truth.
- **P1. Model + parser (1–2 days).** Block and inline parsers with Bear's partial-delimiter semantics. Unit tests from the traces' raw text.
- **P2. Renderer + offset map + reveal (2 days).** Static rendering with theme. Raw↔DOM mapping, reveal toggling on `selectionchange`, gutter tokens.
- **P3. Input controller + rules (2–3 days).** Typing, Backspace/Delete, Enter, Tab/Shift-Tab, block conversions, list continuation/exit, code fences.
- **P4. Navigation (2 days).** Left/Right with token units, Up/Down with goal x across mixed sizes/wraps, Home/End, Shift-selection, mouse click mapping.
- **P5. History (1 day).** Coalescing, conversion-as-separate-step, redo.
- **P6. Remaining features (2 days).** Paste (plain + markdown), IME/composition, link editing, todo click-to-toggle, selection-wide reveal.
- **P7. Parity suite (ongoing).** Playwright replays every Bear trace in Chromium/WebKit and diffs raw text, caret, revealed set and line. CI gate. New behaviors get a Bear probe first, then a trace, then an implementation.

---

## Part 4: Verification status

**Verified on 2026-10-24** (AX data + screenshots via `tools/bearshot`): everything in Part 1, including every item from the earlier open list. That covers:
- Backspace at numbered/quote text
- Cmd/Option-arrows and Home/End
- Shift-selection, double/triple click, and selection-wide reveal
- typing over a selection
- Cmd-B/I
- click hit-testing near collapsed markers
- Up/Down adjacency asymmetry
- paste (plain markdown)
- nested/escaped inline
- undo grouping
- checkbox toggle
- Enter / forward-Delete at every position
- Tab contexts
- code-block internals
- link typing

**Still unprobed:**
- the link URL edit UI (clicking the pencil chip)
- rich-text paste
- wiki-link/tag autocomplete popups
- tables, images and attachments
- `##`→H2 typed one key at a time (vs `####`, which was verified)
- heading-level behavior of forward-Delete before a heading token (no visible change measured; possibly a level change)
- the Enter-vs-typing undo split under real keyboard timing
- IME/composition input
- drag-selection and drag-and-drop

