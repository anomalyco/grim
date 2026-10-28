//! Remote workspaces: the server's REST API (tree, notes, workspaces), the connect flow that gets an app
//! token through the browser, and the open note's room: a WebSocket (tungstenite, on its own thread) whose
//! frames go through collab's `CollabEditor` on the UI thread.
//!
//! Threads never touch `App`: they call `AppHandle::update` with what happened, tagged with a generation, and
//! the handlers drop anything from an older workspace or connection. Headless runs and tests have no
//! network: a `Mock` (collab's in-process `Relay`, plus scripted peers) stands in for the server.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::Duration;

use collab::relay::Relay;
use collab::{AfterClose, CollabEditor, Notice, PeerCursor};
use editor_core::Sel;
use editor_core::text::utf16_to_byte;
use rune::{AppHandle, Tx};
use std::sync::{Arc, Mutex};
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::files::{self, Entry};
use crate::note::{Collab, Ed};
use crate::switcher::ServerIssue;
use crate::workspaces::{Joined, WsRef};
use crate::{App, keys, net};

pub const CLIENT_NAME: &str = "Grimoire for Mac";
/// How long the connect flow waits for the browser.
const CONNECT_WAIT: Duration = Duration::from_secs(300);
/// The tree is fetched again this often while a remote workspace is open.
const TREE_POLL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// 401: the token is missing, revoked or expired.
    Unauthorized,
    /// 403, with the server's message.
    Forbidden(String),
    /// 404 from the Grimoire API (`{error}`): no such workspace or note, or no access to it (the server
    /// doesn't say which).
    NotFound(String),
    /// The server couldn't be reached (DNS, refused, timeout, TLS) or a proxy in front of it says it's down
    /// (502/503/504): worth retrying.
    Network(String),
    /// Something answered, but not the Grimoire API (HTML, a 404 page).
    NotGrimoire(String),
    Other(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Unauthorized => write!(f, "not signed in"),
            ApiError::Forbidden(s) | ApiError::NotFound(s) | ApiError::Network(s) | ApiError::Other(s) => write!(f, "{s}"),
            ApiError::NotGrimoire(s) => write!(f, "{s} isn't a Grimoire server"),
        }
    }
}

/// The REST API of one server, with the app token.
#[derive(Clone, Debug)]
pub struct Api {
    pub server: String,
    pub token: Option<String>,
}

impl Api {
    fn host(&self) -> String {
        net::parse_url(&self.server).map_or_else(|_| self.server.clone(), |u| u.display_host())
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        let r = net::request(method, &format!("{}{path}", self.server), self.token.as_deref(), body).map_err(ApiError::Network)?;
        let message = || r.json().ok().and_then(|v| v["error"].as_str().map(str::to_string));
        match r.status {
            401 => return Err(ApiError::Unauthorized),
            403 => return Err(ApiError::Forbidden(message().unwrap_or_else(|| "forbidden".into()))),
            404 => return Err(message().map_or_else(|| ApiError::NotGrimoire(self.host()), ApiError::NotFound)),
            502..=504 => return Err(ApiError::Network(format!("{} is unavailable (HTTP {})", self.host(), r.status))),
            _ if !r.ok() => return Err(ApiError::Other(message().unwrap_or_else(|| format!("HTTP {}", r.status)))),
            _ => {}
        }
        if r.body.is_empty() { Ok(Value::Null) } else { r.json().map_err(|_| ApiError::NotGrimoire(self.host())) }
    }

    /// `GET /api/server` (no auth): `{name, publicUrl, signin, google, devLogin, version}`.
    pub fn server_info(&self) -> Result<Value, ApiError> {
        match (Api { server: self.server.clone(), token: None }).call("GET", "/api/server", None) {
            Ok(v) if v.is_object() => Ok(v),
            Ok(_) | Err(ApiError::NotFound(_) | ApiError::Forbidden(_) | ApiError::Unauthorized | ApiError::Other(_)) => {
                Err(ApiError::NotGrimoire(self.host()))
            }
            Err(e) => Err(e),
        }
    }

    /// `GET /api/me`: the account (`name`, `login`, `color`…) and, for an app token, `token: {id, label}`.
    pub fn me(&self) -> Result<Value, ApiError> {
        self.call("GET", "/api/me", None)
    }

    pub fn workspaces(&self) -> Result<Vec<Joined>, ApiError> {
        let v = self.call("GET", "/api/workspaces", None)?;
        Ok(v.as_array().map(|a| a.iter().filter_map(Joined::from_json).collect()).unwrap_or_default())
    }

    /// `GET /api/workspaces/:id` (title, role, readOnly), falling back to the older `/api/repos/:id` when
    /// it isn't found there.
    pub fn workspace(&self, id: &str) -> Result<Value, ApiError> {
        match self.call("GET", &format!("/api/workspaces/{}", net::enc(id)), None) {
            Err(e @ ApiError::NotFound(_)) => self.call("GET", &format!("/api/repos/{}", net::enc(id)), None).map_err(|_| e),
            r => r,
        }
    }

    /// The workspace's Markdown notes (paths relative to it).
    pub fn tree(&self, id: &str) -> Result<Vec<String>, ApiError> {
        let v = self.call("GET", &format!("/api/repos/{}/tree", net::enc(id)), None)?;
        Ok(v["files"].as_array().map(|a| a.iter().filter_map(|f| f.as_str().map(str::to_string)).collect()).unwrap_or_default())
    }

    pub fn create(&self, id: &str, path: &str) -> Result<(), ApiError> {
        self.call("POST", &format!("/api/repos/{}/files", net::enc(id)), Some(&json!({ "path": path, "content": "" }))).map(|_| ())
    }

    pub fn rename(&self, id: &str, from: &str, to: &str) -> Result<(), ApiError> {
        self.call("POST", &format!("/api/repos/{}/rename", net::enc(id)), Some(&json!({ "from": from, "to": to }))).map(|_| ())
    }

    pub fn delete(&self, id: &str, path: &str) -> Result<(), ApiError> {
        self.call("DELETE", &format!("/api/repos/{}/files?path={}", net::enc(id), net::enc(path)), None).map(|_| ())
    }

