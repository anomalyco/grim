//! The view: the sidebar (`sidebar`) beside the page, whose `LineView`s (laid out by `layout`)
//! become Rune elements.
//!
//! Paint order inside the surface (which takes the mouse, see `input::surface_drag`): block
//! backgrounds (code blocks, quote bars, table rules, rules), gutter glyphs (bullets, numbers,
//! checkboxes, heading labels), one `rich()` element per text piece (IME marked text spliced in
//! at the caret), strikethrough rules, images (or their placeholders) where layout put them, the
//! selection (translucent, above the text so it shows over code backgrounds), the caret.

use editor_core::{BlockType, TokenKind};
use rune::{Align, Color, Cursor, Cx, Drag, El, LineCap, ScrollSpec, Shape, TextStyle, Tx, col, el, rich, row, text};

use crate::App;
use crate::drop;
use crate::input;
use crate::sidebar;
use crate::switcher;
use crate::layout::{self, Geo, ImgKind, SCALE, col_w};
use crate::theme::*;

pub fn view(app: &App, cx: &mut Cx<App>) -> El {
    SCALE.set(cx.env().scale);
    // The root fills the window; its size is right from the first frame (Rune settles layout reads).
    let [vw, vh] = cx.layout_size("root").unwrap_or([820.0, 720.0]);
    crate::images::next_view();
    sidebar::set_window_w(vw);
    let side = sidebar::shown(app, vw);
    let x0 = if side { SIDEBAR_W } else { 0.0 };
    let ew = vw - x0;
    layout::set_viewport(ew, vh);
    let editor = if let Some((title, detail, fixes)) = app.problem_page() {
        problem_page(title, detail, &fixes, ew)
    } else if app.remote.as_ref().is_some_and(|r| !r.loaded) {
        loading_page(app)
    } else if app.root.is_some() && app.path.is_none() {
        empty_state()
    } else {
        editor(app)
    };
    // Clipped to its own area: nothing slides under the sidebar (the column squeezes down to
    // MIN_TEXT_W beside it, and wide tables or code can still be wider than that).
    let mut root =
        el().key("root").w_full().h_full().fill(c(PAPER)).child(col().key("editor").absolute(x0, 0.0).w(ew).h_full().clip_soft(0.0).child(editor));
    if side {
        root = root.child(sidebar::view(app).absolute(0.0, 0.0));
    }
    if let Some(msg) = app.remote_status() {
        root = root.child(row().key("status-row").absolute(x0, 7.0).w(ew - 14.0).h(30.0).gap(8.0).center_y().justify_end().child(switcher::status_pill(&msg)));
    }
    if side && app.switcher.open {
        for e in switcher::menu(app, vw, vh) {
            root = root.child(e);
        }
    }
    if side && app.switcher.account_open {
        for e in switcher::account_menu(app, vw, vh) {
            root = root.child(e);
        }
    }
    for e in crate::dialogs::overlay(app, vw, vh) {
        root = root.child(e);
    }
    if let Some(msg) = &app.toast {
        root = root.child(toast(msg, &app.toast_alpha).absolute(x0, (vh - 64.0).max(0.0)).w(ew));
    }
    root
}

/// A short message centred at the bottom of the page ("No note at …").
fn toast(msg: &str, alpha: &rune::Live<f32>) -> El {
    row().key("toast-row").h(32.0).center().child(
        row()
            .key("toast")
            .h(32.0)
            .px(14.0)
            .center()
            .fill(c(INK))
            .radius(8.0)
            .live_opacity(alpha)
            .child(text(msg.to_string()).key("toast-text").font(TextStyle::new(13.5, 500.0).lh(18.0)).color(c(PAPER))),
    )
}

