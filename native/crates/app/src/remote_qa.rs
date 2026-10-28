//! The workspace flows end to end against a real server (a scratch one: `tests/integration/qa-scratch.mjs`),
//! through the app's real network code (REST, the connect flow over the loopback, WebSockets), with a
//! scripted browser standing in for Safari (cookies, name and Google sign-in on the server's pages, the
//! fake Google's account chooser, "Not you?").
//!
//! `GRIMOIRE_QA_SERVER=http://<host>:<port> GRIMOIRE_QA_GOOGLE_HOST=<host> cargo test --release -p grimoire
//! qa_flows_against_a_server -- --ignored --nocapture`; each step prints `QA PASS <name>` (a failure
//! panics with what it saw).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rune::Tx;
use serde_json::Value;

use crate::App;
use crate::net;
use crate::remote::{Backend, Fix, Handle, Problem, Update};
use crate::switcher::ServerIssue;
use crate::workspaces::{Store, Tokens, WsRef};

/// A browser: a cookie jar, and the host the fake Google's `127.0.0.1` stands for.
#[derive(Default)]
struct Browser {
    cookies: HashMap<String, String>,
    google_host: String,
    /// The server's public origin (the Origin of its forms, whatever address the page came from).
    origin: String,
}

type Page = (u16, Vec<(String, String)>, String);

impl Browser {
    fn cookie_header(&self) -> String {
        self.cookies.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")
    }

    fn keep(&mut self, h: &[(String, String)]) {
        for (k, v) in h {
            if k == "set-cookie"
                && let Some((name, rest)) = v.split(';').next().and_then(|c| c.split_once('='))
            {
                if rest.is_empty() || v.contains("Max-Age=0") {
                    self.cookies.remove(name);
                } else {
                    self.cookies.insert(name.to_string(), rest.to_string());
                }
            }
        }
    }

    fn fix(&self, url: &str) -> String {
        url.replace("http://127.0.0.1:", &format!("http://{}:", self.google_host))
    }

    fn get(&mut self, url: &str) -> Page {
        let url = url.to_string();
        let c = self.cookie_header();
        let (st, h, b) = net::raw("GET", &url, &[("Cookie", &c)], None).unwrap_or_else(|e| panic!("GET {url}: {e}"));
        self.keep(&h);
        (st, h, String::from_utf8_lossy(&b).into_owned())
    }

    fn post(&mut self, url: &str, form: &[(&str, &str)]) -> Page {
        let url = url.to_string();
        let body = form.iter().map(|(k, v)| format!("{}={}", net::enc(k), net::enc(v))).collect::<Vec<_>>().join("&");
        let c = self.cookie_header();
        let o = self.origin.clone();
        let (st, h, b) = net::raw("POST", &url, &[("Cookie", &c), ("Origin", &o), ("Content-Type", "application/x-www-form-urlencoded")], Some(body.as_bytes()))
            .unwrap_or_else(|e| panic!("POST {url}: {e}"));
        self.keep(&h);
        (st, h, String::from_utf8_lossy(&b).into_owned())
    }

    fn json(&mut self, method: &str, url: &str, body: Option<&Value>) -> (u16, Value) {
        let c = self.cookie_header();
        let o = self.origin.clone();
        let b = body.map(|b| b.to_string());
        let mut h = vec![("Cookie", c.as_str()), ("Origin", o.as_str()), ("Accept", "application/json")];
        if b.is_some() {
            h.push(("Content-Type", "application/json"));
        }
        let (st, _, r) = net::raw(method, url, &h, b.as_deref().map(str::as_bytes)).unwrap_or_else(|e| panic!("{method} {url}: {e}"));
        (st, serde_json::from_slice(&r).unwrap_or(Value::Null))
    }
}

fn location(p: &Page, base: &str) -> String {
    let l = p.1.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone()).unwrap_or_else(|| panic!("no redirect: {} {}", p.0, p.2));
    if l.starts_with('/') { format!("{base}{l}") } else { l }
}

