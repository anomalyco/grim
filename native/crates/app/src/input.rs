//! Keyboard, IME and mouse glue between Rune and the editor.
//!
//! - Keys: `on_key` → `insert_text`, or `Editor::key` through the macOS key table (`keys`: Cocoa's
//!   bindings and the user's DefaultKeyBinding.dict), plus the clipboard and Cmd-S. Of the
//!   commands it returns, the UI performs paging (`Page`: PageUp/PageDown, Option-PageUp/PageDown,
//!   Ctrl-V), Ctrl-L (`CenterSelection`) and Home/End (`ScrollToStart/End`, which scroll without
//!   moving the caret); every other key keeps the caret in view (`Tx::scroll_into_view`, with the scroll view's `scroll_margin`). App shortcuts come first (Cmd-\ / Cmd-Shift-L, Cmd-Shift-E; Cmd-N, Shift-Cmd-N, Cmd-O and Cmd-P are the File menu's, `tree_edit::FILE_MENU`);
//!   while the search dialog is open every other key is left to its field.
//! - IME: `on_ime` keeps the marked text in `App` (the view splices it in at the caret) and
//!   commits through `begin_composition` / `end_composition`.
//! - Mouse: one `on_drag` on the surface. Rune measures `Drag` from the scrolled rect and counts
//!   clicks; Shift extends. A drag after a double or triple click doesn't extend by words or
//!   lines (editor-core has no such mode), it keeps the first selection. A plain click on a
//!   collapsed link's text opens it on release (`App::follow_link`) without touching the
//!   selection; dragging from it selects as usual. Links never reveal by the caret or selection
//!   (the caret steps through their text); only their pencil expands one for editing.

use editor_core::{Command, InlineType, Key as EKey, Mods as EMods, Sel};
use rune::{Drag, Ime, Key, KeyEvent, Phase, PointerButton, Tx};

use crate::App;
use crate::layout::{col_w, view_h};
use crate::theme::*;

pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let m = ev.mods;
    // A dialog has the keys: Esc closes it, Return confirms a confirm dialog, its fields take the rest.
    if let Some(d) = &app.dialog {
        app.marked = None;
        if matches!(ev.key, Key::Escape) {
            app.close_dialog();
            return app.handled(tx);
        }
        let typing = d.typing();
        if matches!(ev.key, Key::Enter) && matches!(d, crate::dialogs::Dialog::Welcome(_)) {
            app.close_dialog();
            return app.handled(tx);
        }
        if matches!(ev.key, Key::Enter) && !typing && matches!(d, crate::dialogs::Dialog::Confirm(_)) {
            crate::actions::confirm_default(app, tx);
            return app.handled(tx);
        }
        // The Open dialog's "Folder" has no field: Return opens the picker.
        if matches!(ev.key, Key::Enter) && !typing && matches!(d, crate::dialogs::Dialog::Open(_)) {
            crate::actions::submit_open(app, tx);
            return app.handled(tx);
        }
        return !typing;
    }
    // App shortcuts work wherever the focus is.
    if let Key::Command(ch) = &ev.key {
        match ch {
            '\\' => {
                app.toggle_sidebar();
                return app.handled(tx);
            }
            'l' if m.shift => {
                app.toggle_sidebar();
                return app.handled(tx);
            }
            // ⌘⇧E: the tree takes the keys, at its current row
            'e' | 'E' if m.shift && app.root.is_some() => {
                app.focus_tree();
                return app.handled(tx);
            }
            _ => {}
        }
    }
    // The switcher's menu or the account menu: Esc closes it; in the switcher, Up/Down move the keyboard
    // highlight over its rows and items, Return chooses, Delete/Backspace on a folder row is its ×.
    if app.switcher.open || app.switcher.account_open {
        app.marked = None;
        if matches!(ev.key, Key::Escape) {
            app.close_switcher();
            return app.handled(tx);
        }
        if app.switcher.open {
            app.switcher_key(&ev.key, tx);
            return app.handled(tx);
        }
        return true;
    }
    // A note being renamed (Esc cancels).
    if app.renaming.as_ref().is_some_and(|(_, f)| f.focused) {
        app.marked = None;
        if matches!(ev.key, Key::Escape) {
            app.renaming = None;
            return app.handled(tx);
        }
        return false;
    }
    // The "Search files" dialog has the keys: Up/Down, Return and Esc are its, the rest go to its field.
    if app.search.open {
        app.marked = None;
        app.tree_focus = false;
        if app.search_key(ev, tx) {
            return app.handled(tx);
        }
        return false;
    }
    // The tree has the keys: none of them reach the editor.
    if app.tree_focus && app.root.is_some() && crate::sidebar::shown(app, crate::sidebar::window_w()) {
        app.marked = None;
        if app.tree_key(ev, std::time::Instant::now(), tx) {
            return app.handled(tx);
        }
    }
    if app.root.is_some() && app.path.is_none() {
        return false;
    }
    // Cmd-Enter with the caret in or at a link opens it.
    if matches!(ev.key, Key::Enter)
        && m.cmd
        && !(m.shift || m.ctrl || m.alt)
        && let Some(raw) = link_at_caret(app)
    {
        app.follow_link(&raw, tx);
        return true;
    }
    let mods = EMods { shift: m.shift, ctrl: m.ctrl, alt: m.alt, cmd: m.cmd };
    let key = match &ev.key {
        Key::Text(s) => {
            let mut chars = s.chars();
            let first = chars.next();
            let single = first.filter(|_| chars.next().is_none());
            if m.ctrl || m.cmd {
                // Ctrl-letters arrive as the letter (Ctrl-Shift: uppercase) or as its control character.
                match single {
                    Some(ch) if (ch as u32) < 0x20 => EKey::Char(char::from(ch as u8 + 0x60)),
                    Some(ch) => EKey::Char(ch.to_ascii_lowercase()),
                    None => return false,
                }
            } else if let Some(b) = tx.key_base().filter(|&b| m.alt && bound(app, EKey::Char(b), mods)) {
                // Option+letter types its character unless the user's DefaultKeyBinding.dict binds
                // it ("~f" = "moveWordForward:"): `Tx::key_base` is the key's own letter for that.
                EKey::Char(b)
            } else {
                if s.is_empty() || s.chars().all(char::is_control) {
                    return false;
                }
                app.ed.insert_text(s);
                return keyed(app, tx);
            }
        }
        Key::Command(ch) => match ch {
            'c' => {
                if let Some(t) = app.ed.copy() {
                    tx.copy(t);
                }
                return app.handled(tx);
            }
            'x' => {
                if let Some(t) = app.ed.cut() {
                    tx.copy(t);
                }
                return keyed(app, tx);
            }
            'v' => {
                // read off the event thread: text, or images (a screenshot, files copied in Finder)
                tx.read_clipboard(|app: &mut App, content, tx| crate::uploads::paste(app, content, tx));
                return true;
            }
            's' => {
                app.save_now();
                app.git_commit_now();
                return app.handled(tx);
            }
            ch => EKey::Char(*ch),
        },
        Key::Enter => EKey::Enter,
        Key::Backspace => EKey::Backspace,
        Key::Delete => EKey::Delete,
        Key::Left => EKey::Left,
        Key::Right => EKey::Right,
        Key::Up => EKey::Up,
        Key::Down => EKey::Down,
        Key::Home => EKey::Home,
        Key::End => EKey::End,
        Key::PageUp => EKey::PageUp,
        Key::PageDown => EKey::PageDown,
        Key::Escape => EKey::Escape,
        Key::Tab => EKey::Tab,
        // Function keys, the context-menu key and any key Rune adds later.
        _ => return false,
    };
    // Enter at or after the first line: an untitled note may take its heading as its name (`App::auto_name`)
    let name_it = matches!(key, EKey::Enter) && !(m.cmd || m.ctrl || m.alt) && {
        let t = app.ed.text();
        let sel = app.ed.selection();
        sel.anchor.min(sel.head) >= t.find('\n').unwrap_or(t.len())
    };
    let geo = app.geometry();
    match app.ed.key(key, mods, &geo) {
        None => false,
        Some(Command::ScrollToStart) => {
            tx.scroll_to_y("scroll", 0.0);
            app.handled(tx)
        }
        Some(Command::ScrollToEnd) => {
            tx.scroll_to_y("scroll", f32::INFINITY);
            app.handled(tx)
        }
        Some(Command::Page { dir, extend }) => {
            page(app, dir as f32, extend);
            keyed(app, tx)
        }
        Some(Command::CenterSelection) => {
            let (_, top, bottom) = app.geometry().caret(app.ed.selection().head);
            tx.scroll_to_y("scroll", PAD_T + (top + bottom) / 2.0 - view_h() / 2.0);
            app.handled(tx)
        }
        Some(_) => {
            if name_it {
                app.auto_name(tx);
            }
            keyed(app, tx)
        }
    }
}

/// The URL source of the link holding the caret (or touching it).
fn link_at_caret(app: &App) -> Option<String> {
    let sel = app.ed.selection();
    let doc = app.ed.doc();
    let line = doc.line_of(sel.head);
    let el = line.inline.iter().find(|e| e.ty == InlineType::Link && e.from <= sel.head && sel.head <= e.to)?;
    let (a, b) = el.url?;
    Some(doc.text[a..b].to_string())
}

/// The key table binds this chord.
fn bound(app: &App, key: EKey, mods: EMods) -> bool {
    app.ed.key_table().is_some_and(|t| t.lookup(key, mods).is_some())
}