/// The scrolling page: a centred surface the width of the column (hits are relative to it, so the
/// sidebar's offset doesn't matter).
fn editor(app: &App) -> El {
    let mut geo = app.geometry();
    let sel = app.ed.selection();
    let marked = app.marked.as_ref().filter(|_| !app.filter.focused).and_then(|(m, cur)| geo.splice_marked(sel.from(), m, *cur));
    let mut kids: Vec<El> = Vec::new();
    blocks(&geo, &mut kids);
    gutter(&geo, &mut kids);
    folds(app, &geo, &mut kids);
    texts(&geo, &mut kids);
    images(&geo, &mut kids);
    links(app, &geo, &mut kids);
    remote_cursors(app, &geo, &mut kids);
    selection_and_caret(app, &geo, marked, &mut kids);

    let surface = el()
        .key("surface")
        .w(layout::surface_w())
        .h(PAD_T + geo.height + PAD_B)
        .cursor(Cursor::Text)
        .on_drag(input::surface_drag)
        .on_hover(|app: &mut App| {
            app.fold_hover = None;
            app.pencil_hover = None;
        })
        .on_drop_files(drop::on_drop_files)
        .accepts_files(drop::is_image)
        .on_drop_move(drop::on_drop_move)
        .on_drop_hover(drop::on_drop_hover)
        .children(kids);
    col()
        .key("scroll")
        .w_full()
        .h_full()
        .scroll(ScrollSpec { stick_bottom: false })
        .scroll_margin(CARET_MARGIN)
        .child(col().key("content").w_full().center_y().child(surface))
}

/// A folder with no notes.
/// Why a remote workspace can't show, and the buttons that fix it (Reconnect, Switch account, Retry
/// now, Remove…).
fn problem_page(title: String, detail: String, fixes: &[crate::remote::Fix], ew: f32) -> El {
    let w = (ew - 80.0).clamp(240.0, 440.0);
    let mut buttons = row().key("problem-actions").gap(10.0).pt(10.0);
    for (i, f) in fixes.iter().enumerate() {
        let f = *f;
        let primary = i == 0;
        buttons = buttons.child(
            row()
                .key(format!("problem-fix-{i}"))
                .label(f.label())
                .h(30.0)
                .px(14.0)
                .center()
                .radius(7.0)
                .fill(c(if primary { INK } else { BG2 }))
                .hover(c(if primary { INK_LIGHT } else { TINT_ACTIVE }))
                .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
                    if d.phase == rune::Phase::Down {
                        app.apply_fix(f, tx);
                    }
                })
                .child(text(f.label()).key(format!("problem-fix-{i}-text")).font(TextStyle::new(13.5, 500.0).lh(18.0)).color(c(if primary { PAPER } else { INK }))),
        );
    }
    col()
        .key("problem")
        .w_full()
        .h_full()
        .center()
        .child(
            col()
                .key("problem-box")
                .w(w)
                .gap(6.0)
                .child(text(title).key("problem-title").font(TextStyle::new(17.0, 600.0).lh(22.0)).color(c(INK)).w(w).wrap())
                .child(text(detail).key("problem-detail").font(TextStyle::new(13.5, 400.0).lh(19.0)).color(c(MUTED)).w(w).wrap())
                .child(buttons),
        )
}

/// A remote workspace on its way: which one, and where.
fn loading_page(app: &App) -> El {
    let (name, loc) = app.current.as_ref().map_or_else(|| (String::new(), String::new()), |w| (w.name(), w.location()));
    let what = if app.switcher.busy.is_some() { format!("Waiting for the browser to connect to {loc}…") } else { format!("Loading from {loc}…") };
    col()
        .key("loading")
        .w_full()
        .h_full()
        .center()
        .gap(6.0)
        .child(text(name).key("loading-title").font(TextStyle::new(15.0, 600.0).lh(20.0)).color(c(INK)))
        .child(text(what).key("loading-hint").font(TextStyle::new(13.5, 400.0).lh(18.0)).color(c(MUTED)))
}

fn empty_state() -> El {
    col()
        .key("empty")
        .w_full()
        .h_full()
        .center()
        .gap(6.0)
        .child(text("No notes yet").key("empty-title").font(TextStyle::new(15.0, 600.0).lh(20.0)).color(c(INK)))
        .child(text("Press ⌘N to start one.").key("empty-hint").font(TextStyle::new(13.5, 400.0).lh(18.0)).color(c(MUTED)))
}

