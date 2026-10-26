# Rust editor engine on the web — plan and coordination

This file is the single source of truth for the "Rust engine on the web" project. Every agent working on it
**reads this whole file first**, **updates its own row on the board** when it starts/finishes, and **appends to the
Log** (newest at the bottom, one or two lines, with commit ids). Edit only your own row/log lines (small, targeted
edits — other agents edit this file concurrently). Put questions for the coordinator under "Open questions".

## Goal

Use the same Rust editor engine (`editor-core`, already used by the native Mac app) in the web app, compiled to
WebAssembly, while the web renderer stays an HTML/contenteditable editor (no Rune on the web). Multiplayer moves into
Rust using **yrs** (the Rust port of Yjs, wire-compatible with our unchanged server). The existing TS editor stays
the default until the Rust engine passes the same browser tests and the Bear parity rig.

## Where things are

| What | Where |
|---|---|
| Web app (TS, Bun) | this box: `/root/projects/multiplayer-notepad` (editor: `src/client/editor/`, tests: `test/editor/`, e2e: `test/e2e/two-users.mjs`, parity rig: `tools/parity/`) |
| Rust workspace | Mac laptop `~/projects/grimoire-native` (`crates/editor-core`, `crates/app` = native Rune app). Access: `ssh -o BatchMode=yes james@100.109.145.97`, prefix `export PATH="$HOME/.cargo/bin:$PATH"` |
| Rune (native only) | laptop `~/projects/worktrees/rune-grimoire` (branch `grimoire-patches`) — not used by the web |
| This file | this box: `/root/projects/multiplayer-notepad/docs/rust-engine/PLAN.md` |

Rules: **never run cargo on this box** (little disk; build on the laptop). Never touch `./data` or restart/deploy the
live server (the coordinator deploys). Commit with `git -c user.name=opencode -c user.email=opencode@localhost commit`,
only your own paths (`git commit -- <paths>`), small commits. The native app must keep building and its tests passing.

## Architecture

```
editor-core (Rust)  parser · rules · reveal · navigation · keymap · undo grouping · LineView · DisplayMap
   │  trait TextStore: StringStore (local files) | YrsStore (multiplayer, Yjs-compatible)   [phase C]
   │  trait Layout:    geometry questions answered by the front end
   ├── crates/app (native)        Layout from parley, drawn with Rune
   └── crates/editor-wasm         wasm-bindgen glue; boundary in UTF-16; returns Patches
          │
          └── web shell (TS): src/client/editor-rs/
                contenteditable div (as today) · beforeinput → preventDefault → engine command
                IME composes in the DOM → engine on compositionend · renders LineView → <div class="ln">
                (reuses editor.css and render.ts look) · JsLayout answers geometry from the DOM
                (caretPositionFromPoint, Range.getClientRects) · images, remote cursors as today
                └── Yjs/WebSocket to the unchanged server (phase A/B: JS Yjs mirrors text edits from Patches;
                    phase C: yrs inside wasm speaks y-protocols directly)
```

Ordering rule on every command: engine applies edit → shell patches the DOM → only then may the engine ask Layout
questions (navigation commands run against the already-patched DOM).

## Contracts (agreed interfaces — change only via the coordinator; note changes in the Log)

### 1. Units and coordinates
- Everything crossing the wasm boundary uses **UTF-16 code-unit offsets** into the Markdown text (like the DOM and
  Yjs). editor-core stays byte-offset internally; `editor-wasm` converts (`text::utf16_to_byte`/`byte_to_utf16`).
- Geometry is in **editor content coordinates** (CSS px, origin = top-left of the editor content box, including
  scroll), not client coordinates. JsLayout converts.

