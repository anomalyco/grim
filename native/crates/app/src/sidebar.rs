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

use rune::{Align, Button, Drag, El, Phase, ScrollSpec, Shape, TextEdit, TextStyle, Tx, col, el, row, text, text_input};

use crate::App;
use crate::files::Row;
use crate::switcher;
use crate::theme::*;

thread_local! {
    /// Window width of the last view, for handlers deciding whether the sidebar shows.
    static WIN_W: Cell<f32> = const { Cell::new(1000.0) };
}

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
            self.blur_filter();
        }
    }

    /// Give the keys back to the editor; the filter's IME composition, if any, is dropped.
    pub fn blur_filter(&mut self) {
        self.filter.focused = false;
        self.filter.preedit = None;
    }

    /// Cmd-P / Cmd-K: show the sidebar and focus the filter with its text selected.
    pub fn focus_filter(&mut self) {
        if self.root.is_none() {
            return;
        }
        if !shown(self, WIN_W.get()) {
            self.sidebar = Some(true);
        }
        // The editor's composition, if any, doesn't follow the keys.
        self.marked = None;
        self.filter.focused = true;
        self.filter.anchor = 0;
        self.filter.focus = self.filter.text.len();
    }

    /// Esc in the filter: clear it, or leave it when it's already empty.
    pub fn filter_escape(&mut self) {
        if self.filter.text.is_empty() {
            self.blur_filter();
        } else {
            self.filter.clear();
        }
    }

    fn row_down(&mut self, path: &Path, dir: bool, tx: &mut Tx) {
        self.blur_filter();
        self.row_menu = None;
        self.renaming = None;
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
        let first = self.tree_rows().iter().find(|r| !r.dir).map(|r| r.path.clone());
        if let Some(path) = first {
            self.blur_filter();
            self.open_note(path, tx);
            self.handled(tx);
        }
    }
}

pub fn view(app: &App) -> El {
    if app.root.is_none() {
        return el();
    }
    let rows = app.tree_rows();
    let filtering = !app.filter.text.trim().is_empty();
    let mut tree: Vec<El> = Vec::new();
    for r in rows.iter() {
        match &app.renaming {
            Some((rel, field)) if *rel == r.rel && !r.dir => tree.push(rename_el(r, field)),
            _ => tree.push(row_el(r, app.path.as_ref() == Some(&r.path))),
        }
        if let Some((rel, confirm)) = &app.row_menu
            && *rel == r.rel
            && !r.dir
        {
            tree.extend(row_actions(r, *confirm));
        }
    }
    if app.remote.as_ref().is_some_and(|x| !x.loaded) && tree.is_empty() {
        tree.push(text("Loading…").key("tree-loading").font(TextStyle::new(13.0, 400.0).lh(18.0)).color(c(MUTED)).pl(16.0).pt(4.0));
    }
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
        .child(el().key("sb-top").w_full().h(switcher::SWITCHER_TOP))
        .child(switcher::button(app))
        .child(el().key("sb-gap").w_full().h(switcher::SWITCHER_H - 40.0))
        .child(tools(app))
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
            if d.phase != Phase::Down {
                return;
            }
            if (d.button == Button::Right || d.mods.ctrl) && !dir && app.remote_writable() {
                app.open_row_menu(&path);
                app.handled(tx);
                return;
            }
            app.row_down(&path, dir, tx);
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

impl App {
    /// The open remote workspace takes edits (rename, delete, new notes).
    pub fn remote_writable(&self) -> bool {
        self.remote.as_ref().is_some_and(|r| r.loaded && !r.read_only)
    }

    /// Right-click (or Ctrl-click) on a remote note row: its Rename / Delete actions under it.
    pub fn open_row_menu(&mut self, path: &Path) {
        let Some(rel) = self.root.as_ref().and_then(|r| path.strip_prefix(r).ok()).map(|r| r.to_string_lossy().into_owned()) else { return };
        self.blur_filter();
        self.renaming = None;
        self.row_menu = if self.row_menu.as_ref().is_some_and(|(r, _)| *r == rel) { None } else { Some((rel, false)) };
    }

    /// Rename: the row becomes a field holding the note's path without `.md`.
    pub fn start_rename(&mut self, rel: &str) {
        self.row_menu = None;
        self.blur_filter();
        self.marked = None;
        let shown = rel.strip_suffix(".md").or_else(|| rel.strip_suffix(".markdown")).unwrap_or(rel);
        let mut f = TextEdit::new(shown);
        f.single_line = true;
        f.focused = true;
        f.anchor = shown.rfind('/').map_or(0, |i| i + 1);
        f.focus = shown.len();
        self.renaming = Some((rel.to_string(), f));
    }

    pub fn submit_rename(&mut self, tx: &mut Tx) {
        let Some((from, f)) = self.renaming.take() else { return };
        self.remote_rename(from, f.text, tx);
        self.handled(tx);
    }
}

/// A remote note's actions, under its row.
fn row_actions(r: &Row, confirm: bool) -> Vec<El> {
    let w = SIDEBAR_W - 2.0 * ROW_INSET;
    let x = r.depth as f32 * INDENT + 12.0;
    type Action = Box<dyn Fn(&mut App, &mut Tx)>;
    let item = |key: String, label: String, color: &str, f: Action| {
        el().key(key.clone())
            .label(label.clone())
            .w(w)
            .h(26.0)
            .ml(ROW_INSET)
            .radius(6.0)
            .hover(c(TINT_HOVER))
            .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
                if d.phase == Phase::Down {
                    f(app, tx);
                    app.handled(tx);
                }
            })
            .child(text(label).key(format!("{key}-text")).font(TextStyle::new(13.0, 500.0).lh(18.0)).color(c(color)).absolute(x + 8.0, 4.0))
    };
    let (a, b) = (r.rel.clone(), r.rel.clone());
    vec![
        item(format!("rename:{}", r.rel), "Rename…".into(), INK_2, Box::new(move |app, _| app.start_rename(&a))),
        item(
            format!("delete:{}", r.rel),
            if confirm { "Delete — press again to confirm".into() } else { "Delete".into() },
            "#c4342d",
            Box::new(move |app, tx| {
                if app.row_menu.as_ref().is_some_and(|(_, c)| *c) {
                    app.row_menu = None;
                    app.remote_delete(b.clone(), tx);
                } else if let Some(m) = app.row_menu.as_mut() {
                    m.1 = true;
                }
            }),
        ),
    ]
}

/// The row of a note being renamed: a field in place of its name.
fn rename_el(r: &Row, field: &TextEdit) -> El {
    let w = SIDEBAR_W - 2.0 * ROW_INSET;
    let x = r.depth as f32 * INDENT + 6.0;
    el().key(format!("renaming:{}", r.rel)).w(w).h(ROW_H).ml(ROW_INSET).child(
        text_input(field, TextStyle::new(13.5, 400.0).lh(18.0))
            .key("rename-field")
            .w(w - x)
            .h(ROW_H)
            .px(6.0)
            .py(5.0)
            .fill(c(PAPER))
            .radius(6.0)
            .border(1.0, c(LINK))
            .color(c(INK))
            .caret(c(INK), selection())
            .on_edit(|app: &mut App| match &mut app.renaming {
                Some(r) => &mut r.1,
                None => &mut app.switcher.input,
            })
            .on_submit(|app: &mut App, tx: &mut Tx| app.submit_rename(tx))
            .absolute(x, 0.0),
    )
}
