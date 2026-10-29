//! The sidebar: the notes folder as a tree, with a "Search files" button and a "New note" action, styled
//! after the web app's (app.css: `.sidebar`, `.sb-actions`, `.sb-search`, `.file-row`).
//!
//! Rows are keyed `row:<path relative to the root>`. A press on a note flushes the open one and
//! opens it; a press on a folder opens or closes it (and makes it where new notes go). The tree is
//! never filtered: the search button opens the "Search files" dialog (`filesearch`). A right-click,
//! Ctrl-click or a row's ⋯ opens the native
//! row menu (`tree_edit`: New note, New folder, Rename, Delete).

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rune::{Drag, El, Key, KeyEvent, Phase, ScrollSpec, Shape, TextEdit, TextStyle, Transition, Tx, col, el, row, text, text_input};

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

pub fn window_w() -> f32 {
    WIN_W.get()
}

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
            self.close_search();
        }
    }

    fn row_down(&mut self, path: &Path, dir: bool, tx: &mut Tx) {
        self.close_search();
        // a click elsewhere commits a rename (the web's blur)
        if self.renaming.is_some() {
            self.submit_rename(tx);
        }
        // a click on a row gives the tree the keys, on that row
        self.tree_focus = true;
        self.tree_cur = Some(path.to_path_buf());
        if dir {
            if !self.collapsed.remove(path) {
                self.collapsed.insert(path.to_path_buf());
            }
        } else {
            self.open_note(path.to_path_buf(), tx);
        }
        self.handled(tx);
    }

    /// ⌘⇧E (from anywhere): the tree takes the keys, at its current row (the open note's by default).
    pub fn focus_tree(&mut self) {
        if self.root.is_none() {
            return;
        }
        if !shown(self, WIN_W.get()) {
            self.sidebar = Some(true);
        }
        self.close_search();
        self.marked = None;
        self.renaming = None;
        let rows = self.tree_rows();
        if self.tree_cur.as_ref().is_none_or(|c| !rows.iter().any(|r| r.path == *c)) {
            self.tree_cur = self.path.clone().filter(|p| rows.iter().any(|r| r.path == *p)).or_else(|| rows.first().map(|r| r.path.clone()));
        }
        self.tree_focus = self.tree_cur.is_some();
    }

    /// The tree's current row's index in `rows` (the open note's when the current row isn't shown).
    fn tree_index(&self, rows: &[Row]) -> usize {
        let at = |p: &Option<PathBuf>| p.as_ref().and_then(|p| rows.iter().position(|r| r.path == *p));
        at(&self.tree_cur).or_else(|| at(&self.path)).unwrap_or(0)
    }

    /// The tree's current row moves to `rows[i]`: a note opens at once (the keys stay in the tree), a folder
    /// is only selected (New note goes there).
    fn tree_go(&mut self, rows: &[Row], i: usize, tx: &mut Tx) {
        let Some(r) = rows.get(i) else { return };
        self.tree_cur = Some(r.path.clone());
        if !r.dir {
            self.open_note(r.path.clone(), tx);
        }
        tx.scroll_into_view(format!("row:{}", r.rel));
    }

    /// A key while the tree has the keys (it never reaches the editor): Up/Down, Right (expand / first
    /// child), Left (collapse / parent), Home/End, Enter (a note: to the editor; a folder: open or close it),
    /// Tab and Esc (to the editor), Delete / ⌘⌫ (the row's Delete), and type-ahead (what's typed within a second
    /// jumps to a row by name).
    pub fn tree_key(&mut self, ev: &KeyEvent, now: Instant, tx: &mut Tx) -> bool {
        let rows = self.tree_rows();
        if rows.is_empty() {
            self.tree_focus = false;
            return false;
        }
        let i = self.tree_index(&rows);
        let last = rows.len() - 1;
        let r = rows[i].clone();
        // Space acts as Enter, unless it's part of a name being typed (the web's tree keys)
        let typing = !self.tree_typed.0.is_empty() && self.tree_typed.1.is_some_and(|t| now.duration_since(t) <= std::time::Duration::from_secs(1));
        let space = matches!(&ev.key, Key::Text(s) if s == " ") && !(ev.mods.cmd || ev.mods.ctrl || ev.mods.alt);
        let key = if space && !typing { Key::Enter } else { ev.key.clone() };
        match &key {
            Key::Down => self.tree_go(&rows, (i + 1).min(last), tx),
            Key::Up => self.tree_go(&rows, i.saturating_sub(1), tx),
            Key::Home => self.tree_go(&rows, 0, tx),
            Key::End => self.tree_go(&rows, last, tx),
            Key::Right if r.dir => {
                if !r.open {
                    self.collapsed.remove(&r.path);
                    self.tree_cur = Some(r.path.clone());
                } else if rows.get(i + 1).is_some_and(|n| n.depth > r.depth) {
                    self.tree_go(&rows, i + 1, tx);
                }
            }
            Key::Left => {
                if r.dir && r.open {
                    self.collapsed.insert(r.path.clone());
                    self.tree_cur = Some(r.path.clone());
                } else if let Some(p) = rows[..i].iter().rposition(|x| x.depth < r.depth) {
                    self.tree_go(&rows, p, tx);
                }
            }
            Key::Enter if r.dir => {
                if !self.collapsed.remove(&r.path) {
                    self.collapsed.insert(r.path.clone());
                }
                self.tree_cur = Some(r.path.clone());
            }
            // Delete, forward Delete or ⌘⌫ (Finder's): the row menu's Delete, its confirm (Return deletes, Escape keeps
            // the row focused); nothing in a read-only workspace or while renaming
            Key::Backspace | Key::Delete if !(ev.mods.ctrl || ev.mods.alt || ev.mods.shift) => {
                if self.tree_editable() && self.renaming.is_none() {
                    self.ask_delete(&r.rel);
                }
            }
            // the row's menu, as a right-click on it (Rune's own Shift+F10 / Menu key needs a focused element)
            Key::ContextMenu if !(ev.mods.cmd || ev.mods.ctrl || ev.mods.alt) => self.row_menu(r.rel.clone(), format!("row:{}", r.rel), tx),
            Key::Function(10) if ev.mods.shift && !(ev.mods.cmd || ev.mods.ctrl || ev.mods.alt) => self.row_menu(r.rel.clone(), format!("row:{}", r.rel), tx),
            Key::Enter | Key::Tab | Key::Escape => {
                if !r.dir {
                    self.open_note(r.path.clone(), tx);
                }
                self.tree_focus = false;
            }
            Key::Text(s) if !(ev.mods.cmd || ev.mods.ctrl) && (typing || !s.trim().is_empty()) => {
                if !typing {
                    self.tree_typed.0.clear();
                }
                self.tree_typed.0.push_str(&s.to_lowercase());
                self.tree_typed.1 = Some(now);
                let typed = self.tree_typed.0.clone();
                // one letter: the next row starting with it (again and again); more: from the current row
                let start = if typed.chars().count() == 1 { i + 1 } else { i };
                let hit = (0..rows.len()).map(|k| (start + k) % rows.len()).find(|&k| rows[k].name.to_lowercase().starts_with(&typed));
                if let Some(k) = hit {
                    self.tree_go(&rows, k, tx);
                }
            }
            _ => {}
        }
        true
    }
}

