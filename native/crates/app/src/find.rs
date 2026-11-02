//! Find in the note (⌘F, Edit ▸ Find…): a small bar at the top right of the page (like Safari's, Notes' or
//! VS Code's) with a query field, "n of m", previous / next and ×. Every match of the query in the note's raw
//! Markdown (case-insensitive) is highlighted with the selection's rects (`Geo::sel_rects`, which maps raw
//! ranges to the display through each piece's raw ↔ display maps, so hidden markers don't shift them), the
//! current one stronger. Matches are found again on every frame, so they follow edits, a collaborator's
//! included. Matches hidden from view (a collapsed link's URL, a folded section) don't count. Return / ⌘G next, Shift-Return / ⇧⌘G previous (both wrap), ⌘E uses the selection, Esc closes
//! the bar and selects the current match. Find only: replace is the next step.

use rune::{Drag, El, Key, KeyEvent, LineCap, Phase, Shape, TextEdit, TextStyle, Tx, el, row, text, text_input};

use crate::App;
use crate::theme::*;

/// The bar's width and its margin from the page's top right corner.
pub const BAR_W: f32 = 340.0;
const BAR_H: f32 = 38.0;
const MARGIN: f32 = 12.0;
/// At most this many matches are found (a huge note and a one-letter query).
const MAX: usize = 10_000;

/// Every match (yellow), and the current one (stronger), both over the text.
pub fn all_fill() -> rune::Color {
    c("#ffd60a").alpha(0.32)
}
pub fn current_fill() -> rune::Color {
    c("#ff9f0a").alpha(0.55)
}

#[derive(Debug, Default)]
pub struct Find {
    pub open: bool,
    pub input: TextEdit,
    /// The current match is the first starting at or after this raw position (wrapping to the first): where
    /// the find started, then the match the arrows moved to.
    pub at: usize,
}

/// The matches of `query` in `text` (raw byte ranges, not overlapping), ignoring case.
pub fn matches(text: &str, query: &str) -> Vec<(usize, usize)> {
    if query.is_empty() {
        return Vec::new();
    }
    // Lowercased text with each folded byte's source offset (lowercasing can change a character's length).
    let mut folded = String::with_capacity(text.len());
    let mut src: Vec<usize> = Vec::with_capacity(text.len() + 1);
    for (i, ch) in text.char_indices() {
        for l in ch.to_lowercase() {
            let n = folded.len();
            folded.push(l);
            src.extend(std::iter::repeat_n(i, folded.len() - n));
        }
    }
    src.push(text.len());
    let q = query.to_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(k) = folded[from..].find(&q) {
        let s = from + k;
        let e = s + q.len();
        let (a, b) = (src[s], src[e]);
        // only whole characters of the text (a fold that starts or ends mid-character is skipped)
        if a < b && text.is_char_boundary(a) && text.is_char_boundary(b) {
            out.push((a, b));
            if out.len() >= MAX {
                break;
            }
        }
        from = e;
    }
    out
}

impl Find {
    /// The current match among `ms`.
    pub fn current(&self, ms: &[(usize, usize)]) -> Option<usize> {
        if ms.is_empty() {
            return None;
        }
        Some(ms.iter().position(|m| m.0 >= self.at).unwrap_or(0))
    }
}

impl App {
    pub fn find_matches(&self) -> Vec<(usize, usize)> {
        if self.find.input.text.is_empty() {
            return Vec::new();
        }
        self.find_matches_in(&self.geometry())
    }

    /// The matches that show: not inside a collapsed link's hidden URL or a folded section (the browser's
    /// own find in the web app likewise only finds what's on the page).
    pub fn find_matches_in(&self, geo: &crate::layout::Geo) -> Vec<(usize, usize)> {
        let mut ms = matches(self.ed.text(), &self.find.input.text);
        ms.retain(|&(a, b)| geo.sel_rects(a, b).iter().any(|r| r[2] > 0.5));
        ms
    }

