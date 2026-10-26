//! The view: `LineView`s (laid out by `layout`) → Rune elements.
//!
//! Paint order inside the surface: block backgrounds (code blocks, quote bars, table rules,
//! rules), input strips (transparent hit targets, see `input`), gutter glyphs (bullets, numbers,
//! checkboxes, heading labels), one `rich()` element per text piece, strikethrough rules, the
//! selection (translucent, above the text so it shows over code backgrounds), the caret.

use editor_core::{BlockType, TokenKind};
use rune::{Align, Cursor, Cx, Drag, El, ScrollSpec, Shape, TextStyle, Tx, col, el, rich, text};

use crate::App;
use crate::input;
use crate::layout::{Geo, SCALE};
use crate::theme::*;

pub fn view(app: &App, cx: &mut Cx<App>) -> El {
    SCALE.set(cx.env().scale);
    let geo = app.geometry();
    let mut kids: Vec<El> = Vec::new();
    blocks(&geo, &mut kids);
    strips(&geo, &mut kids);
    gutter(&geo, &mut kids);
    texts(&geo, &mut kids);
    selection_and_caret(app, &geo, &mut kids);

    let surface = el().key("surface").w(SURFACE_W).h(PAD_T + geo.height + PAD_B).children(kids);
    col().key("root").w_full().h_full().fill(c(PAPER)).child(
        col()
            .key("scroll")
            .w_full()
            .h_full()
            .scroll(ScrollSpec { stick_bottom: false })
            .child(col().key("content").w_full().center_y().child(surface)),
    )
}

fn rect(key: String, x: f32, y: f32, w: f32, h: f32) -> El {
    el().key(key).absolute(PAD_L + x, PAD_T + y).size(w, h)
}

fn blocks(geo: &Geo, kids: &mut Vec<El>) {
    let lines = &geo.lines;
    let mut i = 0;
    while i < lines.len() {
        let l = &lines[i];
        if l.view.code.is_some() {
            let mut j = i;
            while j < lines.len() && lines[j].view.code.is_some() && !(j > i && lines[j].view.code.as_ref().unwrap().first) {
                j += 1;
            }
            let bottom = lines[j - 1].top + lines[j - 1].h;
            kids.push(rect(format!("code{i}"), 0.0, l.top, TEXT_W, bottom - l.top).fill(c(CODE_BG)).radius(6.0));
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
            kids.push(rect(format!("hr{i}"), 0.0, (l.top + l.h / 2.0).round(), TEXT_W - 2.0, 1.0).fill(c(STROKE)));
        }
        if !l.cols.is_empty() && l.drawn() {
            let w = l.cols.last().map_or(TEXT_W, |c| c.1 - CELL_PAD_R);
            let color = if l.view.kind == BlockType::TableHead { HEAD_RULE } else { BG2 };
            kids.push(rect(format!("trule{i}"), 0.0, l.top + l.h - 1.0, w, 1.0).fill(c(color)));
        }
        i += 1;
    }
}

/// Transparent hit targets, one per visual line, spanning the surface width (see `input`).
fn strips(geo: &Geo, kids: &mut Vec<El>) {
    let mut bands = geo.bands();
    if bands.is_empty() {
        bands.push((0, 0.0, geo.height.max(26.0)));
    }
    let n = bands.len();
    for (k, &(_, y0, y1)) in bands.iter().enumerate() {
        let top = if k == 0 { -PAD_T } else { y0 };
        let bottom = if k + 1 == n { geo.height + PAD_B } else { y1 };
        kids.push(
            el().key(format!("hit{k}"))
                .absolute(0.0, PAD_T + top)
                .size(SURFACE_W, bottom - top)
                .cursor(Cursor::Text)
                .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| input::strip_drag(s, d, tx, top, bottom)),
        );
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

fn selection_and_caret(app: &App, geo: &Geo, kids: &mut Vec<El>) {
    let sel = app.ed.selection();
    if !sel.is_empty() {
        for (k, r) in geo.sel_rects(sel.from(), sel.to()).into_iter().enumerate() {
            kids.push(rect(format!("sel{k}"), r[0], r[1], r[2], r[3]).fill(crate::theme::selection()));
        }
        return;
    }
    let (x, t, b) = geo.caret(sel.head);
    kids.push(rect("caret".into(), x - 0.5, t, 2.0, b - t).fill(c(INK)).live_opacity(&app.blink));
}
