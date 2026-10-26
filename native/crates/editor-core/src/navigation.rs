//! Caret navigation: Left/Right by raw unit (atomic tokens count as one), word and line jumps,
//! and Up/Down with a goal x hit-tested in the current (pre-reveal) layout.

use crate::layout::Layout;
use crate::parser::{BlockType, Doc, InlineType, Line, line_at, trim_range};
use crate::render::is_image_line;
use crate::reveal::RevealMap;
use crate::text::{floor_boundary, next_boundary};
use crate::units::{Sel, next_stop, prev_stop, snap, word_left, word_right};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HUnit {
    Char,
    Word,
    /// Cmd-Left: text start, then column 0 (two stages). Cmd-Right: line end.
    Line,
    Doc,
}

/// Left (dir < 0) / Right (dir > 0) by `unit`, optionally extending the selection.
pub fn move_horizontal(doc: &Doc, s: Sel, dir: i32, extend: bool, unit: HUnit) -> Sel {
    if !extend && !s.is_empty() && unit == HUnit::Char {
        return Sel::caret(if dir < 0 { s.from() } else { s.to() });
    }
    let mut p = s.head;
    match unit {
        HUnit::Char => p = if dir < 0 { prev_stop(doc, p) } else { next_stop(doc, p) },
        HUnit::Word => p = if dir < 0 { word_left(doc, p) } else { word_right(doc, p) },
        HUnit::Line => {
            let line = doc.line_of(p);
            p = if dir < 0 {
                if p > line.text_from { line.text_from } else { line.from }
            } else {
                line.to
            };
        }
        HUnit::Doc => p = if dir < 0 { 0 } else { doc.text.len() },
    }
    p = snap(doc, p, if matches!(unit, HUnit::Char | HUnit::Word) { dir } else { 0 });
    if extend { Sel::new(s.anchor, p) } else { Sel::caret(p) }
}

/// Option-Up/Down: start of the current/previous line, end of the current/next one.
pub fn move_paragraph(doc: &Doc, s: Sel, dir: i32, extend: bool) -> Sel {
    let li = line_at(&doc.lines, s.head);
    let line = &doc.lines[li];
    let p = if dir < 0 {
        if s.head > line.from {
            line.from
        } else if li > 0 {
            doc.lines[li - 1].from
        } else {
            0
        }
    } else if s.head < line.to {
        line.to
    } else if li + 1 < doc.lines.len() {
        doc.lines[li + 1].to
    } else {
        doc.text.len()
    };
    let p = snap(doc, p, dir);
    if extend { Sel::new(s.anchor, p) } else { Sel::caret(p) }
}

/// Up (dir < 0) / Down: keep the goal x, hit-test the next visual line in the current layout (at
/// `Layout::adjacent_line_y`, else probing from the caret box; the target still collapsed), then
/// snap.
pub fn move_vertical(doc: &Doc, reveal: &RevealMap, layout: &dyn Layout, goal_x: &mut Option<f64>, s: Sel, dir: i32, extend: bool) -> Sel {
    let from = if extend || s.is_empty() {
        s.head
    } else if dir < 0 {
        s.from()
    } else {
        s.to()
    };
    let cur = layout.caret_rect(from);
    let goal = *goal_x.get_or_insert(cur.left);
    let cur_mid = (cur.top + cur.bottom) / 2.0;
    // start at the adjacent line's middle when the layout knows it (probing on from there if the
    // hit isn't a stop), else just outside the caret box
    let mut y = layout.adjacent_line_y(from, dir).unwrap_or(if dir < 0 { cur.top - 1.0 } else { cur.bottom + 1.0 });
    let b = layout.bounds();
    let step = layout.probe_step().max(0.5);
    let mut target = None;
    for _ in 0..100_000 {
        if if dir < 0 { y < b.top } else { y > b.bottom } {
            break;
        }
        let x = goal.min(b.right - 1.0).max(b.left + 1.0);
        // Images below a line's text aren't caret stops (except on a collapsed line of only
        // images): step over them.
        let image = layout.image_at(x, y);
        if image.is_some_and(|(from, _)| !image_stop(doc, reveal, from)) {
            y += dir as f64 * step;
            continue;
        }
        let image = image.is_some();
        if let Some(pos) = hit_test_adjusted(doc, reveal, layout, x, y) {
            let r = layout.caret_rect(pos);
            let mid = (r.top + r.bottom) / 2.0;
            // must be on another visual line: no vertical overlap with the current caret box
            let other = if dir < 0 { r.bottom <= cur.top + 2.0 && mid < cur_mid } else { r.top >= cur.bottom - 2.0 && mid > cur_mid };
            if other {
                target = Some(pos);
                // the probe may have hit padding around the line box (headings): re-hit at the middle
                // (not an image: below its line's text, it's never inside the caret box)
                if !image
                    && (y < r.top || y > r.bottom)
                    && let Some(again) = hit_test_adjusted(doc, reveal, layout, x, mid)
                {
                    target = Some(again);
                }
                break;
            }
        }
        y += dir as f64 * step;
    }
    let t = target.unwrap_or(if dir < 0 { 0 } else { doc.text.len() });
    let t = snap(doc, t, 0);
    if extend { Sel::new(s.anchor, t) } else { Sel::caret(t) }
}

