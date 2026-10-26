//! wasm-bindgen glue around editor-core for the web editor (contract 4 of
//! docs/rust-engine/PLAN.md). Everything crossing the boundary is in UTF-16 code units; the
//! engine stays in bytes. Each command returns a `Patch`: the minimal splice of the line list
//! (as `LineViewJs` objects), the selection, and the text edits the command made.

pub mod conv;
pub mod diff;

use conv::{LineViewJs, Snap, line_view_js};
use diff::{splice_keys, text_edit, trim};
use editor_core::reveal::RevealMap;
use editor_core::render::line_view;
use editor_core::text::utf16_to_byte;
use collab::{AfterClose, CollabEditor, ConnStatus, Notice};
use editor_core::{Adjacent, Bounds, Command, Editor, Key, Layout, Mods, Rect, Sel, TextStore};
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r##"
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

/** Collab engines (`Engine.collab`): see README.md "Collab mode". Frames are whole WebSocket messages. */
export type SaveState = { dirty: boolean; saving: boolean; commit: string | null; savedAt: number | null };
export type Notice =
  | { t: "hello"; readOnly: boolean; saveState: SaveState }  // the room answered (status: connected)
  | { t: "synced" }                                           // the server's state arrived (once): mount the editor
  | { t: "readOnly"; readOnly: boolean }                      // the engine became read-only / writable
  | { t: "saveState"; saveState: SaveState }
  | { t: "external"; commit: string | null }                  // the file changed outside the editor
  | { t: "reset" };                                           // close the socket, reset(newId), connect again
export type Received = {
  patch?: Patch;            // remote edits (patch.edits = the change, UTF-16); none when reloaded
  frames: Uint8Array[];     // send now
  notices: Notice[];
  awareness: boolean;       // remote presence changed: redraw cursors / participants
  reloaded: boolean;        // the editor was rebuilt from the shared document: render everything (render_all)
  error?: string;           // undecodable frame (ignored)
};
export type Outgoing = { frames: Uint8Array[]; wakeInMs?: number; awareness: boolean };
export type AfterClose = { retry: number } | { closed: string; to: string | null };
export type PeerCursor = { client: number; userId: string; name: string; color: string; anchor: number; head: number; key: string };
export type Peer = { client: number; state: { user?: unknown; cursor?: unknown } };

export interface ImageViewJs {
  from: number; to: number;           // the whole source ![alt](src "title"): a click puts the caret at `to`
  altRange: [from: number, to: number]; // the alt text's range (a marker range; drawn as text when revealed)
  alt: string;
  src: string;                        // as written (not decoded or resolved)
  title?: string;
  revealed: boolean;                  // its source is shown (the caret or selection touches it)
}
"##;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "JsLayout")]
    pub type JsLayout;
    #[wasm_bindgen(method, catch, js_name = caret_rect)]
    fn js_caret_rect(this: &JsLayout, pos: f64) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch, js_name = hit_test)]
    fn js_hit_test(this: &JsLayout, x: f64, y: f64) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch, js_name = bounds)]
    fn js_bounds(this: &JsLayout) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch, js_name = adjacent_line_y)]
    fn js_adjacent_line_y(this: &JsLayout, pos: f64, dir: i32) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch, js_name = table_cell_at)]
    fn js_table_cell_at(this: &JsLayout, line: f64, x: f64, y: f64) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch, js_name = line_mid_y)]
    fn js_line_mid_y(this: &JsLayout, line: f64) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch, js_name = image_at)]
    fn js_image_at(this: &JsLayout, x: f64, y: f64) -> Result<JsValue, JsValue>;
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn perf_now() -> f64;
}

/// A number result (`undefined`, `null`, a missing method or a throw -> None).
fn num(r: Result<JsValue, JsValue>) -> Option<f64> {
    r.ok()?.as_f64().filter(|v| v.is_finite())
}

/// An array-of-numbers result (missing entries -> 0); None unless it is an array.
fn nums(r: Result<JsValue, JsValue>) -> Option<Vec<f64>> {
    let v = r.ok()?;
    if !js_sys::Array::is_array(&v) {
        return None;
    }
    let a: js_sys::Array = v.unchecked_into();
    Some(a.iter().map(|x| x.as_f64().filter(|v| v.is_finite()).unwrap_or(0.0)).collect())
}

fn idx(v: f64) -> usize {
    if v > 0.0 { v as usize } else { 0 }
}

/// editor-core's `Layout` over a JS object, converting offsets with the current text snapshot.
struct Geo<'a> {
    js: &'a JsLayout,
    snap: &'a Snap,
}

impl Layout for Geo<'_> {
    fn caret_rect(&self, pos: usize) -> Rect {
        let a = nums(self.js.js_caret_rect(self.snap.to_u16(pos) as f64)).unwrap_or_default();
        let g = |i: usize| a.get(i).copied().unwrap_or(0.0);
        Rect { left: g(0), top: g(1), bottom: g(1) + g(3) }
    }

    fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
        num(self.js.js_hit_test(x, y)).map(|u| self.snap.to_byte(idx(u)))
    }

    fn bounds(&self) -> Bounds {
        let a = nums(self.js.js_bounds()).unwrap_or_default();
        let g = |i: usize| a.get(i).copied().unwrap_or(0.0);
        Bounds { left: 0.0, top: 0.0, right: g(0), bottom: g(1) }
    }

    fn adjacent_line_y(&self, pos: usize, dir: i32) -> Option<f64> {
        num(self.js.js_adjacent_line_y(self.snap.to_u16(pos) as f64, dir.signum()))
    }

    /// A number: its y; `null`: the document's edge; anything else (undefined, a missing method, a throw): unknown.
    fn adjacent_line(&self, pos: usize, dir: i32) -> Adjacent {
        match self.js.js_adjacent_line_y(self.snap.to_u16(pos) as f64, dir.signum()) {
            Ok(v) if v.is_null() => Adjacent::Edge,
            r => num(r).map_or(Adjacent::Unknown, Adjacent::Y),
        }
    }

    fn table_cell_at(&self, line: usize, x: f64, y: f64) -> Option<usize> {
        num(self.js.js_table_cell_at(line as f64, x, y)).map(idx)
    }

    fn line_mid_y(&self, line: usize) -> Option<f64> {
        num(self.js.js_line_mid_y(line as f64))
    }

    fn image_at(&self, x: f64, y: f64) -> Option<(usize, usize)> {
        let a = nums(self.js.js_image_at(x, y))?;
        (a.len() >= 2).then(|| (self.snap.to_byte(idx(a[0])), self.snap.to_byte(idx(a[1]))))
    }
}

