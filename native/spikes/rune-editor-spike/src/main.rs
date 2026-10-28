//! Phase 0a spike: a Bear-like live-preview Markdown surface on Rune.
//!
//! Rune paints; we own the model and the geometry. Each paragraph is one `rich()` text element
//! (styled byte spans) placed absolutely at a y we computed ourselves with Parley, using the same
//! fonts, version and parameters Rune uses, so our hit testing and caret math match the pixels.
//! Keys come through `AppSpec::on_key` (consumed before any focused field), composed text
//! (dead keys, CJK) through `AppSpec::on_ime`, pointer through one `on_drag` on the editor
//! surface. Caret, selection and checkboxes are plain absolute rects.

use std::cell::{Cell, RefCell};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parley::editing::{Cursor, Selection};
use parley::fontique::{Blob, Collection, CollectionOptions, SourceCache};
use parley::layout::Affinity;
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, FontStyle, FontWeight, Layout, LayoutContext, LineHeight,
    StyleProperty,
};
use rune::text::Ink;
use rune::tok::Family;
use rune::{
    AppSpec, Color, Cx, Drag, El, FileDrop, Ime, Key, KeyEvent, Live, Phase, Shape, Span, TextStyle, Tx, Waker, col, el, rich, text,
};

const PAD: f32 = 28.0;
const TOP: f32 = 20.0;
/// Widest text column; narrower windows wrap to fit (`Cx::viewport`).
const MAX_W: f32 = 600.0;
const GAP: f32 = 8.0;

const BG: &str = "#141416";
const SURFACE: &str = "#1d1d20";
const TEXT: &str = "#e6e6e6";
const DIM: &str = "#5f5f66";
const CODE_FG: &str = "#ff9e7a";
const CODE_BG: &str = "#2c2c31";
const ACCENT: &str = "#4c9bff";

const INTER: [&[u8]; 3] = rune::text::DEFAULT_FONTS;

static FONTS: OnceLock<(&'static [&'static [u8]], &'static str)> = OnceLock::new();

thread_local! {
    static MEASURE: RefCell<Option<Measurer>> = const { RefCell::new(None) };
    /// Device scale of the last view (handlers run between views on the same thread).
    static SCALE: Cell<f32> = const { Cell::new(2.0) };
    /// Text column width of the last view, from the window width.
    static COL_W: Cell<f32> = const { Cell::new(MAX_W) };
}

fn c(hex: &str) -> Color {
    rune::color::hex(hex).unwrap()
}

// ------------------------------------------------------------------------------------------
// Parley, mirrored from rune::text::TextSystem::layout_rich (crates/rune/src/text.rs:439).

struct Measurer {
    fcx: FontContext,
    lcx: LayoutContext<Ink>,
}

impl Measurer {
    fn new(fonts: &[&'static [u8]]) -> Measurer {
        let mut collection = Collection::new(CollectionOptions { shared: false, system_fonts: false });
        for data in fonts {
            collection.register_fonts(Blob::new(Arc::new(*data)), None);
        }
        Measurer { fcx: FontContext { collection, source_cache: SourceCache::default() }, lcx: LayoutContext::new() }
    }

    fn layout(&mut self, text: &str, spans: &[Span], style: TextStyle, scale: f32, max_width: Option<f32>) -> Layout<Ink> {
        let mono = FONTS.get().unwrap().1;
        let sans = match style.family {
            Family::Sans => "Inter",
            Family::Mono => mono,
        };
        let mut b = self.lcx.ranged_builder(&mut self.fcx, text, scale, true);
        b.push_default(FontFamily::from(sans));
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
                b.push(FontFamily::from(mono), r.clone());
            }
            if let Some(w) = s.weight {
                b.push(StyleProperty::FontWeight(FontWeight::new(w)), r.clone());
            }
            if let Some(sz) = s.size {
                b.push(StyleProperty::FontSize(sz), r.clone());
            }
            if s.italic {
                b.push(StyleProperty::FontStyle(FontStyle::Italic), r.clone());
            }
        }
        let mut layout: Layout<Ink> = b.build(text);
        layout.break_all_lines(max_width);
        layout.align(Alignment::Start, AlignmentOptions::default());
        layout
    }
}

