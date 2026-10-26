//! The sidebar: the notes folder as a tree, with a filter field and a "New note" action, styled
//! after the web app's (app.css: `.sidebar`, `.sb-actions`, `.sb-filter`, `.file-row`).
//!
//! Rows are keyed `row:<path relative to the root>`. A press on a note flushes the open one and
//! opens it; a press on a folder opens or closes it (and makes it where new notes go). While the
//! filter has text, only matching notes and the folders above them show, all open. The filter is
//! a Rune `text_input` bound to `App::filter`: while it has focus `input::on_key` leaves keys to
//! it, so the editor doesn't see them.

use std::cell::Cell;
use std::path::{Path, PathBuf};

use rune::{Align, Drag, El, Phase, ScrollSpec, Shape, TextStyle, Tx, col, el, row, text, text_input};

use crate::App;
use crate::files::{self, Row};
use crate::theme::*;

thread_local! {
    /// Window width of the last view, for handlers deciding whether the sidebar shows.
    static WIN_W: Cell<f32> = const { Cell::new(1000.0) };
}

/// Room left at the top for the window's traffic lights (the content view is full size).
const TOP: f32 = 40.0;
const ROW_H: f32 = 28.0;
/// Rows are inset from the sidebar's edges.
const ROW_INSET: f32 = 8.0;
/// Indentation per tree level.
const INDENT: f32 = 14.0;
const FIELD_W: f32 = SIDEBAR_W - 2.0 * ROW_INSET - 12.0;

pub fn set_window_w(w: f32) {
    WIN_W.set(w);
}

pub fn shown(app: &App, window_w: f32) -> bool {
    app.root.is_some() && app.sidebar.unwrap_or(window_w >= NARROW_W)
}

impl App {
    /// Cmd-\ (or Cmd-Shift-L): show or hide the sidebar, overriding the width default.
    pub fn toggle_sidebar(&mut self) {
        if self.root.is_none() {
            return;
        }
        let now = shown(self, WIN_W.get());
        self.sidebar = Some(!now);
        if now {
            self.filter.focused = false;
        }
    }

    /// Cmd-P / Cmd-K: show the sidebar and focus the filter with its text selected.
    pub fn focus_filter(&mut self) {
        if self.root.is_none() {
            return;
        }
        if !shown(self, WIN_W.get()) {
            self.sidebar = Some(true);
        }
        self.filter.focused = true;
        self.filter.anchor = 0;
        self.filter.focus = self.filter.text.len();
    }

    /// Esc in the filter: clear it, or leave it when it's already empty.
    pub fn filter_escape(&mut self) {
        if self.filter.text.is_empty() {
            self.filter.focused = false;
        } else {
            self.filter.clear();
        }
    }

    fn row_down(&mut self, path: &Path, dir: bool, tx: &mut Tx) {
        self.filter.focused = false;
        if dir {
            if self.filter.text.trim().is_empty() && !self.collapsed.remove(path) {
                self.collapsed.insert(path.to_path_buf());
            }
            self.new_dir = Some(path.to_path_buf());
        } else {
            self.new_dir = None;
            self.open_note(path.to_path_buf(), tx);
        }
        self.handled(tx);
    }

    /// Enter in the filter opens the first matching note.
    fn open_first_match(&mut self, tx: &mut Tx) {
        let Some(root) = &self.root else { return };
        let first = files::rows(&self.files, root, &self.collapsed, &self.filter.text).into_iter().find(|r| !r.dir);
        if let Some(r) = first {
            self.filter.focused = false;
            self.open_note(r.path, tx);
            self.handled(tx);
        }
    }
}

pub fn view(app: &App) -> El {
    let Some(root) = &app.root else { return el() };
    let rows = files::rows(&app.files, root, &app.collapsed, &app.filter.text);
    let filtering = !app.filter.text.trim().is_empty();
    let mut tree: Vec<El> = rows.iter().map(|r| row_el(r, app.path.as_ref() == Some(&r.path))).collect();
    if tree.is_empty() {
        let note = if filtering { "No note names match." } else { "No notes yet." };
        tree.push(text(note).key("tree-note").font(TextStyle::new(13.0, 400.0).lh(18.0)).color(c(MUTED)).pl(16.0).pt(4.0));
    }
    col()
        .key("sidebar")
        .w(SIDEBAR_W)
        .h_full()
        .fill(c(PAPER_2))
        // A drop target that takes nothing: files over the sidebar leave the page (its drop caret
        // hides), even where the sidebar covers the page in a narrow window.
        .on_file_drop(|_: &mut App, _: &rune::FileDrop, _: &mut rune::Tx| {})
        .child(el().key("sb-top").w_full().h(TOP))
        .child(tools(app))
        .child(
            row()
                .key("sb-label")
                .w_full()
                .h(30.0)
                .pl(16.0)
                .pr(12.0)
                .mb(2.0)
                .center_y()
                .child(
                    text(files::note_name(root))
                        .key("sb-label-text")
                        .font(TextStyle::new(12.0, 600.0).lh(15.0).tracking(0.06))
                        .color(c(INK_2))
                        .w(SIDEBAR_W - 28.0)
                        .truncate(),
                ),
        )
        .child(
            col()
                .key("tree")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec { stick_bottom: false })
                .clip_soft(6.0)
                .child(col().key("tree-rows").w_full().pb(32.0).children(tree)),
        )
}