    /// Revoke this app's token on the server (`token_id` from the connect redirect or `/api/me`; looked up
    /// when unknown). Ok when it's gone (also when it already was).
    pub fn revoke(&self, token_id: Option<&str>) -> Result<(), ApiError> {
        let id = match token_id {
            Some(id) => id.to_string(),
            None => match self.me() {
                Ok(me) => me["token"]["id"].as_str().map(str::to_string).ok_or_else(|| ApiError::Other("this server can't revoke app tokens".into()))?,
                Err(ApiError::Unauthorized) => return Ok(()),
                Err(e) => return Err(e),
            },
        };
        match self.call("DELETE", &format!("/api/tokens/{}", net::enc(&id)), None) {
            Ok(_) | Err(ApiError::Unauthorized | ApiError::NotFound(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// The browser page that asks the user to allow this app.
pub fn connect_url(server: &str, port: u16, state: &str) -> String {
    let redirect = format!("http://127.0.0.1:{port}/callback");
    format!("{server}/connect?client={}&redirect={}&state={}", net::enc(CLIENT_NAME), net::enc(&redirect), net::enc(state))
}

/// What the connect flow brings back.
#[derive(Clone, Debug, PartialEq)]
pub struct Connected {
    /// The server's name (`/api/server`).
    pub name: String,
    pub token: String,
    /// The token's id (to revoke it), and the account that approved it (servers before these were sent:
    /// `None`; `/api/me` fills them in).
    pub token_id: Option<String>,
    pub account: Option<String>,
}

/// The connect flow: check the server, listen on a loopback port, open the browser at the server's
/// `/connect` page (`open`), and wait for it to redirect back with a token and our state.
pub fn connect_flow(server: &str, open: impl FnOnce(&str) -> Result<(), String>, wait: Duration) -> Result<Connected, ApiError> {
    let info = Api { server: server.to_string(), token: None }.server_info()?;
    let name = info["name"].as_str().unwrap_or("Grimoire").to_string();
    let (listener, port) = net::loopback().map_err(|e| ApiError::Other(format!("can't listen on 127.0.0.1: {e}")))?;
    let state = net::random_hex(16);
    open(&connect_url(server, port, &state)).map_err(|e| ApiError::Other(format!("Couldn't open the browser: {e}")))?;
    let target = net::accept_callback(&listener, wait).map_err(ApiError::Other)?;
    if net::query_param(&target, "state").as_deref() != Some(state.as_str()) {
        return Err(ApiError::Other("The browser answered for another sign-in (state mismatch)".into()));
    }
    if let Some(e) = net::query_param(&target, "error") {
        return Err(ApiError::Other(if e == "access_denied" { "You cancelled in the browser".into() } else { format!("Not connected: {e}") }));
    }
    let token = net::query_param(&target, "token").unwrap_or_default();
    if !crate::workspaces::valid_token(&token) {
        return Err(ApiError::Other("The server sent no token".into()));
    }
    let token_id = net::query_param(&target, "token_id").filter(|s| !s.is_empty());
    let account = net::query_param(&target, "account").filter(|s| !s.is_empty());
    Ok(Connected { name, token, token_id, account })
}

/// `/usr/bin/open <url>` (one argument, no shell).
pub fn open_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open").arg(url).status().map_err(|e| e.to_string()).and_then(|s| {
        if s.success() { Ok(()) } else { Err(format!("open failed ({s})")) }
    })
}

/// A presence colour from a user id (stable; like the server's palette in spirit).
pub fn color_for(id: &str) -> String {
    const PALETTE: [&str; 8] = ["#e5484d", "#f76b15", "#ad7f58", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];
    let h = id.bytes().fold(2166136261u32, |h, b| (h ^ b as u32).wrapping_mul(16777619));
    PALETTE[h as usize % PALETTE.len()].to_string()
}

/// The note tree from the server's list of paths, under the virtual root.
pub fn entries(root: &Path, list: &[String]) -> Vec<Entry> {
    let mut out = Vec::new();
    for p in list {
        if p.is_empty() || p.split('/').any(|s| s.is_empty() || s == "." || s == ".." || s.starts_with('.')) {
            continue;
        }
        let path = root.join(p);
        if files::is_note(&path) {
            files::insert(&mut out, root, &path);
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The room connection

/// What the UI thread sends to a socket thread.
pub enum ToSock {
    Frame(Vec<u8>),
    Close,
}

/// The WebSocket URL of a note's room.
pub fn ws_url(server: &str, id: &str, path: &str) -> String {
    let base = if let Some(r) = server.strip_prefix("https://") { format!("wss://{r}") } else { format!("ws://{}", server.trim_start_matches("http://")) };
    format!("{base}/ws?repo={}&path={}", net::enc(id), net::enc(path))
}

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

fn ws_connect(server: &str, token: Option<&str>, id: &str, path: &str) -> Result<Ws, String> {
    let url = ws_url(server, id, path);
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    if let Some(t) = token {
        req.headers_mut().insert("Authorization", format!("Bearer {t}").parse().map_err(|_| "bad token")?);
    }
    // The server checks the origin of browser sockets; ours is the server's own.
    req.headers_mut().insert("Origin", server.parse().map_err(|_| "bad origin")?);
    let u = net::parse_url(server)?;
    let tcp = net::tcp(&u.host, u.port)?;
    let (ws, _) = tungstenite::client_tls(req, tcp).map_err(|e| e.to_string())?;
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(Duration::from_millis(15))),
        MaybeTlsStream::NativeTls(s) => s.get_ref().set_read_timeout(Some(Duration::from_millis(15))),
        _ => Ok(()),
    }
    .map_err(|e| e.to_string())?;
    Ok(ws)
}

/// Open the room on a thread; frames and the close come back through `handle` tagged with `generation`.
pub fn spawn_socket(handle: Handle, server: String, token: Option<String>, id: String, path: String, generation: u64) -> Sender<ToSock> {
    let (tx, rx) = mpsc::channel::<ToSock>();
    std::thread::spawn(move || {
        let (code, reason) = match ws_connect(&server, token.as_deref(), &id, &path) {
            Ok(ws) => pump_socket(ws, &rx, &handle, generation),
            Err(e) => (1006, e),
        };
        handle.update(move |app, tx| app.room_closed(generation, code, &reason, tx));
    });
    tx
}

/// Until the socket closes: frames out from `rx`, frames in to the app.
fn pump_socket(mut ws: Ws, rx: &Receiver<ToSock>, handle: &Handle, generation: u64) -> (u16, String) {
    loop {
        loop {
            match rx.try_recv() {
                Ok(ToSock::Frame(f)) => {
                    if let Err(e) = ws.send(Message::Binary(f.into())) {
                        handle.update(move |app, _| app.frames_lost(generation));
                        return (1006, e.to_string());
                    }
                }
                Ok(ToSock::Close) | Err(TryRecvError::Disconnected) => {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    return (1000, "closed".into());
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        match ws.read() {
            Ok(Message::Binary(data)) => {
                let data = data.to_vec();
                handle.update(move |app, tx| app.room_frame(generation, &data, tx));
            }
            Ok(Message::Close(f)) => {
                let code = f.as_ref().map_or(1005, |f| u16::from(f.code));
                return (code, f.map_or(String::new(), |f| f.reason.to_string()));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return (1006, e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The mock server (headless runs, tests)

/// A peer on the mock server (another user in the room).
pub struct Peer {
    pub ed: CollabEditor,
    inbox: VecDeque<Vec<u8>>,
}

/// collab's in-process `Relay` as the room of every note, a fixed tree, and scripted peers.
pub struct Mock {
    pub relays: Vec<(String, Relay)>,
    pub tree: Vec<String>,
    pub peers: Vec<(String, Peer)>,
    /// Frames for the app's connection, and the note it's connected to.
    pub to_app: VecDeque<Vec<u8>>,
    pub app_note: Option<String>,
    pub now: f64,
    /// Loading the workspace fails like this (headless snapshots of the problem page, tests).
    pub fail: Option<ApiError>,
    /// Who the app is signed in as, and the workspace's title.
    pub account: String,
    pub title: String,
}

pub type MockRef = Rc<RefCell<Mock>>;

impl Mock {
    pub fn new(notes: &[(&str, &str)]) -> Mock {
        Mock {
            relays: notes.iter().map(|(p, t)| (p.to_string(), Relay::new(t))).collect(),
            tree: notes.iter().map(|(p, _)| p.to_string()).collect(),
            peers: Vec::new(),
            to_app: VecDeque::new(),
            app_note: None,
            now: 0.0,
            fail: None,
            account: "Me".into(),
            title: String::new(),
        }
    }

    fn relay(&mut self, note: &str) -> Option<&mut Relay> {
        self.relays.iter_mut().find(|(p, _)| p == note).map(|(_, r)| r)
    }

    pub fn text(&self, note: &str) -> Option<String> {
        self.relays.iter().find(|(p, _)| p == note).map(|(_, r)| r.text())
    }

    /// A peer named `name` joins `note` (synced).
    pub fn add_peer(&mut self, note: &str, id: u32, name: &str, color: &str) -> usize {
        let user = json!({ "id": format!("peer-{id}"), "name": name, "color": color, "kind": "human" });
        let mut ed = CollabEditor::new(id, user);
        ed.connecting();
        let greet = self.relay(note).map(|r| r.greet()).unwrap_or_default();
        self.peers.push((note.to_string(), Peer { ed, inbox: greet.into() }));
        self.settle();
        self.peers.len() - 1
    }

    /// Run a command on peer `i` (typing, moving its caret), then deliver everything.
    pub fn peer(&mut self, i: usize, f: impl FnOnce(&mut CollabEditor)) {
        f(&mut self.peers[i].1.ed);
        self.now += 60.0;
        let out = self.peers[i].1.ed.take_outgoing(self.now);
        self.peer_frames(i, out.frames);
        self.settle();
    }

    /// Peer `i` focuses with its caret at `byte` (published).
    pub fn peer_caret(&mut self, i: usize, byte: usize) {
        self.now += 60.0;
        let now = self.now;
        let p = &mut self.peers[i].1;
        p.ed.editor_mut().set_selection(Sel::caret(byte));
        let frames = p.ed.set_focused(true, now);
        self.peer_frames(i, frames);
        self.settle();
    }

    fn peer_frames(&mut self, i: usize, frames: Vec<Vec<u8>>) {
        let note = self.peers[i].0.clone();
        for f in frames {
            let Some(r) = self.relay(&note) else { continue };
            let (reply, bcast) = r.handle(&f);
            self.peers[i].1.inbox.extend(reply);
            self.broadcast(&note, Some(i), &bcast);
        }
    }

    fn broadcast(&mut self, note: &str, except_peer: Option<usize>, frames: &[Vec<u8>]) {
        for (j, (n, p)) in self.peers.iter_mut().enumerate() {
            if n == note && Some(j) != except_peer {
                p.inbox.extend(frames.iter().cloned());
            }
        }
        if except_peer.is_some() && self.app_note.as_deref() == Some(note) {
            self.to_app.extend(frames.iter().cloned());
        }
    }

    /// Deliver what the peers have queued until nothing moves.
    pub fn settle(&mut self) {
        loop {
            let mut moved = false;
            for i in 0..self.peers.len() {
                while let Some(f) = self.peers[i].1.inbox.pop_front() {
                    moved = true;
                    let now = self.now;
                    let out = self.peers[i].1.ed.receive(&f, now).map(|r| r.outgoing).unwrap_or_default();
                    self.peer_frames(i, out);
                }
            }
            if !moved {
                return;
            }
        }
    }

    /// The app opens `note`'s room: false when there's no such note.
    pub fn app_connect(&mut self, note: &str) -> bool {
        let Some(greet) = self.relay(note).map(|r| r.greet()) else { return false };
        self.app_note = Some(note.to_string());
        self.to_app = greet.into();
        true
    }

    /// Frames from the app.
    pub fn app_frames(&mut self, frames: Vec<Vec<u8>>) {
        let Some(note) = self.app_note.clone() else { return };
        for f in frames {
            let Some(r) = self.relay(&note) else { continue };
            let (reply, bcast) = r.handle(&f);
            self.to_app.extend(reply);
            for (n, p) in self.peers.iter_mut() {
                if *n == note {
                    p.inbox.extend(bcast.iter().cloned());
                }
            }
        }
        self.settle();
    }
}

// ---------------------------------------------------------------------------------------------
// The open remote workspace

/// A state update from another thread.
pub type Update = Box<dyn FnOnce(&mut App, &mut Tx) + Send>;

/// How background threads reach the app: Rune's `AppHandle` (the running app), or a queue the caller drains
/// (tests driving the real network code without a window).
#[derive(Clone)]
pub enum Handle {
    Rune(AppHandle<App>),
    Queue(Arc<Mutex<Vec<Update>>>),
}

impl Handle {
    pub fn update(&self, f: impl FnOnce(&mut App, &mut Tx) + Send + 'static) {
        match self {
            Handle::Rune(h) => h.update(f),
            Handle::Queue(q) => q.lock().unwrap().push(Box::new(f)),
        }
    }
}

/// How the app reaches the server.
pub enum Backend {
    Net(Handle),
    Mock(MockRef),
    /// Headless without a mock: nothing happens.
    None,
}

pub struct Remote {
    pub ws: WsRef,
    pub api: Api,
    /// This opening of the workspace (replies about an older one are dropped).
    pub session: u64,
    /// Bumped whenever the note's connection changes: frames and closes from older ones are dropped.
    pub generation: u64,
    /// Our presence user (`{id, name, color, kind}`), from `/api/me`.
    pub user: Value,
    /// The workspace is read-only for us (viewer, or a read-only GitHub copy).
    pub read_only: bool,
    pub loaded: bool,
    /// The open note (relative path) and its room.
    pub note: Option<String>,
    pub sock: Option<Sender<ToSock>>,
    pub synced: bool,
    /// The connection is over for good (`closed` reason shown).
    pub ended: Option<String>,
    /// A wake-up for `take_outgoing` is scheduled at this time (ms on the app's clock).
    pub wake_at: Option<f64>,
    pub focused: bool,
    /// Why the workspace can't be shown (the page says so, with what to do about it).
    pub problem: Option<Problem>,
    /// A load is under way (the first, or a retry while a problem shows).
    pub loading: bool,
    /// The account the token belongs to (`/api/me`'s name), once known.
    pub account: Option<String>,
    /// The tree poll can't reach the server (the open note keeps working offline; the pill says so).
    pub offline: Option<String>,
    /// The server's list of notes, as last fetched.
    pub tree_list: Vec<String>,
}

/// Why a remote workspace isn't showing.
#[derive(Clone, Debug, PartialEq)]
pub enum Problem {
    /// No token, or the server refused it (revoked, expired): Reconnect.
    SignedOut,
    /// Opening it: the server says there's no such workspace for this account (403/404; private to
    /// others, deleted, or a wrong URL).
    NoAccess,
    /// It was open, and now it's gone (deleted, or access removed).
    Gone,
    /// The server can't be reached: retried with backoff (`attempt`, the next try in `retry_s`).
    Offline { error: String, attempt: u32, retry_s: u64 },
    /// What answered isn't a Grimoire server.
    NotGrimoire,
    /// Something else (the connect flow failed, an unexpected answer).
    Failed(String),
}

/// What the problem page offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fix {
    Reconnect,
    SwitchAccount,
    RetryNow,
    TryAgain,
    Remove,
}

impl Fix {
    pub fn label(self) -> &'static str {
        match self {
            Fix::Reconnect => "Reconnect",
            Fix::SwitchAccount => "Switch account",
            Fix::RetryNow => "Retry now",
            Fix::TryAgain => "Try again",
            Fix::Remove => "Remove",
        }
    }
}

/// Backoff for loading a workspace while the server can't be reached: 1, 2, 4… seconds, at most 30.
pub fn backoff_s(attempt: u32) -> u64 {
    (1u64 << attempt.saturating_sub(1).min(5)).min(30)
}

impl Remote {
    pub fn new(ws: WsRef, api: Api) -> Remote {
        Remote {
            ws,
            api,
            session: 0,
            generation: 0,
            user: Value::Null,
            read_only: false,
            loaded: false,
            note: None,
            sock: None,
            synced: false,
            ended: None,
            wake_at: None,
            focused: false,
            problem: None,
            loading: false,
            account: None,
            offline: None,
            tree_list: Vec::new(),
        }
    }

    pub fn id(&self) -> &str {
        match &self.ws {
            WsRef::Remote { id, .. } => id,
            WsRef::Local { .. } => "",
        }
    }
}

/// The virtual root a remote workspace's tree hangs from (never on disk).
pub fn virtual_root(server: &str, id: &str) -> PathBuf {
    let host = net::parse_url(server).map_or_else(|_| "server".to_string(), |u| u.display_host().replace(':', "_"));
    PathBuf::from(format!("/.grimoire-remote/{host}/{}", id.replace('/', "_")))
}

static NEXT_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_gen() -> u64 {
    NEXT_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

fn client_id() -> u32 {
    let h = net::random_hex(4);
    (u32::from_str_radix(&h, 16).unwrap_or(1) & 0x7fff_ffff) | 1
}

impl App {
    fn now_ms(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }

    /// Open a remote workspace: the connect flow first when there's no token for its server, then the
    /// workspace's details and tree; `note` (or the one open last) opens once the tree is there.
    pub fn open_remote(&mut self, server: String, id: String, title: String, note: Option<String>, tx: &mut Tx) {
        self.leave_workspace();
        let title = if title.is_empty() { self.store.known_title(&server, &id).unwrap_or_default() } else { title };
        let ws = WsRef::Remote { server: server.clone(), id: id.clone(), title };
        let note = note.or_else(|| self.store.last_note(&ws));
        let token = self.tokens.get(&server);
        let mut r = Remote::new(ws.clone(), Api { server: server.clone(), token: token.clone() });
        r.session = next_gen();
        r.generation = next_gen();
        r.account = self.store.server(&server).and_then(|s| s.account.clone());
        let session = r.session;
        self.root = Some(virtual_root(&server, &id));
        self.set_files(Vec::new());
        self.collapsed.clear();
        self.path = None;
        self.ed = Ed::local("");
        self.ed.set_read_only(true);
        self.remote = Some(r);
        self.current = Some(ws.clone());
        self.store.touch(&ws, note.clone());
        tx.set_title(ws.name());
        tx.scroll_to("scroll", 0.0);
        self.pending_note = note;
        match &self.backend {
            Backend::Net(h) => {
                if token.is_none() {
                    self.start_connect(&server);
                } else {
                    if let Some(r) = self.remote.as_mut() {
                        r.loading = true;
                    }
                    spawn_load(h.clone(), Api { server, token }, id, session);
                }
            }
            Backend::Mock(m) => {
                let fail = m.borrow().fail.clone();
                let user = json!({ "id": "me", "name": m.borrow().account, "color": "#0090ff", "kind": "human" });
                let r = match fail {
                    Some(e) => Err((e, Some(user))),
                    None => Ok(Loaded { me: user, info: json!({ "title": m.borrow().title, "role": "editor" }), list: m.borrow().tree.clone() }),
                };
                self.remote_loaded(session, r, tx);
            }
            Backend::None => {}
        }
    }

    /// Get a (new) token for `server` through the browser: for a first connection, "Reconnect" and "Switch
    /// account" alike. The newest flow wins; an older one finishing later is ignored.
    pub fn start_connect(&mut self, server: &str) {
        let Backend::Net(h) = &self.backend else { return };
        let (h, opener) = (h.clone(), self.opener);
        self.switcher.connect_gen += 1;
        let gen_ = self.switcher.connect_gen;
        let host = WsRef::Remote { server: server.to_string(), id: String::new(), title: String::new() }.location();
        self.switcher.busy = Some(format!("Waiting for the browser to connect to {host}…"));
        let server = server.to_string();
        std::thread::spawn(move || {
            let r = connect_flow(&server, opener, CONNECT_WAIT);
            h.update(move |app, tx| app.connected(gen_, &server, r, tx));
        });
    }

    /// The connect flow finished: keep the token (revoking the one it replaces), note the account, and
    /// reload the open workspace when it's on that server.
    pub fn connected(&mut self, gen_: u64, server: &str, r: Result<Connected, ApiError>, tx: &mut Tx) {
        if gen_ != self.switcher.connect_gen {
            return;
        }
        self.switcher.busy = None;
        let here = self.remote.as_ref().filter(|x| x.api.server == server).map(|x| (x.ws.clone(), x.note.clone().or_else(|| self.pending_note.clone())));
        match r {
            Ok(c) => {
                let old = self.tokens.get(server).filter(|t| *t != c.token);
                let old_id = self.store.server(server).and_then(|s| s.token_id.clone());
                if let (Some(old), Backend::Net(_)) = (old, &self.backend) {
                    // "Switch account": the old token goes (best effort; it's forgotten here anyway)
                    let api = Api { server: server.to_string(), token: Some(old) };
                    std::thread::spawn(move || {
                        if let Err(e) = api.revoke(old_id.as_deref()) {
                            eprintln!("grimoire: {}: couldn't revoke the old token: {e}", api.server);
                        }
                    });
                }
                match self.tokens.set(server, &c.token) {
                    Ok(place) => eprintln!("grimoire: connected to {server} as {} (token in the {place})", c.account.as_deref().unwrap_or("?")),
                    Err(e) => eprintln!("grimoire: {server}: couldn't store the token: {e}"),
                }
                self.store.upsert_server(server, Some(&c.name), None);
                self.store.set_account(server, c.account.clone(), c.token_id.clone());
                self.switcher.server_issues.retain(|(u, _)| u != server);
                self.refresh_joined(server);
                if let Some((WsRef::Remote { server, id, title }, note)) = here {
                    self.open_remote(server, id, title, note, tx);
                }
            }
            Err(e) => {
                let p = match e {
                    ApiError::Network(m) => Problem::Failed(format!("Can't reach the server: {m}")),
                    ApiError::NotGrimoire(_) => Problem::NotGrimoire,
                    e => Problem::Failed(e.to_string()),
                };
                if here.is_some()
                    && let Some(rem) = self.remote.as_mut()
                {
                    rem.loading = false;
                    // a failed "Switch account" keeps the workspace as it was
                    if rem.problem.is_some() || !rem.loaded {
                        rem.problem = Some(p.clone());
                    }
                }
                self.switcher.error = Some(match p {
                    Problem::NotGrimoire => format!("{} isn't a Grimoire server", WsRef::Remote { server: server.into(), id: String::new(), title: String::new() }.location()),
                    Problem::Failed(m) => m,
                    _ => String::new(),
                });
            }
        }
        self.handled(tx);
    }

    /// Fetch the account and the workspaces joined on `server` (for the switcher), in the background.
    pub fn refresh_joined(&mut self, server: &str) {
        let Backend::Net(h) = &self.backend else { return };
        let Some(token) = self.tokens.get(server) else {
            if !self.switcher.server_issues.iter().any(|(u, _)| u == server) {
                self.switcher.server_issues.push((server.to_string(), ServerIssue::SignedOut));
            }
            return;
        };
        let (h, api) = (h.clone(), Api { server: server.to_string(), token: Some(token) });
        std::thread::spawn(move || {
            let me = api.me();
            let r = me.clone().and_then(|_| api.workspaces());
            let name = api.server_info().ok().and_then(|v| v["name"].as_str().map(str::to_string));
            h.update(move |app, tx| {
                // the token changed meanwhile (switched account, disconnected): this answer is stale
                if app.tokens.get(&api.server) != api.token {
                    return;
                }
                app.switcher.server_issues.retain(|(u, _)| *u != api.server);
                match (me, r) {
                    (Ok(me), Ok(list)) => {
                        let account = me["name"].as_str().filter(|s| !s.is_empty()).or(me["login"].as_str()).map(str::to_string);
                        let token_id = me["token"]["id"].as_str().map(str::to_string);
                        app.store.update_titles(&api.server, &list);
                        app.store.upsert_server(&api.server, name.as_deref(), Some(list));
                        let token_id = token_id.or_else(|| app.store.server(&api.server).and_then(|s| s.token_id.clone()));
                        app.store.set_account(&api.server, account.clone(), token_id);
                        if let Some(rem) = app.remote.as_mut().filter(|r| r.api.server == api.server) {
                            rem.account = account;
                        }
                        // the open workspace's title may have changed on the server
                        if let Some(WsRef::Remote { server, id, .. }) = app.current.clone()
                            && server == api.server
                            && let Some(t) = app.store.known_title(&server, &id)
                        {
                            app.retitle_current(&t, tx);
                        }
                    }
                    (Err(ApiError::Unauthorized), _) | (_, Err(ApiError::Unauthorized)) => {
                        app.switcher.server_issues.push((api.server.clone(), ServerIssue::SignedOut));
                    }
                    (Err(e), _) | (_, Err(e)) => app.switcher.server_issues.push((api.server.clone(), ServerIssue::Error(e.to_string()))),
                }
            });
        });
    }

    /// The open remote workspace's title (from the server) changed: the switcher, the window, the recents.
    fn retitle_current(&mut self, t: &str, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        let WsRef::Remote { title, .. } = &mut rem.ws else { return };
        if t.is_empty() || title == t {
            return;
        }
        *title = t.to_string();
        let ws = rem.ws.clone();
        self.current = Some(ws.clone());
        self.store.retitle(&ws);
        if self.path.is_none() {
            tx.set_title(ws.name());
        }
    }

    /// The workspace's details and tree arrived (or failed: `me` when the account was known).
    pub fn remote_loaded(&mut self, session: u64, r: Result<Loaded, (ApiError, Option<Value>)>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut().filter(|x| x.session == session) else { return };
        rem.loading = false;
        match r {
            Ok(Loaded { me, info, list }) => {
                let id = me["id"].as_str().unwrap_or("mac").to_string();
                let name = me["name"].as_str().unwrap_or("Mac").to_string();
                let color = me["color"].as_str().map_or_else(|| color_for(&id), str::to_string);
                rem.user = json!({ "id": id, "name": name, "color": color, "kind": "human" });
                rem.account = Some(name);
                rem.read_only = info["readOnly"].as_bool().unwrap_or(false)
                    || info["role"].as_str() == Some("viewer")
                    || info["access"].as_str() == Some("read");
                rem.loaded = true;
                rem.problem = None;
                if let Some(t) = info["title"].as_str().filter(|t| !t.is_empty()) {
                    let t = t.to_string();
                    self.retitle_current(&t, tx);
                }
                self.remote_tree(session, list);
                if let (Backend::Net(h), Some(rem)) = (&self.backend, self.remote.as_ref()) {
                    spawn_tree_poll(h.clone(), rem.api.clone(), rem.id().to_string(), session);
                }
                // opening it may have recorded a join: the switcher's list for this server changes
                if let Some(server) = self.remote.as_ref().map(|r| r.api.server.clone()) {
                    self.refresh_joined(&server);
                }
                let root = self.root.clone().unwrap_or_default();
                let want = self.pending_note.take().map(|n| root.join(n)).filter(|p| files::contains(&self.files, p));
                if let Some(p) = want.or_else(|| first_note(&self.files)) {
                    self.open_note(p, tx);
                }
            }
            Err((e, me)) => {
                if let Some(n) = me.as_ref().and_then(|m| m["name"].as_str()) {
                    rem.account = Some(n.to_string());
                }
                let problem = match e {
                    ApiError::Unauthorized => {
                        // revoked or expired: forget it; "Reconnect" gets a new one
                        let server = rem.api.server.clone();
                        rem.api.token = None;
                        self.tokens.remove(&server);
                        if !self.switcher.server_issues.iter().any(|(u, _)| *u == server) {
                            self.switcher.server_issues.push((server, ServerIssue::SignedOut));
                        }
                        Problem::SignedOut
                    }
                    ApiError::NotFound(_) | ApiError::Forbidden(_) => Problem::NoAccess,
                    ApiError::NotGrimoire(_) => Problem::NotGrimoire,
                    ApiError::Network(error) => {
                        let attempt = match &rem.problem {
                            Some(Problem::Offline { attempt, .. }) => attempt + 1,
                            _ => 1,
                        };
                        let retry_s = backoff_s(attempt);
                        if let Backend::Net(h) = &self.backend {
                            let h = h.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_secs(retry_s));
                                h.update(move |app, tx| app.retry_load(session, Some(attempt), tx));
                            });
                        }
                        Problem::Offline { error, attempt, retry_s }
                    }
                    ApiError::Other(m) => Problem::Failed(m),
                };
                if let Some(rem) = self.remote.as_mut() {
                    rem.problem = Some(problem);
                }
            }
        }
        self.handled(tx);
    }

    /// Load the open remote workspace again (`attempt`: a scheduled retry, dropped when it's no longer the
    /// latest; `None`: "Retry now").
    pub fn retry_load(&mut self, session: u64, attempt: Option<u32>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut().filter(|r| r.session == session && !r.loading) else { return };
        match (&rem.problem, attempt) {
            (Some(Problem::Offline { attempt: a, .. }), Some(want)) if *a == want => {}
            (Some(Problem::Offline { .. }), None) => {}
            _ => return,
        }
        rem.loading = true;
        match &self.backend {
            Backend::Net(h) => spawn_load(h.clone(), rem.api.clone(), rem.id().to_string(), session),
            Backend::Mock(m) => {
                let fail = m.borrow().fail.clone();
                let r = match fail {
                    Some(e) => Err((e, None)),
                    None => Ok(Loaded { me: json!({ "id": "me", "name": m.borrow().account }), info: json!({ "title": m.borrow().title }), list: m.borrow().tree.clone() }),
                };
                self.remote_loaded(session, r, tx);
            }
            Backend::None => {}
        }
        self.handled(tx);
    }

    /// What the problem page says (title, explanation) and offers.
    pub fn problem_page(&self) -> Option<(String, String, Vec<Fix>)> {
        let rem = self.remote.as_ref()?;
        let p = rem.problem.as_ref()?;
        let name = rem.ws.name();
        let host = rem.ws.location();
        let who = rem.account.as_deref().map_or_else(|| "this account".to_string(), |a| a.to_string());
        Some(match p {
            Problem::SignedOut => (
                format!("Signed out of {host}"),
                format!("Grimoire for Mac isn't connected to {host}: its access was revoked or has expired. Reconnect to sign in again in the browser."),
                vec![Fix::Reconnect, Fix::Remove],
            ),
            Problem::NoAccess => (
                format!("No access to {name}"),
                format!("You don't have access to {name} as {who} on {host}. It may be private to another account, or deleted, or the URL may be wrong. Switch to the account it was shared with."),
                vec![Fix::SwitchAccount, Fix::Remove],
            ),
            Problem::Gone => (
                format!("{name} is no longer available"),
                format!("{name} on {host} was deleted, or {who}'s access to it was removed."),
                vec![Fix::SwitchAccount, Fix::Remove],
            ),
            Problem::Offline { error, attempt, retry_s } => (
                format!("Can't reach {host}"),
                {
                    let mut e = error.clone();
                    if let Some(f) = e.get(..1) {
                        e.replace_range(..1, &f.to_uppercase());
                    }
                    let error = e;
                if rem.loading {
                    format!("{error}. Trying again…")
                } else {
                    format!("{error}. Trying again in {retry_s} s (attempt {attempt}).")
                }
                },
                vec![Fix::RetryNow, Fix::Remove],
            ),
            Problem::NotGrimoire => (
                format!("{host} isn't a Grimoire server"),
                "What answered there isn't Grimoire. Check the URL: it looks like https://server/app/workspace.".to_string(),
                vec![Fix::Remove],
            ),
            Problem::Failed(m) => (format!("Couldn't open {name}"), m.clone(), vec![Fix::TryAgain, Fix::Remove]),
        })
    }

    /// A button on the problem page.
    pub fn apply_fix(&mut self, f: Fix, tx: &mut Tx) {
        let Some(rem) = self.remote.as_ref() else { return };
        let (ws, session, server) = (rem.ws.clone(), rem.session, rem.api.server.clone());
        match f {
            Fix::Reconnect | Fix::SwitchAccount => self.start_connect(&server),
            Fix::RetryNow => self.retry_load(session, None, tx),
            Fix::TryAgain => {
                if let WsRef::Remote { server, id, title } = ws {
                    let note = self.pending_note.clone();
                    self.open_remote(server, id, title, note, tx);
                }
            }
            Fix::Remove => self.remove_recent(&ws, tx),
        }
        self.handled(tx);
    }

    /// Forget a workspace from the recent list; when it's the open one, open the next recent one that
    /// still works (a local folder that exists), else the sample note.
    pub fn remove_recent(&mut self, w: &WsRef, tx: &mut Tx) {
        self.store.forget(w);
        if !self.current.as_ref().is_some_and(|c| c.same(w)) {
            return;
        }
        let next = self.store.recent.iter().find_map(|(r, _)| match r {
            WsRef::Local { path } if path.is_dir() => Some(path.clone()),
            _ => None,
        });
        match next {
            Some(p) => self.open_local(p, tx),
            None => self.show_sample(tx),
        }
    }

    /// No workspace: the built-in sample note.
    pub fn show_sample(&mut self, tx: &mut Tx) {
        self.leave_workspace();
        self.current = None;
        self.root = None;
        self.path = None;
        self.set_files(Vec::new());
        self.ed = Ed::local(crate::doc::SAMPLE);
        self.sent = self.ed.text().to_string();
        tx.set_title("Grimoire".to_string());
        tx.scroll_to("scroll", 0.0);
    }

    /// "Disconnect": revoke the app's token on the server (best effort) and forget it and the server here.
    /// An open workspace there shows "Signed out".
    pub fn disconnect(&mut self, server: &str, tx: &mut Tx) {
        let token = self.tokens.get(server);
        let token_id = self.store.server(server).and_then(|s| s.token_id.clone());
        let host = WsRef::Remote { server: server.to_string(), id: String::new(), title: String::new() }.location();
        if let (Some(token), Backend::Net(h)) = (token, &self.backend) {
            let (h, api) = (h.clone(), Api { server: server.to_string(), token: Some(token) });
            std::thread::spawn(move || {
                let r = api.revoke(token_id.as_deref());
                h.update(move |app, _| match r {
                    Ok(()) => eprintln!("grimoire: {}: token revoked", api.server),
                    Err(e) => app.show_toast(format!("Disconnected here, but the server didn't revoke the token ({e}). Revoke it in Settings on the web.")),
                });
            });
        }
        self.switcher.connect_gen += 1;
        self.switcher.busy = None;
        self.tokens.remove(server);
        self.store.remove_server(server);
        self.switcher.server_issues.retain(|(u, _)| u != server);
        if self.remote.as_ref().is_some_and(|r| r.api.server == server) {
            self.close_room();
            self.path = None;
            self.ed = Ed::local("");
            self.ed.set_read_only(true);
            self.set_files(Vec::new());
            if let Some(rem) = self.remote.as_mut() {
                rem.api.token = None;
                rem.loaded = false;
                rem.session = next_gen();
                rem.problem = Some(Problem::SignedOut);
            }
        }
        self.show_toast(format!("Disconnected from {host}"));
        self.handled(tx);
    }

    /// A new list of notes from the server.
    pub fn remote_tree(&mut self, session: u64, list: Vec<String>) {
        let Some(rem) = self.remote.as_mut().filter(|x| x.session == session) else { return };
        if rem.tree_list == list && !self.files.is_empty() {
            return;
        }
        rem.tree_list = list.clone();
        let root = self.root.clone().unwrap_or_default();
        self.set_files(entries(&root, &list));
    }

    /// The tree poll's answer: a new list, the server out of reach (offline, kept working), or the
    /// workspace gone or the token refused (the problem page).
    pub fn tree_polled(&mut self, session: u64, r: Result<Vec<String>, ApiError>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut().filter(|x| x.session == session) else { return };
        let problem = match r {
            Ok(list) => {
                if rem.offline.take().is_some() {
                    tx.instant();
                }
                self.remote_tree(session, list);
                return;
            }
            Err(ApiError::Network(e)) => {
                if rem.offline.is_none() {
                    rem.offline = Some(e);
                    tx.instant();
                }
                return;
            }
            Err(ApiError::Unauthorized) => Problem::SignedOut,
            Err(ApiError::NotFound(_) | ApiError::Forbidden(_)) => Problem::Gone,
            // anything else: try again next time
            Err(_) => return,
        };
        self.lose_workspace(problem, tx);
    }

    /// The open remote workspace can't go on (revoked token, deleted, access removed): leave the room and
    /// show the problem page.
    fn lose_workspace(&mut self, problem: Problem, tx: &mut Tx) {
        if problem == Problem::SignedOut
            && let Some(server) = self.remote.as_ref().map(|r| r.api.server.clone())
        {
            self.tokens.remove(&server);
            if let Some(rem) = self.remote.as_mut() {
                rem.api.token = None;
            }
            if !self.switcher.server_issues.iter().any(|(u, _)| *u == server) {
                self.switcher.server_issues.push((server, ServerIssue::SignedOut));
            }
        }
        self.close_room();
        self.path = None;
        self.ed = Ed::local("");
        self.ed.set_read_only(true);
        self.set_files(Vec::new());
        if let Some(rem) = self.remote.as_mut() {
            rem.tree_list.clear();
            rem.loaded = false;
            rem.offline = None;
            rem.problem = Some(problem);
        }
        self.handled(tx);
    }

    /// Open a note of the remote workspace: its room through a `CollabEditor` (read-only until it syncs).
    pub fn open_remote_note(&mut self, rel: String, tx: &mut Tx) {
        self.close_room();
        let Some(rem) = self.remote.as_mut() else { return };
        rem.generation = next_gen();
        rem.note = Some(rel.clone());
        rem.synced = false;
        rem.ended = None;
        rem.focused = false;
        rem.wake_at = None;
        let generation = rem.generation;
        let user = if rem.user.is_null() { json!({ "id": "mac", "name": "Mac", "color": "#0090ff", "kind": "human" }) } else { rem.user.clone() };
        let ws = rem.ws.clone();
        let mut ce = Collab::new_in(client_id(), user);
        ce.set_local_read_only(true);
        ce.editor_mut().set_key_table(Some(keys::table()));
        self.ed = Ed::Remote(Box::new(ce));
        self.store.set_note(&ws, Some(rel.clone()));
        tx.set_title(files::note_name(Path::new(&rel)));
        tx.scroll_to("scroll", 0.0);
        self.connect_room(generation);
    }

    fn connect_room(&mut self, generation: u64) {
        let Some(rem) = self.remote.as_mut().filter(|r| r.generation == generation) else { return };
        let Some(note) = rem.note.clone() else { return };
        if let Some(ce) = self.ed.collab_mut() {
            ce.connecting();
        }
        match &self.backend {
            Backend::Net(h) => {
                rem.sock = Some(spawn_socket(h.clone(), rem.api.server.clone(), rem.api.token.clone(), rem.id().to_string(), note, generation));
            }
            Backend::Mock(m) => {
                if !m.borrow_mut().app_connect(&note) {
                    let mut tx = Tx::default();
                    self.room_closed(generation, 4404, "file not found", &mut tx);
                    return;
                }
                self.pump_mock();
            }
            Backend::None => {}
        }
    }

    /// Leave the open note's room (sends our null presence first).
    pub fn close_room(&mut self) {
        let frames = self.ed.collab_mut().map(|c| c.leave()).unwrap_or_default();
        if let Backend::Mock(m) = &self.backend {
            let mut m = m.borrow_mut();
            m.app_frames(frames.clone());
            m.app_note = None;
            m.to_app.clear();
        }
        if let Some(rem) = self.remote.as_mut() {
            if let Some(s) = rem.sock.take() {
                for f in frames {
                    let _ = s.send(ToSock::Frame(f));
                }
                let _ = s.send(ToSock::Close);
            }
            rem.note = None;
            rem.generation = next_gen();
        }

    }

    /// Leave the open workspace (local: flush the note; remote: leave the room).
    pub fn leave_workspace(&mut self) {
        self.save_now();
        self.saver = None;
        self.close_room();
        self.remote = None;
        self.pending_note = None;
        self.renaming = None;
        self.row_menu = None;
        *self.watch.lock().unwrap() = None;
        self.filter.clear();
        self.blur_filter();
        self.new_dir = None;
    }

    /// Send what the collab editor has after a command (and schedule its next wake-up).
    pub fn pump_collab(&mut self) {
        let now = self.now_ms();
        let want_focus = !self.filter.focused && !self.switcher.open && self.renaming.is_none();
        let Some(rem) = self.remote.as_mut() else { return };
        let Some(ce) = self.ed.collab_mut() else { return };
        let mut frames = Vec::new();
        if rem.synced && rem.focused != want_focus {
            rem.focused = want_focus;
            frames.extend(ce.set_focused(want_focus, now));
        }
        let out = ce.take_outgoing(now);
        frames.extend(out.frames);
        if let Some(ms) = out.wake_in_ms {
            let at = now + ms;
            if rem.wake_at.is_none_or(|w| at < w - 1.0) {
                rem.wake_at = Some(at);
                if let Backend::Net(h) = &self.backend {
                    let (h, generation) = (h.clone(), rem.generation);
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs_f64(ms.max(1.0) / 1000.0));
                        h.update(move |app, tx| app.room_wake(generation, tx));
                    });
                }
            }
        }
        self.send_frames(frames);
    }

    fn send_frames(&mut self, frames: Vec<Vec<u8>>) {
        if frames.is_empty() {
            return;
        }
        match &self.backend {
            Backend::Net(_) => {
                let Some(rem) = self.remote.as_ref() else { return };
                match &rem.sock {
                    Some(s) => {
                        for f in frames {
                            if s.send(ToSock::Frame(f)).is_err() {
                                if let Some(ce) = self.ed.collab_mut() {
                                    ce.frames_lost();
                                }
                                break;
                            }
                        }
                    }
                    None => {
                        if let Some(ce) = self.ed.collab_mut() {
                            ce.frames_lost();
                        }
                    }
                }
            }
            Backend::Mock(m) => {
                let m = m.clone();
                m.borrow_mut().app_frames(frames);
                self.pump_mock();
            }
            Backend::None => {}
        }
    }

    /// Mock: deliver what the mock room has for us.
    pub fn pump_mock(&mut self) {
        let Backend::Mock(m) = &self.backend else { return };
        let m = m.clone();
        let generation = self.remote.as_ref().map_or(0, |r| r.generation);
        loop {
            let f = m.borrow_mut().to_app.pop_front();
            let Some(f) = f else { break };
            let mut tx = Tx::default();
            self.room_frame(generation, &f, &mut tx);
        }
    }

    pub fn room_wake(&mut self, generation: u64, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut().filter(|r| r.generation == generation) else { return };
        rem.wake_at = None;
        self.pump_collab();
        tx.instant();
    }

    pub fn frames_lost(&mut self, generation: u64) {
        if self.remote.as_ref().is_some_and(|r| r.generation == generation)
            && let Some(ce) = self.ed.collab_mut()
        {
            ce.frames_lost();
        }
    }

    /// A frame from the room.
    pub fn room_frame(&mut self, generation: u64, frame: &[u8], tx: &mut Tx) {
        if self.remote.as_ref().is_none_or(|r| r.generation != generation) {
            return;
        }
        let now = self.now_ms();
        let Some(ce) = self.ed.collab_mut() else { return };
        let r = match ce.receive(frame, now) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("grimoire: room: {e}");
                return;
            }
        };
        if r.reloaded {
            ce.editor_mut().set_key_table(Some(keys::table()));
        }
        let mut reset = false;
        for n in &r.notices {
            match n {
                Notice::Synced => {
                    let ro = self.remote.as_ref().is_some_and(|x| x.read_only);
                    if let Some(ce) = self.ed.collab_mut() {
                        ce.set_local_read_only(ro);
                    }
                    if let Some(rem) = self.remote.as_mut() {
                        rem.synced = true;
                    }
                }
                Notice::Reset => reset = true,
                _ => {}
            }
        }
        if !r.edits.is_empty() || r.reloaded {
            self.sent = self.ed.text().to_string();
            self.marked = None;
        }
        self.send_frames(r.outgoing);
        if reset {
            self.room_reset(tx);
            return;
        }
        self.pump_collab();
        tx.instant();
    }

    /// The room was recreated (or a read-only connection would drop our edits): start over.
    fn room_reset(&mut self, tx: &mut Tx) {
        if let Some(rem) = self.remote.as_mut() {
            if let Some(s) = rem.sock.take() {
                let _ = s.send(ToSock::Close);
            }
            rem.generation = next_gen();
            rem.synced = false;
            rem.focused = false;
        }
        if let Some(ce) = self.ed.collab_mut() {
            ce.reset(client_id());
            ce.set_local_read_only(true);
            ce.editor_mut().set_key_table(Some(keys::table()));
        }
        self.show_toast("This note was reloaded from the server.".into());
        let generation = self.remote.as_ref().map_or(0, |r| r.generation);
        self.connect_room(generation);
        tx.instant();
    }

    /// The socket closed: retry with backoff, or end the session with a reason.
    pub fn room_closed(&mut self, generation: u64, code: u16, reason: &str, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut().filter(|r| r.generation == generation) else { return };
        rem.sock = None;
        rem.focused = false;
        let Some(ce) = self.ed.collab_mut() else { return };
        match ce.disconnected(code, reason) {
            // `synced` stays: collab's session syncs once (a reconnect brings no second Synced; it resyncs
            // inside), and the pill shows the connection's state meanwhile
            AfterClose::Retry { delay_ms } => {
                rem.generation = next_gen();
                let next = rem.generation;
                if let Backend::Net(h) = &self.backend {
                    let h = h.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(delay_ms as u64));
                        h.update(move |app, tx| {
                            app.connect_room(next);
                            tx.instant();
                        });
                    });
                }
            }
            AfterClose::Closed { reason, to } if reason == "unauthorized" || reason == "forbidden" => {
                let _ = to;
                let p = if reason == "unauthorized" { Problem::SignedOut } else { Problem::Gone };
                // the tree may still be readable after a "forbidden" (a note link's scope): check first
                if p == Problem::Gone
                    && let (Backend::Net(h), Some(rem)) = (&self.backend, self.remote.as_ref())
                {
                    let (h, api, id, session) = (h.clone(), rem.api.clone(), rem.id().to_string(), rem.session);
                    if let Some(rem) = self.remote.as_mut() {
                        rem.ended = Some("No access to this note".into());
                    }
                    std::thread::spawn(move || {
                        let r = api.tree(&id);
                        h.update(move |app, tx| app.tree_polled(session, r, tx));
                    });
                } else {
                    self.lose_workspace(p, tx);
                }
            }
            AfterClose::Closed { reason, to } => {
                rem.synced = false;
                rem.ended = Some(match reason.as_str() {
                    "deleted" => "This note was deleted".to_string(),
                    "renamed" => format!("This note was renamed{}", to.as_deref().map(|t| format!(" to {t}")).unwrap_or_default()),
                    "unauthorized" => "Not signed in to this server".to_string(),
                    "forbidden" => "No access to this note".to_string(),
                    "notfound" => "This note doesn't exist on the server".to_string(),
                    "toolarge" => "This note is too large to open".to_string(),
                    r => format!("Disconnected ({r})"),
                });
                if let Some(ce) = self.ed.collab_mut() {
                    ce.set_local_read_only(true);
                }
                if reason == "renamed"
                    && let Some(to) = to
                {
                    let root = self.root.clone().unwrap_or_default();
                    self.path = None;
                    self.open_note(root.join(to), tx);
                }
            }
        }
        tx.instant();
    }

    /// What the status pill says ("Connecting…", "Offline", "Read only", "Saving…", "Saved").
    pub fn remote_status(&self) -> Option<String> {
        let rem = self.remote.as_ref()?;
        if self.switcher.busy.is_some() && (!rem.loaded || rem.problem.is_some()) {
            return Some("Waiting for the browser…".into());
        }
        if let Some(p) = &rem.problem {
            return Some(match p {
                Problem::SignedOut => "Signed out".into(),
                Problem::NoAccess => "No access".into(),
                Problem::Gone => "Not available".into(),
                Problem::Offline { .. } if rem.loading => "Offline · trying again…".into(),
                Problem::Offline { retry_s, .. } => format!("Offline · retrying in {retry_s} s"),
                Problem::NotGrimoire => "Not a Grimoire server".into(),
                Problem::Failed(_) => "Couldn't open".into(),
            });
        }
        if !rem.loaded {
            return Some("Loading…".into());
        }
        if rem.offline.is_some() && rem.note.is_none() {
            return Some("Offline · reconnecting".into());
        }
        rem.note.as_ref()?;
        if let Some(e) = &rem.ended {
            return Some(e.clone());
        }
        let ce = self.ed.collab()?;
        Some(match ce.status() {
            collab::ConnStatus::Connecting => "Connecting…".into(),
            collab::ConnStatus::Disconnected => "Offline · reconnecting".into(),
            collab::ConnStatus::Connected if rem.offline.is_some() && rem.synced => "Offline · reconnecting".into(),
            collab::ConnStatus::Connected if !rem.synced => "Loading…".into(),
            collab::ConnStatus::Connected => {
                let s = ce.save_state();
                let prefix = if ce.read_only() || rem.read_only { "Read only · " } else { "" };
                let st = if s["saving"].as_bool() == Some(true) {
                    "Saving…"
                } else if s["dirty"].as_bool() == Some(true) {
                    "Edited"
                } else {
                    "Saved"
                };
                format!("{prefix}{st}")
            }
        })
    }

    /// Remote carets to draw: byte positions in the current text.
    pub fn remote_carets(&self) -> Vec<(PeerCursor, usize, usize)> {
        let Some(ce) = self.ed.collab() else { return Vec::new() };
        if self.remote.as_ref().is_none_or(|r| !r.synced) {
            return Vec::new();
        }
        let t = self.ed.text();
        ce.remote_cursors()
            .into_iter()
            .map(|c| {
                let (a, h) = (utf16_to_byte(t, c.anchor_utf16 as usize), utf16_to_byte(t, c.head_utf16 as usize));
                (c, a, h)
            })
            .collect()
    }

    // ---- notes on the server ----

    /// New note in a remote workspace: `Untitled.md` (or the next free name) created on the server, then
    /// opened.
    pub fn remote_new_note(&mut self, tx: &mut Tx) {
        let Some(rem) = self.remote.as_ref().filter(|r| r.loaded && !r.read_only) else { return };
        let root = self.root.clone().unwrap_or_default();
        let dir = self.new_dir.clone().filter(|d| d.starts_with(&root)).unwrap_or_else(|| root.clone());
        let path = files::untitled(&dir, |p| files::contains(&self.files, p));
        let Ok(rel) = path.strip_prefix(&root).map(|r| r.to_string_lossy().into_owned()) else { return };
        let generation = rem.session;
        match &self.backend {
            Backend::Net(h) => {
                let (h, api, id) = (h.clone(), rem.api.clone(), rem.id().to_string());
                std::thread::spawn(move || {
                    let r = api.create(&id, &rel);
                    h.update(move |app, tx| app.remote_created(generation, rel, r, tx));
                });
            }
            Backend::Mock(m) => {
                {
                    let mut m = m.borrow_mut();
                    m.relays.push((rel.clone(), Relay::new("")));
                    m.tree.push(rel.clone());
                }
                self.remote_created(generation, rel, Ok(()), tx);
            }
            Backend::None => {}
        }
    }

    pub fn remote_created(&mut self, _generation: u64, rel: String, r: Result<(), ApiError>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        match r {
            Ok(()) => {
                let mut list = rem.tree_list.clone();
                if !list.contains(&rel) {
                    list.push(rel.clone());
                    list.sort();
                }
                let g = rem.session;
                rem.tree_list.clear();
                self.remote_tree(g, list);
                let root = self.root.clone().unwrap_or_default();
                self.filter.clear();
                self.blur_filter();
                self.open_note(root.join(&rel), tx);
            }
            Err(e) => self.show_toast(format!("Couldn't create {rel}: {e}")),
        }
        self.handled(tx);
    }

    /// Rename a note on the server (`to` relative to the workspace; `.md` added when it has no extension).
    pub fn remote_rename(&mut self, from: String, to: String, tx: &mut Tx) {
        let Some(rem) = self.remote.as_ref().filter(|r| r.loaded && !r.read_only) else { return };
        let mut to = to.trim().trim_matches('/').to_string();
        if to.is_empty() || to == from {
            return;
        }
        if !files::is_note(Path::new(&to)) {
            to.push_str(".md");
        }
        let generation = rem.session;
        match &self.backend {
            Backend::Net(h) => {
                let (h, api, id) = (h.clone(), rem.api.clone(), rem.id().to_string());
                std::thread::spawn(move || {
                    let r = api.rename(&id, &from, &to);
                    h.update(move |app, tx| app.remote_renamed(generation, from, to, r, tx));
                });
            }
            Backend::Mock(m) => {
                {
                    let mut m = m.borrow_mut();
                    if let Some(e) = m.relays.iter_mut().find(|(p, _)| *p == from) {
                        e.0 = to.clone();
                    }
                    m.tree.retain(|p| *p != from);
                    m.tree.push(to.clone());
                }
                self.remote_renamed(generation, from, to, Ok(()), tx);
            }
            Backend::None => {}
        }
    }

    pub fn remote_renamed(&mut self, _generation: u64, from: String, to: String, r: Result<(), ApiError>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        match r {
            Ok(()) => {
                let mut list: Vec<String> = rem.tree_list.iter().filter(|p| **p != from).cloned().collect();
                list.push(to.clone());
                list.sort();
                let g = rem.session;
                let was_open = rem.note.as_deref() == Some(from.as_str());
                rem.tree_list.clear();
                self.remote_tree(g, list);
                if was_open {
                    let root = self.root.clone().unwrap_or_default();
                    self.path = None;
                    self.open_note(root.join(&to), tx);
                }
            }
            Err(e) => self.show_toast(format!("Couldn't rename {from}: {e}")),
        }
        self.handled(tx);
    }

    pub fn remote_delete(&mut self, rel: String, tx: &mut Tx) {
        let Some(rem) = self.remote.as_ref().filter(|r| r.loaded && !r.read_only) else { return };
        let generation = rem.session;
        match &self.backend {
            Backend::Net(h) => {
                let (h, api, id) = (h.clone(), rem.api.clone(), rem.id().to_string());
                std::thread::spawn(move || {
                    let r = api.delete(&id, &rel);
                    h.update(move |app, tx| app.remote_deleted(generation, rel, r, tx));
                });
            }
            Backend::Mock(m) => {
                {
                    let mut m = m.borrow_mut();
                    m.relays.retain(|(p, _)| *p != rel);
                    m.tree.retain(|p| *p != rel);
                }
                self.remote_deleted(generation, rel, Ok(()), tx);
            }
            Backend::None => {}
        }
    }

    pub fn remote_deleted(&mut self, _generation: u64, rel: String, r: Result<(), ApiError>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        match r {
            Ok(()) => {
                let list: Vec<String> = rem.tree_list.iter().filter(|p| **p != rel).cloned().collect();
                let g = rem.session;
                let was_open = rem.note.as_deref() == Some(rel.as_str());
                rem.tree_list.clear();
                self.remote_tree(g, list);
                if was_open {
                    self.close_room();
                    self.path = None;
                    self.ed = Ed::local("");
                    self.ed.set_read_only(true);
                    if let Some(p) = first_note(&self.files) {
                        self.open_note(p, tx);
                    }
                }
            }
            Err(e) => self.show_toast(format!("Couldn't delete {rel}: {e}")),
        }
        self.handled(tx);
    }
}

