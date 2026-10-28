//! What the folder switcher's menu lists, in order (drawn by `switcher::menu`): the web app's switcher
//! (`openSwitcher` in multiplayer-notepad `src/client/main.ts`) item for item when the open folder is
//! remote, plus the folders on this Mac; for a local folder only what needs no server. (In the code a
//! folder, local or remote, is a "workspace"; the UI says "folder".)
//!
//! Every folder row is its name (a dot on the open one) and an × at the right, nothing else: "Remove from
//! list" for a local folder (not the open one), leave for a joined remote one (`leave_cross`, the web's rule).
//!
//! Remote: "On <host>" (the folders joined there), "On <host>" for each other server the app is connected
//! to (its joined folders, left with that server's token), "This Mac", then New… (the "New" dialog: a new
//! folder on this Mac or on a server) and Open… (the "Open" dialog: a folder on this Mac, a remote folder, a
//! GitHub repo); the open
//! folder's Share folder… (owners), Open on GitHub, Remove folder… (owners); and the
//! account: "Signed in as <name> · <email>", Change name…, Settings, Switch account, Sign out.
//!
//! Local: "This Mac", then "On <host>" for each server the app is connected to, New…, Open…: no sharing,
//! members, agent links or account (those need a server).

use crate::App;
use crate::switcher::ServerIssue;
use crate::workspaces::{self, WsRef};

/// What a menu item does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    /// "New…": a new folder on this Mac or on a server.
    New,
    /// "Open…": a folder on this Mac, a remote folder by URL or a GitHub repo.
    Open,
    ShareWorkspace,
    OpenGitHub,
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
            Act::New => "sw-new".into(),
            Act::Open => "sw-open".into(),
            Act::ShareWorkspace => "sw-share-workspace".into(),
            Act::OpenGitHub => "sw-open-github".into(),
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

/// What a folder row's × does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cross {
    /// A local folder: "Remove from list".
    Forget,
    /// A joined remote folder: leave it on its server, after a confirm when that ends a membership.
    Leave { confirm: bool },
}

/// The × on a joined remote folder (the web app's rule): none for the last owner (`canLeave` false; a server
/// that doesn't say: none for owners); otherwise leave, at once when joined through a link or a domain
/// rule, after the confirm for an invited member (getting back in takes a new invite).
pub fn leave_cross(j: &workspaces::Joined) -> Option<Cross> {
    if !j.can_leave.unwrap_or(j.role != "owner") {
        return None;
    }
    Some(Cross::Leave { confirm: !matches!(j.joined_via.as_str(), "link" | "domain") })
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    /// A section heading ("On grimoire.exe.xyz", "Signed in as …").
    Section(String),
    /// A folder to switch to: its name, a dot when it's the open one, and what its × does (if it has one).
    Ws { ws: WsRef, checked: bool, cross: Option<Cross> },
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
            Item::Ws { ws, checked, .. } => format!("{}{}", if *checked { "• " } else { "" }, ws.name()),
            Item::Act { label, disabled, .. } => if *disabled { format!("({label})") } else { label.clone() },
            Item::Sep => "—".into(),
        }
    }
}