### 2. Layout (editor-core trait; new method added in A1)
Existing: `caret_rect(pos) -> Rect`, `hit_test(x,y) -> Option<pos>`, `bounds()`, `table_cell_at`, `line_mid_y`,
`image_at`, `probe_step`. **New (A1):** `fn adjacent_line_y(&self, pos: usize, dir: i32) -> Option<f64>` — the
vertical middle of the visual line just above (dir=-1) / below (dir=1) the caret at `pos`, or None at the document
edge; default impl returns None (engine then falls back to probing). `move_vertical` uses it when available.
**(RA)** `fn adjacent_line(&self, pos, dir) -> Adjacent` with `enum Adjacent { Y(f64), Edge, Unknown }`: `Edge` = no
visual line that way (Up/Down goes to the document's start/end without probing), `Unknown` = probe. Default impl wraps
`adjacent_line_y` (None → Unknown), so old layouts are unchanged; MonoLayout, the native app and the wasm JsLayout glue
implement `adjacent_line`.

### 3. JsLayout (the JS object passed into engine calls that need geometry)
```ts
interface JsLayout {
  caret_rect(pos: number): [x: number, y: number, w: number, h: number];
  hit_test(x: number, y: number): number | undefined;
  bounds(): [w: number, h: number];
  adjacent_line_y(pos: number, dir: -1 | 1): number | null | undefined;  // (RA) null = document edge, undefined = unknown (probe)
  table_cell_at(line: number, x: number, y: number): number | undefined;
  line_mid_y(line: number): number | undefined;
  image_at(x: number, y: number): [from: number, to: number] | undefined;
}
```

### 4. Engine (wasm-bindgen class, `crates/editor-wasm`)
```ts
class Engine {
  constructor(text: string);
  text(): string;
  render_all(): Patch;                       // full render (initial mount)
  insert_text(s: string): Patch;             // typed text / IME commit
  key(key: string, mods: number, layout: JsLayout): Patch | undefined;   // undefined = not handled → let the browser
  mouse_down(x: number, y: number, clicks: number, shift: boolean, layout: JsLayout): Patch;
  mouse_drag(x: number, y: number, layout: JsLayout): Patch;
  set_selection(anchor: number, head: number): Patch;
  begin_composition(): void;  end_composition(): Patch;  // (RA) cancelled (no commit): deletes the selection it started on
  paste(text: string): Patch;  cut(): CutResult;  copy(): string;
  replace_range(from: number, to: number, text: string): Patch;  // (RA) spelling replacement: one edit, no typing rules
  undo(): Patch;  redo(): Patch;  toggle_todo(line: number): Patch;
  set_read_only(ro: boolean): void;
  apply_remote(edits: Edit[]): Patch;        // remote text edits (JS-Yjs mirror: local docs; notes use collab engines, C2); keeps local selection mapped
}
// key names follow KeyboardEvent.key ("ArrowLeft", "Backspace", "Enter", "Tab", "a", ...);
// mods bitmask: 1=shift 2=alt 4=ctrl 8=meta(cmd)
type Edit = { from: number; to: number; insert: string };          // UTF-16, applied in order
type Patch = {
  lines?: { start: number; deleteCount: number; insert: LineViewJs[] };  // splice of the line list (only changed lines)
  sel: { anchor: number; head: number };
  edits?: Edit[];            // local text changes this command made (for the JS Yjs bridge / autosave)
  scroll?: "caret" | "start" | "end";
  composing?: boolean;
};
type CutResult = { text: string; patch: Patch };
// LineViewJs = editor-core LineView serialized with all offsets in UTF-16 (same field names, camelCase), plus
// `key: string` (stable identity for DOM reuse). editor-wasm owns the conversion; editor-core gets no serde dep.
// (B3) Offsets are LINE-RELATIVE: no `index`/`from`/`to`; `len` = the line's length (no "\n"), the line starts at
// the sum of `len + 1` over the lines before it; textFrom, segments[].from/to, images[].from/to/altRange are
// relative to the line start; `text` = the raw line. So lines that only moved are equal and never resent: a
// splice holds only lines whose content or reveal state changed (typing = 1 line, Enter = 2).
```
**(C2, additive) Collab engines** — the engine owns a room's shared document (yrs + the room protocol, sans-IO;
full doc in laptop `crates/editor-wasm/README.md` "Collab mode"; web transport `src/client/editor-rs/collab.ts`):
```ts
class Engine {
  static collab(clientId: number, user: object): Engine;  // clientId: random u32 (crypto.getRandomValues); empty doc until synced
  // every command above works unchanged; apply_remote / set_read_only do nothing on a collab engine
  receive(frame: Uint8Array): { patch?: Patch /* remote edits in patch.edits, or a full render if reloaded */;
    frames: Uint8Array[] /* send now */; notices: Notice[]; awareness: boolean; reloaded: boolean; error?: string };
  take_outgoing(nowMs: number): { frames: Uint8Array[]; wakeInMs?: number; awareness: boolean };  // after every command
  set_focused(focused: boolean, nowMs: number): Uint8Array[];     // cursor published only while focused
  connecting(): void;  disconnected(code: number, reason: string): { retry: number } | { closed: string; to: string | null };
  online(): boolean;  reset(clientId: number): Patch;  request_flush(): Uint8Array[];  leave(): Uint8Array[];
  status(): "connecting" | "connected" | "disconnected";  synced(): boolean;  read_only(): boolean;
  save_state(): SaveState | null;  client_id(): number;  is_consistent(): boolean;
  remote_cursors(): { client: number; userId: string; name: string; color: string; anchor: number; head: number; key: string }[];  // UTF-16
  peers(): { client: number; state: { user?: unknown; cursor?: unknown } }[];
}
type Notice = { t: "hello"; readOnly: boolean; saveState: SaveState } | { t: "synced" } | { t: "readOnly"; readOnly: boolean }
  | { t: "saveState"; saveState: SaveState } | { t: "external"; commit: string | null } | { t: "reset" };
type SaveState = { dirty: boolean; saving: boolean; commit: string | null; savedAt: number | null };
```

