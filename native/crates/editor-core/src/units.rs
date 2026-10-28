//! Caret units over the raw text: which offsets are caret stops, and stepping by unit or word.
//! Atomic units (one caret step): block prefix tokens, escape pairs (`\*`) and
//! grapheme clusters (the TS treats only surrogate pairs as atomic; see README).
//! A collapsed link (any but `Doc::expanded_link`) is stepped through like plain text: its
//! brackets and URL are no stops, nor are its text's edges, so the stops are before it, inside its
//! text and after it (`link_unit`).

use unicode_segmentation::GraphemeCursor;

use crate::parser::{BlockType, Doc, InlineEl, InlineType, Line};
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
    atomic_around_in_line(&doc.text, doc.line_of(pos), pos)
}

fn atomic_around_in_line(text: &str, line: &Line, pos: usize) -> Option<(usize, usize)> {
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
    atomic_around(doc, pos).is_none() && link_unit(doc, doc.line_of(pos), pos).is_none()
}

/// A link other than the expanded one: its brackets and URL are hidden.
pub fn is_collapsed_link(doc: &Doc, el: &InlineEl) -> bool {
    el.ty == InlineType::Link && doc.expanded_link != Some(el.from)
}

/// `i` starts a character drawn as text: not in any element's markers (nested styles, an image
/// source) and not an escape backslash.
fn is_plain(line: &Line, i: usize) -> bool {
    !line.escapes.contains(&i) && !line.inline.iter().any(|e| e.markers.iter().any(|&(m0, m1)| m0 <= i && i < m1))
}

/// A link's text as drawn: the end of its first plain character and the start of its last. None
/// when nothing in it is plain (empty, or only an image).
fn link_plain_text(doc: &Doc, line: &Line, el: &InlineEl) -> Option<(usize, usize)> {
    let text = &doc.text;
    let mut first = None;
    let mut last = None;
    let mut i = el.content_from;
    while i < el.content_to {
        let n = next_boundary(text, i);
        if is_plain(line, i) {
            first.get_or_insert(n);
            last = Some(i);
        }
        i = n;
    }
    Some((first?, last?))
}

/// The plain characters of `el`'s text in [a, b): the first (`dir > 0`) or last one's range.
pub fn link_plain_char(doc: &Doc, line: &Line, el: &InlineEl, a: usize, b: usize, dir: i32) -> Option<(usize, usize)> {
    let mut i = a.max(el.content_from);
    let end = b.min(el.content_to);
    let mut found = None;
    while i < end {
        let n = next_boundary(&doc.text, i);
        if is_plain(line, i) {
            found = Some((i, n));
            if dir > 0 {
                break;
            }
        }
        i = n;
    }
    found
}

/// A collapsed link's hidden lead (`[` up to the end of its first plain character) or tail (from
/// its last plain character's start to after `)`) holding `pos` strictly inside: the stops either
/// side and the one `snap` picks with dir 0 (its outer edge from the hidden syntax). A link with
/// no plain text keeps its text's edges as stops.
fn link_unit(doc: &Doc, line: &Line, pos: usize) -> Option<(usize, usize, usize)> {
    for el in line.inline.iter().filter(|e| is_collapsed_link(doc, e) && e.from < pos && pos < e.to) {
        let (c0, c1) = (el.content_from, el.content_to);
        let near = |a: usize, b: usize| if pos - a <= b - pos { a } else { b };
        match link_plain_text(doc, line, el) {
            Some((first, last)) => {
                if pos < first {
                    return Some((el.from, first, if pos <= c0 { el.from } else { near(el.from, first) }));
                }
                if pos > last {
                    return Some((last, el.to, if pos >= c1 { el.to } else { near(last, el.to) }));
                }
            }
            None => {
                if pos < c0 {
                    return Some((el.from, c0, near(el.from, c0)));
                }
                if pos > c1 {
                    return Some((c1, el.to, near(c1, el.to)));
                }
            }
        }
    }
    None
}

/// In a collapsed link's hidden syntax (brackets, URL).
fn in_hidden_link(doc: &Doc, pos: usize) -> bool {
    doc.line_of(pos)
        .inline
        .iter()
        .any(|e| is_collapsed_link(doc, e) && (e.from <= pos && pos < e.content_from || e.content_to <= pos && pos < e.to))
}

/// Snap a position to a caret stop: dir > 0 forward, dir < 0 backward, 0 nearest.
pub fn snap(doc: &Doc, pos: usize, dir: i32) -> usize {
    let mut pos = crate::text::floor_boundary(&doc.text, pos);
    // a unit's edge is always a stop today; loop anyway so a nested unit can't leave us inside one
    for _ in 0..8 {
        let line = doc.line_of(pos);
        if let Some((a, b, near)) = link_unit(doc, line, pos) {
            pos = if dir > 0 {
                b
            } else if dir < 0 {
                a
            } else {
                near
            };
            continue;
        }
        let Some((a, b)) = atomic_around_in_line(&doc.text, line, pos) else { break };
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

/// Inside a block token or a collapsed link's hidden syntax (never part of a word).
fn in_atomic(doc: &Doc, pos: usize) -> bool {
    doc.line_of(pos).tokens.iter().any(|t| t.from <= pos && pos < t.to) || in_hidden_link(doc, pos)
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