fn measure(text: &str, spans: &[Span], style: TextStyle, scale: f32, max_width: Option<f32>) -> Layout<Ink> {
    MEASURE.with(|m| {
        let mut m = m.borrow_mut();
        let m = m.get_or_insert_with(|| Measurer::new(FONTS.get().unwrap().0));
        m.layout(text, spans, style, scale, max_width)
    })
}

// ------------------------------------------------------------------------------------------
// Markdown line -> display text + spans + index maps

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Heading,
    Task(bool),
    Para,
}

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Text,
    /// Inline marker (`**`, `` ` ``): dim on the caret line, hidden elsewhere.
    Marker,
    /// Heading `# `: always shown, dim.
    BlockMarker,
    /// `- [ ] `: dim on the caret line, replaced by a drawn checkbox elsewhere.
    TaskMarker,
    Bold,
    Italic,
    Code,
}

struct Disp {
    text: String,
    spans: Vec<Span>,
    style: TextStyle,
    /// Left offset in points inside the text column (room for the checkbox).
    x: f32,
    /// Display byte -> raw byte (len + 1 entries).
    d2r: Vec<usize>,
    /// Raw byte -> display byte (len + 1 entries); hidden bytes map to where they would be.
    r2d: Vec<usize>,
    kind: Kind,
}

fn display(raw: &str, reveal: bool, preedit: Option<(usize, usize)>) -> Disp {
    let mut segs: Vec<(usize, usize, Role)> = Vec::new();
    let mut kind = Kind::Para;
    let mut i = 0;
    let hashes = raw.bytes().take_while(|&b| b == b'#').count();
    if (1..=6).contains(&hashes) && raw.as_bytes().get(hashes) == Some(&b' ') {
        kind = Kind::Heading;
        segs.push((0, hashes + 1, Role::BlockMarker));
        i = hashes + 1;
    } else if raw.starts_with("- [ ] ") || raw.starts_with("- [x] ") {
        kind = Kind::Task(raw.as_bytes()[3] == b'x');
        segs.push((0, 6, Role::TaskMarker));
        i = 6;
    }
    let mut text_start = i;
    while i < raw.len() {
        let rest = &raw[i..];
        let pair = if rest.starts_with("**") {
            raw[i + 2..].find("**").filter(|&j| j > 0).map(|j| (2, i + 2 + j, Role::Bold))
        } else if rest.starts_with('*') {
            raw[i + 1..].find('*').filter(|&j| j > 0).map(|j| (1, i + 1 + j, Role::Italic))
        } else if rest.starts_with('`') {
            raw[i + 1..].find('`').filter(|&j| j > 0).map(|j| (1, i + 1 + j, Role::Code))
        } else {
            None
        };
        if let Some((m, close, role)) = pair {
            if text_start < i {
                segs.push((text_start, i, Role::Text));
            }
            segs.push((i, i + m, Role::Marker));
            segs.push((i + m, close, role));
            segs.push((close, close + m, Role::Marker));
            i = close + m;
            text_start = i;
            continue;
        }
        i += rest.chars().next().unwrap().len_utf8();
    }
    if text_start < raw.len() {
        segs.push((text_start, raw.len(), Role::Text));
    }

    let mut text = String::with_capacity(raw.len());
    let mut spans = Vec::new();
    let mut d2r = Vec::with_capacity(raw.len() + 1);
    let mut r2d = vec![0; raw.len() + 1];
    let mut hidden_task = false;
    for &(a, b, role) in &segs {
        let visible = match role {
            Role::Marker => reveal,
            Role::TaskMarker => {
                hidden_task = !reveal;
                reveal
            }
            _ => true,
        };
        let ds = text.len();
        if !visible {
            for r in a..b {
                r2d[r] = ds;
            }
            continue;
        }
        text.push_str(&raw[a..b]);
        for k in 0..b - a {
            r2d[a + k] = ds + k;
            d2r.push(a + k);
        }
        let de = text.len();
        let mut span = Span::new(ds, de);
        match role {
            Role::Text => continue,
            Role::Marker | Role::BlockMarker | Role::TaskMarker => span.color = Some(c(DIM)),
            Role::Bold => span.weight = Some(600.0),
            Role::Italic => span.italic = true,
            Role::Code => {
                span.mono = true;
                span.color = Some(c(CODE_FG));
                span.bg = Some(c(CODE_BG));
                span.bg_pad = 2.0;
            }
        }
        spans.push(span);
    }
    r2d[raw.len()] = text.len();
    d2r.push(raw.len());
    // Text the input method is composing, spliced in at the caret: underlined (a later span
    // takes the brush, so it draws the underline; weight and family from earlier spans stay).
    if let Some((a, b)) = preedit {
        spans.push(Span { underline: Some(c(TEXT)), ..Span::new(r2d[a], r2d[b]) });
    }
    let style = match kind {
        Kind::Heading => TextStyle::new(28.0, 600.0).lh(36.0),
        _ => TextStyle::new(16.0, 400.0).lh(24.0),
    };
    Disp { text, spans, style, x: if hidden_task { 26.0 } else { 0.0 }, d2r, r2d, kind }
}