/// What the browser does with the next connect page the app opens.
#[derive(Clone, Debug)]
enum Plan {
    /// Sign in with a name (a new account), then allow.
    Name(String),
    /// Already signed in as this account: allow.
    Approve(String),
    /// Signed in as the first account: "Not you? Sign in as someone else", then Google (email, name), allow.
    NotYouGoogle(String, String, String),
}

static PLANS: Mutex<Vec<Plan>> = Mutex::new(Vec::new());
static BROWSER: Mutex<Option<Browser>> = Mutex::new(None);
static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn seen(s: String) {
    eprintln!("qa: browser: {s}");
    SEEN.lock().unwrap().push(s);
}

/// The app's `opener`: the connect page, in the scripted browser (on a thread: the app is listening).
fn qa_browser(url: &str) -> Result<(), String> {
    let plan = PLANS.lock().unwrap().pop().ok_or("no browser plan")?;
    let url = url.to_string();
    std::thread::spawn(move || {
        let mut guard = BROWSER.lock().unwrap();
        let b = guard.as_mut().unwrap();
        let base = net::parse_url(&url).unwrap().origin();
        let path = net::parse_url(&url).unwrap().path;
        let q = |k: &str| net::query_param(&path, k).unwrap_or_default();
        let fields = |d: &'static str| vec![("client", q("client")), ("redirect", q("redirect")), ("state", q("state")), ("decision", d.to_string())];
        let allow = |b: &mut Browser, who: &str| {
            let page = b.get(&url);
            assert!(page.2.contains(&format!("as <b class=\"who\">{who}</b>?")), "approval page as {who}: {}", page.2);
            seen(format!("approval page names {who}"));
            let f = fields("allow");
            let f: Vec<(&str, &str)> = f.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let r = b.post(&format!("{base}/connect"), &f);
            let loc = location(&r, &base);
            let lp = net::parse_url(&loc).unwrap().path;
            assert!(loc.starts_with("http://127.0.0.1:") && net::query_param(&lp, "account").as_deref() == Some(who), "{loc}");
            seen(format!("redirect back with the account ({who})"));
            let _ = net::raw("GET", &loc, &[], None);
        };
        match plan {
            Plan::Name(name) => {
                let signed_out = b.get(&url);
                assert!(signed_out.2.contains("Sign in with a name") && signed_out.2.contains("new account"), "{}", signed_out.2);
                seen("signed-out connect page: sign-in options, the name sign-in says it makes a new account".into());
                let r = b.post(&format!("{base}/auth/dev"), &[("name", &name), ("next", &path)]);
                assert_eq!(location(&r, &base), url, "back to the connect page");
                allow(b, &name);
            }
            Plan::Approve(who) => allow(b, &who),
            Plan::NotYouGoogle(current, email, name) => {
                let page = b.get(&url);
                assert!(page.2.contains(&format!("as <b class=\"who\">{current}</b>?")) && page.2.contains("Not you?"), "{}", page.2);
                seen(format!("approval page names {current}, offers Not you?"));
                let f = fields("switch");
                let f: Vec<(&str, &str)> = f.iter().map(|(k, v)| (*k, v.as_str())).collect();
                let r = b.post(&format!("{base}/connect"), &f);
                let back = location(&r, &base);
                let out = b.get(&back);
                assert!(out.2.contains("Continue with Google"), "signed out after Not you?: {}", out.2);
                seen("Not you? signed the browser out: sign-in options shown".into());
                let g = out.2.split("href=\"").find(|s| s.starts_with("/auth/google")).and_then(|s| s.split('"').next()).unwrap().replace("&amp;", "&");
                let r = b.get(&format!("{base}{g}"));
                let chooser = location(&r, &base);
                let cq = net::parse_url(&chooser).unwrap().path;
                let p = |k: &str| net::query_param(&cq, k).unwrap_or_default();
                let gbase = net::parse_url(&b.fix(&chooser)).unwrap().origin();
                let (ru, st, no, ci) = (p("redirect_uri"), p("state"), p("nonce"), p("client_id"));
                let r = b.post(
                    &format!("{gbase}/choose"),
                    &[("email", &email), ("name", &name), ("redirect_uri", &ru), ("state", &st), ("nonce", &no), ("client_id", &ci)],
                );
                let cb = location(&r, &gbase);
                let r = b.get(&cb);
                assert_eq!(r.0, 303, "google callback: {}", r.2);
                seen(format!("signed in with Google as {email}"));
                allow(b, &name);
            }
        }
    });
    Ok(())
}