fn rect(key: String, x: f32, y: f32, w: f32, h: f32) -> El {
    el().key(key).absolute(PAD_L + x, PAD_T + y).size(w, h)
}

fn blocks(geo: &Geo, kids: &mut Vec<El>) {
    let lines = &geo.lines;
    let mut i = 0;
    while i < lines.len() {
        let l = &lines[i];
        if l.view.hidden_by_fold {
            i += 1;
            continue;
        }
        if l.view.code.is_some() {
            let mut j = i;
            while j < lines.len() && lines[j].view.code.is_some() && !(j > i && lines[j].view.code.as_ref().unwrap().first) {
                j += 1;
            }
            let bottom = lines[j - 1].top + lines[j - 1].h;
            kids.push(rect(format!("code{i}"), 0.0, l.top, col_w(), bottom - l.top).fill(c(CODE_BG)).radius(6.0));
            // diff/patch lines: their background across the block
            for (k, line) in lines.iter().enumerate().take(j).skip(i) {
                if let Some(bg) = line.code_bg.filter(|_| line.drawn()) {
                    kids.push(rect(format!("codebg{k}"), 0.0, line.top, col_w(), line.h).fill(bg));
                }
            }
            i = j;
            continue;
        }
        if l.view.kind == BlockType::Quote {
            let mut j = i;
            while j < lines.len() && lines[j].view.kind == BlockType::Quote && lines[j].view.indent == l.view.indent {
                j += 1;
            }
            let bottom = lines[j - 1].top + lines[j - 1].h;
            let x = l.view.indent as f32 * GUTTER + 12.0;
            kids.push(rect(format!("quote{i}"), x, l.top + 2.4, 3.0, bottom - l.top - 4.8).fill(c(STROKE)).radius(2.0));
            i = j;
            continue;
        }
        if l.view.kind == BlockType::Hr {
            kids.push(rect(format!("hr{i}"), 0.0, (l.top + l.h / 2.0).round(), col_w() - 2.0, 1.0).fill(c(STROKE)));
        }
        if !l.cols.is_empty() && l.drawn() {
            let w = l.cols.last().map_or(col_w(), |c| c.1 - CELL_PAD_R);
            let color = if l.view.kind == BlockType::TableHead { HEAD_RULE } else { BG2 };
            kids.push(rect(format!("trule{i}"), 0.0, l.top + l.h - 1.0, w, 1.0).fill(c(color)));
        }
        i += 1;
    }
}

fn gutter(geo: &Geo, kids: &mut Vec<El>) {
    for (li, l) in geo.lines.iter().enumerate() {
        if !l.drawn() {
            continue;
        }
        let (vt, vb) = l.first_vline();
        let mid = (vt + vb) / 2.0;
        let style = l.pieces.first().map_or(body(), |p| p.style);
        let color = if l.view.kind == BlockType::Quote { c(INK_LIGHT) } else { c(INK) };
        for t in &l.toks {
            match t.kind {
                TokenKind::Bullet => {
                    kids.push(rect(format!("bul{li}"), t.x0 + GUTTER / 2.0 - 2.5, (mid - 2.5).round(), 5.0, 5.0).fill(color));
                }
                TokenKind::Numbered => {
                    kids.push(
                        text(t.text.clone())
                            .key(format!("num{li}"))
                            .font(style)
                            .color(color)
                            .w(GUTTER - (style.size * 0.4).round())
                            .align(Align::End)
                            .absolute(PAD_L + t.x0, PAD_T + vt),
                    );
                }
                TokenKind::Todo => {
                    let line = li;
                    let mut b = rect(format!("cb{li}"), t.x0 + (GUTTER - 14.0) / 2.0, (mid - 7.0).round(), 14.0, 14.0)
                        .radius(3.0)
                        .cursor(Cursor::Pointer)
                        .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| input::checkbox_drag(s, d, tx, line));
                    b = if l.view.checked {
                        b.fill(c(INK)).shape(Shape::new().stroke(vec![[3.6, 7.2], [6.0, 9.6], [10.6, 4.4]], 2.0, c(PAPER)))
                    } else {
                        b.border(1.5, c(INK))
                    };
                    kids.push(b);
                }
                TokenKind::Heading if l.view.active => {
                    kids.push(
                        text(format!("H{}", l.view.level))
                            .key(format!("hl{li}"))
                            .font(TextStyle::new(10.0, 600.0).lh(12.0).tracking(0.8))
                            .color(c(MARKER))
                            .absolute(PAD_L - GUTTER, PAD_T + (mid - 6.0).round()),
                    );
                }
                _ => {}
            }
        }
    }
}