pub fn host(server: &str) -> String {
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
            Item::Ws { checked, cross: (!checked).then_some(Cross::Forget), ws: w }
        })
        .collect();
    let servers: Vec<String> = app.store.servers.iter().map(|s| s.url.clone()).collect();
    match &here {
        Some(srv) => {
            out.push(Item::Section(format!("On {}", host(srv))));
            server_rows(app, srv, false, &mut out);
            for s in servers.iter().filter(|s| *s != srv) {
                out.push(Item::Section(format!("On {}", host(s))));
                server_rows(app, s, true, &mut out);
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
    out.push(Item::act(Act::New, "New…"));
    out.push(Item::act(Act::Open, "Open…"));
    let Some(srv) = here else { return tidy(out) };
    let signed_in = signed_in(app, &srv);
    // the open workspace: only once it's loaded (the web app's `ws`)
    if let Some(rem) = app.remote.as_ref().filter(|r| signed_in && r.loaded && r.problem.is_none()) {
        let role = if rem.role.is_empty() { joined(app, &srv, rem.id()).map(|j| j.role.clone()).unwrap_or_default() } else { rem.role.clone() };
        let repo = &rem.repo;
        out.push(Item::Sep);
        if role == "owner" {
            out.push(Item::act(Act::ShareWorkspace, "Share folder…"));
        }
        if repo["kind"] == "github" && repo["ghOwner"].is_string() {
            out.push(Item::act(Act::OpenGitHub, "Open on GitHub"));
        }
        if repo["canRemove"] == true {
            out.push(Item::act(Act::Remove, "Remove folder…"));
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

/// A server's section: what's wrong with it (signed out → Reconnect / Forget, unless it's the open folder's
/// server, whose account section says so), its joined folders, the open one when it isn't joined (no ×),
/// or "No folders yet".
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
                    Item::Ws { checked: cur.is_some_and(|c| c.same(&ws)), cross: leave_cross(j), ws }
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(c) = cur.filter(|c| matches!(c, WsRef::Remote { server, .. } if server == url))
        && !rows.iter().any(|r| matches!(r, Item::Ws { ws, .. } if ws.same(c)))
    {
        // the open workspace isn't joined (opened by URL, or one it can't open): still shown, checked
        rows.push(Item::Ws { ws: c.clone(), checked: true, cross: None });
    }
    if rows.is_empty() {
        rows.push(Item::Act { act: Act::Open, label: "No folders yet".into(), disabled: true });
    }
    out.extend(rows);
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
        let joined = |id: &str, title: &str, role: &str, via: &str| Joined { id: id.into(), title: title.into(), role: role.into(), read_only: false, joined_via: via.into(), can_leave: None };
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
        v.extend(["—", "New…", "Open…"].map(String::from));
        if !ws.is_empty() {
            v.push("—".into());
        }
        v.extend(ws.iter().map(|s| s.to_string()));
        v.push("—".into());
        v.extend(TAIL_ACCOUNT.map(String::from));
        v
    }

    /// Folder rows are names only (no access badge, host or path), each server under its own heading.
    const HEAD: [&str; 7] = ["On grimoire.example", "• Team", "Other", "On 100.1.2.3:3000", "Lab", "This Mac", "Notes"];

    fn head() -> Vec<String> {
        HEAD.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn remote_owner_gets_every_item_like_the_web() {
        let (app, _) = remote_app("owner", "member", true);
        let h = head();
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &["Share folder…", "Remove folder…"]));
    }

    #[test]
    fn remote_editor_viewer_and_link_only() {
        let (app, _) = remote_app("editor", "member", true);
        let h = head();
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &[]));
        // viewers can't hand out agent links to a writable workspace
        let (app, _) = remote_app("viewer", "member", true);
        let h = head();
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &[]));
        // joined through link access (edit)
        let (app, _) = remote_app("editor", "link", true);
        let h = head();
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &[]));
        let (app, _) = remote_app("viewer", "domain", true);
        let h = head();
        let h: Vec<&str> = h.iter().map(String::as_str).collect();
        assert_eq!(labels(&app), expect(&h, &[]));
        // opened by URL, not (yet) joined: listed, checked
        let (app, _) = remote_app("viewer", "none", true);
        let l = labels(&app);
        assert!(l.contains(&"• Team".to_string()), "{l:?}");
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
        assert_eq!(&l[i - 1..i + 2], ["Share folder…", "Open on GitHub", "Remove folder…"]);
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
        assert!(l.contains(&format!("• {name}")), "{l:?}");
        assert!(l.contains(&"On grimoire.example".to_string()) && l.contains(&"Team".to_string()) && l.contains(&"On 100.1.2.3:3000".to_string()));
        assert_eq!(&l[l.len() - 3..], ["—", "New…", "Open…"]);
        for no in ["Share folder…", "Remove folder…", "Change name…", "Settings", "Sign out", "Switch account"] {
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
        let i = l.iter().position(|s| s == "On 100.1.2.3:3000").unwrap();
        assert_eq!(&l[i + 1..i + 5], ["Signed out", "Reconnect", "Forget", "Lab"]);
        // the open workspace's server signed out: no workspace or account items, Reconnect instead
        app.switcher.server_issues.push((SERVER.into(), ServerIssue::SignedOut));
        let l = labels(&app);
        assert_eq!(&l[l.len() - 3..], ["Signed out of grimoire.example", "Reconnect", "Forget"]);
        assert!(!l.contains(&"Share folder…".to_string()) && l.contains(&"Open…".to_string()));
    }

    /// The web app's switcher as captured in headless Chromium on the scratch server (James: owner of
    /// "Linked", "Parity QA" through its domain rule; `crates/app/tests/integration/parity.md`; re-captured
    /// after the web's "folder" rename and its one "Open…" item, with the access badges, Refresh and Leave folder
    /// taken out of both apps' menus by hand): the Mac's items are the same, in the same
    /// order, plus its own "Switch account".
    #[test]
    fn matches_the_web_menu_captured_on_the_scratch_server() {
        let web_owner = ["On 100.73.96.98:47393", "• Linked", "Parity QA", "—", "New…", "Open…", "—", "Share folder…", "Remove folder…", "—", "Signed in as James · james@example.com", "Change name…", "Settings", "Sign out"];
        let web_viewer = ["On 100.73.96.98:47393", "Linked", "• Parity QA", "—", "New…", "Open…", "—", "Signed in as James · james@example.com", "Change name…", "Settings", "Sign out"];
        let srv = "http://100.73.96.98:47393";
        let mut rest = FakeRest::new(srv, "James", "james@example.com");
        rest.workspaces.push(FakeWs::new("linked", "Linked", "owner", "member"));
        rest.workspaces.push(FakeWs::new("parity", "Parity QA", "viewer", "domain"));
        let rest = Arc::new(Mutex::new(rest));
        let mut m = Mock::new(&[("README.md", "# x\n")]);
        m.rest = Some(rest);
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(Rc::new(RefCell::new(m)));
        let j = |id: &str, t: &str, r: &str, via: &str| Joined { id: id.into(), title: t.into(), role: r.into(), read_only: false, joined_via: via.into(), can_leave: None };
        app.store.upsert_server(srv, None, Some(vec![j("linked", "Linked", "owner", "member"), j("parity", "Parity QA", "viewer", "domain")]));
        app.store.set_account(srv, Some("James".into()), None);
        app.store.set_details(srv, Some("james@example.com".into()), Some(true));
        let mac_only = |l: Vec<String>| l.into_iter().filter(|s| s != "Switch account").collect::<Vec<_>>();
        let mut tx = Tx::default();
        for (id, web) in [("linked", &web_owner[..]), ("parity", &web_viewer[..])] {
            app.open_remote(srv.into(), id.into(), String::new(), None, &mut tx);
            let mac = labels(&app);
            assert_eq!(mac[mac.len() - 2], "Switch account");
            assert_eq!(mac_only(mac), web.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        }
    }

    fn crosses(app: &App) -> Vec<(String, Option<Cross>)> {
        items(app)
            .into_iter()
            .filter_map(|i| match i {
                Item::Ws { ws, checked, cross } => Some((format!("{}{}", if checked { "• " } else { "" }, ws.name()), cross)),
                _ => None,
            })
            .collect()
    }

    fn set_can_leave(app: &mut App, id: &str, can: Option<bool>) {
        let s = app.store.servers.iter_mut().find(|s| s.url == SERVER).unwrap();
        s.joined.iter_mut().find(|j| j.id == id).unwrap().can_leave = can;
    }

    /// The × on every folder row, by the web's rules: local folders "Remove from list" (not the open one);
    /// joined remote ones leave (another server's too), at once when joined through a link or a domain rule,
    /// after the confirm for an invited member; none for the last owner, nor for one opened but not joined.
    #[test]
    fn every_folder_row_gets_an_x_by_the_webs_rules() {
        let leave = |confirm| Some(Cross::Leave { confirm });
        let s = |x: &str| x.to_string();
        let (app, _) = remote_app("editor", "member", true);
        assert_eq!(crosses(&app), vec![(s("• Team"), leave(true)), (s("Other"), leave(true)), (s("Lab"), leave(true)), (s("Notes"), Some(Cross::Forget))]);
        assert!(!labels(&app).contains(&s("Leave folder")));
        for via in ["link", "domain"] {
            let (app, _) = remote_app("viewer", via, true);
            assert_eq!(crosses(&app)[0], (s("• Team"), leave(false)), "{via}");
        }
        // owners: none for the only one (the server's canLeave false, or a server that doesn't say)
        let (mut app, _) = remote_app("owner", "member", true);
        assert_eq!(crosses(&app)[0], (s("• Team"), None));
        set_can_leave(&mut app, "team", Some(false));
        assert_eq!(crosses(&app)[0], (s("• Team"), None));
        // … and the member confirm when there are other owners
        set_can_leave(&mut app, "team", Some(true));
        assert_eq!(crosses(&app)[0], (s("• Team"), leave(true)));
        let (app, _) = remote_app("viewer", "none", true);
        assert!(crosses(&app).contains(&(s("• Team"), None)));
        // a local folder: no × on the open one
        let (mut app, _) = remote_app("owner", "member", true);
        let dir = std::env::temp_dir().join(format!("grimoire-menu-x-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut tx = Tx::default();
        app.open_local(dir.clone(), &mut tx);
        let c = crosses(&app);
        assert!(c.iter().any(|(n, x)| n.starts_with("• ") && x.is_none()), "{c:?}");
        assert!(c.contains(&(s("Notes"), Some(Cross::Forget))), "{c:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn name_sign_ins_show_no_localhost_email() {
        let (mut app, _) = remote_app("owner", "member", true);
        app.store.set_details(SERVER, Some("mac-user-1@localhost".into()), None);
        assert!(labels(&app).contains(&"Signed in as Ann".to_string()));
    }
}
