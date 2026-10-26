//! Our own Parley layout of the rendered lines, mirroring Rune's `TextSystem::layout_rich`
//! (same fonts, version and parameters) so carets, hits and selection rects land on the glyphs
//! Rune paints. Implements editor-core's `Layout` trait.
//!
//! Coordinates are "document space": points, x = 0 at the left edge of the text column (list
//! tokens sit inside it, heading labels hang left of it), y = 0 at the top of the first line.
//!
//! Each source line becomes a `LineGeo` holding one `Piece` per independently laid out run of
//! text (one for normal lines, one per cell for table rows). A piece's display string leaves out
//! hidden segments; `d2r`/`r2d` map between display and raw byte offsets.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::{Arc, OnceLock};

use editor_core::{BlockType, Bounds, CellAlign, InlineType, LineView, Rect, SegKind, SegView, TokenKind};
use parley::editing::{Cursor, Selection};
use parley::fontique::{Blob, Collection, CollectionOptions, SourceCache};
use parley::layout::Affinity;
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, FontStyle, FontWeight, Layout, LayoutContext, LineHeight, StyleProperty,
};
use rune::text::Ink;
use rune::{Color, Family, Span, TextStyle};

use crate::theme::*;

pub struct Fonts {
    pub list: &'static [&'static [u8]],
    pub sans: &'static str,
    pub mono: &'static str,
}

pub static FONTS: OnceLock<Fonts> = OnceLock::new();

thread_local! {
    static SHAPER: RefCell<Option<Shaper>> = const { RefCell::new(None) };
    /// Device scale of the last view (handlers run between views on the same thread).
    pub static SCALE: Cell<f32> = const { Cell::new(2.0) };
    /// Text column width and viewport height of the last view.
    static COL_W: Cell<f32> = const { Cell::new(MAX_TEXT_W) };
    static VIEW_H: Cell<f32> = const { Cell::new(720.0) };
}

/// Called by the view with the window size: the column takes the width left after the margins,
/// up to `MAX_TEXT_W`.
pub fn set_viewport(w: f32, h: f32) {
    COL_W.set((w - PAD_L - PAD_R).clamp(MIN_TEXT_W, MAX_TEXT_W).floor());
    VIEW_H.set(h);
}

/// Width of the text column.
pub fn col_w() -> f32 {
    COL_W.get()
}

/// Width of the drawn surface (gutter, column and right margin).
pub fn surface_w() -> f32 {
    PAD_L + col_w() + PAD_R
}

pub fn view_h() -> f32 {
    VIEW_H.get()
}

// ------------------------------------------------------------------------------------------
// Parley, mirrored from rune::text::TextSystem::layout_rich.

struct Shaper {
    fcx: FontContext,
    lcx: LayoutContext<Ink>,
    cache: HashMap<u64, (Rc<Layout<Ink>>, u32)>,
    generation: u32,
}

impl Shaper {
    fn new() -> Shaper {
        let fonts = FONTS.get().expect("fonts");
        let mut collection = Collection::new(CollectionOptions { shared: false, system_fonts: false });
        for data in fonts.list {
            collection.register_fonts(Blob::new(Arc::new(*data)), None);
        }
        Shaper {
            fcx: FontContext { collection, source_cache: SourceCache::default() },
            lcx: LayoutContext::new(),
            cache: HashMap::new(),
            generation: 0,
        }
    }

