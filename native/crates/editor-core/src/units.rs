//! Caret units over the raw text: which offsets are caret stops, and stepping by unit or word.
//! Atomic units (one caret step): block prefix tokens, link URL chips, escape pairs (`\*`) and
//! grapheme clusters (the TS treats only surrogate pairs as atomic; see README).

use unicode_segmentation::UnicodeSegmentation;

use crate::parser::{BlockType, Doc, Line};
use crate::text::{char_at, char_before, is_word_char, next_boundary, prev_boundary};

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
        for el in &line.inline {
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
    grapheme_around(text, line.text_from.min(pos), line.to, pos)
}

/// The grapheme cluster of text[from..to] strictly containing `pos`.
fn grapheme_around(text: &str, from: usize, to: usize, pos: usize) -> Option<(usize, usize)> {
    // an ASCII char always starts a cluster (CR LF can't occur inside a line)
    if text.as_bytes().get(pos).is_none_or(|&b| b < 0x80) {
        return None;
    }
    for (off, g) in text[from..to].grapheme_indices(true) {
        let a = from + off;
        let b = a + g.len();
        if a >= pos {
            break;
        }
        if pos < b {
            return Some((a, b));
        }
    }
    None
}

pub fn is_stop(doc: &Doc, pos: usize) -> bool {
    atomic_around(doc, pos).is_none()
}

/// Snap a position to a caret stop: dir > 0 forward, dir < 0 backward, 0 nearest.
pub fn snap(doc: &Doc, pos: usize, dir: i32) -> usize {
    let pos = crate::text::floor_boundary(&doc.text, pos);
    let line = doc.line_of(pos);
    let Some((a, b)) = atomic_around_in_line(&doc.text, line, pos) else { return pos };
    if dir > 0 {
        return b;
    }
    if dir < 0 {
        return a;
    }
    if line.ty == BlockType::Hr {
        return b;
    }
    if pos - a <= b - pos { a } else { b }
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
        || line.inline.iter().any(|el| el.url.is_some_and(|(a, b)| a <= pos && pos < b))
}

/// The char at `i` is a word char outside atomic units.
fn word_at(doc: &Doc, i: usize) -> bool {
    char_at(&doc.text, i).is_some_and(is_word_char) && !in_atomic(doc, i)
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

/// The word char test used by Cmd-B ("inside a word"), on the char before / at `pos`.
pub fn word_char_before(text: &str, pos: usize) -> bool {
    char_before(text, pos).is_some_and(is_word_char)
}

pub fn word_char_at(text: &str, pos: usize) -> bool {
    char_at(text, pos).is_some_and(is_word_char)
}