    /// ⌘F: the bar with its field focused, holding the selection (one line of it) or the last query, all of it selected.
    pub fn open_find(&mut self, tx: &mut Tx) {
        if self.path.is_none() || self.dialog.is_some() {
            return;
        }
        self.close_search();
        self.close_switcher();
        self.tree_focus = false;
        self.renaming = None;
        self.marked = None;
        let sel = self.ed.selection();
        // already open with the field focused: select what's typed
        if self.find.open && self.find.input.focused {
            self.find.input.anchor = 0;
            self.find.input.focus = self.find.input.text.len();
            return;
        }
        let picked = self.ed.text().get(sel.from()..sel.to()).filter(|s| !s.is_empty() && !s.contains('\n') && s.len() <= 500).map(str::to_string);
        let q = picked.unwrap_or_else(|| self.find.input.text.clone());
        let mut input = TextEdit::new(&q);
        input.anchor = 0;
        input.focus = q.len();
        input.focused = true;
        self.find = Find { open: true, input, at: sel.from() };
        self.find_reveal(tx);
    }

    /// ⌘E: the selection becomes the query (the bar opens, the keys stay where they are).
    pub fn find_use_selection(&mut self, _tx: &mut Tx) {
        let sel = self.ed.selection();
        let Some(q) = self.ed.text().get(sel.from()..sel.to()).filter(|s| !s.is_empty() && !s.contains('\n')).map(str::to_string) else { return };
        let focused = self.find.open && self.find.input.focused;
        let mut input = TextEdit::new(&q);
        input.focus = q.len();
        input.anchor = 0;
        input.focused = focused;
        self.find = Find { open: true, input, at: sel.from() };
    }

    /// Esc, the ×: the bar goes and the editor has the keys; with `select`, the current match is selected.
    pub fn close_find(&mut self, select: bool, tx: &mut Tx) {
        if !self.find.open {
            return;
        }
        if select {
            let ms = self.find_matches();
            if let Some(i) = self.find.current(&ms) {
                let (a, b) = ms[i];
                self.ed.set_selection(editor_core::Sel::new(a, b));
                tx.scroll_into_view("caret");
            }
        }
        self.find.open = false;
        self.find.input.focused = false;
        self.find.input.preedit = None;
    }

    /// Next (`1`) or previous (`-1`) match, wrapping; it scrolls into view. With the bar closed (⌘G after
    /// Esc), the match is selected in the editor instead.
    pub fn find_step(&mut self, dir: i32, tx: &mut Tx) {
        let ms = self.find_matches();
        let Some(i) = self.find.current(&ms) else { return };
        let n = ms.len();
        let j = if dir > 0 { (i + 1) % n } else { (i + n - 1) % n };
        self.find.at = ms[j].0;
        if self.find.open {
            self.find_reveal(tx);
        } else {
            self.ed.set_selection(editor_core::Sel::new(ms[j].0, ms[j].1));
            tx.scroll_into_view("caret");
        }
    }

    pub fn find_reveal(&self, tx: &mut Tx) {
        tx.scroll_into_view("find-cur");
    }

    /// A key while the bar's field has the keys: Return / Shift-Return, ⌘G / ⇧⌘G and Esc are the bar's.
    pub fn find_field_key(&mut self, ev: &KeyEvent, tx: &mut Tx) -> bool {
        match &ev.key {
            Key::Enter => self.find_step(if ev.mods.shift { -1 } else { 1 }, tx),
            Key::Escape => self.close_find(true, tx),
            Key::Command(ch) if ch.eq_ignore_ascii_case(&'g') => self.find_step(if ev.mods.shift { -1 } else { 1 }, tx),
            _ => return false,
        }
        true
    }
}

