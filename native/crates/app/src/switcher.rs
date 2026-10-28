//! The workspace switcher at the top left of the sidebar: the open workspace's name and where it lives, and
//! a caret. Its menu (`menu::items`: the web app's switcher when the open workspace is remote, plus "Open
//! folder…" and the folders on this Mac) is drawn like the web app's `.ws-menu`: section headings, rows
//! with a dot before the open workspace and a badge or host at the right, actions, separators.
//!
//! Choosing a workspace leaves the open one (the local note is saved, the remote room left) and opens it:
//! one workspace at a time.

use rune::{Align, Drag, El, Phase, ScrollSpec, Shape, TextEdit, TextStyle, Tx, col, el, row, text};

use crate::App;
use crate::menu::{self, Item};
use crate::theme::*;
use crate::workspaces::{self, WsRef};

/// The switcher row's height (below the traffic lights' strip).
pub const SWITCHER_H: f32 = 46.0;
pub const MENU_W: f32 = 300.0;
const MENU_ROW_H: f32 = 30.0;

#[derive(Default)]
pub struct Switcher {
    pub open: bool,
    /// A field no one shows (what text inputs edit when their dialog is gone).
    pub input: TextEdit,
    pub error: Option<String>,
    /// A long action running ("Waiting for the browser…").
    pub busy: Option<String>,
    /// Servers whose account or workspace list couldn't be fetched.
    pub server_issues: Vec<(String, ServerIssue)>,
    /// Bumped by every connect flow started (and by Disconnect): only the newest flow's answer counts.
    pub connect_gen: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ServerIssue {
    /// No token, or the server refused it: "Reconnect".
    SignedOut,
    /// It couldn't be reached, or answered oddly.
    Error(String),
}

impl Switcher {
    pub fn new() -> Switcher {
        Switcher { input: TextEdit::new(""), ..Switcher::default() }
    }
}

impl App {
    pub fn toggle_switcher(&mut self) {
        if self.switcher.open {
            self.close_switcher();
            return;
        }
        self.blur_filter();
        self.marked = None;
        self.switcher.open = true;
        self.switcher.error = None;
        self.switcher.server_issues.retain(|(_, i)| *i == ServerIssue::SignedOut);
        let servers: Vec<String> = self.store.servers.iter().map(|s| s.url.clone()).collect();
        for s in servers {
            self.refresh_joined(&s);
        }
    }

    pub fn close_switcher(&mut self) {
        self.switcher.open = false;
        self.switcher.error = None;
    }

    /// Open a workspace from the menu.
    pub fn choose(&mut self, w: WsRef, tx: &mut Tx) {
        self.close_switcher();
        // the open one, unless it's showing a problem (choosing it again tries again)
        if self.current.as_ref().is_some_and(|c| c.same(&w)) && self.remote.as_ref().is_none_or(|r| r.problem.is_none()) {
            self.handled(tx);
            return;
        }
        match w {
            WsRef::Local { path } => {
                if path.is_dir() {
                    self.open_local(path, tx);
                } else {
                    // gone (moved, deleted, an unplugged disk): off the list
                    self.store.forget(&WsRef::Local { path: path.clone() });
                    self.show_toast(format!("No folder at {} (removed from the list)", workspaces::tilde(&path)));
                }
            }
            WsRef::Remote { server, id, title } => self.open_remote(server, id, title, None, tx),
        }
        self.handled(tx);
    }
}

/// A caret pointing down (open: up).
fn caret(open: bool, key: &str) -> El {
    let pts = if open { vec![[1.5, 6.0], [5.0, 2.5], [8.5, 6.0]] } else { vec![[1.5, 3.0], [5.0, 6.5], [8.5, 3.0]] };
    el().key(key.to_string()).size(10.0, 10.0).shape(Shape::new().stroke(pts, 1.5, c(MUTED)))
}

/// A small glyph for the kind of workspace: a folder, or a cloud-ish globe for remote ones.
fn glyph(remote: bool, key: String) -> El {
    let shape = if remote {
        // a circle with a meridian and the equator
        let mut ring = Vec::new();
        for i in 0..=24 {
            let a = i as f32 / 24.0 * std::f32::consts::TAU;
            ring.push([7.0 + 5.5 * a.cos(), 7.0 + 5.5 * a.sin()]);
        }
        let mut mer = Vec::new();
        for i in 0..=16 {
            let a = i as f32 / 16.0 * std::f32::consts::TAU;
            mer.push([7.0 + 2.3 * a.cos(), 7.0 + 5.5 * a.sin()]);
        }
        Shape::new().stroke(ring, 1.2, c(MUTED)).stroke(mer, 1.0, c(MUTED)).stroke(vec![[1.5, 7.0], [12.5, 7.0]], 1.0, c(MUTED))
    } else {
        Shape::new().stroke(vec![[1.5, 3.0], [5.5, 3.0], [7.0, 4.5], [12.5, 4.5], [12.5, 11.5], [1.5, 11.5], [1.5, 3.0]], 1.2, c(MUTED))
    };
    el().key(key).size(14.0, 14.0).shape(shape)
}

/// The switcher row (top of the sidebar).
pub fn button(app: &App) -> El {
    let (name, location, remote) = match &app.current {
        Some(w) => (w.name(), w.location(), matches!(w, WsRef::Remote { .. })),
        None => ("Grimoire".to_string(), "Sample note".to_string(), false),
    };
    let w = SIDEBAR_W - 16.0;
    let mut b = row()
        .key("switcher")
        .label(format!("Folder: {name}"))
        .w(w)
        .h(SWITCHER_H - 6.0)
        .ml(8.0)
        .px(8.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
        .on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.toggle_switcher();
                app.handled(tx);
            }
        })
        .child(glyph(remote, "sw-glyph".into()))
        .child(
            col()
                .key("sw-texts")
                .w(w - 16.0 - 14.0 - 10.0 - 16.0)
                .child(text(name).key("sw-name").font(TextStyle::new(13.5, 600.0).lh(17.0)).color(c(INK)).truncate())
                .child(text(location).key("sw-loc").font(TextStyle::new(11.5, 400.0).lh(15.0)).color(c(MUTED)).truncate()),
        )
        .child(caret(app.switcher.open, "sw-caret"));
    b = if app.switcher.open { b.fill(c(TINT_ACTIVE)) } else { b.hover(c(TINT_HOVER)) };
    b
}