pub fn view(app: &App) -> El {
    if app.root.is_none() {
        return el();
    }
    let rows = app.tree_rows();
    let tree_focused = app.tree_focus && !app.search.open;
    let menu = app.tree_editable();
    let mut tree: Vec<El> = Vec::new();
    for r in rows.iter() {
        match &app.renaming {
            Some((rel, field)) if *rel == r.rel => tree.push(rename_el(r, field)),
            _ => tree.push(row_el(r, app.path.as_ref() == Some(&r.path), tree_focused && app.tree_cur.as_ref() == Some(&r.path), menu, &here(app, r))),
        }
    }
    // the web's `.tree-note`: muted 13 pt; an error in ink-2 after a 6 pt yellow dot
    if let Some((note, error)) = app.tree_note() {
        tree.clear();
        let w = SIDEBAR_W - 20.0 - 16.0;
        let mut r = row().key("tree-note-row").pl(20.0).pr(16.0).pt(4.0).pb(6.0).gap(7.0);
        if error {
            r = r.child(el().key("tree-note-dot").size(6.0, 6.0).radius(3.0).mt(6.0).fill(c("#e0a800")));
        }
        let tw = if error { w - 13.0 } else { w };
        tree.push(r.child(text(note).key("tree-note").font(TextStyle::new(13.0, 400.0).lh(18.0)).color(c(if error { INK_2 } else { MUTED })).w(tw).wrap()));
    }
    col()
        .key("sidebar")
        .w(SIDEBAR_W)
        .h_full()
        .fill(c(PAPER_2))
        // A drop target that takes nothing: files over the sidebar leave the page (its drop caret
        // hides), even where the sidebar covers the page in a narrow window.
        .on_drop_files(|_: &mut App, _: &[PathBuf], _: &mut Tx| {})
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
                // a hard clip; the top and bottom fade only while rows are scrolled under them (never at rest)
                .clip_soft(0.0)
                .scroll_edge_fade(12.0)
                .scroll_margin(12.0)
                .child(col().key("tree-rows").w_full().pb(32.0).children(tree)),
        )
        .children(app.agent_card_shown().then(|| agent_card(app)))
        .children(switcher::account_row(app))
}

