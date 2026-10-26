//! Collapsible heading sections (view state only: the text never changes). A heading's section is
//! the heading line and every line after it up to the next heading of the same or a higher level
//! (or the end of the document); nested headings fold with their parent. A folded heading hides the
//! lines of its section after the heading line; the caret never sits in them.

use crate::parser::{BlockType, Line, line_at};

/// The line is a heading with something to fold (the line after it belongs to its section).
pub const FOLDABLE: u8 = 1;
/// The line is a folded heading.
pub const FOLDED: u8 = 2;
/// The line is hidden by a folded heading above it.
pub const HIDDEN: u8 = 4;

/// The line after heading line `h`'s section (the next heading of the same or a higher level, or
/// the number of lines).
pub fn section_end(lines: &[Line], h: usize) -> usize {
    let level = lines[h].level;
    lines[h + 1..]
        .iter()
        .position(|l| l.ty == BlockType::Heading && l.level <= level)
        .map_or(lines.len(), |k| h + 1 + k)
}

/// Line `h` is a heading whose section holds more than the heading line.
pub fn foldable(lines: &[Line], h: usize) -> bool {
    lines[h].ty == BlockType::Heading
        && lines.get(h + 1).is_some_and(|n| !(n.ty == BlockType::Heading && n.level <= lines[h].level))
}

/// Fold flags of every line, for the folded headings starting at `folds` (sorted line starts).
pub fn flags(lines: &[Line], folds: &[usize]) -> Vec<u8> {
    let mut out = vec![0u8; lines.len()];
    let mut hide_until = 0;
    let mut f = 0;
    for li in 0..lines.len() {
        let mut fl = 0;
        if li < hide_until {
            fl |= HIDDEN;
        }
        if foldable(lines, li) {
            fl |= FOLDABLE;
            while f < folds.len() && folds[f] < lines[li].from {
                f += 1;
            }
            if folds.get(f) == Some(&lines[li].from) {
                fl |= FOLDED;
                if li >= hide_until {
                    hide_until = section_end(lines, li);
                }
            }
        }
        out[li] = fl;
    }
    out
}

/// For a position on a hidden line: the outermost folded heading hiding it and the first line
/// after what it hides. None when `pos` is visible.
pub fn hidden_at(lines: &[Line], flags: &[u8], pos: usize) -> Option<(usize, usize)> {
    let li = line_at(lines, pos);
    if flags.get(li).is_none_or(|f| f & HIDDEN == 0) {
        return None;
    }
    let mut h = li;
    while h > 0 && flags[h] & HIDDEN != 0 {
        h -= 1;
    }
    let mut end = li;
    while end < lines.len() && flags[end] & HIDDEN != 0 {
        end += 1;
    }
    Some((h, end))
}

/// A stable name for a folded heading that survives edits elsewhere: the heading line's text
/// (trailing whitespace trimmed) and how many heading lines with that same text come before it.
pub fn heading_key(lines: &[Line], text: &str, h: usize) -> (String, usize) {
    let key = |l: &Line| l.text(text).trim_end().to_string();
    let k = key(&lines[h]);
    let n = lines[..h].iter().filter(|l| l.ty == BlockType::Heading && key(l) == k).count();
    (k, n)
}