// ------------------------------------------------------------------------------------------
// Model

type Pos = (usize, usize);

struct Ed {
    lines: Vec<String>,
    focus: Pos,
    anchor: Pos,
    /// Sticky x for up/down, in text-column points.
    goal_x: Option<f32>,
    blink: Live<f32>,
    /// Input-method composition at the caret: text and its cursor (bytes within it).
    preedit: Option<(String, usize)>,
    /// Where dragged-in files would land (a drop caret), while they hover the surface.
    drop_at: Option<Pos>,
}

fn init() -> Ed {
    let lines = [
        "# Grimoire spike",
        "Some **bold** text and `inline code` with dim markers.",
        "Hidden markers: **this is bold** and `code` until the caret arrives.",
        "- [ ] a task with **bold** in it",
        "- [x] a finished task",
        "A long paragraph that wraps across several visual lines, so up and down have to move within one paragraph using Parley line geometry, which is the *interesting case* for an editor.",
    ];
    Ed {
        lines: lines.iter().map(|s| s.to_string()).collect(),
        focus: (1, 5),
        anchor: (1, 5),
        goal_x: None,
        blink: Live::new(1.0),
        preedit: None,
        drop_at: None,
    }
}

impl Ed {
    fn sel(&self) -> (Pos, Pos) {
        if self.anchor <= self.focus { (self.anchor, self.focus) } else { (self.focus, self.anchor) }
    }

    fn set(&mut self, p: Pos, extend: bool) {
        self.focus = p;
        if !extend {
            self.anchor = p;
        }
    }

    fn selected_text(&self) -> String {
        let (a, b) = self.sel();
        if a.0 == b.0 {
            return self.lines[a.0][a.1..b.1].to_string();
        }
        let mut s = self.lines[a.0][a.1..].to_string();
        for l in &self.lines[a.0 + 1..b.0] {
            s.push('\n');
            s.push_str(l);
        }
        s.push('\n');
        s.push_str(&self.lines[b.0][..b.1]);
        s
    }

    fn delete_sel(&mut self) -> bool {
        if self.anchor == self.focus {
            return false;
        }
        let (a, b) = self.sel();
        if a.0 == b.0 {
            self.lines[a.0].replace_range(a.1..b.1, "");
        } else {
            let tail = self.lines[b.0][b.1..].to_string();
            self.lines[a.0].truncate(a.1);
            self.lines[a.0].push_str(&tail);
            self.lines.drain(a.0 + 1..=b.0);
        }
        self.set(a, false);
        true
    }

    fn insert(&mut self, s: &str) {
        self.delete_sel();
        let (mut l, c) = self.focus;
        let tail = self.lines[l].split_off(c);
        let mut parts = s.split('\n');
        self.lines[l].push_str(parts.next().unwrap_or(""));
        for p in parts {
            l += 1;
            self.lines.insert(l, p.to_string());
        }
        let c = self.lines[l].len();
        self.lines[l].push_str(&tail);
        self.set((l, c), false);
    }

    fn prev(&self, (l, c): Pos) -> Pos {
        if c > 0 {
            (l, self.lines[l][..c].char_indices().next_back().map_or(0, |(i, _)| i))
        } else if l > 0 {
            (l - 1, self.lines[l - 1].len())
        } else {
            (0, 0)
        }
    }

    fn next(&self, (l, c): Pos) -> Pos {
        let line = &self.lines[l];
        if c < line.len() {
            (l, c + line[c..].chars().next().unwrap().len_utf8())
        } else if l + 1 < self.lines.len() {
            (l + 1, 0)
        } else {
            (l, c)
        }
    }