    /// `max_w` in points.
    fn layout(&mut self, text: &str, spans: &[Span], style: TextStyle, scale: f32, max_w: Option<f32>) -> Rc<Layout<Ink>> {
        let max_w = max_w.map(|w| w * scale);
        let mut h = DefaultHasher::new();
        text.hash(&mut h);
        for s in spans {
            (s.start, s.end, s.mono, s.italic, s.weight.map(f32::to_bits), s.size.map(f32::to_bits)).hash(&mut h);
        }
        (style.size.to_bits(), style.weight.to_bits(), style.family, style.line_height.to_bits(), style.tracking.to_bits())
            .hash(&mut h);
        (scale.to_bits(), max_w.map(f32::to_bits)).hash(&mut h);
        let key = h.finish();
        let g = self.generation;
        if let Some((l, used)) = self.cache.get_mut(&key) {
            *used = g;
            return l.clone();
        }
        let fonts = FONTS.get().unwrap();
        let family = match style.family {
            Family::Sans => fonts.sans,
            Family::Mono => fonts.mono,
        };
        let mut b = self.lcx.ranged_builder(&mut self.fcx, text, scale, true);
        b.push_default(FontFamily::from(family));
        b.push_default(StyleProperty::FontSize(style.size));
        b.push_default(StyleProperty::FontWeight(FontWeight::new(style.weight)));
        b.push_default(LineHeight::Absolute(style.line_px()));
        if style.tracking != 0.0 {
            b.push_default(StyleProperty::LetterSpacing(style.tracking));
        }
        for (i, s) in spans.iter().enumerate() {
            let r = (s.start as usize).min(text.len())..(s.end as usize).min(text.len());
            if r.is_empty() {
                continue;
            }
            b.push(StyleProperty::Brush(Ink(i as u16 + 1)), r.clone());
            if s.mono {
                b.push(FontFamily::from(fonts.mono), r.clone());
            }
            if s.italic {
                b.push(StyleProperty::FontStyle(FontStyle::Italic), r.clone());
            }
            if let Some(w) = s.weight {
                b.push(StyleProperty::FontWeight(FontWeight::new(w)), r.clone());
            }
            if let Some(sz) = s.size {
                b.push(StyleProperty::FontSize(sz), r.clone());
            }
        }
        let mut layout: Layout<Ink> = b.build(text);
        layout.break_all_lines(max_w);
        layout.align(Alignment::Start, AlignmentOptions::default());
        let l = Rc::new(layout);
        self.cache.insert(key, (l.clone(), g));
        l
    }

    fn next_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        let g = self.generation;
        self.cache.retain(|_, (_, used)| g.wrapping_sub(*used) < 8);
    }
}

// ------------------------------------------------------------------------------------------
// Pieces

pub struct Piece {
    pub x: f32,
    pub y: f32,
    /// Wrap width (also the Rune element's width).
    pub w: f32,
    pub text: String,
    pub spans: Vec<Span>,
    pub style: TextStyle,
    pub color: Color,
    pub from: usize,
    pub to: usize,
    pub cell: Option<usize>,
    d2r: Vec<usize>,
    r2d: Vec<usize>,
    pub layout: Rc<Layout<Ink>>,
    pub h: f32,
    /// Unwrapped content width.
    pub natural_w: f32,
    /// Display ranges drawn with a strikethrough rule.
    pub strikes: Vec<(usize, usize)>,
    scale: f32,
}

impl Piece {
    fn disp(&self, pos: usize) -> usize {
        self.r2d[pos.clamp(self.from, self.to) - self.from]
    }

    /// Caret (x, top, bottom) at raw `pos`.
    pub fn caret(&self, pos: usize) -> (f32, f32, f32) {
        self.caret_display(self.disp(pos))
    }

    /// Caret (x, top, bottom) at display offset `di`.
    fn caret_display(&self, di: usize) -> (f32, f32, f32) {
        let s = self.scale;
        let bb = Cursor::from_byte_index(&self.layout, di, Affinity::Downstream).geometry(&self.layout, 2.0 * s);
        let x = self.x + bb.x0 as f32 / s;
        let mut top = bb.y0 as f32 / s;
        let mut h = (bb.y1 - bb.y0) as f32 / s;
        if h < 2.0 {
            top = 0.0;
            h = self.style.line_px();
        }
        (x, self.y + top, self.y + top + h)
    }

    /// Raw offset under a point (clamped into the piece's box).
    pub fn hit(&self, x: f32, y: f32) -> usize {
        let s = self.scale;
        let ly = (y - self.y).clamp(0.0, (self.h - 0.5).max(0.0));
        let cur = Cursor::from_point(&self.layout, (x - self.x) * s, ly * s);
        self.d2r[cur.index().min(self.text.len())]
    }

