//! Geometry of the rendered lines: each piece of text laid out by Rune's own `TextSystem` (built
//! with the app's fonts, as Rune's runtime builds its), so carets, hits and selection rects come
//! from the very layout whose glyphs Rune paints. Implements editor-core's `Layout` trait.
//!
//! Coordinates are "document space": points, x = 0 at the left edge of the text column (list
//! tokens sit inside it, heading labels hang left of it), y = 0 at the top of the first line.
//!
//! Each source line becomes a `LineGeo` holding one `Piece` per independently laid out run of
//! text (one for normal lines, one per cell for table rows). A piece's display string leaves out
//! hidden segments; `map` (editor-core's `DisplayMap`, which resolves hit affinity next to hidden
//! markers) and `r2d` map between display and raw byte offsets.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::OnceLock;

use editor_core::layout::DisplayMap;
use editor_core::reveal::RevealMap;
use crate::rimages::Base;
use editor_core::{BlockType, Bounds, CellAlign, Doc, ImageView, InlineType, LinePart, LineView, Rect, SegKind, SegView, TokenKind};
use parley::Layout;
use parley::editing::{Cursor, Selection};
use parley::layout::Affinity;
use rune::text::{Ink, RichLayoutOptions, TextSystem};
use rune::{Color, Span, TextStyle};

use crate::highlight::LineHl;
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
    /// The editor pane's width (the surface is centred in it).
    static VIEW_W: Cell<f32> = const { Cell::new(0.0) };
}

/// Called by the view with the window size: the column takes the width left after the margins,
/// up to `MAX_TEXT_W`.
pub fn set_viewport(w: f32, h: f32) {
    COL_W.set((w - PAD_L - PAD_R).clamp(MIN_TEXT_W, MAX_TEXT_W).floor());
    VIEW_H.set(h);
    VIEW_W.set(w);
}

/// The editor pane's width (the surface's before the first view).
pub fn pane_w() -> f32 {
    let w = VIEW_W.get();
    if w > 0.0 { w } else { surface_w() }
}

/// A table or a code block: a box of its own that scrolls sideways, as the web's. Narrow, it's the text column;
/// wider content breaks out into the margins on both sides (code up to `CODE_MAX_W`, tables `TABLE_MAX_W`, never
/// past the pane less `WIDE_GAP`), then scrolls inside the box. `x` is the box's left in column coordinates (0
/// or less), `content_w` how wide what's in it is (from `x`).
#[derive(Clone, Debug, PartialEq)]
pub struct Wide {
    pub first: usize,
    pub end: usize,
    pub x: f32,
    pub w: f32,
    pub content_w: f32,
    pub top: f32,
    pub h: f32,
    pub code: bool,
}

/// A block's box for content `content_w` wide, as the web's: the text column when it fits (its left edge on the
/// column's); else up to `max_w` wide and at most twice the distance from the column's centre to the nearer pane
/// edge less `WIDE_GAP` each side, centred on the column.
pub fn wide_box(content_w: f32, max_w: f32) -> (f32, f32) {
    let col = col_w();
    if content_w <= col {
        return (0.0, col);
    }
    let pane = pane_w();
    let centre = (pane - surface_w()) / 2.0 + PAD_L + col / 2.0;
    let room = 2.0 * (centre.min(pane - centre) - WIDE_GAP);
    let w = content_w.min(max_w).min(room).max(col).floor();
    (((col - w) / 2.0).floor(), w)
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

/// A one-line label as Rune lays it out: its width and its first baseline below its box's top (points).
pub fn measure(text: &str, style: TextStyle) -> (f32, f32) {
    let scale = SCALE.get();
    SHAPER.with(|cell| {
        let mut guard = cell.borrow_mut();
        let sh = guard.get_or_insert_with(Shaper::new);
        let l = sh.layout(text, &[], style, scale, None);
        let base = l.lines().next().map_or(style.line_px() * 0.8 * scale, |m| m.metrics().baseline);
        (l.full_width() / scale, base / scale)
    })
}

// ------------------------------------------------------------------------------------------
// Text layout: Rune's own `TextSystem` with the app's fonts, so our layouts are the ones Rune
// paints (same shaping, `trak` tracking, ligature rules and system fallbacks for symbols, emoji and
// CJK) rather than a copy of its code.

pub struct Shaper {
    text: TextSystem,
}

impl Shaper {
    fn new() -> Shaper {
        let fonts = FONTS.get().expect("fonts");
        Shaper { text: TextSystem::new(fonts.list, (fonts.sans, fonts.mono)) }
    }

    /// `max_w` in points (a `rich()` element's width: Rune wraps it at that many device px).
    fn layout(&mut self, text: &str, spans: &[Span], style: TextStyle, scale: f32, max_w: Option<f32>) -> Rc<Layout<Ink>> {
        // a word longer than the width breaks anywhere (the web's `overflow-wrap: anywhere`); one layout for drawing,
        // carets, hits and selection. Code lines have no width: they never wrap.
        self.text.layout_rich_with(text, spans, style, scale, max_w.map(|w| w * scale), RichLayoutOptions::new().wrap_anywhere())
    }

    /// This thread's layouts use `list` and `families` from now on (the verification test: the app's own
    /// fonts, while other tests keep `FONTS`).
    #[cfg(test)]
    pub fn use_fonts(list: &'static [&'static [u8]], families: (&str, &str)) {
        SHAPER.with(|cell| *cell.borrow_mut() = Some(Shaper { text: TextSystem::new(list, families) }));
    }

    /// Once per geometry build: layouts unused for a while go.
    fn next_generation(&mut self) {
        self.text.end_commit();
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
    /// Display -> raw, with hit affinity (editor-core's `DisplayMap`).
    map: DisplayMap,
    r2d: Vec<usize>,
    pub layout: Rc<Layout<Ink>>,
    pub h: f32,
    /// Unwrapped content width.
    pub natural_w: f32,
    /// Display ranges drawn with a strikethrough rule.
    pub strikes: Vec<(usize, usize)>,
    /// Collapsed links' pencils (the space kept for them after the link text).
    pub pencils: Vec<PencilGeo>,
    scale: f32,
}

/// The pencil after a collapsed link's text: a press reveals the link for editing.
#[derive(Clone, Debug, PartialEq)]
pub struct PencilGeo {
    /// [x, y, w, h] in document space.
    pub rect: [f32; 4],
    /// The link's URL range (its text ends two bytes before, at the `]`).
    pub url: (usize, usize),
}

/// Kept in the text for a collapsed link's pencil (drawn transparent; the pencil is drawn over it):
/// a wide letter, so it never wraps away from the link's last word.
const PENCIL_SLOT: char = 'W';
/// The slot's size (em): the old chip's, so the line's metrics don't change.
const PENCIL_SLOT_EM: f32 = 0.85;

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
        // the right half of a glyph is upstream: next to hidden markers that keeps the caret on
        // the glyph's side of them (the right half of a bold word's last letter stays bold)
        self.map.raw_at(cur.index().min(self.text.len()), cur.affinity() == Affinity::Upstream)
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

    /// The first visual line's baseline in document space.
    pub fn baseline(&self) -> f32 {
        self.layout.lines().next().map_or(self.y + self.style.line_px() * 0.8, |l| self.y + l.metrics().baseline / self.scale)
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
            InlineType::Image => {}
        }
    }
    match seg.kind {
        SegKind::Marker | SegKind::Fence | SegKind::Pipe | SegKind::Pad | SegKind::Delim => {
            sp.color = Some(c(MARKER));
            sp.underline = None;
            any = true;
        }
        // an expanded link's URL (editable): like its markers
        SegKind::Chip if !seg.hidden => {
            sp.color = Some(c(MARKER));
            sp.underline = None;
            any = true;
        }
        // a collapsed one: the pencil's slot
        SegKind::Chip => {
            sp.color = Some(c(PAPER).alpha(0.0));
            sp.size = Some(base.size * PENCIL_SLOT_EM);
            sp.underline = None;
            sp.weight = None;
            sp.italic = false;
            sp.bg = None;
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
    /// Image alt text ranges: revealed, they're drawn as text, not dimmed like the rest of the source.
    alts: Vec<(usize, usize)>,
    /// Code highlighting: raw ranges and their token ids (`highlight::LineHl::tokens`).
    tokens: &'a [(usize, usize, u8)],
    /// Collapsed links get a pencil, except those around just an image (these URL starts) and
    /// on a line showing only its images.
    pencils: bool,
    no_pencil: &'a [usize],
}

fn make_piece(sh: &mut Shaper, src: &str, p: PieceSpec, x: f32, y: f32, w: Option<f32>, scale: f32) -> Piece {
    let PieceSpec { segs, from, to, style, color, cell, alts, tokens, pencils: with_pencils, no_pencil } = p;
    let mut text = String::with_capacity(to - from);
    let mut spans = Vec::new();
    let mut strikes = Vec::new();
    let mut slots = Vec::new();
    let mut map = DisplayMap::new(from);
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
        let pencil = seg.kind == SegKind::Chip && seg.hidden && with_pencils && !no_pencil.contains(&seg.from);
        let visible = (!seg.hidden || pencil) && seg.kind != SegKind::Token;
        if !visible {
            for r in sf..st {
                r2d[r - from] = ds;
            }
            raw = st;
            continue;
        }
        if pencil {
            text.push(PENCIL_SLOT);
            for r in sf..st {
                r2d[r - from] = ds;
            }
            map.push(sf, st, text.len() - ds);
            slots.push((ds, text.len(), seg.from, seg.to));
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
                map.push(r, r + ch.len_utf8(), text.len() - before);
                for j in 1..ch.len_utf8() {
                    r2d[r - from + j] = before + j;
                }
            }
        }
        if let Some(mut sp) = seg_span(seg, ds, text.len(), style, &mut strikes) {
            if seg.kind == SegKind::Marker && alts.iter().any(|&(a, b)| a <= sf && st <= b) {
                sp.color = Some(c(INK));
            }
            spans.push(sp);
        }
        raw = st;
    }
    while raw < to {
        r2d[raw - from] = text.len();
        raw += 1;
    }
    r2d[to - from] = text.len();
    map.set_end(to);
    for &(a, b, id) in tokens {
        let (ds, de) = (r2d[a.clamp(from, to) - from], r2d[b.clamp(from, to) - from]);
        if ds < de {
            let (color, italic, bold) = crate::highlight::token_style(id);
            spans.push(Span { color: Some(color), italic, weight: bold.then_some(BOLD), ..Span::new(ds, de) });
        }
    }
    let layout = sh.layout(&text, &spans, style, scale, w);
    // rune::text::layout_height, back in points.
    let h = layout.height().max(style.line_px() * scale).ceil() / scale;
    let natural_w = if w.is_none() { layout.full_width().ceil() / scale } else { 0.0 };
    let mut piece = Piece {
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
        map,
        r2d,
        layout,
        h,
        natural_w,
        strikes,
        pencils: Vec::new(),
        scale,
    };
    piece.pencils = slots
        .into_iter()
        .filter_map(|(ds, de, u0, u1)| Some(PencilGeo { rect: *piece.display_rects(ds, de).first()?, url: (u0, u1) }))
        .collect();
    piece
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
    /// The whole line: its text and its images.
    pub h: f32,
    /// One per table cell, else one per shown text part (`LineView::parts`), top to bottom.
    pub pieces: Vec<Piece>,
    pub toks: Vec<Tok>,
    /// Table rows: column x ranges (including the cell padding).
    pub cols: Vec<(f32, f32)>,
    pub images: Vec<ImgGeo>,
    /// Each image block's band (top, bottom): from the text above it (or the line's top) to the
    /// text below it (or the line's bottom). `ImgGeo::block` indexes it.
    pub blocks: Vec<(f32, f32)>,
    /// Where the line's content starts (its tokens before).
    pub content_from: usize,
    /// A code line's background across the block (diff/patch added and removed lines).
    pub code_bg: Option<Color>,
}

