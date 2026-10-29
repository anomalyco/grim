//! Toasts, as the web's `toast()` (`.toasts`, `.toast`): short messages stacked at the bottom centre, newest
//! last; an error has a yellow dot; one with a button ("Create it") stays longer. Info 3.5 s, error 6 s, with a
//! button 8 s, then they fade out and go.

use std::time::Duration;

use rune::{Cursor, Drag, El, Live, Phase, TextStyle, Tx, col, el, row, text};

use crate::App;
use crate::links::ToastAction;
use crate::theme::*;

/// At most this many at once (the oldest go first).
const MAX: usize = 4;
/// `.toast`'s widest.
const MAX_W: f32 = 480.0;

pub struct Toast {
    pub id: u64,
    pub msg: String,
    pub error: bool,
    pub action: Option<ToastAction>,
    pub alpha: Live<f32>,
}

impl App {
    /// An info toast.
    pub fn show_toast(&mut self, msg: String) {
        self.push_toast(msg, false, None);
    }

    /// An error toast (the yellow dot; 6 s).
    pub fn show_error(&mut self, msg: String) {
        self.push_toast(msg, true, None);
    }

    /// A toast with a button (8 s).
    pub fn toast_with(&mut self, msg: String, action: Option<ToastAction>) {
        self.push_toast(msg, false, action);
    }

    fn push_toast(&mut self, msg: String, error: bool, action: Option<ToastAction>) {
        self.toast_next += 1;
        let id = self.toast_next;
        let shown = Duration::from_millis(if action.is_some() {
            8000
        } else if error {
            6000
        } else {
            3500
        });
        let alpha = Live::new(1.0);
        self.toasts.push(Toast { id, msg, error, action, alpha: alpha.clone() });
        if self.toasts.len() > MAX {
            self.toasts.remove(0);
        }
        // headless runs (and tests) keep them
        if let crate::remote::Backend::Net(h) = &self.backend
            && !self.headless
        {
            let h = h.clone();
            std::thread::spawn(move || {
                std::thread::sleep(shown);
                alpha.set(0.0);
                std::thread::sleep(Duration::from_millis(300));
                h.update(move |app, _| app.toasts.retain(|t| t.id != id));
            });
        }
    }

    /// The newest toast's message.
    pub fn toast(&self) -> Option<&str> {
        self.toasts.last().map(|t| t.msg.as_str())
    }

    /// The newest toast's button.
    pub fn toast_action(&self) -> Option<&ToastAction> {
        self.toasts.last().and_then(|t| t.action.as_ref())
    }

    /// The newest toast with a button: pressed.
    pub fn run_toast_action(&mut self, tx: &mut Tx) {
        if let Some(id) = self.toasts.iter().rev().find(|t| t.action.is_some()).map(|t| t.id) {
            self.run_toast(id, tx);
        }
    }

    /// Toast `id`'s button was pressed: it goes, and its action runs.
    pub fn run_toast(&mut self, id: u64, tx: &mut Tx) {
        let Some(i) = self.toasts.iter().position(|t| t.id == id) else { return };
        let Some(action) = self.toasts.remove(i).action else { return };
        self.run_action(action, tx);
        self.handled(tx);
    }
}

/// The stack, bottom centre of the page (24 pt up), 8 pt apart.
pub fn view(app: &App, x0: f32, w: f32, vh: f32) -> Option<El> {
    if app.toasts.is_empty() {
        return None;
    }
    let pills: Vec<El> = app.toasts.iter().map(|t| pill(t, w)).collect();
    Some(col().key("toasts").absolute(x0, 0.0).w(w).h((vh - 24.0).max(0.0)).gap(8.0).justify_end().children(pills))
}

/// The toast's text: on one line when it fits in `room`, else wrapped to it.
fn message(s: &str, id: u64, style: TextStyle, room: f32) -> El {
    let (tw, _) = crate::layout::measure(s, style);
    let msg = text(s.to_string()).key(format!("toast-text{id}")).font(style).color(c(PAPER));
    if tw > room { msg.w(room).wrap() } else { msg }
}

/// `.toast`: ink, paper text 13 pt, 10/14 padding, 10 pt corners; `.toast-error` its yellow dot; `.toast-action` a
/// translucent button.
fn pill(t: &Toast, w: f32) -> El {
    let id = t.id;
    let style = TextStyle::new(13.0, 400.0).lh(18.2);
    let room = MAX_W.min(w - 32.0) - 28.0 - if t.error { 16.0 } else { 0.0 } - if t.action.is_some() { 90.0 } else { 0.0 };
    let msg = message(&t.msg, id, style, room);
    let mut p = row().key(format!("toast{id}")).label(t.msg.clone()).px(14.0).py(10.0).gap(9.0).center_y().radius(10.0).fill(c(INK)).live_opacity(&t.alpha);
    if t.error {
        p = p.child(el().key(format!("toast-dot{id}")).size(7.0, 7.0).radius(3.5).fill(c("#f5c542")));
    }
    p = p.child(msg);
    if let Some(a) = &t.action {
        let alpha = t.alpha.clone();
        p = p.child(
            row()
                .key(format!("toast-action{id}"))
                .label(a.label())
                .px(9.0)
                .py(4.0)
                .ml(4.0)
                .radius(6.0)
                .fill(c(PAPER).alpha(0.14))
                .hover(c(PAPER).alpha(0.24))
                .cursor(Cursor::Pointer)
                .child(text(a.label()).key(format!("toast-action-text{id}")).font(TextStyle::new(13.0, crate::theme::wt(600.0)).lh(18.2)).color(c(PAPER)))
                .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
                    // not once it has faded out
                    if d.phase == Phase::Down && alpha.get() > 0.5 {
                        app.run_toast(id, tx);
                    }
                }),
        );
    }
    row().key(format!("toast-row{id}")).w(w).center().child(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stack, newest last, at most four; errors and buttons as the web's; a button runs its action and its
    /// toast goes.
    #[test]
    fn toasts_stack() {
        let mut app = App::new("", None, true);
        let mut tx = Tx::default();
        for i in 0..3 {
            app.show_toast(format!("info {i}"));
        }
        app.show_error("Couldn't rename a: taken".into());
        app.toast_with("No note at “x.md”".into(), Some(ToastAction::Create("x.md".into())));
        let got: Vec<(&str, bool, bool)> = app.toasts.iter().map(|t| (t.msg.as_str(), t.error, t.action.is_some())).collect();
        assert_eq!(got, [("info 1", false, false), ("info 2", false, false), ("Couldn't rename a: taken", true, false), ("No note at “x.md”", false, true)]);
        assert_eq!(app.toast(), Some("No note at “x.md”"));
        let id = app.toasts.last().unwrap().id;
        app.run_toast(id, &mut tx);
        assert_eq!(app.toast(), Some("Couldn't rename a: taken"), "the pressed one went");
    }

    /// A long message wraps at the toast's width (480 pt at most); a short one stays on one line.
    #[test]
    fn long_toasts_wrap() {
        let _ = crate::layout::FONTS.set(crate::layout::Fonts { list: &[], sans: "Inter", mono: "Inter" });
        let style = TextStyle::new(13.0, 400.0).lh(18.2);
        assert!(!message("Saved", 1, style, 400.0).wraps());
        assert!(message(&"a very long message ".repeat(10), 1, style, 400.0).wraps());
    }
}