    /// Selection rects [x, y, w, h] for raw range a..b.
    pub fn rects(&self, a: usize, b: usize) -> Vec<[f32; 4]> {
        self.display_rects(self.disp(a), self.disp(b))
    }

    pub fn display_rects(&self, da: usize, db: usize) -> Vec<[f32; 4]> {
        if da >= db {
            return Vec::new();
        }
        let s = self.scale;
        let sel = Selection::new(
            Cursor::from_byte_index(&self.layout, da, Affinity::Downstream),
            Cursor::from_byte_index(&self.layout, db, Affinity::Upstream),
        );
        sel.geometry(&self.layout)
            .into_iter()
            .map(|(bb, _)| {
                [
                    self.x + bb.x0 as f32 / s,
                    self.y + bb.y0 as f32 / s,
                    (bb.x1 - bb.x0) as f32 / s,
                    (bb.y1 - bb.y0) as f32 / s,
                ]
            })
            .collect()
    }

    /// Visual lines as (top, bottom) in document space.
    pub fn vlines(&self) -> Vec<(f32, f32)> {
        let s = self.scale;
        self.layout
            .lines()
            .map(|l| {
                let m = l.metrics();
                (self.y + m.block_min_coord / s, self.y + m.block_max_coord / s)
            })
            .collect()
    }
}

fn seg_span(seg: &SegView, ds: usize, de: usize, base: TextStyle, strikes: &mut Vec<(usize, usize)>) -> Option<Span> {
    let mut sp = Span::new(ds, de);
    let mut any = false;
    for st in &seg.styles {
        any = true;
        match st {
            InlineType::Bold => sp.weight = Some(if base.weight >= BOLD { base.weight } else { BOLD }),
            InlineType::Italic => sp.italic = true,
            InlineType::Strike => {
                if seg.kind == SegKind::Text {
                    strikes.push((ds, de));
                }
            }
            InlineType::Underline => sp.underline = Some(c(INK)),
            InlineType::Highlight => {
                sp.bg = Some(highlight());
                sp.bg_pad = 1.0;
            }
            InlineType::Code => {
                sp.mono = true;
                sp.size = Some((base.size * 0.88 * 2.0).round() / 2.0);
                sp.bg = Some(c(CODE_BG));
                sp.bg_pad = 3.0;
            }
            InlineType::Link => {
                sp.color = Some(c(LINK));
                sp.underline = Some(c(LINK).alpha(0.55));
            }
            InlineType::Tag => {
                sp.color = Some(c(INK_LIGHT));
                sp.bg = Some(c(BG2));
                sp.bg_pad = 3.0;
                sp.weight = Some(500.0);
            }
        }
    }
    match seg.kind {
        SegKind::Marker | SegKind::Fence | SegKind::Pipe | SegKind::Pad | SegKind::Delim => {
            sp.color = Some(c(MARKER));
            sp.underline = None;
            any = true;
        }
        SegKind::Chip => {
            sp.color = Some(c(INK_LIGHT));
            sp.size = Some(base.size * 0.85);
            sp.underline = None;
            any = true;
        }
        _ => {}
    }
    any.then_some(sp)
}

struct PieceSpec<'a> {
    segs: Vec<&'a SegView>,
    from: usize,
    to: usize,
    style: TextStyle,
    color: Color,
    cell: Option<usize>,
}