/// What an image box shows.
#[derive(Clone, Debug, PartialEq)]
pub enum ImgKind {
    /// Still loading, its size remembered (`imagesizes`): an empty box of that size.
    Reserved,
    /// Decoded: drawn from this file.
    Ready(PathBuf),
    /// Decoding (space kept for the placeholder, nothing drawn).
    Loading,
    /// Missing, unreadable, remote or unsupported: the placeholder with `ImgGeo::label`.
    Missing,
    /// Downloading: a quiet box with `ImgGeo::label` ("Loading image…"), no icon.
    Fetching,
}

/// An image of a line, in document space.
#[derive(Clone, Debug)]
pub struct ImgGeo {
    /// Its block (`LineGeo::blocks`).
    pub block: usize,
    /// The image's source range: a click on it puts the caret at `to`.
    pub from: usize,
    pub to: usize,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub kind: ImgKind,
    /// The placeholder's text ("Image not found: alt").
    pub label: String,
}

/// Images are at most this tall (keeping their aspect), like the web editor's `max-height`.
pub const MAX_IMAGE_H: f32 = 480.0;
/// Space between images on one row and between rows; above the block (below the text) and under it.
const IMAGE_GAP: f32 = 6.0;
const IMAGES_PAD_T: f32 = 4.0;
const IMAGES_PAD_T_ALONE: f32 = 6.0;
const IMAGES_PAD_B: f32 = 6.0;
pub const IMAGE_RADIUS: f32 = 6.0;

/// The placeholder's text style (0.8 em) and padding.
pub fn placeholder_style() -> TextStyle {
    TextStyle::new(12.8, 400.0).lh(19.0)
}
pub const PLACEHOLDER_PAD_X: f32 = 8.0;
pub const PLACEHOLDER_PAD_Y: f32 = 3.0;
/// The broken-image icon and the gap after it.
pub const PLACEHOLDER_ICON: f32 = 14.0;
const PLACEHOLDER_ICON_GAP: f32 = 6.0;

/// Display size of an image of `iw`×`ih` pixels (one pixel a point, like the web editor's CSS
/// pixels): at most `avail` wide and `MAX_IMAGE_H` tall, aspect kept.
pub fn image_box(iw: u32, ih: u32, avail: f32) -> (f32, f32) {
    let (iw, ih) = (iw.max(1) as f32, ih.max(1) as f32);
    let w = iw.min(avail.max(1.0)).min(MAX_IMAGE_H * iw / ih).floor().max(1.0);
    (w, (w * ih / iw).round().max(1.0))
}

/// Lays the line's images out left to right from (`x`, `y`), wrapping at `avail`; returns the
/// block's height.
#[allow(clippy::too_many_arguments)]
fn place_images(sh: &mut Shaper, views: &[ImageView], note_dir: Base, x: f32, y: f32, avail: f32, scale: f32, out: &mut Vec<ImgGeo>) -> f32 {
    let (mut cx, mut cy, mut row_h) = (x, y, 0.0f32);
    for iv in views {
        use crate::images::ImageState;
        use crate::rimages::{Fetched, Source};
        let alt = iv.alt.trim();
        let with_alt = |what: &str| if alt.is_empty() { what.to_string() } else { format!("{what}: {alt}") };
        // the file to show, or the placeholder's kind and text
        let source = crate::rimages::source(&iv.src, note_dir);
        // its size as last seen, by source (`imagesizes`): the box is reserved until it's here
        let key = match &source {
            Source::File(p) => Some(p.to_string_lossy().into_owned()),
            Source::Url { url, .. } => Some(url.clone()),
            _ => None,
        };
        let remembered = key.as_deref().and_then(crate::imagesizes::known);
        let (file, mut label) = match source {
            Source::File(p) => (Ok(p), with_alt("Image not found")),
            Source::Url { url, token } => match crate::rimages::fetch(&url, token.as_deref()) {
                Fetched::Ready(p) => (Ok(p), with_alt("Image not found")),
                Fetched::Loading => (Err(ImgKind::Fetching), with_alt("Loading image")),
                Fetched::Failed { missing: true, .. } => (Err(ImgKind::Missing), with_alt("Image not found")),
                Fetched::Failed { .. } => (Err(ImgKind::Missing), with_alt("Couldn't load image")),
            },
            Source::Offline => (Err(ImgKind::Missing), with_alt("Remote image")),
            Source::Invalid => (Err(ImgKind::Missing), with_alt("Image not found")),
        };
        if alt.is_empty() && matches!(file, Err(ImgKind::Fetching)) {
            label = "Loading image…".into();
        }
        let placeholder = |sh: &mut Shaper, label: &str, icon: bool| {
            let inner = PLACEHOLDER_PAD_X * 2.0 + if icon { PLACEHOLDER_ICON + PLACEHOLDER_ICON_GAP } else { 0.0 };
            let st = placeholder_style();
            let natural = sh.layout(label, &[], st, scale, None).full_width().ceil() / scale;
            let tw = natural.min((avail - inner).max(20.0));
            let th = sh.layout(label, &[], st, scale, Some(tw + 1.0)).height().max(st.line_px() * scale).ceil() / scale;
            ((inner + tw + 1.0).min(avail.max(inner)), th + PLACEHOLDER_PAD_Y * 2.0)
        };
        let (kind, (w, h)) = match file {
            Ok(path) => match crate::images::state(&path) {
                ImageState::Ready { width, height } => {
                    if let Some(k) = &key {
                        crate::imagesizes::remember(k, width, height);
                    }
                    (ImgKind::Ready(path), image_box(width, height, avail))
                }
                ImageState::Loading => match remembered {
                    Some((iw, ih)) => (ImgKind::Reserved, image_box(iw, ih, avail)),
                    None => (ImgKind::Loading, placeholder(sh, &label, true)),
                },
                ImageState::Failed(_) => (ImgKind::Missing, placeholder(sh, &label, true)),
            },
            Err(ImgKind::Fetching) => match remembered {
                Some((iw, ih)) => (ImgKind::Reserved, image_box(iw, ih, avail)),
                None => (ImgKind::Fetching, placeholder(sh, &label, false)),
            },
            Err(k) => (k, placeholder(sh, &label, true)),
        };
        if cx > x && cx + w > x + avail {
            cx = x;
            cy += row_h + IMAGE_GAP;
            row_h = 0.0;
        }
        out.push(ImgGeo { block: 0, from: iv.from, to: iv.to, x: cx, y: cy, w, h, kind, label });
        cx += w + IMAGE_GAP;
        row_h = row_h.max(h);
    }
    cy + row_h - y
}

impl LineGeo {
    /// The image a point is on: the rows of an image block split its band into bands (each from
    /// its row's top to the next row's, the first from the block's top, the last to its bottom),
    /// and a point in a band is on the nearest image of its row.
    pub fn image_at(&self, x: f32, y: f32) -> Option<&ImgGeo> {
        let b = self.blocks.iter().position(|&(t, bt)| t <= y && y < bt)?;
        let mut imgs = self.images.iter().filter(|i| i.block == b).peekable();
        let first = imgs.peek()?.y;
        let row = self.images.iter().filter(|i| i.block == b).map(|i| i.y).filter(|&ry| ry <= y).fold(first, f32::max);
        let dist = |i: &ImgGeo| if x < i.x { i.x - x } else { (x - (i.x + i.w)).max(0.0) };
        imgs.filter(|i| i.y == row).min_by(|a, b| dist(a).total_cmp(&dist(b)))
    }

    /// The text piece showing raw `pos`: table cells as they're laid out (the last starting at
    /// or before it); text parts: the first ending at or after it (at an image block's end, the
    /// part before, holding its source), so a position in a part that isn't shown sits at the
    /// end of the shown one before it, else the start of the next.
    fn piece_at(&self, pos: usize) -> Option<&Piece> {
        let p0 = self.pieces.first()?;
        if !self.cols.is_empty() {
            return Some(self.pieces.iter().rev().find(|p| p.from <= pos).unwrap_or(p0));
        }
        self.pieces.iter().find(|p| pos <= p.to).or(self.pieces.last())
    }
}

impl LineGeo {
    pub fn drawn(&self) -> bool {
        !self.view.collapsed && self.h > 0.0
    }

    /// Top and bottom of the first visual line of text (an image block first: a line's height
    /// from its top, beside it).
    pub fn first_vline(&self) -> (f32, f32) {
        match self.pieces.first() {
            Some(p) => match self.images.first() {
                Some(i) if p.from > self.content_from && i.y < p.y => (i.y, i.y + p.style.line_px()),
                _ => (p.y, p.y + p.style.line_px()),
            },
            None => (self.top, self.top + self.h),
        }
    }
}

pub struct Geo {
    pub lines: Vec<LineGeo>,
    pub height: f32,
    /// The tables and code blocks, top to bottom (`Wide`).
    pub wide: Vec<Wide>,
}

/// A collapsed link on screen (`Geo::links`).
#[derive(Clone, Debug, PartialEq)]
pub struct LinkGeo {
    pub line: usize,
    /// Its start (the `[`): names it.
    pub from: usize,
    /// The end of its text (the `]`): where its pencil puts the caret.
    pub text_end: usize,
    /// Its URL's source range.
    pub url: (usize, usize),
    /// Where its text is drawn ([x, y, w, h] per row), or the image it wraps.
    pub rects: Vec<[f32; 4]>,
    pub pencil: Option<[f32; 4]>,
    /// It wraps just an image.
    pub image: bool,
}

fn is_table(v: &LineView) -> bool {
    matches!(v.kind, BlockType::TableHead | BlockType::TableDelim | BlockType::TableRow)
}

