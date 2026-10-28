//! Geometry the UI provides: caret rects and hit-testing in the *current* layout (the one drawn
//! from the latest `render_lines`, i.e. with the current reveal state). Used for Up/Down by visual
//! line, clicks and table cell hits. `MonoLayout` is a simple monospace, no-wrap implementation
//! for tests.

use crate::editor::Editor;
use crate::render::{LineView, SegKind};
use crate::store::TextStore;

/// A caret box: x position and vertical extent (y grows downwards).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub bottom: f64,
}

/// The laid-out document's extent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// The visual line next to the caret (`Layout::adjacent_line`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Adjacent {
    /// Its vertical middle.
    Y(f64),
    /// There is none: the caret is on the first (Up) / last (Down) visual line.
    Edge,
    /// The layout can't tell: Up/Down probes from the caret box in `probe_step`s.
    Unknown,
}

pub trait Layout {
    /// Caret box at raw offset `pos` in the current layout. Collapsed (hidden) segments have zero
    /// width, so every offset inside a collapsed run has the same x.
    fn caret_rect(&self, pos: usize) -> Rect;

    /// The raw offset at a point, hit-tested natively in the current layout (like
    /// `caretPositionFromPoint`: the nearer edge of the character under x on the visual line under
    /// y; atomic tokens resolve to their start or end). None when the point is outside the text.
    fn hit_test(&self, x: f64, y: f64) -> Option<usize>;

    /// The extent of the whole laid-out document.
    fn bounds(&self) -> Bounds;

    /// Table rows: the cell index under x on line `line` (x left of the row -> 0, right of the
    /// row -> last cell). None if unknown (the engine then uses the native hit's cell).
    fn table_cell_at(&self, _line: usize, _x: f64, _y: f64) -> Option<usize> {
        None
    }

    /// Vertical middle of line `line`'s box (used to redirect hits on a collapsed table
    /// delimiter row to the header row).
    fn line_mid_y(&self, _line: usize) -> Option<f64> {
        None
    }

    /// The source range of the image a point is on, if any. Images are drawn below their line's
    /// text in rows; a point anywhere in a row's band (beside a narrow image, or in the gaps)
    /// counts as on the nearest image of that row. Image hits are taken as they are: the caret
    /// goes to the end of the source, with no edge adjustment or re-hit on the text row.
    fn image_at(&self, _x: f64, _y: f64) -> Option<(usize, usize)> {
        None
    }

    /// Vertical middle of the visual line just above (`dir` < 0) or below (`dir` > 0) the one
    /// holding the caret at `pos`; None when unknown (the default). Only used through the default
    /// `adjacent_line`; layouts that can tell the document's edge apart implement that instead.
    fn adjacent_line_y(&self, _pos: usize, _dir: i32) -> Option<f64> {
        None
    }

    /// The visual line just above (`dir` < 0) or below (`dir` > 0) the one holding the caret at
    /// `pos`. Up/Down hit-tests at its middle once (stepping on by `probe_step` only if that
    /// misses, e.g. on an image below text); at the edge the caret goes to the document's start /
    /// end; `Unknown` makes it probe from the caret box. Default: `adjacent_line_y` (None ->
    /// `Unknown`).
    fn adjacent_line(&self, pos: usize, dir: i32) -> Adjacent {
        self.adjacent_line_y(pos, dir).map_or(Adjacent::Unknown, Adjacent::Y)
    }

    /// Vertical probe step for Up/Down (the TS uses 4px).
    fn probe_step(&self) -> f64 {
        4.0
    }
}

/// Maps offsets in a line's drawn text (visible segments only, hidden markers left out) back to
/// raw offsets, for hit testing in a text layout engine. At a boundary between two drawn units the
/// hit's affinity decides: upstream (the point was on the right half of the unit before) gives
/// the end of that unit, downstream its successor's start. Next to hidden markers that is the
/// side of the markers the click was on, like `caretPositionFromPoint` + TS `domToRaw`: the right
/// half of the `d` in collapsed `**bold** x` lands before the closing `**`, the left half of the
/// space after them.
#[derive(Clone, Debug, Default)]
pub struct DisplayMap {
    /// (display start, raw from, raw to) per drawn unit, in order.
    units: Vec<(usize, usize, usize)>,
    len: usize,
    raw_start: usize,
    raw_end: usize,
}

