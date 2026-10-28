//! What the folder switcher's menu lists, in order (drawn by `switcher::menu`): the web app's switcher
//! (`openSwitcher` in multiplayer-notepad `src/client/main.ts`) item for item when the open folder is
//! remote, plus the folders on this Mac; for a local folder only what needs no server. (In the code a
//! folder, local or remote, is a "workspace"; the UI says "folder".)
//!
//! Every folder row is its name (a dot on the open one) and an × at the right, nothing else: "Remove from
//! list" for a local folder (not the open one), leave for a joined remote one (at once, as on the web).
//!
//! Always one order, whichever folder is open (the open one only gets its dot): "This Mac" (local folders by
//! name), then each server the app is connected to by host, its host as the heading ("grimoire.exe.xyz": the
//! folders joined there, by name; left with that server's token); `natural_cmp`, `folder_cmp`. Then New… (the "New" dialog: a new
//! folder on this Mac or on a server) and Open… (the "Open" dialog: a folder on this Mac, a remote folder, a
//! GitHub repo); the open folder's Open on GitHub, Remove folder… (its maker).
//!
//! A local folder open: the same lists, then New…, Open….
//!
//! The account isn't in the switcher: the row at the bottom of the sidebar shows the open remote folder's
//! account (none for a local folder) and opens `account_items` (the web's account menu: the email, Change
//! name…, Sign out; plus the Mac's Switch account; Reconnect / Forget when signed out).

use crate::App;
use crate::switcher::ServerIssue;
use crate::workspaces::WsRef;

/// What a menu item does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    /// "New…": a new folder on this Mac or on a server.
    New,
    /// "Open…": a folder on this Mac, a remote folder by URL or a GitHub repo.
    Open,
    OpenGitHub,
    Remove,
    ChangeName,
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
            Act::OpenGitHub => "sw-open-github".into(),
            Act::Remove => "sw-remove".into(),
            Act::ChangeName => "sw-change-name".into(),
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
    /// A joined remote folder: leave it on its server (at once; opening it again joins it again).
    Leave,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    /// A section heading (a server's host, "grimoire.exe.xyz"; an account's email).
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
    // One fixed order whichever folder is open (the web's too): This Mac first, then each server by host,
    // folders by name (`natural_cmp`, ties by path / id); the open folder only gets its dot.
    if !locals.is_empty() {
        out.push(Item::Section("This Mac".into()));
        out.extend(locals);
    }
    let mut servers: Vec<String> = app.store.servers.iter().map(|s| s.url.clone()).collect();
    if let Some(h) = here.as_ref().filter(|h| !servers.contains(h)) {
        servers.push(h.clone());
    }
    servers.sort_by(|a, b| natural_cmp(&host(a), &host(b)).then_with(|| a.cmp(b)));
    for s in &servers {
        out.push(Item::Section(host(s)));
        // the open folder's server says it's signed out in the account row, the others here
        server_rows(app, s, here.as_ref() != Some(s), &mut out);
    }
    out.push(Item::Sep);
    out.push(Item::act(Act::New, "New…"));
    out.push(Item::act(Act::Open, "Open…"));
    let Some(srv) = here else { return tidy(out) };
    let signed_in = signed_in(app, &srv);
    // the open workspace: only once it's loaded (the web app's `ws`)
    if let Some(rem) = app.remote.as_ref().filter(|r| signed_in && r.loaded && r.problem.is_none()) {
        let repo = &rem.repo;
        out.push(Item::Sep);
        if repo["kind"] == "github" && repo["ghOwner"].is_string() {
            out.push(Item::act(Act::OpenGitHub, "Open on GitHub"));
        }
        if repo["canRemove"] == true {
            out.push(Item::act(Act::Remove, "Remove folder…"));
        }
    }
    tidy(out)
}

/// The server whose account the sidebar's account row shows: the open remote folder's. None for a local
/// folder (no server: no row).
pub fn account_server(app: &App) -> Option<String> {
    match app.current.as_ref() {
        Some(WsRef::Remote { server, .. }) => Some(server.clone()),
        _ => None,
    }
}