/// Fold toggles of headings: a chevron left of the heading label, shown while the pointer is over
/// the heading's gutter, when the caret is on the heading, and always when it's folded (pointing
/// right); a folded heading ends in a "…" pill. Both toggle the fold.
/// Size of the fold chevron and its x in the surface (left of the heading label).
const FOLD_ICON: f32 = 10.0;
const FOLD_X: f32 = 4.0;

fn folds(app: &App, geo: &Geo, kids: &mut Vec<El>) {
    for (li, l) in geo.lines.iter().enumerate() {
        if !l.view.foldable || !l.drawn() {
            continue;
        }
        let (vt, vb) = l.first_vline();
        let mid = ((vt + vb) / 2.0).round();
        let shown = l.view.folded || l.view.active || app.fold_hover == Some(li);
        let line = li;
        // the hit area: the whole gutter beside the heading's first row
        let area = rect(format!("foldhit{li}"), -PAD_L, vt, PAD_L - 4.0, vb - vt)
            .cursor(Cursor::Pointer)
            .on_hover(move |s: &mut App| s.fold_hover = Some(line))
            .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| input::fold_drag(s, d, tx, line));
        if shown {
            let k = FOLD_ICON;
            let chevron = if l.view.folded {
                Shape::new().stroke(vec![[k * 0.35, k * 0.15], [k * 0.7, k * 0.5], [k * 0.35, k * 0.85]], 1.6, c(MARKER))
            } else {
                Shape::new().stroke(vec![[k * 0.15, k * 0.35], [k * 0.5, k * 0.7], [k * 0.85, k * 0.35]], 1.6, c(MARKER))
            };
            kids.push(rect(format!("fold{li}"), -PAD_L + FOLD_X, mid - k / 2.0, k, k).shape(chevron));
        }
        kids.push(area);
        if l.view.folded {
            let (x, _, _) = geo.caret(l.view.to);
            let (w, h) = (24.0, 15.0);
            kids.push(
                rect(format!("foldpill{li}"), x + 6.0, mid - h / 2.0, w, h)
                    .fill(c(BG2))
                    .radius(h / 2.0)
                    .cursor(Cursor::Pointer)
                    .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| input::fold_drag(s, d, tx, line))
                    .child(
                        text("…")
                            .key(format!("foldell{li}"))
                            .font(TextStyle::new(12.0, 600.0).lh(h))
                            .color(c(MARKER))
                            .w(w)
                            .align(Align::Center),
                    ),
            );
        }
    }
}

fn texts(geo: &Geo, kids: &mut Vec<El>) {
    for (li, l) in geo.lines.iter().enumerate() {
        if !l.drawn() {
            continue;
        }
        for (pi, p) in l.pieces.iter().enumerate() {
            if p.text.is_empty() {
                continue;
            }
            kids.push(
                rich(p.text.clone(), p.spans.clone())
                    .key(format!("t{li}-{pi}"))
                    .font(p.style)
                    .color(p.color)
                    .w(p.w)
                    .absolute(PAD_L + p.x, PAD_T + p.y),
            );
            for (k, &(da, db)) in p.strikes.iter().enumerate() {
                for (m, r) in p.display_rects(da, db).into_iter().enumerate() {
                    let y = r[1] + (r[3] * 0.53).round();
                    kids.push(rect(format!("st{li}-{pi}-{k}-{m}"), r[0], y, r[2], 1.25).fill(p.color));
                }
            }
        }
    }
}