fn make_piece(sh: &mut Shaper, src: &str, p: PieceSpec, x: f32, y: f32, w: Option<f32>, scale: f32) -> Piece {
    let PieceSpec { segs, from, to, style, color, cell } = p;
    let mut text = String::with_capacity(to - from);
    let mut spans = Vec::new();
    let mut strikes = Vec::new();
    let mut d2r = Vec::with_capacity(to - from + 1);
    let mut r2d = vec![0; to - from + 1];
    let mut raw = from;
    for seg in segs {
        let (sf, st) = (seg.from.clamp(from, to), seg.to.clamp(from, to));
        if st < raw || sf >= st && seg.kind != SegKind::Chip {
            continue;
        }
        while raw < sf {
            r2d[raw - from] = text.len();
            raw += 1;
        }
        let ds = text.len();
        let visible = !seg.hidden && seg.kind != SegKind::Token;
        if !visible {
            for r in sf..st {
                r2d[r - from] = ds;
            }
            raw = st;
            continue;
        }
        if seg.kind == SegKind::Chip {
            text.push('↗');
            for r in sf..st {
                r2d[r - from] = ds;
            }
            for _ in ds..text.len() {
                d2r.push(sf);
            }
        } else {
            // Tabs have no glyph: draw each as four spaces (all four map to the tab's start).
            for (k, ch) in src[sf..st].char_indices() {
                let r = sf + k;
                r2d[r - from] = text.len();
                let before = text.len();
                if ch == '\t' {
                    text.push_str("    ");
                } else {
                    text.push(ch);
                }
                for _ in before..text.len() {
                    d2r.push(r);
                }
                for j in 1..ch.len_utf8() {
                    r2d[r - from + j] = before + j;
                }
            }
        }
        if let Some(sp) = seg_span(seg, ds, text.len(), style, &mut strikes) {
            spans.push(sp);
        }
        raw = st;
    }
    while raw < to {
        r2d[raw - from] = text.len();
        raw += 1;
    }
    r2d[to - from] = text.len();
    d2r.push(to);
    let layout = sh.layout(&text, &spans, style, scale, w);
    // rune::text::layout_height, back in points.
    let h = layout.height().max(style.line_px() * scale).ceil() / scale;
    let natural_w = if w.is_none() { layout.full_width().ceil() / scale } else { 0.0 };
    Piece {
        x,
        y,
        w: w.unwrap_or(natural_w + 1.0),
        text,
        spans,
        style,
        color,
        from,
        to,
        cell,
        d2r,
        r2d,
        layout,
        h,
        natural_w,
        strikes,
        scale,
    }
}

// ------------------------------------------------------------------------------------------
// Lines

pub struct Tok {
    pub from: usize,
    pub to: usize,
    pub x0: f32,
    pub x1: f32,
    pub kind: TokenKind,
    /// Raw token text, trimmed ("1.", "-", "- [ ]").
    pub text: String,
}

pub struct LineGeo {
    pub view: LineView,
    pub top: f32,
    pub h: f32,
    pub pieces: Vec<Piece>,
    pub toks: Vec<Tok>,
    /// Table rows: column x ranges (including the cell padding).
    pub cols: Vec<(f32, f32)>,
}

impl LineGeo {
    pub fn drawn(&self) -> bool {
        !self.view.collapsed && self.h > 0.0
    }

    /// Top and bottom of the first visual line of text.
    pub fn first_vline(&self) -> (f32, f32) {
        match self.pieces.first() {
            Some(p) => (p.y, p.y + p.style.line_px()),
            None => (self.top, self.top + self.h),
        }
    }
}

pub struct Geo {
    pub lines: Vec<LineGeo>,
    pub height: f32,
}

fn is_table(v: &LineView) -> bool {
    matches!(v.kind, BlockType::TableHead | BlockType::TableDelim | BlockType::TableRow)
}

pub fn build(src: &str, views: &[LineView]) -> Geo {
    let scale = SCALE.get();
    SHAPER.with(|cell| {
        let mut guard = cell.borrow_mut();
        let sh = guard.get_or_insert_with(Shaper::new);
        sh.next_generation();
        let mut lines = Vec::with_capacity(views.len());
        let mut y = 0.0;
        let mut i = 0;
        while i < views.len() {
            if is_table(&views[i]) {
                let mut j = i;
                while j < views.len() && is_table(&views[j]) {
                    j += 1;
                }
                build_table(sh, src, &views[i..j], &mut y, scale, &mut lines);
                i = j;
            } else {
                let l = build_line(sh, src, &views[i], y, scale);
                y += l.h;
                lines.push(l);
                i += 1;
            }
        }
        Geo { lines, height: y }
    })
}