// ----------------------------------------------------------------------------------------------
// Patch (serialized with serde-wasm-bindgen)

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SelJs {
    pub anchor: u32,
    pub head: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct EditJs {
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinesJs {
    pub start: u32,
    pub delete_count: u32,
    pub insert: Vec<LineViewJs>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PatchJs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<LinesJs>,
    pub sel: SelJs,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edits: Option<Vec<EditJs>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composing: Option<bool>,
}

#[derive(Serialize)]
struct CutJs {
    text: String,
    patch: PatchJs,
}

#[derive(Deserialize)]
struct EditIn {
    from: f64,
    to: f64,
    insert: String,
}

fn to_js<T: Serialize>(v: &T) -> JsValue {
    v.serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true).serialize_maps_as_objects(true)).unwrap_or(JsValue::UNDEFINED)
}

/// A `KeyboardEvent.key` name as an editor-core key (None: not one the key map knows).
pub fn parse_key(k: &str) -> Option<Key> {
    Some(match k {
        "ArrowLeft" | "Left" => Key::Left,
        "ArrowRight" | "Right" => Key::Right,
        "ArrowUp" | "Up" => Key::Up,
        "ArrowDown" | "Down" => Key::Down,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "Backspace" => Key::Backspace,
        "Delete" | "Del" => Key::Delete,
        "Enter" => Key::Enter,
        "Tab" => Key::Tab,
        "Escape" | "Esc" => Key::Escape,
        _ => {
            let mut it = k.chars();
            let c = it.next()?;
            if it.next().is_some() {
                return None;
            }
            Key::Char(c)
        }
    })
}

/// Mods bitmask: 1 = shift, 2 = alt (Option), 4 = ctrl, 8 = meta (Cmd).
pub fn parse_mods(m: u32) -> Mods {
    Mods { shift: m & 1 != 0, alt: m & 2 != 0, ctrl: m & 4 != 0, cmd: m & 8 != 0 }
}

// ----------------------------------------------------------------------------------------------
// Engine

/// What the engine edits: a plain text (`new Engine(text)`), or the shared document of a Grimoire room
/// (`Engine.collab(clientId, user)`: yrs + the WebSocket protocol, sans-IO).
enum Ed {
    Plain(Box<Editor>),
    Collab(Box<CollabEditor>),
}

/// Run `$body` with `$e` bound to the editor (`&mut Editor<S>` for either store).
macro_rules! with_ed {
    ($ed:expr, $e:ident => $body:expr) => {
        match $ed {
            Ed::Plain(p) => {
                let $e = &mut **p;
                $body
            }
            Ed::Collab(c) => {
                let $e = c.editor_mut();
                $body
            }
        }
    };
}

/// Same with `&Editor<S>`.
macro_rules! with_ed_ref {
    ($ed:expr, $e:ident => $body:expr) => {
        match $ed {
            Ed::Plain(p) => {
                let $e = &**p;
                $body
            }
            Ed::Collab(c) => {
                let $e = c.editor();
                $body
            }
        }
    };
}

#[wasm_bindgen]
pub struct Engine {
    ed: Ed,
    v: View,
}

/// What the front end has, as of the last patch.
struct View {
    /// The text as of the last patch (always equal to the editor's text between calls).
    snap: Snap,
    /// The line list as of the last patch (without keys: those are in `keys`), and its reveal state.
    lines: Vec<LineViewJs>,
    keys: Vec<u32>,
    reveal: RevealMap,
    next_key: u32,
    /// Between `begin_composition` and the commit (`insert_text`) or `end_composition`.
    composing: bool,
    /// The collab editor was rebuilt and the front end hasn't rendered it yet (`render_all` clears it).
    stale: bool,
    /// `set_profiling(true)`: timings of the last command (see `profile`).
    prof: Option<Prof>,
}

impl View {
    fn new(text: &str) -> View {
        View {
            snap: Snap::new(text.to_string()),
            lines: vec![],
            keys: vec![],
            reveal: RevealMap::new(),
            next_key: 0,
            composing: false,
            stale: false,
            prof: None,
        }
    }

    fn now(&self) -> f64 {
        if self.prof.is_some() { perf_now() } else { 0.0 }
    }
}

/// Milliseconds spent in the parts of the last command.
#[derive(Clone, Copy, Debug, Default)]
struct Prof {
    start: f64,
    edit: f64,
    render: f64,
    diff: f64,
    conv: f64,
    ser: f64,
}

// ---- collab results (serialized) ----

/// Frames to send (`Uint8Array`s in JS).
pub type Frames = Vec<serde_bytes::ByteBuf>;

