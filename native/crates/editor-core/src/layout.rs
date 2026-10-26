//! Geometry the UI provides: caret rects and hit-testing in the *current* layout (the one drawn
//! from the latest `render_lines`, i.e. with the current reveal state). Used for Up/Down by visual
//! line, clicks and table cell hits. `MonoLayout` is a simple monospace, no-wrap implementation
//! for tests.

use crate::editor::Editor;
use crate::render::{LineView, SegKind};

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

pub trait Layout {
    /// Caret box at raw offset `pos` in the current layout. Collapsed (hidden) segments have zero
    /// width, so every offset inside a collapsed run has the same x.
    fn caret_rect(&self, pos: usize) -> Rect;

    /// The raw offset at a point, hit-tested natively in the current layout (like
    /// `caretPositionFromPoint`: the nearer edge of the character under x on the visual line under
    /// y; atomic tokens/chips resolve to their start or end). None when the point is outside the text.
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

    /// Vertical probe step for Up/Down (the TS uses 4px).
    fn probe_step(&self) -> f64 {
        4.0
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
    from: usize,
    to: usize,
    text_from: usize,
    units: Vec<Unit>,
}

/// Monospace, no-wrap test layout: one row per source line, `char_w` per visible char, block
/// tokens two columns wide (heading tokens zero: they hang in the margin), link chips one column,
/// hidden segments zero, table cells separated by one column of padding.
#[derive(Clone, Debug)]
pub struct MonoLayout {
    lines: Vec<MonoLine>,
    pub char_w: f64,
    pub line_h: f64,
    pub cols: f64,
}

impl MonoLayout {
    pub fn new(editor: &Editor) -> MonoLayout {
        MonoLayout::from_views(&editor.render_lines(), editor.text())
    }

    pub fn from_views(views: &[LineView], text: &str) -> MonoLayout {
        let lines = views
            .iter()
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
                        SegKind::Chip => push(s.from, s.to, 1.0),
                        _ => {
                            for (i, c) in text[s.from..s.to].char_indices() {
                                push(s.from + i, s.from + i + c.len_utf8(), 1.0);
                            }
                        }
                    }
                }
                MonoLine { from: v.from, to: v.to, text_from: v.text_from, units }
            })
            .collect();
        MonoLayout { lines, char_w: 10.0, line_h: 20.0, cols: 80.0 }
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
        let l = self.lines.get(line)?;
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
        (line < self.lines.len()).then_some((line as f64 + 0.5) * self.line_h)
    }
}
