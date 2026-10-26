# editor-wasm

wasm-bindgen glue that runs `editor-core` in the browser (contract 4 of the web repo's
`docs/rust-engine/PLAN.md`). The web shell (`src/client/editor-rs/` in multiplayer-notepad) renders
the `LineViewJs` objects into its contenteditable DOM and answers geometry through a `JsLayout`.

- Everything crossing the boundary is in **UTF-16 code units** (offsets into the Markdown text, like
  the DOM and Yjs). editor-core stays in bytes; `conv::Snap` converts (identity for ASCII texts,
  checkpoints at line starts otherwise).
- Geometry is in editor content coordinates (CSS px), as the `JsLayout` returns it.
- editor-core has no serde dependency: `conv.rs` holds serde mirror structs of `LineView`.

## Build

On the Mac (never on the web box):

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.129   # = the pinned wasm-bindgen in Cargo.toml
scripts/build-wasm.sh            # -> target/editor-wasm-pkg/ (+ DEST=user@host:dir/ to scp it)
cargo test -p editor-wasm        # native tests: offsets, diffing, keys, patch flow
```

The script builds with `opt-level=z`, LTO, one codegen unit, `panic=abort` (through
`CARGO_PROFILE_RELEASE_*` env vars, so the native release profile is untouched), runs
`wasm-bindgen --target web`, and `wasm-opt -Oz` when binaryen is installed. From the web box:

```sh
ssh -o BatchMode=yes james@100.109.145.97 'cd ~/projects/grimoire-native && scripts/build-wasm.sh'
scp 'james@100.109.145.97:projects/grimoire-native/target/editor-wasm-pkg/*' src/client/editor-rs/pkg/
bun test src/client/editor-rs/pkg-smoke.test.ts
```

Use it with `import init, { Engine } from "./pkg/editor_wasm.js"; await init();` (or
`initSync({ module: bytes })`).

## API (contract 4)

```ts
class Engine {
  constructor(text: string);
  text(): string;
  render_all(): Patch;                 // full render: deleteCount = lines the front end had, fresh keys
  insert_text(s: string): Patch;       // typed text; while composing, the IME commit
  key(key: string, mods: number, layout: JsLayout): Patch | undefined;
  mouse_down(x: number, y: number, clicks: number, shift: boolean, layout: JsLayout): Patch;
  mouse_drag(x: number, y: number, layout: JsLayout): Patch;
  set_selection(anchor: number, head: number): Patch;
  begin_composition(): void; end_composition(): Patch;
  abort_composition(): void;           // forget a composition, text unchanged (its view was rebuilt / went away)
  paste(text: string): Patch; cut(): CutResult; copy(): string;
  replace_range(from: number, to: number, text: string): Patch; // spelling replacement: one edit, no typing rules
  undo(): Patch; redo(): Patch; toggle_todo(line: number): Patch;
  // folding (view state: no text edit, never in `edits`; see "Folding" below)
  toggle_fold(line: number): Patch;    // a heading's chevron / "…" pill
  fold_command(which: "toggle" | "fold" | "unfold" | "foldAll" | "unfoldAll"): Patch;
  fold_keys(): [string, number][];     // folded headings as [heading line text, occurrence]: persist per note
  set_fold_keys(keys: [string, number][]): Patch;
  set_read_only(ro: boolean): void;
  apply_remote(edits: Edit[]): Patch;
  set_profiling(on: boolean): void;    // perf: time every command with performance.now()
  profile(): number[] | undefined;     // last command, ms: [engine, serialization, edit, render, diff, conversion]
  free(): void;                        // wasm-bindgen: release the Rust object
}
```

- `key`: `KeyboardEvent.key` names (`ArrowLeft`/`Right`/`Up`/`Down`, `Home`, `End`, `PageUp`,
  `PageDown`, `Backspace`, `Delete`, `Enter`, `Tab`, `Escape`, or a single character such as `"z"`,
  matched case-insensitively for shortcuts); `mods`: 1 = Shift, 2 = Alt/Option, 4 = Ctrl, 8 =
  Meta/Cmd. Bindings are editor-core's macOS key map (`keymap.rs`), the same as the native app.
  Returns `undefined` when the key isn't the editor's (plain characters, PageUp/PageDown, Ctrl-arrows,
  unknown names): let the browser have it. When read-only, editing keys return `undefined`; the
  formatting and undo shortcuts return a patch that changes nothing (swallow them).
- `scroll`: `"caret"` after key commands, typing, paste, cut, undo/redo; `"start"`/`"end"` for
  Home/End (they scroll without moving the caret); absent for mouse, `set_selection`,
  `toggle_todo`, `apply_remote`, `render_all`.
- Folding (editor-core `fold.rs`): a heading's section runs to the next heading of the same or a higher
  level; folding hides its lines after the heading (`hiddenByFold`), nested folds are kept. Fold changes
  come as line splices like reveal changes. The caret never sits in hidden lines: arrows skip them, Enter at
  a folded heading's end starts a same-level heading after the section, a selection across a fold includes
  the hidden text, and anything that puts a selection end inside (undo, remote edit, `set_selection`)
  unfolds it. Keys: Cmd-' toggle (Bear), Cmd-Option-[ / ] fold (again: the enclosing section) / unfold,
  with Shift (or `{` / `}`) all. Fold commands work read-only. Remote edits map folds; a fold whose
  heading start is deleted goes away. Collab rebuilds keep them (by `fold_keys`).
- IME: `begin_composition()` when composition starts (the browser composes in the DOM), then the
  commit through `insert_text(committed)` (it replaces the selection the composition started on),
  then `end_composition()`. `end_composition()` without a commit (cancelled) deletes the selection
  the composition started on, if any (like the TS editor), and ends the undo group; after a commit it
  changes nothing. While composing, patches carry `composing: true`. `abort_composition()` forgets a
  composition without touching the text (the DOM holding it was re-rendered or the view unmounted).
- `replace_range(from, to, text)`: `Editor::replace_range` (spelling corrections,
  `insertReplacementText`): one edit replacing the range (no typing rules), grouped for undo like
  TS `replaceSelection` input.
- `edits`: present when the command changed the text: the replacements it made, in order (each in
  UTF-16 offsets of the text left by the ones before it; touching ones merged, each trimmed to what
  changed), e.g. one per line for Tab over several lines. Never present for `apply_remote` (those
  edits aren't local).
- `apply_remote`: edits apply in order, each against the text after the previous ones, through
  `Editor::apply_remote`: not undoable (undo keeps reverting only local changes), works when
  read-only, the selection is mapped (a caret at a remote insertion point stays before it).
- `cut()` with no selection returns `{ text: "", patch }`; `copy()` returns `""`.
- `JsLayout` methods may return `undefined` (or be missing/throw: treated as `undefined`);
  `caret_rect` / `bounds` fall back to zeros. `adjacent_line_y` (Up/Down) returning `null` means
  there is no visual line in that direction (the caret goes to the document's start / end, no
  probing); `undefined` makes the engine probe with `hit_test` in 4 px steps from the caret box. Engine calls that take a layout (`key`, `mouse_*`) must come after the
  DOM shows the last patch.

## Collab mode

`Engine.collab(clientId, user)` makes an engine on the shared document of a Grimoire room: it embeds
`collab::CollabEditor` (yrs + the room protocol, sans-IO), so the engine produces and consumes the
WebSocket frames itself (y-protocols sync/awareness + the control JSON; see the web repo's
`docs/rust-engine/yrs.md` and `collab.md`). The shell owns the socket and the timers
(`src/client/editor-rs/collab.ts` in multiplayer-notepad). The document is empty until the room's
state arrives. Every command above works unchanged (local edits go into yrs); `apply_remote` does
nothing on a collab engine (remote edits come through `receive`). The engine is read-only while the
room says so; `set_read_only(true)` makes it read-only on top of that (a view mounted read-only),
`false` follows the room again.

```ts
class Engine {
  static collab(clientId: number, user: object): Engine; // clientId: random u32 (crypto.getRandomValues); user {id,name,color,kind}
  is_collab(): boolean;
  receive(frame: Uint8Array, nowMs: number): Received; // every binary frame from the server (same clock as take_outgoing)
  frames_lost(): void;                           // frames from this engine couldn't be sent (socket closing)
  static recover_unsent(clientId: number): Uint8Array | undefined; // our edits this session, even after a trap
  take_outgoing(nowMs: number): Outgoing;        // after every command, and when wakeInMs fires (performance.now())
  set_focused(focused: boolean, nowMs: number): Uint8Array[]; // our cursor is published only while focused
  connecting(): void;                            // before opening a socket
  disconnected(code: number, reason: string): AfterClose;
  online(): boolean;                             // window "online": true = reconnect now
  reset(clientId: number): Patch;                // after a "reset" notice: fresh empty doc (full render), then connect again
  request_flush(): Uint8Array[];                 // ask the server to commit now
  leave(): Uint8Array[];                         // send before closing for good (null presence)
  status(): "connecting" | "connected" | "disconnected";
  synced(): boolean; read_only(): boolean; save_state(): SaveState | null; client_id(): number;
  remote_cursors(): PeerCursor[];                // others' carets/selections (not our own user's), UTF-16
  peers(): Peer[];                               // others' presence states {user, cursor}
  is_consistent(): boolean;                      // editor text == shared text
}
type SaveState = { dirty: boolean; saving: boolean; commit: string | null; savedAt: number | null };
type Notice =
  | { t: "hello"; readOnly: boolean; saveState: SaveState } | { t: "synced" }
  | { t: "readOnly"; readOnly: boolean } | { t: "saveState"; saveState: SaveState }
  | { t: "external"; commit: string | null } | { t: "reset" };