/// "+ New note" and the filter field.
fn tools(app: &App) -> El {
    let plus = el()
        .key("plus")
        .size(10.0, 10.0)
        .child(el().key("plus-h").absolute(0.0, 4.0).size(10.0, 2.0).fill(c(INK)))
        .child(el().key("plus-v").absolute(4.0, 0.0).size(2.0, 10.0).fill(c(INK)));
    let new_note = row()
        .key("new-note")
        .w_full()
        .h(ROW_H)
        .px(8.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
        .hover(c(TINT_HOVER))
        .on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.new_note(tx);
                app.handled(tx);
            }
        })
        .child(plus)
        .child(text("New note").key("new-note-text").font(TextStyle::new(13.5, 500.0).lh(18.0)).color(c(INK)));

    let focused = app.filter.focused;
    let mut field = el().key("filter-box").w(FIELD_W).h(32.0).ml(ROW_INSET).child(
        text_input(&app.filter, TextStyle::new(13.5, 400.0).lh(18.0))
            .key("filter")
            .w_full()
            .h(32.0)
            .px(10.0)
            .py(7.0)
            .fill(c(PAPER))
            .radius(6.0)
            .border(1.0, if focused { c(LINK) } else { line() })
            .color(c(INK))
            .placeholder("Filter notes", c(MUTED))
            .caret(c(INK), selection())
            .on_edit(|app: &mut App| &mut app.filter)
            .on_submit(|app: &mut App, tx: &mut Tx| app.open_first_match(tx)),
    );
    if !focused && app.filter.text.is_empty() {
        field = field.child(
            text("⌘P")
                .key("filter-hint")
                .font(TextStyle::new(10.5, 500.0).lh(16.0))
                .color(c(MUTED))
                .w(26.0)
                .align(Align::Center)
                .border(1.0, line())
                .radius(4.0)
                .absolute(FIELD_W - 26.0 - 7.0, 8.0),
        );
    }
    col().key("sb-tools").w_full().pl(ROW_INSET).pr(12.0).pt(8.0).pb(14.0).gap(10.0).child(new_note).child(field)
}

fn row_el(r: &Row, active: bool) -> El {
    let w = SIDEBAR_W - 2.0 * ROW_INSET;
    // Chevron centred at depth × INDENT, name 12 pt after it (files line up with folder names).
    let cx = r.depth as f32 * INDENT;
    let x = cx + 12.0;
    let style = TextStyle::new(14.0, if active { 600.0 } else { 400.0 }).lh(18.0);
    let (path, dir): (PathBuf, bool) = (r.path.clone(), r.dir);
    let mut e = el()
        .key(format!("row:{}", r.rel))
        .label(r.name.clone())
        .w(w)
        .h(ROW_H)
        .ml(ROW_INSET)
        .radius(6.0)
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.row_down(&path, dir, tx);
            }
        })
        .child(
            text(r.name.clone())
                .key(format!("name:{}", r.rel))
                .font(style)
                .color(c(if r.dir { INK_2 } else { INK }))
                .w(w - x - 8.0)
                .truncate()
                .absolute(x, (ROW_H - 18.0) / 2.0),
        );
    e = if active { e.fill(c(TINT_ACTIVE)) } else { e.hover(c(TINT_HOVER)) };
    if r.dir {
        // Two 1.5 pt strokes, like the web's rotated border chevron.
        let pts = if r.open { vec![[1.5, 3.0], [5.0, 6.5], [8.5, 3.0]] } else { vec![[3.0, 1.5], [6.5, 5.0], [3.0, 8.5]] };
        e = e.child(el().key(format!("chev:{}", r.rel)).absolute(cx - 5.0, (ROW_H - 10.0) / 2.0).size(10.0, 10.0).shape(Shape::new().stroke(pts, 1.5, c(MUTED))));
    }
    e
}