/// The "Share with an agent" card's state: its Copy just copied ("Copied" for a moment), a link being made,
/// and the agent links made so far (server, folder id → URL), so later copies don't wait for the server.
#[derive(Debug, Default)]
pub struct AgentCard {
    pub copied: bool,
    pub busy: bool,
    pub urls: std::collections::HashMap<(String, String), String>,
}

/// Pinned at the bottom of the sidebar (the web's `.sb-agent`): "Share with an agent" and Copy, which copies
/// instructions for an agent to work in the open folder (`actions::copy_agent_prompt`).
fn agent_card(app: &App) -> El {
    row()
        .key("agent-card")
        .w(SIDEBAR_W - 24.0)
        .ml(12.0)
        .mt(8.0)
        // the account row, when there is one, sits 8 pt below
        .mb(if crate::menu::account_server(app).is_some() { 8.0 } else { 12.0 })
        .pl(12.0)
        .pr(8.0)
        .py(8.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
        .fill(c(TINT_HOVER))
        // the webs label: on two lines in the Macs narrower sidebar, never cut
        .child(text("Share this workspace with an agent").key("agent-card-label").font(TextStyle::new(13.0, crate::theme::wt(450.0)).lh(18.0)).color(c(INK_2)).w(SIDEBAR_W - 24.0 - 20.0 - 62.0).wrap())
        .child(crate::dialogs::button(
            if app.agent.copied { "Copied" } else { "Copy" },
            "agent-copy",
            crate::dialogs::Btn::Small,
            app.agent.busy,
            Box::new(crate::actions::copy_agent_prompt),
        ))
}

impl App {
    /// "+ New note" shows: hidden, as the web's, while a remote workspace isn't loaded or is read-only.
    pub fn shows_new_note(&self) -> bool {
        self.remote.is_none() || self.remote_writable()
    }
}

/// The "Search files" button, then "+ New note" under it (the web's order).
fn tools(app: &App) -> El {
    let field = crate::filesearch::button(FIELD_W).ml(ROW_INSET);
    let tools = col().key("sb-tools").w_full().pl(ROW_INSET).pr(12.0).pt(8.0).pb(14.0).gap(10.0).child(field);
    if !app.shows_new_note() {
        return tools;
    }
    // A quiet action, not a heading: regular weight, muted (darker on hover), a light plus.
    let (ink, plus_ink) = (MUTED, "#8b8b93");
    // The plus in the chevrons' 10 pt box, its centre on the top-level chevrons' (ROW_INSET + INDENT from
    // the sidebar's edge; the tools column starts at ROW_INSET), the label where top-level names start
    // (ROW_INSET + INDENT + 12).
    let plus = el()
        .key("plus")
        .size(10.0, 10.0)
        .child(el().key("plus-h").absolute(0.0, 4.25).size(10.0, 1.5).fill(c(plus_ink)))
        .child(el().key("plus-v").absolute(4.25, 0.0).size(1.5, 10.0).fill(c(plus_ink)));
    let label = text("New note").key("new-note-text").font(TextStyle::new(13.5, 400.0).lh(18.0)).color(c(ink));
    let label = label.group_color(c(INK));
    let new_note = row()
        .key("new-note")
        .w_full()
        .h(ROW_H)
        .pl(INDENT - 5.0)
        .pr(8.0)
        .gap(12.0 - 5.0)
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
        .child(label);
    // the search button first (right under the switcher), then New note (as on the web)
    tools.child(new_note)
}

/// A tree row: the open note in the quiet grey (bold); the tree's current row, while the tree has the keys,
/// only by its background, a light blue tint (the text stays dark; hover doesn't change it). With
/// `menu` (the folder takes edits) a right-click, Ctrl-click or its ⋯ (shown on hover and on the current
/// row) opens the native row menu (New note, New folder, Rename, Delete).
fn row_el(r: &Row, active: bool, focused: bool, menu: bool, people: &[crate::header::Person]) -> El {
    let w = SIDEBAR_W - 2.0 * ROW_INSET;
    // Chevron centred at depth × INDENT, name 12 pt after it (files line up with folder names).
    let cx = r.depth as f32 * INDENT;
    let x = cx + 12.0;
    let style = TextStyle::new(14.0, if active { 600.0 } else { 400.0 }).lh(18.0);
    let (path, dir): (PathBuf, bool) = (r.path.clone(), r.dir);
    let rel = r.rel.clone();
    let mut e = el()
        .key(format!("row:{}", r.rel))
        .label(r.name.clone())
        // the web's `title`: the path in the workspace
        .help(r.rel.clone())
        .w(w)
        .h(ROW_H)
        .ml(ROW_INSET)
        .radius(6.0)
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            // Ctrl-click is a right-click (`on_secondary_press`).
            if d.phase != Phase::Down || tx.mods().ctrl {
                return;
            }
            app.row_down(&path, dir, tx);
        })
        // right-click, Ctrl-click, two-finger click: the menu at the pointer
        .on_secondary_press(move |app: &mut App, press, tx: &mut Tx| {
            app.row_menu(rel.clone(), press, tx);
            app.handled(tx);
        })
        .child(
            text(r.name.clone())
                .key(format!("name:{}", r.rel))
                .font(style)
                .color(c(if r.dir { INK_2 } else { INK }))
                .w(w - x - if menu { MORE + 8.0 } else { 8.0 } - dots_w(people))
                .truncate()
                .absolute(x, (ROW_H - 18.0) / 2.0),
        );
    if menu {
        e = e.child(more_button(r, w, focused));
    }
    if !people.is_empty() {
        let right = if menu { w - MORE - 4.0 - 4.0 } else { w - 8.0 };
        e = e.child(presence_dots(r, people).absolute(right - dots_w(people) + 6.0, (ROW_H - 14.0) / 2.0));
    }
    // (every row is a hover group, for its ⋯)
    e = if focused {
        e.fill(c(TREE_FOCUS)).hover(c(TREE_FOCUS))
    } else if active {
        e.fill(c(TINT_ACTIVE)).hover(c(TINT_ACTIVE))
    } else {
        e.hover(c(TINT_HOVER))
    };
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

    /// Rename: the row becomes a field holding the path (a note's without `.md`), its last name selected.
    /// Return renames (`App::rename_path`), Escape keeps the old name.
    /// Rename, as the web's inline rename: the row's name only (a note's without `.md`), all selected. Return or
    /// a click elsewhere renames it in its folder; Escape keeps it.
    pub fn start_rename(&mut self, rel: &str) {
        if self.guest_blocks(crate::dialogs::GuestAction::Rename(rel.to_string())) {
            return;
        }
        self.close_search();
        self.marked = None;
        let shown = self.rename_name(rel);
        let mut f = TextEdit::new(&shown);
        f.focused = true;
        f.anchor = 0;
        f.focus = shown.len();
        self.renaming = Some((rel.to_string(), f));
    }

    /// What the rename field holds for `rel`: its last name, a note's without its extension.
    fn rename_name(&self, rel: &str) -> String {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if self.is_dir_rel(rel) { name } else { name.strip_suffix(".md").or_else(|| name.strip_suffix(".markdown")).unwrap_or(name) }.to_string()
    }

    pub fn submit_rename(&mut self, tx: &mut Tx) {
        let Some((from, f)) = self.renaming.take() else { return };
        let name = f.text.trim();
        if name.is_empty() || name == self.rename_name(&from) {
            self.handled(tx);
            return;
        }
        if name.contains(['/', '\\']) || name == "." || name == ".." {
            self.show_error("A name can't contain / or \\.".into());
            self.handled(tx);
            return;
        }
        // in the same folder, keeping a note's extension (the web's `ext || ".md"`)
        let ext = if self.is_dir_rel(&from) {
            ""
        } else if from.ends_with(".markdown") {
            ".markdown"
        } else {
            ".md"
        };
        let to = match from.rsplit_once('/') {
            Some((folder, _)) => format!("{folder}/{name}{ext}"),
            None => format!("{name}{ext}"),
        };
        self.rename_path(&from, &to, tx);
        self.handled(tx);
    }
}

