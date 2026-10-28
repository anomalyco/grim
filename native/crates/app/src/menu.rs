//! What the workspace switcher's menu lists, in order (drawn by `switcher::menu`): the web app's switcher
//! (`openSwitcher` in multiplayer-notepad `src/client/main.ts`) item for item when the open workspace is
//! remote, plus "Open folder…" and the folders on this Mac; for a local folder only what needs no server.
//!
//! Remote: "On <host>" (the workspaces joined there with how they were joined: Owner / Editor / Viewer /
//! via link / … · domain; a dot on the open one), "Other servers" (the workspaces joined on the other
//! servers the app is connected to, with their host), "This Mac", then Open folder…, Add remote
//! workspace…, New workspace…, Add GitHub repo…; the open workspace's Share workspace… (owners), Share
//! with agent…, Open on GitHub, Refresh, Leave workspace (not owners), Remove workspace… (owners); and the
//! account: "Signed in as <name> · <email>", Change name…, Settings, Switch account, Sign out.
//!
//! Local: "This Mac", then "On <host>" for each server the app is connected to, Open folder…, Add remote
//! workspace…: no sharing, members, agent links or account (those need a server).

use crate::App;
use crate::switcher::ServerIssue;
use crate::workspaces::{self, WsRef};

/// What a menu item does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    OpenFolder,
    AddRemote,
    NewWorkspace,
    AddGitHub,
    ShareWorkspace,
    ShareAgent,
    OpenGitHub,
    Refresh,
    Leave,
    Remove,
    ChangeName,
    Settings,
    SwitchAccount,
    SignOut,
    /// A signed-out server: connect again, or forget it here.
    Reconnect(String),
    Forget(String),
}