/// The first note in tree order (folders first, like the sidebar), else none.
pub fn first_note(entries: &[Entry]) -> Option<PathBuf> {
    // notes at a level before the folders in it
    entries.iter().find(|e| e.kids.is_none()).map(|e| e.path.clone()).or_else(|| entries.iter().find_map(|e| e.kids.as_deref().and_then(first_note)))
}

/// What loading a workspace brings: the account (`/api/me`), the workspace's details, its notes.
pub struct Loaded {
    pub me: Value,
    pub info: Value,
    pub list: Vec<String>,
}

/// Load a workspace's account, details and tree. A failure says what failed, with the account when that
/// much worked.
pub fn load(api: &Api, id: &str) -> Result<Loaded, (ApiError, Option<Value>)> {
    let me = api.me().map_err(|e| match e {
        // a 404 for /api/me: not a Grimoire server (or one too old for apps)
        ApiError::NotFound(_) => (ApiError::NotGrimoire(api.host()), None),
        e => (e, None),
    })?;
    let info = api.workspace(id).map_err(|e| (e, Some(me.clone())))?;
    let list = api.tree(id).map_err(|e| (e, Some(me.clone())))?;
    Ok(Loaded { me, info, list })
}

fn spawn_load(h: Handle, api: Api, id: String, session: u64) {
    std::thread::spawn(move || {
        let r = load(&api, &id);
        h.update(move |app, tx| app.remote_loaded(session, r, tx));
    });
}