fn build_line(sh: &mut Shaper, src: &str, v: &LineView, top: f32, scale: f32) -> LineGeo {
    let mut toks = Vec::new();
    let mut x = 0.0;
    for s in v.segments.iter().filter(|s| s.kind == SegKind::Token) {
        let kind = s.token.unwrap_or(TokenKind::Indent);
        let w = match kind {
            TokenKind::Heading => 0.0,
            TokenKind::Hr => col_w() - 2.0,
            _ => GUTTER,
        };
        toks.push(Tok { from: s.from, to: s.to, x0: x, x1: x + w, kind, text: src[s.from..s.to].trim().to_string() });
        x += w;
    }
    let in_code = v.code.is_some();
    let (style, pad_t, pad_b) = if in_code {
        (code_block(), 0.0, 0.0)
    } else if v.kind == BlockType::Heading {
        heading(v.level)
    } else {
        (body(), 0.0, 0.0)
    };
    let left = if in_code {
        CODE_PAD
    } else if v.kind == BlockType::Hr {
        0.0
    } else {
        x
    };
    let color = match v.kind {
        BlockType::Todo if v.checked => c(MARKER),
        BlockType::Quote => c(INK_LIGHT),
        BlockType::Fence => c(MARKER),
        _ => c(INK),
    };
    let segs: Vec<&SegView> = v.segments.iter().filter(|s| s.kind != SegKind::Token).collect();
    let from = segs.first().map_or(v.text_from, |s| s.from.min(v.text_from)).clamp(v.from, v.to);
    let w = col_w() - left - if in_code { CODE_PAD } else { 0.0 };
    let spec = PieceSpec { segs, from, to: v.to, style, color, cell: None };
    let piece = make_piece(sh, src, spec, left, top + pad_t, Some(w), scale);
    let h = if v.collapsed {
        if v.kind == BlockType::Fence { 8.0 } else { 0.0 }
    } else if v.kind == BlockType::Hr {
        24.0
    } else {
        pad_t + piece.h + pad_b
    };
    LineGeo { view: v.clone(), top, h, pieces: vec![piece], toks, cols: Vec::new() }
}

fn build_table(sh: &mut Shaper, src: &str, views: &[LineView], y: &mut f32, scale: f32, out: &mut Vec<LineGeo>) {
    let ncols = views.iter().filter_map(|v| v.table.as_ref().map(|t| t.columns.max(t.cells))).max().unwrap_or(1).max(1);
    let style_of = |v: &LineView| match v.kind {
        BlockType::TableHead => TextStyle::new(BODY_SIZE, 600.0).lh(26.0),
        BlockType::TableDelim => TextStyle::new(13.5, 400.0).lh(26.0).mono(),
        _ => body(),
    };
    // Segments per cell, per row.
    let rows: Vec<Vec<Vec<&SegView>>> = views
        .iter()
        .map(|v| {
            let mut cells: Vec<Vec<&SegView>> = vec![Vec::new(); ncols];
            let mut last = 0;
            for s in v.segments.iter().filter(|s| s.kind != SegKind::Token) {
                let c = s.cell.unwrap_or(last).min(ncols - 1);
                last = c;
                cells[c].push(s);
            }
            cells
        })
        .collect();
    let span = |segs: &[&SegView]| -> Option<(usize, usize)> {
        Some((segs.iter().map(|s| s.from).min()?, segs.iter().map(|s| s.to).max()?))
    };
    // Natural column widths.
    let mut nat = vec![0.0f32; ncols];
    for (v, cells) in views.iter().zip(&rows) {
        if v.collapsed {
            continue;
        }
        for (ci, segs) in cells.iter().enumerate() {
            let Some((from, to)) = span(segs) else { continue };
            let p = make_piece(
                sh,
                src,
                PieceSpec { segs: segs.clone(), from, to, style: style_of(v), color: c(INK), cell: Some(ci) },
                0.0,
                0.0,
                None,
                scale,
            );
            nat[ci] = nat[ci].max(p.natural_w);
        }
    }
    let gaps = CELL_PAD_R * (ncols - 1) as f32;
    let avail = col_w() - gaps;
    let sum: f32 = nat.iter().sum();
    let widths: Vec<f32> =
        nat.iter().map(|&n| if sum <= avail { n.max(24.0) } else { (n * avail / sum).max(24.0) }).collect();
    let mut cols = Vec::with_capacity(ncols);
    let mut x = 0.0;
    for w in &widths {
        cols.push((x, x + w + CELL_PAD_R));
        x += w + CELL_PAD_R;
    }
    for (v, cells) in views.iter().zip(&rows) {
        let top = *y;
        let mut pieces = Vec::new();
        for (ci, segs) in cells.iter().enumerate() {
            let Some((from, to)) = span(segs) else { continue };
            let style = style_of(v);
            let mk = |sh: &mut Shaper, w| {
                make_piece(
                    sh,
                    src,
                    PieceSpec { segs: segs.clone(), from, to, style, color: c(INK), cell: Some(ci) },
                    cols[ci].0,
                    top + CELL_PAD_Y,
                    w,
                    scale,
                )
            };
            let natural = mk(sh, None).natural_w;
            let mut p = mk(sh, Some(widths[ci]));
            if !v.revealed {
                let slack = (widths[ci] - natural).max(0.0);
                match v.table.as_ref().and_then(|t| t.align.get(ci).copied().flatten()) {
                    Some(CellAlign::Right) => p.x += slack,
                    Some(CellAlign::Center) => p.x += (slack / 2.0).round(),
                    _ => {}
                }
            }
            pieces.push(p);
        }
        let h = if v.collapsed { 0.0 } else { pieces.iter().map(|p| p.h).fold(26.0, f32::max) + 2.0 * CELL_PAD_Y };
        *y += h;
        out.push(LineGeo { view: v.clone(), top, h, pieces, toks: Vec::new(), cols: cols.clone() });
    }
}

