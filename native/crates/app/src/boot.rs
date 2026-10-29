//! What the window shows before the first complete view, and while another workspace loads: never the pieces of a
//! view arriving one by one (an empty tree, "Loading…", a blank note, then the text). At launch the window is the
//! page's colour, with a quiet GRIMOIRE mark after `MARK_AFTER`; switching workspaces keeps the old view (its last
//! frame, inert) until the new one is ready. Then the complete view shows in one frame. After `CAP` it shows
//! whatever is ready (with its quiet placeholders) rather than waiting longer; problem pages show at once.
//!
//! `view` only reads the gate; it opens in `settle_gate`, after every update (`Handle::update`, `App::handled`),
//! together with what was held back for the swap (the title, the scroll back to the top).

use std::time::{Duration, Instant};

use rune::{El, TextStyle, Transition, Tx, col, el, text};

use crate::App;
use crate::remote::Backend;
use crate::theme::{MUTED, PAPER, c};

pub const MARK_AFTER: Duration = Duration::from_millis(150);
pub const CAP: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Gate {
    /// The complete view.
    Open,
    /// Launching: the launch screen until the first view is ready.
    Launch(Instant),
    /// Switching workspaces: the last frame of the old one until the new one is ready.
    Switch(Instant),
}

/// What a frame shows (tests sample it after every update).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    Launch,
    Old,
    Complete,
}

/// What the swap does once the gate opens.
#[derive(Default)]
pub struct Held {
    pub title: Option<String>,
    pub scroll_top: bool,
}

impl App {
    /// Close the gate: `launch` at startup (no view yet), else a workspace switch (the old view stays). The redraws
    /// for the mark and the cap are timers.
    pub fn close_gate(&mut self, launch: bool) {
        let now = Instant::now();
        self.gate = if launch || self.last_view.borrow().is_none() { Gate::Launch(now) } else { Gate::Switch(now) };
        if let Backend::Net(h) = &self.backend {
            for after in [MARK_AFTER, CAP] {
                let h = h.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(after + Duration::from_millis(5));
                    // the update itself settles the gate and redraws
                    h.update(|_, tx| tx.instant());
                });
            }
        }
    }

    /// Everything the first view needs is there: the workspace and its tree, and the open note's text (live, or
    /// its cached text), or a page saying why not.
    pub fn view_ready(&self) -> bool {
        let Some(rem) = &self.remote else { return true };
        if rem.problem.is_some() {
            return true;
        }
        if !rem.loaded {
            return false;
        }
        match &rem.note {
            None => self.pending_note.is_none(),
            Some(_) => rem.synced || rem.preview || rem.notice.is_some(),
        }
    }

    /// After an update: open the gate when the new view is ready (or past the cap), with the held title and scroll.
    pub fn settle_gate(&mut self, tx: &mut Tx) {
        let since = match self.gate {
            Gate::Open => return,
            Gate::Launch(t) | Gate::Switch(t) => t,
        };
        if !self.view_ready() && since.elapsed() < CAP {
            return;
        }
        self.gate = Gate::Open;
        let held = std::mem::take(&mut self.held);
        if let Some(t) = held.title {
            tx.set_title(t);
        }
        if held.scroll_top {
            tx.scroll_to_y("scroll", 0.0);
        }
        tx.instant();
    }

    /// The window title, now or when the gate opens.
    pub fn set_title_gated(&mut self, title: String, tx: &mut Tx) {
        if self.gate == Gate::Open {
            tx.set_title(title);
        } else {
            self.held.title = Some(title);
        }
    }

    /// Back to the top of the page, now or when the gate opens (not the old view's scroll meanwhile).
    pub fn scroll_top_gated(&mut self, tx: &mut Tx) {
        if self.gate == Gate::Open {
            tx.scroll_to_y("scroll", 0.0);
        } else {
            self.held.scroll_top = true;
        }
    }

    pub fn phase(&self) -> Phase {
        match self.gate {
            Gate::Open => Phase::Complete,
            Gate::Launch(_) => Phase::Launch,
            Gate::Switch(_) => Phase::Old,
        }
    }
}

/// The frame while the gate is closed, or None for the complete view.
pub fn gated(app: &App) -> Option<El> {
    match app.gate {
        Gate::Open => None,
        Gate::Launch(t) => Some(launch_screen(t.elapsed() >= MARK_AFTER)),
        Gate::Switch(t) => Some(match app.last_view.borrow().clone() {
            // the old view, inert: a cover takes the pointer
            Some(old) => old.child(el().key("switch-cover").absolute(0.0, 0.0).w_full().h_full().on_press(|_: &mut App| {})),
            None => launch_screen(t.elapsed() >= MARK_AFTER),
        }),
    }
}

/// The page's colour, and (after a moment) a small quiet mark in the middle. No spinner.
pub fn launch_screen(mark: bool) -> El {
    let mut e = col().key("root").w_full().h_full().fill(c(PAPER)).center();
    if mark {
        e = e.child(text("GRIMOIRE").key("launch-mark").font(TextStyle::new(11.0, 600.0).lh(14.0).tracking(2.2)).color(c(MUTED).alpha(0.7)).transition(Transition::opacity()));
    }
    e
}
