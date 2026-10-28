//! Render plan: per line, the block info and a list of segments with raw ranges, styles and
//! whether they are currently hidden (collapsed). This is what the UI draws.

use std::collections::BTreeSet;

use crate::parser::{BlockType, CellAlign, Doc, InlineType, Line, TokenKind, trim_range};
use crate::reveal::{LineReveal, RevealMap};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SegKind {
    /// Block prefix token (atomic, drawn as a gutter glyph; holds no visible raw text).
    Token,
    /// Visible text.
    Text,
    /// An inline marker (`**`, `[`, `](`, …): hidden unless its element is revealed.
    Marker,
    /// An escape backslash: always hidden.
    Escape,
    /// A link URL: plain text (not atomic) carrying its link's `el`, hidden while the link is
    /// collapsed (the UI draws its pencil there) and drawn as text when it's revealed.
    Chip,
    /// A code fence line's text (``` and info string): hidden unless the block is revealed.
    Fence,
    /// Table pipe / cell padding / delimiter-row cell: hidden unless the table is revealed.
    Pipe,
    Pad,
    Delim,
}

/// A segment of a line's render plan (absolute raw range).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seg {
    pub kind: SegKind,
    pub from: usize,
    pub to: usize,
    /// Inline styles applying to the segment, outermost first.
    pub styles: Vec<InlineType>,
    /// For markers: index (into `line.inline`) of the element the marker belongs to.
    pub el: Option<usize>,
    pub token: Option<TokenKind>,
    /// Table lines: the cell this segment is drawn in.
    pub cell: Option<usize>,
}

impl Seg {
    fn new(kind: SegKind, from: usize, to: usize) -> Seg {
        Seg { kind, from, to, styles: vec![], el: None, token: None, cell: None }
    }
}

/// Pure render plan for a line.
pub fn line_segments(line: &Line, text: &str) -> Vec<Seg> {
    let mut segs: Vec<Seg> = line
        .tokens
        .iter()
        .map(|t| Seg { token: Some(t.kind), ..Seg::new(SegKind::Token, t.from, t.to) })
        .collect();
    match line.ty {
        BlockType::Code => {
            if line.to > line.from {
                segs.push(Seg::new(SegKind::Text, line.from, line.to));
            }
            return segs;
        }
        BlockType::Fence => {
            if line.to > line.from {
                segs.push(Seg::new(SegKind::Fence, line.from, line.to));
            }
            return segs;
        }
        BlockType::Hr => return segs,
        _ => {}
    }
    if line.table.is_some() {
        return table_segments(line, text);
    }
    inline_segments(line, line.text_from, line.to, &mut segs, None);
    segs
}

/// Inline segments of [a, b) (text, markers, escapes, link chips).
fn inline_segments(line: &Line, a: usize, b: usize, segs: &mut Vec<Seg>, cell: Option<usize>) {
    if a >= b {
        return;
    }
    let mut cuts = BTreeSet::from([a, b]);
    for el in &line.inline {
        cuts.insert(el.from);
        cuts.insert(el.to);
        for &(m0, m1) in &el.markers {
            cuts.insert(m0);
            cuts.insert(m1);
        }
        if let Some((u0, u1)) = el.url {
            cuts.insert(u0);
            cuts.insert(u1);
        }
    }
    for &e in &line.escapes {
        cuts.insert(e);
        cuts.insert(e + 1);
    }
    let points: Vec<usize> = cuts.into_iter().filter(|&p| p >= a && p <= b).collect();
    for w in points.windows(2) {
        let (f, t) = (w[0], w[1]);
        let mut styles = Vec::new();
        let mut kind = SegKind::Text;
        let mut el_idx = None;
        for (k, e) in line.inline.iter().enumerate() {
            if e.from <= f && t <= e.to {
                styles.push(e.ty);
                if e.markers.iter().any(|&(m0, m1)| m0 <= f && t <= m1) {
                    kind = SegKind::Marker;
                    el_idx = Some(k);
                }
                if e.url.is_some_and(|(u0, u1)| u0 <= f && t <= u1) {
                    kind = SegKind::Chip;
                }
            }
        }
        if line.escapes.contains(&f) && t == f + 1 {
            kind = SegKind::Escape;
        }
        if kind == SegKind::Chip
            && let Some(prev) = segs.last_mut()
            && prev.kind == SegKind::Chip
            && prev.to == f
        {
            prev.to = t;
            continue;
        }
        segs.push(Seg { kind, from: f, to: t, styles, el: el_idx, token: None, cell });
    }
}