type Received = { patch?: Patch; frames: Uint8Array[]; notices: Notice[]; awareness: boolean; reloaded: boolean; error?: string };
type Outgoing = { frames: Uint8Array[]; wakeInMs?: number; awareness: boolean };
type AfterClose = { retry: number } | { closed: string; to: string | null };
type PeerCursor = { client: number; userId: string; name: string; color: string; anchor: number; head: number; key: string };
type Peer = { client: number; state: { user?: unknown; cursor?: unknown } };
```

- `receive`: send `frames` at once; apply `patch` (remote edits: `patch.edits` holds the changes in
  UTF-16, in order, the selection is mapped). With `reloaded` there is no patch: the editor was
  rebuilt from the shared document (at the initial sync, without parsing the doc twice, or because its
  text and the shared text disagreed): call `render_all()` (any other command before that returns a
  full render). Redraw cursors/participants when `awareness`. `nowMs` stamps remote presence (30 s
  timeout) and our announces. Nothing is trusted before the room's `hello`. Notices: `hello`
  (connected, save state), `readOnly` (before `hello` when it changes), `synced` (once: mount the
  editor now), `saveState`, `external`, `reset` (the room was recreated, or a read-only connection
  would drop edits the server may lack: close the socket and start over).
- Unsent edits: local edits go out as updates only once the server's step1 of the connection is
  answered (our step2 carries everything before, once); edits made offline, before that, still pending
  in the engine, or in frames the shell reported lost (`frames_lost`, socket closing) count as unsent;
  a read-only connection with unsent edits, or whose server state vector lacks some of ours, resets.
- Malformed updates: updates are checked before yrs sees them (`collab::validate`: only strings,
  embeds, formats and deleted items in the root text "md", no zero-length or skip blocks, no client
  listed twice, sane clocks); updates that would leave a gap in a client's clocks wait until it fills.
  A rejected sync frame comes back as `error` (the document now lacks something: the web shell falls
  back to the TS editor). If yrs still panics (`panic=abort`: a WebAssembly trap), the instance is
  dead; `Engine.recover_unsent(clientId)` (a static, it doesn't touch the dead object) returns our
  edits of the session as one Yjs update for the TS editor to apply.
- `take_outgoing`: local edits of the command(s) as one merged update frame, our cursor (throttled
  to one publish per 50 ms: `wakeInMs` says when to call again), the 15 s presence renewal; remote
  presence that timed out (30 s) sets `awareness`.
- `disconnected`: `{retry}` = reconnect after that many ms (500 doubling to 10 s, reset by `hello`);
  `{closed}` = the session ended (codes 4401/4403/4404/4413, 4000 or a `closed` control message:
  deleted, renamed (`to`), removed, unauthorized, forbidden, notfound, toolarge).
- An embed in the shared text (only a misbehaving peer adds one) shows as U+FFFC, so offsets stay
  those of yrs.
- `remote_cursors`: `key` is the cursor as published (it changes only when that participant moves
  it; a remote edit shifting the offsets keeps it), colors are valid `#hex` (`#888888` otherwise),
  names non-empty (`anonymous`).
