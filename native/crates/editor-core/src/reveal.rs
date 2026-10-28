//! Reveal engine: which markers are shown for the local selection. Pure.
//! An inline element reveals when the caret is in [from, to] (inclusive) or it strictly overlaps the
//! selection, together with every element nested inside it. Links are the exception: only the
//! expanded one (`Doc::expanded_link`, the pencil) reveals, never by the selection alone. Code
//! fences reveal when the selection touches the block, and a table's pipes, cell padding and
//! delimiter row when it touches the table.

use std::collections::BTreeMap;

use crate::parser::{Doc, InlineType, line_at};
use crate::units::{Sel, is_collapsed_link};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LineReveal {
    /// Indices into `line.inline` of revealed elements.
    pub els: Vec<usize>,
    /// Code block fences / table syntax of this line are revealed.
    pub fence: bool,
    /// The line holds the selection head.
    pub active: bool,
}

/// Reveal state per line index; lines without an entry are fully collapsed.
pub type RevealMap = BTreeMap<usize, LineReveal>;

pub fn compute_reveal(doc: &Doc, sel: Option<Sel>) -> RevealMap {
    let mut out = RevealMap::new();
    let Some(sel) = sel else { return out };
    let a = sel.from();
    let b = sel.to();
    let l0 = line_at(&doc.lines, a);
    let l1 = line_at(&doc.lines, b);
    out.entry(line_at(&doc.lines, sel.head)).or_default().active = true;
    // elements are identified by (type, from, to): lines of one paragraph hold copies
    let mut hits: Vec<(InlineType, usize, usize)> = Vec::new();
    let mut lo = l0;
    let mut hi = l1;
    for line in &doc.lines[l0..=l1] {
        if let Some(bs) = line.block_start {
            out.entry(bs).or_default().fence = true;
            if let Some(be) = line.block_end
                && doc.lines[be].ty == crate::parser::BlockType::Fence
            {
                out.entry(be).or_default().fence = true;
            }
            continue;
        }
        if let Some(tb) = &line.table {
            for k in tb.start..=tb.end {
                out.entry(k).or_default().fence = true;
            }
        }
        for el in &line.inline {
            if is_collapsed_link(doc, el) {
                continue;
            }
            let hit = if a == b { el.from <= a && a <= el.to } else { el.from < b && el.to > a };
            if hit {
                let key = (el.ty, el.from, el.to);
                if !hits.contains(&key) {
                    hits.push(key);
                }
                // elements can span the lines of a paragraph
                lo = lo.min(line_at(&doc.lines, el.from));
                hi = hi.max(line_at(&doc.lines, el.to));
            }
        }
    }
    if hits.is_empty() {
        return out;
    }
    for i in lo..=hi {
        let line = &doc.lines[i];
        let els: Vec<usize> = line
            .inline
            .iter()
            .enumerate()
            .filter(|(_, el)| {
                // revealed: hit elements and everything nested inside them (but collapsed links)
                !is_collapsed_link(doc, el)
                    && hits.iter().any(|&(ty, f, t)| (ty, f, t) == (el.ty, el.from, el.to) || (el.from >= f && el.to <= t))
            })
            .map(|(k, _)| k)
            .collect();
        if !els.is_empty() {
            out.entry(i).or_default().els = els;
        }
    }
    out
}
