//! The view: the sidebar (`sidebar`) beside the page, whose `LineView`s (laid out by `layout`)
//! become Rune elements.
//!
//! Paint order inside the surface (which takes the mouse, see `input::surface_drag`): block
//! backgrounds (code blocks, quote bars, table rules, rules), gutter glyphs (bullets, numbers,
//! checkboxes, heading labels), one `rich()` element per text piece (IME marked text spliced in
//! at the caret), strikethrough rules, images (or their placeholders) where layout put them, the
//! selection (translucent, above the text so it shows over code backgrounds), the caret.

use editor_core::{BlockType, TokenKind};
use rune::{Align, Cursor, Cx, Drag, El, Fit, LineCap, ScrollSpec, Shape, TextStyle, Tx, col, el, rich, text};

use crate::App;
use crate::drop;
use crate::input;
use crate::sidebar;
use crate::layout::{self, Geo, ImgKind, SCALE, col_w};
use crate::theme::*;

pub fn view(app: &App, cx: &mut Cx<App>) -> El {
    SCALE.set(cx.env().scale);
    let (vw, vh) = cx.viewport();
    sidebar::set_window_w(vw);
    let side = sidebar::shown(app, vw);
    let x0 = if side { SIDEBAR_W } else { 0.0 };
    let ew = vw - x0;
    layout::set_viewport(ew, vh);
    let editor = if app.root.is_some() && app.path.is_none() { empty_state() } else { editor(app) };
    // Clipped to its own area: nothing slides under the sidebar (the column squeezes down to
    // MIN_TEXT_W beside it, and wide tables or code can still be wider than that).
    let mut root =
        el().key("root").w_full().h_full().fill(c(PAPER)).child(col().key("editor").absolute(x0, 0.0).w(ew).h_full().clip_soft(0.0).child(editor));
    if side {
        root = root.child(sidebar::view(app).absolute(0.0, 0.0));
    }
    root
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
    selection_and_caret(app, &geo, marked, &mut kids);

    let surface = el()
        .key("surface")
        .w(layout::surface_w())
        .h(PAD_T + geo.height + PAD_B)
        .cursor(Cursor::Text)
        .on_drag(input::surface_drag)
        .on_hover(|app: &mut App| app.fold_hover = None)
        .on_file_drop(drop::on_file_drop)
        .children(kids);
    col()
        .key("scroll")
        .w_full()
        .h_full()
        .scroll(ScrollSpec { stick_bottom: false })
        .child(col().key("content").w_full().center_y().child(surface))
}

/// A folder with no notes.
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
                ImgKind::Ready(path) => kids.push(
                    rune::image(path.as_path())
                        .key(format!("img{li}-{k}"))
                        .fit(Fit::Fill)
                        .radius(layout::IMAGE_RADIUS)
                        .absolute(PAD_L + i.x, PAD_T + i.y)
                        .size(i.w, i.h),
                ),
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
