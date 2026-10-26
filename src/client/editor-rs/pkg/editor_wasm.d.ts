/* tslint:disable */
/* eslint-disable */

/** Geometry answered by the front end, in editor content coordinates (CSS px). Offsets are UTF-16. */
export interface JsLayout {
    caret_rect(pos: number): [x: number, y: number, w: number, h: number];
    hit_test(x: number, y: number): number | undefined;
    bounds(): [w: number, h: number];
    /** The adjacent visual line's middle y; null: none (document edge); undefined: unknown (the engine probes). */
    adjacent_line_y(pos: number, dir: -1 | 1): number | null | undefined;
    table_cell_at(line: number, x: number, y: number): number | undefined;
    line_mid_y(line: number): number | undefined;
    image_at(x: number, y: number): [from: number, to: number] | undefined;
}
/** A text change, UTF-16 offsets into the text before it; a list of them applies in order. */
export type Edit = { from: number; to: number; insert: string };
export type Patch = {
    /** Splice of the line list: remove `deleteCount` lines at `start`, insert `insert` there. */
    lines?: { start: number; deleteCount: number; insert: LineViewJs[] };
    sel: { anchor: number; head: number };
    edits?: Edit[];
    scroll?: "caret" | "start" | "end";
    composing?: boolean;
};
export type CutResult = { text: string; patch: Patch };
export type BlockType = "paragraph" | "heading" | "bullet" | "todo" | "numbered" | "quote" | "hr"
| "fence" | "code" | "table-head" | "table-delim" | "table-row";
export type SegKind = "token" | "text" | "mk" | "esc" | "chip" | "fence" | "pipe" | "pad" | "delim"; // render.ts names
export type InlineType = "bold" | "italic" | "strike" | "underline" | "highlight" | "code" | "link" | "tag" | "image";
export type TokenKind = "indent" | "heading" | "bullet" | "todo" | "numbered" | "quote" | "hr";
export type CellAlign = "left" | "center" | "right" | null;

export interface LineViewJs {
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
}

export interface SegViewJs {
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

export interface ImageViewJs {
    from: number; to: number;           // the whole source ![alt](src "title"): a click puts the caret at `to`
    altRange: [from: number, to: number]; // the alt text's range (a marker range; drawn as text when revealed)
    alt: string;
    src: string;                        // as written (not decoded or resolved)
    title?: string;
    revealed: boolean;                  // its source is shown (the caret or selection touches it)
}



export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Remote text edits (UTF-16, applied in order). The patch has no `edits` (they aren't local).
     */
    apply_remote(edits: Edit[]): Patch;
    begin_composition(): void;
    copy(): string;
    cut(): CutResult;
    /**
     * Ends a composition that had no commit (cancelled): a selection it replaced is deleted (like
     * the TS editor), the undo group ends. After a commit (`insert_text`) it changes nothing.
     */
    end_composition(): Patch;
    /**
     * Typed text, or the IME commit while composing.
     */
    insert_text(s: string): Patch;
    /**
     * A key press through editor-core's key map; `undefined` when the key isn't the editor's.
     */
    key(key: string, mods: number, layout: JsLayout): Patch | undefined;
    mouse_down(x: number, y: number, clicks: number, shift: boolean, layout: JsLayout): Patch;
    mouse_drag(x: number, y: number, layout: JsLayout): Patch;
    constructor(text: string);
    paste(text: string): Patch;
    /**
     * With profiling on: milliseconds spent in the last command as `[engine, serialization, edit, render, diff,
     * conversion]` (engine = edit + render + diff + conversion: everything before the patch becomes JS objects).
     */
    profile(): Float64Array | undefined;
    redo(): Patch;
    /**
     * Full render: replaces every line the front end has (fresh keys).
     */
    render_all(): Patch;
    /**
     * Replace `from..to` (UTF-16) with `text` as one edit (spelling correction, `insertReplacementText`), without
     * typing rules.
     */
    replace_range(from: number, to: number, text: string): Patch;
    /**
     * Time the parts of every command (with `performance.now()`), for `profile()`.
     */
    set_profiling(on: boolean): void;
    set_read_only(ro: boolean): void;
    set_selection(anchor: number, head: number): Patch;
    text(): string;
    toggle_todo(line: number): Patch;
    undo(): Patch;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly engine_apply_remote: (a: number, b: number) => number;
    readonly engine_begin_composition: (a: number) => void;
    readonly engine_copy: (a: number, b: number) => void;
    readonly engine_cut: (a: number) => number;
    readonly engine_end_composition: (a: number) => number;
    readonly engine_insert_text: (a: number, b: number, c: number) => number;
    readonly engine_key: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_mouse_down: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly engine_mouse_drag: (a: number, b: number, c: number, d: number) => number;
    readonly engine_new: (a: number, b: number) => number;
    readonly engine_paste: (a: number, b: number, c: number) => number;
    readonly engine_profile: (a: number, b: number) => void;
    readonly engine_redo: (a: number) => number;
    readonly engine_render_all: (a: number) => number;
    readonly engine_replace_range: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_set_profiling: (a: number, b: number) => void;
    readonly engine_set_read_only: (a: number, b: number) => void;
    readonly engine_set_selection: (a: number, b: number, c: number) => number;
    readonly engine_text: (a: number, b: number) => void;
    readonly engine_toggle_todo: (a: number, b: number) => number;
    readonly engine_undo: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
