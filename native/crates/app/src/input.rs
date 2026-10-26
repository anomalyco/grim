//! Keyboard and mouse glue between Rune and the editor.
//!
//! Everything that works around gaps in the current Rune lives here, so it can be replaced
//! when the patched Rune (grimoire-patches) lands:
//! - Drag coordinates ignore the scroll offset. Each visual line gets its own transparent strip
//!   with its own handler, so the line under the pointer is known exactly (hit testing uses the
//!   scrolled rects) and only the y inside it is approximate when scrolled. A drag moves by the
//!   exact pointer delta from where it went down. With the patch: one `on_drag` on the surface.
//! - No click count in `Drag`: counted with the wall clock (disabled headless, where scripts run
//!   faster than real time). With the patch: `Drag::clicks`.
//! - No modifiers in `Drag`: no shift-click. With the patch: `Drag::mods.shift`.
//! - No app-level IME: only plain typing (`Key::Text`) reaches the editor. With the patch:
//!   `AppSpec::on_ime` → `begin_composition`/`end_composition` and a marked-text overlay.
//! - PageUp/PageDown aren't delivered, and the scroll offset can't be set, so Home/End
//!   (ScrollToStart/End) and keeping the caret in view are not done yet.

use std::time::Instant;

use editor_core::{Key as EKey, Mods as EMods};
use rune::{Drag, Key, KeyEvent, Phase, Tx};

use crate::App;
use crate::theme::*;

#[derive(Default)]
pub struct InputState {
    last_down: Option<(Instant, f32, f32)>,
    clicks: u32,
    /// Document point where the current drag went down.
    drag: Option<(f32, f32)>,
    pub headless: bool,
}

impl InputState {
    pub fn new(headless: bool) -> InputState {
        InputState { headless, ..Default::default() }
    }

    fn count_click(&mut self, x: f32, y: f32) -> u32 {
        let now = Instant::now();
        let again = !self.headless
            && self.last_down.is_some_and(|(t, lx, ly)| {
                now.duration_since(t).as_millis() < 400 && (x - lx).abs() < 4.0 && (y - ly).abs() < 4.0
            });
        self.clicks = if again { (self.clicks + 1).min(3) } else { 1 };
        self.last_down = Some((now, x, y));
        self.clicks
    }
}

pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let m = ev.mods;
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
                return app.handled(tx);
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
                return app.handled(tx);
            }
            'v' => {
                if let Some(t) = arboard::Clipboard::new().ok().and_then(|mut cb| cb.get_text().ok()) {
                    app.ed.paste(&t.replace("\r\n", "\n"));
                }
                return app.handled(tx);
            }
            's' => {
                app.save_now();
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
        Key::Escape => EKey::Escape,
        Key::Tab => EKey::Tab,
        Key::Function(_) => return false,
    };
    let geo = app.geometry();
    if app.ed.key(key, mods, &geo).is_none() {
        return false;
    }
    app.handled(tx)
}

/// A press/drag on the strip covering document y `top..bottom` (see the module docs).
pub fn strip_drag(app: &mut App, d: &mut Drag, tx: &mut Tx, top: f32, bottom: f32) {
    let geo = app.geometry();
    let x = d.x - PAD_L;
    match d.phase {
        Phase::Down => {
            let y = (top + d.y).clamp(top, bottom - 0.01);
            let clicks = app.input.count_click(x, y);
            app.input.drag = Some((x, y));
            let (x, y) = to_text(x, y, geo.height);
            app.ed.mouse_down(&geo, x, y, clicks, false);
        }
        // Revealing markers shifts the text under a still pointer, so only real movement extends
        // (pointer_up also sends a Move at the release point).
        Phase::Move if d.x != d.start_x || d.y != d.start_y => {
            let Some((_, y0)) = app.input.drag else { return };
            if app.input.clicks > 1 {
                return;
            }
            let (x, y) = to_text(x, y0 + (d.y - d.start_y), geo.height);
            app.ed.mouse_drag(&geo, x, y);
        }
        Phase::Up => app.input.drag = None,
        _ => return,
    }
    app.handled(tx);
}

/// Clamp a document point into the text: above the first line hits the first line, below the
/// last line goes to the end of the document.
fn to_text(x: f32, y: f32, height: f32) -> (f64, f64) {
    if height <= 0.0 {
        return (0.0, 0.0);
    }
    if y >= height {
        return (f64::from(TEXT_W) + 100.0, f64::from(height) - 0.5);
    }
    (f64::from(x.max(-GUTTER)), f64::from(y.max(0.0)))
}

pub fn checkbox_drag(app: &mut App, d: &mut Drag, tx: &mut Tx, line: usize) {
    if d.phase == Phase::Down {
        app.ed.toggle_todo(line);
        app.handled(tx);
    }
}