    fn word_at(&self, (l, c): Pos) -> (usize, usize) {
        let line = &self.lines[l];
        let is_word = |ch: char| ch.is_alphanumeric() || ch == '_';
        let a = line[..c].char_indices().rev().take_while(|&(_, ch)| is_word(ch)).last().map_or(c, |(i, _)| i);
        let b = line[c..].char_indices().find(|&(_, ch)| !is_word(ch)).map_or(line.len(), |(i, _)| c + i);
        (a, b)
    }
}

// ------------------------------------------------------------------------------------------
// Geometry (points, relative to the text column origin)

struct LineGeo {
    y: f32,
    h: f32,
    d: Disp,
    layout: Layout<Ink>,
}

fn geometry(ed: &Ed) -> Vec<LineGeo> {
    let s = SCALE.get();
    let w = COL_W.get();
    let mut y = 0.0;
    ed.lines
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let d = match &ed.preedit {
                Some((p, _)) if i == ed.focus.0 => {
                    let at = ed.focus.1;
                    let spliced = format!("{}{p}{}", &raw[..at], &raw[at..]);
                    display(&spliced, true, Some((at, at + p.len())))
                }
                _ => display(raw, i == ed.focus.0, None),
            };
            let layout = measure(&d.text, &d.spans, d.style, s, Some((w - d.x) * s));
            // rune::text::layout_height (text.rs:652), back in points.
            let h = layout.height().max(d.style.line_px() * s).ceil() / s;
            let g = LineGeo { y, h, d, layout };
            y += h + GAP;
            g
        })
        .collect()
}

/// Caret rect [x, y, w, h] for a raw byte index on line `g`.
fn caret_rect(g: &LineGeo, raw: usize) -> [f32; 4] {
    let s = SCALE.get();
    let di = g.d.r2d[raw.min(g.d.r2d.len() - 1)];
    let bb = Cursor::from_byte_index(&g.layout, di, Affinity::Downstream).geometry(&g.layout, 2.0 * s);
    let h = ((bb.y1 - bb.y0) as f32 / s).max(1.0);
    let h = if h < 2.0 { g.d.style.line_px() } else { h };
    [g.d.x + bb.x0 as f32 / s, g.y + bb.y0 as f32 / s, 2.0, h]
}

fn hit(geo: &[LineGeo], x: f32, y: f32) -> Pos {
    let s = SCALE.get();
    let i = geo.iter().position(|g| y < g.y + g.h + GAP).unwrap_or(geo.len() - 1);
    let g = &geo[i];
    let ly = (y - g.y).clamp(0.0, (g.h - 0.5).max(0.0));
    let cur = Cursor::from_point(&g.layout, (x - g.d.x) * s, ly * s);
    (i, g.d.d2r[cur.index().min(g.d.text.len())])
}

fn vertical(ed: &mut Ed, down: bool, extend: bool) {
    let geo = geometry(ed);
    let r = caret_rect(&geo[ed.focus.0], ed.focus.1);
    let x = *ed.goal_x.get_or_insert(r[0]);
    let y = if down { r[1] + r[3] + GAP + 1.0 } else { r[1] - 1.0 };
    let last = geo.len() - 1;
    let p = if y < 0.0 {
        (0, 0)
    } else if y >= geo[last].y + geo[last].h {
        (last, ed.lines[last].len())
    } else {
        hit(&geo, x, y)
    };
    ed.set(p, extend);
}

// ------------------------------------------------------------------------------------------
// Input