/// A table row: every cell gets the pipe before it, its padding and its inline content; spaces
/// before a leading pipe go to the first cell and a trailing pipe (and what follows) to the last.
fn table_segments(line: &Line, text: &str) -> Vec<Seg> {
    let tb = line.table.as_ref().unwrap();
    let mut segs = Vec::new();
    let raw = |segs: &mut Vec<Seg>, from: usize, to: usize, cell: usize| {
        let mut p = from;
        while p < to {
            if tb.pipes.contains(&p) {
                segs.push(Seg { cell: Some(cell), ..Seg::new(SegKind::Pipe, p, p + 1) });
                p += 1;
                continue;
            }
            let mut q = p;
            while q < to && !tb.pipes.contains(&q) {
                q += 1;
            }
            segs.push(Seg { cell: Some(cell), ..Seg::new(SegKind::Pad, p, q) });
            p = q;
        }
    };
    let mut pos = line.from;
    let last = tb.cells.len() - 1;
    for (c, &(cf, ct)) in tb.cells.iter().enumerate() {
        raw(&mut segs, pos, cf, c);
        if line.ty == BlockType::TableDelim {
            if ct > cf {
                segs.push(Seg { cell: Some(c), ..Seg::new(SegKind::Delim, cf, ct) });
            }
        } else {
            let (a, b) = trim_range(text, cf, ct);
            if a > cf {
                segs.push(Seg { cell: Some(c), ..Seg::new(SegKind::Pad, cf, a) });
            }
            inline_segments(line, a, b, &mut segs, Some(c));
            if ct > b {
                segs.push(Seg { cell: Some(c), ..Seg::new(SegKind::Pad, b, ct) });
            }
        }
        pos = ct;
    }
    raw(&mut segs, pos, line.to, last);
    segs
}

// -----------------------------------------------------------------------------------------------
// Line views

/// A segment with its current visibility.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegView {
    pub kind: SegKind,
    pub from: usize,
    pub to: usize,
    pub styles: Vec<InlineType>,
    /// Collapsed: draw at zero width (the raw text still exists and the caret never sits inside).
    /// A hidden `Text` segment is the whitespace starting a row after an image block
    /// (`LineView::parts`): drawn at zero width too, but its positions are caret stops.
    pub hidden: bool,
    pub token: Option<TokenKind>,
    pub cell: Option<usize>,
    /// For markers: the element index (into the line's inline elements).
    pub el: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableView {
    pub align: Vec<Option<CellAlign>>,
    /// Number of cells in this row (rows can have fewer cells than columns: draw placeholders).
    pub cells: usize,
    pub columns: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeView {
    /// First / last line of the code block (the fences when present).
    pub first: bool,
    pub last: bool,
}

/// An image on a line (`![alt](src "title")`), drawn below the line's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageView {
    /// The whole source (absolute raw range): a click on the image puts the caret at `to`.
    pub from: usize,
    pub to: usize,
    /// The alt text's raw range (a marker range: drawn as text, not dimmed, when revealed).
    pub alt_range: (usize, usize),
    pub alt: String,
    /// The source as written (not decoded or resolved).
    pub src: String,
    pub title: Option<String>,
    /// Its source is shown (the caret or selection touches it).
    pub revealed: bool,
}

/// A piece of a line with images, in order: the line is drawn as its parts top to bottom, text
/// parts wrapping in the column and each image block on its own row(s) where it is in the text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinePart {
    /// Raw `from..to` drawn as one wrapping block of text (the first starts at the line's start,
    /// tokens included; one ends where an image block follows, after the images' sources). Not
    /// `shown`: nothing visible in it (only collapsed sources and whitespace), so it takes no row;
    /// its positions sit at the end of the shown text part before it, else the start of the one
    /// after.
    Text { from: usize, to: usize, shown: bool },
    /// `LineView::images[first..end]` as one block (left to right, wrapping), right after the
    /// text part holding their sources.
    Images { first: usize, end: usize },
}

/// Everything the UI needs to draw one source line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineView {
    pub index: usize,
    pub from: usize,
    pub to: usize,
    pub text_from: usize,
    pub kind: BlockType,
    pub level: u8,
    pub checked: bool,
    pub number: u32,
    pub indent: usize,
    /// Content indentation in gutter widths (indent levels, plus one for a list/quote token).
    pub gutter_levels: usize,
    /// The line holds the selection head (heading tokens show their "H1" label only then).
    pub active: bool,
    /// Code fences / table syntax of this line are revealed.
    pub revealed: bool,
    /// A line drawn collapsed (a code fence or a table delimiter row that isn't revealed).
    pub collapsed: bool,
    pub code: Option<CodeView>,
    pub table: Option<TableView>,
    pub segments: Vec<SegView>,
    /// The line's images, in order.
    pub images: Vec<ImageView>,
    /// A paragraph of nothing but images (optionally inside links): while none of them is
    /// revealed, only the images show (`text_hidden`).
    pub image_only: bool,
    /// A line with images split at them (`LinePart`), empty when the line has none. Images (or
    /// links around just an image) with only whitespace between them form one block; an
    /// image-only line is one text part (shown unless `text_hidden`) and one block. Whitespace
    /// starting a text part after a block is a hidden `Text` segment: real text with caret stops,
    /// drawn at zero width (no indent at the row's start, like whitespace at a soft wrap).
    pub parts: Vec<LinePart>,
    /// A heading with something to fold (set by `Editor::line_view`; false from `line_view`).
    pub foldable: bool,
    /// A folded heading: the lines of its section after it are hidden.
    pub folded: bool,
    /// Hidden inside a folded section: takes no space and holds no caret position.
    pub hidden_by_fold: bool,
}