/// The other people in a remote note (the event stream's presence), not us.
fn here(app: &App, r: &Row) -> Vec<crate::header::Person> {
    let Some(rem) = app.remote.as_ref().filter(|_| !r.dir) else { return Vec::new() };
    let me = rem.user["id"].as_str().unwrap_or_default();
    app.presence.get(&(rem.id().to_string(), r.rel.clone())).map(|v| v.iter().filter(|p| p.id != me).cloned().collect()).unwrap_or_default()
}

/// How much of the row the dots take (with the 6 pt before them), none without people.
fn dots_w(people: &[crate::header::Person]) -> f32 {
    match people.len() {
        0 => 0.0,
        n => 6.0 + n.min(4) as f32 * 10.0 - 3.0 + if n > 4 { 1.0 + 6.0 * format!("+{}", n - 4).len() as f32 } else { 0.0 },
    }
}

/// The web's `.presence-dots`: up to four 7 pt squares (2 pt corners) in each person's colour, an agent's
/// hollow, then "+N"; their names as the tooltip.
fn presence_dots(r: &Row, people: &[crate::header::Person]) -> El {
    let names: Vec<&str> = people.iter().map(|p| p.name.as_str()).collect();
    // absolute in its row (nothing moves) and faded in when it arrives
    let mut d = row().key(format!("dots:{}", r.rel)).h(14.0).gap(3.0).center_y().help(names.join(", ")).transition(Transition::opacity());
    for (i, p) in people.iter().take(4).enumerate() {
        let col = rune::color::hex(&p.color).unwrap_or_else(|| c("#888888"));
        let dot = el().key(format!("pdot{i}:{}", r.rel)).size(7.0, 7.0).radius(2.0);
        d = d.child(if p.kind == "agent" { dot.border(1.5, col) } else { dot.fill(col) });
    }
    if people.len() > 4 {
        d = d.child(text(format!("+{}", people.len() - 4)).key(format!("pmore:{}", r.rel)).font(TextStyle::new(10.5, 400.0).lh(14.0)).color(c(MUTED)).ml(1.0));
    }
    d
}