/// After a keyboard edit or move: the usual bookkeeping, and the caret scrolls into view.
fn keyed(app: &mut App, tx: &mut Tx) -> bool {
    tx.scroll_into_view("caret");
    app.handled(tx)
}

/// PageUp/PageDown: the caret moves by a viewport page (less two lines of overlap), keeping its
/// x; Shift extends. Past either end it goes to the document's start or end.
fn page(app: &mut App, dir: f32, extend: bool) {
    let geo = app.geometry();
    let sel = app.ed.selection();
    let (x, top, bottom) = geo.caret(sel.head);
    let step = (view_h() - 2.0 * body().line_px()).max(body().line_px());
    let y = (top + bottom) / 2.0 + dir * step;
    let p = if y < 0.0 {
        0
    } else if y >= geo.height {
        app.ed.text().len()
    } else {
        app.ed.hit_test(&geo, f64::from(x), f64::from(y)).unwrap_or(sel.head)
    };
    app.ed.set_selection(if extend { Sel::new(sel.anchor, p) } else { Sel::caret(p) });
}

/// IME composition: dead keys, the accent picker and CJK input. The marked text isn't in the
/// document; the view draws it (`App::marked`). Keys pressed while composing go to the IME, not
/// `on_key`, so the selection is still the one the composition started from when it commits.
pub fn on_ime(app: &mut App, ev: &Ime, tx: &mut Tx) -> bool {
    if app.search.input.focused || app.other_field_focused() || app.dialog.is_some() {
        app.marked = None;
        return false;
    }
    if app.root.is_some() && app.path.is_none() {
        return false;
    }
    match ev {
        Ime::Preedit(text, cursor) => {
            app.marked = (!text.is_empty()).then(|| (text.clone(), cursor.map_or(text.len(), |c| c.1)));
        }
        Ime::Commit(text) => {
            app.ed.begin_composition();
            app.ed.end_composition(text);
            app.marked = None;
        }
        Ime::Enabled => return false,
        Ime::Disabled => app.marked = None,
    }
    keyed(app, tx)
}

/// A press on a collapsed link's text that hasn't moved (yet): it opens on release.
pub struct LinkPress {
    /// Where it was pressed (surface points).
    x: f32,
    y: f32,
    /// The link's URL as written.
    url: String,
    /// Moved further than `LINK_SLOP`: a selection drag, not a click.
    moved: bool,
}

/// How far (points) a press on a link may move and still open it.
const LINK_SLOP: f32 = 4.0;

/// A press or drag on the surface. `Drag` is in surface points, scroll included.
pub fn surface_drag(app: &mut App, d: &mut Drag, tx: &mut Tx) {
    // a click in the page commits a rename (the web's blur)
    if d.phase == Phase::Down && app.renaming.is_some() {
        app.submit_rename(tx);
    }
    let g = Gesture { phase: d.phase, x: d.x, y: d.y, start_x: d.start_x, start_y: d.start_y, clicks: d.clicks, mods: tx.mods(), primary: tx.button() == PointerButton::Primary };
    surface_gesture(app, &g, tx);
}

/// What `surface_gesture` reads of a `Drag` and its `Tx` (tests build it; Rune's `Drag` has private fields).
#[derive(Clone, Copy)]
pub struct Gesture {
    pub phase: Phase,
    pub x: f32,
    pub y: f32,
    pub start_x: f32,
    pub start_y: f32,
    pub clicks: u32,
    pub mods: rune::Mods,
    pub primary: bool,
}