## Phases and board

Status: `todo` · `doing (session id)` · `done (commit)` · `blocked (why)`.

### Phase A — foundations (parallel)
| id | task | repo/paths (owner only) | depends | status |
|---|---|---|---|---|
| A1 | editor-core: `Layout::adjacent_line_y` (+ use in move_vertical, implement in native app via parley lines); `TextStore` trait with `StringStore` (Editor generic or boxed; native unaffected); remote-edit API `apply_remote(edits)` that maps selection + history positions through remote edits (prep for collab); tests | laptop `crates/editor-core`, minimal `crates/app` changes | — | done (1871520) |
| A2 | `crates/editor-wasm`: wasm-bindgen Engine per contract 4 using the current editor-core API (UTF-16 conversion, line diffing in the glue via LineView PartialEq, LineViewJs conversion, JsLayout extern impl of Layout); build script `scripts/build-wasm.sh` (wasm32-unknown-unknown + wasm-bindgen-cli, wasm-opt if available) that copies the `--target web` output to this box at `src/client/editor-rs/pkg/` (scp); node/bun smoke test of the wasm module on this box | laptop `crates/editor-wasm`, `scripts/build-wasm.sh`, this box `src/client/editor-rs/pkg/` | (A1 for adjacent_line_y/apply_remote: stub until merged) | done (laptop e4aac11, web 7bef04f) |
| A3 | Web shell `src/client/editor-rs/` (TS): mountRustEditor(host, opts) with the same options/API as `mountEditor` (ytext, awareness, readOnly, images…); DOM renderer from LineViewJs reusing editor.css classes and render.ts look; JsLayout from the DOM; input bridge (beforeinput/keydown/composition/mouse/clipboard/drag-select); JS Yjs bridge (local Patch.edits → Y.Text with local origin; remote Y events → engine.apply_remote); remote cursors via existing code; `?engine=rust` switch in main.ts. Develop against contract 4 with a fake engine until A2's pkg lands | this box `src/client/editor-rs/`, tiny hook in `src/client/main.ts` | contract 4 | done (b86d792, 1ce6b64, 06e7db9) |
| A4 | yrs spike `crates/collab` (standalone): YrsStore over yrs `Text`; y-sync v1 protocol client (sync step 1/2, update, awareness) talking to a scratch Grimoire server; proves interop with the JS Yjs server/browser (edits both ways, concurrent merge), yrs UndoManager with Bear-style grouping hooks (explicit stop-capturing; local-origin only); report findings in `docs/rust-engine/yrs.md` (this box) | laptop `crates/collab` (new) | — | done (laptop ce241e1, box 189cf0a) |

