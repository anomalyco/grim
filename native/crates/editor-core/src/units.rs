//! Caret units over the raw text: which offsets are caret stops, and stepping by unit or word.
//! Atomic units (one caret step): block prefix tokens, link URL chips (unless `Doc::url_text`), escape pairs (`\*`) and
//! grapheme clusters (the TS treats only surrogate pairs as atomic; see README).

use unicode_segmentation::GraphemeCursor;

use crate::parser::{BlockType, Doc, Line};
use crate::text::{char_at, is_word_char, next_boundary, prev_boundary};

/// A selection in byte offsets. `anchor == head` is a caret.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Hash)]
pub struct Sel {
    pub anchor: usize,
    pub head: usize,
}

impl Sel {
    pub fn new(anchor: usize, head: usize) -> Sel {
        Sel { anchor, head }
    }
    pub fn caret(pos: usize) -> Sel {
        Sel { anchor: pos, head: pos }
    }
    pub fn from(&self) -> usize {
        self.anchor.min(self.head)
    }
    pub fn to(&self) -> usize {
        self.anchor.max(self.head)
    }
    pub fn is_empty(&self) -> bool {
        self.anchor == self.head
    }
}

/// The atomic range strictly containing `pos`, if any.
pub fn atomic_around(doc: &Doc, pos: usize) -> Option<(usize, usize)> {
    atomic_around_in_line(doc, doc.line_of(pos), pos)
}

fn atomic_around_in_line(doc: &Doc, line: &Line, pos: usize) -> Option<(usize, usize)> {
    let text = &doc.text;
    // a horizontal rule has a single caret stop, after it
    if line.ty == BlockType::Hr && pos >= line.from && pos < line.to {
        return Some((if line.from > 0 { line.from - 1 } else { line.to }, line.to));
    }
    if pos <= line.from || pos >= line.to {
        return None;
    }
    for t in &line.tokens {
        if t.from < pos && pos < t.to {
            return Some((t.from, t.to));
        }
    }
    if pos >= line.text_from {
        for el in line.inline.iter().filter(|_| !doc.url_text) {
            if let Some((a, b)) = el.url
                && a < pos
                && pos < b
            {
                return Some((a, b));
            }
        }
        for &e in &line.escapes {
            if pos == e + 1 {
                return Some((e, e + 2));
            }
        }
    }
    cluster_in_line(text, line, pos)
}

/// The grapheme cluster strictly containing `pos`. Clusters never cross inline syntax: the edges
/// of markers, escape pairs and link URLs split them, so a combining mark typed after `**` or
/// after an escaped `\*` is a unit of its own rather than gluing itself to the syntax.
fn cluster_in_line(text: &str, line: &Line, pos: usize) -> Option<(usize, usize)> {
    if pos <= line.text_from || pos >= line.to || !text.is_char_boundary(pos) {
        return None;
    }
    // between two ASCII chars there is always a boundary (CR LF can't occur inside a line)
    let b = text.as_bytes();
    if b[pos] < 0x80 && b[pos - 1] < 0x80 {
        return None;
    }
    let (mut lo, mut hi) = (line.text_from, line.to);
    let mut edges = line
        .inline
        .iter()
        .flat_map(|el| el.markers.iter().flat_map(|&(m0, m1)| [m0, m1]).chain(el.url.into_iter().flat_map(|(u0, u1)| [u0, u1])))
        .chain(line.escapes.iter().flat_map(|&e| [e, e + 2]));
    if edges.any(|e| {
        if e < pos {
            lo = lo.max(e);
        } else if e > pos {
            hi = hi.min(e);
        }
        e == pos
    }) {
        return None;
    }
    let s = &text[lo..hi];
    let mut c = GraphemeCursor::new(pos - lo, s.len(), true);
    if c.is_boundary(s, 0).ok()? {
        return None;
    }
    let a = c.prev_boundary(s, 0).ok()??;
    let mut c = GraphemeCursor::new(pos - lo, s.len(), true);
    let z = c.next_boundary(s, 0).ok()??;
    Some((lo + a, lo + z))
}

