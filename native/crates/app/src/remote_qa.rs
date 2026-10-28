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

    /// "Sign in" (the account row of a folder open as a guest): the connect flow, then the folder again as
    /// the account.
    fn sign_in(&mut self) {
        self.app.toggle_account();
        self.wait("signed in", 60, |a| a.remote.as_ref().is_some_and(|r| r.loaded && r.problem.is_none() && !App::is_guest_in(r)));
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
    let mk = |o: &mut Browser, title: &str| -> String {
        let (st, w) = o.json("POST", &format!("{server}/api/workspaces"), Some(&serde_json::json!({ "title": title })));
        assert_eq!(st, 201, "{w}");
        w["id"].as_str().unwrap().to_string()
    };
    let notes = mk(&mut owner, "dffddf");
    assert!(notes.starts_with("dffddf-") && notes.len() == "dffddf-".len() + 4, "{notes}");
    let editable = mk(&mut owner, "Editable");
    pass("setup", format!("James (Google) made {notes} and {editable}"));

    let q: Arc<Mutex<Vec<Update>>> = Arc::default();
    let mut app = App::new("", None, true);
    app.backend = Backend::Net(Handle::Queue(q.clone()));
    app.tokens = Tokens::File(dir.join("tokens.json"));
    app.store = Store::load(Some(dir.clone()));
    app.store.ensure_guest();
    app.opener = qa_browser;
    let mut r = Run { app, tx: Tx::default(), q };

    // 0. Every folder is public: with no account the Mac opens James's folder as a guest — no browser, no
    //    sign-in — and edits it; the commit is the guest's
    assert!(PLANS.lock().unwrap().is_empty());
    r.open(&server, &notes);
    assert!(r.app.switcher.busy.is_none() && r.app.tokens.get(&server).is_none(), "no connect flow");
    assert!(r.app.is_guest() && r.app.remote.as_ref().unwrap().loaded && !r.app.remote.as_ref().unwrap().read_only);
    assert_eq!(crate::menu::account_label(&r.app).as_deref(), Some("Sign in"));
    assert!(!r.app.agent_card_shown());
    let guest = r.app.store.guest.clone().unwrap();
    r.synced("note synced as a guest");
    let end = r.app.ed.text().len();
    r.app.ed.set_selection(editor_core::Sel::caret(end));
    r.app.ed.insert_text("Guest edit from the Mac\n");
    r.app.handled(&mut r.tx);
    let t = Instant::now();
    loop {
        r.drain();
        let (_, h) = owner.json("GET", &format!("{server}/api/repos/{notes}/history?path=README.md"), None);
        let (_, f) = owner.json("GET", &format!("{server}/api/repos/{notes}/file?path=README.md"), None);
        if f["content"].as_str().is_some_and(|c| c.contains("Guest edit from the Mac")) && h.to_string().contains(&format!("{} (guest)", guest.name)) {
            break;
        }
        assert!(t.elapsed().as_secs() < 30, "the guest's edit never reached the server's history: {h}");
        std::thread::sleep(Duration::from_millis(200));
    }
    pass("mac: a guest opens and edits a public folder (no browser)", format!("committed as \"{} (guest)\"", guest.name));
    // the room's line authors: James's README line and ours
    r.wait("line authors", 20, |a| a.remote.as_ref().and_then(|r| r.authors.as_ref()).is_some_and(|la| la.authors.iter().any(|x| x.name == guest.name)));
    let la = r.app.remote.as_ref().unwrap().authors.clone().unwrap();
    let names: Vec<String> = la.authors.iter().map(|a| format!("{} ({})", a.name, a.kind)).collect();
    // the event stream: the server's presence says we're in README.md
    r.wait("presence from the event stream", 20, |a| {
        a.presence.iter().any(|((repo, path), ppl)| *repo == notes && path == "README.md" && ppl.iter().any(|p| p.name == guest.name))
    });
    pass("mac: presence from the event stream", format!("{:?}", r.app.presence.keys().collect::<Vec<_>>()));
    pass("mac: line authors from the room", format!("authors {names:?}, lines {:?}", la.values));

    // 1. Signing in is optional, from the account row's "Sign in": another account (a new name account in
    //    the browser) then edits James's folder as itself, and its edits reach the server
    PLANS.lock().unwrap().push(Plan::Name("Confused Noodle".into()));
    r.sign_in();
    assert!(r.app.remote.as_ref().unwrap().loaded && !r.app.remote.as_ref().unwrap().read_only);
    assert_eq!(r.app.store.server(&server).and_then(|s| s.account.clone()).as_deref(), Some("Confused Noodle"));
    r.synced("note synced");
    let end = r.app.ed.text().len();
    r.app.ed.set_selection(editor_core::Sel::caret(end));
    r.app.ed.insert_text("Mac edit in someone else's folder\n");
    r.app.handled(&mut r.tx);
    let t = Instant::now();
    loop {
        r.drain();
        let (_, f) = owner.json("GET", &format!("{server}/api/repos/{notes}/file?path=README.md"), None);
        if f["content"].as_str().is_some_and(|c| c.contains("Mac edit in someone else's folder")) {
            break;
        }
        assert!(t.elapsed().as_secs() < 30, "the edit never reached the server: {f}");
        std::thread::sleep(Duration::from_millis(200));
    }
    let saved = std::fs::read_to_string(dir.join("workspaces.json")).unwrap();
    assert!(!saved.contains(r#""title": """#), "no empty title saved: {saved}");
    pass("mac: another account's folder opens and takes edits", "James reads the Mac's line from the server".into());
    let noodle_token = r.app.tokens.get(&server).unwrap();

    // 2. A folder that doesn't exist: "No such workspace", not an endless Loading…
    r.open(&server, "no-such-folder-x1");
    let (title, detail, fixes) = r.app.problem_page().expect("a problem page");
    assert_eq!(r.app.remote.as_ref().unwrap().problem, Some(Problem::Missing));
    assert_eq!(title, "No such workspace");
    assert_eq!(fixes, vec![Fix::MyWorkspaces, Fix::Remove]);
    r.app.apply_fix(Fix::Remove, &mut r.tx);
    pass("mac: a missing folder says so", format!("{title} / {detail}"));

    // 3. The joined list: the folders opened
    r.open(&server, &editable);
    r.synced("editable synced");
    r.app.toggle_switcher();
    r.wait("joined list", 20, |a| a.store.server(&server).is_some_and(|s| s.joined.iter().any(|j| j.id == editable) && s.joined.iter().any(|j| j.id == notes)));
    let joined: Vec<String> = r.app.store.server(&server).unwrap().joined.iter().map(|j| format!("{} {}", j.id, j.title)).collect();
    r.app.close_switcher();
    pass("mac: joined list per server", format!("{joined:?}, as {:?}", r.app.store.server(&server).unwrap().account));

    // 4. Switch account (the account menu; "Not you?" → Google as James): the folder reloads as James
    let w = r.app.store.recent.iter().find(|(w, _)| matches!(w, WsRef::Remote { id, .. } if *id == notes)).unwrap().0.clone();
    r.app.choose(w, &mut r.tx);
    r.wait("dffddf open", 30, |a| a.remote.as_ref().is_some_and(|r| r.loaded));
    PLANS.lock().unwrap().push(Plan::NotYouGoogle("Confused Noodle".into(), "james@example.com".into(), "James".into()));
    r.app.run_act(crate::menu::Act::SwitchAccount, &mut r.tx);
    r.wait("loaded as James", 60, |a| a.store.server(&server).and_then(|s| s.account.clone()).as_deref() == Some("James") && a.remote.as_ref().is_some_and(|r| r.loaded && r.problem.is_none()));
    r.synced("dffddf synced as James");
    assert_eq!(r.app.current.as_ref().unwrap().name(), "dffddf");
    assert_eq!(r.app.store.recent[0].0.name(), "dffddf", "the recent entry has the server's title");
    let t = Instant::now();
    while net::request("GET", &format!("{server}/api/me"), Some(&noodle_token), None).unwrap().status != 401 {
        assert!(t.elapsed().as_secs() < 10, "the old token wasn't revoked");
        std::thread::sleep(Duration::from_millis(100));
    }
    pass("mac: switch account", format!("title {:?}, account James, old token 401", r.app.current.as_ref().unwrap().name()));

    // 6. Notes on the server: create, rename, delete
    r.app.new_note(&mut r.tx);
    r.wait("new note open", 30, |a| a.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some("Untitled.md") && r.synced));
    r.app.ed.insert_text("# From the Mac");
    r.app.handled(&mut r.tx);
    r.app.remote_rename("Untitled.md".into(), "From Mac".into(), &mut r.tx);
    r.wait("renamed", 30, |a| a.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some("From Mac.md") && r.synced));
    let (_, tree) = owner.json("GET", &format!("{server}/api/repos/{notes}/tree"), None);
    assert!(tree["files"].as_array().unwrap().iter().any(|f| f == "From Mac.md"), "{tree}");
    r.app.remote_delete("From Mac.md".into(), &mut r.tx);
    r.wait("deleted", 30, |a| a.remote.as_ref().is_some_and(|r| !r.tree_list.iter().any(|p| p == "From Mac.md")));
    let (_, tree) = owner.json("GET", &format!("{server}/api/repos/{notes}/tree"), None);
    assert!(!tree["files"].as_array().unwrap().iter().any(|f| f == "From Mac.md"), "{tree}");
    pass("mac: create/rename/delete a note remotely", format!("server tree after: {}", tree["files"]));

    // 6b. Folders: New Folder, rename the folder (one commit, the open note follows), delete it (one commit)
    r.app.tree_cur = None;
    r.app.path = None;
    r.app.new_folder(&mut r.tx);
    r.wait("new folder", 30, |a| a.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some("New folder/Untitled.md") && r.synced));
    assert_eq!(r.app.renaming.as_ref().map(|x| x.0.as_str()), Some("New folder"));
    r.app.renaming.as_mut().unwrap().1.text = "Mac folder".into();
    r.app.submit_rename(&mut r.tx);
    r.wait("folder renamed", 30, |a| a.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some("Mac folder/Untitled.md") && r.synced));
    let (_, tree) = owner.json("GET", &format!("{server}/api/repos/{notes}/tree"), None);
    let files = tree["files"].as_array().unwrap();
    assert!(files.iter().any(|f| f == "Mac folder/Untitled.md") && !files.iter().any(|f| f.as_str().unwrap().starts_with("New folder/")), "{tree}");
    r.app.delete_path("Mac folder", true, &mut r.tx);
    r.wait("folder deleted", 30, |a| a.remote.as_ref().is_some_and(|r| !r.tree_list.iter().any(|p| p.starts_with("Mac folder/"))));
    let (_, tree) = owner.json("GET", &format!("{server}/api/repos/{notes}/tree"), None);
    assert!(!tree["files"].as_array().unwrap().iter().any(|f| f.as_str().unwrap().starts_with("Mac folder/")), "{tree}");
    pass("mac: new folder, rename and delete a folder remotely", format!("server tree after: {}", tree["files"]));

    // 7. The token revoked from the web: the app says so and offers Reconnect, which works
    let tid = r.app.store.server(&server).and_then(|s| s.token_id.clone()).expect("token id from the redirect");
    let (st, _) = owner.json("DELETE", &format!("{server}/api/tokens/{tid}"), None);
    assert_eq!(st, 200);
    // the window coming to the front asks `/api/me` (folders stay readable with a bad token, so only it says)
    r.app.tokens_checked = None;
    r.app.check_tokens();
    r.wait("signed out to a guest", 20, |a| a.is_guest() && a.remote.as_ref().is_some_and(|r| r.loaded && r.problem.is_none()));
    let toast = r.app.toast().map(str::to_string);
    assert_eq!(toast.as_deref(), Some(format!("Signed out of {}", crate::menu::host(&server)).as_str()));
    assert!(r.app.tokens.get(&server).is_none());
    r.synced("synced as a guest again");
    assert!(!r.app.ed.is_read_only(), "still editable as a guest");
    PLANS.lock().unwrap().push(Plan::Approve("James".into()));
    r.sign_in();
    r.synced("signed in again");
    assert_eq!(crate::menu::account_label(&r.app).as_deref(), Some("James"));
    pass("mac: token revoked on the web → a guest, then Sign in", format!("{toast:?} → guest, editable → James again"));

    // 8. Server down: offline status, backoff, recovery (through a proxy that goes down)
    let proxy = Proxy::start(&server);
    r.open(&proxy.url, &editable);
    // the proxy's origin isn't the server's: sign in there (a guest's writes come only from the server's origin)
    PLANS.lock().unwrap().push(Plan::Approve("James".into()));
    r.sign_in();
    r.synced("via proxy synced");
    proxy.set_up(false);
    r.wait("offline shown", 30, |a| a.remote_status().is_some_and(|s| s.starts_with("Offline")));
    let offline = r.app.remote_status();
    proxy.set_up(true);
    r.wait("back online", 60, |a| a.remote.as_ref().is_some_and(|r| r.synced) && a.remote_status().as_deref() == Some("Saved"));
    proxy.set_up(false);
    r.app.open_remote(proxy.url.clone(), notes.clone(), String::new(), None, &mut r.tx);
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
    let w = r.app.store.recent.iter().find(|(w, _)| matches!(w, WsRef::Remote { id, server: s, .. } if *id == notes && *s == server)).unwrap().0.clone();
    r.app.choose(w, &mut r.tx);
    r.wait("back to remote", 30, |a| a.remote.as_ref().is_some_and(|r| r.loaded && r.synced));
    pass("mac: switch local ↔ remote", format!("local {:?}, remote {:?}", "local text", r.app.current.as_ref().unwrap().name()));

    // 10. A workspace deleted while open
    let doomed = mk(&mut owner, "Doomed");
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
    for want in ["dffddf", "Editable"] {
        assert!(names.iter().any(|n| n.starts_with(want)), "{want} in {names:?}");
    }
    assert!(!reloaded.recent.iter().any(|(w, _)| matches!(w, WsRef::Remote { title, .. } if title.is_empty())));
    pass("mac: recents survive restart with titles", format!("{names:?}"));

    // 13. Disconnect: the token is revoked on the server and forgotten here
    let token = r.app.tokens.get(&server).unwrap();
    let w = reloaded.recent.iter().find(|(w, _)| matches!(w, WsRef::Remote { id, server: s, .. } if *id == notes && *s == server)).unwrap().0.clone();
    r.app.choose(w, &mut r.tx);
    r.wait("dffddf open", 30, |a| a.remote.as_ref().is_some_and(|r| r.loaded));
    r.app.disconnect(&server, &mut r.tx);
    assert!(r.app.tokens.get(&server).is_none() && r.app.store.server(&server).is_none());
    assert_eq!(r.app.remote.as_ref().unwrap().problem, Some(Problem::SignedOut));
    let t = Instant::now();
    while net::request("GET", &format!("{server}/api/me"), Some(&token), None).unwrap().status != 401 {
        r.drain();
        assert!(t.elapsed().as_secs() < 10, "disconnect didn't revoke the token");
        std::thread::sleep(Duration::from_millis(100));
    }
    pass("mac: disconnect revokes the token", format!("toast {:?}; token 401", r.app.toast()));

    for s in SEEN.lock().unwrap().iter() {
        println!("QA BROWSER {s}");
    }
    r.app.close_room();
    r.drain();
    let _ = r.settled();
    let _ = std::fs::remove_dir_all(&dir);
}