/// A TCP proxy in front of the server that can go down (refusing and cutting connections) and come back.
struct Proxy {
    url: String,
    up: Arc<AtomicBool>,
    conns: Arc<Mutex<Vec<TcpStream>>>,
}

impl Proxy {
    fn start(target: &str) -> Proxy {
        let t = net::parse_url(target).unwrap();
        let (l, port): (TcpListener, u16) = net::loopback().unwrap();
        let up = Arc::new(AtomicBool::new(true));
        let conns: Arc<Mutex<Vec<TcpStream>>> = Arc::default();
        let (up2, conns2) = (up.clone(), conns.clone());
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(c) = c else { continue };
                if !up2.load(Ordering::SeqCst) {
                    let _ = c.shutdown(Shutdown::Both);
                    continue;
                }
                let Ok(s) = TcpStream::connect((t.host.as_str(), t.port)) else { continue };
                conns2.lock().unwrap().extend([c.try_clone().unwrap(), s.try_clone().unwrap()]);
                for (mut a, mut b) in [(c.try_clone().unwrap(), s.try_clone().unwrap()), (s, c)] {
                    std::thread::spawn(move || {
                        let mut buf = [0u8; 16384];
                        while let Ok(n) = a.read(&mut buf) {
                            if n == 0 || b.write_all(&buf[..n]).is_err() {
                                break;
                            }
                        }
                        let _ = b.shutdown(Shutdown::Write);
                    });
                }
            }
        });
        Proxy { url: format!("http://127.0.0.1:{port}"), up, conns }
    }

    fn set_up(&self, up: bool) {
        self.up.store(up, Ordering::SeqCst);
        if !up {
            for c in self.conns.lock().unwrap().drain(..) {
                let _ = c.shutdown(Shutdown::Both);
            }
        }
    }
}

struct Run {
    app: App,
    tx: Tx,
    q: Arc<Mutex<Vec<Update>>>,
}

impl Run {
    fn drain(&mut self) {
        let fs: Vec<Update> = std::mem::take(&mut *self.q.lock().unwrap());
        for f in fs {
            f(&mut self.app, &mut self.tx);
        }
    }

    fn wait(&mut self, what: &str, secs: u64, ok: impl Fn(&App) -> bool) {
        let t = Instant::now();
        while !ok(&self.app) {
            assert!(
                t.elapsed().as_secs() < secs,
                "timed out: {what} (status {:?}, problem {:?}, text {:?})",
                self.app.remote_status(),
                self.app.remote.as_ref().map(|r| r.problem.clone()),
                self.app.ed.text().chars().take(60).collect::<String>()
            );
            self.drain();
            std::thread::sleep(Duration::from_millis(20));
        }
        eprintln!("qa: {what} ({} ms)", t.elapsed().as_millis());
    }

    fn settled(&mut self) -> bool {
        self.app.remote.as_ref().is_some_and(|r| !r.loading && (r.loaded || r.problem.is_some()))
    }

    fn open(&mut self, server: &str, id: &str) {
        self.app.open_remote(server.into(), id.into(), String::new(), None, &mut self.tx);
        self.wait(&format!("{id} settled"), 60, |a| a.remote.as_ref().is_some_and(|r| !r.loading && (r.loaded || r.problem.is_some())));
    }

    fn synced(&mut self, what: &str) {
        self.wait(what, 30, |a| a.remote.as_ref().is_some_and(|r| r.synced && r.note.is_some()));
    }
}

fn pass(name: &str, evidence: String) {
    println!("QA PASS {name}: {evidence}");
}