/// The bar (`find-…` keys), at the top right of the page whose left edge is `x0`, width `ew`, below `top`.
pub fn bar(app: &App, x0: f32, ew: f32, top: f32) -> Option<El> {
    if !app.find.open {
        return None;
    }
    let ms = app.find_matches();
    let cur = app.find.current(&ms);
    let count = match cur {
        _ if app.find.input.text.is_empty() => String::new(),
        None => "No results".into(),
        Some(i) => format!("{} of {}", i + 1, ms.len()),
    };
    let w = BAR_W.min(ew - 2.0 * MARGIN).max(200.0);
    let field_w = w - 160.0;
    let field = text_input(&app.find.input, TextStyle::new(13.0, 400.0).lh(16.0))
        .single_line()
        .key("find-input")
        .w(field_w)
        .h(26.0)
        .px(8.0)
        .py(5.0)
        .fill(c(PAPER))
        .radius(5.0)
        .border(1.0, if app.find.input.focused { c(LINK) } else { line() })
        .color(c(INK))
        .placeholder("Find in note", c(GREY))
        .caret(c(INK), selection())
        .on_edit(|app: &mut App| &mut app.find.input)
        .on_input_key(|app: &mut App, ev: &KeyEvent, tx: &mut Tx| {
            if !app.find_field_key(ev, tx) {
                return false;
            }
            app.handled(tx);
            true
        })
        .on_submit(|app: &mut App, tx: &mut Tx| {
            app.find_step(1, tx);
            app.handled(tx);
        });
    let none = cur.is_none();
    let card = row()
        .key("find")
        .w(w)
        .h(BAR_H)
        .px(6.0)
        .gap(4.0)
        .center_y()
        .fill(c(PAPER))
        .radius(8.0)
        .border(1.0, line())
        .shadow(12.0, 32.0, c("#18181b").alpha(0.14))
        .on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.find.input.focused = true;
                app.handled(tx);
            }
        })
        .child(field)
        .child(
            text(count)
                .key("find-count")
                .font(TextStyle::new(12.0, 400.0).lh(16.0))
                .color(c(MUTED))
                .w(66.0)
                .truncate(),
        )
        .child(button("find-prev", chevron(false, if none { c(GREY) } else { c(INK) }), |app, tx| app.find_step(-1, tx)))
        .child(button("find-next", chevron(true, if none { c(GREY) } else { c(INK) }), |app, tx| app.find_step(1, tx)))
        .child(button("find-close", cross(c(MUTED)), |app, tx| app.close_find(false, tx)));
    Some(card.absolute((x0 + ew - w - MARGIN).round(), top + MARGIN))
}

fn button(key: &str, icon: Shape, f: fn(&mut App, &mut Tx)) -> El {
    row()
        .key(key.to_string())
        .size(24.0, 24.0)
        .center()
        .radius(5.0)
        .hover(c(PAPER_2))
        .child(el().key(format!("{key}-icon")).size(12.0, 12.0).shape(icon))
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                f(app, tx);
                app.handled(tx);
            }
        })
}

/// A chevron pointing down (next) or up (previous), 12 pt.
fn chevron(down: bool, color: rune::Color) -> Shape {
    let (y0, y1) = if down { (4.0, 8.0) } else { (8.0, 4.0) };
    Shape::new().stroke_with(vec![[2.5, y0], [6.0, y1], [9.5, y0]], false, 1.5, LineCap::Round, color)
}

fn cross(color: rune::Color) -> Shape {
    Shape::new().line([3.0, 3.0], [9.0, 9.0], 1.4, LineCap::Round, color).line([9.0, 3.0], [3.0, 9.0], 1.4, LineCap::Round, color)
}

#[cfg(test)]
mod tests {
    use super::matches;

    #[test]
    fn finds_ignoring_case() {
        assert_eq!(matches("Plan, **plan**, PLAN", "plan"), [(0, 4), (8, 12), (16, 20)]);
        assert_eq!(matches("İx ix", "ix"), [(4, 6)]);
        assert!(matches("abc", "").is_empty());
    }
}