/// Lays out `views` of `src`; image sources resolve against `note_dir` (the open note's folder).
#[cfg(test)]
pub fn build(src: &str, views: &[LineView], note_dir: Option<&std::path::Path>) -> Geo {
    build_in(src, views, Base::Local(note_dir))
}

/// `build`, image sources resolving against `base` (a local note's folder, or a remote note).
pub fn build_in(src: &str, views: &[LineView], note_dir: Base) -> Geo {
    let scale = SCALE.get();
    SHAPER.with(|cell| {
        let mut guard = cell.borrow_mut();
        let sh = guard.get_or_insert_with(Shaper::new);
        sh.next_generation();
        let mut lines = Vec::with_capacity(views.len());
        let mut wide = Vec::new();
        let mut y = 0.0;
        let hl = crate::highlight::highlight(src, views);
        let mut i = 0;
        while i < views.len() {
            if views[i].hidden_by_fold {
                // inside a folded section: no space, nothing drawn
                let content_from = views[i].text_from;
                lines.push(LineGeo { view: views[i].clone(), top: y, h: 0.0, pieces: Vec::new(), toks: Vec::new(), cols: Vec::new(), images: Vec::new(), blocks: Vec::new(), content_from, code_bg: None });
                i += 1;
            } else if is_table(&views[i]) {
                let mut j = i;
                while j < views.len() && is_table(&views[j]) && !views[j].hidden_by_fold {
                    j += 1;
                }
                let (first, top) = (lines.len(), y);
                let (x, w, content_w) = build_table(sh, src, &views[i..j], &mut y, scale, &mut lines);
                wide.push(Wide { first, end: lines.len(), x, w, content_w, top, h: y - top, code: false });
                i = j;
            } else if views[i].code.is_some() {
                // a code block: its lines unwrapped, in a box of its own
                let mut j = i + 1;
                while j < views.len() && views[j].code.as_ref().is_some_and(|c| !c.first) && !views[j].hidden_by_fold {
                    j += 1;
                }
                let (first, top) = (lines.len(), y);
                for (k, v) in views.iter().enumerate().take(j).skip(i) {
                    let l = build_line(sh, src, v, y, scale, note_dir, hl.get(k).and_then(Option::as_ref));
                    y += l.h;
                    lines.push(l);
                }
                let content = lines[first..].iter().flat_map(|l| l.pieces.iter()).map(|p| p.x + p.natural_w).fold(0.0, f32::max) + CODE_PAD;
                let (x, w) = wide_box(content, CODE_MAX_W);
                if x != 0.0 {
                    for l in &mut lines[first..] {
                        for p in &mut l.pieces {
                            p.x += x;
                        }
                    }
                }
                wide.push(Wide { first, end: lines.len(), x, w, content_w: content.max(w).ceil(), top, h: y - top, code: true });
                i = j;
            } else {
                let l = build_line(sh, src, &views[i], y, scale, note_dir, hl.get(i).and_then(Option::as_ref));
                y += l.h;
                lines.push(l);
                i += 1;
            }
        }
        Geo { lines, height: y, wide }
    })
}

fn build_line(sh: &mut Shaper, src: &str, v: &LineView, top: f32, scale: f32, note_dir: Base, hl: Option<&LineHl>) -> LineGeo {
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
    let alts: Vec<(usize, usize)> = v.images.iter().map(|i| i.alt_range).collect();
    let tokens = hl.map_or(&[][..], |h| &h.tokens);
    let code_bg = hl.and_then(|h| h.bg).map(c);
    // `[![alt](src)](url)` (the URL starts right after the image's `](`): the image is the link
    // (a click opens it); its pencil only while the image's source shows
    let no_pencil: Vec<usize> = v.images.iter().filter(|i| !i.revealed && src[i.to..].starts_with("](")).map(|i| i.to + 2).collect();
    let pencils = !v.text_hidden();
    if !v.image_only && !v.parts.is_empty() && !v.collapsed && v.kind != BlockType::Hr {
        // Split at the images: each text part wraps on its own rows, each image block sits on
        // its own rows where it is in the text.
        let mut y = top + pad_t;
        let (mut pieces, mut images, mut blocks) = (Vec::new(), Vec::new(), Vec::new());
        for part in &v.parts {
            match *part {
                LinePart::Text { from: pf, to: pt, shown } => {
                    if !shown {
                        continue;
                    }
                    let pf = if pf <= v.from { from } else { pf };
                    let segs = segs.iter().copied().filter(|s| pf <= s.from && s.to <= pt).collect();
                    let spec = PieceSpec { segs, from: pf, to: pt, style, color, cell: None, alts: alts.clone(), tokens, pencils, no_pencil: &no_pencil };
                    let p = make_piece(sh, src, spec, left, y, (!in_code).then_some(w), scale);
                    y += p.h;
                    pieces.push(p);
                }
                LinePart::Images { first, end } => {
                    let band = if pieces.is_empty() { top } else { y };
                    let pad = if pieces.is_empty() { IMAGES_PAD_T_ALONE } else { IMAGES_PAD_T };
                    let n = images.len();
                    y += pad + place_images(sh, &v.images[first..end], note_dir, left, y + pad, w, scale, &mut images) + IMAGES_PAD_B;
                    for i in &mut images[n..] {
                        i.block = blocks.len();
                    }
                    blocks.push((band, y));
                }
            }
        }
        // the last block's band reaches the line's bottom
        let h = y + pad_b - top;
        if let Some(b) = blocks.last_mut()
            && pieces.last().is_none_or(|p| p.y < b.0)
        {
            b.1 = top + h;
        }
        return LineGeo { view: v.clone(), top, h, pieces, toks, cols: Vec::new(), images, blocks, content_from: from, code_bg };
    }
    let spec = PieceSpec { segs, from, to: v.to, style, color, cell: None, alts, tokens, pencils, no_pencil: &no_pencil };
    let piece = make_piece(sh, src, spec, left, top + pad_t, (!in_code).then_some(w), scale);
    let mut h = if v.collapsed {
        if v.kind == BlockType::Fence { 8.0 } else { 0.0 }
    } else if v.kind == BlockType::Hr {
        24.0
    } else {
        pad_t + piece.h + pad_b
    };
    // Images go below the text (an image-only line shows only them while they're collapsed).
    let mut images = Vec::new();
    let mut blocks = Vec::new();
    if !v.images.is_empty() && !v.collapsed {
        let (text_h, pad) = if v.text_hidden() { (0.0, IMAGES_PAD_T_ALONE) } else { (h, IMAGES_PAD_T) };
        let block = place_images(sh, &v.images, note_dir, left, top + text_h + pad, w, scale, &mut images);
        h = text_h + pad + block + IMAGES_PAD_B;
        let start = if v.text_hidden() { top } else { top + text_h };
        blocks.push((start, top + h));
    }
    LineGeo { view: v.clone(), top, h, pieces: vec![piece], toks, cols: Vec::new(), images, blocks, content_from: from, code_bg }
}

/// A table's rows; returns its box (`Wide`'s x, w, content_w).
fn build_table(sh: &mut Shaper, src: &str, views: &[LineView], y: &mut f32, scale: f32, out: &mut Vec<LineGeo>) -> (f32, f32, f32) {
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
                PieceSpec { segs: segs.clone(), from, to, style: style_of(v), color: c(INK), cell: Some(ci), alts: Vec::new(), tokens: &[], pencils: true, no_pencil: &[] },
                0.0,
                0.0,
                None,
                scale,
            );
            nat[ci] = nat[ci].max(p.natural_w);
        }
    }
    // each column its natural width, at most the text column's (longer cells wrap); a table wider than the column
    // breaks out into the margins, then scrolls
    let gaps = CELL_PAD_R * (ncols - 1) as f32;
    let widths: Vec<f32> = nat.iter().map(|&n| n.min(col_w()).max(24.0)).collect();
    let content_w = widths.iter().sum::<f32>() + gaps;
    let (bx, bw) = wide_box(content_w, TABLE_MAX_W);
    let mut cols = Vec::with_capacity(ncols);
    let mut x = bx;
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
                    PieceSpec { segs: segs.clone(), from, to, style, color: c(INK), cell: Some(ci), alts: Vec::new(), tokens: &[], pencils: true, no_pencil: &[] },
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
        out.push(LineGeo { view: v.clone(), top, h, pieces, toks: Vec::new(), cols: cols.clone(), images: Vec::new(), blocks: Vec::new(), content_from: v.from, code_bg: None });
    }
    (bx, bw, content_w.max(bw))
}

// ------------------------------------------------------------------------------------------
// Queries

impl Geo {
    /// The table or code block whose box holds (`x`, `y`) (column coordinates).
    pub fn wide_at(&self, x: f32, y: f32) -> Option<&Wide> {
        self.wide.iter().find(|w| y >= w.top && y < w.top + w.h && x >= w.x && x < w.x + w.w)
    }

    /// The table or code block line `li` is in.
    pub fn wide_of_line(&self, li: usize) -> Option<&Wide> {
        self.wide.iter().find(|w| (w.first..w.end).contains(&li))
    }

    pub fn line_at_pos(&self, pos: usize) -> usize {
        self.lines.partition_point(|l| l.view.from <= pos).saturating_sub(1)
    }

    pub fn line_at_y(&self, y: f32) -> usize {
        self.lines.partition_point(|l| l.top <= y).saturating_sub(1)
    }

    /// Caret (x, top, bottom) for raw `pos`.
    pub fn caret(&self, pos: usize) -> (f32, f32, f32) {
        // a position hidden in a folded section (someone else's caret) shows on its folded heading, at its "…"
        // pill: the heading's end + 14 pt (the web's `caretRect`)
        let mut li = self.line_at_pos(pos);
        if li > 0 && self.lines.get(li).is_some_and(|l| l.view.hidden_by_fold) {
            while li > 0 && self.lines[li].view.hidden_by_fold {
                li -= 1;
            }
            let (x, t, b) = self.caret(self.lines[li].view.to);
            return (x + 14.0, t, b);
        }
        let Some(l) = self.lines.get(li) else { return (0.0, 0.0, body().line_px()) };
        if l.view.kind == BlockType::Hr
            && let Some(t) = l.toks.last()
        {
            let mid = l.top + l.h / 2.0;
            return (if pos >= t.to { t.x1 } else { t.x0 }, mid - 11.0, mid + 11.0);
        }
        let Some(p0) = l.pieces.first() else { return (0.0, l.top, l.top + l.h.max(1.0)) };
        if pos < p0.from.min(l.content_from) {
            let (top, bottom) = l.first_vline();
            let x = l.toks.iter().find_map(|t| (t.from == pos).then_some(t.x0)).or_else(|| l.toks.iter().find_map(|t| (t.to == pos).then_some(t.x1)));
            return (x.unwrap_or(0.0), top, bottom);
        }
        l.piece_at(pos).unwrap_or(p0).caret(pos)
    }