impl DisplayMap {
    /// An empty map for drawn text starting at raw `raw_start`.
    pub fn new(raw_start: usize) -> DisplayMap {
        DisplayMap { units: Vec::new(), len: 0, raw_start, raw_end: raw_start }
    }

    /// Append a drawn unit: raw `from..to` drawn as `display_len` bytes (a char as itself, a tab
    /// as spaces). Hidden raw text between units is simply skipped.
    pub fn push(&mut self, from: usize, to: usize, display_len: usize) {
        self.units.push((self.len, from, to));
        self.len += display_len;
        self.raw_end = self.raw_end.max(to);
    }

    /// The raw end of the drawn range (after any trailing hidden text).
    pub fn set_end(&mut self, raw_end: usize) {
        self.raw_end = raw_end;
    }

    pub fn display_len(&self) -> usize {
        self.len
    }

    /// The map for one rendered line, drawing each visible segment's raw text as itself (block
    /// tokens are not drawn here).
    pub fn from_line(view: &LineView, text: &str) -> DisplayMap {
        let mut m = DisplayMap::new(view.text_from);
        for s in &view.segments {
            if s.hidden || s.kind == SegKind::Token {
                continue;
            }
            for (i, c) in text[s.from..s.to].char_indices() {
                let r = s.from + i;
                m.push(r, r + c.len_utf8(), c.len_utf8());
            }
        }
        m.set_end(view.to);
        m
    }