/// The ⋯ at a row's right end (20 pt, darker over itself): shown while the row is hovered or current; a
/// press opens the row's menu under the row.
const MORE: f32 = 20.0;

/// The tree's focused row: the app blue (#296d9a) 18 % over the sidebar (#f4f4f5), mixed in sRGB as the
/// web's `color-mix(in srgb, var(--blue) 18%, var(--paper-2))` (Rune blends alpha in linear light, which
/// would come out greyer). No edge, no ring.
const TREE_FOCUS: &str = "#d0dce5";

fn more_button(r: &Row, w: f32, lit: bool) -> El {
    let rel = r.rel.clone();
    let dot = |i: usize| el().key(format!("more-dot{i}:{}", r.rel)).absolute(3.5 + 5.0 * i as f32, 8.5).size(3.0, 3.0).radius(1.5).fill(c(INK_2));
    let button = el()
        .key(format!("more:{}", r.rel))
        .label("More actions")
        .help("More")
        .size(MORE, MORE)
        .radius(4.0)
        .hover(c(TINT_ACTIVE))
        .child(el().key(format!("more-dots:{}", r.rel)).size(MORE, MORE).group_opacity(0.6, 1.0).child(dot(0)).child(dot(1)).child(dot(2)))
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.row_menu(rel.clone(), format!("row:{rel}"), tx);
                app.handled(tx);
            }
        });
    let slot = el().key(format!("more-slot:{}", r.rel)).size(MORE, MORE).absolute(w - MORE - 4.0, (ROW_H - MORE) / 2.0).child(button);
    if lit { slot } else { slot.group_opacity(0.0, 1.0) }
}

