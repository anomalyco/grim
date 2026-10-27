//! The workspace switcher at the top left of the sidebar: the open workspace's name and where it lives, and
//! a caret. Its menu lists the recent workspaces (local folders and remote ones), the workspaces joined on
//! each connected server, "Open folder…" (the macOS folder picker; a path field in headless runs or when the
//! picker can't run) and "Add remote workspace…" (a URL field: `https://server/app/<workspace>[/<note>]`).
//!
//! Choosing one leaves the open workspace (the local note is saved, the remote room left) and opens it: one
//! workspace at a time.

use std::path::PathBuf;

use rune::{Align, Drag, El, Phase, Shape, TextEdit, TextStyle, Tx, col, el, row, text, text_input};

use crate::App;
use crate::theme::*;
use crate::workspaces::{self, WsRef};

/// The switcher row's height (below the traffic lights' strip).
pub const SWITCHER_H: f32 = 46.0;
pub const MENU_W: f32 = 300.0;
const MENU_ROW_H: f32 = 40.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    AddRemote,
    OpenPath,
}

#[derive(Default)]
pub struct Switcher {
    pub open: bool,
    /// The URL or path field shown in the menu.
    pub field: Option<Field>,
    pub input: TextEdit,
    pub error: Option<String>,
    /// A long action running ("Waiting for the browser…").
    pub busy: Option<String>,
    /// Servers whose workspace list couldn't be fetched.
    pub server_errors: Vec<(String, String)>,
}

impl Switcher {
    pub fn new() -> Switcher {
        let mut input = TextEdit::new("");
        input.single_line = true;
        Switcher { input, ..Switcher::default() }
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
        self.switcher.server_errors.clear();
        let servers: Vec<String> = self.store.servers.iter().map(|s| s.url.clone()).collect();
        for s in servers {
            self.refresh_joined(&s);
        }
    }

    pub fn close_switcher(&mut self) {
        self.switcher.open = false;
        self.switcher.field = None;
        self.switcher.input.focused = false;
        self.switcher.input.preedit = None;
        self.switcher.input.clear();
        self.switcher.error = None;
    }

    fn show_field(&mut self, f: Field) {
        self.switcher.field = Some(f);
        self.switcher.error = None;
        self.switcher.input.clear();
        self.switcher.input.focused = true;
    }

    /// "Open folder…": the system folder picker (on a thread: `osascript`'s `choose folder`, a real
    /// NSOpenPanel), or the path field when headless or the picker isn't there.
    pub fn open_folder_dialog(&mut self) {
        let crate::remote::Backend::Net(h) = &self.backend else {
            self.show_field(Field::OpenPath);
            return;
        };
        let h = h.clone();
        self.close_switcher();
        std::thread::spawn(move || {
            let out = std::process::Command::new("/usr/bin/osascript")
                .args(["-e", "POSIX path of (choose folder with prompt \"Open a folder of notes\")"])
                .output();
            match out {
                Ok(o) if o.status.success() => {
                    let p = String::from_utf8_lossy(&o.stdout).trim().trim_end_matches('/').to_string();
                    if !p.is_empty() {
                        h.update(move |app, tx| {
                            app.open_local(PathBuf::from(p), tx);
                            app.handled(tx);
                        });
                    }
                }
                // -128: cancelled
                Ok(o) if String::from_utf8_lossy(&o.stderr).contains("-128") => {}
                _ => h.update(|app, tx| {
                    app.switcher.open = true;
                    app.show_field(Field::OpenPath);
                    app.handled(tx);
                }),
            }
        });
    }