### Phase B — Rust engine in the browser (after A1–A3)
| id | task | depends | status |
|---|---|---|---|
| B1 | Integrate pkg + shell; make `test/editor/browser/run.mjs` run against both engines (`ENGINE=rust`); fix until it passes; images, tables, read-only, homepage example | A1–A3 | done (b3a57e6) |
| B2 | Bear parity rig against `?engine=rust` (tools/parity) — compare with the TS engine's score | B1 | done (bf721ca) |
| B3 | Perf, started early (coordinator decision: A3 measured 90–115 ms per keystroke near the top of a 3000-line doc): line-relative LineViewJs offsets so only changed lines are sent (editor-wasm diff + shell `toRLine`/lineview.ts only), profile and cut the engine's per-keystroke cost (incremental reparse/render_lines if needed), target < 8 ms per keystroke on 3000 lines; wasm size, load time; TS-vs-Rust numbers | A3 | done (laptop 40b083f, web 5e23e40) |

| RA | Fix the Phase A review findings in `docs/rust-engine/review-A.md` (skip any already fixed by B1/B3; note which) | B1, B3 | done (laptop 9d9b2c5, web 0b03c87) |

### Phase C — multiplayer in Rust (after A4, B1)
| id | task | depends | status |
|---|---|---|---|
| C1 | `YrsStore` behind `TextStore` in editor-core (feature `collab`); undo via yrs UndoManager with the ported grouping | A1, A4 | done (laptop 907430a, e1653a1) |
| C2 | Web: engine owns the doc (yrs in wasm) and speaks y-protocols over the existing WebSocket; awareness/cursors; `two-users.mjs` passes with ENGINE=rust. Also (from C1 gaps): a note containing `\r` must NOT be rewritten for everyone on load — the collab path must keep the shared text byte-identical (normalize only in the engine's view, or keep `\r` like the TS engine); auto-rebuild the editor from the shared doc when `is_consistent()` fails | C1, B1, B3 | done (laptop 2dcc6dd, b98c1fa; web ba5f02a) |
| C3 | Native: open a live note from grimoire.exe.xyz with the same YrsStore (optional) | C1 | todo |

### Phase D — switch over
| id | task | depends | status |
|---|---|---|---|
| D1 | Make Rust the default engine; keep TS engine behind `?engine=ts` for one release; deploy | B2, C2 | todo |
| D2 | Remove TS editor logic (keep render CSS/look); docs | D1 | todo |

Every phase ends with a review subagent (model `console-google/gemini-4-argon#high`) and a fix pass — run by the coordinator.

## Open questions
- A4: C1 undo: editor-core's own History (A1, remote-rebased, shared with native) or yrs UndoManager (exact Y.UndoManager parity; needs a one-line yrs patch for redo caret)? See yrs.md "C1 recommendation".
  - **Decision (coordinator):** editor-core's own History (A1's remote rebasing). One undo implementation for native and web, already ported from the TS grouping rules, no yrs patch needed. yrs's UndoManager is not used. C1 must still verify the TS behaviours history.ts relied on (local-only undo, selection restore, groups across remote edits) with tests; if a real gap shows up, note it here.
  - Also for C1/C2 (from A4): always pass a random u32 client id from JS (`crypto.getRandomValues`); pin yrs 0.28.x; keep the yrs `sync` feature off; port reconnect / room-generation restart / focus-only cursor from the TS client.