// ------------------------------------------------------------------------------------------
// Queries

impl Geo {
    pub fn line_at_pos(&self, pos: usize) -> usize {
        self.lines.partition_point(|l| l.view.from <= pos).saturating_sub(1)
    }

    pub fn line_at_y(&self, y: f32) -> usize {
        self.lines.partition_point(|l| l.top <= y).saturating_sub(1)
    }

    /// Caret (x, top, bottom) for raw `pos`.
    pub fn caret(&self, pos: usize) -> (f32, f32, f32) {
        let Some(l) = self.lines.get(self.line_at_pos(pos)) else { return (0.0, 0.0, body().line_px()) };
        if l.view.kind == BlockType::Hr
            && let Some(t) = l.toks.last()
        {
            let mid = l.top + l.h / 2.0;
            return (if pos >= t.to { t.x1 } else { t.x0 }, mid - 11.0, mid + 11.0);
        }
        let Some(p0) = l.pieces.first() else { return (0.0, l.top, l.top + l.h.max(1.0)) };
        if pos < p0.from {
            let (top, bottom) = l.first_vline();
            let x = l.toks.iter().find_map(|t| (t.from == pos).then_some(t.x0)).or_else(|| l.toks.iter().find_map(|t| (t.to == pos).then_some(t.x1)));
            return (x.unwrap_or(0.0), top, bottom);
        }
        let p = l.pieces.iter().rev().find(|p| p.from <= pos).unwrap_or(p0);
        p.caret(pos)
    }

    pub fn hit(&self, x: f32, y: f32) -> usize {
        let Some(l) = self.lines.get(self.line_at_y(y)) else { return 0 };
        if l.view.kind == BlockType::Hr {
            return l.view.to;
        }
        if !l.cols.is_empty() {
            let c = l.cols.iter().position(|c| x < c.1).unwrap_or(l.cols.len() - 1);
            let p = l
                .pieces
                .iter()
                .find(|p| p.cell == Some(c))
                .or_else(|| l.pieces.iter().rfind(|p| p.cell.is_some_and(|pc| pc <= c)))
                .or(l.pieces.first());
            return p.map_or(l.view.to, |p| p.hit(x, y));
        }
        let Some(p) = l.pieces.first() else { return l.view.to };
        if x < p.x {
            for t in l.toks.iter().filter(|t| t.x1 > t.x0) {
                if x < t.x1 {
                    return if x < (t.x0 + t.x1) / 2.0 { t.from } else { t.to };
                }
            }
        }
        p.hit(x, y)
    }