/// What Open → Folder's picker answers in the parity run.
static PICK: Mutex<Option<String>> = Mutex::new(None);

fn qa_picker() -> Result<Option<String>, String> {
    Ok(PICK.lock().unwrap().clone())
}

fn menu_labels(app: &App) -> Vec<String> {
    crate::menu::items(app).iter().map(crate::menu::Item::label).collect()
}

fn account_labels(app: &App) -> Vec<String> {
    crate::menu::account_items(app).iter().map(crate::menu::Item::label).collect()
}

/// The × on the row of remote folder `id`.
fn cross_of(app: &App, id: &str) -> Option<crate::menu::Cross> {
    crate::menu::items(app).into_iter().find_map(|i| match i {
        crate::menu::Item::Ws { ws: WsRef::Remote { id: i, .. }, cross, .. } if i == id => Some(cross),
        _ => None,
    })?
}

/// The switcher's items against a real server, one by one (`GRIMOIRE_QA_SERVER`, as for the QA run): the
/// menu for someone else's folder, one we made and a local folder; New… → Remote folder, the agent card
/// (prints `PARITY AGENT-URL`, then waits up to `GRIMOIRE_QA_AGENT_WAIT` s for `agent-was-here.md`, which
/// the Linux box makes through that link; the tree's 3 s poll shows it), Leave (a row's ×), Remove (its
/// maker), Change name, Open folder from a remote and from a local workspace, Sign out.
#[test]
#[ignore]
fn parity_against_a_server() {
    use crate::actions;
    use crate::dialogs::Dialog;
    use crate::menu::Act;
    let Ok(server) = std::env::var("GRIMOIRE_QA_SERVER") else { return };
    let ghost = std::env::var("GRIMOIRE_QA_GOOGLE_HOST").unwrap_or_else(|_| net::parse_url(&server).unwrap().host);
    let agent_wait: u64 = std::env::var("GRIMOIRE_QA_AGENT_WAIT").ok().and_then(|s| s.parse().ok()).unwrap_or(240);
    let dir = std::env::temp_dir().join(format!("grimoire-parity-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    *BROWSER.lock().unwrap() = Some(Browser { google_host: ghost.clone(), origin: server.clone(), ..Browser::default() });
    let host = net::parse_url(&server).unwrap().display_host();

    // James (Google, in a browser of his own) made a folder (every folder is public).
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
    let (st, w) = owner.json("POST", &format!("{server}/api/workspaces"), Some(&serde_json::json!({ "title": "Linked" })));
    assert_eq!(st, 201, "{w}");
    let linked = w["id"].as_str().unwrap().to_string();
    pass("setup", format!("James made {linked}"));

    let q: Arc<Mutex<Vec<Update>>> = Arc::default();
    let mut app = App::new("", None, true);
    app.backend = Backend::Net(Handle::Queue(q.clone()));
    app.tokens = Tokens::File(dir.join("tokens.json"));
    app.store = Store::load(Some(dir.clone()));
    app.store.ensure_guest();
    app.opener = qa_browser;
    app.picker = Some(qa_picker);
    let mut r = Run { app, tx: Tx::default(), q };
    let tok = |r: &Run| r.app.tokens.get(&server).unwrap();
    let get = |token: &str, path: &str| -> (u16, Value) {
        let resp = net::request("GET", &format!("{server}{path}"), Some(token), None).unwrap();
        (resp.status, resp.json().unwrap_or(Value::Null))
    };
    let idle = |r: &mut Run, ms: u64| {
        let t = Instant::now();
        while t.elapsed() < Duration::from_millis(ms) {
            r.drain();
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let set_field = |r: &mut Run, n: usize, s: &str| *r.app.dialog.as_mut().unwrap().field(n).unwrap() = crate::dialogs::field_edit(s);

    // 1. Mac user (a name account) opens James's folder: joined by opening it, editable, not removable.
    r.open(&server, &linked);
    PLANS.lock().unwrap().push(Plan::Name("Mac user".into()));
    r.sign_in();
    assert!(r.app.remote.as_ref().unwrap().loaded);
    r.app.toggle_switcher();
    r.wait("joined list", 20, |a| a.store.server(&server).is_some_and(|s| s.joined.iter().any(|j| j.id == linked)));
    idle(&mut r, 300);
    let m = menu_labels(&r.app);
    println!("PARITY MENU remote-other {m:?}");
    assert!(m.contains(&"• Linked".to_string()) && !m.contains(&"Remove workspace…".to_string()), "{m:?}");
    assert_eq!(cross_of(&r.app, &linked), Some(crate::menu::Cross::Leave));
    assert!(!r.app.remote.as_ref().unwrap().read_only);
    r.app.close_switcher();
    pass("menu: someone else's folder", format!("{m:?}"));

    // 2. New… → Remote folder (on the server it's connected to)
    r.app.run_act(Act::New, &mut r.tx);
    actions::pick_open(&mut r.app, crate::dialogs::OpenChoice::NewRemote, &mut r.tx);
    set_field(&mut r, 5, &server);
    set_field(&mut r, 4, "Parity QA");
    actions::submit_open(&mut r.app, &mut r.tx);
    r.wait("new workspace open", 30, |a| a.remote.as_ref().is_some_and(|x| x.loaded && x.ws.name() == "Parity QA"));
    let ws = r.app.remote.as_ref().unwrap().id().to_string();
    let (st, d) = get(&tok(&r), &format!("/api/workspaces/{ws}"));
    assert_eq!((st, d["canRemove"].as_bool()), (200, Some(true)), "{d}");
    r.synced("README synced");
    r.app.toggle_switcher();
    r.wait("owner's joined list", 20, |a| a.store.server(&server).is_some_and(|s| s.joined.iter().any(|j| j.id == ws)));
    idle(&mut r, 300);
    let m = menu_labels(&r.app);
    println!("PARITY MENU remote-maker {m:?}");
    for want in ["• Parity QA", "Linked", "Remove workspace…", "New Workspace…", "Open Workspace…"] {
        assert!(m.contains(&want.to_string()), "{want} in {m:?}");
    }
    let acc = account_labels(&r.app);
    println!("PARITY ACCOUNT remote-maker {acc:?}");
    for want in ["Change name…", "Switch account", "Sign out"] {
        assert!(acc.contains(&want.to_string()) && !m.contains(&want.to_string()), "{want}: account {acc:?}, switcher {m:?}");
    }
    for no in ["Share folder…", "Settings", "Share with agent…", "Leave folder", "Refresh"] {
        assert!(!m.contains(&no.to_string()) && !acc.contains(&no.to_string()), "{no}: {m:?} / {acc:?}");
    }
    assert_eq!(cross_of(&r.app, &ws), Some(crate::menu::Cross::Leave), "its maker can leave it too");
    r.app.close_switcher();
    pass("new folder + its maker's menu", format!("{ws}; {m:?}"));

    // 3. The sidebar's "Share with an agent" Copy: the Linux box runs a shell command through the link
    assert!(r.app.agent_card_shown());
    r.app.copied = None;
    actions::copy_agent_prompt(&mut r.app, &mut r.tx);
    r.wait("agent prompt copied", 20, |a| a.copied.as_deref().is_some_and(|c| c.contains("http")));
    let prompt = r.app.copied.clone().unwrap();
    let url = prompt.split_whitespace().find(|w| w.starts_with("http")).unwrap().to_string();
    println!("PARITY AGENT-URL {url}");
    println!("PARITY AGENT-PROMPT {prompt:?}");
    r.app.dialog = None;
    // 4. The tree's periodic update (every 3 s) brings the agent's note: no Refresh
    let t = Instant::now();
    loop {
        idle(&mut r, 1000);
        if r.app.remote.as_ref().unwrap().tree_list.iter().any(|p| p == "agent-was-here.md") {
            break;
        }
        assert!(t.elapsed().as_secs() < agent_wait, "the agent's note never showed: {:?}", r.app.remote.as_ref().unwrap().tree_list);
    }
    pass("agent link: a shell command from the Linux box shows up", format!("tree {:?}", r.app.remote.as_ref().unwrap().tree_list));

    // 5. Off the list: back to Linked, its row's ×, then Remove in the confirm
    let w = WsRef::Remote { server: server.clone(), id: linked.clone(), title: "Linked".into() };
    r.app.choose(w, &mut r.tx);
    r.wait("Linked open", 30, |a| a.remote.as_ref().is_some_and(|x| x.loaded && x.id() == linked));
    assert_eq!(cross_of(&r.app, &linked), Some(crate::menu::Cross::Leave), "no × on Linked");
    r.app.ask_remove_folder(WsRef::Remote { server: server.clone(), id: linked.clone(), title: "Linked".into() }, &mut r.tx);
    assert!(matches!(&r.app.dialog, Some(Dialog::Confirm(c)) if c.title == "Remove Linked from your list?"));
    actions::confirm(&mut r.app, &mut r.tx);
    let msg = "Removed Linked from your list";
    r.wait("left", 30, |a| a.toast() == Some(msg));
    let (_, list) = get(&tok(&r), "/api/workspaces");
    assert!(!list.as_array().unwrap().iter().any(|w| w["id"] == linked.as_str()), "{list}");
    r.wait("next workspace open", 30, |a| a.remote.as_ref().is_some_and(|x| x.loaded && x.id() == ws));
    pass("leave", format!("{msg} → joined now {:?}", list.as_array().unwrap().iter().map(|w| w["title"].clone()).collect::<Vec<_>>()));

    // 6. Remove folder… (its maker)
    r.app.run_act(Act::New, &mut r.tx);
    actions::pick_open(&mut r.app, crate::dialogs::OpenChoice::NewRemote, &mut r.tx);
    set_field(&mut r, 5, &server);
    set_field(&mut r, 4, "Doomed");
    actions::submit_open(&mut r.app, &mut r.tx);
    r.wait("Doomed open", 30, |a| a.remote.as_ref().is_some_and(|x| x.loaded && x.ws.name() == "Doomed"));
    let doomed = r.app.remote.as_ref().unwrap().id().to_string();
    r.app.run_act(Act::Remove, &mut r.tx);
    let msg = match &r.app.dialog { Some(Dialog::Confirm(c)) => (c.title.clone(), c.message.clone()), _ => panic!("no confirm") };
    actions::confirm(&mut r.app, &mut r.tx);
    r.wait("removed, next open", 30, |a| a.remote.as_ref().is_some_and(|x| x.loaded && x.id() != doomed));
    let (st, _) = get(&tok(&r), &format!("/api/repos/{doomed}"));
    assert_eq!(st, 404);
    pass("remove by its maker", format!("{msg:?} → /api/repos/{doomed} 404"));

    // 7. Change name…
    r.app.run_act(Act::ChangeName, &mut r.tx);
    set_field(&mut r, 0, "Mac Parity");
    actions::submit_prompt(&mut r.app, &mut r.tx);
    r.wait("renamed", 20, |a| a.store.server(&server).and_then(|s| s.account.clone()).as_deref() == Some("Mac Parity"));
    let (_, me) = get(&tok(&r), "/api/me");
    assert_eq!(me["name"], "Mac Parity");
    r.wait("reloaded", 30, |a| a.remote.as_ref().is_some_and(|x| x.loaded));
    pass("change name", format!("/api/me name {}; account row says {:?}", me["name"], crate::menu::account_label(&r.app)));

    // 8. Open folder… from a remote workspace, then from a local one
    let (a, b) = (dir.join("folder-a"), dir.join("folder-b"));
    for d in [&a, &b] {
        std::fs::create_dir_all(d).unwrap();
        crate::doc::write(&d.join("Note.md"), "local").unwrap();
    }
    *PICK.lock().unwrap() = Some(a.to_string_lossy().into_owned());
    r.app.run_act(Act::Open, &mut r.tx);
    actions::submit_open(&mut r.app, &mut r.tx);
    r.wait("folder-a open", 10, |x| matches!(&x.current, Some(WsRef::Local { path }) if path.ends_with("folder-a")));
    let m = menu_labels(&r.app);
    println!("PARITY MENU local {m:?}");
    assert!(m.contains(&"Open Workspace…".to_string()) && !m.contains(&"Remove workspace…".to_string()));
    assert!(crate::menu::account_label(&r.app).is_none() && account_labels(&r.app).is_empty(), "a local folder: no account row");
    *PICK.lock().unwrap() = Some(b.to_string_lossy().into_owned());
    r.app.run_act(Act::Open, &mut r.tx);
    actions::submit_open(&mut r.app, &mut r.tx);
    r.wait("folder-b open", 10, |x| matches!(&x.current, Some(WsRef::Local { path }) if path.ends_with("folder-b")));
    pass("open folder in both modes", format!("remote → {} → {}; local menu {m:?}", a.display(), b.display()));

    // 9. Sign out (back on the server first)
    let w = WsRef::Remote { server: server.clone(), id: ws.clone(), title: "Parity QA".into() };
    r.app.choose(w, &mut r.tx);
    r.wait("Parity QA open", 30, |a| a.remote.as_ref().is_some_and(|x| x.loaded));
    let token = tok(&r);
    r.app.run_act(Act::SignOut, &mut r.tx);
    let msg = match &r.app.dialog { Some(Dialog::Confirm(c)) => c.message.clone(), _ => panic!("no confirm") };
    actions::confirm(&mut r.app, &mut r.tx);
    let t = Instant::now();
    while get(&token, "/api/me").0 != 401 {
        r.drain();
        assert!(t.elapsed().as_secs() < 10, "sign out didn't revoke the token");
        std::thread::sleep(Duration::from_millis(100));
    }
    let m = account_labels(&r.app);
    assert_eq!(m, ["Signed out of ".to_string() + &host, "Reconnect".to_string()], "the account menu");
    assert_eq!(crate::menu::account_label(&r.app).as_deref(), Some("Signed out"));
    pass("sign out", format!("{msg} → token 401; account row \"Signed out\", its menu {m:?}"));
    r.app.close_room();
    r.drain();
    let _ = std::fs::remove_dir_all(&dir);
}

/// New… → Remote folder on a server the app has never connected to (`GRIMOIRE_QA_SERVER`): the connect
/// flow runs first (a name sign-in in the scripted browser), then the folder is created there (its maker
/// may remove it) and opened.
#[test]
#[ignore]
fn new_remote_folder_against_a_server() {
    use crate::actions;
    use crate::dialogs::{Dialog, OpenChoice};
    use crate::menu::Act;
    let Ok(server) = std::env::var("GRIMOIRE_QA_SERVER") else { return };
    let ghost = std::env::var("GRIMOIRE_QA_GOOGLE_HOST").unwrap_or_else(|_| net::parse_url(&server).unwrap().host);
    let dir = std::env::temp_dir().join(format!("grimoire-new-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    *BROWSER.lock().unwrap() = Some(Browser { google_host: ghost, origin: server.clone(), ..Browser::default() });
    let q: Arc<Mutex<Vec<Update>>> = Arc::default();
    let mut app = App::new("", None, true);
    app.backend = Backend::Net(Handle::Queue(q.clone()));
    app.tokens = Tokens::File(dir.join("tokens.json"));
    app.store = Store::load(Some(dir.clone()));
    app.store.ensure_guest();
    app.opener = qa_browser;
    let mut r = Run { app, tx: Tx::default(), q };
    assert!(r.app.tokens.get(&server).is_none() && r.app.store.server(&server).is_none(), "never connected");
    PLANS.lock().unwrap().push(Plan::Name("New Mac".into()));
    r.app.run_act(Act::New, &mut r.tx);
    actions::pick_open(&mut r.app, OpenChoice::NewRemote, &mut r.tx);
    *r.app.dialog.as_mut().unwrap().field(5).unwrap() = crate::dialogs::field_edit(&format!("{server}/"));
    *r.app.dialog.as_mut().unwrap().field(4).unwrap() = crate::dialogs::field_edit("Made with New");
    actions::submit_open(&mut r.app, &mut r.tx);
    r.wait("connect flow started", 20, |a| matches!(&a.dialog, Some(Dialog::Open(d)) if d.status.is_some()) || a.remote.is_some());
    r.wait("created and open", 60, |a| a.remote.as_ref().is_some_and(|x| x.loaded && x.ws.name() == "Made with New"));
    let token = r.app.tokens.get(&server).expect("a token from the connect flow");
    let id = r.app.remote.as_ref().unwrap().id().to_string();
    let resp = net::request("GET", &format!("{server}/api/workspaces/{id}"), Some(&token), None).unwrap();
    let d = resp.json().unwrap_or(Value::Null);
    assert_eq!((resp.status, d["canRemove"].as_bool()), (200, Some(true)), "{d}");
    pass("new remote folder: connect, then create and open", format!("{id} on {server}: {d}"));
    let _ = std::fs::remove_dir_all(&dir);
}