fn on_key(ed: &mut Ed, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let m = ev.mods;
    let ext = m.shift;
    let (l, col) = ed.focus;
    match &ev.key {
        Key::Text(s) => {
            if m.ctrl || s.chars().all(char::is_control) {
                return false;
            }
            ed.insert(s);
        }
        Key::Enter => {
            let task = ed.lines[l].starts_with("- [") && ed.lines[l].len() > 6;
            ed.insert(if task { "\n- [ ] " } else { "\n" });
        }
        Key::Tab => ed.insert("    "),
        Key::Backspace => {
            if !ed.delete_sel() {
                let p = ed.prev(ed.focus);
                if p != ed.focus {
                    ed.anchor = p;
                    ed.delete_sel();
                }
            }
        }
        Key::Delete => {
            if !ed.delete_sel() {
                let n = ed.next(ed.focus);
                if n != ed.focus {
                    ed.anchor = n;
                    ed.delete_sel();
                }
            }
        }
        Key::Left | Key::Right => {
            let right = ev.key == Key::Right;
            let (a, b) = ed.sel();
            if !ext && a != b {
                ed.set(if right { b } else { a }, false);
            } else {
                let p = if m.cmd {
                    (l, if right { ed.lines[l].len() } else { 0 })
                } else if m.alt {
                    let (wa, wb) = ed.word_at(ed.focus);
                    if right && wb > col { (l, wb) } else if !right && wa < col { (l, wa) } else if right { ed.next(ed.focus) } else { ed.prev(ed.focus) }
                } else if right {
                    ed.next(ed.focus)
                } else {
                    ed.prev(ed.focus)
                };
                ed.set(p, ext);
            }
        }
        Key::Up | Key::Down => {
            if m.cmd {
                let last = ed.lines.len() - 1;
                let p = if ev.key == Key::Down { (last, ed.lines[last].len()) } else { (0, 0) };
                ed.set(p, ext);
            } else {
                vertical(ed, ev.key == Key::Down, ext);
            }
        }
        Key::Home => ed.set((l, 0), ext),
        Key::End => ed.set((l, ed.lines[l].len()), ext),
        Key::PageUp => ed.set((0, 0), ext),
        Key::PageDown => {
            let last = ed.lines.len() - 1;
            ed.set((last, ed.lines[last].len()), ext)
        }
        Key::Escape => ed.anchor = ed.focus,
        Key::Command('a') => {
            let last = ed.lines.len() - 1;
            ed.anchor = (0, 0);
            ed.focus = (last, ed.lines[last].len());
        }
        Key::Command('c') => tx.copy(ed.selected_text()),
        Key::Command('x') => {
            tx.copy(ed.selected_text());
            ed.delete_sel();
        }
        Key::Command('v') => {
            if let Some(t) = arboard::Clipboard::new().ok().and_then(|mut cb| cb.get_text().ok()) {
                ed.insert(&t.replace("\r\n", "\n"));
            }
        }
        _ => return false,
    }
    if !matches!(ev.key, Key::Up | Key::Down) {
        ed.goal_x = None;
    }
    ed.blink.set(1.0);
    tx.instant();
    true
}

fn on_drag(ed: &mut Ed, d: &mut Drag, tx: &mut Tx) {
    let geo = geometry(ed);
    let (x, y) = (d.x - PAD, d.y - TOP);
    let p = hit(&geo, x, y);
    match d.phase {
        Phase::Down => {
            let g = &geo[p.0];
            if let Kind::Task(done) = g.d.kind
                && g.d.x > 0.0
                && x < g.d.x
                && y >= g.y
                && y < g.y + g.h
            {
                ed.lines[p.0].replace_range(3..4, if done { " " } else { "x" });
                d.data = -1.0;
                tx.instant();
                return;
            }
            // Rune counts clicks (system double-click interval, 4 pt) and reports modifiers.
            ed.preedit = None;
            let count = d.clicks.min(3);
            d.data = count as f32;
            match count {
                1 => ed.set(p, d.mods.shift),
                2 => {
                    let (a, b) = ed.word_at(p);
                    ed.anchor = (p.0, a);
                    ed.focus = (p.0, b);
                }
                _ => {
                    ed.anchor = (p.0, 0);
                    ed.focus = (p.0, ed.lines[p.0].len());
                }
            }
        }
        // Revealing markers on click shifts the text under a still pointer, so only a real
        // movement extends (pointer_up also sends a Move at the release point).
        Phase::Move if d.data == 1.0 && (d.x != d.start_x || d.y != d.start_y) => ed.focus = p,
        _ => {}
    }
    ed.goal_x = None;
    ed.blink.set(1.0);
    tx.instant();
}