    /// Selection rects [x, y, w, h] for the raw range a..b.
    pub fn sel_rects(&self, a: usize, b: usize) -> Vec<[f32; 4]> {
        let mut out = Vec::new();
        if a >= b {
            return out;
        }
        let first = self.line_at_pos(a);
        for l in &self.lines[first..] {
            if l.view.from > b {
                break;
            }
            if !l.drawn() {
                continue;
            }
            let (top, bottom) = l.first_vline();
            for t in l.toks.iter().filter(|t| t.x1 > t.x0) {
                if a <= t.from && t.to <= b {
                    out.push([t.x0, top, t.x1 - t.x0, bottom - top]);
                }
            }
            for p in &l.pieces {
                let (ra, rb) = (a.max(p.from), b.min(p.to));
                if ra < rb {
                    out.extend(p.rects(ra, rb));
                }
            }
            if b > l.view.to && a <= l.view.to {
                let (x, t, bt) = self.caret(l.view.to);
                out.push([x, t, 6.0, bt - t]);
            }
        }
        out
    }

    /// Splice IME marked text into the piece holding raw `pos`, underlined, for drawing only
    /// (handlers measure the document without it). `cursor` is the IME caret, a byte offset in
    /// `marked`. Returns the caret (x, top, bottom) inside the marked text, or None when `pos`
    /// isn't in a text piece. Lines below don't move if the marked text adds a wrapped line.
    pub fn splice_marked(&mut self, pos: usize, marked: &str, cursor: usize) -> Option<(f32, f32, f32)> {
        let li = self.line_at_pos(pos);
        let l = self.lines.get_mut(li)?;
        let p = l.pieces.iter_mut().rev().find(|p| p.from <= pos && pos <= p.to)?;
        let di = p.disp(pos);
        let n = marked.len();
        p.text.insert_str(di, marked);
        // Ranges after the caret move right; ranges around it grow over the marked text.
        let shift = |a: &mut usize, b: &mut usize| {
            if *a >= di {
                *a += n;
                *b += n;
            } else if *b > di {
                *b += n;
            }
        };
        for sp in &mut p.spans {
            let (mut a, mut b) = (sp.start as usize, sp.end as usize);
            shift(&mut a, &mut b);
            (sp.start, sp.end) = (a as u32, b as u32);
        }
        for st in &mut p.strikes {
            shift(&mut st.0, &mut st.1);
        }
        p.spans.push(Span { underline: Some(c(INK)), ..Span::new(di, di + n) });
        let scale = p.scale;
        p.layout = SHAPER.with(|cell| {
            let mut guard = cell.borrow_mut();
            let sh = guard.get_or_insert_with(Shaper::new);
            sh.layout(&p.text, &p.spans, p.style, scale, Some(p.w))
        });
        p.h = p.layout.height().max(p.style.line_px() * scale).ceil() / scale;
        Some(p.caret_display(di + cursor.min(n)))
    }
}

impl editor_core::Layout for Geo {
    fn caret_rect(&self, pos: usize) -> Rect {
        let (x, t, b) = self.caret(pos);
        Rect { left: x as f64, top: t as f64, bottom: b as f64 }
    }

    fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
        if self.lines.is_empty() || y < 0.0 || y >= self.height as f64 {
            return None;
        }
        Some(self.hit(x as f32, y as f32))
    }

    fn bounds(&self) -> Bounds {
        Bounds { left: 0.0, top: 0.0, right: col_w() as f64, bottom: self.height as f64 }
    }

    fn table_cell_at(&self, line: usize, x: f64, _y: f64) -> Option<usize> {
        let l = self.lines.get(line)?;
        if l.cols.is_empty() {
            return None;
        }
        Some(l.cols.iter().position(|c| (x as f32) < c.1).unwrap_or(l.cols.len() - 1))
    }

    fn line_mid_y(&self, line: usize) -> Option<f64> {
        self.lines.get(line).map(|l| (l.top + l.h / 2.0) as f64)
    }
}