/// The account menu (opens upward from the sidebar's account row): the web's (the email when there is one,
/// Change name…, Sign out) plus the Mac's Switch account; signed out, Reconnect and Forget.
pub fn account_items(app: &App) -> Vec<Item> {
    let Some(srv) = account_server(app) else { return Vec::new() };
    let mut out = Vec::new();
    if signed_in(app, &srv) {
        let (_, email) = account(app, &srv);
        if !email.is_empty() {
            out.push(Item::Section(email));
        }
        out.push(Item::act(Act::ChangeName, "Change name…"));
        out.push(Item::act(Act::SwitchAccount, "Switch account"));
        out.push(Item::act(Act::SignOut, "Sign out"));
    } else {
        out.push(Item::Section(format!("Signed out of {}", host(&srv))));
        out.push(Item::act(Act::Reconnect(srv.clone()), "Reconnect"));
        if app.store.server(&srv).is_some() {
            out.push(Item::act(Act::Forget(srv.clone()), "Forget"));
        }
    }
    out
}

/// What the account row says: the account's name, or "Signed out" (None for a local folder).
pub fn account_label(app: &App) -> Option<String> {
    let srv = account_server(app)?;
    if !signed_in(app, &srv) {
        return Some("Signed out".into());
    }
    let (name, _) = account(app, &srv);
    Some(if name.is_empty() { host(&srv) } else { name })
}

/// The switcher's rows and items the keyboard can highlight and choose (folder rows and enabled items), in
/// order.
pub fn choosable(app: &App) -> Vec<Item> {
    items(app).into_iter().filter(|i| matches!(i, Item::Ws { .. } | Item::Act { disabled: false, .. })).collect()
}

/// Whether the app has a working token for `server`.
pub fn signed_in(app: &App, server: &str) -> bool {
    let out = app.switcher.server_issues.iter().any(|(u, i)| u == server && *i == ServerIssue::SignedOut);
    let open = app.remote.as_ref().filter(|r| r.api.server == server);
    let refused = open.is_some_and(|r| r.problem == Some(crate::remote::Problem::SignedOut));
    !out && !refused && (app.store.server(server).is_some() || open.is_some_and(|r| r.loaded))
}

/// The account on `server`: its name and email (no email for name sign-ins, whose addresses end in @localhost).
pub fn account(app: &App, server: &str) -> (String, String) {
    let rem = app.remote.as_ref().filter(|r| r.api.server == server);
    let s = app.store.server(server);
    let name = s.and_then(|s| s.account.clone()).or_else(|| rem.and_then(|r| r.account.clone())).unwrap_or_default();
    let email = s.and_then(|s| s.email.clone()).or_else(|| rem.and_then(|r| r.me["email"].as_str().map(str::to_string))).unwrap_or_default();
    (name, if email.ends_with("@localhost") { String::new() } else { email })
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
                    Item::Ws { checked: cur.is_some_and(|c| c.same(&ws)), cross: Some(Cross::Leave), ws }
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
    rows.sort_by(|a, b| match (a, b) {
        (Item::Ws { ws: x, .. }, Item::Ws { ws: y, .. }) => folder_cmp(x, y),
        _ => std::cmp::Ordering::Equal,
    });
    if rows.is_empty() {
        rows.push(Item::Act { act: Act::Open, label: "No folders yet".into(), disabled: true });
    }
    out.extend(rows);
}

/// The switcher's name order (the web's `localeCompare(…, { numeric: true, sensitivity: "base" })`):
/// case-insensitive, runs of digits by their value ("Notes 2" before "Notes 10"; "2" and "02" tie).
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    let digits = |it: &mut std::iter::Peekable<std::str::Chars>| {
        let mut s = String::new();
        while let Some(c) = it.peek().filter(|c| c.is_ascii_digit()) {
            s.push(*c);
            it.next();
        }
        s
    };
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Equal,
            (None, _) => return Less,
            (_, None) => return Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let (n, m) = (digits(&mut x), digits(&mut y));
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let o = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if o != Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                if c != d {
                    return c.cmp(&d);
                }
                x.next();
                y.next();
            }
        }
    }
}