/// Files dragged in from Finder: a drop caret follows the pointer; the drop inserts Markdown
/// image links there. Rune gives surface-local points as scrolled, like `on_drag`.
fn on_file_drop(ed: &mut Ed, ev: &FileDrop, tx: &mut Tx) {
    eprintln!("file drop: {ev:?}");
    let at = ev.pos().map(|(x, y)| hit(&geometry(ed), x - PAD, y - TOP));
    match ev {
        FileDrop::Hover { .. } => ed.drop_at = at,
        FileDrop::Cancel => ed.drop_at = None,
        FileDrop::Drop { paths, .. } => {
            ed.drop_at = None;
            let Some(p) = at else { return };
            let md: Vec<String> = paths
                .iter()
                .map(|p| {
                    let alt = p.file_stem().map_or(String::new(), |s| s.to_string_lossy().into_owned());
                    let url = p.display().to_string();
                    // CommonMark: a destination with spaces goes in angle brackets.
                    if url.contains(' ') { format!("![{alt}](<{url}>)") } else { format!("![{alt}]({url})") }
                })
                .collect();
            ed.preedit = None;
            ed.set(p, false);
            ed.insert(&md.join(" "));
            ed.goal_x = None;
            ed.blink.set(1.0);
        }
    }
    tx.instant();
}

/// Composed text from the input method. Plain typing arrives through `on_key`; this gets
/// dead keys (Option-E then E), the accent picker and CJK.
fn on_ime(ed: &mut Ed, ev: &Ime, tx: &mut Tx) -> bool {
    match ev {
        Ime::Preedit(p, cur) => {
            ed.delete_sel();
            ed.preedit = (!p.is_empty()).then(|| (p.clone(), cur.map_or(p.len(), |c| c.1)));
        }
        Ime::Commit(s) => {
            ed.preedit = None;
            ed.insert(s);
        }
        Ime::Enabled => {}
        Ime::Disabled => ed.preedit = None,
    }
    ed.goal_x = None;
    ed.blink.set(1.0);
    tx.instant();
    true
}

// ------------------------------------------------------------------------------------------
// View

fn view(ed: &Ed, cx: &mut Cx<Ed>) -> El {
    let s = cx.env().scale;
    SCALE.set(s);
    // Root padding 24 on each side, surface padding PAD on each side.
    COL_W.set((cx.viewport().0 - 48.0 - PAD * 2.0).clamp(200.0, MAX_W));
    let w = COL_W.get();
    let geo = geometry(ed);
    let total = geo.last().map_or(0.0, |g| g.y + g.h);
    let mut surface = el()
        .key("surface")
        .w(PAD * 2.0 + w)
        .h(TOP * 2.0 + total)
        .fill(c(SURFACE))
        .radius(10.0)
        .cursor(rune::Cursor::Text)
        .on_drag(on_drag)
        .on_file_drop(on_file_drop);

    // Selection under the text.
    let (a, b) = ed.sel();
    if a != b {
        for i in a.0..=b.0 {
            let g = &geo[i];
            let ra = if i == a.0 { a.1 } else { 0 };
            let rb = if i == b.0 { b.1 } else { ed.lines[i].len() };
            let sel = Selection::new(
                Cursor::from_byte_index(&g.layout, g.d.r2d[ra], Affinity::Downstream),
                Cursor::from_byte_index(&g.layout, g.d.r2d[rb], Affinity::Upstream),
            );
            let mut rects = sel.geometry(&g.layout);
            if i != b.0 {
                // The newline: a sliver after the last visual line of a fully crossed paragraph.
                let r = caret_rect(g, rb);
                surface = surface.child(
                    el().key(format!("nl{i}")).absolute(PAD + r[0], TOP + r[1]).size(6.0, r[3]).fill(c(ACCENT).alpha(0.35)),
                );
            }
            for (k, (bb, _)) in rects.drain(..).enumerate() {
                surface = surface.child(
                    el().key(format!("sel{i}-{k}"))
                        .absolute(PAD + g.d.x + bb.x0 as f32 / s, TOP + g.y + bb.y0 as f32 / s)
                        .size((bb.x1 - bb.x0) as f32 / s, (bb.y1 - bb.y0) as f32 / s)
                        .fill(c(ACCENT).alpha(0.35)),
                );
            }
        }
    }

    for (i, g) in geo.iter().enumerate() {
        if let Kind::Task(done) = g.d.kind
            && g.d.x > 0.0
        {
            let top = TOP + g.y + (g.d.style.line_px() - 15.0) / 2.0;
            let mut b = el().key(format!("box{i}")).absolute(PAD + 2.0, top).size(15.0, 15.0).radius(4.0);
            b = if done {
                b.fill(c(ACCENT)).shape(Shape::new().stroke(vec![[3.5, 7.5], [6.5, 10.5], [11.5, 4.5]], 2.0, Color::WHITE))
            } else {
                b.border(1.5, c(DIM))
            };
            surface = surface.child(b);
        }
        surface = surface.child(
            rich(g.d.text.clone(), g.d.spans.clone())
                .key(format!("line{i}"))
                .font(g.d.style)
                .color(if g.d.kind == Kind::Task(true) { c(TEXT).alpha(0.5) } else { c(TEXT) })
                .w(w - g.d.x)
                .absolute(PAD + g.d.x, TOP + g.y),
        );
    }

    let caret = ed.focus.1 + ed.preedit.as_ref().map_or(0, |p| p.1);
    let r = caret_rect(&geo[ed.focus.0], caret);
    surface = surface.child(
        el().key("caret")
            .absolute(PAD + r[0], TOP + r[1])
            .size(r[2], r[3])
            .fill(c(ACCENT))
            .live_opacity(&ed.blink)
            .ime_cursor(),
    );

    if let Some(p) = ed.drop_at {
        let r = caret_rect(&geo[p.0], p.1);
        surface = surface.child(
            el().key("drop-caret").absolute(PAD + r[0] - 1.0, TOP + r[1]).size(r[2] + 2.0, r[3]).fill(c(ACCENT).alpha(0.6)).radius(1.5),
        );
    }

    let status = format!(
        "caret {}:{}   anchor {}:{}   lines {}{}{}   (click, shift-click, arrows, type, ⌥E E, enter, cmd-a/c/x/v)",
        ed.focus.0,
        ed.focus.1,
        ed.anchor.0,
        ed.anchor.1,
        ed.lines.len(),
        ed.preedit.as_ref().map_or(String::new(), |p| format!("   preedit {:?}", p.0)),
        ed.drop_at.map_or(String::new(), |p| format!("   drop {}:{}", p.0, p.1)),
    );
    col()
        .key("root")
        .w_full()
        .h_full()
        .fill(c(BG))
        .padding(24.0)
        .gap(12.0)
        .child(text(status).key("status").font(TextStyle::new(12.0, 500.0)).color(c(DIM)))
        .child(if rune::extra_args().iter().any(|a| a == "--scroll") {
            // Experiment: the surface inside a Rune scroll viewport (see docs, Drag coordinates).
            col().key("viewport").h(180.0).w(PAD * 2.0 + w).scroll(rune::ScrollSpec { stick_bottom: false }).child(surface)
        } else {
            surface
        })
}