fn frames(v: Vec<Vec<u8>>) -> Frames {
    v.into_iter().map(serde_bytes::ByteBuf::from).collect()
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum NoticeJs {
    Hello {
        #[serde(rename = "readOnly")]
        read_only: bool,
        #[serde(rename = "saveState")]
        save_state: serde_json::Value,
    },
    Synced,
    ReadOnly {
        #[serde(rename = "readOnly")]
        read_only: bool,
    },
    SaveState {
        #[serde(rename = "saveState")]
        save_state: serde_json::Value,
    },
    External {
        commit: Option<String>,
    },
    Reset,
}

fn notice_js(n: Notice, save_state: &serde_json::Value) -> NoticeJs {
    match n {
        Notice::Hello { read_only, .. } => NoticeJs::Hello { read_only, save_state: save_state.clone() },
        Notice::Synced => NoticeJs::Synced,
        Notice::ReadOnly(read_only) => NoticeJs::ReadOnly { read_only },
        Notice::SaveState(save_state) => NoticeJs::SaveState { save_state },
        Notice::External(commit) => NoticeJs::External { commit },
        Notice::Reset => NoticeJs::Reset,
    }
}

#[derive(Serialize, Debug, Default)]
pub struct ReceivedJs {
    /// The editor changed (remote edits: `edits` holds them; or rebuilt: a full render).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<PatchJs>,
    /// Send these now.
    pub frames: Frames,
    pub notices: Vec<NoticeJs>,
    /// Remote presence changed: redraw remote cursors / participants.
    pub awareness: bool,
    /// The editor was rebuilt from the shared document (initial sync, or after a mismatch): `patch` is a full
    /// render.
    pub reloaded: bool,
    /// The frame couldn't be decoded (it's ignored).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingJs {
    pub frames: Frames,
    /// Call `take_outgoing` again after this many ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_in_ms: Option<f64>,
    /// Remote presence timed out: redraw remote cursors / participants.
    pub awareness: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(untagged)]
pub enum AfterCloseJs {
    Retry { retry: u32 },
    Closed { closed: String, to: Option<String> },
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeerCursorJs {
    pub client: f64,
    pub user_id: String,
    pub name: String,
    pub color: String,
    /// UTF-16 offsets into the current text.
    pub anchor: u32,
    pub head: u32,
    /// The cursor as published (JSON): changes only when that participant moves it.
    pub key: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PeerJs {
    pub client: f64,
    pub state: serde_json::Value,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str) -> Engine {
        let mut ed = Editor::new(text);
        ed.set_edit_log(true);
        let v = View::new(ed.text());
        Engine { ed: Ed::Plain(Box::new(ed)), v }
    }

    /// An engine on the shared document of a Grimoire room. `client_id`: random per session, below 2^32
    /// (`crypto.getRandomValues`); `user`: our presence user `{id, name, color, kind}`. The document is empty
    /// until the server's state arrives through `receive`. Every command works as for a plain engine; call
    /// `take_outgoing` after each one and send the frames.
    pub fn collab(client_id: u32, #[wasm_bindgen(unchecked_param_type = "object")] user: JsValue) -> Engine {
        let user: serde_json::Value = serde_wasm_bindgen::from_value(user).unwrap_or(serde_json::Value::Null);
        Engine::collab_rs(client_id, user)
    }

    pub fn is_collab(&self) -> bool {
        matches!(self.ed, Ed::Collab(_))
    }

    pub fn text(&self) -> String {
        with_ed_ref!(&self.ed, e => e.text().to_string())
    }

    /// Full render: replaces every line the front end has (fresh keys).
    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn render_all(&mut self) -> JsValue {
        self.mark();
        let p = self.render_all_rs();
        self.out(&p)
    }

    /// Typed text, or the IME commit while composing.
    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn insert_text(&mut self, s: &str) -> JsValue {
        self.mark();
        let p = self.insert_text_rs(s);
        self.out(&p)
    }

    /// A key press through editor-core's key map; `undefined` when the key isn't the editor's.
    #[wasm_bindgen(unchecked_return_type = "Patch | undefined")]
    pub fn key(&mut self, key: &str, mods: u32, layout: &JsLayout) -> JsValue {
        self.mark();
        let Some(k) = parse_key(key) else { return JsValue::UNDEFINED };
        let geo = Geo { js: layout, snap: &self.v.snap };
        let Some(cmd) = with_ed!(&mut self.ed, e => e.key(k, parse_mods(mods), &geo)) else { return JsValue::UNDEFINED };
        let p = self.step(Some(scroll_of(cmd)));
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn mouse_down(&mut self, x: f64, y: f64, clicks: u32, shift: bool, layout: &JsLayout) -> JsValue {
        self.mark();
        let geo = Geo { js: layout, snap: &self.v.snap };
        with_ed!(&mut self.ed, e => e.mouse_down(&geo, x, y, clicks, shift));
        let p = self.step(None);
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn mouse_drag(&mut self, x: f64, y: f64, layout: &JsLayout) -> JsValue {
        self.mark();
        let geo = Geo { js: layout, snap: &self.v.snap };
        with_ed!(&mut self.ed, e => e.mouse_drag(&geo, x, y));
        let p = self.step(None);
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn set_selection(&mut self, anchor: u32, head: u32) -> JsValue {
        self.mark();
        let p = self.set_selection_rs(anchor, head);
        self.out(&p)
    }

    pub fn begin_composition(&mut self) {
        with_ed!(&mut self.ed, e => e.begin_composition());
        self.v.composing = true;
    }

    /// Forgets a composition without changing the text (the view that showed it was rebuilt or went away).
    pub fn abort_composition(&mut self) {
        self.v.composing = false;
        with_ed!(&mut self.ed, e => e.cancel_composition());
    }

    /// Ends a composition that had no commit (cancelled): a selection it replaced is deleted (like
    /// the TS editor), the undo group ends. After a commit (`insert_text`) it changes nothing.
    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn end_composition(&mut self) -> JsValue {
        self.mark();
        let p = self.end_composition_rs();
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn paste(&mut self, text: &str) -> JsValue {
        self.mark();
        let p = self.paste_rs(text);
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "CutResult")]
    pub fn cut(&mut self) -> JsValue {
        self.mark();
        let text = with_ed!(&mut self.ed, e => e.cut()).unwrap_or_default();
        let c = CutJs { text, patch: self.step(Some("caret")) };
        self.out(&c)
    }

    pub fn copy(&self) -> String {
        with_ed_ref!(&self.ed, e => e.copy()).unwrap_or_default()
    }

    /// Replace `from..to` (UTF-16) with `text` as one edit (spelling correction, `insertReplacementText`), without
    /// typing rules.
    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn replace_range(&mut self, from: u32, to: u32, text: &str) -> JsValue {
        self.mark();
        let p = self.replace_range_rs(from, to, text);
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn undo(&mut self) -> JsValue {
        self.mark();
        let p = self.undo_rs();
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn redo(&mut self) -> JsValue {
        self.mark();
        with_ed!(&mut self.ed, e => e.redo());
        let p = self.step(Some("caret"));
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn toggle_todo(&mut self, line: u32) -> JsValue {
        self.mark();
        with_ed!(&mut self.ed, e => e.toggle_todo(line as usize));
        let p = self.step(None);
        self.out(&p)
    }

    /// Time the parts of every command (with `performance.now()`), for `profile()`.
    pub fn set_profiling(&mut self, on: bool) {
        self.v.prof = on.then(Prof::default);
    }

    /// With profiling on: milliseconds spent in the last command as `[engine, serialization, edit, render, diff,
    /// conversion]` (engine = edit + render + diff + conversion: everything before the patch becomes JS objects).
    pub fn profile(&self) -> Option<Vec<f64>> {
        self.v.prof.map(|p| vec![p.edit + p.render + p.diff + p.conv, p.ser, p.edit, p.render, p.diff, p.conv])
    }

    /// Read-only (no edits; selection, copy and remote edits still work). A collab engine is also read-only
    /// while the room says so: this adds to that (false: follow the room).
    pub fn set_read_only(&mut self, ro: bool) {
        match &mut self.ed {
            Ed::Plain(e) => e.set_read_only(ro),
            Ed::Collab(c) => c.set_local_read_only(ro),
        }
    }

    /// Remote text edits (UTF-16, applied in order). The patch has no `edits` (they aren't local). Plain engines
    /// only: a collab engine gets remote edits through `receive` (this changes nothing there).
    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn apply_remote(&mut self, #[wasm_bindgen(unchecked_param_type = "Edit[]")] edits: JsValue) -> JsValue {
        self.mark();
        let edits: Vec<EditIn> = serde_wasm_bindgen::from_value(edits).unwrap_or_default();
        let edits: Vec<(usize, usize, String)> = edits.into_iter().map(|e| (idx(e.from), idx(e.to), e.insert)).collect();
        let p = self.apply_remote_rs(&edits);
        self.out(&p)
    }

    // ---- collab (all of these do nothing / return empty results on a plain engine) ----

    /// Feed one binary frame from the server. Send `frames`, apply `patch`, act on `notices`. `now_ms`: the
    /// same clock as `take_outgoing`'s (`performance.now()`).
    #[wasm_bindgen(unchecked_return_type = "Received")]
    pub fn receive(&mut self, frame: &[u8], now_ms: f64) -> JsValue {
        self.mark();
        let r = self.receive_rs(frame, now_ms);
        self.out(&r)
    }

    /// Frames from `take_outgoing` / `receive` / `set_focused` couldn't be sent (the socket was closing): the
    /// edits in them count as unsent (they go out with the next connection's step2).
    pub fn frames_lost(&mut self) {
        if let Ed::Collab(c) = &mut self.ed {
            c.frames_lost();
        }
    }

    /// Every local edit of the collab engine with `client_id` this session, as one Yjs v1 update (undefined:
    /// none, or no such engine). Readable even after that engine trapped (a panic): the app hands it to the
    /// TS editor that takes over.
    pub fn recover_unsent(client_id: u32) -> Option<Vec<u8>> {
        collab::recover_local_updates(client_id)
    }

    /// Frames to send after a command (local edits as one update, our cursor while focused, presence renewal),
    /// and when to call again (`wakeInMs`). `now_ms`: `performance.now()`.
    #[wasm_bindgen(unchecked_return_type = "Outgoing")]
    pub fn take_outgoing(&mut self, now_ms: f64) -> JsValue {
        let o = self.take_outgoing_rs(now_ms);
        to_js(&o)
    }

    /// Focus / blur: our cursor is shown to others only while the editor is focused.
    #[wasm_bindgen(unchecked_return_type = "Uint8Array[]")]
    pub fn set_focused(&mut self, focused: bool, now_ms: f64) -> JsValue {
        to_js(&frames(self.set_focused_rs(focused, now_ms)))
    }

    /// About to open a socket (status → connecting).
    pub fn connecting(&mut self) {
        if let Ed::Collab(c) = &mut self.ed {
            c.connecting();
        }
    }

    /// The socket closed: `{retry: ms}` (reconnect then) or `{closed: reason, to}` (the session ended:
    /// deleted, renamed (`to`), removed, unauthorized, forbidden, notfound, toolarge, …).
    #[wasm_bindgen(unchecked_return_type = "AfterClose")]
    pub fn disconnected(&mut self, code: u16, reason: &str) -> JsValue {
        to_js(&self.disconnected_rs(code, reason))
    }

    /// The browser went online: true = a retry is pending, reconnect now.
    pub fn online(&mut self) -> bool {
        match &mut self.ed {
            Ed::Collab(c) => c.online(),
            Ed::Plain(_) => false,
        }
    }

    /// After a `reset` notice: a fresh, empty document with a new client id (then connect again). Returns
    /// the full render of the empty document.
    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn reset(&mut self, client_id: u32) -> JsValue {
        let p = self.reset_rs(client_id);
        to_js(&p)
    }

    /// Ask the server to commit now.
    #[wasm_bindgen(unchecked_return_type = "Uint8Array[]")]
    pub fn request_flush(&mut self) -> JsValue {
        to_js(&frames(self.request_flush_rs()))
    }

    /// Announce that we leave (send these, then close the socket).
    #[wasm_bindgen(unchecked_return_type = "Uint8Array[]")]
    pub fn leave(&mut self) -> JsValue {
        to_js(&frames(self.leave_rs()))
    }

    /// "connecting" | "connected" | "disconnected" ("connected" for a plain engine).
    pub fn status(&self) -> String {
        match &self.ed {
            Ed::Collab(c) => match c.status() {
                ConnStatus::Connecting => "connecting",
                ConnStatus::Connected => "connected",
                ConnStatus::Disconnected => "disconnected",
            },
            Ed::Plain(_) => "connected",
        }
        .into()
    }

    /// The server's state has arrived (the editor shows the note).
    pub fn synced(&self) -> bool {
        self.synced_rs()
    }

    pub fn read_only(&self) -> bool {
        with_ed_ref!(&self.ed, e => e.is_read_only())
    }

    /// `{dirty, saving, commit, savedAt}` from the last hello / status (null before).
    #[wasm_bindgen(unchecked_return_type = "SaveState | null")]
    pub fn save_state(&self) -> JsValue {
        match &self.ed {
            Ed::Collab(c) => to_js(c.save_state()),
            Ed::Plain(_) => JsValue::NULL,
        }
    }

    pub fn client_id(&self) -> f64 {
        match &self.ed {
            Ed::Collab(c) => c.client_id() as f64,
            Ed::Plain(_) => 0.0,
        }
    }

    /// Other participants' carets/selections to draw (not our own user's from other tabs), UTF-16.
    #[wasm_bindgen(unchecked_return_type = "PeerCursor[]")]
    pub fn remote_cursors(&self) -> JsValue {
        to_js(&self.remote_cursors_rs())
    }

    /// Other clients' presence states `{user, cursor}` (participants list).
    #[wasm_bindgen(unchecked_return_type = "Peer[]")]
    pub fn peers(&self) -> JsValue {
        to_js(&self.peers_rs())
    }

    /// The editor's text equals the shared document's (`receive` rebuilds the editor when it doesn't).
    pub fn is_consistent(&self) -> bool {
        match &self.ed {
            Ed::Collab(c) => c.is_consistent(),
            Ed::Plain(_) => true,
        }
    }
}

fn scroll_of(cmd: Command) -> &'static str {
    match cmd {
        Command::ScrollToStart => "start",
        Command::ScrollToEnd => "end",
        _ => "caret",
    }
}

impl Engine {
    pub fn collab_rs(client_id: u32, user: serde_json::Value) -> Engine {
        let mut c = CollabEditor::new(client_id, user);
        c.editor_mut().set_edit_log(true);
        let v = View::new(c.editor().text());
        Engine { ed: Ed::Collab(Box::new(c)), v }
    }

    /// The plain editor (panics on a collab engine: use `collab_editor`).
    pub fn editor(&self) -> &Editor {
        match &self.ed {
            Ed::Plain(e) => e,
            Ed::Collab(_) => panic!("collab engine"),
        }
    }

    pub fn collab_editor(&self) -> Option<&CollabEditor> {
        match &self.ed {
            Ed::Collab(c) => Some(c),
            Ed::Plain(_) => None,
        }
    }

    /// The editor's current line views (tests).
    pub fn render_lines(&self) -> Vec<editor_core::LineView> {
        with_ed_ref!(&self.ed, e => e.render_lines())
    }

    /// Start timing a command.
    fn mark(&mut self) {
        if self.v.prof.is_some() {
            self.v.prof = Some(Prof { start: perf_now(), ..Prof::default() });
        }
    }

    /// The result as JS objects (timed as serialization).
    fn out<T: Serialize>(&mut self, v: &T) -> JsValue {
        let t = self.v.now();
        let js = to_js(v);
        if let Some(p) = &mut self.v.prof {
            p.ser = perf_now() - t;
        }
        js
    }

    pub fn render_all_rs(&mut self) -> PatchJs {
        with_ed!(&mut self.ed, e => render_all_with(e, &mut self.v))
    }

    pub fn insert_text_rs(&mut self, s: &str) -> PatchJs {
        if self.v.composing {
            self.v.composing = false;
            with_ed!(&mut self.ed, e => e.end_composition(s));
        } else {
            with_ed!(&mut self.ed, e => e.insert_text(s));
        }
        self.step(Some("caret"))
    }

    pub fn end_composition_rs(&mut self) -> PatchJs {
        let was = std::mem::take(&mut self.v.composing);
        if was {
            with_ed!(&mut self.ed, e => e.end_composition(""));
        }
        self.step(was.then_some("caret"))
    }

    pub fn replace_range_rs(&mut self, from: u32, to: u32, text: &str) -> PatchJs {
        let (a, b) = (self.v.snap.to_byte(from as usize), self.v.snap.to_byte(to as usize));
        with_ed!(&mut self.ed, e => e.replace_range(a.min(b), a.max(b), text));
        self.step(Some("caret"))
    }

    pub fn set_selection_rs(&mut self, anchor: u32, head: u32) -> PatchJs {
        let sel = Sel::new(self.v.snap.to_byte(anchor as usize), self.v.snap.to_byte(head as usize));
        with_ed!(&mut self.ed, e => e.set_selection(sel));
        self.step(None)
    }

    pub fn paste_rs(&mut self, text: &str) -> PatchJs {
        with_ed!(&mut self.ed, e => e.paste(text));
        self.step(Some("caret"))
    }

    pub fn undo_rs(&mut self) -> PatchJs {
        with_ed!(&mut self.ed, e => e.undo());
        self.step(Some("caret"))
    }

    pub fn redo_rs(&mut self) -> PatchJs {
        with_ed!(&mut self.ed, e => e.redo());
        self.step(Some("caret"))
    }

    pub fn key_rs(&mut self, key: &str, mods: u32, layout: &dyn Layout) -> Option<PatchJs> {
        let k = parse_key(key)?;
        let cmd = with_ed!(&mut self.ed, e => e.key(k, parse_mods(mods), layout))?;
        Some(self.step(Some(scroll_of(cmd))))
    }

    /// Remote edits, UTF-16 offsets, each against the text left by the ones before it (plain engines).
    pub fn apply_remote_rs(&mut self, edits: &[(usize, usize, String)]) -> PatchJs {
        if let Ed::Plain(ed) = &mut self.ed {
            let mut text = self.v.snap.text.clone();
            let mut ranges = Vec::with_capacity(edits.len());
            for (i, (from, to, insert)) in edits.iter().enumerate() {
                let a = utf16_to_byte(&text, *from);
                let b = utf16_to_byte(&text, *to).max(a);
                if i + 1 < edits.len() {
                    text.replace_range(a..b, insert);
                }
                ranges.push((a..b, insert.clone()));
            }
            ed.apply_remote(&ranges);
        }
        let mut p = self.step(None);
        p.edits = None;
        p
    }

    // ---- collab ----

    pub fn receive_rs(&mut self, frame: &[u8], now_ms: f64) -> ReceivedJs {
        let Ed::Collab(c) = &mut self.ed else {
            return ReceivedJs { error: Some("not a collab engine".into()), ..Default::default() };
        };
        let r = match c.receive(frame, now_ms) {
            Ok(r) => r,
            Err(e) => return ReceivedJs { error: Some(e), ..Default::default() },
        };
        let save_state = c.save_state().clone();
        let notices = r.notices.into_iter().map(|n| notice_js(n, &save_state)).collect();
        let patch = if r.reloaded {
            // a new editor: the front end renders everything (`render_all`); nothing is serialized here
            c.editor_mut().set_edit_log(true);
            self.v.snap = Snap::new(c.editor().text().to_string());
            self.v.composing = false;
            self.v.stale = true;
            None
        } else if !r.edits.is_empty() {
            // `edits` = the remote changes (UTF-16, in order)
            Some(self.step(None))
        } else {
            None
        };
        ReceivedJs { patch, frames: frames(r.outgoing), notices, awareness: r.awareness, reloaded: r.reloaded, error: None }
    }

    pub fn take_outgoing_rs(&mut self, now_ms: f64) -> OutgoingJs {
        let sel = self.sel_u16();
        match &mut self.ed {
            Ed::Collab(c) => {
                let o = c.take_outgoing_at(now_ms, sel);
                OutgoingJs { frames: frames(o.frames), wake_in_ms: o.wake_in_ms, awareness: o.awareness }
            }
            Ed::Plain(_) => OutgoingJs::default(),
        }
    }

    pub fn set_focused_rs(&mut self, focused: bool, now_ms: f64) -> Vec<Vec<u8>> {
        let sel = self.sel_u16();
        match &mut self.ed {
            Ed::Collab(c) => c.set_focused_at(focused, now_ms, sel),
            Ed::Plain(_) => vec![],
        }
    }

    pub fn synced_rs(&self) -> bool {
        match &self.ed {
            Ed::Collab(c) => c.synced(),
            Ed::Plain(_) => true,
        }
    }

    pub fn request_flush_rs(&mut self) -> Vec<Vec<u8>> {
        match &mut self.ed {
            Ed::Collab(c) => c.request_flush(),
            Ed::Plain(_) => vec![],
        }
    }

    pub fn leave_rs(&mut self) -> Vec<Vec<u8>> {
        match &mut self.ed {
            Ed::Collab(c) => c.leave(),
            Ed::Plain(_) => vec![],
        }
    }

    pub fn disconnected_rs(&mut self, code: u16, reason: &str) -> AfterCloseJs {
        match &mut self.ed {
            Ed::Collab(c) => match c.disconnected(code, reason) {
                AfterClose::Retry { delay_ms } => AfterCloseJs::Retry { retry: delay_ms },
                AfterClose::Closed { reason, to } => AfterCloseJs::Closed { closed: reason, to },
            },
            Ed::Plain(_) => AfterCloseJs::Closed { closed: "plain".into(), to: None },
        }
    }

    pub fn reset_rs(&mut self, client_id: u32) -> PatchJs {
        if let Ed::Collab(c) = &mut self.ed {
            c.reset(client_id);
            c.editor_mut().set_edit_log(true);
            self.v.snap = Snap::new(c.editor().text().to_string());
            self.v.composing = false;
        }
        self.render_all_rs()
    }

    pub fn remote_cursors_rs(&self) -> Vec<PeerCursorJs> {
        let Ed::Collab(c) = &self.ed else { return vec![] };
        c.remote_cursors()
            .into_iter()
            .map(|p| PeerCursorJs {
                client: p.client as f64,
                user_id: p.user_id,
                name: p.name,
                color: p.color,
                anchor: p.anchor_utf16,
                head: p.head_utf16,
                key: p.key,
            })
            .collect()
    }

    /// The selection in UTF-16 from the snapshot (equal to the editor's text between calls), unless stale.
    fn sel_u16(&self) -> Option<(u32, u32)> {
        if self.v.stale {
            return None;
        }
        let s = with_ed_ref!(&self.ed, e => e.selection());
        Some((self.v.snap.to_u16(s.anchor) as u32, self.v.snap.to_u16(s.head) as u32))
    }

    pub fn peers_rs(&self) -> Vec<PeerJs> {
        let Ed::Collab(c) = &self.ed else { return vec![] };
        c.peers().into_iter().map(|(client, state)| PeerJs { client: client as f64, state }).collect()
    }

    /// After a command: the text edits, the line splice and the selection, and the new snapshot. After a
    /// rebuild nobody rendered yet (`stale`): a full render.
    pub fn step(&mut self, scroll: Option<&'static str>) -> PatchJs {
        if self.v.stale {
            let mut p = self.render_all_rs();
            p.scroll = scroll;
            return p;
        }
        with_ed!(&mut self.ed, e => step_with(e, &mut self.v, scroll))
    }
}

fn sel_js<S: TextStore>(ed: &Editor<S>, snap: &Snap) -> SelJs {
    let s = ed.selection();
    SelJs { anchor: snap.to_u16(s.anchor) as u32, head: snap.to_u16(s.head) as u32 }
}

fn render_all_with<S: TextStore>(ed: &mut Editor<S>, v: &mut View) -> PatchJs {
    let delete = v.lines.len();
    ed.take_line_changes();
    ed.take_edits();
    if v.stale || v.snap.text != ed.text() {
        v.snap = Snap::new(ed.text().to_string());
    }
    v.stale = false;
    v.reveal = ed.reveal();
    let doc = ed.doc();
    v.lines = doc.lines.iter().map(|l| line_view_js(&line_view(doc, l, v.reveal.get(&l.index)), &v.snap)).collect();
    v.keys = (0..v.lines.len())
        .map(|_| {
            v.next_key += 1;
            v.next_key
        })
        .collect();
    let insert = v.lines.iter().zip(&v.keys).map(|(l, &k)| LineViewJs { key: k.to_string(), ..l.clone() }).collect();
    PatchJs {
        lines: Some(LinesJs { start: 0, delete_count: delete as u32, insert }),
        sel: sel_js(ed, &v.snap),
        edits: None,
        scroll: None,
        composing: v.composing.then_some(true),
    }
}

/// After a command: the text edit, the line splice and the selection, and the new snapshot.
/// Only lines the editor re-parsed (`take_line_changes`) or whose reveal state changed are
/// rendered again; lines that only moved aren't sent (their offsets are line-relative).
fn step_with<S: TextStore>(ed: &mut Editor<S>, v: &mut View, scroll: Option<&'static str>) -> PatchJs {
    // the edits the editor made, in order (touching ones merged, each trimmed to what changed), into the
    // snapshot one by one: edits far apart don't become one span over everything between them
    let log = coalesce(ed.take_edits(), &v.snap.text);
    let mut edits = Vec::with_capacity(log.len());
    for (r, ins) in &log {
        edits.push(EditJs { from: v.snap.to_u16(r.start) as u32, to: v.snap.to_u16(r.end) as u32, insert: ins.clone() });
        v.snap.edit(r.start, r.end, ins);
    }
    if v.snap.text != ed.text() {
        debug_assert!(false, "the edit log replays to the editor's text");
        let (a, b, ins) = text_edit(&v.snap.text, ed.text());
        edits.push(EditJs { from: v.snap.to_u16(a) as u32, to: v.snap.to_u16(b) as u32, insert: ins.to_string() });
        v.snap.edit(a, b, ins);
    }
    let edits = (!edits.is_empty()).then_some(edits);
    let t1 = v.now();
    let changes = ed.take_line_changes();
    let reveal = ed.reveal();
    let doc = ed.doc();
    let (n_old, n_new) = (v.lines.len(), doc.lines.len());
    // changed lines: old `lo..old_hi` became new `lo..hi`
    let (start, old_end, new_end) = match changes {
        Some(c) if n_old - c.old_end.min(n_old) == n_new - c.new_end.min(n_new) => (c.start, c.old_end, c.new_end),
        None if n_old == n_new => (n_old, n_old, n_old),
        _ => (0, n_old, n_new), // can't happen: render everything again
    };
    let (mut lo, mut hi) = (start, new_end);
    let old_of = |k: usize| if k < start { Some(k) } else if k >= new_end { Some(k - new_end + old_end) } else { None };
    let new_of = |k: usize| if k < start { Some(k) } else if k >= old_end { Some(k - old_end + new_end) } else { None };
    for (&k, r) in &reveal {
        if old_of(k).is_some_and(|o| v.reveal.get(&o) != Some(r)) {
            (lo, hi) = (lo.min(k), hi.max(k + 1));
        }
    }
    for (&k, r) in &v.reveal {
        if let Some(n) = new_of(k)
            && reveal.get(&n) != Some(r)
        {
            (lo, hi) = (lo.min(n), hi.max(n + 1));
        }
    }
    let old_hi = hi - new_end + old_end;
    let fresh: Vec<LineViewJs> =
        doc.lines[lo..hi].iter().map(|l| line_view_js(&line_view(doc, l, reveal.get(&l.index)), &v.snap)).collect();
    let t2 = v.now();
    let (p, sfx) = trim(&v.lines[lo..old_hi], &fresh);
    let (start, delete) = (lo + p, old_hi - lo - p - sfx);
    let insert = &fresh[p..fresh.len() - sfx];
    let keys = splice_keys(&v.keys[start..start + delete], insert.len(), &mut v.next_key);
    let t3 = v.now();
    let lines = (delete > 0 || !insert.is_empty()).then(|| LinesJs {
        start: start as u32,
        delete_count: delete as u32,
        insert: insert.iter().zip(&keys).map(|(l, &k)| LineViewJs { key: k.to_string(), ..l.clone() }).collect(),
    });
    v.keys.splice(start..start + delete, keys);
    v.lines.splice(start..start + delete, insert.iter().cloned());
    v.reveal = reveal;
    if let Some(p) = &mut v.prof {
        let t4 = perf_now();
        *p = Prof { edit: t1 - p.start, render: t2 - t1, diff: t3 - t2, conv: t4 - t3, ..*p };
    }
    PatchJs { lines, sel: sel_js(ed, &v.snap), edits, scroll, composing: v.composing.then_some(true) }
}

/// Sequential byte edits made against `text` with touching ones merged and each trimmed to the bytes that
/// really change (a replacement's common prefix / suffix left out); no-op edits dropped.
pub fn coalesce(log: Vec<(std::ops::Range<usize>, String)>, text: &str) -> Vec<(std::ops::Range<usize>, String)> {
    if log.len() <= 1 {
        // (typing: no copy of the text)
        return log.into_iter().filter_map(|(r, ins)| trimmed(r.clone(), &ins, &text[r])).collect();
    }
    // (range in the text before it, insert, removed text)
    let mut out: Vec<(std::ops::Range<usize>, String, String)> = Vec::with_capacity(log.len());
    let mut cur = std::borrow::Cow::Borrowed(text);
    for (r, ins) in log {
        let touches = out.last().is_some_and(|(lr, li, _)| r.start <= lr.start + li.len() && r.end >= lr.start);
        if touches {
            let (lr, li, lg) = out.last_mut().unwrap();
            // the stretch lo..hi of the current text (after `last`) with this edit applied inside it
            let lo = r.start.min(lr.start);
            let hi = r.end.max(lr.start + li.len());
            let mut mid = cur[lo..hi].to_string();
            mid.replace_range(r.start - lo..r.end - lo, &ins);
            // the same stretch in the text before `last`
            let mut old = String::with_capacity(hi - lo);
            old.push_str(&cur[lo..lr.start]);
            old.push_str(lg);
            old.push_str(&cur[lr.start + li.len()..hi]);
            let old_hi = lo + old.len();
            *lr = lo..old_hi;
            *li = mid;
            *lg = old;
        } else {
            out.push((r.clone(), ins.clone(), cur[r.clone()].to_string()));
        }
        cur.to_mut().replace_range(r, &ins);
    }
    out.into_iter().filter_map(|(r, ins, gone)| trimmed(r, &ins, &gone)).collect()
}

/// Replacing `r` (holding `gone`) with `ins`, without the common prefix / suffix; None if nothing changes.
fn trimmed(r: std::ops::Range<usize>, ins: &str, gone: &str) -> Option<(std::ops::Range<usize>, String)> {
    let p = common_prefix(gone, ins);
    let sfx = common_suffix(&gone[p..], &ins[p..]);
    let (a, b) = (r.start + p, r.end - sfx);
    let ins = &ins[p..ins.len() - sfx];
    (a < b || !ins.is_empty()).then(|| (a..b, ins.to_string()))
}

fn common_prefix(a: &str, b: &str) -> usize {
    let mut p = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    while !a.is_char_boundary(p) || !b.is_char_boundary(p) {
        p -= 1;
    }
    p
}

fn common_suffix(a: &str, b: &str) -> usize {
    let mut s = a.bytes().rev().zip(b.bytes().rev()).take_while(|(x, y)| x == y).count();
    while !a.is_char_boundary(a.len() - s) || !b.is_char_boundary(b.len() - s) {
        s -= 1;
    }
    s
}

#[cfg(test)]
mod collab_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::MonoLayout;

    /// Apply a patch's splice to a JS-side line list (as the front end does).
    fn apply(list: &mut Vec<LineViewJs>, p: &PatchJs) {
        if let Some(l) = &p.lines {
            let s = l.start as usize;
            list.splice(s..s + l.delete_count as usize, l.insert.iter().cloned());
        }
    }

    fn check_mirror(e: &Engine, list: &[LineViewJs]) {
        let snap = Snap::new(e.text().to_string());
        let want: Vec<LineViewJs> = e.render_lines().iter().zip(list).map(|(l, j)| conv::line_js(l, j.key.parse().unwrap(), &snap)).collect();
        assert_eq!(list, &want[..]);
        let keys: std::collections::HashSet<_> = list.iter().map(|l| &l.key).collect();
        assert_eq!(keys.len(), list.len(), "keys unique");
    }

    #[test]
    fn patches_keep_the_front_end_in_sync() {
        let mut e = Engine::new("# Hi 😀\n- a");
        let mut list = vec![];
        let p = e.render_all_rs();
        assert_eq!(p.lines.as_ref().unwrap().delete_count, 0);
        apply(&mut list, &p);
        check_mirror(&e, &list);
        // caret at the end of "- a" (UTF-16 offset 11: "# Hi 😀" is 7 units, then "\n- a")
        let p = e.set_selection_rs(11, 11);
        assert_eq!(p.sel, SelJs { anchor: 11, head: 11 });
        apply(&mut list, &p);
        let p = e.insert_text_rs("😀");
        assert_eq!(p.edits, Some(vec![EditJs { from: 11, to: 11, insert: "😀".into() }]));
        assert_eq!(p.sel, SelJs { anchor: 13, head: 13 });
        let l = p.lines.as_ref().unwrap();
        assert_eq!((l.start, l.delete_count, l.insert.len()), (1, 1, 1));
        apply(&mut list, &p);
        check_mirror(&e, &list);
        let lay = MonoLayout::new(e.editor());
        let p = e.key_rs("Enter", 0, &lay).unwrap();
        assert_eq!(e.text(), "# Hi 😀\n- a😀\n- ");
        assert_eq!(p.edits, Some(vec![EditJs { from: 13, to: 13, insert: "\n- ".into() }]));
        assert_eq!(p.scroll, Some("caret"));
        apply(&mut list, &p);
        check_mirror(&e, &list);
        assert!(e.key_rs("a", 0, &lay).is_none());
        assert!(e.key_rs("Dead", 0, &lay).is_none());
        let p = e.undo_rs();
        // typing and the Enter are one undo group
        assert_eq!(e.text(), "# Hi 😀\n- a");
        assert_eq!(p.edits, Some(vec![EditJs { from: 11, to: 16, insert: "".into() }]));
        apply(&mut list, &p);
        check_mirror(&e, &list);
        let p = e.apply_remote_rs(&[(0, 0, "x".into()), (2, 4, "".into())]);
        assert_eq!(e.text(), "x#i 😀\n- a");
        assert_eq!(p.edits, None);
        apply(&mut list, &p);
        check_mirror(&e, &list);
    }

    #[test]
    fn remote_edits_are_not_undone() {
        let mut e = Engine::new("ab😀");
        let mut list = vec![];
        apply(&mut list, &e.render_all_rs());
        apply(&mut list, &e.set_selection_rs(4, 4));
        apply(&mut list, &e.insert_text_rs("X"));
        // two edits, the second against the text left by the first
        let p = e.apply_remote_rs(&[(0, 0, "😁".into()), (3, 4, "B".into())]);
        assert_eq!(e.text(), "😁aB😀X");
        assert_eq!(p.sel, SelJs { anchor: 7, head: 7 });
        apply(&mut list, &p);
        check_mirror(&e, &list);
        let p = e.undo_rs();
        assert_eq!(e.text(), "😁aB😀");
        assert_eq!(p.edits, Some(vec![EditJs { from: 6, to: 7, insert: "".into() }]));
        apply(&mut list, &p);
        check_mirror(&e, &list);
    }

    #[test]
    fn only_changed_lines_are_sent() {
        let text: String = (0..300).map(|i| if i % 3 == 0 { format!("- item **{i}**\n") } else { format!("line {i} 😀\n") }).collect();
        let mut e = Engine::new(&text);
        let mut list = vec![];
        apply(&mut list, &e.render_all_rs());
        // typing at the top: one line
        apply(&mut list, &e.set_selection_rs(8, 8));
        let p = e.insert_text_rs("x");
        let l = p.lines.as_ref().unwrap();
        assert_eq!((l.start, l.delete_count, l.insert.len()), (0, 1, 1));
        apply(&mut list, &p);
        check_mirror(&e, &list);
        // Enter in the middle of the first line: that line and the new one
        let p = { let lay = MonoLayout::new(e.editor()); e.key_rs("Enter", 0, &lay).unwrap() };
        let l = p.lines.as_ref().unwrap();
        assert_eq!((l.start, l.delete_count, l.insert.len()), (0, 1, 2));
        apply(&mut list, &p);
        check_mirror(&e, &list);
        // moving the caret down a line: the reveal of both lines changes
        let p = e.set_selection_rs(30, 30);
        apply(&mut list, &p);
        check_mirror(&e, &list);
        // a code fence opened at the top changes every line below it
        apply(&mut list, &e.set_selection_rs(0, 0));
        let p = e.paste_rs("```\n");
        assert!(p.lines.as_ref().unwrap().insert.len() > 290);
        apply(&mut list, &p);
        check_mirror(&e, &list);
        let p = e.undo_rs();
        apply(&mut list, &p);
        check_mirror(&e, &list);
        // remote edit far below the caret
        let p = e.apply_remote_rs(&[(2000, 2000, "\n# head\n".into())]);
        assert!(p.lines.as_ref().unwrap().insert.len() <= 3);
        apply(&mut list, &p);
        check_mirror(&e, &list);
    }

    #[test]
    fn crlf_text_stays_byte_identical() {
        let mut e = Engine::new("a\r\n- b\r\nc");
        assert_eq!(e.text(), "a\r\n- b\r\nc");
        let mut list = vec![];
        apply(&mut list, &e.render_all_rs());
        assert_eq!(list.iter().map(|l| l.len).collect::<Vec<_>>(), vec![2, 4, 1]);
        check_mirror(&e, &list);
        // remote edit after the second "\r" (UTF-16 offset 7 = after "a\r\n- b\r")
        let p = e.apply_remote_rs(&[(7, 7, "X".into())]);
        assert_eq!(e.text(), "a\r\n- b\rX\nc");
        apply(&mut list, &p);
        check_mirror(&e, &list);
        apply(&mut list, &e.set_selection_rs(10, 10));
        let p = e.insert_text_rs("d");
        assert_eq!(p.edits, Some(vec![EditJs { from: 10, to: 10, insert: "d".into() }]));
        assert_eq!(e.text(), "a\r\n- b\rX\ncd");
    }

    #[test]
    fn cancelled_composition_deletes_the_selection_and_ends_the_group() {
        let mut e = Engine::new("hello world");
        let mut list = vec![];
        apply(&mut list, &e.render_all_rs());
        apply(&mut list, &e.set_selection_rs(5, 5));
        apply(&mut list, &e.insert_text_rs("X"));
        apply(&mut list, &e.set_selection_rs(0, 5));
        e.begin_composition();
        let p = e.end_composition_rs();
        assert_eq!(e.text(), "X world");
        assert_eq!(p.edits, Some(vec![EditJs { from: 0, to: 5, insert: "".into() }]));
        assert_eq!(p.composing, None);
        apply(&mut list, &p);
        check_mirror(&e, &list);
        // its own undo step (not the cut kind, not joined with the typing)
        apply(&mut list, &e.undo_rs());
        assert_eq!(e.text(), "helloX world");
        // after a commit, end_composition changes nothing
        apply(&mut list, &e.set_selection_rs(0, 0));
        e.begin_composition();
        apply(&mut list, &e.insert_text_rs("é"));
        let p = e.end_composition_rs();
        assert_eq!((p.edits, p.lines.is_none()), (None, true));
        assert_eq!(e.text(), "éhelloX world");
        // a cancelled composition on a caret: nothing
        e.begin_composition();
        let p = e.end_composition_rs();
        assert_eq!(p.edits, None);
    }

    #[test]
    fn replace_range_is_one_edit_without_typing_rules() {
        let mut e = Engine::new("teh **wrod** 😀 x");
        let mut list = vec![];
        apply(&mut list, &e.render_all_rs());
        apply(&mut list, &e.set_selection_rs(16, 16));
        let p = e.replace_range_rs(6, 10, "word");
        assert_eq!(e.text(), "teh **word** 😀 x");
        assert_eq!(p.edits, Some(vec![EditJs { from: 7, to: 9, insert: "or".into() }]));
        assert_eq!(p.sel, SelJs { anchor: 10, head: 10 });
        apply(&mut list, &p);
        check_mirror(&e, &list);
        // a typed ">" at a line start would convert to a quote; a replacement runs no typing rules
        let p = e.replace_range_rs(0, 3, ">");
        assert_eq!(e.text(), "> **word** 😀 x");
        apply(&mut list, &p);
        check_mirror(&e, &list);
        apply(&mut list, &e.undo_rs());
        assert_eq!(e.text(), "teh **wrod** 😀 x");
    }

    #[test]
    fn keys_and_mods() {
        assert_eq!(parse_key("ArrowUp"), Some(Key::Up));
        assert_eq!(parse_key("Z"), Some(Key::Char('Z')));
        assert_eq!(parse_key("Shift"), None);
        assert_eq!(parse_mods(9), Mods { shift: true, cmd: true, ..Mods::NONE });
        let mut e = Engine::new("abc");
        let lay = MonoLayout::new(e.editor());
        let p = e.key_rs("End", 0, &lay).unwrap();
        assert_eq!(p.scroll, Some("end"));
        let p = e.key_rs("Z", 9, &lay).unwrap(); // Cmd-Shift-Z: redo (nothing to redo)
        assert_eq!(p.edits, None);
    }
}