impl Act {
    /// The element key of its row.
    pub fn key(&self) -> String {
        match self {
            Act::OpenFolder => "sw-open-folder".into(),
            Act::AddRemote => "sw-add-remote".into(),
            Act::NewWorkspace => "sw-new-workspace".into(),
            Act::AddGitHub => "sw-add-github".into(),
            Act::ShareWorkspace => "sw-share-workspace".into(),
            Act::ShareAgent => "sw-share-agent".into(),
            Act::OpenGitHub => "sw-open-github".into(),
            Act::Refresh => "sw-refresh".into(),
            Act::Leave => "sw-leave".into(),
            Act::Remove => "sw-remove".into(),
            Act::ChangeName => "sw-change-name".into(),
            Act::Settings => "sw-settings".into(),
            Act::SwitchAccount => "sw-switch-account".into(),
            Act::SignOut => "sw-sign-out".into(),
            Act::Reconnect(s) => format!("sw-reconnect-{}", host(s)),
            Act::Forget(s) => format!("sw-forget-{}", host(s)),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    /// A section heading ("On grimoire.exe.xyz", "Signed in as …").
    Section(String),
    /// A workspace to switch to: its name, a detail at the right (the badge, or the host / path), a dot
    /// when it's the open one, and an × "Remove from list" (local folders but the open one).
    Ws { ws: WsRef, detail: String, checked: bool, removable: bool },
    Act { act: Act, label: String, disabled: bool },
    /// A muted line (why a server's list couldn't be fetched).
    Note(String),
    Sep,
}

impl Item {
    fn act(act: Act, label: &str) -> Item {
        Item::Act { act, label: label.into(), disabled: false }
    }

    /// The text shown (tests, the parity list).
    #[cfg(test)]
    pub fn label(&self) -> String {
        match self {
            Item::Section(s) | Item::Note(s) => s.clone(),
            Item::Ws { ws, detail, checked, .. } => {
                let d = if detail.is_empty() { String::new() } else { format!(" [{detail}]") };
                format!("{}{}{d}", if *checked { "• " } else { "" }, ws.name())
            }
            Item::Act { label, disabled, .. } => if *disabled { format!("({label})") } else { label.clone() },
            Item::Sep => "—".into(),
        }
    }
}

fn host(server: &str) -> String {
    WsRef::Remote { server: server.to_string(), id: String::new(), title: String::new() }.location()
}

/// The menu's items, in order (separators only between groups, never first, last or doubled).
pub fn items(app: &App) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    let cur = app.current.as_ref();
    let here = match cur {
        Some(WsRef::Remote { server, .. }) => Some(server.clone()),
        _ => None,
    };
    let locals: Vec<Item> = crate::switcher::local_folders(&app.store)
        .into_iter()
        .map(|w| {
            let checked = cur.is_some_and(|c| c.same(&w));
            Item::Ws { detail: w.location(), checked, removable: !checked, ws: w }
        })
        .collect();
    let servers: Vec<String> = app.store.servers.iter().map(|s| s.url.clone()).collect();
    match &here {
        Some(srv) => {
            out.push(Item::Section(format!("On {}", host(srv))));
            server_rows(app, srv, false, &mut out);
            let mut others = Vec::new();
            for s in servers.iter().filter(|s| *s != srv) {
                other_rows(app, s, &mut others);
            }
            if !others.is_empty() {
                out.push(Item::Section("Other servers".into()));
                out.extend(others);
            }
            if !locals.is_empty() {
                out.push(Item::Section("This Mac".into()));
                out.extend(locals);
            }
        }
        None => {
            if !locals.is_empty() {
                out.push(Item::Section("This Mac".into()));
                out.extend(locals);
            }
            for s in &servers {
                out.push(Item::Section(format!("On {}", host(s))));
                server_rows(app, s, true, &mut out);
            }
        }
    }
    out.push(Item::Sep);
    out.push(Item::act(Act::OpenFolder, "Open folder…"));
    out.push(Item::act(Act::AddRemote, "Add remote workspace…"));
    let Some(srv) = here else { return tidy(out) };
    let signed_in = signed_in(app, &srv);
    if signed_in {
        out.push(Item::act(Act::NewWorkspace, "New workspace…"));
        out.push(Item::act(Act::AddGitHub, "Add GitHub repo…"));
    }
    // the open workspace: only once it's loaded (the web app's `ws`)
    if let Some(rem) = app.remote.as_ref().filter(|r| signed_in && r.loaded && r.problem.is_none()) {
        let joined = joined(app, &srv, rem.id());
        let role = if rem.role.is_empty() { joined.map(|j| j.role.clone()).unwrap_or_default() } else { rem.role.clone() };
        let repo = &rem.repo;
        out.push(Item::Sep);
        if role == "owner" {
            out.push(Item::act(Act::ShareWorkspace, "Share workspace…"));
        }
        if repo["canShare"] == true && repo["status"] == "ready" {
            out.push(Item::act(Act::ShareAgent, "Share with agent…"));
        }
        if repo["kind"] == "github" && repo["ghOwner"].is_string() {
            out.push(Item::act(Act::OpenGitHub, "Open on GitHub"));
        }
        out.push(Item::act(Act::Refresh, "Refresh"));
        if joined.is_some_and(|j| j.role != "owner") {
            out.push(Item::act(Act::Leave, "Leave workspace"));
        }
        if repo["canRemove"] == true {
            out.push(Item::act(Act::Remove, "Remove workspace…"));
        }
    }
    out.push(Item::Sep);
    if signed_in {
        out.push(Item::Section(account_line(app, &srv)));
        out.push(Item::act(Act::ChangeName, "Change name…"));
        out.push(Item::act(Act::Settings, "Settings"));
        out.push(Item::act(Act::SwitchAccount, "Switch account"));
        out.push(Item::act(Act::SignOut, "Sign out"));
    } else {
        out.push(Item::Section(format!("Signed out of {}", host(&srv))));
        out.push(Item::act(Act::Reconnect(srv.clone()), "Reconnect"));
        if app.store.server(&srv).is_some() {
            out.push(Item::act(Act::Forget(srv.clone()), "Forget"));
        }
    }
    tidy(out)
}

/// Whether the app has a working token for `server`.
pub fn signed_in(app: &App, server: &str) -> bool {
    let out = app.switcher.server_issues.iter().any(|(u, i)| u == server && *i == ServerIssue::SignedOut);
    let open = app.remote.as_ref().filter(|r| r.api.server == server);
    let refused = open.is_some_and(|r| r.problem == Some(crate::remote::Problem::SignedOut));
    !out && !refused && (app.store.server(server).is_some() || open.is_some_and(|r| r.loaded))
}

/// "Signed in as <name> · <email>" (no email for name sign-ins, whose addresses end in @localhost).
pub fn account_line(app: &App, server: &str) -> String {
    let rem = app.remote.as_ref().filter(|r| r.api.server == server);
    let s = app.store.server(server);
    let name = s.and_then(|s| s.account.clone()).or_else(|| rem.and_then(|r| r.account.clone())).unwrap_or_default();
    let email = s.and_then(|s| s.email.clone()).or_else(|| rem.and_then(|r| r.me["email"].as_str().map(str::to_string))).unwrap_or_default();
    if email.is_empty() || email.ends_with("@localhost") { format!("Signed in as {name}") } else { format!("Signed in as {name} · {email}") }
}

fn joined<'a>(app: &'a App, server: &str, id: &str) -> Option<&'a workspaces::Joined> {
    app.store.server(server).and_then(|s| s.joined.iter().find(|j| j.id == id))
}