/// Start of the grapheme cluster holding the char at `i` (its base char decides its class).
fn cluster_base(doc: &Doc, i: usize) -> usize {
    cluster_in_line(&doc.text, doc.line_of(i), i).map_or(i, |r| r.0)
}

pub fn is_stop(doc: &Doc, pos: usize) -> bool {
    atomic_around(doc, pos).is_none()
}

/// Snap a position to a caret stop: dir > 0 forward, dir < 0 backward, 0 nearest.
pub fn snap(doc: &Doc, pos: usize, dir: i32) -> usize {
    let mut pos = crate::text::floor_boundary(&doc.text, pos);
    // a unit's edge is always a stop today; loop anyway so a nested unit can't leave us inside one
    for _ in 0..8 {
        let line = doc.line_of(pos);
        let Some((a, b)) = atomic_around_in_line(doc, line, pos) else { break };
        pos = if dir > 0 {
            b
        } else if dir < 0 || (line.ty != BlockType::Hr && pos - a <= b - pos) {
            a
        } else {
            b
        };
    }
    pos
}

pub fn snap_sel(doc: &Doc, s: Sel, dir: i32) -> Sel {
    Sel { anchor: snap(doc, s.anchor, dir), head: snap(doc, s.head, dir) }
}

pub fn next_stop(doc: &Doc, pos: usize) -> usize {
    if pos >= doc.text.len() {
        return doc.text.len();
    }
    snap(doc, next_boundary(&doc.text, pos), 1)
}

pub fn prev_stop(doc: &Doc, pos: usize) -> usize {
    if pos == 0 {
        return 0;
    }
    snap(doc, prev_boundary(&doc.text, pos), -1)
}

/// Inside a block token or a link URL (atomic units that are never part of a word).
fn in_atomic(doc: &Doc, pos: usize) -> bool {
    let line = doc.line_of(pos);
    line.tokens.iter().any(|t| t.from <= pos && pos < t.to)
        || !doc.url_text && line.inline.iter().any(|el| el.url.is_some_and(|(a, b)| a <= pos && pos < b))
}

/// The char at `i` is a word char outside atomic units.
/// The cluster at `i` is classified by its base char, so a cluster is never split between a word
/// and its surroundings.
fn word_at(doc: &Doc, i: usize) -> bool {
    word_char_at(doc, i) && !in_atomic(doc, i)
}

fn word_before(doc: &Doc, i: usize) -> bool {
    i > 0 && word_at(doc, prev_boundary(&doc.text, i))
}

/// Option-Right: skip non-word characters (markers, spaces, tokens), then a word.
pub fn word_right(doc: &Doc, pos: usize) -> usize {
    let n = doc.text.len();
    let mut i = pos;
    while i < n && !word_at(doc, i) {
        i = next_boundary(&doc.text, i);
    }
    while i < n && word_at(doc, i) {
        i = next_boundary(&doc.text, i);
    }
    snap(doc, i, 1)
}

/// Option-Left: skip non-word characters backwards, then a word.
pub fn word_left(doc: &Doc, pos: usize) -> usize {
    let mut i = pos;
    while i > 0 && !word_before(doc, i) {
        i = prev_boundary(&doc.text, i);
    }
    while word_before(doc, i) {
        i = prev_boundary(&doc.text, i);
    }
    snap(doc, i, -1)
}

/// Range of the word around `pos`, if the caret touches a word.
pub fn word_range(doc: &Doc, pos: usize) -> Option<(usize, usize)> {
    if !word_before(doc, pos) && !word_at(doc, pos) {
        return None;
    }
    let mut a = pos;
    let mut b = pos;
    while word_before(doc, a) {
        a = prev_boundary(&doc.text, a);
    }
    while b < doc.text.len() && word_at(doc, b) {
        b = next_boundary(&doc.text, b);
    }
    Some((a, b))
}

/// The word char test used by Cmd-B ("inside a word"), on the cluster before / at `pos`.
pub fn word_char_before(doc: &Doc, pos: usize) -> bool {
    pos > 0 && word_char_at(doc, prev_boundary(&doc.text, pos))
}

pub fn word_char_at(doc: &Doc, pos: usize) -> bool {
    pos < doc.text.len() && char_at(&doc.text, cluster_base(doc, pos)).is_some_and(is_word_char)
}