fn setup(ed: &mut Ed, _wake: Waker) {
    let headless = std::env::args().any(|a| matches!(a.as_str(), "--snap" | "--tree" | "--frames" | "--strip" | "--trace"));
    if headless {
        return;
    }
    // Live values repaint without rebuilding the view (crates/rune/src/live.rs).
    let blink = ed.blink.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(530));
            blink.set(if blink.get() > 0.5 { 0.0 } else { 1.0 });
        }
    });
}

fn main() {
    let menlo: Option<&'static [u8]> =
        std::fs::read("/System/Library/Fonts/Menlo.ttc").ok().map(|v| &*Box::leak(v.into_boxed_slice()));
    let mut list: Vec<&'static [u8]> = INTER.to_vec();
    list.extend(menlo);
    // `--italic-font`: the real Inter Italic (fonts/Inter-Italic.ttf, from the Inter 4.1
    // release, not committed) instead of Rune's synthesized oblique.
    if std::env::args().any(|a| a == "--italic-font") {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fonts/Inter-Italic.ttf");
        let italic = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        list.push(Box::leak(italic.into_boxed_slice()));
    }
    let fonts: &'static [&'static [u8]] = Box::leak(list.into_boxed_slice());
    let mono = if menlo.is_some() { "Menlo" } else { "Inter" };
    FONTS.set((fonts, mono)).ok();

    rune::run(AppSpec {
        title: "Rune editor spike",
        size: (760.0, 560.0),
        min_size: None,
        init,
        view,
        scenes: &[
            ("default", |_| {}),
            ("selection", |ed| {
                ed.anchor = (1, 10);
                ed.focus = (5, 40);
            }),
            ("caret-end-of-wrap", |ed| {
                ed.focus = (5, 120);
                ed.anchor = (5, 120);
            }),
        ],
        fonts,
        families: ("Inter", if menlo.is_some() { "Menlo" } else { "Inter" }),
        setup: Some(setup),
        poll: None,
        on_key: Some(on_key),
        on_ime: Some(on_ime),
        on_file_drop: None,
    });
}