    /// Enter in the menu's field.
    pub fn submit_field(&mut self, tx: &mut Tx) {
        let text = self.switcher.input.text.trim().to_string();
        match self.switcher.field {
            Some(Field::AddRemote) => match workspaces::parse_remote_url(&text) {
                Ok(u) => {
                    self.close_switcher();
                    self.open_remote(u.server, u.id, String::new(), u.note, tx);
                }
                Err(e) => self.switcher.error = Some(e),
            },
            Some(Field::OpenPath) => {
                let p = expand_tilde(&text);
                if p.is_dir() {
                    self.close_switcher();
                    self.open_local(p, tx);
                } else {
                    self.switcher.error = Some(format!("No folder at {text}"));
                }
            }
            None => {}
        }
        self.handled(tx);
    }

    /// Open a workspace from the menu.
    pub fn choose(&mut self, w: WsRef, tx: &mut Tx) {
        self.close_switcher();
        if self.current.as_ref().is_some_and(|c| c.same(&w)) {
            self.handled(tx);
            return;
        }
        match w {
            WsRef::Local { path } => {
                if path.is_dir() {
                    self.open_local(path, tx);
                } else {
                    self.show_toast(format!("No folder at {}", workspaces::tilde(&path)));
                }
            }
            WsRef::Remote { server, id, title } => self.open_remote(server, id, title, None, tx),
        }
        self.handled(tx);
    }
}

fn expand_tilde(s: &str) -> PathBuf {
    match s.strip_prefix("~") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let home = std::env::var("HOME").unwrap_or_default();
            PathBuf::from(format!("{home}{rest}"))
        }
        _ => PathBuf::from(s),
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
        .label(format!("Workspace: {name}"))
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
    text(label).key(key).font(TextStyle::new(11.0, 600.0).lh(14.0).tracking(0.06)).color(c(MUTED)).pl(10.0).pt(8.0).pb(4.0)
}

fn ws_row(w: &WsRef, current: bool, key: String, extra: Option<String>) -> El {
    let remote = matches!(w, WsRef::Remote { .. });
    let target = w.clone();
    let loc = match extra {
        Some(e) => format!("{} · {e}", w.location()),
        None => w.location(),
    };
    let mut r = row()
        .key(key.clone())
        .label(w.name())
        .w(MENU_W - 12.0)
        .h(MENU_ROW_H)
        .px(8.0)
        .gap(10.0)
        .center_y()
        .radius(6.0)
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.choose(target.clone(), tx);
            }
        })
        .child(glyph(remote, format!("{key}-glyph")))
        .child(
            col()
                .key(format!("{key}-texts"))
                .w(MENU_W - 12.0 - 16.0 - 14.0 - 20.0 - 16.0)
                .child(text(w.name()).key(format!("{key}-name")).font(TextStyle::new(13.5, if current { 600.0 } else { 400.0 }).lh(17.0)).color(c(INK)).truncate())
                .child(text(loc).key(format!("{key}-loc")).font(TextStyle::new(11.5, 400.0).lh(15.0)).color(c(MUTED)).truncate()),
        );
    if current {
        r = r.child(el().key(format!("{key}-check")).size(12.0, 12.0).shape(Shape::new().stroke(vec![[1.5, 6.5], [4.5, 9.5], [10.5, 2.5]], 1.6, c(INK))));
    }
    if current { r.fill(c(TINT_ACTIVE)) } else { r.hover(c(TINT_HOVER)) }
}