    /// The raw offset for display offset `display` hit with the given affinity.
    pub fn raw_at(&self, display: usize, upstream: bool) -> usize {
        // the last unit starting at or before `display`
        let k = self.units.partition_point(|u| u.0 <= display);
        let next = self.units.get(k);
        let cur = k.checked_sub(1).map(|i| self.units[i]);
        let end_of = |i: usize| self.units.get(i + 1).map_or(self.len, |u| u.0);
        match cur {
            // inside a unit drawn wider than one position (a tab): its start
            Some(u) if u.0 < display && display < end_of(k - 1) => u.1,
            // exactly at the start of unit k-1: the boundary is between k-2 and k-1
            Some(u) if u.0 == display => {
                let prev = (k >= 2).then(|| self.units[k - 2]);
                if upstream { prev.map_or(self.raw_start, |p| p.2) } else { u.1 }
            }
            // at the end of the drawn text (after the last unit), or past it
            Some(u) => {
                if upstream && display == self.len { u.2 } else { self.raw_end }
            }
            None => {
                if upstream {
                    self.raw_start
                } else {
                    next.map_or(self.raw_end, |n| n.1)
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
struct Unit {
    from: usize,
    to: usize,
    x0: f64,
    x1: f64,
    cell: Option<usize>,
}

#[derive(Clone, Debug)]
struct MonoLine {
    /// The document line index.
    index: usize,
    from: usize,
    to: usize,
    text_from: usize,
    units: Vec<Unit>,
}

/// Monospace, no-wrap test layout: one row per source line, `char_w` per visible char, block
/// tokens two columns wide (heading tokens zero: they hang in the margin),
/// hidden segments zero, table cells separated by one column of padding.
#[derive(Clone, Debug)]
pub struct MonoLayout {
    lines: Vec<MonoLine>,
    pub char_w: f64,
    pub line_h: f64,
    pub cols: f64,
}

impl MonoLayout {
    pub fn new<S: TextStore>(editor: &Editor<S>) -> MonoLayout {
        MonoLayout::from_views(&editor.render_lines(), editor.text())
    }

    pub fn from_views(views: &[LineView], text: &str) -> MonoLayout {
        // lines hidden in a folded section take no space
        let lines = views
            .iter()
            .filter(|v| !v.hidden_by_fold)
            .map(|v| {
                let mut x = 0.0;
                let mut units = Vec::new();
                let mut cur_cell = None;
                for s in &v.segments {
                    if s.hidden {
                        continue;
                    }
                    // table cells are separated by one column of padding
                    if s.cell != cur_cell && cur_cell.is_some() {
                        x += 1.0;
                    }
                    cur_cell = s.cell;
                    let mut push = |from, to, w: f64| {
                        units.push(Unit { from, to, x0: x, x1: x + w, cell: s.cell });
                        x += w;
                    };
                    match s.kind {
                        SegKind::Token => {
                            let w = if s.token == Some(crate::parser::TokenKind::Heading) { 0.0 } else { 2.0 };
                            push(s.from, s.to, w)
                        }
                        _ => {
                            for (i, c) in text[s.from..s.to].char_indices() {
                                push(s.from + i, s.from + i + c.len_utf8(), 1.0);
                            }
                        }
                    }
                }
                MonoLine { index: v.index, from: v.from, to: v.to, text_from: v.text_from, units }
            })
            .collect();
        MonoLayout { lines, char_w: 10.0, line_h: 20.0, cols: 80.0 }
    }

    /// The row of document line `line` (None: hidden).
    fn row_of(&self, line: usize) -> Option<usize> {
        self.lines.binary_search_by_key(&line, |l| l.index).ok()
    }

    fn line_index(&self, pos: usize) -> usize {
        let mut lo = 0;
        let mut hi = self.lines.len().saturating_sub(1);
        while lo < hi {
            let mid = (lo + hi + 1) >> 1;
            if self.lines[mid].from <= pos {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    }
}

impl Layout for MonoLayout {
    fn caret_rect(&self, pos: usize) -> Rect {
        let li = self.line_index(pos);
        let line = &self.lines[li];
        let mut x = 0.0;
        for u in &line.units {
            if u.to <= pos {
                x = u.x1;
            } else {
                if u.from < pos {
                    x = u.x0;
                }
                break;
            }
        }
        let top = li as f64 * self.line_h;
        Rect { left: x * self.char_w, top, bottom: top + self.line_h }
    }

    fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
        if y < 0.0 || x < 0.0 {
            return None;
        }
        let li = (y / self.line_h) as usize;
        let line = self.lines.get(li)?;
        let col = x / self.char_w;
        for u in &line.units {
            if u.x1 > u.x0 && col < u.x1 {
                return Some(if col < (u.x0 + u.x1) / 2.0 { u.from } else { u.to });
            }
        }
        Some(line.units.last().map_or(if line.from == line.to { line.from } else { line.text_from.min(line.to) }, |u| u.to))
    }

    fn bounds(&self) -> Bounds {
        Bounds { left: 0.0, top: 0.0, right: self.cols * self.char_w, bottom: self.lines.len() as f64 * self.line_h }
    }

    fn table_cell_at(&self, line: usize, x: f64, _y: f64) -> Option<usize> {
        let l = self.lines.get(self.row_of(line)?)?;
        let col = x / self.char_w;
        let mut ranges: Vec<(usize, f64, f64)> = Vec::new();
        for u in &l.units {
            let Some(c) = u.cell else { continue };
            match ranges.iter_mut().find(|r| r.0 == c) {
                Some(r) => r.2 = u.x1 + 1.0,
                None => ranges.push((c, u.x0, u.x1 + 1.0)),
            }
        }
        if let Some(r) = ranges.iter().find(|r| r.1 <= col && col < r.2) {
            return Some(r.0);
        }
        let last = ranges.last()?;
        if col >= last.2 {
            return Some(last.0);
        }
        if col <= ranges[0].1 {
            return Some(ranges[0].0);
        }
        None
    }

    fn line_mid_y(&self, line: usize) -> Option<f64> {
        self.row_of(line).map(|r| (r as f64 + 0.5) * self.line_h)
    }

    fn adjacent_line_y(&self, pos: usize, dir: i32) -> Option<f64> {
        let row = self.line_index(pos).checked_add_signed(dir.signum() as isize)?;
        (row < self.lines.len()).then_some((row as f64 + 0.5) * self.line_h)
    }

    fn adjacent_line(&self, pos: usize, dir: i32) -> Adjacent {
        self.adjacent_line_y(pos, dir).map_or(Adjacent::Edge, Adjacent::Y)
    }
}
