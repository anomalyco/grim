# Editor parity rig

Plays the same keystroke scenarios in Bear and in our editor on the Mac, using native key events, and compares what the user sees after each step. It does not compare Bear's internals, only the visible result.

## Pieces
- **`scenarios.json`:** each scenario has a `doc` (markdown), a starting caret `at` (`needle@offset` within the visible text, or `$` for the end), and `steps`:
  - `type:<text>`: types the text, one character per key event.
  - `key:<NAME>[+cmd][+alt][+shift][+ctrl]`: a key press. Names are `RET BS FDEL TAB LEFT RIGHT UP DOWN HOME END ESC SPACE`, or a letter (`A B I Z V C X U S K`).
  - `at:<needle@offset>`: moves the caret, like a click.
  - `clip:<text>`: sets the clipboard (`\n` for a newline).
  - `wait:<ms>`: pauses.
- **`runner.swift`:** runs on the Mac. It drives Bear (scratch note `ZZ opencode render test`) through the Accessibility API, and drives our editor in a separate Chrome instance through CDP on port 9333. It records the view of the caret's line after every step, plus the final raw markdown.
- **`page.ts`:** the test page. It mounts our editor (the Rust engine; wasm from `src/client/editor-rs/pkg`, inlined by `run.sh`) on a local document and exposes `window.__parity` for the runner.
- **`compare.ts`:** turns the two result files into a Markdown report.

## View format
- Hidden characters are omitted.
- `▸` is a block token (bullet, heading, quote, todo, numbered gutter); `✎` is a link chip.
- `‹x›` is a visible syntax marker.
- `⟨FLAGS:text⟩` is a styled run, with flags `B` bold, `I` italic, `S` strike, `U` underline, `H` highlight, `C` code.
- `|` is the caret; `[…]` is a selection.

## Run
```bash
tools/parity/run.sh both       # all scenarios, both targets, then report
tools/parity/run.sh bear       # re-record the Bear baseline only
tools/parity/run.sh ours nav.  # our editor only (the default), scenarios whose id contains "nav." → ours.json, report.md
```
The runner posts keys to the parity Chrome only, but the user's own input while it runs (dictation, clipboard tools, clicks) can land in the page and fail a scenario at random; rerun failures one by one (`run.sh ours <id>`) before believing them.
The Mac must be unlocked; while locked, Bear's accessibility tree is empty. Bear and the parity Chrome window take focus while the runner works.
