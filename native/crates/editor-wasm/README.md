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
  begin_composition(): void; end_composition(): void;
  paste(text: string): Patch; cut(): CutResult; copy(): string;
  undo(): Patch; redo(): Patch; toggle_todo(line: number): Patch;
  set_read_only(ro: boolean): void;
  apply_remote(edits: Edit[]): Patch;
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
- IME: `begin_composition()` when composition starts (the browser composes in the DOM), then the
  commit through `insert_text(committed)` (it replaces the selection the composition started on),
  then `end_composition()`. `end_composition()` without a commit (cancelled) changes nothing; while
  composing, patches carry `composing: true`.
- `edits`: present when the command changed the text: one minimal replacement in UTF-16 offsets
  of the text before the command. Never present for `apply_remote` (those edits aren't local).
- `apply_remote`: edits apply in order, each against the text after the previous ones, through
  `Editor::apply_remote`: not undoable (undo keeps reverting only local changes), works when
  read-only, the selection is mapped (a caret at a remote insertion point stays before it).
- `cut()` with no selection returns `{ text: "", patch }`; `copy()` returns `""`.
- `JsLayout` methods may return `undefined` (or be missing/throw: treated as `undefined`);
  `caret_rect` / `bounds` fall back to zeros. `adjacent_line_y` (Up/Down) returning `undefined`
  makes the engine probe with `hit_test` in 4 px steps from the caret box. Engine calls that take a layout (`key`, `mouse_*`) must come after the
  DOM shows the last patch.

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

`lines` is the minimal splice of the line list: the common prefix and suffix of lines that are
**exactly** equal (same `LineView` and same raw text) are left out. Because every offset is absolute,
an edit shifts the offsets (and an inserted/removed line the `index`) of every later line, so those
lines are resent too. Their `key`s say which DOM line they are (see `key` below), so the shell can
reuse a line's DOM and only refresh its stored offsets when its content didn't change.

## LineViewJs

One object per source line (editor-core `LineView`, fields camelCase). **All offsets are absolute
UTF-16 offsets into the Markdown text** (subtract `from` for line-relative ones).

```ts
type BlockType = "paragraph" | "heading" | "bullet" | "todo" | "numbered" | "quote" | "hr"
  | "fence" | "code" | "table-head" | "table-delim" | "table-row";
type SegKind = "token" | "text" | "mk" | "esc" | "chip" | "fence" | "pipe" | "pad" | "delim"; // render.ts names
type InlineType = "bold" | "italic" | "strike" | "underline" | "highlight" | "code" | "link" | "tag" | "image";
type TokenKind = "indent" | "heading" | "bullet" | "todo" | "numbered" | "quote" | "hr";
type CellAlign = "left" | "center" | "right" | null;

interface LineViewJs {
  key: string;          // stable identity for DOM reuse (see below)
  index: number;        // line number (0-based)
  from: number;         // line start
  to: number;           // line end, before the "\n"
  textFrom: number;     // after the block prefix tokens (heading "# ", list "- ", "- [ ] ", "1. ", "> ", indents)
  text: string;         // the raw line text, text.slice(from, to) (no "\n"): segment text is text.slice(s.from - from, s.to - from)
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
  of the old line they were; of the remaining lines, edited lines take the keys of the old lines
  they replace in order (typing in a line keeps its key); extra lines get fresh keys. Keys are
  unique within the list. `render_all` assigns fresh keys to every line.
- So: a key in `insert` that the DOM already has = the same line (reuse its element); compare the
  content (e.g. `text`, `active`, `segments`) to decide whether to redraw it or just update offsets.

## Layout

```ts
interface JsLayout {
  caret_rect(pos: number): [x: number, y: number, w: number, h: number];
  hit_test(x: number, y: number): number | undefined;
  bounds(): [w: number, h: number];
  adjacent_line_y(pos: number, dir: -1 | 1): number | undefined;
  table_cell_at(line: number, x: number, y: number): number | undefined;
  line_mid_y(line: number): number | undefined;
  image_at(x: number, y: number): [from: number, to: number] | undefined;
}
```

`Geo` (lib.rs) implements editor-core's `Layout` over it: positions are converted UTF-16 <-> bytes
with the text as of the last patch, `caret_rect` -> `Rect { left: x, top: y, bottom: y + h }`,
`bounds` -> `Bounds { 0, 0, w, h }`.