/// Fetch the tree every few seconds while this opening of the workspace lasts.
fn spawn_tree_poll(h: Handle, api: Api, id: String, session: u64) {
    let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    std::thread::spawn(move || {
        while alive.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(TREE_POLL);
            let list = api.tree(&id);
            let a = alive.clone();
            h.update(move |app, tx| {
                if app.remote.as_ref().is_none_or(|r| r.session != session || r.problem.is_some()) {
                    a.store(false, std::sync::atomic::Ordering::SeqCst);
                } else {
                    app.tree_polled(session, list, tx);
                }
            });
        }
    });
}

/// Headless `--remote-demo`: a remote workspace on the mock server, with Ada typing in the open note and her
/// caret showing. `--remote-demo=<state>` shows a problem instead: `noaccess` (the owner's case: a private
/// workspace and another account), `signedout`, `offline`, `notgrimoire`, `gone`, or `loading`.
pub fn demo(app: &mut App, state: &str) {
    let mut m = Mock::new(&[
        ("Team notes.md", "# Team notes\n\nPlanning for the **launch**:\n\n- Draft the announcement\n- Review the docs\n- Book the room\n\nOpen questions go below.\n"),
        ("ideas/Roadmap.md", "# Roadmap\n"),
        ("ideas/Names.md", "# Names\n"),
        ("Meeting 1-1.md", "# 1-1\n"),
    ]);
    let server = "https://grimoire.example";
    if !state.is_empty() {
        m.account = "confused-noodle".into();
        m.fail = match state {
            "noaccess" => Some(ApiError::NotFound("workspace not found".into())),
            "signedout" => Some(ApiError::Unauthorized),
            "offline" => Some(ApiError::Network("can't reach grimoire.example:443: Connection refused (os error 61)".into())),
            "notgrimoire" => Some(ApiError::NotGrimoire("grimoire.example".into())),
            _ => None,
        };
        app.store.upsert_server(server, Some("Grimoire"), Some(vec![Joined { id: "team".into(), title: "Team".into(), role: "editor".into(), read_only: false }]));
        app.store.set_account(server, Some("confused-noodle".into()), Some("t_demo".into()));
        let m = Rc::new(RefCell::new(m));
        app.backend = Backend::Mock(m.clone());
        let mut tx = Tx::default();
        match state {
            "loading" => {
                app.backend = Backend::None;
                app.open_remote(server.into(), "dffddf-jrpu".into(), String::new(), None, &mut tx);
            }
            "gone" => {
                app.open_remote(server.into(), "team".into(), "Team".into(), Some("Team notes.md".into()), &mut tx);
                app.tree_polled(app.remote.as_ref().map_or(0, |r| r.session), Err(ApiError::NotFound("workspace not found".into())), &mut tx);
            }
            _ => app.open_remote(server.into(), "dffddf-jrpu".into(), String::new(), None, &mut tx),
        }
        if state == "signedout" {
            app.switcher.server_issues.retain(|(u, _)| u != server);
            app.switcher.server_issues.push((server.into(), crate::switcher::ServerIssue::SignedOut));
        }
        return;
    }
    let ada = m.add_peer("Team notes.md", 4242, "Ada", "#d6409f");
    let m = Rc::new(RefCell::new(m));
    app.backend = Backend::Mock(m.clone());
    let mut tx = Tx::default();
    app.open_remote(server.into(), "team".into(), "Team".into(), Some("Team notes.md".into()), &mut tx);
    let text = m.borrow().peers[ada].1.ed.editor().text().to_string();
    let at = text.find("the docs").map_or(text.len(), |i| i + "the docs".len());
    m.borrow_mut().peer(ada, |ed| {
        ed.editor_mut().set_selection(Sel::caret(at));
        ed.editor_mut().insert_text(" today");
    });
    app.pump_mock();
    m.borrow_mut().peer_caret(ada, at + " today".len());
    app.pump_mock();
    app.pump_collab();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::tests::mock_server;

    #[test]
    fn connect_flow_gets_a_token_through_the_loopback_redirect() {
        let (base, rx) = mock_server(vec![(200, r#"{"name":"Test Grimoire","signin":"open"}"#.into())]);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let s2 = seen.clone();
        let r = connect_flow(
            &base,
            move |url| {
                *s2.lock().unwrap() = url.to_string();
                let redirect = net::query_param(url, "redirect").unwrap();
                let state = net::query_param(url, "state").unwrap();
                // the browser, after the user approves: back to the loopback with the token
                std::thread::spawn(move || net::get(&format!("{redirect}?token=gr_tok-1&state={state}"), None).unwrap());
                Ok(())
            },
            Duration::from_secs(5),
        );
        let c = r.unwrap();
        assert_eq!((c.name.as_str(), c.token.as_str(), c.account, c.token_id), ("Test Grimoire", "gr_tok-1", None, None));
        let url = seen.lock().unwrap().clone();
        assert!(url.starts_with(&format!("{base}/connect?client=Grimoire%20for%20Mac&redirect=http%3A%2F%2F127.0.0.1%3A")), "{url}");
        assert!(rx.recv().unwrap().starts_with("GET /api/server "));
    }

    #[test]
    fn connect_flow_checks_the_state_and_the_server() {
        let (base, _rx) = mock_server(vec![(200, r#"{"name":"G"}"#.into())]);
        let r = connect_flow(
            &base,
            |url| {
                let redirect = net::query_param(url, "redirect").unwrap();
                std::thread::spawn(move || net::get(&format!("{redirect}?token=t&state=forged"), None));
                Ok(())
            },
            Duration::from_secs(5),
        );
        assert!(r.unwrap_err().to_string().contains("state"));
        let (base, _rx) = mock_server(vec![(404, "nope".into())]);
        assert!(matches!(connect_flow(&base, |_| panic!("no browser for a non-server"), Duration::from_secs(1)), Err(ApiError::NotGrimoire(_))));
        let (base, _rx) = mock_server(vec![(200, r#"{"name":"G"}"#.into())]);
        let r = connect_flow(
            &base,
            |url| {
                let (redirect, state) = (net::query_param(url, "redirect").unwrap(), net::query_param(url, "state").unwrap());
                std::thread::spawn(move || net::get(&format!("{redirect}?error=denied&state={state}"), None));
                Ok(())
            },
            Duration::from_secs(5),
        );
        assert!(r.unwrap_err().to_string().contains("denied"));
    }

    #[test]
    fn rest_client_follows_the_contract() {
        let (base, rx) = mock_server(vec![
            (200, r#"{"head":"abc","files":["a.md","dir/b.md"]}"#.into()),
            (201, r#"{"path":"dir/new.md","version":"v"}"#.into()),
            (200, r#"{"path":"c.md"}"#.into()),
            (200, r#"{"ok":true}"#.into()),
            (200, r#"[{"id":"team","title":"Team","kind":"notes","role":"editor","linkAccess":"none","readOnly":false,"head":"x","joinedVia":"member"}]"#.into()),
            (401, r#"{"error":"not signed in"}"#.into()),
            (403, r#"{"error":"you have read-only access to this repo"}"#.into()),
        ]);
        let api = Api { server: base, token: Some("tok".into()) };
        assert_eq!(api.tree("my ws").unwrap(), vec!["a.md", "dir/b.md"]);
        let req = rx.recv().unwrap();
        assert!(req.starts_with("GET /api/repos/my%20ws/tree HTTP/1.1"), "{req}");
        assert!(req.contains("Authorization: Bearer tok"));
        api.create("w", "dir/new.md").unwrap();
        let req = rx.recv().unwrap();
        assert!(req.starts_with("POST /api/repos/w/files ") && req.contains(r#""path":"dir/new.md""#), "{req}");
        api.rename("w", "a.md", "c.md").unwrap();
        let req = rx.recv().unwrap();
        assert!(req.starts_with("POST /api/repos/w/rename ") && req.contains(r#""from":"a.md""#) && req.contains(r#""to":"c.md""#));
        api.delete("w", "dir/b c.md").unwrap();
        assert!(rx.recv().unwrap().starts_with("DELETE /api/repos/w/files?path=dir%2Fb%20c.md "));
        let ws = api.workspaces().unwrap();
        assert_eq!(ws, vec![Joined { id: "team".into(), title: "Team".into(), role: "editor".into(), read_only: false }]);
        assert!(rx.recv().unwrap().starts_with("GET /api/workspaces "));
        assert_eq!(api.me().unwrap_err(), ApiError::Unauthorized);
        assert_eq!(api.create("w", "x.md").unwrap_err(), ApiError::Forbidden("you have read-only access to this repo".into()));
    }

    #[test]
    fn api_errors_say_what_went_wrong() {
        let (base, _rx) = mock_server(vec![
            (404, r#"{"error":"workspace not found"}"#.into()),
            (404, "<html>Not Found</html>".into()),
            (502, "<html>Bad gateway</html>".into()),
            (200, "<!doctype html><title>Some site</title>".into()),
            (403, r#"{"error":"only the workspace's owners can do this"}"#.into()),
            (200, r#"{"id":"u1","name":"Ann","token":{"id":"t_9","label":"Grimoire for Mac"}}"#.into()),
            (200, r#"{"ok":true}"#.into()),
        ]);
        let api = Api { server: base.clone(), token: Some("tok".into()) };
        assert_eq!(api.tree("w").unwrap_err(), ApiError::NotFound("workspace not found".into()));
        assert!(matches!(api.tree("w").unwrap_err(), ApiError::NotGrimoire(_)));
        assert!(matches!(api.tree("w").unwrap_err(), ApiError::Network(m) if m.contains("HTTP 502")));
        assert!(matches!(api.me().unwrap_err(), ApiError::NotGrimoire(_)));
        assert!(matches!(api.tree("w").unwrap_err(), ApiError::Forbidden(_)));
        // revoke: the token's id from /api/me, then DELETE /api/tokens/:id
        api.revoke(None).unwrap();
        // nothing listening: a network error
        let (l, port) = net::loopback().unwrap();
        drop(l);
        let gone = Api { server: format!("http://127.0.0.1:{port}"), token: None };
        assert!(matches!(gone.me().unwrap_err(), ApiError::Network(_)));
        assert!(matches!(gone.server_info().unwrap_err(), ApiError::Network(_)));
        assert_eq!(backoff_s(1), 1);
        assert_eq!(backoff_s(3), 4);
        assert_eq!(backoff_s(9), 30);
    }

    fn failing_app(fail: ApiError) -> (App, MockRef) {
        let (mut app, m) = mock_app(&[("a.md", "one\n")]);
        m.borrow_mut().fail = Some(fail);
        m.borrow_mut().account = "confused-noodle".into();
        m.borrow_mut().title = "dffddf".into();
        let mut tx = Tx::default();
        app.open_remote("https://grimoire.exe.xyz".into(), "dffddf-jrpu".into(), String::new(), None, &mut tx);
        (app, m)
    }

    #[test]
    fn no_access_is_explained_with_the_account_and_fixes() {
        let (mut app, m) = failing_app(ApiError::NotFound("workspace not found".into()));
        let (title, detail, fixes) = app.problem_page().expect("a problem page, not an endless Loading…");
        assert_eq!(title, "No access to dffddf-jrpu");
        assert!(detail.contains("You don't have access to dffddf-jrpu as confused-noodle on grimoire.exe.xyz"), "{detail}");
        assert_eq!(fixes, vec![Fix::SwitchAccount, Fix::Remove]);
        assert_eq!(app.remote_status().as_deref(), Some("No access"));
        // in the recents with the id standing in for the title, never empty
        assert_eq!(app.store.recent[0].0.name(), "dffddf-jrpu");
        // access granted (the other account): choosing it again loads it, with the server's title
        m.borrow_mut().fail = None;
        let mut tx = Tx::default();
        let w = app.store.recent[0].0.clone();
        app.choose(w, &mut tx);
        assert!(app.problem_page().is_none());
        assert!(app.remote.as_ref().unwrap().loaded);
        assert_eq!(app.store.recent[0].0.name(), "dffddf");
        assert_eq!(app.current.as_ref().unwrap().name(), "dffddf");
        // and "Remove" on a failing one leaves for the sample
        m.borrow_mut().fail = Some(ApiError::Forbidden("no".into()));
        let w = app.store.recent[0].0.clone();
        app.open_remote("https://grimoire.exe.xyz".into(), "dffddf-jrpu".into(), String::new(), None, &mut tx);
        assert_eq!(app.current.as_ref().unwrap().name(), "dffddf", "the title is kept");
        app.apply_fix(Fix::Remove, &mut tx);
        assert!(!app.store.recent.iter().any(|(r, _)| r.same(&w)));
        assert!(app.current.is_none() && app.remote.is_none());
        assert_eq!(app.ed.text(), crate::doc::SAMPLE);
    }

    #[test]
    fn signed_out_offline_and_other_problems() {
        let (app, _m) = failing_app(ApiError::Unauthorized);
        let (title, _, fixes) = app.problem_page().unwrap();
        assert_eq!((title.as_str(), fixes[0]), ("Signed out of grimoire.exe.xyz", Fix::Reconnect));
        assert!(app.switcher.server_issues.iter().any(|(u, i)| u == "https://grimoire.exe.xyz" && *i == ServerIssue::SignedOut));

        let (mut app, m) = failing_app(ApiError::Network("can't reach grimoire.exe.xyz:443: refused".into()));
        let (title, detail, fixes) = app.problem_page().unwrap();
        assert_eq!(title, "Can't reach grimoire.exe.xyz");
        assert!(detail.contains("Trying again in 1 s (attempt 1)"), "{detail}");
        assert_eq!(fixes[0], Fix::RetryNow);
        assert_eq!(app.remote_status().as_deref(), Some("Offline · retrying in 1 s"));
        let mut tx = Tx::default();
        app.apply_fix(Fix::RetryNow, &mut tx);
        assert!(matches!(app.remote.as_ref().unwrap().problem, Some(Problem::Offline { attempt: 2, retry_s: 2, .. })));
        // a stale scheduled retry is dropped
        let session = app.remote.as_ref().unwrap().session;
        app.retry_load(session, Some(1), &mut tx);
        assert!(matches!(app.remote.as_ref().unwrap().problem, Some(Problem::Offline { attempt: 2, .. })));
        // back online
        m.borrow_mut().fail = None;
        app.retry_load(session, Some(2), &mut tx);
        assert!(app.problem_page().is_none());
        assert_eq!(app.ed.text(), "one\n");

        let (app, _m) = failing_app(ApiError::NotGrimoire("grimoire.exe.xyz".into()));
        assert_eq!(app.problem_page().unwrap().0, "grimoire.exe.xyz isn't a Grimoire server");
    }

    #[test]
    fn a_workspace_that_goes_away_while_open_shows_why() {
        let (mut app, m) = mock_app(&[("a.md", "one\n")]);
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), "Team".into(), None, &mut tx);
        let session = app.remote.as_ref().unwrap().session;
        // offline for a while: the note stays, the pill says so
        app.tree_polled(session, Err(ApiError::Network("refused".into())), &mut tx);
        assert_eq!(app.ed.text(), "one\n");
        assert!(app.problem_page().is_none());
        app.tree_polled(session, Ok(vec!["a.md".into(), "b.md".into()]), &mut tx);
        assert!(app.remote.as_ref().unwrap().offline.is_none());
        assert!(app.tree_rows().iter().any(|r| r.rel == "b.md"));
        // deleted (or access removed)
        app.tree_polled(session, Err(ApiError::NotFound("workspace not found".into())), &mut tx);
        assert_eq!(app.problem_page().unwrap().0, "Team is no longer available");
        assert_eq!(m.borrow().app_note, None, "the room was left");
        assert!(app.tree_rows().is_empty());
    }

    #[test]
    fn a_dropped_room_reconnects_back_to_saved_not_loading() {
        let (mut app, _m) = mock_app(&[("a.md", "one\n")]);
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), "Team".into(), None, &mut tx);
        assert_eq!(app.remote_status().as_deref(), Some("Saved"));
        let g = app.remote.as_ref().unwrap().generation;
        app.room_closed(g, 1006, "connection reset", &mut tx);
        assert_eq!(app.remote_status().as_deref(), Some("Offline · reconnecting"));
        // the retry (Net: after collab's backoff) opens the room again; its resync brings no second Synced
        let g = app.remote.as_ref().unwrap().generation;
        app.connect_room(g);
        assert_eq!(app.remote_status().as_deref(), Some("Saved"), "not an endless Loading… after a reconnect");
        app.ed.insert_text("x");
        app.handled(&mut tx);
        assert_eq!(app.ed.text(), "xone\n");
    }

    #[test]
    fn room_urls_and_trees() {
        assert_eq!(ws_url("https://g.example", "my ws", "dir/a b.md"), "wss://g.example/ws?repo=my%20ws&path=dir%2Fa%20b.md");
        assert_eq!(ws_url("http://100.1.2.3:3000", "w", "a.md"), "ws://100.1.2.3:3000/ws?repo=w&path=a.md");
        let root = virtual_root("http://h:3000", "team");
        let e = entries(&root, &["b.md".into(), "dir/a.md".into(), "../x.md".into(), ".hidden/y.md".into(), "pic.png".into()]);
        let rows = files::rows(&e, &root, &Default::default(), "");
        let rels: Vec<_> = rows.iter().map(|r| r.rel.as_str()).collect();
        assert_eq!(rels, vec!["dir", "dir/a.md", "b.md"]);
        assert_eq!(first_note(&e), Some(root.join("b.md")));
        assert_eq!(color_for("u1"), color_for("u1"));
    }

    fn mock_app(notes: &[(&str, &str)]) -> (App, MockRef) {
        let m = Rc::new(RefCell::new(Mock::new(notes)));
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(m.clone());
        (app, m)
    }

    #[test]
    fn a_remote_note_opens_edits_and_shows_cursors_through_a_mocked_room() {
        let (mut app, m) = mock_app(&[("a.md", "# A\nhello\n"), ("dir/b.md", "bee\n")]);
        let ada = m.borrow_mut().add_peer("dir/b.md", 77, "Ada", "#d6409f");
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), String::new(), Some("dir/b.md".into()), &mut tx);
        let rem = app.remote.as_ref().unwrap();
        assert!(rem.loaded && rem.synced);
        assert_eq!(rem.note.as_deref(), Some("dir/b.md"));
        assert_eq!(app.path, Some(app.root.clone().unwrap().join("dir/b.md")));
        assert_eq!(app.ed.text(), "bee\n");
        assert!(!app.ed.is_read_only());
        assert!(app.saver.is_none(), "no local autosave for remote notes");
        assert_eq!(app.remote_status().as_deref(), Some("Saved"));
        assert_eq!(app.tree_rows().iter().map(|r| r.rel.clone()).collect::<Vec<_>>(), vec!["dir", "dir/b.md", "a.md"]);

        // our typing reaches the room and the other user
        app.ed.set_selection(Sel::caret(3));
        app.ed.insert_text("s!");
        app.handled(&mut tx);
        assert_eq!(m.borrow().text("dir/b.md").unwrap(), "bees!\n");
        assert_eq!(m.borrow().peers[ada].1.ed.editor().text(), "bees!\n");

        // theirs reaches us, and our caret stays put
        m.borrow_mut().peer(ada, |ed| {
            ed.editor_mut().set_selection(Sel::caret(0));
            ed.editor_mut().insert_text("Two ");
        });
        app.pump_mock();
        assert_eq!(app.ed.text(), "Two bees!\n");
        assert_eq!(app.ed.selection(), Sel::caret(9));

        // their cursor, with name and colour
        m.borrow_mut().peer_caret(ada, 3);
        app.pump_mock();
        let carets = app.remote_carets();
        assert_eq!(carets.len(), 1);
        assert_eq!((carets[0].0.name.as_str(), carets[0].0.color.as_str(), carets[0].1, carets[0].2), ("Ada", "#d6409f", 3, 3));

        // ours is published while the editor has the keys, and withdrawn while the filter has them
        let seen = |m: &MockRef| m.borrow().peers[ada].1.ed.remote_cursors().len();
        assert_eq!(seen(&m), 1);
        app.focus_filter();
        app.handled(&mut tx);
        m.borrow_mut().settle();
        assert_eq!(seen(&m), 0);
        app.blur_filter();
        app.handled(&mut tx);
        assert_eq!(seen(&m), 1);

        // switching notes leaves the room
        app.open_note(app.root.clone().unwrap().join("a.md"), &mut tx);
        assert_eq!(app.ed.text(), "# A\nhello\n");
        assert_eq!(m.borrow().app_note.as_deref(), Some("a.md"));
        m.borrow_mut().settle();
        assert_eq!(seen(&m), 0, "our presence left with us");
        assert_eq!(app.store.last_note(app.current.as_ref().unwrap()).as_deref(), Some("a.md"));
    }

    #[test]
    fn remote_notes_are_created_renamed_and_deleted_on_the_server() {
        let (mut app, m) = mock_app(&[("a.md", "one\n")]);
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), "Team".into(), None, &mut tx);
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("a.md"));
        app.new_note(&mut tx);
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("Untitled.md"));
        assert!(m.borrow().tree.contains(&"Untitled.md".to_string()));
        app.ed.insert_text("# Fresh");
        app.handled(&mut tx);
        assert_eq!(m.borrow().text("Untitled.md").unwrap(), "# Fresh");
        app.start_rename("Untitled.md");
        app.renaming.as_mut().unwrap().1.text = "ideas/Fresh".into();
        app.submit_rename(&mut tx);
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("ideas/Fresh.md"));
        assert_eq!(app.ed.text(), "# Fresh");
        assert!(app.tree_rows().iter().any(|r| r.rel == "ideas/Fresh.md"));
        app.remote_delete("ideas/Fresh.md".into(), &mut tx);
        assert!(!m.borrow().tree.iter().any(|p| p.contains("Fresh")));
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("a.md"), "the next note opens");
    }

    #[test]
    fn read_only_rooms_and_missing_notes() {
        let (mut app, m) = mock_app(&[("a.md", "one\n")]);
        m.borrow_mut().relays[0].1.read_only = true;
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "gh".into(), String::new(), None, &mut tx);
        assert!(app.ed.is_read_only());
        app.ed.insert_text("x");
        app.handled(&mut tx);
        assert_eq!(app.ed.text(), "one\n");
        assert_eq!(app.remote_status().as_deref(), Some("Read only · Saved"));
        // a note that isn't on the server: the room says notfound, the editor stays read-only
        app.path = None;
        app.open_remote_note("gone.md".into(), &mut tx);
        assert_eq!(app.remote_status().as_deref(), Some("This note doesn't exist on the server"));
        assert!(app.ed.is_read_only());
    }

    #[test]
    fn switching_workspaces_keeps_one_open() {
        let dir = std::env::temp_dir().join(format!("grimoire-switch-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::doc::write(&dir.join("local.md"), "local text").unwrap();
        let (mut app, m) = mock_app(&[("a.md", "one\n")]);
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), String::new(), None, &mut tx);
        app.open_local(dir.clone(), &mut tx);
        assert!(app.remote.is_none());
        assert_eq!(m.borrow().app_note, None, "the room was left");
        assert_eq!(app.ed.text(), "local text");
        assert!(app.ed.collab().is_none());
        assert_eq!(app.store.recent.len(), 2);
        assert!(matches!(&app.store.recent[0].0, WsRef::Local { .. }));
        // and back through the switcher's list
        let w = app.store.recent[1].0.clone();
        app.choose(w, &mut tx);
        assert_eq!(app.ed.text(), "one\n");
        // a bad URL in the field
        app.toggle_switcher();
        app.switcher.field = Some(crate::switcher::Field::AddRemote);
        app.switcher.input.text = "https://g.example/settings".into();
        app.submit_field(&mut tx);
        assert!(app.switcher.error.is_some() && app.switcher.open);
        app.switcher.input.text = "https://g.example/app/team/a.md".into();
        app.submit_field(&mut tx);
        assert!(!app.switcher.open);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The browser's part of the connect flow, without a browser: sign in by name (dev login) as "Mac user",
    /// approve on /connect, and follow the redirect to our loopback listener.
    fn it_browser(url: &str) -> Result<(), String> {
        let u = net::parse_url(url)?;
        let base = u.origin();
        let form = format!("name=Mac%20user&next={}", net::enc(&u.path));
        let (st, h, _) = net::raw(
            "POST",
            &format!("{base}/auth/dev"),
            &[("Origin", &base), ("Content-Type", "application/x-www-form-urlencoded")],
            Some(form.as_bytes()),
        )?;
        let cookie = h.iter().find(|(k, _)| k == "set-cookie").map(|(_, v)| v.split(';').next().unwrap_or("").to_string()).ok_or(format!("no cookie ({st})"))?;
        let (st, _, page) = net::raw("GET", url, &[("Cookie", &cookie)], None)?;
        let page = String::from_utf8_lossy(&page).into_owned();
        assert!(st == 200 && page.contains("Allow"), "approval page: {st} {page}");
        let q = |k: &str| net::query_param(&u.path, k).unwrap_or_default();
        let body = format!("client={}&redirect={}&state={}&decision=allow", net::enc(&q("client")), net::enc(&q("redirect")), net::enc(&q("state")));
        let (st, h, _) = net::raw(
            "POST",
            &format!("{base}/connect"),
            &[("Origin", &base), ("Cookie", &cookie), ("Content-Type", "application/x-www-form-urlencoded")],
            Some(body.as_bytes()),
        )?;
        let loc = h.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone()).ok_or(format!("no redirect ({st})"))?;
        assert!(loc.starts_with("http://127.0.0.1:"), "{loc}");
        std::thread::spawn(move || net::get(&loc, None));
        Ok(())
    }

    /// Against a real server (a scratch one: `GRIMOIRE_IT_SERVER=http://host:port`, workspace
    /// `GRIMOIRE_IT_WS` (notes), note `GRIMOIRE_IT_NOTE` (Welcome.md)): connect through /connect, open the
    /// workspace and the note over the real WebSocket, wait for "Bob was here" from a browser editing the same
    /// note, type "Mac was here", publish our caret, see Bob's caret, and print the final text.
    #[test]
    #[ignore]
    fn integration_against_a_server() {
        let Ok(server) = std::env::var("GRIMOIRE_IT_SERVER") else { return };
        let ws = std::env::var("GRIMOIRE_IT_WS").unwrap_or_else(|_| "notes".into());
        let note = std::env::var("GRIMOIRE_IT_NOTE").unwrap_or_else(|_| "Welcome.md".into());
        let dir = std::env::temp_dir().join(format!("grimoire-it-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let q: Arc<Mutex<Vec<Update>>> = Arc::default();
        let mut app = App::new("", None, true);
        app.backend = Backend::Net(Handle::Queue(q.clone()));
        app.tokens = crate::workspaces::Tokens::File(dir.join("tokens.json"));
        app.store = crate::workspaces::Store::load(Some(dir.clone()));
        app.opener = it_browser;
        let mut tx = Tx::default();
        let drain = |app: &mut App, tx: &mut Tx| {
            let fs: Vec<Update> = std::mem::take(&mut *q.lock().unwrap());
            for f in fs {
                f(app, tx);
            }
        };
        let wait = |app: &mut App, tx: &mut Tx, what: &str, secs: u64, ok: &dyn Fn(&App) -> bool| {
            let t = std::time::Instant::now();
            while !ok(app) {
                assert!(t.elapsed().as_secs() < secs, "timed out: {what} (status {:?}, text {:?})", app.remote_status(), app.ed.text());
                drain(app, tx);
                std::thread::sleep(Duration::from_millis(20));
            }
            eprintln!("it: {what} ({} ms)", t.elapsed().as_millis());
        };
        app.open_remote(server.clone(), ws.clone(), String::new(), Some(note.clone()), &mut tx);
        wait(&mut app, &mut tx, "connected, token stored", 30, &|a| a.tokens.get(&server).is_some());
        wait(&mut app, &mut tx, "workspace loaded", 30, &|a| a.remote.as_ref().is_some_and(|r| r.loaded));
        wait(&mut app, &mut tx, "joined workspaces listed", 10, &|a| a.store.server(&server).is_some_and(|s| !s.joined.is_empty()));
        eprintln!("it: joined {:?}", app.store.server(&server).map(|s| s.joined.clone()));
        eprintln!("it: tree {:?}", app.remote.as_ref().unwrap().tree_list);
        wait(&mut app, &mut tx, "note synced", 30, &|a| a.remote.as_ref().is_some_and(|r| r.synced && r.note.as_deref() == Some(note.as_str())));
        eprintln!("it: status {:?}", app.remote_status());
        wait(&mut app, &mut tx, "Bob's edit arrived", 120, &|a| a.ed.text().contains("Bob was here"));
        // type at the end of the first line, caret stays there (published)
        let end = app.ed.text().find('\n').unwrap_or(app.ed.text().len());
        app.ed.set_selection(Sel::caret(end));
        app.ed.insert_text(" Mac was here");
        app.handled(&mut tx);
        // the caret publish is throttled: let its wake-up run
        let t = std::time::Instant::now();
        while t.elapsed() < Duration::from_millis(150) {
            drain(&mut app, &mut tx);
            std::thread::sleep(Duration::from_millis(10));
        }
        wait(&mut app, &mut tx, "Bob's caret visible", 60, &|a| a.remote_carets().iter().any(|(c, _, _)| c.name == "Bob"));
        wait(&mut app, &mut tx, "Bob's second edit (after seeing ours)", 60, &|a| a.ed.text().contains("Bob saw Mac"));
        std::thread::sleep(Duration::from_millis(500));
        drain(&mut app, &mut tx);
        let carets: Vec<_> = app.remote_carets().iter().map(|(c, a, h)| format!("{} {} {a}-{h}", c.name, c.color)).collect();
        eprintln!("it: remote carets {carets:?}");
        println!("IT-TEXT-BEGIN\n{}\nIT-TEXT-END", app.ed.text());
        // REST: create, rename, delete a note
        app.new_note(&mut tx);
        wait(&mut app, &mut tx, "new note created and open", 30, &|a| a.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some("Untitled.md") && r.synced));
        app.ed.insert_text("# From the Mac");
        app.handled(&mut tx);
        app.remote_rename("Untitled.md".into(), "From Mac".into(), &mut tx);
        wait(&mut app, &mut tx, "renamed", 30, &|a| a.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some("From Mac.md") && r.synced));
        assert_eq!(app.ed.text(), "# From the Mac");
        app.remote_delete("From Mac.md".into(), &mut tx);
        wait(&mut app, &mut tx, "deleted", 30, &|a| a.remote.as_ref().is_some_and(|r| !r.tree_list.iter().any(|p| p == "From Mac.md")));
        app.close_room();
        drain(&mut app, &mut tx);
        std::thread::sleep(Duration::from_millis(300));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