    /// The image under a point.
    pub fn image_at(&self, x: f32, y: f32) -> Option<&ImgGeo> {
        self.lines.get(self.line_at_y(y))?.image_at(x, y)
    }

    /// Collapsed links (`reveal` from the editor that rendered this geometry): where their text
    /// (or the image a link wraps) is drawn, and their pencils.
    pub fn links(&self, doc: &Doc, reveal: &RevealMap) -> Vec<LinkGeo> {
        let mut out = Vec::new();
        for l in self.lines.iter().filter(|l| l.drawn() && !l.view.hidden_by_fold) {
            let Some(line) = doc.lines.get(l.view.index) else { continue };
            let shown: &[usize] = reveal.get(&line.index).map_or(&[], |r| &r.els);
            for (k, el) in line.inline.iter().enumerate() {
                let Some(url) = el.url.filter(|_| el.ty == InlineType::Link && !shown.contains(&k)) else { continue };
                let (a, b) = (el.content_from.max(l.view.from), el.content_to.min(l.view.to));
                let image = l.images.iter().find(|i| i.from == el.content_from && i.to == el.content_to);
                let mut rects = Vec::new();
                if let Some(i) = image {
                    rects.push([i.x, i.y, i.w, i.h]);
                } else if a < b {
                    for p in l.pieces.iter().filter(|p| p.from < b && a < p.to) {
                        rects.extend(p.rects(a.max(p.from), b.min(p.to)).into_iter().filter(|r| r[2] > 0.5));
                    }
                }
                let pencil = l.pieces.iter().flat_map(|p| &p.pencils).find(|g| g.url == url).map(|g| g.rect);
                if rects.is_empty() && pencil.is_none() {
                    continue;
                }
                out.push(LinkGeo { line: l.view.index, from: el.from, text_end: el.content_to, url, rects, pencil, image: image.is_some() });
            }
        }
        out
    }