/// Images (below their line's text, or where they are in it), at most the column wide with small round corners; a muted
/// placeholder with the alt text for one that can't load. A loading image keeps its space.
fn images(geo: &Geo, kids: &mut Vec<El>) {
    for (li, l) in geo.lines.iter().enumerate() {
        for (k, i) in l.images.iter().enumerate() {
            match &i.kind {
                ImgKind::Ready(path) => {
                    // The box already has the image's aspect: stretched to it.
                    let Some(img) = crate::images::ready(path) else { continue };
                    kids.push(
                        el().key(format!("img{li}-{k}"))
                            .role("image")
                            .pixels(img.pixels())
                            .radius(layout::IMAGE_RADIUS)
                            .absolute(PAD_L + i.x, PAD_T + i.y)
                            .size(i.w, i.h),
                    )
                }
                ImgKind::Loading => {}
                ImgKind::Missing => {
                    kids.push(rect(format!("imgph{li}-{k}"), i.x, i.y, i.w, i.h).fill(c(BG2)).radius(layout::IMAGE_RADIUS));
                    let s = layout::PLACEHOLDER_ICON;
                    let (ix, iy) = (i.x + layout::PLACEHOLDER_PAD_X, i.y + layout::PLACEHOLDER_PAD_Y + ((19.0 - s) / 2.0).round());
                    // A picture frame with a hill and a sun (the web editor's broken-image icon).
                    let k_ = s / 16.0;
                    let p = |x: f32, y: f32| [x * k_, y * k_];
                    let icon = Shape::new()
                        .stroke(vec![p(3.5, 3.0), p(12.5, 3.0), p(14.0, 4.5), p(14.0, 11.5), p(12.5, 13.0), p(3.5, 13.0), p(2.0, 11.5), p(2.0, 4.5), p(3.5, 3.0)], 1.3 * k_, c(MARKER))
                        .stroke(vec![p(2.5, 11.5), p(6.0, 8.0), p(8.5, 10.5), p(10.0, 9.0), p(13.5, 12.0)], 1.3 * k_, c(MARKER))
                        .line(p(10.5, 6.5), p(10.5, 6.5), 2.0 * k_, LineCap::Round, c(MARKER));
                    kids.push(rect(format!("imgicon{li}-{k}"), ix, iy, s, s).shape(icon));
                    let tx = ix + s + 6.0;
                    kids.push(
                        rich(i.label.clone(), Vec::new())
                            .key(format!("imgalt{li}-{k}"))
                            .font(layout::placeholder_style())
                            .color(c(MARKER))
                            .w((i.x + i.w - layout::PLACEHOLDER_PAD_X - tx).max(1.0))
                            .absolute(PAD_L + tx, PAD_T + i.y + layout::PLACEHOLDER_PAD_Y),
                    );
                }
            }
        }
    }
}

/// Collapsed links: a pointing hand over their text (elements that hand their gestures to the
/// surface's), and the pencil after it (muted, darker under the pointer) that reveals the link.
fn links(app: &App, geo: &Geo, kids: &mut Vec<El>) {
    let mut keys = Vec::new();
    for g in geo.links(app.ed.doc(), &app.ed.reveal()) {
        for (k, r) in g.rects.iter().enumerate() {
            let key = format!("lk{}-{k}", g.from);
            let (ox, oy) = (PAD_L + r[0], PAD_T + r[1]);
            let k2 = key.clone();
            kids.push(
                rect(key.clone(), r[0], r[1], r[2], r[3])
                    .cursor(Cursor::Pointer)
                    .on_hover(|s: &mut App| {
                        s.fold_hover = None;
                        s.pencil_hover = None;
                    })
                    .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| input::link_text_drag(s, d, tx, &k2, ox, oy)),
            );
            keys.push(key);
        }
        if let Some(r) = g.pencil {
            let hover = app.pencil_hover == Some(g.url.0);
            let (u0, end) = (g.url.0, g.text_end);
            let k = PENCIL_ICON;
            let (ix, iy) = (r[0] + ((r[2] - k) / 2.0).round(), r[1] + ((r[3] - k) / 2.0).round());
            let color = c(if hover { PENCIL_HOVER } else { PENCIL });
            kids.push(
                rect(format!("pencil{u0}"), ix, iy, k, k)
                    .shape(pencil_icon(k, color))
                    .cursor(Cursor::Pointer)
                    .on_hover(move |s: &mut App| s.pencil_hover = Some(u0))
                    .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| input::pencil_drag(s, d, tx, end)),
            );
        }
    }
    // A gesture that started on a link's text and revealed it: its element stays, over the surface.
    if let Some(key) = app.link_capture.as_ref().filter(|k| !keys.contains(k)) {
        let k2 = key.clone();
        kids.push(
            el().key(key.clone())
                .absolute(0.0, 0.0)
                .size(layout::surface_w(), PAD_T + geo.height + PAD_B)
                .cursor(Cursor::Text)
                .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| input::link_text_drag(s, d, tx, &k2, 0.0, 0.0)),
        );
    }
}