pub fn surface_gesture(app: &mut App, d: &Gesture, tx: &mut Tx) {
    // Pressing the page takes the keys back from the filter field and the tree.
    app.close_search();
    app.tree_focus = false;
    let geo = app.geometry();
    // in a table or code block scrolled sideways: where in its content
    let d = &Gesture { x: app.unscroll(&geo, d.x, d.y), start_x: app.unscroll(&geo, d.start_x, d.start_y), ..*d };
    let (x, y) = to_text(d.x - PAD_L, d.y - PAD_T, &geo);
    match d.phase {
        Phase::Down => {
            app.link_press = None;
            let m = d.mods;
            // A plain single click on a collapsed link: nothing moves until the release.
            if d.clicks <= 1
                && d.primary
                && !(m.shift || m.cmd || m.ctrl || m.alt)
                && let Some(g) = geo.link_at(app.ed.doc(), &app.ed.reveal(), d.x - PAD_L, d.y - PAD_T)
            {
                let url = app.ed.text()[g.url.0..g.url.1].to_string();
                app.link_press = Some(LinkPress { x: d.x, y: d.y, url, moved: false });
                app.handled(tx);
                return;
            }
            // On an image: the caret after its source, a double click selects the source.
            app.ed.mouse_down(&geo, x, y, d.clicks.max(1), m.shift);
        }
        Phase::Move if app.link_press.is_some() => {
            let p = app.link_press.as_mut().unwrap();
            if !p.moved {
                if (d.x - p.x).hypot(d.y - p.y) <= LINK_SLOP {
                    return;
                }
                // dragging from the link: select from where it was pressed
                p.moved = true;
                let (sx, sy) = to_text(p.x - PAD_L, p.y - PAD_T, &geo);
                app.ed.mouse_down(&geo, sx, sy, 1, false);
            }
            let geo = app.geometry();
            let (x, y) = to_text(d.x - PAD_L, d.y - PAD_T, &geo);
            app.ed.mouse_drag(&geo, x, y);
        }
        Phase::Up if app.link_press.is_some() => {
            let p = app.link_press.take().unwrap();
            if !p.moved {
                app.follow_link(&p.url, tx);
            }
            return;
        }
        // Revealing markers shifts the text under a still pointer, so only real movement extends
        // (pointer_up also sends a Move at the release point).
        Phase::Move if d.clicks <= 1 && (d.x != d.start_x || d.y != d.start_y) => {
            app.ed.mouse_drag(&geo, x, y);
        }
        _ => return,
    }
    app.handled(tx);
}

/// Clamp a document point into the text: above the first line hits the first line, below the
/// last line goes to the end of the document.
pub fn to_text(x: f32, y: f32, geo: &crate::layout::Geo) -> (f64, f64) {
    let height = geo.height;
    if height <= 0.0 {
        return (0.0, 0.0);
    }
    if y >= height {
        return (f64::from(col_w()) + 100.0, f64::from(height) - 0.5);
    }
    // the gutter holds the line's start; a table or code block breaking out reaches further left
    let min = if geo.wide_at(x, y).is_some() { x } else { -GUTTER };
    (f64::from(x.max(min)), f64::from(y.max(0.0)))
}

impl App {
    /// A point on the surface, inside a table's or code block's box: where it is in the block's content (its
    /// sideways scroll added). Elsewhere, as is.
    pub fn unscroll(&self, geo: &crate::layout::Geo, x: f32, y: f32) -> f32 {
        match geo.wide_at(x - PAD_L, y - PAD_T) {
            Some(w) => x - self.wide_scroll.borrow().get(&w.first).map_or(0.0, |o| o.get()[0]),
            None => x,
        }
    }
}

pub fn checkbox_drag(app: &mut App, d: &mut Drag, tx: &mut Tx, line: usize) {
    if d.phase == Phase::Down {
        app.close_search();
        app.ed.toggle_todo(line);
        app.handled(tx);
    }
}

/// A press on a collapsed link's pencil: the link expands for editing (`Editor::expand_link`), the
/// caret at the end of its text (inside the brackets).
pub fn pencil_drag(app: &mut App, d: &mut Drag, tx: &mut Tx, text_end: usize) {
    if d.phase == Phase::Down {
        pencil_press(app, tx, text_end);
    }
}

pub fn pencil_press(app: &mut App, tx: &mut Tx, text_end: usize) {
    app.close_search();
    app.link_press = None;
    app.pencil_hover = None;
    app.ed.expand_link(text_end);
    app.handled(tx);
}

/// A gesture on the element over a collapsed link's text (there for its pointing-hand cursor),
/// at (`ox`, `oy`) in the surface: handled as the surface's. `key` keeps the element (as a
/// stand-in over the surface) until the release, so a drag that reveals the link isn't cut off.
pub fn link_text_drag(app: &mut App, d: &mut Drag, tx: &mut Tx, key: &str, ox: f32, oy: f32) {
    if d.phase == Phase::Down {
        app.link_capture = Some(key.to_string());
    }
    // the link's place in its block's content: back to where it is on the surface (its block's scroll taken off)
    let geo = app.geometry();
    let off = app.unscroll(&geo, ox, oy) - ox;
    d.x += ox - off;
    d.y += oy;
    d.start_x += ox - off;
    d.start_y += oy;
    surface_drag(app, d, tx);
    if d.phase == Phase::Up {
        app.link_capture = None;
    }
}

/// A press on a heading's fold chevron (its gutter) or its "…" pill.
pub fn fold_drag(app: &mut App, d: &mut Drag, tx: &mut Tx, line: usize) {
    if d.phase == Phase::Down {
        app.close_search();
        app.ed.toggle_fold(line);
        app.handled(tx);
    }
}

impl App {
    /// A text field other than the search dialog's has the keys (a dialog's, a rename).
    pub fn other_field_focused(&self) -> bool {
        self.dialog.as_ref().is_some_and(|d| d.typing()) || self.renaming.as_ref().is_some_and(|(_, f)| f.focused)
    }
}