    /// The collapsed link whose text (or image) is under a point.
    pub fn link_at(&self, doc: &Doc, reveal: &RevealMap, x: f32, y: f32) -> Option<LinkGeo> {
        let li = self.line_at_y(y);
        self.links(doc, reveal)
            .into_iter()
            .filter(|g| g.line == li)
            .find(|g| g.rects.iter().any(|r| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]))
    }

    pub fn hit(&self, x: f32, y: f32) -> usize {
        let Some(l) = self.lines.get(self.line_at_y(y)) else { return 0 };
        if let Some(img) = l.image_at(x, y) {
            return img.to;
        }
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
        let Some(p0) = l.pieces.first() else { return l.view.to };
        // the text part under y (the last starting above it)
        let p = l.pieces.iter().rev().find(|p| p.y <= y).unwrap_or(p0);
        if x < p.x && p.from <= l.content_from {
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
            for i in l.images.iter().filter(|i| a <= i.from && i.to <= b) {
                out.push([i.x, i.y, i.w, i.h]);
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
        let pi = if l.cols.is_empty() {
            l.pieces.iter().position(|p| p.from <= pos && pos <= p.to)?
        } else {
            l.pieces.iter().rposition(|p| p.from <= pos && pos <= p.to)?
        };
        let p = &mut l.pieces[pi];
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

    fn image_at(&self, x: f64, y: f64) -> Option<(usize, usize)> {
        Geo::image_at(self, x as f32, y as f32).map(|i| (i.from, i.to))
    }

    fn adjacent_line_y(&self, pos: usize, dir: i32) -> Option<f64> {
        Geo::adjacent_line_y(self, pos, dir).map(f64::from)
    }

    fn adjacent_line(&self, pos: usize, dir: i32) -> editor_core::Adjacent {
        Geo::adjacent_line_y(self, pos, dir).map_or(editor_core::Adjacent::Edge, |y| editor_core::Adjacent::Y(y.into()))
    }
}

impl LineGeo {
    /// The line's visual rows (top, bottom), top to bottom: wrapped text lines (merged across a
    /// table row's cells), then each row of images below it (an image-only collapsed line has
    /// only those). Rule and collapsed lines are one row; hidden lines have none.
    fn rows(&self) -> Vec<(f32, f32)> {
        if self.h <= 0.0 {
            return Vec::new();
        }
        if self.view.collapsed || self.view.kind == BlockType::Hr || self.pieces.is_empty() {
            return vec![(self.top, self.top + self.h)];
        }
        let mut rows: Vec<(f32, f32)> = Vec::new();
        if self.images.is_empty() || !self.view.text_hidden() {
            for (t, b) in self.pieces.iter().flat_map(Piece::vlines) {
                match rows.iter_mut().find(|r| r.0 < b && t < r.1) {
                    Some(r) => *r = (r.0.min(t), r.1.max(b)),
                    None => rows.push((t, b)),
                }
            }
            rows.sort_by(|a, b| a.0.total_cmp(&b.0));
        }
        // image bands, as `image_at` splits them
        for (b, &(start, bottom)) in self.blocks.iter().enumerate() {
            let mut tops: Vec<f32> = self.images.iter().filter(|i| i.block == b).map(|i| i.y).collect();
            tops.dedup();
            for (k, &t) in tops.iter().enumerate() {
                let t = if k == 0 { start } else { t };
                rows.push((t, tops.get(k + 1).copied().unwrap_or(bottom)));
            }
        }
        rows.sort_by(|a, b| a.0.total_cmp(&b.0));
        rows
    }
}

impl Geo {
    /// Middle of the visual row next to the caret at `pos` (`Layout::adjacent_line_y`): the row
    /// an Up/Down probe stepping from just outside the caret box would reach first (clamped to
    /// that first probe's y, if the row reaches into the caret box); None: there is no such row.
    pub fn adjacent_line_y(&self, pos: usize, dir: i32) -> Option<f32> {
        let (_, top, bottom) = self.caret(pos);
        if dir < 0 {
            let y0 = top - 1.0;
            if y0 < 0.0 {
                return None;
            }
            let start = self.line_at_y(y0);
            let (t, b) = self.lines[..=start].iter().rev().flat_map(|l| l.rows().into_iter().rev()).find(|r| r.0 <= y0)?;
            Some(((t + b) / 2.0).min(y0))
        } else {
            let y0 = bottom + 1.0;
            if y0 > self.height {
                return None;
            }
            let start = self.line_at_y(y0.min(self.height));
            let (t, b) = self.lines.get(start..)?.iter().flat_map(LineGeo::rows).find(|r| r.1 > y0)?;
            Some(((t + b) / 2.0).max(y0))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::{Editor, Key, Mods, Sel};
    use std::path::Path;

    fn setup() -> (Editor, PathBuf) {
        // No fonts: Rune's built-in Inter faces.
        let _ = FONTS.set(Fonts { list: &[], sans: "Inter", mono: "Inter" });
        crate::images::set_sync(true);
        SCALE.set(2.0);
        set_viewport(PAD_L + MAX_TEXT_W + PAD_R, 800.0);
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/photos");
        let text = std::fs::read_to_string(dir.join("Photos.md")).unwrap();
        (Editor::new(&text), dir)
    }

    fn geo(ed: &Editor, dir: &Path) -> Geo {
        build(ed.text(), &ed.render_lines(), Some(dir))
    }

    fn line_of(g: &Geo, pos: usize) -> usize {
        g.line_at_pos(pos)
    }

    /// Tables and code blocks: the text column when they fit; wider, they break out into the margins (code up to
    /// `CODE_MAX_W`, tables `TABLE_MAX_W`, never past the pane less a gap) and scroll inside; code lines don't wrap.
    /// The geometry as the web's layout can answer it: the adjacent line unknown, so the engine probes.
    struct Probing<'a>(&'a Geo);
    impl editor_core::Layout for Probing<'_> {
        fn caret_rect(&self, pos: usize) -> editor_core::Rect {
            editor_core::Layout::caret_rect(self.0, pos)
        }
        fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
            editor_core::Layout::hit_test(self.0, x, y)
        }
        fn bounds(&self) -> editor_core::Bounds {
            editor_core::Layout::bounds(self.0)
        }
        fn table_cell_at(&self, line: usize, x: f64, y: f64) -> Option<usize> {
            editor_core::Layout::table_cell_at(self.0, line, x, y)
        }
        fn line_mid_y(&self, line: usize) -> Option<f64> {
            editor_core::Layout::line_mid_y(self.0, line)
        }
        fn adjacent_line(&self, _pos: usize, _dir: i32) -> editor_core::Adjacent {
            editor_core::Adjacent::Unknown
        }
    }

    /// Shift+Down from anywhere in a table's header row goes on down the table and out of it, with the
    /// adjacent line known (the Mac) or probed (as the web's layout may make the engine do).
    #[test]
    fn shift_down_leaves_a_table_header() {
        let (_, dir) = setup();
        let src = "before\n| Name | Role |\n| --- | --- |\n| Ada | Lead |\n| Bob | Design |\nafter";
        let shift = Mods { shift: true, ..Mods::NONE };
        let mut stuck = Vec::new();
        for probe in [false, true] {
            for start in 0..=22 {
                let mut ed = Editor::new(src);
                ed.set_selection(Sel::caret(start));
                let mut lines = vec![ed.doc().line_of(start).index];
                for _ in 0..6 {
                    let g = geo(&ed, &dir);
                    if probe {
                        ed.key(Key::Down, shift, &Probing(&g));
                    } else {
                        ed.key(Key::Down, shift, &g);
                    }
                    lines.push(ed.doc().line_of(ed.selection().head).index);
                }
                if *lines.last().unwrap() != 5 {
                    stuck.push((probe, start, lines));
                }
            }
        }
        assert!(stuck.is_empty(), "{stuck:?}");
    }

    /// The web's widths at 1440 px (a 1168 pt pane beside the 272 pt sidebar): the 30-column table 1095 (the pane's
    /// room: 2 × (571.5 − 24)), long code 1000 (its cap); content narrower than its cap keeps its natural width.
    /// Revealed inline code and highlights: the markers carry the content's background (and pad), so the backticks or
    /// `==` and the text are one pill (Rune merges touching runs of one background on a line into one rounded rect),
    /// the markers only muted; collapsed, the pill is the content's.
    #[test]
    fn revealed_markers_share_the_pill() {
        let (_, dir) = setup();
        let src = "Run `cargo test` and ==this part== now.";
        for (at, mark, bg) in [(6usize, "`", c(CODE_BG)), (25, "==", highlight())] {
            let mut ed = Editor::new(src);
            ed.set_selection(Sel::caret(at));
            let g = geo(&ed, &dir);
            let p = &g.lines[0].pieces[0];
            let open = p.text.find(mark).unwrap();
            let close = p.text[open + mark.len()..].find(mark).unwrap() + open + mark.len();
            let cover = |i: usize| {
                let i = i as u32;
                p.spans.iter().filter(|s| s.start <= i && i < s.end).find_map(|s| s.bg.map(|b| (b, s.bg_pad)))
            };
            let (first, mid, last) = (cover(open), cover(open + mark.len() + 1), cover(close));
            assert_eq!(first.map(|b| b.0), Some(bg), "{mark}: the opening marker in the pill");
            assert!(first == mid && mid == last, "{mark}: one background and pad across: {first:?} {mid:?} {last:?}");
            let o = open as u32;
            let marker_color = p.spans.iter().find(|s| s.start <= o && o < s.end && s.color.is_some()).and_then(|s| s.color);
            assert_eq!(marker_color, Some(c(MARKER)), "{mark}: muted");
        }
    }

    /// A 200-letter word wraps inside the column (and in a table cell), as the web's `overflow-wrap: anywhere`; the caret
    /// walks through it and a click on its second row lands there.
    #[test]
    fn unbroken_words_wrap_anywhere() {
        let (_, dir) = setup();
        let word = "w".repeat(200);
        let src = format!("before {word} after\n\n| a | b |\n| - | - |\n| {word} | x |\n");
        let mut ed = Editor::new(&src);
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        let p = &g.lines[0].pieces[0];
        assert!(p.w <= col_w() && p.natural_w <= col_w() + 1.0, "{} > {}", p.natural_w, col_w());
        assert!(p.vlines().len() >= 2, "wrapped onto more rows");
        let cell = &g.lines[4].pieces[0];
        assert!(cell.w <= col_w() && cell.vlines().len() >= 2, "the cell wraps at the column width");
        assert!(g.wide[0].content_w <= col_w() + 2.0 * CELL_PAD_R + 40.0, "its column at most the text column's wide");
        // the caret steps through the word: Down moves to its next row, inside it
        let start = "before ".len();
        ed.set_selection(Sel::caret(start + 2));
        let (_, t0, _) = g.caret(start + 2);
        ed.key(Key::Down, Mods::NONE, &g);
        let h = ed.selection().head;
        assert!(h > start + 2 && h < start + 200, "{h}");
        assert!(g.caret(h).1 > t0);
        // a click on the second row lands on it, in the word
        let (_, t1, b1) = g.caret(h);
        let hit = g.hit(40.0, (t1 + b1) / 2.0);
        assert!(hit > start && hit < start + 200 && g.caret(hit).1 == t1, "{hit}");
    }

    #[test]
    fn wide_blocks_match_the_web_at_1440() {
        let (_, dir) = setup();
        let row = |n: usize, w: &str| format!("| {} |", (0..n).map(|c| format!("{w}{c}")).collect::<Vec<_>>().join(" | "));
        let delim = |n: usize| format!("|{}|", vec!["---"; n].join("|"));
        // the web's fixture (test/e2e): the medium table and the medium code line (105 characters)
        let medium_head = format!("| {} |", (1..=9).map(|i| format!("Heading {i}")).collect::<Vec<_>>().join(" | "));
        let medium_row = format!("| {} |", (1..=9).map(|i| format!("value-{i}-xx")).collect::<Vec<_>>().join(" | "));
        let medium_code = format!("const medium = \"{}\";", "m".repeat(86));
        let medium_delim = format!("|{}", "---|".repeat(9));
        let src = format!(
            "intro\n\n{}\n{}\n{}\n\n{medium_head}\n{medium_delim}\n{medium_row}\n\n```\n{}\n```\n\n```js\n{medium_code}\n```\n",
            row(30, "Column "), delim(30), row(30, "r1c"),
            "x".repeat(300),
        );
        set_viewport(1168.0, 800.0);
        let mut ed = Editor::new(&src);
        // the caret elsewhere: the tables collapsed, as the web measured them
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        let w: Vec<f32> = g.wide.iter().map(|b| b.w).collect();
        assert_eq!((w[0], w[2]), (1095.0, 1000.0), "{w:?}");
        // the medium table: 881 here, the web's 877 (the same Inter 16 and 18 pt gaps; each of its 9 columns measures
        // about half a point wider in Rune than in the browser), centred, not scrolling
        let t = &g.wide[1];
        assert!((t.w - 881.0).abs() <= 1.0 && t.content_w <= t.w + 1.0, "{t:?}");
        assert_eq!(t.x, ((col_w() - t.w) / 2.0).floor());
        // the medium code block: natural width, centred (its 870 needs Menlo, which these tests don't load: the
        // snapshot 169-wide-medium measures it in the app)
        let c = &g.wide[3];
        assert!(c.w > col_w() && c.x == ((col_w() - c.w) / 2.0).floor(), "{c:?}");
        set_viewport(PAD_L + MAX_TEXT_W + PAD_R, 800.0);
    }

    #[test]
    fn wide_tables_and_code_break_out_then_scroll() {
        let (_, dir) = setup();
        let cols = 30;
        let head = format!("| {} |", (1..=cols).map(|i| format!("Column {i}")).collect::<Vec<_>>().join(" | "));
        let delim = format!("|{}|", vec!["---"; cols].join("|"));
        let row = format!("| {} |", (0..cols).map(|c| format!("c{c}")).collect::<Vec<_>>().join(" | "));
        let long = "x".repeat(400);
        let src = format!("| a | b |\n| - | - |\n| 1 | 2 |\n\n{head}\n{delim}\n{row}\n\n```\nlet s = \"{long}\";\nshort\n```\n\nend\n");
        set_viewport(1600.0, 800.0);
        let ed = Editor::new(&src);
        let g = geo(&ed, &dir);
        assert_eq!(g.wide.len(), 3);
        let (narrow, table, code) = (&g.wide[0], &g.wide[1], &g.wide[2]);
        assert_eq!((narrow.x, narrow.w, narrow.code), (0.0, col_w(), false), "a narrow table: the column");
        assert!(g.lines[narrow.first].cols.last().unwrap().1 < col_w(), "at its natural width");
        assert!(table.x < 0.0 && table.w > col_w() && table.w <= TABLE_MAX_W && table.w <= 1600.0 - 2.0 * WIDE_GAP);
        assert_eq!(table.x, ((col_w() - table.w) / 2.0).floor(), "centred on the column");
        assert!(table.content_w > table.w, "wider still: it scrolls");
        assert!(code.code && code.x < 0.0 && code.w <= CODE_MAX_W && code.content_w > code.w);
        assert_eq!(g.lines[code.first].pieces[0].h, code_block().line_px(), "a code line doesn't wrap");
        // a narrower window: the boxes shrink with it
        set_viewport(1000.0, 800.0);
        let g = geo(&ed, &dir);
        assert!(g.wide[1].w <= 1000.0 - 2.0 * WIDE_GAP && g.wide[1].content_w > g.wide[1].w);
        // a click in the box goes to its cell
        let c = &g.lines[g.wide[1].first + 2].pieces[1];
        assert_eq!(g.wide_at(c.x + 2.0, c.y + 2.0).map(|w| w.first), Some(g.wide[1].first));
        set_viewport(PAD_L + MAX_TEXT_W + PAD_R, 800.0);
    }

    #[test]
    fn folded_lines_take_no_space_and_up_down_skip_them() {
        let (_, dir) = setup();
        let mut ed = Editor::new("# A\none\n| a | b |\n| - | - |\n| c | d |\n---\n## B\ntwo\n# C\nthree");
        let before = geo(&ed, &dir);
        assert!(ed.toggle_fold(0));
        let g = geo(&ed, &dir);
        let c = ed.doc().lines.iter().position(|l| l.text(ed.text()) == "# C").unwrap();
        assert!(g.lines[1..c].iter().all(|l| l.h == 0.0 && l.top == g.lines[c].top && !l.drawn()));
        assert_eq!(g.lines[c].top, before.lines[1].top);
        assert!(g.height < before.height);
        // Down from the heading lands on "# C", Up comes back
        ed.set_selection(Sel::caret(3));
        ed.key(Key::Down, Mods::NONE, &g);
        assert_eq!(line_of(&g, ed.selection().head), c);
        ed.key(Key::Up, Mods::NONE, &g);
        assert_eq!(line_of(&g, ed.selection().head), 0);
        // a click at the folded heading's bottom edge stays on it, just below lands on "# C"
        let (_, _, bottom) = g.caret(3);
        assert_eq!(line_of(&g, g.hit(40.0, g.lines[c].top - 1.0)), 0);
        assert_eq!(line_of(&g, g.hit(40.0, bottom.max(g.lines[c].top) + 1.0)), c);
        // a caret in the folded section (someone else's) shows at the heading's "…" pill, as the web
        let (hx, ht, hb) = g.caret(3);
        assert_eq!(g.caret(ed.text().find("two").unwrap()), (hx + 14.0, ht, hb));
    }

    #[test]
    fn a_collapsed_link_keeps_a_slot_for_its_pencil_and_a_revealed_one_shows_its_url() {
        let (_, dir) = setup();
        let text = "Go [there](https://e.com/x) now, **[bold](b.md)** too";
        let mut ed = Editor::new(text);
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        let p = &g.lines[0].pieces[0];
        assert_eq!(p.pencils.len(), 2);
        let u0 = text.find("https").unwrap();
        let pen = &p.pencils[0];
        assert_eq!(pen.url, (u0, text.find(") now").unwrap()));
        // right after the link text, as wide as the pencil
        let end = text.find("](").unwrap();
        assert!((pen.rect[0] - g.caret(end).0).abs() < 0.5);
        assert!(pen.rect[2] >= 11.0 && pen.rect[2] <= 16.0, "{:?}", pen.rect);
        // the text after the link follows the slot
        let now = text.find(" now").unwrap();
        assert!((g.caret(now).0 - (pen.rect[0] + pen.rect[2])).abs() < 1.0);
        let links = g.links(ed.doc(), &ed.reveal());
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].text_end, end);
        assert_eq!(links[0].pencil, Some(pen.rect));
        let (x0, _, _) = g.caret(text.find("there").unwrap());
        assert!((links[0].rects[0][0] - x0).abs() < 0.5 && links[0].rects[0][2] > 20.0);
        assert!(g.link_at(ed.doc(), &ed.reveal(), x0 + 5.0, links[0].rects[0][1] + 5.0).is_some());
        assert!(g.link_at(ed.doc(), &ed.reveal(), x0 - 5.0, links[0].rects[0][1] + 5.0).is_none());
        // the caret in its text doesn't reveal it
        ed.set_selection(Sel::caret(text.find("here").unwrap()));
        let g = geo(&ed, &dir);
        assert_eq!(g.lines[0].pieces[0].pencils.len(), 2);
        assert_eq!(g.links(ed.doc(), &ed.reveal()).len(), 2);
        // expanded (its pencil): the URL is text, every position a caret stop; no pencil, no link hit
        assert!(ed.expand_link(end));
        assert_eq!(ed.selection(), Sel::caret(end));
        ed.set_selection(Sel::caret(u0 + 4));
        let g = geo(&ed, &dir);
        let p = &g.lines[0].pieces[0];
        assert!(p.text.starts_with("Go [there](https://e.com/x) now"), "{}", p.text);
        assert_eq!(p.pencils.len(), 1, "the other link keeps its pencil");
        assert!(g.caret(u0 + 4).0 > g.caret(u0 + 3).0);
        let (x, t, b) = g.caret(u0 + 4);
        assert_eq!(ed.hit_test(&g, f64::from(x), f64::from((t + b) / 2.0)), Some(u0 + 4));
        assert_eq!(g.links(ed.doc(), &ed.reveal()).len(), 1);
    }

    #[test]
    fn image_boxes_keep_the_aspect_within_the_column_and_480_pt() {
        assert_eq!(image_box(800, 450, MAX_TEXT_W), (767.0, 431.0));
        assert_eq!(image_box(160, 60, MAX_TEXT_W), (160.0, 60.0));
        assert_eq!(image_box(240, 900, MAX_TEXT_W), (128.0, 480.0));
        assert_eq!(image_box(800, 450, 300.0), (300.0, 169.0));
    }

    #[test]
    fn images_are_part_of_their_line() {
        let (mut ed, dir) = setup();
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        // "![Sunset…](images/sunset.png)" alone on line 4: collapsed, only the image.
        let l = &g.lines[4];
        assert!(l.view.text_hidden());
        assert_eq!(l.images.len(), 1);
        let img = &l.images[0];
        assert_eq!(img.kind, ImgKind::Ready(dir.join("images/sunset.png")));
        assert_eq!((img.w, img.h, img.y - l.top), (767.0, 431.0, 6.0));
        assert_eq!(l.h, 6.0 + 431.0 + 6.0);
        assert_eq!(g.lines[5].top, l.top + l.h);
        // A click on the image goes to the end of its source.
        assert_eq!(g.hit(100.0, img.y + 100.0), img.to);
        assert_eq!(g.image_at(100.0, img.y + 100.0).map(|i| i.to), Some(img.to));
        // The badge's %20 is decoded; it sits below its text line, which keeps its height.
        let b = &g.lines[6];
        assert!(!b.view.text_hidden());
        assert_eq!(b.images[0].kind, ImgKind::Ready(dir.join("images/my badge.png")));
        assert_eq!(b.images[0].y, b.top + b.pieces[0].h + 4.0);
        // The missing one shows its alt text.
        let m = &g.lines[10].images[0];
        assert_eq!((m.kind.clone(), m.label.as_str()), (ImgKind::Missing, "Image not found: old scan"));
        assert!(m.h > 20.0 && m.w < 300.0);
        // A selection over the whole image line covers the image.
        let rects = g.sel_rects(img.from, img.to);
        assert!(rects.contains(&[img.x, img.y, img.w, img.h]));
    }

    #[test]
    fn the_caret_on_an_image_line_shows_the_source_above_the_image() {
        let (mut ed, dir) = setup();
        let collapsed = geo(&ed, &dir).lines[4].images[0].y;
        let to = geo(&ed, &dir).lines[4].view.to;
        ed.set_selection(Sel::caret(to));
        let g = geo(&ed, &dir);
        let l = &g.lines[4];
        assert!(!l.view.text_hidden());
        assert_eq!(l.pieces[0].text, "![Sunset over the pier](images/sunset.png)");
        let (_, top, bottom) = g.caret(to);
        assert_eq!((top, bottom), (l.top, l.top + 26.0));
        assert_eq!(l.images[0].y, l.top + 26.0 + 4.0);
        assert!(l.images[0].y > collapsed);
    }

    #[test]
    fn up_and_down_step_over_images_line_by_line() {
        let (mut ed, dir) = setup();
        let end2 = geo(&ed, &dir).lines[2].view.to;
        ed.set_selection(Sel::caret(end2));
        let mut lines = Vec::new();
        for _ in 0..4 {
            let g = geo(&ed, &dir);
            ed.key(Key::Down, Mods::default(), &g);
            lines.push(line_of(&geo(&ed, &dir), ed.selection().head));
        }
        assert_eq!(lines, [3, 4, 5, 6]);
        for _ in 0..3 {
            let g = geo(&ed, &dir);
            ed.key(Key::Up, Mods::default(), &g);
            lines.push(line_of(&geo(&ed, &dir), ed.selection().head));
        }
        assert_eq!(lines[4..], [5, 4, 3]);
    }

    #[test]
    fn images_without_a_folder_or_remote_show_the_placeholder() {
        let (_, _) = setup();
        let ed = Editor::new("![](https://e.com/a.png)\n![rel](a.png)\n");
        let g = build(ed.text(), &ed.render_lines(), None);
        assert_eq!(g.lines[0].images[0].kind, ImgKind::Missing);
        assert_eq!(g.lines[0].images[0].label, "Remote image");
        assert_eq!(g.lines[1].images[0].label, "Image not found: rel");
        assert_eq!(g.lines[1].images[0].kind, ImgKind::Missing);
    }

    /// Two badges side by side (an image-only line), a sentence with a narrow badge below it.
    fn rows() -> (Editor, PathBuf) {
        let (_, dir) = setup();
        let b = "images/my%20badge.png";
        (Editor::new(&format!("top\n![a]({b})![b]({b})\nmid text ![n]({b})\nend\n")), dir)
    }

    #[test]
    fn clicks_on_an_image_go_after_its_own_source() {
        let (mut ed, dir) = rows();
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        let (a, b) = (&g.lines[1].images[0], &g.lines[1].images[1]);
        assert_eq!((a.w, b.x), (160.0, 166.0));
        // On the first of two: after the first, not the line's end.
        ed.mouse_down(&g, f64::from(a.x + 50.0), f64::from(a.y + 20.0), 1, false);
        assert_eq!(ed.selection(), Sel::caret(a.to));
        // In the gap between them and right of the last, on the row: the nearest.
        let g = geo(&ed, &dir);
        let (a, b) = (g.lines[1].images[0].clone(), g.lines[1].images[1].clone());
        assert_eq!(g.hit(a.x + a.w + 2.0, a.y + 5.0), a.to);
        assert_eq!(g.hit(600.0, b.y + 5.0), b.to);
        // Right of a narrow image under a sentence: the image, not the text above.
        let n = g.lines[2].images[0].clone();
        assert_eq!(ed.hit_test(&g, 500.0, f64::from(n.y + 30.0)), Some(n.to));
        assert_eq!(ed.hit_test(&g, 500.0, f64::from(n.y - 2.0)), Some(n.to));
    }

    #[test]
    fn double_click_selects_an_image_source_shift_click_extends_to_it() {
        let (mut ed, dir) = rows();
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        let b = g.lines[1].images[1].clone();
        let (x, y) = (f64::from(b.x + 10.0), f64::from(b.y + 10.0));
        ed.mouse_down(&g, x, y, 1, false);
        assert_eq!(ed.selection(), Sel::caret(b.to));
        // The first click revealed the line and moved the image: the second still means it.
        let g = geo(&ed, &dir);
        assert!(g.lines[1].images[1].y > b.y);
        ed.mouse_down(&g, x, y, 2, false);
        assert_eq!(ed.selection(), Sel::new(b.from, b.to));
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        ed.mouse_down(&g, x, y, 1, true);
        assert_eq!(ed.selection(), Sel::new(0, b.to));
    }

    /// `Geo` without `adjacent_line_y`: Up/Down probe in 4 pt steps.
    struct Probe<'a>(&'a Geo);

    impl editor_core::Layout for Probe<'_> {
        fn caret_rect(&self, pos: usize) -> Rect {
            self.0.caret_rect(pos)
        }
        fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
            editor_core::Layout::hit_test(self.0, x, y)
        }
        fn bounds(&self) -> Bounds {
            self.0.bounds()
        }
        fn table_cell_at(&self, line: usize, x: f64, y: f64) -> Option<usize> {
            self.0.table_cell_at(line, x, y)
        }
        fn line_mid_y(&self, line: usize) -> Option<f64> {
            self.0.line_mid_y(line)
        }
        fn image_at(&self, x: f64, y: f64) -> Option<(usize, usize)> {
            editor_core::Layout::image_at(self.0, x, y)
        }
    }

    #[test]
    fn adjacent_lines_land_where_probing_does() {
        let (_, dir) = setup();
        let sample = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/long.md")).unwrap();
        let docs = [
            std::fs::read_to_string(dir.join("Photos.md")).unwrap(),
            rows().0.text().to_string(),
            "# Heading one\nA paragraph that is long enough to wrap onto a second visual line in the column, and then some more words to wrap again.\n## Two\n- bullet\n---\n```\ncode\n```\n| a | b |\n| --- | --- |\n| cell with enough text to wrap inside its column, more and more words here | x |\nend".to_string(),
            sample,
        ];
        for text in docs {
            let base = Editor::new(&text);
            let ends: Vec<usize> = base.doc().lines.iter().map(|l| l.to).collect();
            for (key, starts) in [(Key::Down, &ends[..1]), (Key::Up, &ends[ends.len() - 1..])] {
                for &s in starts.iter().chain(ends.iter().step_by((ends.len() / 8).max(1))) {
                    let (mut a, mut b) = (base.clone(), base.clone());
                    a.set_selection(Sel::caret(s));
                    b.set_selection(Sel::caret(s));
                    for i in 0..ends.len().min(40) {
                        let ga = geo(&a, &dir);
                        a.key(key, Mods::default(), &ga);
                        let gb = geo(&b, &dir);
                        b.key(key, Mods::default(), &Probe(&gb));
                        assert_eq!(a.selection(), b.selection(), "from {s}, {key:?} #{i}");
                    }
                }
            }
        }
    }

    #[test]
    fn up_steps_over_images_below_text_and_stops_on_collapsed_image_lines() {
        let (mut ed, dir) = rows();
        let end = ed.text().len() - 1;
        ed.set_selection(Sel::caret(end));
        let g = geo(&ed, &dir);
        let n = g.lines[2].images[0].clone();
        let (a, b) = (g.lines[1].images[0].clone(), g.lines[1].images[1].clone());
        // Up from "end" (goal x inside the narrow badge): over the sentence's image (images below
        // text aren't caret stops) onto its text row, at the goal.
        ed.key(Key::Up, Mods::default(), &g);
        let head = ed.selection().head;
        assert_eq!(line_of(&geo(&ed, &dir), head), 2);
        assert!(head < n.from, "{head}");
        // Up again onto the collapsed image-only line: the first of the two badges (no jump to
        // the line's end, after the second).
        let g = geo(&ed, &dir);
        ed.key(Key::Up, Mods::default(), &g);
        assert_eq!(ed.selection().head, a.to);
        assert_ne!(a.to, b.to);
        // And Down from there comes back through the sentence's line.
        let g = geo(&ed, &dir);
        ed.key(Key::Down, Mods::default(), &g);
        assert_eq!(line_of(&geo(&ed, &dir), ed.selection().head), 2);
    }

    /// "this is ![x](badge) a line" between two lines (badge: 160×60).
    fn mid() -> (Editor, PathBuf, usize, usize) {
        let (_, dir) = setup();
        let t = "top\nthis is ![x](images/my%20badge.png) a line\nend\n";
        let from = t.find("![").unwrap();
        let to = t.find(") a").unwrap() + 1;
        (Editor::new(t), dir, from, to)
    }

    #[test]
    fn a_mid_line_image_splits_its_line() {
        let (mut ed, dir, from, to) = mid();
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        let l = &g.lines[1];
        assert_eq!(l.pieces.len(), 2);
        let (p0, p1) = (&l.pieces[0], &l.pieces[1]);
        // the source and the space after it draw nothing
        assert_eq!((p0.text.as_str(), p1.text.as_str()), ("this is ", "a line"));
        let img = &l.images[0];
        assert_eq!((img.x, img.y, img.w, img.h), (0.0, p0.y + p0.h + 4.0, 160.0, 60.0));
        assert_eq!(p1.y, img.y + img.h + 6.0);
        assert_eq!(p1.x, p0.x);
        assert_eq!(l.h, p1.y + p1.h - l.top);
        assert_eq!(g.lines[2].top, l.top + l.h);
        // carets: the image's end on the first row, after the space at the second row's start
        let (_, t, _) = g.caret(to);
        assert_eq!(t, p0.y);
        let (x, t, _) = g.caret(to + 1);
        assert_eq!((x, t), (p1.x, p1.y));
        assert_eq!(g.caret(to + 2).1, p1.y);
        // clicks: right of the first row stays before the source; the second row's left edge is
        // after the space; the image goes after its source
        assert_eq!(ed.hit_test(&g, 600.0, f64::from(p0.y + 5.0)), Some(from));
        assert_eq!(ed.hit_test(&g, 0.0, f64::from(p1.y + 5.0)), Some(to + 1));
        assert_eq!(ed.hit_test(&g, 600.0, f64::from(p1.y + 5.0)), Some(l.view.to));
        assert_eq!(ed.hit_test(&g, f64::from(img.x + 50.0), f64::from(img.y + 30.0)), Some(to));
        assert_eq!(ed.hit_test(&g, 500.0, f64::from(img.y - 2.0)), Some(to));
    }

    #[test]
    fn up_and_down_around_a_mid_line_image() {
        let (mut ed, dir, from, to) = mid();
        // Down from the first row steps over the image onto the text after it, at the goal x
        ed.set_selection(Sel::caret(6));
        let g = geo(&ed, &dir);
        ed.key(Key::Down, Mods::default(), &g);
        let h = ed.selection().head;
        assert!(h > to + 1 && line_of(&g, h) == 1, "{h}");
        // Up comes back over it
        let g = geo(&ed, &dir);
        ed.key(Key::Up, Mods::default(), &g);
        assert_eq!(ed.selection().head, 6);
        // Down from the second row leaves the line; Up from "end" lands on the second row
        ed.set_selection(Sel::caret(to + 3));
        let g = geo(&ed, &dir);
        ed.key(Key::Down, Mods::default(), &g);
        assert_eq!(line_of(&g, ed.selection().head), 2);
        let g = geo(&ed, &dir);
        ed.key(Key::Up, Mods::default(), &g);
        assert!(ed.selection().head > to, "{:?}", ed.selection());
        // Up from the first row goes to "top"
        ed.set_selection(Sel::caret(from - 1));
        let g = geo(&ed, &dir);
        ed.key(Key::Up, Mods::default(), &g);
        assert_eq!(line_of(&g, ed.selection().head), 0);
    }

    #[test]
    fn a_revealed_mid_line_image_stays_after_its_source() {
        let (mut ed, dir, from, to) = mid();
        ed.set_selection(Sel::caret(0));
        let collapsed = geo(&ed, &dir).lines[1].images[0].clone();
        ed.set_selection(Sel::caret(to));
        let g = geo(&ed, &dir);
        let l = &g.lines[1];
        assert_eq!(l.pieces[0].text, "this is ![x](images/my%20badge.png)");
        assert_eq!(l.pieces[1].text, "a line");
        let img = &l.images[0];
        // one row of text above it either way: the image doesn't move
        assert_eq!((img.x, img.y), (collapsed.x, collapsed.y));
        let (_, t, b) = g.caret(to);
        assert!(b <= img.y && t >= l.top);
        // a selection across the image covers both rows and the image
        let rects = g.sel_rects(from - 3, to + 4);
        assert!(rects.contains(&[img.x, img.y, img.w, img.h]));
        assert!(rects.iter().any(|r| r[1] < img.y) && rects.iter().any(|r| r[1] > img.y + img.h));
    }

    #[test]
    fn text_before_a_mid_line_image_wraps_above_it() {
        let (_, dir) = setup();
        set_viewport(PAD_L + 300.0 + PAD_R, 800.0);
        let t = "words words words words words words words words words ![x](images/my%20badge.png) after";
        let ed = Editor::new(t);
        let g = geo(&ed, &dir);
        let l = &g.lines[0];
        assert!(l.pieces[0].vlines().len() >= 2);
        let last = *l.pieces[0].vlines().last().unwrap();
        assert!(l.images[0].y >= last.1);
        assert!(l.pieces[1].y >= l.images[0].y + l.images[0].h);
        set_viewport(PAD_L + MAX_TEXT_W + PAD_R, 800.0);
    }

    #[test]
    fn an_image_starting_a_line_has_no_row_above_it() {
        let (_, dir) = setup();
        let mut ed = Editor::new("top\n![x](images/my%20badge.png) caption\n");
        ed.set_selection(Sel::caret(0));
        let g = geo(&ed, &dir);
        let l = &g.lines[1];
        assert_eq!(l.pieces.len(), 1);
        assert_eq!(l.images[0].y, l.top + 6.0);
        assert_eq!(l.pieces[0].text, "caption");
        // a click above the image is on it; the caret after the space is at the caption's start
        assert_eq!(g.hit(10.0, l.top + 1.0), l.images[0].to);
        let (x, t, _) = g.caret(l.images[0].to + 1);
        assert_eq!((x, t), (l.pieces[0].x, l.pieces[0].y));
    }

    // ---- code highlighting

    /// The coloured spans of line `li`'s first piece: (display text, colour, italic, bold).
    fn code_spans(g: &Geo, li: usize) -> Vec<(String, Color, bool, bool)> {
        let p = &g.lines[li].pieces[0];
        p.spans.iter().map(|s| (p.text[s.start as usize..s.end as usize].to_string(), s.color.unwrap(), s.italic, s.weight == Some(BOLD))).collect()
    }

    fn find<'a>(spans: &'a [(String, Color, bool, bool)], text: &str) -> &'a (String, Color, bool, bool) {
        spans.iter().find(|s| s.0.trim() == text).unwrap_or_else(|| panic!("{text:?} in {spans:?}"))
    }

    #[test]
    fn code_blocks_with_a_language_are_coloured() {
        let (_, dir) = setup();
        let src = "```rust\nfn main() { let s = \"hi\"; } // done\n```\n\n```\nfn main() { let s = \"hi\"; } // done\n```\n\n```klingon\nfn main() {}\n```\n\n```TS title=x.ts\nconst \tn = 1;\n```\n";
        let ed = Editor::new(src);
        let g = geo(&ed, &dir);
        let s = code_spans(&g, 1);
        assert_eq!(find(&s, "fn").1, c("#296d9a"));
        assert_eq!(find(&s, "main").1, c("#5b4fa8"));
        assert_eq!(find(&s, "\"hi\"").1, c("#3f7d4e"));
        let comment = find(&s, "// done");
        assert!(comment.2 && !comment.3 && comment.1 == c("#7a7b82"));
        // tokens drawn as plain text get no span (`s`, and the spaces after `main`/`s`)
        assert!(s.iter().all(|x| x.0.trim() != "s"));
        // no language, an unknown one, fences: nothing
        for li in [0, 2, 4, 5, 6, 8, 9, 10] {
            assert!(g.lines[li].pieces.iter().all(|p| p.spans.iter().all(|sp| sp.color != Some(c("#296d9a")))), "line {li}");
        }
        assert!(g.lines[5].pieces[0].spans.is_empty() && g.lines[9].pieces[0].spans.is_empty());
        // the info string's first word, any case; a tab is drawn as four spaces and its token
        // still covers it
        let s = code_spans(&g, 13);
        assert_eq!(find(&s, "const").1, c("#296d9a"));
        assert_eq!(find(&s, "1").1, c("#8a5a14"));
        assert_eq!(g.lines[13].pieces[0].text, "const     n = 1;");
        assert!(g.lines.iter().all(|l| l.code_bg.is_none()));
    }

    #[test]
    fn highlighting_keeps_text_and_glyph_positions() {
        let (_, dir) = setup();
        // no italic or bold tokens here: colour alone moves nothing (italic and bold fonts may have
        // their own advances; Menlo's don't, see menlo_styles_share_advances)
        let body = "let x = vec![1, 2];\nfn f(a: &str) -> bool { a.is_empty() }";
        let plain = geo(&Editor::new(&format!("```\n{body}\n```")), &dir);
        let ed = Editor::new(&format!("```rust\n{body}\n```"));
        let lit = geo(&ed, &dir);
        let shift = 4; // "rust"
        for li in [1, 2] {
            let (a, b) = (&plain.lines[li].pieces[0], &lit.lines[li].pieces[0]);
            assert_eq!(a.text, b.text);
            assert!(!b.spans.is_empty());
            for pos in a.from..=a.to {
                assert_eq!(plain.caret(pos), lit.caret(pos + shift), "caret at {pos}");
            }
        }
        // hits land where the carets are
        let l = &lit.lines[2];
        for pos in l.view.from..l.view.to {
            let (x, t, bt) = lit.caret(pos);
            assert_eq!(lit.hit(x + 0.5, (t + bt) / 2.0), pos);
        }
    }

    /// Carets and hits come from the layout whose glyphs Rune draws. The app's view runs in a headless Rune
    /// `Runtime` (the app's fonts: Inter, its italics and bolds, Menlo; Rune's system fallbacks for symbols,
    /// emoji and CJK) over a note with plain, bold, italic, code (Menlo), headings, emoji, CJK and
    /// ligature-prone text, wrapped and not. For every piece, the glyph quads Rune places for our layout
    /// (`TextSystem::glyphs_for_layout`, at the element's drawn origin) are exactly the glyph (and colour
    /// emoji) instances the runtime painted; then each glyph sits between the carets at its cluster's two
    /// ends, and a hit at its middle lands on one of them.
    #[test]
    fn carets_and_hits_land_on_the_glyphs_rune_draws() {
        use parley::Cluster;
        use rune::render::{KIND_GLYPH, KIND_IMAGE};
        let (fonts, mono) = crate::app_fonts();
        let _ = FONTS.set(Fonts { list: &[], sans: "Inter", mono: "Inter" });
        Shaper::use_fonts(fonts, ("Inter", mono));
        crate::images::set_sync(true);
        let (vw, vh) = (PAD_L + MAX_TEXT_W + PAD_R, 1400.0);
        let note = "# Heading: office ffi -> fl\n\nPlain text with **bold**, *italic*, ***both***, `code -> => != ffi www` and ~~gone~~.\n\n## Emoji 🚀 ✅ 👍🏽 and CJK 日本語のテキスト 中文 한국어\n\nLigatures in body text: office, affine, fluffy, waffle, -> => != <= www, “quotes” — dashes… and a paragraph long enough to wrap onto a second and then a third line of the column so the wrapped rows count too, with 🚀 emoji and 漢字 in it.\n\n```rust\nfn f(a: &str) -> bool { a != \"ffi\" && a.len() >= 2 } // => ok\n```\n\n- [ ] a task with `inline -> code`\n> a quote, *italic* fluffy office\n";
        let mut app = crate::App::new(note, None, true);
        app.ed.set_selection(editor_core::Sel::caret(note.len()));
        let geo = app.geometry();
        let mut rt = rune::Runtime::with_text(app, crate::render::view, (vw, vh), rune::Env::new(false, 2.0), TextSystem::new(fonts, ("Inter", mono)));
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        let key = |r: [f32; 4]| r.map(|v| (v * 100.0).round() as i64);
        let mut drawn: Vec<[i64; 4]> = rt.instances.iter().filter(|i| i.params[1] == KIND_GLYPH || i.params[1] == KIND_IMAGE).map(|i| key(i.rect)).collect();
        let els = rt.elements();
        let mut ts = TextSystem::new(fonts, ("Inter", mono));
        let mut expected = Vec::new();
        let mut checked = 0;
        for (li, l) in geo.lines.iter().enumerate() {
            for (pi, p) in l.pieces.iter().enumerate() {
                if p.text.is_empty() || !l.drawn() {
                    continue;
                }
                let k = format!("t{li}-{pi}");
                let e = els.iter().find(|e| e.key.as_deref() == Some(k.as_str())).unwrap_or_else(|| panic!("no element {k}"));
                assert_eq!(e.rect[2], p.w, "{k}: Rune's width is the one we wrap at");
                let s = p.scale;
                let mut quads = Vec::new();
                ts.glyphs_for_layout(&p.layout, s, [e.rect[0] * s, e.rect[1] * s], true, &mut quads);
                for q in &quads {
                    expected.push(key(q.rect));
                    // the glyph between the carets at its cluster's ends, and a hit on it at one of them
                    let b = q.byte as usize;
                    let Some(cl) = Cluster::from_byte_index(&p.layout, b) else { continue };
                    let r = cl.text_range();
                    let x = |i: usize, aff| Cursor::from_byte_index(&p.layout, i, aff).geometry(&p.layout, 1.0).x0 as f32 + e.rect[0] * s;
                    let (x0, x1) = (x(r.start, Affinity::Downstream), x(r.end, Affinity::Upstream));
                    let (lo, hi) = (x0.min(x1), x0.max(x1));
                    let mid = q.rect[0] + q.rect[2] / 2.0;
                    let slack = 0.35 * p.style.size * s;
                    assert!(lo - slack <= mid && mid <= hi + slack, "{k} {:?}: glyph centre {mid} outside carets {lo}..{hi}", &p.text[r.clone()]);
                    let cy = q.rect[1] + q.rect[3] / 2.0 - e.rect[1] * s;
                    let hit = Cursor::from_point(&p.layout, (lo + hi) / 2.0 - e.rect[0] * s, cy).index();
                    assert!(hit == r.start || hit == r.end, "{k} {:?}: hit {hit} not at {r:?}", &p.text[r.clone()]);
                    checked += 1;
                }
            }
        }
        drawn.sort();
        expected.sort();
        assert!(checked > 300, "{checked} glyphs");
        assert_eq!(drawn.len(), expected.len(), "glyph count");
        assert_eq!(drawn, expected, "Rune draws the glyphs of our layouts, where we place them");
        // the fallbacks really were used: colour emoji (image instances) and CJK glyphs
        assert!(rt.instances.iter().any(|i| i.params[1] == KIND_IMAGE), "colour emoji drawn");
        println!("verified {checked} glyphs in {} pieces", geo.lines.iter().map(|l| l.pieces.len()).sum::<usize>());
    }

    #[test]
    fn menlo_styles_share_advances() {
        let Ok(menlo) = std::fs::read("/System/Library/Fonts/Menlo.ttc") else { return };
        let menlo: &'static [u8] = Box::leak(menlo.into_boxed_slice());
        let fonts: &'static [&'static [u8]] = Box::leak(vec![menlo].into_boxed_slice());
        let mut ts = TextSystem::new(fonts, ("Menlo", "Menlo"));
        let text = "fn main() { let s = \"héllo\"; } // done";
        let mut width = |italic: bool, bold: bool| {
            let mut spans = Vec::new();
            if italic {
                spans.push(Span::new(3, 20).italic());
            }
            if bold {
                spans.push(Span::new(10, 30).weight(BOLD));
            }
            ts.layout_rich(text, &spans, TextStyle::new(13.5, 400.0).mono(), 2.0, None).full_width()
        };
        let w = width(false, false);
        assert!(w > 0.0);
        assert_eq!(width(true, false), w);
        assert_eq!(width(false, true), w);
        assert_eq!(width(true, true), w);
    }

    #[test]
    fn diff_and_patch_lines_get_backgrounds() {
        let (_, dir) = setup();
        let ed = Editor::new("```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n-\n```\n\n```patch\n+x\n```\n\n```\n-not a diff\n```");
        let g = geo(&ed, &dir);
        let bg: Vec<_> = g.lines.iter().map(|l| l.code_bg).collect();
        let (p, m) = (Some(c("#e9f3ec")), Some(c("#f7efe5")));
        assert_eq!(bg, [None, None, m, p, None, m, None, None, None, p, None, None, None, None, None]);
        let s = code_spans(&g, 2);
        assert_eq!(find(&s, "old").1, c("#9a5b1e"));
    }

    #[test]
    fn highlighting_follows_edits_undo_and_reloads() {
        let (_, dir) = setup();
        let src = "Intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n```py\nx = 1\n```\n";
        let mut ed = Editor::new(src);
        let before = geo(&ed, &dir);
        let s0 = (code_spans(&before, 3), code_spans(&before, 4));
        // open a block comment on the first code line: both lines turn into a comment
        let at = src.find("const a").unwrap();
        ed.set_selection(Sel::caret(at));
        ed.insert_text("/*");
        let g = geo(&ed, &dir);
        assert!(code_spans(&g, 3).iter().any(|s| s.0.starts_with("/*") && s.2));
        assert!(code_spans(&g, 4).iter().all(|s| s.2), "{:?}", code_spans(&g, 4));
        // the python block didn't change
        assert_eq!(code_spans(&g, 8), code_spans(&before, 8));
        // undo puts it back
        assert!(ed.undo());
        let g = geo(&ed, &dir);
        assert_eq!((code_spans(&g, 3), code_spans(&g, 4)), s0.clone());
        // typing outside the blocks changes nothing in them
        ed.set_selection(Sel::caret(5));
        ed.insert_text(" more");
        let g = geo(&ed, &dir);
        assert_eq!((code_spans(&g, 3), code_spans(&g, 4)), s0.clone());
        // a reload (set_text) with a new block before: both coloured, the old one unchanged
        ed.set_text(&format!("```rust\nfn f() {{}}\n```\n{src}"));
        let g = geo(&ed, &dir);
        assert_eq!(find(&code_spans(&g, 1), "fn").1, c("#296d9a"));
        assert_eq!((code_spans(&g, 6), code_spans(&g, 7)), s0);
        // changing the language re-lexes the block
        let t = ed.text().replacen("```ts", "```python", 1);
        ed.set_text(&t);
        let g = geo(&ed, &dir);
        assert_ne!(code_spans(&g, 6), code_spans(&before, 3));
        // dropping the language leaves it plain
        let t = ed.text().replacen("```python", "```", 1);
        ed.set_text(&t);
        assert!(geo(&ed, &dir).lines[6].pieces[0].spans.is_empty());
    }

    #[test]
    fn notes_without_code_skip_highlighting() {
        let (ed, _) = setup();
        let views = ed.render_lines();
        assert!(crate::highlight::highlight(ed.text(), &views).is_empty());
    }

    /// Per-keystroke cost of a 500-line code block: `cargo test --release -p grimoire -- --ignored
    /// --nocapture typing_in_a_long_code_block`. Typing characters in the middle of the block, with
    /// the block's language (highlighted) and without (plain), each keystroke a whole `build` as in
    /// the app (the highlight part timed on its own too).
    #[test]
    #[ignore]
    fn typing_in_a_long_code_block() {
        use std::time::Instant;
        let (_, dir) = setup();
        let chunk = "export async function load(path: string, n = 3): Promise<Note[]> {\n  const text = await readFile(path, \"utf8\"); // read it\n  return text.split(/\\n/).map((l, i) => ({ i, l: l.trim() })).slice(0, n * 0x10);\n}\n\n";
        for lang in ["ts", ""] {
            let src = format!("# Long\n\n```{lang}\n{}```\n", chunk.repeat(100));
            let mut ed = Editor::new(&src);
            let t0 = Instant::now();
            geo(&ed, &dir);
            let first = t0.elapsed();
            ed.set_selection(Sel::caret(src.len() / 2));
            let (mut total, mut hl) = (0.0, 0.0);
            let n = 40;
            for _ in 0..n {
                ed.insert_text("x");
                let views = ed.render_lines();
                let t0 = Instant::now();
                crate::highlight::highlight(ed.text(), &views);
                hl += t0.elapsed().as_secs_f64();
                let t0 = Instant::now();
                build(ed.text(), &views, Some(&dir));
                total += t0.elapsed().as_secs_f64();
            }
            println!(
                "```{lang}: first build {:.1} ms; per keystroke: build {:.2} ms, of which highlight {:.3} ms",
                first.as_secs_f64() * 1e3,
                total / n as f64 * 1e3,
                hl / n as f64 * 1e3
            );
        }
    }
}