/// The row being renamed (a note or a folder): a field in place of its name.
fn rename_el(r: &Row, field: &TextEdit) -> El {
    let w = SIDEBAR_W - 2.0 * ROW_INSET;
    let x = r.depth as f32 * INDENT + 6.0;
    el().key(format!("renaming:{}", r.rel)).w(w).h(ROW_H).ml(ROW_INSET).child(
        text_input(field, TextStyle::new(13.5, 400.0).lh(18.0))
            .single_line()
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
            .on_input_key(|app: &mut App, ev: &rune::KeyEvent, tx: &mut Tx| {
                if !matches!(ev.key, rune::Key::Escape) {
                    return false;
                }
                app.renaming = None;
                app.handled(tx)
            })
            .on_submit(|app: &mut App, tx: &mut Tx| app.submit_rename(tx))
            .absolute(x, 0.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files;
    use rune::Mods;

    fn key(k: Key) -> KeyEvent {
        KeyEvent { key: k, mods: Mods::default() }
    }

    /// a.md, z.md, b/c.md, b/d/e.md: the tree's rows are b, b/d, b/d/e.md, b/c.md, a.md, z.md.
    fn tree_app(name: &str) -> (App, PathBuf) {
        let dir = std::env::temp_dir().join(format!("grimoire-tree-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (p, t) in [("a.md", "# A"), ("z.md", "# Z"), ("b/c.md", "# C"), ("b/d/e.md", "# E")] {
            let f = dir.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, t).unwrap();
        }
        let dir = std::fs::canonicalize(&dir).unwrap();
        let app = App::new("# A", Some(dir.join("a.md")), true).with_root(Some(dir.clone()), files::scan(&dir).0);
        (app, dir)
    }

    fn rels(app: &App) -> Vec<String> {
        app.tree_rows().iter().map(|r| r.rel.clone()).collect()
    }

    fn cur(app: &App, dir: &Path) -> String {
        files::rel(dir, app.tree_cur.as_ref().unwrap())
    }

    fn press(app: &mut App, k: Key, tx: &mut Tx) {
        crate::input::on_key(app, &key(k), tx);
    }

    /// Delete, forward Delete or ⌘⌫ on a focused row: the row menu's confirm; Escape keeps the row focused,
    /// Return deletes; the focus goes to the next row (the previous after the last), and the open note deleted
    /// gives way to the next note. Nothing while renaming or in a read-only workspace.
    #[test]
    fn delete_keys_delete_the_focused_row_after_the_confirm() {
        let (mut app, dir) = tree_app("delete-keys");
        let mut tx = Tx::default();
        app.focus_tree();
        // b/c.md, the open note
        app.tree_cur = Some(dir.join("b/c.md"));
        app.open_note(dir.join("b/c.md"), &mut tx);
        app.tree_focus = true;
        press(&mut app, Key::Backspace, &mut tx);
        let Some(crate::dialogs::Dialog::Confirm(c)) = &app.dialog else { panic!("the confirm") };
        assert_eq!((c.title.as_str(), c.message.as_str()), ("Delete note", "Move “b/c.md” to the Trash?"));
        // Escape: kept, the row still focused
        press(&mut app, Key::Escape, &mut tx);
        assert!(app.dialog.is_none() && app.tree_focus);
        assert_eq!(cur(&app, &dir), "b/c.md");
        assert!(rels(&app).contains(&"b/c.md".to_string()));
        // forward Delete, Return: gone; the next row (a.md) has the focus and opens (it was the open note)
        press(&mut app, Key::Delete, &mut tx);
        assert!(app.dialog.is_some());
        press(&mut app, Key::Enter, &mut tx);
        assert_eq!(rels(&app), ["b", "b/d", "b/d/e.md", "a.md", "z.md"]);
        assert_eq!(cur(&app, &dir), "a.md");
        assert_eq!(app.path, Some(dir.join("a.md")), "the next note opens");
        assert!(app.tree_focus);
        // ⌘⌫ on the last row: the previous row next; a note that wasn't open doesn't change the open one
        app.tree_cur = Some(dir.join("z.md"));
        crate::input::on_key(&mut app, &KeyEvent { key: Key::Backspace, mods: Mods { cmd: true, ..Mods::default() } }, &mut tx);
        press(&mut app, Key::Enter, &mut tx);
        assert_eq!(rels(&app), ["b", "b/d", "b/d/e.md", "a.md"]);
        assert_eq!(cur(&app, &dir), "a.md", "the previous row after the last");
        assert_eq!(app.path, Some(dir.join("a.md")));
        // a folder: its confirm, then the row after it
        app.tree_cur = Some(dir.join("b/d"));
        press(&mut app, Key::Backspace, &mut tx);
        let Some(crate::dialogs::Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!(c.title, "Delete folder");
        press(&mut app, Key::Enter, &mut tx);
        assert_eq!(rels(&app), ["b", "a.md"]);
        assert_eq!(cur(&app, &dir), "a.md");
        // not while renaming
        app.renaming = Some(("a.md".into(), crate::dialogs::field_edit("a")));
        app.tree_focus = true;
        app.tree_cur = Some(dir.join("a.md"));
        app.tree_key(&key(Key::Backspace), std::time::Instant::now(), &mut tx);
        assert!(app.dialog.is_none(), "renaming: no delete");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_tree_moves_with_the_keys_and_keeps_them_from_the_editor() {
        let (mut app, dir) = tree_app("keys");
        let mut tx = Tx::default();
        assert_eq!(rels(&app), ["b", "b/d", "b/d/e.md", "b/c.md", "a.md", "z.md"]);
        // ⌘⇧E: the tree at the open note
        crate::input::on_key(&mut app, &KeyEvent { key: Key::Command('e'), mods: Mods { cmd: true, shift: true, ..Mods::default() } }, &mut tx);
        assert!(app.tree_focus);
        assert_eq!(cur(&app, &dir), "a.md");
        // typing doesn't reach the editor
        press(&mut app, Key::Text("x".into()), &mut tx);
        assert_eq!(app.ed.text(), "# A");
        // Up onto a note opens it, the keys stay in the tree
        press(&mut app, Key::Up, &mut tx);
        assert_eq!((cur(&app, &dir).as_str(), app.ed.text()), ("b/c.md", "# C"));
        assert!(app.tree_focus);
        // Home: the folder b, only selected (the note stays open)
        press(&mut app, Key::Home, &mut tx);
        assert_eq!(cur(&app, &dir), "b");
        assert_eq!(app.ed.text(), "# C");
        press(&mut app, Key::Up, &mut tx);
        assert_eq!(cur(&app, &dir), "b", "no wrap at the top");
        // Left on an open folder closes it; on a top-level row it stays
        press(&mut app, Key::Left, &mut tx);
        assert_eq!(rels(&app), ["b", "a.md", "z.md"]);
        press(&mut app, Key::Left, &mut tx);
        assert_eq!(cur(&app, &dir), "b");
        // Right opens it, then goes to its first child
        press(&mut app, Key::Right, &mut tx);
        assert_eq!(rels(&app).len(), 6);
        press(&mut app, Key::Right, &mut tx);
        assert_eq!(cur(&app, &dir), "b/d");
        // Enter on a folder toggles it
        press(&mut app, Key::Enter, &mut tx);
        assert_eq!(rels(&app), ["b", "b/d", "b/c.md", "a.md", "z.md"]);
        // Down from b/d: b/c.md (b/d is closed); Left from a note: its parent
        press(&mut app, Key::Down, &mut tx);
        assert_eq!(cur(&app, &dir), "b/c.md");
        press(&mut app, Key::Left, &mut tx);
        assert_eq!(cur(&app, &dir), "b");
        // End, and no wrap at the bottom
        press(&mut app, Key::End, &mut tx);
        press(&mut app, Key::Down, &mut tx);
        assert_eq!((cur(&app, &dir).as_str(), app.ed.text()), ("z.md", "# Z"));
        // type-ahead: "a" jumps to a.md (the "x" typed earlier was more than a second ago)
        app.tree_typed.1 = None;
        press(&mut app, Key::Text("a".into()), &mut tx);
        assert_eq!(cur(&app, &dir), "a.md");
        // Escape: back to the editor, which takes keys again
        press(&mut app, Key::Escape, &mut tx);
        assert!(!app.tree_focus);
        press(&mut app, Key::Text("x".into()), &mut tx);
        assert!(app.ed.text().contains('x') && app.ed.text().len() == 4, "{:?}", app.ed.text());
        // Enter on a note (and Tab) give the editor the keys too
        app.focus_tree();
        press(&mut app, Key::Tab, &mut tx);
        assert!(!app.tree_focus);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Folders opened or closed stay so in the next launch (the store's `folders`, as the web's localStorage).
    #[test]
    fn open_and_closed_folders_are_remembered() {
        let (_, dir) = tree_app("remember");
        let support = std::env::temp_dir().join(format!("grimoire-remember-support-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&support);
        let launch = || {
            let mut app = App::new("# A", Some(dir.join("a.md")), true);
            app.store = crate::workspaces::Store::load(Some(support.clone()));
            app.with_root(Some(dir.clone()), files::scan(&dir).0)
        };
        let mut app = launch();
        let mut tx = Tx::default();
        assert_eq!(rels(&app), ["b", "b/d", "b/d/e.md", "b/c.md", "a.md", "z.md"]);
        app.row_down(&dir.join("b/d"), true, &mut tx);
        assert_eq!(app.store.folder_open(&dir.join("b/d")), Some(false));
        let app = launch();
        assert_eq!(rels(&app), ["b", "b/d", "b/c.md", "a.md", "z.md"], "b/d stays closed");
        // opening it again: as the default, nothing to remember
        let mut app = app;
        app.row_down(&dir.join("b/d"), true, &mut tx);
        assert_eq!(app.store.folder_open(&dir.join("b/d")), None);
        assert_eq!(launch().tree_rows().len(), 6);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&support);
    }

    #[test]
    fn typeahead_waits_a_second() {
        let (mut app, dir) = tree_app("typeahead");
        let mut tx = Tx::default();
        // type-ahead: "z" then (within a second) nothing more; after a second the buffer starts over
        app.focus_tree();
        let t0 = Instant::now();
        app.tree_key(&key(Key::Text("z".into())), t0, &mut tx);
        assert_eq!(cur(&app, &dir), "z.md");
        app.tree_key(&key(Key::Text("a".into())), t0 + std::time::Duration::from_millis(300), &mut tx);
        assert_eq!(cur(&app, &dir), "z.md", "\"za\": no row");
        app.tree_key(&key(Key::Text("a".into())), t0 + std::time::Duration::from_millis(1500), &mut tx);
        assert_eq!(cur(&app, &dir), "a.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Space: Enter's job (a folder opens or closes, a note opens and takes the keys), except while typing a name.
    #[test]
    fn space_acts_as_enter_unless_typing() {
        let (mut app, dir) = tree_app("space");
        let mut tx = Tx::default();
        app.focus_tree();
        let t0 = Instant::now();
        let at = |ms: u64| t0 + std::time::Duration::from_millis(ms);
        // typing "z" then a space within a second: part of the name ("z " matches nothing), the tree keeps the keys
        app.tree_key(&key(Key::Text("z".into())), at(0), &mut tx);
        app.tree_key(&key(Key::Text(" ".into())), at(200), &mut tx);
        assert_eq!((cur(&app, &dir).as_str(), app.tree_focus), ("z.md", true));
        // later: Space on the folder b toggles it
        app.tree_key(&key(Key::Home), at(3000), &mut tx);
        let before = rels(&app).len();
        app.tree_key(&key(Key::Text(" ".into())), at(3100), &mut tx);
        assert_ne!(rels(&app).len(), before, "the folder toggled");
        // Space on a note opens it and gives the editor the keys
        app.tree_key(&key(Key::End), at(3200), &mut tx);
        app.tree_key(&key(Key::Text(" ".into())), at(3300), &mut tx);
        assert_eq!((app.ed.text(), app.tree_focus), ("# Z", false));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