#[test]
#[ignore]
fn qa_flows_against_a_server() {
    let Ok(server) = std::env::var("GRIMOIRE_QA_SERVER") else { return };
    let ghost = std::env::var("GRIMOIRE_QA_GOOGLE_HOST").unwrap_or_else(|_| net::parse_url(&server).unwrap().host);
    let dir = std::env::temp_dir().join(format!("grimoire-qa-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    *BROWSER.lock().unwrap() = Some(Browser { google_host: ghost.clone(), origin: server.clone(), ..Browser::default() });

    // The owner (James, Google) and their workspaces, through the web API.
    let mut owner = Browser { google_host: ghost.clone(), origin: server.clone(), ..Browser::default() };
    {
        let r = owner.get(&format!("{server}/auth/google?next=/app"));
        let chooser = location(&r, &server);
        let cq = net::parse_url(&chooser).unwrap().path;
        let p = |k: &str| net::query_param(&cq, k).unwrap_or_default();
        let gbase = net::parse_url(&owner.fix(&chooser)).unwrap().origin();
        let (ru, st, no, ci) = (p("redirect_uri"), p("state"), p("nonce"), p("client_id"));
        let r = owner.post(&format!("{gbase}/choose"), &[("email", "james@example.com"), ("name", "James"), ("redirect_uri", &ru), ("state", &st), ("nonce", &no), ("client_id", &ci)]);
        let cb = location(&r, &gbase);
        owner.get(&cb);
    }
    let (st, me) = owner.json("GET", &format!("{server}/api/me"), None);
    assert_eq!((st, me["name"].as_str()), (200, Some("James")));
    let mk = |o: &mut Browser, title: &str, link: &str| -> String {
        let (st, w) = o.json("POST", &format!("{server}/api/workspaces"), Some(&serde_json::json!({ "title": title, "linkAccess": link })));
        assert_eq!(st, 201, "{w}");
        w["id"].as_str().unwrap().to_string()
    };
    let (st, w) = owner.json("POST", &format!("{server}/api/workspaces"), Some(&serde_json::json!({ "title": "dffddf" })));
    assert_eq!((st, w["linkAccess"].as_str()), (201, Some("none")), "private by default");
    let private = w["id"].as_str().unwrap().to_string();
    assert!(private.starts_with("dffddf-") && private.len() == "dffddf-".len() + 4, "{private}");
    let viewable = mk(&mut owner, "Viewable", "view");
    let editable = mk(&mut owner, "Editable", "edit");
    pass("setup", format!("owner James (Google); private {private}, view {viewable}, edit {editable}"));

    let q: Arc<Mutex<Vec<Update>>> = Arc::default();
    let mut app = App::new("", None, true);
    app.backend = Backend::Net(Handle::Queue(q.clone()));
    app.tokens = Tokens::File(dir.join("tokens.json"));
    app.store = Store::load(Some(dir.clone()));
    app.opener = qa_browser;
    let mut r = Run { app, tx: Tx::default(), q };
    let host = net::parse_url(&server).unwrap().display_host();

    // 1. The owner's case: the browser signs in as someone else (a new name account); the private workspace
    //    is refused with a clear page instead of an endless Loading…
    PLANS.lock().unwrap().push(Plan::Name("Confused Noodle".into()));
    r.open(&server, &private);
    let (title, detail, fixes) = r.app.problem_page().expect("a problem page");
    assert_eq!(r.app.remote.as_ref().unwrap().problem, Some(Problem::NoAccess));
    assert!(detail.contains(&format!("as Confused Noodle on {host}")), "{detail}");
    assert_eq!(fixes, vec![Fix::SwitchAccount, Fix::Remove]);
    assert_eq!(r.app.store.server(&server).and_then(|s| s.account.clone()).as_deref(), Some("Confused Noodle"));
    let saved = std::fs::read_to_string(dir.join("workspaces.json")).unwrap();
    assert!(!saved.contains(r#""title": """#), "no empty title saved: {saved}");
    pass("mac: private workspace, other account → clear error", format!("{title} / {detail} / {fixes:?}"));
    let noodle_token = r.app.tokens.get(&server).unwrap();

    // 2. A link-access (view) workspace loads, read-only
    r.open(&server, &viewable);
    assert!(r.app.remote.as_ref().unwrap().loaded && r.app.remote.as_ref().unwrap().read_only);
    r.synced("viewable note synced");
    let before = r.app.ed.text().to_string();
    r.app.ed.insert_text("x");
    r.app.handled(&mut r.tx);
    assert_eq!(r.app.ed.text(), before, "a viewer can't type");
    assert_eq!(r.app.remote_status().as_deref(), Some("Read only · Saved"));
    pass("mac: link-access view workspace loads read-only", format!("status {:?}, text {before:?}", r.app.remote_status()));

    // 3. An edit-link workspace loads and takes edits that reach the server
    r.open(&server, &editable);
    r.synced("editable note synced");
    let end = r.app.ed.text().len();
    r.app.ed.set_selection(editor_core::Sel::caret(end));
    r.app.ed.insert_text("Mac edit as a link editor\n");
    r.app.handled(&mut r.tx);
    let t = Instant::now();
    loop {
        r.drain();
        let (_, f) = owner.json("GET", &format!("{server}/api/repos/{editable}/file?path=README.md"), None);
        if f["content"].as_str().is_some_and(|c| c.contains("Mac edit as a link editor")) {
            break;
        }
        assert!(t.elapsed().as_secs() < 30, "the edit never reached the server: {f}");
        std::thread::sleep(Duration::from_millis(200));
    }
    pass("mac: link-access edit workspace takes edits", "owner reads the Mac's line from the server".into());

    // 4. The joined list: the link workspaces opened, not the private one
    r.app.toggle_switcher();
    r.wait("joined list", 20, |a| a.store.server(&server).is_some_and(|s| s.joined.iter().any(|j| j.id == editable) && s.joined.iter().any(|j| j.id == viewable)));
    let joined: Vec<String> = r.app.store.server(&server).unwrap().joined.iter().map(|j| format!("{} {} {}", j.id, j.title, j.role)).collect();
    assert!(!joined.iter().any(|j| j.starts_with(&private)), "{joined:?}");
    r.app.close_switcher();
    pass("mac: joined list per server (joined only)", format!("{joined:?}, as {:?}", r.app.store.server(&server).unwrap().account));

    // 5. Back to the private one: Switch account ("Not you?" → Google as James) → it loads
    let w = r.app.store.recent.iter().find(|(w, _)| matches!(w, WsRef::Remote { id, .. } if *id == private)).unwrap().0.clone();
    r.app.choose(w, &mut r.tx);
    r.wait("private refused again", 30, |a| a.remote.as_ref().is_some_and(|r| r.problem == Some(Problem::NoAccess)));
    PLANS.lock().unwrap().push(Plan::NotYouGoogle("Confused Noodle".into(), "james@example.com".into(), "James".into()));
    r.app.apply_fix(Fix::SwitchAccount, &mut r.tx);
    r.wait("loaded as James", 60, |a| a.remote.as_ref().is_some_and(|r| r.loaded && r.problem.is_none()));
    r.synced("private note synced");
    assert_eq!(r.app.current.as_ref().unwrap().name(), "dffddf");
    assert_eq!(r.app.store.recent[0].0.name(), "dffddf", "the recent entry has the server's title");
    assert_eq!(r.app.store.server(&server).and_then(|s| s.account.clone()).as_deref(), Some("James"));
    let t = Instant::now();
    while net::request("GET", &format!("{server}/api/me"), Some(&noodle_token), None).unwrap().status != 401 {
        assert!(t.elapsed().as_secs() < 10, "the old token wasn't revoked");
        std::thread::sleep(Duration::from_millis(100));
    }
    pass("mac: switch account → private workspace loads", format!("title {:?}, account James, old token 401", r.app.current.as_ref().unwrap().name()));

    // 6. Notes on the server: create, rename, delete
    r.app.new_note(&mut r.tx);
    r.wait("new note open", 30, |a| a.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some("Untitled.md") && r.synced));
    r.app.ed.insert_text("# From the Mac");
    r.app.handled(&mut r.tx);
    r.app.remote_rename("Untitled.md".into(), "From Mac".into(), &mut r.tx);
    r.wait("renamed", 30, |a| a.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some("From Mac.md") && r.synced));
    let (_, tree) = owner.json("GET", &format!("{server}/api/repos/{private}/tree"), None);
    assert!(tree["files"].as_array().unwrap().iter().any(|f| f == "From Mac.md"), "{tree}");
    r.app.remote_delete("From Mac.md".into(), &mut r.tx);
    r.wait("deleted", 30, |a| a.remote.as_ref().is_some_and(|r| !r.tree_list.iter().any(|p| p == "From Mac.md")));
    let (_, tree) = owner.json("GET", &format!("{server}/api/repos/{private}/tree"), None);
    assert!(!tree["files"].as_array().unwrap().iter().any(|f| f == "From Mac.md"), "{tree}");
    pass("mac: create/rename/delete a note remotely", format!("server tree after: {}", tree["files"]));

    // 7. The token revoked from the web: the app says so and offers Reconnect, which works
    let (_, toks) = owner.json("GET", &format!("{server}/api/tokens"), None);
    let tid = r.app.store.server(&server).and_then(|s| s.token_id.clone()).expect("token id from the redirect");
    assert!(toks.as_array().unwrap().iter().any(|t| t["id"] == tid.as_str() && t["label"] == "Grimoire for Mac"), "{toks}");
    let (st, _) = owner.json("DELETE", &format!("{server}/api/tokens/{tid}"), None);
    assert_eq!(st, 200);
    r.wait("signed out shown", 20, |a| a.remote.as_ref().is_some_and(|r| r.problem == Some(Problem::SignedOut)));
    let (title, _, fixes) = r.app.problem_page().unwrap();
    assert_eq!(fixes[0], Fix::Reconnect);
    assert!(r.app.switcher.server_issues.iter().any(|(u, i)| *u == server && *i == ServerIssue::SignedOut));
    PLANS.lock().unwrap().push(Plan::Approve("James".into()));
    r.app.apply_fix(Fix::Reconnect, &mut r.tx);
    r.wait("reconnected", 60, |a| a.remote.as_ref().is_some_and(|r| r.loaded && r.problem.is_none()));
    pass("mac: token revoked on the web → Reconnect", format!("{title:?} → {fixes:?} → loaded again"));

    // 8. Server down: offline status, backoff, recovery (through a proxy that goes down)
    let proxy = Proxy::start(&server);
    PLANS.lock().unwrap().push(Plan::Approve("James".into()));
    r.open(&proxy.url, &editable);
    r.synced("via proxy synced");
    proxy.set_up(false);
    r.wait("offline shown", 30, |a| a.remote_status().is_some_and(|s| s.starts_with("Offline")));
    let offline = r.app.remote_status();
    proxy.set_up(true);
    r.wait("back online", 60, |a| a.remote.as_ref().is_some_and(|r| r.synced) && a.remote_status().as_deref() == Some("Saved"));
    proxy.set_up(false);
    r.app.open_remote(proxy.url.clone(), viewable.clone(), String::new(), None, &mut r.tx);
    r.wait("open while down: offline page, retrying", 60, |a| matches!(a.remote.as_ref().and_then(|r| r.problem.clone()), Some(Problem::Offline { attempt: 3.., .. })));
    let (title, detail, _) = r.app.problem_page().unwrap();
    proxy.set_up(true);
    r.wait("loads by itself when the server is back", 60, |a| a.remote.as_ref().is_some_and(|r| r.loaded && r.problem.is_none()));
    pass("mac: server down → offline → recovers", format!("{offline:?}; opening while down: {title} / {detail}; recovered"));

    // 9. Local ↔ remote
    let local = dir.join("local");
    std::fs::create_dir_all(&local).unwrap();
    crate::doc::write(&local.join("Local.md"), "local text").unwrap();
    r.app.open_local(local.clone(), &mut r.tx);
    assert!(r.app.remote.is_none() && r.app.ed.text() == "local text");
    let w = r.app.store.recent.iter().find(|(w, _)| matches!(w, WsRef::Remote { id, server: s, .. } if *id == private && *s == server)).unwrap().0.clone();
    r.app.choose(w, &mut r.tx);
    r.wait("back to remote", 30, |a| a.remote.as_ref().is_some_and(|r| r.loaded && r.synced));
    pass("mac: switch local ↔ remote", format!("local {:?}, remote {:?}", "local text", r.app.current.as_ref().unwrap().name()));

    // 10. A workspace deleted while open
    let doomed = mk(&mut owner, "Doomed", "none");
    r.open(&server, &doomed);
    r.synced("doomed open");
    let (st, _) = owner.json("DELETE", &format!("{server}/api/repos/{doomed}"), None);
    assert_eq!(st, 200);
    r.wait("gone shown", 30, |a| a.remote.as_ref().is_some_and(|r| r.problem == Some(Problem::Gone)));
    pass("mac: workspace deleted while open", r.app.problem_page().unwrap().0);
    r.app.apply_fix(Fix::Remove, &mut r.tx);
    assert!(!r.app.store.recent.iter().any(|(w, _)| matches!(w, WsRef::Remote { id, .. } if *id == doomed)));
    pass("mac: remove from recents", format!("now showing {:?}", r.app.current.as_ref().map(|c| c.name())));

    // 11. Not a Grimoire server
    let g = BROWSER.lock().unwrap().as_ref().map(|b| b.google_host.clone()).unwrap();
    let not = std::env::var("GRIMOIRE_QA_NOT_GRIMOIRE").unwrap_or_else(|_| format!("http://{g}:9"));
    r.open(&not, "x");
    let p = r.app.remote.as_ref().unwrap().problem.clone();
    assert!(matches!(p, Some(Problem::NotGrimoire | Problem::Offline { .. } | Problem::Failed(_))), "{p:?}");
    pass("mac: not a Grimoire server", format!("{not}: {:?} / {:?}", p, r.app.problem_page().map(|x| x.0)));

    // 12. Recents survive a restart, with titles
    let reloaded = Store::load(Some(dir.clone()));
    let names: Vec<String> = reloaded.recent.iter().map(|(w, _)| format!("{} @ {}", w.name(), w.location())).collect();
    for want in ["dffddf", "Editable", "Viewable"] {
        assert!(names.iter().any(|n| n.starts_with(want)), "{want} in {names:?}");
    }
    assert!(!reloaded.recent.iter().any(|(w, _)| matches!(w, WsRef::Remote { title, .. } if title.is_empty())));
    pass("mac: recents survive restart with titles", format!("{names:?}"));

    // 13. Disconnect: the token is revoked on the server and forgotten here
    let token = r.app.tokens.get(&server).unwrap();
    let w = reloaded.recent.iter().find(|(w, _)| matches!(w, WsRef::Remote { id, server: s, .. } if *id == private && *s == server)).unwrap().0.clone();
    r.app.choose(w, &mut r.tx);
    r.wait("private open", 30, |a| a.remote.as_ref().is_some_and(|r| r.loaded));
    r.app.disconnect(&server, &mut r.tx);
    assert!(r.app.tokens.get(&server).is_none() && r.app.store.server(&server).is_none());
    assert_eq!(r.app.remote.as_ref().unwrap().problem, Some(Problem::SignedOut));
    let t = Instant::now();
    while net::request("GET", &format!("{server}/api/me"), Some(&token), None).unwrap().status != 401 {
        r.drain();
        assert!(t.elapsed().as_secs() < 10, "disconnect didn't revoke the token");
        std::thread::sleep(Duration::from_millis(100));
    }
    pass("mac: disconnect revokes the token", format!("toast {:?}; token 401", r.app.toast));

    for s in SEEN.lock().unwrap().iter() {
        println!("QA BROWSER {s}");
    }
    r.app.close_room();
    r.drain();
    let _ = r.settled();
    let _ = std::fs::remove_dir_all(&dir);
}