/// Two folders in the switcher's order: by name, ties by path (local) or id (remote).
pub fn folder_cmp(a: &WsRef, b: &WsRef) -> std::cmp::Ordering {
    let key = |w: &WsRef| match w {
        WsRef::Local { path } => path.to_string_lossy().into_owned(),
        WsRef::Remote { id, .. } => id.clone(),
    };
    natural_cmp(&a.name(), &b.name()).then_with(|| key(a).cmp(&key(b)))
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

    /// A remote folder `team` on the mock server (made by us when `mine`; joined unless `joined` is false),
    /// another folder there, a local folder and another server.
    fn remote_app(mine: bool, joined: bool) -> (App, Arc<Mutex<FakeRest>>) {
        let mut rest = FakeRest::new(SERVER, "Ann", "ann@example.com");
        rest.workspaces.push(FakeWs::new("team", "Team", mine));
        rest.workspaces.push(FakeWs::new("other", "Other", false));
        let rest = Arc::new(Mutex::new(rest));
        let mut m = Mock::new(&[("README.md", "# Team\n")]);
        m.rest = Some(rest.clone());
        m.account = "Ann".into();
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(Rc::new(RefCell::new(m)));
        app.store.touch(&WsRef::Local { path: PathBuf::from("/Users/ann/Notes") }, None);
        let mut list = vec![Joined::new("other", "Other")];
        if joined {
            list.insert(0, Joined::new("team", "Team"));
        }
        app.store.upsert_server(SERVER, Some("Grimoire"), Some(list));
        app.store.set_account(SERVER, Some("Ann".into()), Some("t_mac".into()));
        app.store.set_details(SERVER, Some("ann@example.com".into()), Some(true));
        app.store.upsert_server("http://100.1.2.3:3000", None, Some(vec![Joined::new("lab", "Lab")]));
        let mut tx = Tx::default();
        app.open_remote(SERVER.into(), "team".into(), "Team".into(), None, &mut tx);
        assert!(app.remote.as_ref().unwrap().loaded);
        (app, rest)
    }

    fn expect(ws: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = HEAD.iter().map(|s| s.to_string()).collect();
        v.extend(["—", "New…", "Open…"].map(String::from));
        if !ws.is_empty() {
            v.push("—".into());
        }
        v.extend(ws.iter().map(|s| s.to_string()));
        v
    }

    /// Folder rows are names only: This Mac, then each server under its own heading, by host; folders by name.
    const HEAD: [&str; 7] = ["This Mac", "Notes", "100.1.2.3:3000", "Lab", "grimoire.example", "Other", "• Team"];

    /// Every folder is public: no sharing or settings items; Remove folder… only for its maker.
    #[test]
    fn remote_menus_like_the_web() {
        let (app, _) = remote_app(true, true);
        assert_eq!(labels(&app), expect(&["Remove folder…"]));
        let (app, _) = remote_app(false, true);
        assert_eq!(labels(&app), expect(&[]));
        // opened by URL, not (yet) joined: listed, checked
        let (app, _) = remote_app(false, false);
        let l = labels(&app);
        assert!(l.contains(&"• Team".to_string()), "{l:?}");
        for no in ["Share folder…", "Settings", "Share with agent…", "Leave folder"] {
            assert!(!l.contains(&no.to_string()), "{no}: {l:?}");
        }
    }

    #[test]
    fn a_github_workspace_offers_open_on_github() {
        let (mut app, rest) = remote_app(true, true);
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
        assert_eq!(&l[i - 1..i + 2], ["—", "Open on GitHub", "Remove folder…"]);
    }

    #[test]
    fn local_has_no_server_items() {
        let (mut app, _) = remote_app(true, true);
        let dir = std::env::temp_dir().join(format!("grimoire-menu-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut tx = Tx::default();
        app.open_local(dir.clone(), &mut tx);
        let l = labels(&app);
        let name = crate::files::note_name(&std::fs::canonicalize(&dir).unwrap());
        assert_eq!(l[0], "This Mac");
        assert!(l.contains(&format!("• {name}")), "{l:?}");
        assert!(l.contains(&"grimoire.example".to_string()) && l.contains(&"Team".to_string()) && l.contains(&"100.1.2.3:3000".to_string()));
        assert_eq!(&l[l.len() - 3..], ["—", "New…", "Open…"]);
        for no in ["Remove folder…", "Change name…", "Sign out", "Switch account"] {
            assert!(!l.contains(&no.to_string()), "{no} in a local menu: {l:?}");
        }
        assert!(account_items(&app).is_empty() && account_label(&app).is_none(), "a local folder: no account row");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signed_out_servers_offer_reconnect() {
        let (mut app, _) = remote_app(true, true);
        app.switcher.server_issues.push(("http://100.1.2.3:3000".into(), ServerIssue::SignedOut));
        let l = labels(&app);
        let i = l.iter().position(|s| s == "100.1.2.3:3000").unwrap();
        assert_eq!(&l[i + 1..i + 5], ["Signed out", "Reconnect", "Forget", "Lab"]);
        // the open workspace's server signed out: no workspace items; the account row says so, its menu
        // offers Reconnect / Forget
        app.switcher.server_issues.push((SERVER.into(), ServerIssue::SignedOut));
        let l = labels(&app);
        assert_eq!(&l[l.len() - 2..], ["New…", "Open…"]);
        assert!(!l.contains(&"Remove folder…".to_string()) && !l.iter().any(|s| s.starts_with("Signed out of")));
        assert_eq!(account_label(&app).as_deref(), Some("Signed out"));
        assert_eq!(account_labels(&app), ["Signed out of grimoire.example", "Reconnect", "Forget"]);
    }

    /// The web app's switcher as captured in headless Chromium on a scratch server running the public-folders
    /// server (`crates/app/tests/integration/parity.md`): James made "Linked"; "Parity QA" is someone else's.
    /// The Mac's items are the same, in the same order. The account row's menu: the web's is the email,
    /// Change name…, Sign out; the Mac's the same plus its own Switch account.
    #[test]
    fn matches_the_web_menu_captured_on_the_scratch_server() {
        let web_maker = ["100.73.96.98:47395", "• Linked", "Parity QA", "—", "New…", "Open…", "—", "Remove folder…"];
        let web_other = ["100.73.96.98:47395", "Linked", "• Parity QA", "—", "New…", "Open…"];
        let web_account = ["james@example.com", "Change name…", "Sign out"];
        let srv = "http://100.73.96.98:47395";
        let mut rest = FakeRest::new(srv, "James", "james@example.com");
        rest.workspaces.push(FakeWs::new("linked", "Linked", true));
        rest.workspaces.push(FakeWs::new("parity", "Parity QA", false));
        let rest = Arc::new(Mutex::new(rest));
        let mut m = Mock::new(&[("README.md", "# x\n")]);
        m.rest = Some(rest);
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(Rc::new(RefCell::new(m)));
        app.store.upsert_server(srv, None, Some(vec![Joined::new("linked", "Linked"), Joined::new("parity", "Parity QA")]));
        app.store.set_account(srv, Some("James".into()), None);
        app.store.set_details(srv, Some("james@example.com".into()), Some(true));
        let mac_only = |l: Vec<String>| l.into_iter().filter(|s| s != "Switch account").collect::<Vec<_>>();
        let mut tx = Tx::default();
        for (id, web) in [("linked", &web_maker[..]), ("parity", &web_other[..])] {
            app.open_remote(srv.into(), id.into(), String::new(), None, &mut tx);
            assert_eq!(labels(&app), web.iter().map(|s| s.to_string()).collect::<Vec<_>>());
            let acc = account_labels(&app);
            assert_eq!(&acc[acc.len() - 2..], ["Switch account", "Sign out"]);
            assert_eq!(mac_only(acc), web_account.map(String::from));
            assert_eq!(account_label(&app).as_deref(), Some("James"));
        }
    }

    /// The list's order never depends on the open folder: This Mac, servers by host, folders by name
    /// (case-insensitive, natural), ties by id; only the dot moves.
    #[test]
    fn the_order_is_the_same_whichever_folder_is_open() {
        let (mut app, _) = remote_app(true, true);
        let j = Joined::new;
        app.store.upsert_server(SERVER, Some("Grimoire"), Some(vec![j("t2", "team"), j("team", "Team"), j("n10", "Notes 10"), j("n2", "notes 2"), j("other", "Other"), j("a", "alpha")]));
        app.store.upsert_server("https://B.example", None, Some(vec![j("b1", "B one")]));
        let unmarked = |app: &App| labels(app).into_iter().map(|l| l.trim_start_matches("• ").to_string()).collect::<Vec<_>>();
        let order = unmarked(&app);
        assert_eq!(
            &order[..order.iter().position(|l| l == "—").unwrap()],
            ["This Mac", "Notes", "100.1.2.3:3000", "Lab", "b.example", "B one", "grimoire.example", "alpha", "notes 2", "Notes 10", "Other", "team", "Team"]
        );
        let mut tx = Tx::default();
        for (server, id) in [(SERVER, "other"), ("http://100.1.2.3:3000", "lab"), ("https://B.example", "b1"), (SERVER, "t2")] {
            app.open_remote(server.into(), id.into(), String::new(), None, &mut tx);
            let now = unmarked(&app);
            assert_eq!(now[..12], order[..12], "opening {id} reorders nothing");
            assert_eq!(labels(&app).iter().filter(|l| l.starts_with("• ")).count(), 1);
        }
        let dir = std::env::temp_dir().join(format!("grimoire-order-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        app.open_local(dir.clone(), &mut tx);
        let local = unmarked(&app);
        let name = crate::files::note_name(&std::fs::canonicalize(&dir).unwrap());
        assert_eq!(local[0], "This Mac");
        assert!(local[1..3].contains(&name), "{local:?}");
        assert_eq!(local[3..14], order[2..13], "the servers' part: the same");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The same names in the same order as the web's `localeCompare(…, { numeric: true, sensitivity: "base" })`
    /// with ties by id (computed in bun on the Linux box: `crates/app/tests/integration/parity.md`).
    #[test]
    fn natural_order_matches_the_web() {
        let mut rows = vec![
            ("notes 10", "a"), ("Notes 2", "b"), ("notes 1", "c"), ("Alpha", "d"), ("alpha", "c2"), ("b", "e"), ("B2", "f"), ("b10", "g"),
            ("10 things", "h"), ("2 things", "i"), ("Team", "t"), ("team", "s"), ("Zeta", "z"), ("notes 02", "j"),
        ];
        rows.sort_by(|x, y| natural_cmp(x.0, y.0).then_with(|| x.1.cmp(y.1)));
        let got: Vec<String> = rows.iter().map(|(n, i)| format!("{n}|{i}")).collect();
        let web = ["2 things|i", "10 things|h", "alpha|c2", "Alpha|d", "b|e", "B2|f", "b10|g", "notes 1|c", "Notes 2|b", "notes 02|j", "notes 10|a", "team|s", "Team|t", "Zeta|z"];
        assert_eq!(got, web);
        let mut hosts = vec!["grimoire.exe.xyz", "100.73.96.98:3000", "Grimoire.example", "b.example", "10.0.0.2:3000", "2.example"];
        hosts.sort_by(|a, b| natural_cmp(a, b).then_with(|| a.cmp(b)));
        assert_eq!(hosts, ["2.example", "10.0.0.2:3000", "100.73.96.98:3000", "b.example", "Grimoire.example", "grimoire.exe.xyz"]);
    }

    /// The switcher's keyboard highlight: Up/Down over the folder rows and enabled items (no wrap), Return
    /// chooses, Delete/Backspace on a folder row is its ×.
    #[test]
    fn the_switcher_takes_arrow_keys() {
        let (mut app, _) = remote_app(true, true);
        let mut tx = Tx::default();
        app.toggle_switcher();
        let all: Vec<String> = choosable(&app).iter().map(Item::label).collect();
        assert_eq!(all, ["Notes", "Lab", "Other", "• Team", "New…", "Open…", "Remove folder…"]);
        app.switcher_key(&rune::Key::Down, &mut tx);
        assert_eq!(app.switcher.kb, Some(0));
        app.switcher_key(&rune::Key::Up, &mut tx);
        assert_eq!(app.switcher.kb, Some(0), "no wrap");
        app.switcher_key(&rune::Key::Down, &mut tx);
        app.switcher_key(&rune::Key::Down, &mut tx);
        assert_eq!(app.switcher.kb, Some(2));
        // Delete on a folder row: its ×'s confirm
        app.switcher_key(&rune::Key::Backspace, &mut tx);
        let Some(crate::dialogs::Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!(c.title, "Remove Other from your list?");
        app.dialog = None;
        // from nothing, Up takes the last item; Return runs it
        app.toggle_switcher();
        assert_eq!(app.switcher.kb, None);
        app.switcher_key(&rune::Key::Up, &mut tx);
        assert_eq!(app.switcher.kb, Some(6));
        app.switcher_key(&rune::Key::Enter, &mut tx);
        assert!(!app.switcher.open);
        assert!(matches!(&app.dialog, Some(crate::dialogs::Dialog::Confirm(c)) if c.title == "Remove folder"));
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

    /// The × on every folder row: local folders "Remove from list" (not the open one); every joined remote
    /// folder leave (another server's too, its maker's included); none on one opened but not joined.
    #[test]
    fn every_folder_row_gets_an_x() {
        let s = |x: &str| x.to_string();
        let leave = Some(Cross::Leave);
        for mine in [true, false] {
            let (app, _) = remote_app(mine, true);
            assert_eq!(crosses(&app), vec![(s("Notes"), Some(Cross::Forget)), (s("Lab"), leave.clone()), (s("Other"), leave.clone()), (s("• Team"), leave.clone())]);
        }
        let (app, _) = remote_app(false, false);
        assert!(crosses(&app).contains(&(s("• Team"), None)));
        // a local folder: no × on the open one
        let (mut app, _) = remote_app(true, true);
        let dir = std::env::temp_dir().join(format!("grimoire-menu-x-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut tx = Tx::default();
        app.open_local(dir.clone(), &mut tx);
        let c = crosses(&app);
        assert!(c.iter().any(|(n, x)| n.starts_with("• ") && x.is_none()), "{c:?}");
        assert!(c.contains(&(s("Notes"), Some(Cross::Forget))), "{c:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn account_labels(app: &App) -> Vec<String> {
        account_items(app).iter().map(Item::label).collect()
    }

    /// The switcher has no account items; the account row (the open folder's server's account) has them.
    #[test]
    fn the_account_menu_is_out_of_the_switcher() {
        let (app, _) = remote_app(true, true);
        let l = labels(&app);
        for no in ["Change name…", "Settings", "Switch account", "Sign out"] {
            assert!(!l.contains(&no.to_string()), "{no} in the switcher: {l:?}");
        }
        assert!(!l.iter().any(|s| s.starts_with("Signed in as") || s.contains('@')), "{l:?}");
        assert_eq!(account_label(&app).as_deref(), Some("Ann"));
        assert_eq!(account_labels(&app), ["ann@example.com", "Change name…", "Switch account", "Sign out"]);
    }

    /// The account row's menu and the switcher's: one open at a time; choosing an item closes it.
    #[test]
    fn the_account_menu_opens_and_closes() {
        let (mut app, _) = remote_app(true, true);
        app.toggle_account();
        assert!(app.switcher.account_open && !app.switcher.open);
        app.toggle_switcher();
        assert!(app.switcher.open && !app.switcher.account_open);
        app.toggle_account();
        assert!(app.switcher.account_open && !app.switcher.open);
        app.toggle_account();
        assert!(!app.switcher.account_open);
        app.toggle_account();
        let mut tx = Tx::default();
        app.run_act(Act::ChangeName, &mut tx);
        assert!(!app.switcher.account_open && app.dialog.is_some());
    }

    #[test]
    fn name_sign_ins_show_no_localhost_email() {
        let (mut app, _) = remote_app(true, true);
        app.store.set_details(SERVER, Some("mac-user-1@localhost".into()), None);
        assert_eq!(account_labels(&app), ["Change name…", "Switch account", "Sign out"]);
        assert_eq!(account(&app, SERVER), ("Ann".to_string(), String::new()));
    }
}
