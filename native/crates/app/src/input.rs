//! Keyboard, IME and mouse glue between Rune and the editor.
//!
//! - Keys: `on_key` → `insert_text`, or `Editor::key` through editor-core's keymap, plus the
//!   clipboard, Cmd-S and PageUp/PageDown (which editor-core leaves to the UI). Home/End
//!   (`ScrollToStart/End`) scroll without moving the caret; every other key keeps the caret in
//!   view (`Tx::scroll_into_view`). App shortcuts come first (Cmd-N, Cmd-\ / Cmd-Shift-L, Cmd-P / Cmd-K);
//!   while the sidebar's filter field has focus every other key is left to it.
//! - IME: `on_ime` keeps the marked text in `App` (the view splices it in at the caret) and
//!   commits through `begin_composition` / `end_composition`.
//! - Mouse: one `on_drag` on the surface. Rune measures `Drag` from the scrolled rect and counts
//!   clicks; Shift extends. A drag after a double or triple click doesn't extend by words or
//!   lines (editor-core has no such mode), it keeps the first selection.

use editor_core::{Command, Key as EKey, Mods as EMods, Sel};
use rune::{Drag, Ime, Key, KeyEvent, Phase, Tx};

use crate::App;
use crate::layout::{col_w, view_h};
use crate::theme::*;

pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let m = ev.mods;
    // App shortcuts work wherever the focus is.
    if let Key::Command(ch) = &ev.key {
        match ch {
            'n' if !m.shift => {
                app.new_note(tx);
                return app.handled(tx);
            }
            '\\' => {
                app.toggle_sidebar();
                return app.handled(tx);
            }
            'l' if m.shift => {
                app.toggle_sidebar();
                return app.handled(tx);
            }
            'p' | 'k' if app.root.is_some() => {
                app.focus_filter();
                return app.handled(tx);
            }
            _ => {}
        }
    }
    // The filter field has the keys (Esc clears it, then leaves it).
    if app.filter.focused {
        // Focused by a click: the editor's composition, if any, doesn't follow the keys.
        app.marked = None;
        if matches!(ev.key, Key::Escape) {
            app.filter_escape();
            tx.instant();
            return true;
        }
        return false;
    }
    if app.root.is_some() && app.path.is_none() {
        return false;
    }
    let mods = EMods { shift: m.shift, ctrl: m.ctrl, alt: m.alt, cmd: m.cmd };
    let key = match &ev.key {
        Key::Text(s) => {
            let mut chars = s.chars();
            let first = chars.next();
            let single = first.filter(|_| chars.next().is_none());
            if m.ctrl || m.cmd {
                // Ctrl-H/D/K arrive either as the letter or as its control character.
                match single {
                    Some(ch) if (ch as u32) < 0x20 => EKey::Char(char::from(ch as u8 + 0x60)),
                    Some(ch) => EKey::Char(ch.to_ascii_lowercase()),
                    None => return false,
                }
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
                if let Some(t) = arboard::Clipboard::new().ok().and_then(|mut cb| cb.get_text().ok()) {
                    app.ed.paste(&t.replace("\r\n", "\n"));
                }
                return keyed(app, tx);
            }
            's' => {
                app.save_now();
                return app.handled(tx);
            }
            ch => EKey::Char(*ch),
        },
        Key::PageUp | Key::PageDown if !(m.cmd || m.ctrl || m.alt) => {
            page(app, if matches!(ev.key, Key::PageUp) { -1.0 } else { 1.0 }, m.shift);
            return keyed(app, tx);
        }
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
        Key::Function(_) => return false,
    };
    let geo = app.geometry();
    match app.ed.key(key, mods, &geo) {
        None => false,
        Some(Command::ScrollToStart) => {
            tx.scroll_to("scroll", 0.0);
            app.handled(tx)
        }
        Some(Command::ScrollToEnd) => {
            tx.scroll_to("scroll", f32::INFINITY);
            app.handled(tx)
        }
        Some(_) => keyed(app, tx),
    }
}

/// After a keyboard edit or move: the usual bookkeeping, and the caret scrolls into view.
fn keyed(app: &mut App, tx: &mut Tx) -> bool {
    tx.scroll_into_view("caret", CARET_MARGIN);
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
    if app.filter.focused {
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

/// A press or drag on the surface. `Drag` is in surface points, scroll included.
pub fn surface_drag(app: &mut App, d: &mut Drag, tx: &mut Tx) {
    // Pressing the page takes the keys back from the filter field.
    app.blur_filter();
    let geo = app.geometry();
    let (x, y) = to_text(d.x - PAD_L, d.y - PAD_T, geo.height);
    match d.phase {
        Phase::Down => {
            // On an image: the caret after its source, a double click selects the source.
            app.ed.mouse_down(&geo, x, y, d.clicks.max(1), d.mods.shift);
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
pub fn to_text(x: f32, y: f32, height: f32) -> (f64, f64) {
    if height <= 0.0 {
        return (0.0, 0.0);
    }
    if y >= height {
        return (f64::from(col_w()) + 100.0, f64::from(height) - 0.5);
    }
    (f64::from(x.max(-GUTTER)), f64::from(y.max(0.0)))
}

pub fn checkbox_drag(app: &mut App, d: &mut Drag, tx: &mut Tx, line: usize) {
    if d.phase == Phase::Down {
        app.blur_filter();
        app.ed.toggle_todo(line);
        app.handled(tx);
    }
}

/// A press on a heading's fold chevron (its gutter) or its "…" pill.
pub fn fold_drag(app: &mut App, d: &mut Drag, tx: &mut Tx, line: usize) {
    if d.phase == Phase::Down {
        app.blur_filter();
        app.ed.toggle_fold(line);
        app.handled(tx);
    }
}