fn action(label: &str, key: &str, f: fn(&mut App, &mut Tx)) -> El {
    row()
        .key(key.to_string())
        .label(label.to_string())
        .w(MENU_W - 12.0)
        .h(32.0)
        .px(10.0)
        .center_y()
        .radius(6.0)
        .hover(c(TINT_HOVER))
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                f(app, tx);
                app.handled(tx);
            }
        })
        .child(text(label.to_string()).key(format!("{key}-text")).font(TextStyle::new(13.5, 500.0).lh(18.0)).color(c(INK)))
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
    let cur = app.current.as_ref();
    if !app.store.recent.is_empty() {
        kids.push(section("RECENT".into(), "sw-sec-recent".into()));
        for (i, (w, _)) in app.store.recent.iter().take(8).enumerate() {
            kids.push(ws_row(w, cur.is_some_and(|c| c.same(w)), format!("sw-recent-{i}"), None));
        }
    }
    for (si, s) in app.store.servers.iter().enumerate() {
        let host = WsRef::Remote { server: s.url.clone(), id: String::new(), title: String::new() }.location();
        kids.push(section(format!("ON {}", host.to_uppercase()), format!("sw-sec-server-{si}")));
        if let Some((_, e)) = app.switcher.server_errors.iter().find(|(u, _)| *u == s.url) {
            kids.push(text(e.clone()).key(format!("sw-server-err-{si}")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).pl(10.0).pb(4.0));
        }
        if s.joined.is_empty() {
            kids.push(text("No workspaces joined yet").key(format!("sw-server-empty-{si}")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).pl(10.0).pb(4.0));
        }
        for (i, j) in s.joined.iter().enumerate() {
            let w = WsRef::Remote { server: s.url.clone(), id: j.id.clone(), title: j.title.clone() };
            let role = if j.read_only && j.role != "viewer" { format!("{} · read only", j.role) } else { j.role.clone() };
            kids.push(ws_row(&w, cur.is_some_and(|c| c.same(&w)), format!("sw-joined-{si}-{i}"), (!role.is_empty()).then_some(role)));
        }
    }
    kids.push(el().key("sw-div").w(MENU_W - 24.0).h(1.0).ml(6.0).mt(6.0).mb(6.0).fill(line()));
    kids.push(action("Open folder…", "sw-open-folder", |app, _| app.open_folder_dialog()));
    kids.push(action("Add remote workspace…", "sw-add-remote", |app, _| app.show_field(Field::AddRemote)));
    if let Some(f) = app.switcher.field {
        let placeholder = match f {
            Field::AddRemote => "https://server/app/workspace",
            Field::OpenPath => "~/path/to/folder",
        };
        kids.push(
            el().key("sw-field-box").w(MENU_W - 12.0).h(32.0).mt(4.0).child(
                text_input(&app.switcher.input, TextStyle::new(13.0, 400.0).lh(18.0))
                    .key("sw-field")
                    .w_full()
                    .h(32.0)
                    .px(10.0)
                    .py(7.0)
                    .fill(c(PAPER))
                    .radius(6.0)
                    .border(1.0, if app.switcher.input.focused { c(LINK) } else { line() })
                    .color(c(INK))
                    .placeholder(placeholder, c(MUTED))
                    .caret(c(INK), selection())
                    .on_edit(|app: &mut App| &mut app.switcher.input)
                    .on_submit(|app: &mut App, tx: &mut Tx| app.submit_field(tx)),
            ),
        );
        let hint = match f {
            Field::AddRemote => "Paste a workspace URL, then press Return.",
            Field::OpenPath => "Type a folder path, then press Return.",
        };
        kids.push(text(hint).key("sw-field-hint").font(TextStyle::new(11.5, 400.0).lh(15.0)).color(c(MUTED)).pl(4.0).pt(4.0));
    }
    if let Some(e) = &app.switcher.error {
        kids.push(text(e.clone()).key("sw-error").font(TextStyle::new(12.0, 500.0).lh(16.0)).color(c("#c4342d")).pl(4.0).pt(4.0).w(MENU_W - 16.0));
    }
    if let Some(b) = &app.switcher.busy {
        kids.push(text(b.clone()).key("sw-busy").font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).pl(4.0).pt(4.0).w(MENU_W - 16.0));
    }
    let menu = col()
        .key("sw-menu")
        .w(MENU_W)
        .padding(6.0)
        .fill(c(PAPER))
        .radius(10.0)
        .border(1.0, line())
        .shadow(8.0, 24.0, c("#000000").alpha(0.14))
        .absolute(8.0, SWITCHER_TOP + SWITCHER_H - 2.0)
        .children(kids);
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