- Tests: `cargo test -p editor-wasm` (`src/collab_tests.rs`: an in-process room).

## Patch

```ts
type Edit = { from: number; to: number; insert: string };
type Patch = {
  lines?: { start: number; deleteCount: number; insert: LineViewJs[] }; // absent: no line changed
  sel: { anchor: number; head: number };                                // always present
  edits?: Edit[];
  scroll?: "caret" | "start" | "end";
  composing?: boolean;
};
type CutResult = { text: string; patch: Patch };
```

`lines` is the minimal splice of the line list: the common prefix and suffix of lines that look the
same (same `LineView` up to a shift of its offsets, same raw text) are left out. Offsets are
line-relative, so an edit only resends the lines it changed (plus lines whose reveal state changed),
not every later line; the front end derives each line's start from the lengths (`len`) of the lines
before it. `key` says which DOM line an inserted view is (see `key` below).

## LineViewJs

One object per source line (editor-core `LineView`, fields camelCase, without `index`/`from`/`to`).
**All offsets are UTF-16 offsets relative to the line start** (add the line's start, the sum of
`len + 1` over the lines before it, for absolute ones).

```ts
type BlockType = "paragraph" | "heading" | "bullet" | "todo" | "numbered" | "quote" | "hr"
  | "fence" | "code" | "table-head" | "table-delim" | "table-row";
type SegKind = "token" | "text" | "mk" | "esc" | "chip" | "fence" | "pipe" | "pad" | "delim"; // render.ts names
type InlineType = "bold" | "italic" | "strike" | "underline" | "highlight" | "code" | "link" | "tag" | "image";
type TokenKind = "indent" | "heading" | "bullet" | "todo" | "numbered" | "quote" | "hr";
type CellAlign = "left" | "center" | "right" | null;

interface LineViewJs {
  key: string;          // stable identity for DOM reuse (see below)
  len: number;          // length of the line (without the "\n"); the line starts after the previous line's len + 1
  textFrom: number;     // after the block prefix tokens (heading "# ", list "- ", "- [ ] ", "1. ", "> ", indents)
  text: string;         // the raw line text (no "\n"): segment text is text.slice(s.from, s.to)
  kind: BlockType;
  level: number;        // heading level 1..6 (0 otherwise)
  checked: boolean;     // todo is checked
  number: number;       // numbered list: the item's number
  indent: number;       // indent levels (leading tabs / indent tokens)
  gutterLevels: number; // content indentation in gutter widths: indent + 1 for a list/quote token
  active: boolean;      // the line holds the selection head (heading tokens show their "H1" label only then)
  revealed: boolean;    // code fence / table syntax of this line is revealed
  collapsed: boolean;   // drawn collapsed: a code fence or table delimiter row that isn't revealed
  code?: { first: boolean; last: boolean };                // in a code block: first / last line of the block (the fences when present)
  table?: { align: CellAlign[]; cells: number; columns: number }; // table line: column alignments, cells in this row (draw placeholders up to columns)
  segments: SegViewJs[];  // in order, covering the line's raw text
  images: ImageViewJs[];  // the line's images, in order (drawn below the line's text)
  imageOnly: boolean;     // a paragraph of nothing but images (optionally inside links)
  textHidden: boolean;    // imageOnly and no image revealed: only the images show
  foldable?: true;        // a heading with a section to fold (absent: false)
  folded?: true;          // a folded heading: draw its "…" pill
  hiddenByFold?: true;    // hidden inside a folded section: no space, no caret positions
}

interface SegViewJs {
  kind: SegKind;   // token: block prefix (atomic gutter glyph, holds no visible text); text: visible text;
                   // mk: inline marker (**, [, ](, …); esc: escape backslash (always hidden);
                   // chip: link URL (atomic, drawn as a chip, never as its text); fence: ``` line text;
                   // pipe / pad / delim: table pipe, cell padding, delimiter-row cell
  from: number; to: number;
  styles: InlineType[];  // inline styles applying, outermost first
  hidden: boolean;       // collapsed: draw at zero width (raw text still exists; the caret never sits inside)
  token?: TokenKind;     // kind "token": which token
  cell?: number;         // table lines: the cell this segment is drawn in
  el?: number;           // kind "mk": index of the inline element it belongs to (markers of one element share it)
}