fn section(label: String, key: String) -> El {
    text(label).key(key).font(TextStyle::new(11.5, 550.0).lh(14.0)).color(c(MUTED)).w(MENU_W - 12.0).truncate().px(10.0).pt(8.0).pb(4.0)
}

/// "This Mac": the local folders opened before (remembered, each once), by name. Remote workspaces come
/// from the servers' joined lists, never from what was opened.
pub fn local_folders(store: &workspaces::Store) -> Vec<WsRef> {
    let mut out: Vec<WsRef> = Vec::new();
    for (w, _) in &store.recent {
        if matches!(w, WsRef::Local { .. }) && !out.iter().any(|l| l.same(w)) {
            out.push(w.clone());
        }
    }
    out.sort_by_key(|w| (w.name().to_lowercase(), w.location()));
    out
}

/// A workspace row (the web app's `.menu-item.has-detail`): a dot before the open one (the others keep its
/// space), the name, the badge or where it lives at the right, and for local folders an × "Remove from list".
fn ws_row(w: &WsRef, detail: &str, current: bool, removable: bool, key: String) -> El {
    let target = w.clone();
    let mut r = row()
        .key(key.clone())
        .label(w.name())
        .w(MENU_W - 12.0)
        .h(MENU_ROW_H)
        .px(10.0)
        .center_y()
        .radius(4.0)
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.choose(target.clone(), tx);
            }
        })
        .child(el().key(format!("{key}-dot")).size(6.0, 6.0).radius(3.0).mr(10.0).fill(if current { c(INK) } else { c(PAPER).alpha(0.0) }))
        .child(text(w.name()).key(format!("{key}-name")).font(TextStyle::new(13.5, 400.0).lh(18.0)).color(c(INK)).grow(1.0).truncate());
    if !detail.is_empty() {
        r = r.child(text(detail.to_string()).key(format!("{key}-detail")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).ml(12.0).max_w(150.0).truncate());
    }
    if removable {
        let target = w.clone();
        r = r.child(
            el().key(format!("{key}-remove"))
                .label("Remove from list")
                .size(18.0, 18.0)
                .ml(6.0)
                .radius(4.0)
                .hover(c(TINT_ACTIVE))
                .shape(Shape::new().stroke(vec![[5.0, 5.0], [13.0, 13.0]], 1.3, c(MUTED)).stroke(vec![[13.0, 5.0], [5.0, 13.0]], 1.3, c(MUTED)))
                .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
                    if d.phase == Phase::Down {
                        app.remove_recent(&target, tx);
                        app.handled(tx);
                    }
                }),
        );
    }
    r.hover(c(PAPER_2))
}