impl LineView {
    /// The line's text row is collapsed: an image-only line whose images are all collapsed.
    pub fn text_hidden(&self) -> bool {
        self.image_only && !self.images.iter().any(|i| i.revealed)
    }
}

/// A line whose whole text is images (optionally inside links), with nothing else. Every caret
/// position on it touches an image, so it's revealed whenever the caret is on it.
pub fn is_image_line(line: &Line) -> bool {
    if line.ty != BlockType::Paragraph || !line.tokens.is_empty() || line.to <= line.from {
        return false;
    }
    let imgs: Vec<_> = line.inline.iter().filter(|e| e.ty == InlineType::Image).collect();
    if imgs.is_empty() {
        return false;
    }
    let links: Vec<_> = line
        .inline
        .iter()
        .filter(|e| e.ty == InlineType::Link && imgs.iter().any(|m| e.content_from <= m.from && m.to <= e.content_to))
        .collect();
    // every inline element is one of those, on this line (not, say, bold that spans the
    // paragraph's lines)
    if line.inline.iter().any(|e| e.from < line.from || e.to > line.to || (e.ty != InlineType::Image && !links.contains(&e))) {
        return false;
    }
    let mut p = line.from;
    while p < line.to {
        if let Some(img) = imgs.iter().find(|m| m.from == p) {
            p = img.to;
            continue;
        }
        let in_link = links.iter().any(|l| {
            l.markers.iter().any(|&(m0, m1)| m0 <= p && p < m1) || l.url.is_some_and(|(u0, u1)| u0 <= p && p < u1)
        });
        if !in_link {
            return false;
        }
        p += 1;
    }
    true
}

pub fn line_view(doc: &Doc, line: &Line, rv: Option<&LineReveal>) -> LineView {
    let revealed = rv.is_some_and(|r| r.fence);
    let els: &[usize] = rv.map_or(&[], |r| &r.els);
    let mut segments: Vec<SegView> = line_segments(line, &doc.text)
        .into_iter()
        .map(|s| {
            let hidden = match s.kind {
                SegKind::Marker => !s.el.is_some_and(|e| els.contains(&e)),
                SegKind::Escape => true,
                SegKind::Fence | SegKind::Pipe | SegKind::Pad | SegKind::Delim => !revealed,
                SegKind::Token | SegKind::Text | SegKind::Chip => false,
            };
            let mut v = SegView { kind: s.kind, from: s.from, to: s.to, styles: s.styles, hidden, token: s.token, cell: s.cell, el: s.el };
            // a URL carries its link's element and collapses with it
            if v.kind == SegKind::Chip
                && let Some(k) = line.inline.iter().position(|e| e.url.is_some_and(|(u0, u1)| u0 <= v.from && v.to <= u1))
            {
                v.el = Some(k);
                v.hidden = !els.contains(&k);
            }
            v
        })
        .collect();
    let images = line
        .inline
        .iter()
        .enumerate()
        .filter(|(_, e)| e.ty == InlineType::Image && e.from >= line.from && e.to <= line.to)
        .map(|(k, e)| {
            let src = e.src.map_or("", |(a, b)| &doc.text[a..b]);
            ImageView {
                from: e.from,
                to: e.to,
                alt_range: (e.content_from, e.content_to),
                alt: doc.text[e.content_from..e.content_to].to_string(),
                src: src.to_string(),
                title: e.title.clone(),
                revealed: els.contains(&k),
            }
        })
        .collect::<Vec<ImageView>>();
    let image_only = is_image_line(line);
    if image_only && !images.iter().any(|i| i.revealed) {
        // Only the images show: link chips and markers of links around them too (TS
        // `.ln-img:not(.img-rv) { font-size: 0 }`).
        for s in segments.iter_mut().filter(|s| s.kind != SegKind::Token) {
            s.hidden = true;
        }
    }
    let parts = if images.is_empty() {
        Vec::new()
    } else if image_only {
        let shown = images.iter().any(|i| i.revealed);
        vec![LinePart::Text { from: line.from, to: line.to, shown }, LinePart::Images { first: 0, end: images.len() }]
    } else {
        split_parts(&doc.text, line, &images, &mut segments)
    };
    let list_tok = line.tokens.iter().any(|t| !matches!(t.kind, TokenKind::Indent | TokenKind::Heading | TokenKind::Hr));
    LineView {
        index: line.index,
        from: line.from,
        to: line.to,
        text_from: line.text_from,
        kind: line.ty,
        level: line.level,
        checked: line.checked,
        number: line.number,
        indent: line.indent,
        gutter_levels: line.indent + usize::from(list_tok),
        active: rv.is_some_and(|r| r.active),
        revealed,
        collapsed: !revealed && matches!(line.ty, BlockType::Fence | BlockType::TableDelim),
        code: line.block_start.map(|bs| CodeView { first: bs == line.index, last: line.block_end == Some(line.index) }),
        table: line.table.as_ref().map(|t| TableView { align: t.align.clone(), cells: t.cells.len(), columns: t.align.len() }),
        segments,
        images,
        image_only,
        parts,
        foldable: false,
        folded: false,
        hidden_by_fold: false,
    }
}