interface ImageViewJs {
  from: number; to: number;           // the whole source ![alt](src "title"): a click puts the caret at `to`
  altRange: [from: number, to: number]; // the alt text's range (a marker range; drawn as text when revealed)
  alt: string;
  src: string;                        // as written (not decoded or resolved)
  title?: string;
  revealed: boolean;                  // its source is shown (the caret or selection touches it)
}
```

Optional fields are absent (not `null`) when they don't apply; `table.align` entries are `null` for
columns without alignment.

### `key`

- Lines outside the splice keep their keys (they're not resent).
- Inside the splice, lines that only moved (same content and view, offsets shifted) keep the key
  of the old line they were (rare: lines that only moved are normally outside the splice); of the
  remaining lines, edited lines take the keys of the old lines they replace in order (typing in a line keeps its key); extra lines get fresh keys. Keys are
  unique within the list. `render_all` assigns fresh keys to every line.
- So: a key in `insert` that the DOM already has = the same line (reuse its element); compare the
  content (e.g. `text`, `active`, `segments`) to decide whether to redraw it.

## Layout

```ts
interface JsLayout {
  caret_rect(pos: number): [x: number, y: number, w: number, h: number];
  hit_test(x: number, y: number): number | undefined;
  bounds(): [w: number, h: number];
  adjacent_line_y(pos: number, dir: -1 | 1): number | null | undefined; // null: document edge
  table_cell_at(line: number, x: number, y: number): number | undefined;
  line_mid_y(line: number): number | undefined;
  image_at(x: number, y: number): [from: number, to: number] | undefined;
}
```

`Geo` (lib.rs) implements editor-core's `Layout` over it: positions are converted UTF-16 <-> bytes
with the text as of the last patch, `caret_rect` -> `Rect { left: x, top: y, bottom: y + h }`,
`bounds` -> `Bounds { 0, 0, w, h }`.