/// An action row (the web app's `.menu-item`), muted and inert when disabled.
fn action(label: &str, act: menu::Act, disabled: bool) -> El {
    let key = act.key();
    let mut r = row()
        .key(key.clone())
        .label(label.to_string())
        .w(MENU_W - 12.0)
        .h(MENU_ROW_H)
        .px(10.0)
        .center_y()
        .radius(4.0)
        .child(text(label.to_string()).key(format!("{key}-text")).font(TextStyle::new(13.5, 400.0).lh(18.0)).color(c(if disabled { MUTED } else { INK })));
    if !disabled {
        r = r.hover(c(PAPER_2)).on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.run_act(act.clone(), tx);
                app.handled(tx);
            }
        });
    }
    r
}

/// The open menu, and a backdrop over the window that closes it.
pub fn menu(app: &App, vw: f32, vh: f32) -> Vec<El> {
    let backdrop = el().key("sw-backdrop").absolute(0.0, 0.0).size(vw, vh).on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
        if d.phase == Phase::Down {
            app.close_switcher();
            app.handled(tx);
        }
    });
    let mut kids: Vec<El> = Vec::new();
    let (mut n_local, mut n_ws, mut n_sec, mut n_sep, mut n_note) = (0, 0, 0, 0, 0);
    for it in menu::items(app) {
        match it {
            Item::Section(s) => {
                kids.push(section(s, format!("sw-sec-{n_sec}")));
                n_sec += 1;
            }
            Item::Ws { ws, detail, checked, removable } => {
                let key = if matches!(ws, WsRef::Local { .. }) {
                    n_local += 1;
                    format!("sw-local-{}", n_local - 1)
                } else {
                    n_ws += 1;
                    format!("sw-ws-{}", n_ws - 1)
                };
                kids.push(ws_row(&ws, &detail, checked, removable, key));
            }
            Item::Act { act, label, disabled } => kids.push(action(&label, act, disabled)),
            Item::Note(s) => {
                kids.push(text(s).key(format!("sw-note-{n_note}")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).px(10.0).py(4.0).w(MENU_W - 12.0).wrap());
                n_note += 1;
            }
            Item::Sep => {
                kids.push(el().key(format!("sw-sep-{n_sep}")).w(MENU_W - 24.0).h(1.0).ml(6.0).mt(4.0).mb(4.0).fill(c("#18181b").alpha(0.07)));
                n_sep += 1;
            }
        }
    }
    if let Some(e) = &app.switcher.error {
        kids.push(text(e.clone()).key("sw-error").font(TextStyle::new(12.0, 500.0).lh(16.0)).color(c("#c4342d")).px(10.0).pt(4.0).w(MENU_W - 16.0).wrap());
    }
    if let Some(b) = &app.switcher.busy {
        kids.push(text(b.clone()).key("sw-busy").font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).px(10.0).pt(4.0).w(MENU_W - 16.0).wrap());
    }
    let top = SWITCHER_TOP + SWITCHER_H - 2.0;
    let menu = col()
        .key("sw-menu")
        .w(MENU_W)
        .max_h((vh - top - 12.0).max(120.0))
        .fill(c(PAPER))
        .radius(8.0)
        .border(1.0, line())
        .shadow(8.0, 24.0, c("#000000").alpha(0.14))
        .clip_soft(0.0)
        .absolute(8.0, top)
        .child(col().key("sw-menu-scroll").w(MENU_W - 2.0).scroll(ScrollSpec { stick_bottom: false }).child(col().key("sw-menu-items").w(MENU_W - 2.0).padding(5.0).children(kids)));
    vec![backdrop, menu]
}

/// Where the switcher row starts (under the traffic lights).
pub const SWITCHER_TOP: f32 = 34.0;

/// The status pill of a remote note (top right of the page).
pub fn status_pill(msg: &str) -> El {
    row()
        .key("remote-status")
        .h(24.0)
        .px(10.0)
        .center_y()
        .radius(12.0)
        .fill(c(BG2))
        .child(text(msg.to_string()).key("remote-status-text").font(TextStyle::new(12.0, 500.0).lh(16.0)).color(c(MUTED)).align(Align::Center))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_menu_lists_local_folders_by_name_and_no_recent_remotes() {
        let mut s = workspaces::Store::default();
        let l = |p: &str| WsRef::Local { path: PathBuf::from(p) };
        for w in [l("/a/zeta"), l("/b/Alpha"), l("/a/zeta"), l("/c/mid")] {
            s.touch(&w, None);
        }
        s.touch(&WsRef::Remote { server: "https://s".into(), id: "x".into(), title: "X".into() }, None);
        let names: Vec<String> = local_folders(&s).iter().map(|w| w.name()).collect();
        assert_eq!(names, vec!["Alpha", "mid", "zeta"]);
        // many remote workspaces opened never push the local folders out of the list
        for i in 0..30 {
            s.touch(&WsRef::Remote { server: "https://s".into(), id: format!("w{i}"), title: String::new() }, None);
        }
        assert_eq!(local_folders(&s).len(), 3);
    }
}