/// A server's section: what's wrong with it (local mode: signed out → Reconnect / Forget), its joined
/// workspaces with their badges, the open one when it isn't joined, or "No workspaces yet".
fn server_rows(app: &App, url: &str, issues: bool, out: &mut Vec<Item>) {
    let cur = app.current.as_ref();
    let srv = app.store.server(url);
    let issue = app.switcher.server_issues.iter().find(|(u, _)| u == url).map(|(_, i)| i.clone());
    match &issue {
        Some(ServerIssue::SignedOut) if issues => {
            out.push(Item::Note("Signed out".into()));
            out.push(Item::act(Act::Reconnect(url.to_string()), "Reconnect"));
            if srv.is_some() {
                out.push(Item::act(Act::Forget(url.to_string()), "Forget"));
            }
        }
        Some(ServerIssue::Error(e)) => out.push(Item::Note(e.clone())),
        _ => {}
    }
    let mut rows: Vec<Item> = srv
        .map(|s| {
            s.joined
                .iter()
                .map(|j| {
                    let ws = WsRef::Remote { server: url.to_string(), id: j.id.clone(), title: j.title.clone() };
                    Item::Ws { checked: cur.is_some_and(|c| c.same(&ws)), detail: j.badge(), removable: false, ws }
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(c) = cur.filter(|c| matches!(c, WsRef::Remote { server, .. } if server == url))
        && !rows.iter().any(|r| matches!(r, Item::Ws { ws, .. } if ws.same(c)))
    {
        // the open workspace isn't joined (opened by URL, or one it can't open): still shown, with why
        let why = app.remote_status().filter(|_| app.remote.as_ref().is_some_and(|r| r.problem.is_some())).map(|s| s.to_lowercase()).unwrap_or_default();
        rows.push(Item::Ws { ws: c.clone(), detail: why, checked: true, removable: false });
    }
    if rows.is_empty() {
        rows.push(Item::Act { act: Act::NewWorkspace, label: "No workspaces yet".into(), disabled: true });
    }
    out.extend(rows);
}

/// Another server (the open workspace is elsewhere): its joined workspaces with its host, or what's wrong.
fn other_rows(app: &App, url: &str, out: &mut Vec<Item>) {
    let h = host(url);
    match app.switcher.server_issues.iter().find(|(u, _)| u == url).map(|(_, i)| i.clone()) {
        Some(ServerIssue::SignedOut) => {
            out.push(Item::Note(format!("Signed out of {h}")));
            out.push(Item::act(Act::Reconnect(url.to_string()), "Reconnect"));
            out.push(Item::act(Act::Forget(url.to_string()), "Forget"));
            return;
        }
        Some(ServerIssue::Error(e)) => out.push(Item::Note(format!("{h}: {e}"))),
        None => {}
    }
    for j in app.store.server(url).map(|s| s.joined.clone()).unwrap_or_default() {
        out.push(Item::Ws { ws: WsRef::Remote { server: url.to_string(), id: j.id, title: j.title }, detail: h.clone(), checked: false, removable: false });
    }
}

/// No separator first, last, or twice in a row (the web app's `showMenu`).
fn tidy(items: Vec<Item>) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    for i in items {
        if i == Item::Sep && out.last().is_none_or(|l| *l == Item::Sep) {
            continue;
        }
        out.push(i);
    }
    while out.last() == Some(&Item::Sep) {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{FakeRest, FakeWs};
    use crate::remote::{Backend, Mock};
    use crate::workspaces::Joined;
    use rune::Tx;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};

    const SERVER: &str = "https://grimoire.example";

    fn labels(app: &App) -> Vec<String> {
        items(app).iter().map(Item::label).collect()
    }

    /// A remote workspace `team` on the mock server where we're `role` (joined `via`), plus a local folder
    /// and another server.
    fn remote_app(role: &str, via: &str, google: bool) -> (App, Arc<Mutex<FakeRest>>) {
        let mut rest = FakeRest::new(SERVER, "Ann", "ann@example.com");
        rest.google = google;
        rest.workspaces.push(FakeWs::new("team", "Team", role, via));
        rest.workspaces.push(FakeWs::new("other", "Other", "editor", "member"));
        let rest = Arc::new(Mutex::new(rest));
        let mut m = Mock::new(&[("README.md", "# Team\n")]);
        m.rest = Some(rest.clone());
        m.account = "Ann".into();
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(Rc::new(RefCell::new(m)));
        app.store.touch(&WsRef::Local { path: PathBuf::from("/Users/ann/Notes") }, None);
        let joined = |id: &str, title: &str, role: &str, via: &str| Joined { id: id.into(), title: title.into(), role: role.into(), read_only: false, joined_via: via.into() };
        let mut list = vec![joined("other", "Other", "editor", "member")];
        if via != "none" {
            list.insert(0, joined("team", "Team", role, via));
        }
        app.store.upsert_server(SERVER, Some("Grimoire"), Some(list));
        app.store.set_account(SERVER, Some("Ann".into()), Some("t_mac".into()));
        app.store.set_details(SERVER, Some("ann@example.com".into()), Some(google));
        app.store.upsert_server("http://100.1.2.3:3000", None, Some(vec![joined("lab", "Lab", "viewer", "member")]));
        let mut tx = Tx::default();
        app.open_remote(SERVER.into(), "team".into(), "Team".into(), None, &mut tx);
        assert!(app.remote.as_ref().unwrap().loaded);
        (app, rest)
    }

    const TAIL_ACCOUNT: [&str; 5] = ["Signed in as Ann · ann@example.com", "Change name…", "Settings", "Switch account", "Sign out"];

    fn expect(head: &[&str], ws: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = head.iter().map(|s| s.to_string()).collect();
        v.extend(["—", "Open folder…", "Add remote workspace…", "New workspace…", "Add GitHub repo…", "—"].map(String::from));
        v.extend(ws.iter().map(|s| s.to_string()));
        v.push("—".into());
        v.extend(TAIL_ACCOUNT.map(String::from));
        v
    }

    const HEAD: [&str; 7] = ["On grimoire.example", "• Team [{badge}]", "Other [Editor]", "Other servers", "Lab [100.1.2.3:3000]", "This Mac", "Notes [/Users/ann/Notes]"];

    fn head(badge: &str) -> Vec<String> {
        HEAD.iter().map(|s| s.replace("{badge}", badge)).collect()
    }

    #[test]
    fn remote_owner_gets_every_item_like_the_web() {
        let (app, _) = remote_app("owner", "member", true);
        let h = head("Owner");
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &["Share workspace…", "Share with agent…", "Refresh", "Remove workspace…"]));
    }

    #[test]
    fn remote_editor_viewer_and_link_only() {
        let (app, _) = remote_app("editor", "member", true);
        let h = head("Editor");
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &["Share with agent…", "Refresh", "Leave workspace"]));
        // viewers can't hand out agent links to a writable workspace
        let (app, _) = remote_app("viewer", "member", true);
        let h = head("Viewer");
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &["Refresh", "Leave workspace"]));
        // joined through link access (edit)
        let (app, _) = remote_app("editor", "link", true);
        let h = head("via link");
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &["Share with agent…", "Refresh", "Leave workspace"]));
        let (app, _) = remote_app("viewer", "domain", true);
        assert!(labels(&app).contains(&"• Team [Viewer · domain]".to_string()));
        // opened by URL, not (yet) joined: listed, checked, no badge, and no Leave
        let (app, _) = remote_app("viewer", "none", true);
        let l = labels(&app);
        assert!(l.contains(&"• Team".to_string()), "{l:?}");
        assert!(!l.contains(&"Leave workspace".to_string()));
    }

    #[test]
    fn a_github_workspace_offers_open_on_github() {
        let (mut app, rest) = remote_app("owner", "member", true);
        {
            let mut r = rest.lock().unwrap();
            let w = r.workspaces.iter_mut().find(|w| w.id == "team").unwrap();
            w.kind = "github".into();
            w.read_only = true;
            w.gh = Some(("acme".into(), "docs".into()));
        }
        let mut tx = Tx::default();
        app.open_remote(SERVER.into(), "team".into(), "Team".into(), None, &mut tx);
        let l = labels(&app);
        let i = l.iter().position(|s| s == "Open on GitHub").expect("Open on GitHub");
        assert_eq!(&l[i - 2..i + 2], ["Share workspace…", "Share with agent…", "Open on GitHub", "Refresh"]);
    }

    #[test]
    fn local_has_no_server_items() {
        let (mut app, _) = remote_app("owner", "member", true);
        let dir = std::env::temp_dir().join(format!("grimoire-menu-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut tx = Tx::default();
        app.open_local(dir.clone(), &mut tx);
        let l = labels(&app);
        let name = crate::files::note_name(&std::fs::canonicalize(&dir).unwrap());
        assert_eq!(l[0], "This Mac");
        assert!(l.iter().any(|s| s.starts_with(&format!("• {name} ["))), "{l:?}");
        assert!(l.contains(&"On grimoire.example".to_string()) && l.contains(&"Team [Owner]".to_string()) && l.contains(&"On 100.1.2.3:3000".to_string()));
        assert_eq!(&l[l.len() - 3..], ["—", "Open folder…", "Add remote workspace…"]);
        for no in ["New workspace…", "Add GitHub repo…", "Share workspace…", "Share with agent…", "Refresh", "Leave workspace", "Remove workspace…", "Change name…", "Settings", "Sign out", "Switch account"] {
            assert!(!l.contains(&no.to_string()), "{no} in a local menu: {l:?}");
        }
        assert!(!l.iter().any(|s| s.starts_with("Signed in as")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signed_out_servers_offer_reconnect() {
        let (mut app, _) = remote_app("owner", "member", true);
        app.switcher.server_issues.push(("http://100.1.2.3:3000".into(), ServerIssue::SignedOut));
        let l = labels(&app);
        let i = l.iter().position(|s| s == "Other servers").unwrap();
        assert_eq!(&l[i + 1..i + 4], ["Signed out of 100.1.2.3:3000", "Reconnect", "Forget"]);
        // the open workspace's server signed out: no workspace or account items, Reconnect instead
        app.switcher.server_issues.push((SERVER.into(), ServerIssue::SignedOut));
        let l = labels(&app);
        assert_eq!(&l[l.len() - 3..], ["Signed out of grimoire.example", "Reconnect", "Forget"]);
        assert!(!l.contains(&"New workspace…".to_string()) && !l.contains(&"Share workspace…".to_string()));
    }

    /// The web app's switcher as captured in headless Chromium on the scratch server (James: owner of
    /// "Linked", "Parity QA" through its domain rule; `crates/app/tests/integration/parity.md`): the Mac's
    /// items are the same, in the same order, plus its own "Open folder…" and "Switch account".
    #[test]
    fn matches_the_web_menu_captured_on_the_scratch_server() {
        let web_owner = ["On 100.73.96.98:47393", "• Linked [Owner]", "Parity QA [Viewer · domain]", "—", "Add remote workspace…", "New workspace…", "Add GitHub repo…", "—", "Share workspace…", "Share with agent…", "Refresh", "Remove workspace…", "—", "Signed in as James · james@example.com", "Change name…", "Settings", "Sign out"];
        let web_viewer = ["On 100.73.96.98:47393", "Linked [Owner]", "• Parity QA [Viewer · domain]", "—", "Add remote workspace…", "New workspace…", "Add GitHub repo…", "—", "Refresh", "Leave workspace", "—", "Signed in as James · james@example.com", "Change name…", "Settings", "Sign out"];
        let srv = "http://100.73.96.98:47393";
        let mut rest = FakeRest::new(srv, "James", "james@example.com");
        rest.workspaces.push(FakeWs::new("linked", "Linked", "owner", "member"));
        rest.workspaces.push(FakeWs::new("parity", "Parity QA", "viewer", "domain"));
        let rest = Arc::new(Mutex::new(rest));
        let mut m = Mock::new(&[("README.md", "# x\n")]);
        m.rest = Some(rest);
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(Rc::new(RefCell::new(m)));
        let j = |id: &str, t: &str, r: &str, via: &str| Joined { id: id.into(), title: t.into(), role: r.into(), read_only: false, joined_via: via.into() };
        app.store.upsert_server(srv, None, Some(vec![j("linked", "Linked", "owner", "member"), j("parity", "Parity QA", "viewer", "domain")]));
        app.store.set_account(srv, Some("James".into()), None);
        app.store.set_details(srv, Some("james@example.com".into()), Some(true));
        let mac_only = |l: Vec<String>| l.into_iter().filter(|s| s != "Open folder…" && s != "Switch account").collect::<Vec<_>>();
        let mut tx = Tx::default();
        for (id, web) in [("linked", &web_owner[..]), ("parity", &web_viewer[..])] {
            app.open_remote(srv.into(), id.into(), String::new(), None, &mut tx);
            let mac = labels(&app);
            let i = mac.iter().position(|s| s == "Add remote workspace…").unwrap();
            assert_eq!(mac[i - 1], "Open folder…", "Open folder… right before Add remote workspace…");
            assert_eq!(mac[mac.len() - 2], "Switch account");
            assert_eq!(mac_only(mac), web.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        }
    }

    #[test]
    fn name_sign_ins_show_no_localhost_email() {
        let (mut app, _) = remote_app("owner", "member", true);
        app.store.set_details(SERVER, Some("mac-user-1@localhost".into()), None);
        assert!(labels(&app).contains(&"Signed in as Ann".to_string()));
    }
}