/// An image on a collapsed image-only line (its text hidden, only images shown).
fn image_stop(doc: &Doc, reveal: &RevealMap, from: usize) -> bool {
    let line = doc.line_of(from);
    is_image_line(line)
        && !reveal.get(&line.index).is_some_and(|r| r.els.iter().any(|&k| line.inline.get(k).is_some_and(|e| e.ty == InlineType::Image)))
}

/// Hit-test in the current layout, then fix up the line edges (a hit on an image goes to the end
/// of its source as it is): past the end of a line's last
/// visible character the caret goes to the line end (after collapsed closing markers); left of the
/// first visible character it goes to the text start (before collapsed opening markers).
/// The result is always on a char boundary.
pub fn hit_test_adjusted(doc: &Doc, reveal: &RevealMap, layout: &dyn Layout, x: f64, y: f64) -> Option<usize> {
    if let Some((_, to)) = layout.image_at(x, y) {
        return Some(floor_boundary(&doc.text, to.min(doc.text.len())));
    }
    let pos = floor_boundary(&doc.text, layout.hit_test(x, y)?);
    Some(floor_boundary(&doc.text, adjust_hit(doc, reveal, layout, pos, x, y)))
}

fn adjust_hit(doc: &Doc, reveal: &RevealMap, layout: &dyn Layout, pos: usize, x: f64, y: f64) -> usize {
    let line = doc.line_of(pos);
    if line.table.is_some() {
        return table_hit(doc, reveal, layout, line, pos, x, y);
    }
    if pos < line.to && only_hidden(doc, reveal, line, pos, line.to) && x > layout.caret_rect(pos).left + 1.0 {
        return line.to;
    }
    if pos > line.text_from && only_hidden(doc, reveal, line, line.text_from, pos) && x < layout.caret_rect(pos).left - 1.0 {
        return line.text_from;
    }
    pos
}

/// Table hits are resolved per cell (the cell under the point, or the first/last cell when the
/// point is left/right of the row). In a collapsed table, hits on hidden pipes/padding land in that
/// cell's text, and a hit on the collapsed delimiter row goes to the header row. In both states the
/// usual edge rule applies within the cell.
#[allow(clippy::too_many_arguments)]
fn table_hit(doc: &Doc, reveal: &RevealMap, layout: &dyn Layout, line: &Line, pos: usize, x: f64, y: f64) -> usize {
    let tb = line.table.as_ref().unwrap();
    let collapsed = !reveal.get(&line.index).is_some_and(|r| r.fence);
    if collapsed && line.ty == BlockType::TableDelim {
        let head = &doc.lines[tb.start];
        if let Some(my) = layout.line_mid_y(head.index)
            && let Some(p) = layout.hit_test(x, my)
            && line_at(&doc.lines, p) == head.index
        {
            return table_hit(doc, reveal, layout, head, floor_boundary(&doc.text, p), x, my);
        }
        // one character into the header row (the TS head.from + 1, which counts UTF-16 units)
        return next_boundary(&doc.text, head.from).min(head.to);
    }
    let c = match layout.table_cell_at(line.index, x, y) {
        Some(c) => c.min(tb.cells.len() - 1),
        // fall back to the cell containing the native hit
        None => match tb.cells.iter().position(|&(cf, ct)| cf <= pos && pos <= ct) {
            Some(c) => c,
            None => return pos,
        },
    };
    let (cf, ct) = tb.cells[c];
    let (a, b) = trim_range(&doc.text, cf, ct);
    let mut pos = pos;
    if collapsed {
        if a == b {
            return next_boundary(&doc.text, cf).min(ct);
        }
        pos = pos.clamp(a, b);
    }
    if pos < a || pos > b {
        return pos;
    }
    if pos < b && only_hidden(doc, reveal, line, pos, b) && x > layout.caret_rect(pos).left + 1.0 {
        return b;
    }
    if pos > a && only_hidden(doc, reveal, line, a, pos) && x < layout.caret_rect(pos).left - 1.0 {
        return a;
    }
    pos
}

/// Every character of [from, to) is currently collapsed (unrevealed marker or escape backslash).
/// A collapsed image among other text doesn't count: it's drawn below the line, so a click beside
/// it isn't at its edge.
pub fn only_hidden(doc: &Doc, reveal: &RevealMap, line: &Line, from: usize, to: usize) -> bool {
    if matches!(line.ty, BlockType::Code | BlockType::Fence) || from < line.text_from {
        return false;
    }
    let rv: &[usize] = reveal.get(&line.index).map_or(&[], |r| &r.els);
    let images = is_image_line(line);
    let mut p = from;
    while p < to {
        if !line.escapes.contains(&p) {
            let hidden = line
                .inline
                .iter()
                .enumerate()
                .any(|(k, el)| {
                    !rv.contains(&k) && (images || el.ty != InlineType::Image) && el.markers.iter().any(|&(m0, m1)| m0 <= p && p < m1)
                });
            if !hidden {
                return false;
            }
        }
        p = next_boundary(&doc.text, p);
    }
    true
}