/// Size of the link pencil.
const PENCIL_ICON: f32 = 13.0;

/// A pencil, tip down-left (the web editor's).
fn pencil_icon(k: f32, color: Color) -> Shape {
    let s = k / 16.0;
    let p = |x: f32, y: f32| [x * s, y * s];
    let w = 1.4 * s;
    Shape::new()
        .stroke_with(vec![p(11.2, 2.3), p(13.7, 4.8), p(5.2, 13.3), p(1.8, 14.2), p(2.7, 10.8)], true, w, LineCap::Round, color)
        .line(p(9.6, 3.9), p(12.1, 6.4), w, LineCap::Round, color)
}

/// The selection, or the caret (inside the marked text while composing). The caret element is
/// always there, transparent under a selection: it places the IME candidate window and is what
/// keyboard moves scroll into view.
fn selection_and_caret(app: &App, geo: &Geo, marked: Option<(f32, f32, f32)>, kids: &mut Vec<El>) {
    let sel = app.ed.selection();
    let selecting = !sel.is_empty() && marked.is_none();
    if selecting {
        for (k, r) in geo.sel_rects(sel.from(), sel.to()).into_iter().enumerate() {
            kids.push(rect(format!("sel{k}"), r[0], r[1], r[2], r[3]).fill(crate::theme::selection()));
        }
    }
    let (x, t, b) = marked.unwrap_or_else(|| geo.caret(sel.head));
    let caret = rect("caret".into(), x - 0.5, t, 2.0, b - t).ime_cursor();
    // While the sidebar's filter has the keys, only its caret shows.
    kids.push(if selecting || app.filter.focused { caret } else { caret.fill(c(INK)).live_opacity(&app.blink) });
    if let Some(p) = app.drop_at {
        let (x, t, b) = geo.caret(p);
        kids.push(rect("drop-caret".into(), x - 1.0, t, 2.0, b - t).fill(c(ACCENT)).radius(1.0));
    }
}

/// Other people's carets and selections in a remote note: their colour, a translucent selection, and their
/// name in a small label above the caret.
fn remote_cursors(app: &App, geo: &Geo, kids: &mut Vec<El>) {
    for (c_, a, h) in app.remote_carets() {
        let color = rune::color::hex(&c_.color).unwrap_or_else(|| c("#888888"));
        let k = c_.client;
        if a != h {
            for (i, r) in geo.sel_rects(a.min(h), a.max(h)).into_iter().enumerate() {
                kids.push(rect(format!("rsel{k}-{i}"), r[0], r[1], r[2], r[3]).fill(color.alpha(0.18)));
            }
        }
        let (x, t, b) = geo.caret(h);
        kids.push(rect(format!("rcaret{k}"), x - 1.0, t, 2.0, b - t).fill(color));
        kids.push(
            text(c_.name.clone())
                .key(format!("rname{k}"))
                .font(TextStyle::new(11.0, 600.0).lh(15.0))
                .color(c(PAPER))
                .fill(color)
                .radius(3.0)
                .px(4.0)
                .absolute(PAD_L + x - 1.0, PAD_T + t - 15.0),
        );
    }
}
