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
use editor_core::{Bounds, Command, Editor, Key, Layout, Mods, Rect, Sel};
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
  adjacent_line_y(pos: number, dir: -1 | 1): number | undefined;
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
    v.serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true)).unwrap_or(JsValue::UNDEFINED)
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

#[wasm_bindgen]
pub struct Engine {
    ed: Editor,
    /// The text as of the last patch (always equal to `ed.text()` between calls).
    snap: Snap,
    /// The line list as of the last patch (without keys: those are in `keys`), and its reveal state.
    lines: Vec<LineViewJs>,
    keys: Vec<u32>,
    reveal: RevealMap,
    next_key: u32,
    /// Between `begin_composition` and the commit (`insert_text`) or `end_composition`.
    composing: bool,
    /// `set_profiling(true)`: timings of the last command (see `profile`).
    prof: Option<Prof>,
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

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str) -> Engine {
        let ed = Editor::new(text);
        let snap = Snap::new(ed.text().to_string());
        Engine { ed, snap, lines: vec![], keys: vec![], reveal: RevealMap::new(), next_key: 0, composing: false, prof: None }
    }

    pub fn text(&self) -> String {
        self.ed.text().to_string()
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
        let geo = Geo { js: layout, snap: &self.snap };
        let Some(cmd) = self.ed.key(k, parse_mods(mods), &geo) else { return JsValue::UNDEFINED };
        let scroll = match cmd {
            Command::ScrollToStart => "start",
            Command::ScrollToEnd => "end",
            _ => "caret",
        };
        let p = self.step(Some(scroll));
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn mouse_down(&mut self, x: f64, y: f64, clicks: u32, shift: bool, layout: &JsLayout) -> JsValue {
        self.mark();
        let geo = Geo { js: layout, snap: &self.snap };
        self.ed.mouse_down(&geo, x, y, clicks, shift);
        let p = self.step(None);
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn mouse_drag(&mut self, x: f64, y: f64, layout: &JsLayout) -> JsValue {
        self.mark();
        let geo = Geo { js: layout, snap: &self.snap };
        self.ed.mouse_drag(&geo, x, y);
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
        self.ed.begin_composition();
        self.composing = true;
    }

    /// Ends a composition that had no commit (cancelled): the text is left unchanged.
    pub fn end_composition(&mut self) {
        self.composing = false;
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
        let text = self.ed.cut().unwrap_or_default();
        let c = CutJs { text, patch: self.step(Some("caret")) };
        self.out(&c)
    }

    pub fn copy(&self) -> String {
        self.ed.copy().unwrap_or_default()
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
        self.ed.redo();
        let p = self.step(Some("caret"));
        self.out(&p)
    }

    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn toggle_todo(&mut self, line: u32) -> JsValue {
        self.mark();
        self.ed.toggle_todo(line as usize);
        let p = self.step(None);
        self.out(&p)
    }

    /// Time the parts of every command (with `performance.now()`), for `profile()`.
    pub fn set_profiling(&mut self, on: bool) {
        self.prof = on.then(Prof::default);
    }

    /// With profiling on: milliseconds spent in the last command as `[engine, serialization, edit, render, diff,
    /// conversion]` (engine = edit + render + diff + conversion: everything before the patch becomes JS objects).
    pub fn profile(&self) -> Option<Vec<f64>> {
        self.prof.map(|p| vec![p.edit + p.render + p.diff + p.conv, p.ser, p.edit, p.render, p.diff, p.conv])
    }

    pub fn set_read_only(&mut self, ro: bool) {
        self.ed.set_read_only(ro);
    }

    /// Remote text edits (UTF-16, applied in order). The patch has no `edits` (they aren't local).
    #[wasm_bindgen(unchecked_return_type = "Patch")]
    pub fn apply_remote(&mut self, #[wasm_bindgen(unchecked_param_type = "Edit[]")] edits: JsValue) -> JsValue {
        self.mark();
        let edits: Vec<EditIn> = serde_wasm_bindgen::from_value(edits).unwrap_or_default();
        let edits: Vec<(usize, usize, String)> = edits.into_iter().map(|e| (idx(e.from), idx(e.to), e.insert)).collect();
        let p = self.apply_remote_rs(&edits);
        self.out(&p)
    }
}

impl Engine {
    pub fn editor(&self) -> &Editor {
        &self.ed
    }

    fn now(&self) -> f64 {
        if self.prof.is_some() { perf_now() } else { 0.0 }
    }

    /// Start timing a command.
    fn mark(&mut self) {
        if self.prof.is_some() {
            self.prof = Some(Prof { start: perf_now(), ..Prof::default() });
        }
    }

    /// The result as JS objects (timed as serialization).
    fn out<T: Serialize>(&mut self, v: &T) -> JsValue {
        let t = self.now();
        let js = to_js(v);
        if let Some(p) = &mut self.prof {
            p.ser = perf_now() - t;
        }
        js
    }

    pub fn render_all_rs(&mut self) -> PatchJs {
        let delete = self.lines.len();
        self.ed.take_line_changes();
        self.reveal = self.ed.reveal();
        let doc = self.ed.doc();
        self.lines = doc.lines.iter().map(|l| line_view_js(&line_view(doc, l, self.reveal.get(&l.index)), &self.snap)).collect();
        self.keys = (0..self.lines.len())
            .map(|_| {
                self.next_key += 1;
                self.next_key
            })
            .collect();
        let insert = self.lines.iter().zip(&self.keys).map(|(l, &k)| LineViewJs { key: k.to_string(), ..l.clone() }).collect();
        PatchJs {
            lines: Some(LinesJs { start: 0, delete_count: delete as u32, insert }),
            sel: self.sel_js(),
            edits: None,
            scroll: None,
            composing: self.composing.then_some(true),
        }
    }

    pub fn insert_text_rs(&mut self, s: &str) -> PatchJs {
        if self.composing {
            self.composing = false;
            self.ed.end_composition(s);
        } else {
            self.ed.insert_text(s);
        }
        self.step(Some("caret"))
    }

    pub fn set_selection_rs(&mut self, anchor: u32, head: u32) -> PatchJs {
        let sel = Sel::new(self.snap.to_byte(anchor as usize), self.snap.to_byte(head as usize));
        self.ed.set_selection(sel);
        self.step(None)
    }

    pub fn paste_rs(&mut self, text: &str) -> PatchJs {
        self.ed.paste(text);
        self.step(Some("caret"))
    }

    pub fn undo_rs(&mut self) -> PatchJs {
        self.ed.undo();
        self.step(Some("caret"))
    }

    pub fn key_rs(&mut self, key: &str, mods: u32, layout: &dyn Layout) -> Option<PatchJs> {
        let cmd = self.ed.key(parse_key(key)?, parse_mods(mods), layout)?;
        let scroll = match cmd {
            Command::ScrollToStart => "start",
            Command::ScrollToEnd => "end",
            _ => "caret",
        };
        Some(self.step(Some(scroll)))
    }

    /// Remote edits, UTF-16 offsets, each against the text left by the ones before it.
    pub fn apply_remote_rs(&mut self, edits: &[(usize, usize, String)]) -> PatchJs {
        let mut text = self.snap.text.clone();
        let mut ranges = Vec::with_capacity(edits.len());
        for (i, (from, to, insert)) in edits.iter().enumerate() {
            let a = utf16_to_byte(&text, *from);
            let b = utf16_to_byte(&text, *to).max(a);
            if i + 1 < edits.len() {
                text.replace_range(a..b, insert);
            }
            ranges.push((a..b, insert.clone()));
        }
        self.ed.apply_remote(&ranges);
        let mut p = self.step(None);
        p.edits = None;
        p
    }

    fn sel_js(&self) -> SelJs {
        let s = self.ed.selection();
        SelJs { anchor: self.snap.to_u16(s.anchor) as u32, head: self.snap.to_u16(s.head) as u32 }
    }

    /// After a command: the text edit, the line splice and the selection, and the new snapshot.
    /// Only lines the editor re-parsed (`take_line_changes`) or whose reveal state changed are
    /// rendered again; lines that only moved aren't sent (their offsets are line-relative).
    pub fn step(&mut self, scroll: Option<&'static str>) -> PatchJs {
        let new_text = self.ed.text();
        let edits = (new_text != self.snap.text).then(|| {
            let (a, b, ins) = text_edit(&self.snap.text, new_text);
            let e = EditJs { from: self.snap.to_u16(a) as u32, to: self.snap.to_u16(b) as u32, insert: ins.to_string() };
            self.snap.edit(a, b, ins);
            vec![e]
        });
        let t1 = self.now();
        let changes = self.ed.take_line_changes();
        let reveal = self.ed.reveal();
        let doc = self.ed.doc();
        let (n_old, n_new) = (self.lines.len(), doc.lines.len());
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
            if old_of(k).is_some_and(|o| self.reveal.get(&o) != Some(r)) {
                (lo, hi) = (lo.min(k), hi.max(k + 1));
            }
        }
        for (&k, r) in &self.reveal {
            if let Some(n) = new_of(k)
                && reveal.get(&n) != Some(r)
            {
                (lo, hi) = (lo.min(n), hi.max(n + 1));
            }
        }
        let old_hi = hi - new_end + old_end;
        let fresh: Vec<LineViewJs> =
            doc.lines[lo..hi].iter().map(|l| line_view_js(&line_view(doc, l, reveal.get(&l.index)), &self.snap)).collect();
        let t2 = self.now();
        let (p, sfx) = trim(&self.lines[lo..old_hi], &fresh);
        let (start, delete) = (lo + p, old_hi - lo - p - sfx);
        let insert = &fresh[p..fresh.len() - sfx];
        let keys = splice_keys(&self.keys[start..start + delete], insert.len(), &mut self.next_key);
        let t3 = self.now();
        let lines = (delete > 0 || !insert.is_empty()).then(|| LinesJs {
            start: start as u32,
            delete_count: delete as u32,
            insert: insert.iter().zip(&keys).map(|(l, &k)| LineViewJs { key: k.to_string(), ..l.clone() }).collect(),
        });
        self.keys.splice(start..start + delete, keys);
        self.lines.splice(start..start + delete, insert.iter().cloned());
        self.reveal = reveal;
        if let Some(p) = &mut self.prof {
            let t4 = perf_now();
            *p = Prof { edit: t1 - p.start, render: t2 - t1, diff: t3 - t2, conv: t4 - t3, ..*p };
        }
        PatchJs { lines, sel: self.sel_js(), edits, scroll, composing: self.composing.then_some(true) }
    }
}

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
        let snap = Snap::new(e.ed.text().to_string());
        let want: Vec<LineViewJs> = e.ed.render_lines().iter().zip(list).map(|(l, j)| conv::line_js(l, j.key.parse().unwrap(), &snap)).collect();
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
        let lay = MonoLayout::new(&e.ed);
        let p = e.key_rs("Enter", 0, &lay).unwrap();
        assert_eq!(e.ed.text(), "# Hi 😀\n- a😀\n- ");
        assert_eq!(p.edits, Some(vec![EditJs { from: 13, to: 13, insert: "\n- ".into() }]));
        assert_eq!(p.scroll, Some("caret"));
        apply(&mut list, &p);
        check_mirror(&e, &list);
        assert!(e.key_rs("a", 0, &lay).is_none());
        assert!(e.key_rs("Dead", 0, &lay).is_none());
        let p = e.undo_rs();
        // typing and the Enter are one undo group
        assert_eq!(e.ed.text(), "# Hi 😀\n- a");
        assert_eq!(p.edits, Some(vec![EditJs { from: 11, to: 16, insert: "".into() }]));
        apply(&mut list, &p);
        check_mirror(&e, &list);
        let p = e.apply_remote_rs(&[(0, 0, "x".into()), (2, 4, "".into())]);
        assert_eq!(e.ed.text(), "x#i 😀\n- a");
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
        assert_eq!(e.ed.text(), "😁aB😀X");
        assert_eq!(p.sel, SelJs { anchor: 7, head: 7 });
        apply(&mut list, &p);
        check_mirror(&e, &list);
        let p = e.undo_rs();
        assert_eq!(e.ed.text(), "😁aB😀");
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
        let p = { let lay = MonoLayout::new(&e.ed); e.key_rs("Enter", 0, &lay).unwrap() };
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
    fn keys_and_mods() {
        assert_eq!(parse_key("ArrowUp"), Some(Key::Up));
        assert_eq!(parse_key("Z"), Some(Key::Char('Z')));
        assert_eq!(parse_key("Shift"), None);
        assert_eq!(parse_mods(9), Mods { shift: true, cmd: true, ..Mods::NONE });
        let mut e = Engine::new("abc");
        let lay = MonoLayout::new(&e.ed);
        let p = e.key_rs("End", 0, &lay).unwrap();
        assert_eq!(p.scroll, Some("end"));
        let p = e.key_rs("Z", 9, &lay).unwrap(); // Cmd-Shift-Z: redo (nothing to redo)
        assert_eq!(p.edits, None);
    }
}