- (none yet)
- A2: Patch.lines splices are minimal only up to absolute offsets: an edit shifts `from`/`to`/segment offsets (and an Enter the `index`) of every later line, so all later lines are resent (exact-equality diff, per contract). Keys stay stable for moved lines, so the DOM can be reused, but a keystroke near the top of a 3000-line doc still serializes ~3000 LineViewJs. Proposal for B3: make LineViewJs offsets line-relative (JS derives `from` by summing `to-from+1`) so the diff can use shape equality and only send changed lines. Coordinator decision needed before B3.
  - **Decision (coordinator):** keep absolute offsets for phase A/B1 (A3 builds against them; correctness first). In B3, if the 3000-line keystroke benchmark shows the resend matters, switch to line-relative offsets (A2's proposal) in one coordinated change to editor-wasm + the shell. A3: keep offset handling in one place in the renderer (derive positions from a line's `from`, don't cache absolute offsets in many DOM attributes) so that switch is cheap.
- A3: (1) needed a one-word server change outside my paths: CSP `script-src 'self' 'wasm-unsafe-eval'` in `src/server/index.ts` (wasm can't compile otherwise) — in 1ce6b64, please review/deploy with it. (2) Perf data for B3 (3000-line doc, keystroke near the top, headless Chromium): wasm engine call ~65–90 ms (reparse + serde of ~3000 resent LineViewJs), shell apply ~24 ms for the 2999-line splice (divs are reused in place, nothing re-rendered); with the fake TS engine the shell's whole keystroke is ~15 ms. So the line-relative-offsets switch is worth doing in B3; the shell already converts every LineViewJs to line-relative form in one place (`editor-rs/lineview.ts` toRLine) and derives absolute spans from line lengths (`view.ts` updateSpans), so only toRLine's `base` changes.

## Log
- 2026-10-26 coordinator: plan written; launching A1–A4 in parallel.
- 2026-10-26 A1: done 1871520. Added `Layout::adjacent_line_y` (MonoLayout + app Geo impl; move_vertical starts there, probes on if missed), `TextStore`/`StringStore` (`Editor<S: TextStore = StringStore>`, `Editor::with_store`, `store()`; `Editor::new` unchanged), `Editor::apply_remote(&[(Range<usize>, String)])` (byte offsets, in order; not undoable, history rebased by OT, works read-only), `History::map_remote`. Public change (compatible): `Editor` now generic with a default param, `MonoLayout::new` takes `&Editor<S>`. Note for A2: caret at a remote insertion point stays before it. Tests green (editor-core, app), clippy clean, run.sh snapshots byte-identical.
- 2026-10-26 A2: **pkg works**: `src/client/editor-rs/pkg/` (editor_wasm.js/.wasm/.d.ts, `--target web`; `initSync({module: bytes})` or `await init()`); smoke test `bun test src/client/editor-rs/pkg-smoke.test.ts` passes. LineViewJs/Patch types documented in laptop `crates/editor-wasm/README.md` and in the pkg .d.ts (segment kinds use render.ts names: token/text/mk/esc/chip/fence/pipe/pad/delim; BlockType kebab like TS; all offsets absolute UTF-16; extra fields `text`, `textHidden`). wasm 245 KB raw / 97 KB gzip (no wasm-opt).
- 2026-10-26 A2: done. laptop e4aac11 (crates/editor-wasm, scripts/build-wasm.sh, workspace member), web 7bef04f (pkg + smoke test). Uses A1's `adjacent_line_y` (JsLayout, dir ±1) and `Editor::apply_remote` (no stubs left). Contract 4 implemented as written; additions: LineViewJs `text` (raw line) and `textHidden`; IME = `begin_composition()` → `insert_text(commit)` → `end_composition()` (end without commit changes nothing). wasm 253 KB raw / 99 KB gzip; wasm-opt -Oz tried (232 KB raw but 101 KB gzip → not worth it). Rebuild: `ssh … 'cd ~/projects/grimoire-native && scripts/build-wasm.sh'` then `scp 'james@100.109.145.97:projects/grimoire-native/target/editor-wasm-pkg/*' src/client/editor-rs/pkg/`.
- 2026-10-26 A4: yrs spike done: Rust client interops with server+browser (edits both ways, same-spot merge, Rust cursor shown, undo/redo, git commit), wasm ~138 KB gz; findings in docs/rust-engine/yrs.md (laptop ce241e1, box 189cf0a).
- 2026-10-26 A3: done (b86d792, 1ce6b64, 06e7db9). `src/client/editor-rs/`: mountRustEditor (same options/handle as mountEditor; wasm loaded lazily from /dist/editor-rs/, falls back to the TS editor if it can't load), renderer from LineViewJs producing byte-identical DOM to render.ts (unit-tested against the real wasm for every test doc × selections, plus identical DOM↔raw mapping), JsLayout from the DOM (all 7 methods), input bridge (beforeinput/keydown via engine.key with non-Mac Ctrl→Cmd translation/IME/mouse+drag/clipboard/selectionchange), JS Yjs mirror + remote edits → apply_remote, awareness + existing remote cursors, `?engine=rust|ts` (localStorage `grimoire.engine`). Shared helpers factored out of the TS editor without behaviour change (editor/geometry.ts, render.ts/offsets.ts/cursors.ts exports). Tests: `bun test test/editor/rs` (happy-dom devDep), `bun test/e2e/rust-engine.mjs` (typing, list Enter, Ctrl-B, undo, clicks past hidden markers, double click, arrows, Up/Down, IME via CDP, todo/image/table clicks, TS user + Rust user converge, cursors both ways). For B1: `test/editor/browser/harness-rs.ts` (same `T` as harness.ts; `?fake` = plain-text fake engine), page handle `document.querySelector('.mde').mdeView`.
- 2026-10-26 C1: done (laptop 907430a, e1653a1). `collab::CollabEditor` = `Editor<CollabStore>` (TextStore over yrs + String mirror) + provider.ts-ported `Session`; undo = editor-core History (yrs UndoManager off via `YrsStore::without_undo`). API for C2, behaviours and gaps: docs/rust-engine/collab.md. Tests: history.ts behaviours across editors, lifecycle, presence (15 s renew / 30 s expiry), convergence fuzz (300 seeds); interop script passes with the example client on the driver; wasm32 check clean. Gaps: CRLF normalized on load (local edit), undo re-inserts new items (remote carets inside don't return), yrs 0.28 out-of-order pending bug (unreachable over FIFO WS).
- 2026-10-26 B1: done b3a57e6. `ENGINE=rust bun test/editor/browser/run.mjs` (run.mjs now builds its harness itself; default ts): **218/218 on both engines** (also against HEAD's older pkg and B3's in-progress tree). No engine bug found by the suite: no editor-core/editor-wasm changes. Added checks (both engines): composition while remote edits arrive, insertReplacementText (also inside collapsed bold), read-only (keys/todo/paste/IME blocked; select, copy, remote edits work). No test adaptations needed. New `test/editor/browser/diff.mjs`: differential TS-vs-Rust fuzzer (random keys, `CLICKS=1`, `MAC=1`; replay with DOC/CARET/KEYS). Found + fixed in the shell (layout.ts hit_test): Up/Down onto a bullet/indent picked the far edge of the token → nearer edge (todo box still → text start, like TS). Remaining divergences, all judged TS-side or intended: Rust drops undo groups whose inverse is a no-op (e.g. Backspace then retype the same char: TS undo only reselects); TS bugs: a multi-click starting inside an existing selection is swallowed, a click on an hr puts the caret before it (Rust: single stop after); programmatic carets inside hidden syntax snap the other way (unreachable by input). Shared-file edits: `src/client/main.ts` (engine switch moved to `editor-rs/engine.ts` `preferredEngine()`), `src/client/home.ts` (home + /start editors use Rust with ?engine=rust), `test/e2e/rust-engine.mjs` (home/start on Rust, IME in Alice while Bob types on the same line).
- 2026-10-26 B3: done (laptop 40b083f, web 5e23e40). **Contract 4 changed: LineViewJs offsets are line-relative** (`len` replaces `index`/`from`/`to`; contract text updated above; shell `toRLine`/types/fake/tests adapted). editor-core: incremental re-parse (`parser::reparse` from the edited block: block state per line, re-parse until the state re-converges outside a paragraph run, shift the rest; debug builds assert it equals a full parse; random-edit tests) + `Editor::take_line_changes()` (additive API). editor-wasm: renders/serializes only re-parsed or reveal-changed lines, incremental UTF-16 snapshot, `Engine.set_profiling/profile()`. Keystroke in a 3000-line mixed doc, headless Chromium (`bun tools/perf/keystroke.mjs`): Rust before 41 / 26 / 11 ms (top/middle/bottom; Enter 37) → after 5.7–6.5 ms (engine 0.2–0.3, shell JS ~0.7, rest is the browser); TS engine 8–10 ms. Native engine 1.4 → 0.03–0.08 ms. wasm 266 KB raw / 103 KB gzip (+12 KB), compile 1.5 ms. Notes: ~3 ms of every keystroke (both engines) is Chromium's selection sync, which walks the whole editable during user input (grows with DOM size; only viewport virtualization or EditContext would remove it); layout ~1.7 ms. Mount of a 3000-line doc: render_all ~25 ms (full serialization) — fine for now.
- 2026-10-26 B2: done bf721ca. `ENGINE=rust tools/parity/run.sh` (page.ts `?engine=rust`, wasm base64-inlined). Ran on HEAD b3a57e6 (committed pkg, not B3's in-progress tree), Bear baseline reused (bear.json recorded after the last scenarios.json change, covers all 83). **TS 81/83, Rust 81/83, the two engines identical on every scenario.** Both fail only nav.updown-headings-lists and nav.updown-nested-list (Up/Down column choice; same output from both, a shared rule, not a Rust regression). First full run showed TS 74 / Rust 76: all extra failures were the user's dictation/clipboard landing in the parity page (foreign sentences in the raw text); they pass on rerun. No engine or shell fixes needed. Reports: /tmp/opencode/parity/report-{ts,rust}-final.md.
- 2026-10-26 RA: done (laptop 9d9b2c5, web 0b03c87). All 12 review-A findings fixed, none were already fixed by B1/B3. **Contract changes:** (2) `Layout::adjacent_line -> Adjacent { Y, Edge, Unknown }` (default wraps `adjacent_line_y`); (3) JsLayout `adjacent_line_y` returns `null` at the document edge, `undefined` = unknown/probe; (4) `end_composition(): Patch` (a cancelled composition deletes the selection it started on, via `Editor::end_composition("")`), new `replace_range(from, to, text): Patch` (used for insertReplacementText). editor-core never rewrites text any more (`\r` kept like TS parseDoc; native app normalizes local files on open) — this also settles the C2 `\r` note. Tests: laptop `tests/review_a.rs` + editor-wasm/collab unit tests; run.mjs +25 checks (both engines; 3 Rust-only where the TS editor has the same quirk: Down at the last line scrolls, detail-2 press without a first click, chip mousedown without mouseup — TS input.ts has the same pointerDown issue); shell tests (CRLF, replace_range/cancelled IME on fake+wasm, `<img>` reuse, per-base loader). diff.mjs: same divergences as before (also CRLF docs: none). #11 (unloaded image) couldn't be made to fail (the hit_test fallback lands right); fixed anyway.
- 2026-10-26 C2: done (laptop 2dcc6dd, b98c1fa; web ba5f02a). `?engine=rust` notes: the wasm engine owns the shared doc — **contract 4 addition: `Engine.collab(clientId, user)`** + `receive`/`take_outgoing`/`set_focused`/lifecycle/`remote_cursors`/`peers` (block under contract 4; editor-wasm README "Collab mode"); plain `new Engine(text)` unchanged. Web: `editor-rs/collab.ts` RustCollab (WebSocket transport, same events/fields as GrimoireProvider), view.ts collab mode, cursors.ts draws resolved cursors, main.ts Session picks RustCollab or GrimoireProvider (TS fallback if the wasm fails). JS Yjs mirror kept only for local docs (home page, run.mjs/parity harnesses) — not dead code there. collab: `CollabEditor::rebuild` (auto on `!is_consistent()`); editor-core: byte-counting `byte_to_utf16`. All green: cargo test/clippy/run.sh (snapshots identical); two-users TS+TS/Rust+Rust/TS+Rust/Rust+TS; rust-engine.mjs; new rust-collab.mjs (offline merge, generation reset, read-only, agent edit + cursor, CRLF byte-identical; Bob Rust or TS); run.mjs 243/243 on ts, rust, **rust COLLAB=1** (in-page room); diff.mjs no new divergences (plain/CLICKS/MAC, also COLLAB=1); bun test test/editor, test/editor/rs (+collab.test.ts), test/server; tsc; build:client. wasm 642 KB raw / 222 KB gzip (was 267/103: yrs + protocol + serde_json; no wasm-opt on the laptop). Keystroke (3000 lines): rust 5.5–7.9 ms, rust-collab 5.5–7.2 ms (engine 0.3–1.2 incl. the update frame), TS 13–20 ms on this (noisy) run. Gap (both engines, pre-existing): End on a CRLF line puts the caret after the `\r`, so typed text lands between `\r` and `\n`.