/// The parts of a mixed line with images (`LineView::parts`); hides the whitespace starting each
/// text part after an image block.
fn split_parts(text: &str, line: &Line, images: &[ImageView], segments: &mut Vec<SegView>) -> Vec<LinePart> {
    // an image's extent: a link around just the image counts as part of it
    let unit = |i: &ImageView| {
        line.inline
            .iter()
            .find(|e| e.ty == InlineType::Link && e.content_from == i.from && e.content_to == i.to && e.from >= line.from && e.to <= line.to)
            .map_or((i.from, i.to), |e| (e.from, e.to))
    };
    let blank = |a: usize, b: usize| a >= b || text[a..b].chars().all(char::is_whitespace);
    // (first, end, raw end) per block
    let mut blocks: Vec<(usize, usize, usize)> = Vec::new();
    for (k, i) in images.iter().enumerate() {
        let (a, b) = unit(i);
        match blocks.last_mut() {
            Some(g) if g.2 <= a && blank(g.2, a) => (g.1, g.2) = (k + 1, b.max(g.2)),
            _ => blocks.push((k, k + 1, b)),
        }
    }
    let mut parts = Vec::new();
    let mut pos = line.from;
    for &(first, end, to) in &blocks {
        parts.push(LinePart::Text { from: pos, to, shown: false });
        parts.push(LinePart::Images { first, end });
        pos = to;
        // whitespace starting the text after the block: hidden
        let ws = pos + text[pos..line.to].len() - text[pos..line.to].trim_start().len();
        if ws > pos {
            hide_range(segments, pos, ws);
        }
    }
    if pos < line.to {
        parts.push(LinePart::Text { from: pos, to: line.to, shown: false });
    }
    let visible = |a: usize, b: usize| {
        segments.iter().any(|s| {
            a <= s.from && s.to <= b && s.to > s.from && !s.hidden && s.kind != SegKind::Token
                && (s.kind == SegKind::Chip || !blank(s.from, s.to))
        })
    };
    let mut any = false;
    for p in &mut parts {
        if let LinePart::Text { from, to, shown } = p {
            *shown = visible(*from, *to);
            any |= *shown;
        }
    }
    // nothing to show anywhere: keep a text row for the caret, the first
    if !any && let Some(LinePart::Text { shown, .. }) = parts.first_mut() {
        *shown = true;
    }
    parts
}

/// Hide the text segments' part inside `a..b` (splitting them at the edges).
fn hide_range(segments: &mut Vec<SegView>, a: usize, b: usize) {
    let mut out = Vec::with_capacity(segments.len() + 2);
    for s in segments.drain(..) {
        if s.kind != SegKind::Text || s.to <= a || s.from >= b {
            out.push(s);
            continue;
        }
        let (h0, h1) = (s.from.max(a), s.to.min(b));
        if s.from < h0 {
            out.push(SegView { to: h0, ..s.clone() });
        }
        out.push(SegView { from: h0, to: h1, hidden: true, ..s.clone() });
        if h1 < s.to {
            out.push(SegView { from: h1, ..s });
        }
    }
    *segments = out;
}

/// Line views without fold state (`Editor::render_lines` adds it).
pub fn render_lines(doc: &Doc, reveal: &RevealMap) -> Vec<LineView> {
    doc.lines.iter().map(|l| line_view(doc, l, reveal.get(&l.index))).collect()
}
