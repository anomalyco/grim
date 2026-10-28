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

/// The open note's room editor: the staged one while a renamed note's new room syncs, else the editor's.
macro_rules! room_ed {
    ($s:expr) => {
        match $s.staged.as_deref_mut() {
            Some(c) => Some(c),
            None => $s.ed.collab_mut(),
        }
    };
}

macro_rules! room_ed_ref {
    ($s:expr) => {
        match $s.staged.as_deref() {
            Some(c) => Some(c),
            None => $s.ed.collab(),
        }
    };
}
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
    /// 404 from the Grimoire API (`{error}`): no such folder or note.
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

/// Stands in for the network: answers `(method, path, body)` with `(status, body)` (headless runs and tests:
/// `fake::FakeRest`).
#[derive(Clone)]
pub struct Fake(pub Arc<FakeFn>);

/// `(method, path, body)` → `(status, body)`.
pub type FakeFn = dyn Fn(&str, &str, Option<&Value>) -> (u16, String) + Send + Sync;

impl std::fmt::Debug for Fake {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Fake")
    }
}

/// The REST API of one server, with the app token.
#[derive(Clone, Debug)]
pub struct Api {
    pub server: String,
    pub token: Option<String>,
    /// Without a token: who the requests come from (the `X-Grimoire-Guest` headers, as the web's guests send).
    pub guest: Option<crate::workspaces::Guest>,
    /// In-process answers instead of the network (headless, tests).
    pub fake: Option<Fake>,
}

impl Api {
    pub fn new(server: impl Into<String>, token: Option<String>) -> Api {
        Api { server: server.into(), token, guest: None, fake: None }
    }

    fn host(&self) -> String {
        net::parse_url(&self.server).map_or_else(|_| self.server.clone(), |u| u.display_host())
    }

    /// A guest's headers: its id, name and colour, and the server's own origin (what its pages send; the
    /// server refuses a guest's writes from anywhere else). None with a token.
    fn guest_headers(&self) -> Vec<(&'static str, String)> {
        let Some(g) = self.guest.as_ref().filter(|_| self.token.is_none()) else { return Vec::new() };
        let origin = net::parse_url(&self.server).map(|u| u.origin()).unwrap_or_default();
        vec![("X-Grimoire-Guest", g.id.clone()), ("X-Grimoire-Guest-Name", net::enc(&g.name)), ("X-Grimoire-Guest-Color", g.color.clone()), ("Origin", origin)]
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        let r = match &self.fake {
            Some(f) => {
                let (status, body) = (f.0)(method, path, body);
                net::Response { status, body: body.into_bytes() }
            }
            None => {
                // a guest: its id, name and colour, and the server's own origin (what its pages send; the server
                // refuses a guest's writes from anywhere else)
                let extra = self.guest_headers();
                let extra: Vec<(&str, &str)> = extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
                net::request_with(method, &format!("{}{path}", self.server), self.token.as_deref(), &extra, body).map_err(ApiError::Network)?
            }
        };
        self.check(&r)
    }

    /// A response as the API's JSON, or what went wrong.
    fn check(&self, r: &net::Response) -> Result<Value, ApiError> {
        let message = || r.json().ok().and_then(|v| v["error"].as_str().map(str::to_string));
        match r.status {
            401 => return Err(ApiError::Unauthorized),
            403 => return Err(ApiError::Forbidden(message().unwrap_or_else(|| "forbidden".into()))),
            404 => return Err(message().map_or_else(|| ApiError::NotGrimoire(self.host()), ApiError::NotFound)),
            413 => return Err(ApiError::Other(message().unwrap_or_else(|| "the image is too large (10 MB at most)".into()))),
            502..=504 => return Err(ApiError::Network(format!("{} is unavailable (HTTP {})", self.host(), r.status))),
            _ if !r.ok() => return Err(ApiError::Other(message().unwrap_or_else(|| format!("HTTP {}", r.status)))),
            _ => {}
        }
        if r.body.is_empty() { Ok(Value::Null) } else { r.json().map_err(|_| ApiError::NotGrimoire(self.host())) }
    }

    /// `POST /api/repos/:id/images?note=&name=`, the image as the raw body (what the web's `api.uploadImage`
    /// sends): stored in `images/` next to `note` and committed; the Markdown that shows it.
    pub fn upload_image(&self, id: &str, note: &str, name: &str, bytes: &[u8]) -> Result<String, ApiError> {
        let path = format!("/api/repos/{}/images?note={}&name={}", net::enc(id), net::enc(note), net::enc(name));
        let r = match &self.fake {
            Some(f) => {
                let (status, body) = (f.0)("POST", &path, Some(&json!({ "bytes": bytes.len() })));
                net::Response { status, body: body.into_bytes() }
            }
            None => {
                let auth = self.token.as_deref().map(|t| format!("Bearer {t}"));
                let mut headers = vec![("Accept", "application/json"), ("Content-Type", image_type(name))];
                if let Some(a) = &auth {
                    headers.push(("Authorization", a));
                }
                // a guest uploads as the web's guests do
                let guest = self.guest_headers();
                headers.extend(guest.iter().map(|(k, v)| (*k, v.as_str())));
                let (status, _, body) = net::raw("POST", &format!("{}{path}", self.server), &headers, Some(bytes)).map_err(ApiError::Network)?;
                net::Response { status, body }
            }
        };
        let v = self.check(&r)?;
        v["markdown"].as_str().map(str::to_string).ok_or_else(|| ApiError::Other("the server sent no Markdown for the image".into()))
    }

    /// `GET /api/server` (no auth): `{name, publicUrl, google, devLogin, version}`.
    pub fn server_info(&self) -> Result<Value, ApiError> {
        match (Api { token: None, ..self.clone() }).call("GET", "/api/server", None) {
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

    /// `GET /api/workspaces/:id` (title, readOnly, canRemove), falling back to the older `/api/repos/:id` when
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

    /// A new note with the server's own first text (`# <name>`), as the web's "Create it" makes.
    pub fn create_titled(&self, id: &str, path: &str) -> Result<String, ApiError> {
        let v = self.call("POST", &format!("/api/repos/{}/files", net::enc(id)), Some(&json!({ "path": path })))?;
        Ok(v["path"].as_str().unwrap_or(path).to_string())
    }

    pub fn create(&self, id: &str, path: &str) -> Result<(), ApiError> {
        self.call("POST", &format!("/api/repos/{}/files", net::enc(id)), Some(&json!({ "path": path, "content": "" }))).map(|_| ())
    }

    pub fn rename(&self, id: &str, from: &str, to: &str) -> Result<(), ApiError> {
        self.call("POST", &format!("/api/repos/{}/rename", net::enc(id)), Some(&json!({ "from": from, "to": to }))).map(|_| ())
    }

    /// A folder and everything under it to `to`, in one commit (`{folder: true}`).
    pub fn rename_folder(&self, id: &str, from: &str, to: &str) -> Result<(), ApiError> {
        self.call("POST", &format!("/api/repos/{}/rename", net::enc(id)), Some(&json!({ "from": from, "to": to, "folder": true }))).map(|_| ())
    }

    /// A folder and everything under it, in one commit.
    pub fn delete_folder(&self, id: &str, dir: &str) -> Result<(), ApiError> {
        self.call("DELETE", &format!("/api/repos/{}/files?folder={}", net::enc(id), net::enc(dir)), None).map(|_| ())
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

impl Api {
    /// `GET /api/repos/:id`: the workspace as a repo (`kind`, `ghOwner`/`ghName`, `status`, `readOnly`,
    /// `canRemove`).
    pub fn repo(&self, id: &str) -> Result<Value, ApiError> {
        self.call("GET", &format!("/api/repos/{}", net::enc(id)), None)
    }

    /// `PATCH /api/me {name}` ("Change name…"): the name saved (trimmed, at most 60 characters).
    pub fn set_name(&self, name: &str) -> Result<String, ApiError> {
        let v = self.call("PATCH", "/api/me", Some(&json!({ "name": name })))?;
        Ok(v["name"].as_str().unwrap_or(name).to_string())
    }

    /// `POST /api/workspaces {title}` (New → Remote folder), or `POST /api/repos` on servers without it:
    /// `(id, title)`.
    pub fn create_workspace(&self, title: &str) -> Result<(String, String), ApiError> {
        let body = json!({ "title": title });
        let v = match self.call("POST", "/api/workspaces", Some(&body)) {
            Err(ApiError::NotFound(_) | ApiError::NotGrimoire(_)) => self.call("POST", "/api/repos", Some(&body))?,
            Err(ApiError::Other(m)) if m.contains("405") || m.contains("method not allowed") => self.call("POST", "/api/repos", Some(&body))?,
            r => r?,
        };
        let id = v["id"].as_str().ok_or_else(|| ApiError::Other("the server sent no folder id".into()))?.to_string();
        Ok((id.clone(), v["title"].as_str().unwrap_or(&id).to_string()))
    }

    /// `POST /api/repos {github, readOnly}` (Open → GitHub repo): the repo, maybe still importing.
    pub fn add_github(&self, github: &str, read_only: bool) -> Result<Value, ApiError> {
        self.call("POST", "/api/repos", Some(&json!({ "github": github, "readOnly": read_only })))
    }

    /// `GET /api/config`: `githubAppSlug` (editable GitHub repos).
    pub fn config(&self) -> Result<Value, ApiError> {
        self.call("GET", "/api/config", None)
    }

    /// `DELETE /api/repos/:id` ("Remove folder…", its maker).
    pub fn remove_workspace(&self, id: &str) -> Result<(), ApiError> {
        self.call("DELETE", &format!("/api/repos/{}", net::enc(id)), None).map(|_| ())
    }

    /// `DELETE /api/workspaces/:id/join` (a folder row's ×).
    pub fn leave(&self, id: &str) -> Result<(), ApiError> {
        self.call("DELETE", &format!("/api/workspaces/{}/join", net::enc(id)), None).map(|_| ())
    }

    /// `POST /api/repos/:id/shares` (the sidebar's "Share with an agent"): this person's agent link for the
    /// folder (`{id, url}`, made on first use).
    pub fn agent_link(&self, id: &str) -> Result<String, ApiError> {
        let v = self.call("POST", &format!("/api/repos/{}/shares", net::enc(id)), Some(&json!({})))?;
        v["url"].as_str().map(str::to_string).ok_or_else(|| ApiError::Other("the server sent no link".into()))
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
    let info = Api::new(server, None).server_info()?;
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

fn ws_connect(server: &str, token: Option<&str>, guest: Option<&crate::workspaces::Guest>, id: &str, path: &str) -> Result<Ws, String> {
    let mut url = ws_url(server, id, path);
    // a guest (no token) joins with its id, name and colour, as the web's guests do
    if let Some(g) = guest.filter(|_| token.is_none()) {
        url.push_str(&format!("&anon={}&name={}&color={}", net::enc(&g.id), net::enc(&g.name), net::enc(&g.color)));
    }
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
pub fn spawn_socket(handle: Handle, api: &Api, id: String, path: String, generation: u64) -> Sender<ToSock> {
    let (tx, rx) = mpsc::channel::<ToSock>();
    let (server, token, guest) = (api.server.clone(), api.token.clone(), api.guest.clone());
    std::thread::spawn(move || {
        let (code, reason) = match ws_connect(&server, token.as_deref(), guest.as_ref(), &id, &path) {
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
    /// The server's REST API beyond tree and notes (folders, agent links, tokens), when a run needs it.
    pub rest: Option<Arc<Mutex<crate::fake::FakeRest>>>,
    /// The app has no token: it's a guest there.
    pub guest: bool,
    /// Files that aren't notes (images), by path: what `/raw` serves and uploads add.
    pub files: Vec<(String, Vec<u8>)>,
    /// Uploads wait in `held` until a test lets them finish (`App::finish_mock_uploads`).
    pub hold_uploads: bool,
    pub held: Vec<(u64, Vec<Result<String, String>>)>,
    /// Every upload: `note name size`.
    pub uploads: Vec<String>,
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
            guest: false,
            rest: None,
            files: Vec::new(),
            hold_uploads: false,
            held: Vec::new(),
            uploads: Vec::new(),
        }
    }

    /// An image upload, named as the server names it (`ops.ts uploadImage`): `images/` next to the note, the
    /// name kept, `name-2.png`… past other contents, the same contents reused; the Markdown that shows it.
    pub fn upload(&mut self, note: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
        self.uploads.push(format!("{note} {name} {}", bytes.len()));
        if bytes.is_empty() {
            return Err("the file is empty".into());
        }
        let (stem, ext) = name.rsplit_once('.').unwrap_or((name, "png"));
        let dir = match note.rsplit_once('/') {
            Some((d, _)) => format!("{d}/images"),
            None => "images".to_string(),
        };
        for n in 1.. {
            let file = if n == 1 { format!("{stem}.{ext}") } else { format!("{stem}-{n}.{ext}") };
            let path = format!("{dir}/{file}");
            match self.files.iter().find(|(p, _)| *p == path) {
                Some((_, b)) if b != bytes => continue,
                Some(_) => {}
                None => self.files.push((path.clone(), bytes.to_vec())),
            }
            return Ok(format!("![{stem}](images/{})", crate::drop::encode(&file)));
        }
        unreachable!()
    }

    /// `GET …/raw?path=` against `files`.
    pub fn raw(&self, url: &str) -> (u16, Vec<u8>) {
        let path = net::query_param(url, "path").unwrap_or_default();
        self.files.iter().find(|(p, _)| *p == path).map_or((404, b"{\"error\":\"not found\"}".to_vec()), |(_, b)| (200, b.clone()))
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
    /// The workspace is read-only (a read-only GitHub copy).
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
    /// The note a link asked for (Open → URL): "No note at …" if the folder doesn't have it.
    pub asked: Option<String>,
    /// The heading a link asked for, gone to once the note's room syncs.
    pub goto: Option<String>,
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
    /// `GET /api/repos/:id` (`kind`, `status`, `readOnly`, `canRemove`…), from the last load.
    pub repo: Value,
    /// `/api/me` as last loaded (`name`, `email`…).
    pub me: Value,
    /// The open note's line authors (its room's `blame`), following the text.
    pub authors: Option<crate::authors::LineAuthors>,
}

/// Why a remote workspace isn't showing.
#[derive(Clone, Debug, PartialEq)]
pub enum Problem {
    /// No token, or the server refused it (revoked, expired): Reconnect.
    SignedOut,
    /// Opening it: the server says there's no such folder (404: deleted, or a wrong URL).
    Missing,
    /// It was open, and now it's gone (deleted).
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
    RetryNow,
    TryAgain,
    Remove,
}

impl Fix {
    pub fn label(self) -> &'static str {
        match self {
            Fix::Reconnect => "Reconnect",
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
            asked: None,
            goto: None,
            focused: false,
            problem: None,
            loading: false,
            account: None,
            offline: None,
            tree_list: Vec::new(),
            repo: Value::Null,
            me: Value::Null,
            authors: None,
        }
    }

    pub fn id(&self) -> &str {
        match &self.ws {
            WsRef::Remote { id, .. } => id,
            WsRef::Local { .. } => "",
        }
    }
}

/// An image's content type from its name (the server sniffs the bytes anyway).
pub fn image_type(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
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
    /// The REST API of `server` with `token` (in-process answers when the mock server has them).
    pub fn api_with(&self, server: &str, token: Option<String>) -> Api {
        let fake = match &self.backend {
            Backend::Mock(m) => m.borrow().rest.clone().map(|r| crate::fake::transport(&r)),
            _ => None,
        };
        // no token: a guest (every folder is public; only creating folders needs an account)
        let guest = if token.is_none() { self.store.guest.clone() } else { None };
        Api { server: server.to_string(), token, guest, fake }
    }

    /// The REST API of `server` with the token stored for it.
    pub fn api_for(&self, server: &str) -> Api {
        self.api_with(server, self.tokens.get(server))
    }

    fn now_ms(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }

    /// Open a remote workspace — signed in with the server's token, or without one as a guest (every folder is
    /// public: no sign-in, no browser) — its details and tree; `note` (or the one open last) opens once the
    /// tree is there.
    pub fn open_remote(&mut self, server: String, id: String, title: String, note: Option<String>, tx: &mut Tx) {
        self.leave_workspace();
        let title = if title.is_empty() { self.store.known_title(&server, &id).unwrap_or_default() } else { title };
        let ws = WsRef::Remote { server: server.clone(), id: id.clone(), title };
        // a note asked for by its link: `.md` added when it has none (old /r/ links), as on the web
        let asked = note.map(|n| if n.to_lowercase().ends_with(".md") { n } else { format!("{n}.md") });
        let note = asked.clone().or_else(|| self.store.last_note(&ws));
        let token = self.tokens.get(&server);
        let mut r = Remote::new(ws.clone(), self.api_with(&server, token.clone()));
        r.session = next_gen();
        r.generation = next_gen();
        r.account = self.store.server(&server).and_then(|s| s.account.clone());
        r.asked = asked;
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
        tx.scroll_to_y("scroll", 0.0);
        self.pending_note = note;
        match &self.backend {
            Backend::Net(h) => {
                if let Some(r) = self.remote.as_mut() {
                    r.loading = true;
                }
                spawn_load(h.clone(), self.api_with(&server, token), id, session);
            }
            Backend::Mock(m) => {
                // the folder's images come from the mock's files
                // (weak: a thread-local mustn't keep the mock alive past the thread's other locals)
                let m = Rc::downgrade(m);
                crate::rimages::set_fake(Some(Rc::new(move |url: &str| m.upgrade().map(|m| m.borrow().raw(url)).ok_or_else(|| "no server".to_string()))));
                let r = self.mock_load(&server, &id, true);
                self.remote_loaded(session, r, tx);
            }
            Backend::None => {}
        }
    }

    /// Loading a workspace from the mock server: its account, details and repo from its REST stand-in when
    /// it has one, its notes from the mock's tree.
    fn mock_load(&self, server: &str, id: &str, first: bool) -> Result<Loaded, (ApiError, Option<Value>)> {
        let Backend::Mock(m) = &self.backend else { return Err((ApiError::Other("no mock".into()), None)) };
        let (fail, account, title, list, rest, guest) = {
            let m = m.borrow();
            (m.fail.clone(), m.account.clone(), m.title.clone(), m.tree.clone(), m.rest.is_some(), m.guest)
        };
        let user = if guest {
            self.store.guest.clone().unwrap_or_default().me()
        } else if first {
            json!({ "id": "me", "name": account, "color": "#0090ff", "kind": "human" })
        } else {
            json!({ "id": "me", "name": account })
        };
        if let Some(e) = fail {
            return Err((e, first.then_some(user)));
        }
        if rest {
            let token = (!guest).then(|| "t_mock".to_string());
            let mut l = load(&self.api_with(server, token), id)?;
            l.list = list;
            return Ok(l);
        }
        let info = json!({ "title": title });
        Ok(Loaded { me: user, info, list, repo: Value::Null })
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
                    let api = self.api_with(server, Some(old));
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
                if let Some((s, title)) = self.switcher.pending_new.take_if(|(s, _)| s == server) {
                    self.create_remote(s, title, tx);
                } else if let Some((WsRef::Remote { server, id, title }, note)) = here {
                    self.open_remote(server, id, title, note, tx);
                }
            }
            Err(e) => {
                if self.switcher.pending_new.take_if(|(s, _)| s == server).is_some() {
                    let msg = crate::actions::new_remote_error(server, &e);
                    self.new_remote_failed_pub(msg);
                }
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
            // signed in there before and the token is gone: signed out; never signed in: a guest, which is fine
            if self.store.server(server).is_some() && !self.switcher.server_issues.iter().any(|(u, _)| u == server) {
                self.switcher.server_issues.push((server.to_string(), ServerIssue::SignedOut));
            }
            return;
        };
        let (h, api) = (h.clone(), self.api_with(server, Some(token)));
        std::thread::spawn(move || {
            let me = api.me();
            let r = me.clone().and_then(|_| api.workspaces());
            let info = api.server_info().ok();
            let name = info.as_ref().and_then(|v| v["name"].as_str().map(str::to_string));
            let google = info.as_ref().and_then(|v| v["google"].as_bool());
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
                        let email = me["email"].as_str().filter(|e| !e.is_empty()).map(str::to_string);
                        app.store.set_details(&api.server, email, google);
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
                    (Err(ApiError::Unauthorized), _) | (_, Err(ApiError::Unauthorized)) => app.signed_out(&api.server, tx),
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
            Ok(Loaded { me, info, list, repo }) => {
                rem.repo = repo;
                rem.me = me.clone();
                let id = me["id"].as_str().unwrap_or("mac").to_string();
                let name = me["name"].as_str().unwrap_or("Mac").to_string();
                let color = me["color"].as_str().map_or_else(|| color_for(&id), str::to_string);
                let kind = me["kind"].as_str().unwrap_or("human").to_string();
                rem.user = json!({ "id": id, "name": name, "color": color, "kind": kind });
                // a guest has no account (the account row says "Sign in")
                rem.account = (kind != "guest").then_some(name);
                rem.read_only = info["readOnly"].as_bool().unwrap_or(false);
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
                if let Some(asked) = self.remote.as_mut().and_then(|r| r.asked.take())
                    && want.is_none()
                {
                    self.show_toast(format!("No note at “{asked}”"));
                }
                if let Some(p) = want.or_else(|| first_note(&self.files)) {
                    self.open_note(p, tx);
                }
            }
            Err((e, me)) => {
                if let Some(n) = me.as_ref().and_then(|m| m["name"].as_str()) {
                    rem.account = Some(n.to_string());
                }
                if e == ApiError::Unauthorized && rem.api.token.is_some() {
                    let server = rem.api.server.clone();
                    self.signed_out(&server, tx);
                    return;
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
                    ApiError::NotFound(_) | ApiError::Forbidden(_) => Problem::Missing,
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
            Backend::Mock(_) => {
                let (server, id) = (rem.api.server.clone(), rem.id().to_string());
                let r = self.mock_load(&server, &id, false);
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
        Some(match p {
            Problem::SignedOut => (
                format!("Signed out of {host}"),
                format!("Grimoire for Mac isn't connected to {host}: its access was revoked or has expired. Reconnect to sign in again in the browser."),
                vec![Fix::Reconnect, Fix::Remove],
            ),
            Problem::Missing => ("No such folder".to_string(), format!("“{}” doesn't exist on {host}.", rem.id()), vec![Fix::Remove]),
            Problem::Gone => (format!("{name} is no longer available"), format!("{name} on {host} was deleted."), vec![Fix::Remove]),
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
                "What answered there isn't Grimoire. Check the URL: it looks like https://server/app/folder.".to_string(),
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
            Fix::Reconnect => self.start_connect(&server),
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
        tx.scroll_to_y("scroll", 0.0);
    }

    /// "Disconnect": revoke the app's token on the server (best effort) and forget it and the server here.
    /// An open workspace there shows "Signed out".
    pub fn disconnect(&mut self, server: &str, tx: &mut Tx) {
        let token = self.tokens.get(server);
        let token_id = self.store.server(server).and_then(|s| s.token_id.clone());
        let host = WsRef::Remote { server: server.to_string(), id: String::new(), title: String::new() }.location();
        if let (Some(token), Backend::Net(h)) = (token, &self.backend) {
            let (h, api) = (h.clone(), self.api_with(server, Some(token)));
            std::thread::spawn(move || {
                let r = api.revoke(token_id.as_deref());
                h.update(move |app, _| match r {
                    Ok(()) => eprintln!("grimoire: {}: token revoked", api.server),
                    Err(e) => app.show_toast(format!("Disconnected here, but the server didn't revoke the token ({e}).")),
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

    /// The server refused this app's token for `server` (revoked on the web, expired): it's dropped and the app
    /// carries on as a guest there — the open folder on that server opens again as a guest (readable and
    /// editable; every folder is public), the account row says "Sign in", and the toast says "Signed out of
    /// <host>". Seen by any request with the token that gets a 401, and by `check_tokens`.
    pub fn signed_out(&mut self, server: &str, tx: &mut Tx) {
        if self.tokens.get(server).is_none() && self.store.server(server).is_none() {
            return;
        }
        self.tokens.remove(server);
        self.store.remove_server(server);
        self.switcher.server_issues.retain(|(u, _)| u != server);
        self.switcher.account_open = false;
        self.show_toast(format!("Signed out of {}", crate::menu::host(server)));
        let open = self.remote.as_ref().filter(|r| r.api.server == server).map(|r| (r.ws.clone(), r.note.clone().or_else(|| self.pending_note.clone())));
        if let Some((WsRef::Remote { server, id, title }, note)) = open {
            self.open_remote(server, id, title, note, tx);
        }
        self.handled(tx);
    }

    /// Ask each server the app has a token for who it is (`GET /api/me`): a 401 there is a token revoked on
    /// the web (folders stay readable with a bad token, so nothing else would notice): `signed_out`. At
    /// launch and when the window gains focus (at most every 30 s).
    pub fn check_tokens(&mut self) {
        let Backend::Net(h) = &self.backend else { return };
        if self.tokens_checked.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
            return;
        }
        self.tokens_checked = Some(std::time::Instant::now());
        let mut servers: Vec<String> = self.store.servers.iter().map(|s| s.url.clone()).collect();
        if let Some(r) = self.remote.as_ref().filter(|r| r.api.token.is_some() && !servers.contains(&r.api.server)) {
            servers.push(r.api.server.clone());
        }
        for server in servers {
            let Some(token) = self.tokens.get(&server) else { continue };
            let (h, api) = (h.clone(), self.api_with(&server, Some(token)));
            std::thread::spawn(move || {
                if api.me() == Err(ApiError::Unauthorized) {
                    h.update(move |app, tx| {
                        // only if it's still the token that was refused
                        if app.tokens.get(&api.server) == api.token {
                            app.signed_out(&api.server, tx);
                        }
                    });
                }
            });
        }
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
            Err(ApiError::Unauthorized) if rem.api.token.is_some() => {
                let server = rem.api.server.clone();
                self.signed_out(&server, tx);
                return;
            }
            Err(ApiError::Unauthorized) => Problem::SignedOut,
            Err(ApiError::NotFound(_) | ApiError::Forbidden(_)) => Problem::Gone,
            // anything else: try again next time
            Err(_) => return,
        };
        self.lose_workspace(problem, tx);
    }

    /// The open remote workspace can't go on (revoked token, deleted): leave the room and
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
        rem.authors = None;
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
        self.staged = None;
        self.ed = Ed::Remote(Box::new(ce));
        self.store.set_note(&ws, Some(rel.clone()));
        tx.set_title(files::note_name(Path::new(&rel)));
        tx.scroll_to_y("scroll", 0.0);
        self.connect_room(generation);
    }

    /// The open remote note was renamed (by us, or the room says so): join the new name's room without a blank
    /// moment. Until it syncs, the old text and caret stay shown (read-only) and the new room's editor waits in
    /// `App::staged`; at the sync it takes over with the caret where it was.
    pub fn reopen_renamed(&mut self, to: String, tx: &mut Tx) {
        if self.remote.is_none() {
            return;
        }
        let (text, sel) = (self.ed.text().to_string(), self.ed.selection());
        self.close_room();
        let mut shown = Ed::local(&text);
        shown.set_selection(sel);
        shown.set_read_only(true);
        self.ed = shown;
        let Some(rem) = self.remote.as_mut() else { return };
        rem.generation = next_gen();
        rem.note = Some(to.clone());
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
        self.staged = Some(Box::new(ce));
        self.store.set_note(&ws, Some(to.clone()));
        tx.set_title(files::note_name(Path::new(&to)));
        let root = self.root.clone().unwrap_or_default();
        if let Some(keys) = self.path.as_ref().and_then(|p| self.folds.remove(p)) {
            self.folds.insert(root.join(&to), keys);
        }
        self.path = Some(root.join(&to));
        self.connect_room(generation);
    }

    /// The staged editor synced: it becomes the editor, with the caret (and selection) shown before.
    fn take_staged(&mut self) {
        let Some(mut ce) = self.staged.take() else { return };
        let sel = self.ed.selection();
        let text = ce.editor().text().to_string();
        let fit = |mut i: usize| {
            i = i.min(text.len());
            while !text.is_char_boundary(i) {
                i -= 1;
            }
            i
        };
        ce.editor_mut().set_selection(Sel::new(fit(sel.anchor), fit(sel.head)));
        self.ed = Ed::Remote(ce);
        self.sent = self.ed.text().to_string();
    }

    fn connect_room(&mut self, generation: u64) {
        let Some(rem) = self.remote.as_mut().filter(|r| r.generation == generation) else { return };
        let Some(note) = rem.note.clone() else { return };
        if let Some(ce) = room_ed!(self) {
            ce.connecting();
        }
        match &self.backend {
            Backend::Net(h) => {
                rem.sock = Some(spawn_socket(h.clone(), &rem.api, rem.id().to_string(), note, generation));
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
        let frames = room_ed!(self).map(|c| c.leave()).unwrap_or_default();
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
        self.staged = None;
        self.remote = None;
        self.pending_note = None;
        self.renaming = None;
        *self.watch.lock().unwrap() = None;
        self.close_search();
    }

    /// Send what the collab editor has after a command (and schedule its next wake-up).
    pub fn pump_collab(&mut self) {
        let now = self.now_ms();
        let want_focus = !self.search.open && !self.tree_focus && !self.switcher.open && !self.switcher.account_open && self.renaming.is_none() && self.dialog.is_none();
        let Some(rem) = self.remote.as_mut() else { return };
        let Some(ce) = room_ed!(self) else { return };
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
                                if let Some(ce) = room_ed!(self) {
                                    ce.frames_lost();
                                }
                                break;
                            }
                        }
                    }
                    None => {
                        if let Some(ce) = room_ed!(self) {
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
            && let Some(ce) = room_ed!(self)
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
        // our own edits so far are ours before the room's changes come in
        self.authors_follow(true);
        let Some(ce) = room_ed!(self) else { return };
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
                    if let Some(ce) = room_ed!(self) {
                        ce.set_local_read_only(ro);
                    }
                    if let Some(rem) = self.remote.as_mut() {
                        rem.synced = true;
                    }
                    self.take_staged();
                    self.run_goto(tx);
                }
                Notice::Reset => reset = true,
                Notice::Blame(b) => {
                    if let Some(rem) = self.remote.as_mut() {
                        let me = rem.user["id"].as_str().unwrap_or_default().to_string();
                        rem.authors = Some(crate::authors::LineAuthors::new(b.clone(), self.ed.text(), &me));
                    }
                }
                _ => {}
            }
        }
        if !r.edits.is_empty() || r.reloaded {
            self.map_uploads(&r.edits);
            self.sent = self.ed.text().to_string();
            self.marked = None;
            self.authors_follow(false);
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
        if let Some(ce) = room_ed!(self) {
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
        let Some(ce) = room_ed!(self) else { return };
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
            AfterClose::Closed { reason, .. } if reason == "unauthorized" => {
                match self.remote.as_ref().filter(|r| r.api.token.is_some()).map(|r| r.api.server.clone()) {
                    Some(server) => self.signed_out(&server, tx),
                    None => self.lose_workspace(Problem::SignedOut, tx),
                }
            }
            AfterClose::Closed { reason, to } => {
                rem.synced = false;
                rem.ended = Some(match reason.as_str() {
                    "deleted" => "This note was deleted".to_string(),
                    "renamed" => format!("This note was renamed{}", to.as_deref().map(|t| format!(" to {t}")).unwrap_or_default()),
                    "forbidden" => "Refused by the server (cross-origin)".to_string(),
                    "notfound" => "This note doesn't exist on the server".to_string(),
                    "toolarge" => "This note is too large to open".to_string(),
                    r => format!("Disconnected ({r})"),
                });
                if let Some(ce) = room_ed!(self) {
                    ce.set_local_read_only(true);
                }
                if reason == "renamed"
                    && let Some(to) = to
                {
                    self.reopen_renamed(to, tx);
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
                Problem::Missing => "No such folder".into(),
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
        let ce = room_ed_ref!(self)?;
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
    /// The other participants' presence users in the open note's room.
    pub fn room_peers(&self) -> Vec<(u64, Value)> {
        room_ed_ref!(self).map(|ce| ce.peers()).unwrap_or_default()
    }

    pub fn remote_carets(&self) -> Vec<(PeerCursor, usize, usize)> {
        let Some(ce) = room_ed_ref!(self) else { return Vec::new() };
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
        if !self.remote_writable() {
            return;
        }
        let root = self.root.clone().unwrap_or_default();
        let dir = self.selected_dir().unwrap_or_else(|| root.clone());
        let path = files::untitled(&dir, |p| files::contains(&self.files, p));
        let Ok(rel) = path.strip_prefix(&root).map(|r| r.to_string_lossy().into_owned()) else { return };
        self.remote_create(rel, None, tx);
    }

    /// Create note `rel` on the server and open it; `rename`: then start renaming that folder (New Folder).
    pub fn remote_create(&mut self, rel: String, rename: Option<String>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_ref().filter(|r| r.loaded && !r.read_only) else { return };
        let generation = rem.session;
        match &self.backend {
            Backend::Net(h) => {
                let (h, api, id) = (h.clone(), rem.api.clone(), rem.id().to_string());
                std::thread::spawn(move || {
                    let r = api.create(&id, &rel);
                    h.update(move |app, tx| app.remote_created(generation, rel, rename, r, tx));
                });
            }
            Backend::Mock(m) => {
                {
                    let mut m = m.borrow_mut();
                    m.relays.push((rel.clone(), Relay::new("")));
                    m.tree.push(rel.clone());
                }
                self.remote_created(generation, rel, rename, Ok(()), tx);
            }
            Backend::None => {}
        }
    }

    pub fn remote_created(&mut self, _generation: u64, rel: String, rename: Option<String>, r: Result<(), ApiError>, tx: &mut Tx) {
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
                self.close_search();
                self.open_note(root.join(&rel), tx);
                if let Some(dir) = rename {
                    self.start_rename(&dir);
                }
            }
            Err(e) => self.show_toast(format!("Couldn't create {rel}: {e}")),
        }
        self.handled(tx);
    }

    /// Rename a note on the server (`to` relative to the workspace; `.md` added when it has no extension).
    pub fn remote_rename(&mut self, from: String, to: String, tx: &mut Tx) {
        if !self.remote_writable() {
            return;
        }
        let mut to = to.trim().trim_matches('/').to_string();
        if to.is_empty() || to == from {
            return;
        }
        if !files::is_note(Path::new(&to)) {
            to.push_str(".md");
        }
        self.remote_move(from, to, false, tx);
    }

    /// Rename a note, or a folder with everything in it (`dir`: one commit, the server's `{folder: true}`).
    pub fn remote_move(&mut self, from: String, to: String, dir: bool, tx: &mut Tx) {
        let Some(rem) = self.remote.as_ref().filter(|r| r.loaded && !r.read_only) else { return };
        let generation = rem.session;
        match &self.backend {
            Backend::Net(h) => {
                let (h, api, id) = (h.clone(), rem.api.clone(), rem.id().to_string());
                std::thread::spawn(move || {
                    let r = if dir { api.rename_folder(&id, &from, &to) } else { api.rename(&id, &from, &to) };
                    h.update(move |app, tx| app.remote_renamed(generation, from, to, dir, r, tx));
                });
            }
            Backend::Mock(m) => {
                {
                    let mut m = m.borrow_mut();
                    let moved = |p: &str| moved(p, &from, &to, dir);
                    for e in m.relays.iter_mut() {
                        if let Some(t) = moved(&e.0) {
                            e.0 = t;
                        }
                    }
                    m.tree = m.tree.iter().map(|p| moved(p).unwrap_or_else(|| p.clone())).collect();
                }
                self.remote_renamed(generation, from, to, dir, Ok(()), tx);
            }
            Backend::None => {}
        }
    }

    pub fn remote_renamed(&mut self, _generation: u64, from: String, to: String, dir: bool, r: Result<(), ApiError>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        match r {
            Ok(()) => {
                let mut list: Vec<String> = rem.tree_list.iter().map(|p| moved(p, &from, &to, dir).unwrap_or_else(|| p.clone())).collect();
                list.sort();
                list.dedup();
                let g = rem.session;
                let open = rem.note.as_deref().and_then(|n| moved(n, &from, &to, dir));
                rem.tree_list.clear();
                self.remote_tree(g, list);
                if let Some(n) = open {
                    self.reopen_renamed(n, tx);
                }
            }
            Err(e) => self.show_toast(format!("Couldn't rename {from}: {e}")),
        }
        self.handled(tx);
    }

    pub fn remote_delete(&mut self, rel: String, tx: &mut Tx) {
        self.remote_delete_path(rel, false, tx);
    }

    /// Delete a note, or a folder with everything in it (`dir`: one commit). When the open note goes, the
    /// first note outside what was deleted opens.
    pub fn remote_delete_path(&mut self, rel: String, dir: bool, tx: &mut Tx) {
        let Some(rem) = self.remote.as_ref().filter(|r| r.loaded && !r.read_only) else { return };
        let generation = rem.session;
        match &self.backend {
            Backend::Net(h) => {
                let (h, api, id) = (h.clone(), rem.api.clone(), rem.id().to_string());
                std::thread::spawn(move || {
                    let r = if dir { api.delete_folder(&id, &rel) } else { api.delete(&id, &rel) };
                    h.update(move |app, tx| app.remote_deleted(generation, rel, dir, r, tx));
                });
            }
            Backend::Mock(m) => {
                {
                    let mut m = m.borrow_mut();
                    m.relays.retain(|(p, _)| !under(p, &rel, dir));
                    m.tree.retain(|p| !under(p, &rel, dir));
                }
                self.remote_deleted(generation, rel, dir, Ok(()), tx);
            }
            Backend::None => {}
        }
    }

    pub fn remote_deleted(&mut self, _generation: u64, rel: String, dir: bool, r: Result<(), ApiError>, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        match r {
            Ok(()) => {
                let list: Vec<String> = rem.tree_list.iter().filter(|p| !under(p, &rel, dir)).cloned().collect();
                let g = rem.session;
                let was_open = rem.note.as_deref().is_some_and(|n| under(n, &rel, dir));
                rem.tree_list.clear();
                self.remote_tree(g, list);
                if was_open {
                    self.close_room();
                    self.path = None;
                    self.ed = Ed::local("");
                    self.ed.set_read_only(true);
                    let root = self.root.clone().unwrap_or_default();
                    if let Some(p) = first_note_outside(&self.files, &root.join(&rel)) {
                        self.open_note(p, tx);
                    }
                }
            }
            Err(e) => self.show_toast(format!("Couldn't delete {rel}: {e}")),
        }
        self.handled(tx);
    }
}

/// Whether `p` is note `rel`, or (`dir`) in folder `rel`.
fn under(p: &str, rel: &str, dir: bool) -> bool {
    if dir { p.strip_prefix(rel).is_some_and(|r| r.starts_with('/')) } else { p == rel }
}

/// Where `p` goes when `from` (a note, or with `dir` a folder) becomes `to`; `None` when it doesn't move.
fn moved(p: &str, from: &str, to: &str, dir: bool) -> Option<String> {
    if !under(p, from, dir) {
        return None;
    }
    Some(if dir { format!("{to}{}", &p[from.len()..]) } else { to.to_string() })
}

/// The first note in tree order that isn't `gone` or in it.
pub fn first_note_outside(entries: &[Entry], gone: &Path) -> Option<PathBuf> {
    let left = || entries.iter().filter(|e| !e.path.starts_with(gone));
    left().find(|e| e.kids.is_none()).map(|e| e.path.clone()).or_else(|| left().find_map(|e| e.kids.as_deref().and_then(|k| first_note_outside(k, gone))))
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
    /// `GET /api/repos/:id` (what the switcher offers: Open on GitHub, Remove folder…); null when it failed.
    pub repo: Value,
}

/// Load a workspace's account, details and tree. A failure says what failed, with the account when that
/// much worked.
pub fn load(api: &Api, id: &str) -> Result<Loaded, (ApiError, Option<Value>)> {
    if api.token.is_none() {
        // a guest: no account to ask for; the folder's details from `/api/repos/:id` (`/api/workspaces` is
        // for accounts), its notes from the tree, as the web's guests read them
        let me = api.guest.clone().unwrap_or_default().me();
        let info = api.repo(id).map_err(|e| (e, None))?;
        let list = api.tree(id).map_err(|e| (e, None))?;
        return Ok(Loaded { me, info: info.clone(), list, repo: info });
    }
    let me = api.me().map_err(|e| match e {
        // a 404 for /api/me: not a Grimoire server (or one too old for apps)
        ApiError::NotFound(_) => (ApiError::NotGrimoire(api.host()), None),
        e => (e, None),
    })?;
    let info = api.workspace(id).map_err(|e| (e, Some(me.clone())))?;
    let list = api.tree(id).map_err(|e| (e, Some(me.clone())))?;
    let repo = api.repo(id).unwrap_or(Value::Null);
    Ok(Loaded { me, info, list, repo })
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
/// caret showing (`guest`: the same without an account). `--remote-demo=<state>` shows a problem instead:
/// `missing` (no such folder), `signedout`, `offline`, `notgrimoire`, `gone`, or `loading`.
pub fn demo(app: &mut App, state: &str) {
    let mut m = Mock::new(&[
        ("Team notes.md", "# Team notes\n\nPlanning for the **launch**:\n\n- Draft the announcement\n- Review the docs\n- Book the room\n\nOpen questions go below.\n"),
        ("ideas/Roadmap.md", "# Roadmap\n"),
        ("ideas/Names.md", "# Names\n"),
        ("Meeting 1-1.md", "# 1-1\n"),
    ]);
    let server = "https://grimoire.example";
    if ["owner", "editor", "viewer", "single"].contains(&state) {
        demo_roles(app, m, server, state);
        return;
    }
    if state == "media" {
        demo_media(app, server);
        return;
    }
    if state == "guest" {
        // no account: a guest (the account row says "Sign in", no agent card), Ada typing
        m.guest = true;
        let id = "demo-guest-1".to_string();
        app.store.guest = Some(crate::workspaces::Guest { color: crate::workspaces::guest_color(&id), id, name: "moist-noodle".into() });
    } else if !state.is_empty() {
        m.account = "confused-noodle".into();
        m.fail = match state {
            "missing" => Some(ApiError::NotFound("folder not found".into())),
            "signedout" => Some(ApiError::Unauthorized),
            "offline" => Some(ApiError::Network("can't reach grimoire.example:443: Connection refused (os error 61)".into())),
            "notgrimoire" => Some(ApiError::NotGrimoire("grimoire.example".into())),
            _ => None,
        };
        app.store.upsert_server(server, Some("Grimoire"), Some(vec![Joined::new("team", "Team")]));
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
                app.tree_polled(app.remote.as_ref().map_or(0, |r| r.session), Err(ApiError::NotFound("folder not found".into())), &mut tx);
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
    // who wrote each line (as the room's `blame` says): Ada and us
    let me = app.remote.as_ref().map(|r| r.user.clone()).unwrap_or_default();
    let blame = serde_json::json!({
        "t": "blame",
        "authors": [{ "id": "ada", "name": "Ada", "kind": "human", "color": "#d6409f" }, { "id": me["id"], "name": me["name"], "kind": me["kind"], "color": me["color"] }],
        "lines": [0, -1, 1, -1, 1, 0, 0, -1, 1, -1],
    });
    m.borrow_mut().to_app.push_back(collab::protocol::control_frame(&blame));
    app.pump_mock();
    app.pump_collab();
}

/// `--remote-demo=media`: a remote note showing an image from the server and a missing one, a pasted screenshot
/// still uploading ("Uploading…" at the end), and a link to a missing note followed (the toast with Create it).
fn demo_media(app: &mut App, server: &str) {
    let mut m = Mock::new(&[
        ("Trips/Lisbon.md", "# Lisbon\n\nThe view from the castle:\n\n![castle](images/castle.png)\n\nSee the [packing list](Packing) and [the budget](budget).\n\n![old map](images/map.png)\n\nScreenshot: "),
        ("Trips/Packing.md", "# Packing\n"),
    ]);
    m.files.push(("Trips/images/castle.png".into(), demo_picture(480, 200)));
    let m = Rc::new(RefCell::new(m));
    app.backend = Backend::Mock(m.clone());
    app.store.upsert_server(server, Some("Grimoire"), Some(vec![Joined::new("team", "Team")]));
    let mut tx = Tx::default();
    app.open_remote(server.into(), "team".into(), "Team".into(), Some("Trips/Lisbon.md".into()), &mut tx);
    m.borrow_mut().hold_uploads = true;
    let end = app.ed.text().len();
    app.add_images(vec![crate::uploads::NewImage::Png { name: "image.png".into(), bytes: demo_picture(40, 20) }], end, end, &mut tx);
    app.follow_link("budget", &mut tx);
}

/// A sky over two hills, as PNG (demo images).
fn demo_picture(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_fn(w, h, |x, y| {
        let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
        let hill1 = 0.62 + 0.12 * (fx * 5.0).sin();
        let hill2 = 0.78 + 0.08 * (fx * 3.0 + 1.0).cos();
        if fy > hill2 {
            image::Rgba([70, 120, 70, 255])
        } else if fy > hill1 {
            image::Rgba([110, 160, 95, 255])
        } else {
            image::Rgba([(150.0 + 80.0 * fy) as u8, (190.0 + 40.0 * fy) as u8, 235, 255])
        }
    });
    let mut out = std::io::Cursor::new(Vec::new());
    let _ = img.write_to(&mut out, image::ImageFormat::Png);
    out.into_inner()
}

/// `--remote-demo=owner|editor|viewer|single`: "Team" on the mock server with its REST stand-in, made by us
/// (`owner`: Remove folder…), by someone else (`editor`), or a read-only GitHub copy (`viewer`); the switcher's
/// items and every dialog work against it. Plus other folders and another server's, except for `single`: Team
/// is the only folder in the list.
fn demo_roles(app: &mut App, mut m: Mock, server: &str, role: &str) {
    use crate::fake::{FakeRest, FakeWs};
    let mut rest = FakeRest::new(server, "Ann Lee", "ann@example.com");
    rest.google = false;
    let mut team = FakeWs::new("team", "Team", role == "owner");
    team.files = m.tree.clone();
    if role == "viewer" {
        team.kind = "github".into();
        team.read_only = true;
        team.gh = Some(("acme".into(), "team".into()));
    }
    rest.workspaces.push(team);
    let single = role == "single";
    if !single {
        rest.workspaces.push(FakeWs::new("design", "Design reviews", false));
        rest.workspaces.push(FakeWs::new("handbook", "Handbook", false));
    }
    let rest = Arc::new(Mutex::new(rest));
    m.rest = Some(rest);
    m.account = "Ann Lee".into();
    let j = Joined::new;
    let joined = if single { vec![j("team", "Team")] } else { vec![j("team", "Team"), j("design", "Design reviews"), j("handbook", "Handbook")] };
    app.store.upsert_server(server, Some("Grimoire"), Some(joined));
    app.store.set_account(server, Some("Ann Lee".into()), Some("t_mac".into()));
    app.store.set_details(server, Some("ann@example.com".into()), Some(false));
    if !single {
        app.store.upsert_server("http://100.73.96.98:3000", Some("Lab"), Some(vec![j("lab", "Lab notes")]));
    }
    app.backend = Backend::Mock(Rc::new(RefCell::new(m)));
    let mut tx = Tx::default();
    app.open_remote(server.into(), "team".into(), "Team".into(), Some("Team notes.md".into()), &mut tx);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::tests::mock_server;
    use crate::uploads::NewImage;

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
            (200, r#"[{"id":"team","title":"Team","kind":"notes","readOnly":false,"status":"ready","head":"x","canRemove":true}]"#.into()),
            (401, r#"{"error":"not signed in"}"#.into()),
            (403, r#"{"error":"you have read-only access to this repo"}"#.into()),
        ]);
        let api = Api::new(base, Some("tok".into()));
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
        assert_eq!(ws, vec![Joined::new("team", "Team")]);
        assert!(rx.recv().unwrap().starts_with("GET /api/workspaces "));
        assert_eq!(api.me().unwrap_err(), ApiError::Unauthorized);
        assert_eq!(api.create("w", "x.md").unwrap_err(), ApiError::Forbidden("you have read-only access to this repo".into()));
    }

    /// Without a token the app is a guest, as the web's browsers are: no `/api/me`, the folder from
    /// `/api/repos/:id`, its tree; every request carries the guest's id, name and colour and the server's own
    /// origin; nothing is sent as a bearer.
    #[test]
    fn a_guest_reads_and_writes_with_the_guest_headers() {
        let (base, rx) = mock_server(vec![
            (200, r#"{"id":"team","title":"Team","kind":"notes","readOnly":false,"status":"ready","canRemove":false}"#.into()),
            (200, r#"{"head":"abc","files":["a.md"]}"#.into()),
            (201, r#"{"path":"b.md"}"#.into()),
        ]);
        let g = crate::workspaces::Guest { id: "abcdef123456".into(), name: "moist-noodle".into(), color: "#296d9a".into() };
        let api = Api { guest: Some(g.clone()), ..Api::new(base.clone(), None) };
        let l = load(&api, "team").unwrap();
        assert_eq!(l.me, json!({ "id": "guest:abcdef123456", "name": "moist-noodle", "color": "#296d9a", "kind": "guest" }));
        assert_eq!((l.info["title"].as_str(), l.list.as_slice()), (Some("Team"), ["a.md".to_string()].as_slice()));
        api.create("team", "b.md").unwrap();
        for want in ["GET /api/repos/team ", "GET /api/repos/team/tree ", "POST /api/repos/team/files "] {
            let req = rx.recv().unwrap();
            assert!(req.starts_with(want), "{req}");
            assert!(!req.contains("Authorization"), "{req}");
            for h in ["X-Grimoire-Guest: abcdef123456\r\n", "X-Grimoire-Guest-Name: moist-noodle\r\n", "X-Grimoire-Guest-Color: #296d9a\r\n", &format!("Origin: {base}\r\n")] {
                assert!(req.contains(h), "{h:?} in {req}");
            }
        }
        // with a token: no guest headers, whatever the guest is
        let (base, rx) = mock_server(vec![(200, r#"{"head":"abc","files":[]}"#.into())]);
        let api = Api { guest: Some(g), ..Api::new(base, Some("tok".into())) };
        api.tree("team").unwrap();
        let req = rx.recv().unwrap();
        assert!(req.contains("Authorization: Bearer tok") && !req.contains("X-Grimoire-Guest"), "{req}");
        // the guest identity: the web's name and colour rules
        let g = crate::workspaces::Guest::new();
        assert!(g.id.len() >= 6 && g.name.split('-').count() == 2 && g.color.starts_with('#'), "{g:?}");
        // the web's colorFor (bun: src/client/util.ts)
        for (id, c) in [("abc", "#4a5568"), ("abcdef123456", "#2b6a54"), ("guest:xyz", "#7c4d3a")] {
            assert_eq!(crate::workspaces::guest_color(id), c, "{id}");
        }
    }

    #[test]
    fn workspace_actions_use_the_web_apps_endpoints() {
        let (base, rx) = mock_server(vec![
            (200, r#"{"ok":true,"name":"Ann Lee"}"#.into()),
            (201, r#"{"id":"road-trip-x1","title":"Road trip","kind":"notes","readOnly":false,"status":"ready","head":"x","canRemove":true}"#.into()),
            (404, r#"{"error":"not found"}"#.into()),
            (201, r#"{"id":"plain","title":"Plain"}"#.into()),
            (201, r#"{"id":"gh-a-b","title":"a/b","status":"importing"}"#.into()),
            (200, r#"{"ok":true}"#.into()),
            (200, r#"{"ok":true}"#.into()),
            (201, r#"{"id":"s1","url":"https://g/a/0b9f"}"#.into()),
            (403, r#"{"error":"only whoever made this folder can remove it"}"#.into()),
        ]);
        let api = Api::new(base, Some("tok".into()));
        let next = || {
            let r = rx.recv().unwrap();
            assert!(r.contains("Authorization: Bearer tok\r\n"), "{r}");
            let line = r.lines().next().unwrap().trim_end_matches(" HTTP/1.1").to_string();
            let body = r.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
            if body.is_empty() { line } else { format!("{line} {body}") }
        };
        assert_eq!(api.set_name("Ann Lee").unwrap(), "Ann Lee");
        assert_eq!(next(), r#"PATCH /api/me {"name":"Ann Lee"}"#);
        assert_eq!(api.create_workspace("Road trip").unwrap(), ("road-trip-x1".into(), "Road trip".into()));
        assert_eq!(next(), r#"POST /api/workspaces {"title":"Road trip"}"#);
        // servers without /api/workspaces: POST /api/repos
        assert_eq!(api.create_workspace("Plain").unwrap().0, "plain");
        assert_eq!(next(), r#"POST /api/workspaces {"title":"Plain"}"#);
        assert_eq!(next(), r#"POST /api/repos {"title":"Plain"}"#);
        assert_eq!(api.add_github("a/b", true).unwrap()["status"], "importing");
        assert_eq!(next(), r#"POST /api/repos {"github":"a/b","readOnly":true}"#);
        api.remove_workspace("w").unwrap();
        assert_eq!(next(), "DELETE /api/repos/w");
        api.leave("w").unwrap();
        assert_eq!(next(), "DELETE /api/workspaces/w/join");
        assert_eq!(api.agent_link("w").unwrap(), "https://g/a/0b9f");
        assert_eq!(next(), r#"POST /api/repos/w/shares {}"#);
        // errors carry the server's words
        assert_eq!(api.remove_workspace("w").unwrap_err(), ApiError::Forbidden("only whoever made this folder can remove it".into()));
    }

    #[test]
    fn api_errors_say_what_went_wrong() {
        let (base, _rx) = mock_server(vec![
            (404, r#"{"error":"folder not found"}"#.into()),
            (404, "<html>Not Found</html>".into()),
            (502, "<html>Bad gateway</html>".into()),
            (200, "<!doctype html><title>Some site</title>".into()),
            (403, r#"{"error":"only the folder's owners can do this"}"#.into()),
            (200, r#"{"id":"u1","name":"Ann","token":{"id":"t_9","label":"Grimoire for Mac"}}"#.into()),
            (200, r#"{"ok":true}"#.into()),
        ]);
        let api = Api::new(base.clone(), Some("tok".into()));
        assert_eq!(api.tree("w").unwrap_err(), ApiError::NotFound("folder not found".into()));
        assert!(matches!(api.tree("w").unwrap_err(), ApiError::NotGrimoire(_)));
        assert!(matches!(api.tree("w").unwrap_err(), ApiError::Network(m) if m.contains("HTTP 502")));
        assert!(matches!(api.me().unwrap_err(), ApiError::NotGrimoire(_)));
        assert!(matches!(api.tree("w").unwrap_err(), ApiError::Forbidden(_)));
        // revoke: the token's id from /api/me, then DELETE /api/tokens/:id
        api.revoke(None).unwrap();
        // nothing listening: a network error
        let (l, port) = net::loopback().unwrap();
        drop(l);
        let gone = Api::new(format!("http://127.0.0.1:{port}"), None);
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
    fn a_missing_folder_says_so() {
        let (mut app, m) = failing_app(ApiError::NotFound("folder not found".into()));
        let (title, detail, fixes) = app.problem_page().expect("a problem page, not an endless Loading…");
        assert_eq!((title.as_str(), detail.as_str()), ("No such folder", "“dffddf-jrpu” doesn't exist on grimoire.exe.xyz."));
        assert_eq!(fixes, vec![Fix::Remove]);
        assert_eq!(app.remote_status().as_deref(), Some("No such folder"));
        // in the recents with the id standing in for the title, never empty
        assert_eq!(app.store.recent[0].0.name(), "dffddf-jrpu");
        // there after all (a typo fixed on the server): choosing it again loads it, with the server's title
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
        // deleted
        app.tree_polled(session, Err(ApiError::NotFound("folder not found".into())), &mut tx);
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
        let rows = files::rows(&e, &root, &Default::default());
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

    /// A remote untitled note takes its H1 as its name through the server's rename (taken names skipped);
    /// the text and caret stay put across the new room's sync; only once.
    #[test]
    fn remote_untitled_notes_are_named_after_their_heading_once() {
        let (mut app, m) = mock_app(&[("Untitled.md", ""), ("Trip.md", "taken\n")]);
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), "Team".into(), Some("Untitled.md".into()), &mut tx);
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("Untitled.md"));
        app.ed.insert_text("# Trip\nplans");
        app.handled(&mut tx);
        let caret = app.ed.selection();
        app.auto_name(&mut tx);
        let rem = app.remote.as_ref().unwrap();
        assert_eq!(rem.note.as_deref(), Some("Trip 2.md"));
        assert!(rem.synced && app.staged.is_none(), "the new room synced and took over");
        assert!(m.borrow().tree.contains(&"Trip 2.md".to_string()) && !m.borrow().tree.contains(&"Untitled.md".to_string()));
        assert_eq!((app.ed.text(), app.ed.selection()), ("# Trip\nplans", caret));
        assert!(app.ed.collab().is_some());
        app.ed.insert_text("!");
        app.handled(&mut tx);
        app.auto_name(&mut tx);
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("Trip 2.md"), "once");
        assert_eq!(m.borrow().text("Trip 2.md").as_deref(), Some("# Trip\nplans!"));
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

        // ours is published while the editor has the keys, and withdrawn while the search dialog has them
        let seen = |m: &MockRef| m.borrow().peers[ada].1.ed.remote_cursors().len();
        assert_eq!(seen(&m), 1);
        app.open_search();
        app.handled(&mut tx);
        m.borrow_mut().settle();
        assert_eq!(seen(&m), 0);
        app.close_search();
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

    /// A remote folder is its notes' prefix: New Folder creates "New folder/Untitled.md" and renames the folder,
    /// renaming a folder moves each note, deleting one deletes each (after the confirm).
    #[test]
    fn remote_folders_are_made_renamed_and_deleted_through_their_notes() {
        let (mut app, m) = mock_app(&[("c.md", "c\n"), ("ideas/a.md", "a\n"), ("ideas/b.md", "b\n")]);
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), "Team".into(), Some("ideas/a.md".into()), &mut tx);
        app.new_folder(&mut tx);
        assert!(m.borrow().tree.contains(&"ideas/New folder/Untitled.md".to_string()), "in the open note's folder");
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("ideas/New folder/Untitled.md"));
        assert_eq!(app.renaming.as_ref().map(|r| r.0.as_str()), Some("ideas/New folder"));
        app.renaming.as_mut().unwrap().1.text = "ideas/Drafts".into();
        app.submit_rename(&mut tx);
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("ideas/Drafts/Untitled.md"), "the open note follows");
        app.rename_path("ideas", "plans", &mut tx);
        let mut tree = m.borrow().tree.clone();
        tree.sort();
        assert_eq!(tree, ["c.md", "plans/Drafts/Untitled.md", "plans/a.md", "plans/b.md"]);
        app.ask_delete("plans");
        let Some(crate::dialogs::Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!(c.message, "Delete “plans” and the 3 notes in it? They stay in the Git history.");
        crate::actions::confirm(&mut app, &mut tx);
        assert_eq!(m.borrow().tree, ["c.md"]);
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("c.md"), "the first note left opens");
        app.ask_delete("c.md");
        let Some(crate::dialogs::Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.message.as_str()), ("Delete note", "Delete “c.md”? It stays in the Git history."));
    }

    /// Open… by URL with no token: the folder opens (no browser, no sign-in), joins the list, takes edits as
    /// the guest; the account row says "Sign in", the agent card stays hidden, the switcher lists the folder
    /// under its server.
    #[test]
    fn open_by_url_works_as_a_guest() {
        let (mut app, m) = mock_app(&[("a.md", "one\n")]);
        m.borrow_mut().guest = true;
        app.opener = |_| panic!("no browser for a public folder");
        let mut tx = Tx::default();
        app.open_dialog(crate::dialogs::OpenChoice::Remote, &mut tx);
        if let Some(crate::dialogs::Dialog::Open(d)) = &mut app.dialog {
            d.url = rune::TextEdit::new("https://g.example/app/team/a.md");
        }
        crate::actions::submit_open(&mut app, &mut tx);
        assert!(app.dialog.is_none());
        let rem = app.remote.as_ref().unwrap();
        assert!(rem.loaded && rem.problem.is_none() && rem.api.token.is_none());
        assert_eq!(rem.note.as_deref(), Some("a.md"));
        let g = app.store.guest.clone().unwrap();
        assert_eq!(rem.user["kind"], "guest");
        assert_eq!(rem.user["name"], g.name.as_str());
        assert!(app.is_guest() && rem.account.is_none());
        assert_eq!(crate::menu::account_label(&app).as_deref(), Some("Sign in"));
        assert!(!crate::menu::signed_in(&app, "https://g.example"));
        assert!(!app.agent_card_shown(), "agent links are for accounts");
        assert!(app.store.recent.iter().any(|(w, _)| matches!(w, WsRef::Remote { id, .. } if id == "team")));
        let labels: Vec<String> = crate::menu::items(&app).iter().map(crate::menu::Item::label).collect();
        assert!(labels.windows(2).any(|w| w[0] == "g.example" && w[1].ends_with("team")), "{labels:?}");
        // edits reach the server's room
        app.ed.insert_text("guest ");
        app.handled(&mut tx);
        assert_eq!(m.borrow().text("a.md").unwrap(), "guest one\n");
        assert!(!app.ed.is_read_only());
    }

    /// A token the server refuses (revoked on the web): dropped, "Signed out of <host>", and the open folder
    /// carries on as a guest, still editable.
    #[test]
    fn a_refused_token_signs_out_to_a_guest() {
        let dir = std::env::temp_dir().join(format!("grimoire-signedout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (mut app, m) = mock_app(&[("a.md", "one\n")]);
        let server = "https://g.example";
        app.tokens = crate::workspaces::Tokens::File(dir.join("tokens.json"));
        app.tokens.set(server, "gr_tok-1").unwrap();
        app.store.upsert_server(server, Some("G"), Some(vec![Joined::new("team", "Team")]));
        app.store.set_account(server, Some("Ann".into()), None);
        let mut tx = Tx::default();
        app.open_remote(server.into(), "team".into(), "Team".into(), None, &mut tx);
        assert!(!app.is_guest() && crate::menu::signed_in(&app, server));
        // the server forgets the token: the next answer refusing it signs this Mac out there
        m.borrow_mut().guest = true;
        app.signed_out(server, &mut tx);
        assert!(app.tokens.get(server).is_none() && app.store.server(server).is_none());
        assert_eq!(app.toast.as_deref(), Some("Signed out of g.example"));
        let rem = app.remote.as_ref().unwrap();
        assert!(rem.loaded && rem.problem.is_none() && app.is_guest());
        assert_eq!(rem.note.as_deref(), Some("a.md"));
        assert_eq!(crate::menu::account_label(&app).as_deref(), Some("Sign in"));
        app.ed.insert_text("still ");
        app.handled(&mut tx);
        assert_eq!(m.borrow().text("a.md").unwrap(), "still one\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The room's line authors reach the margin: names where the author changes (headings and empty lines
    /// skipped), our own typing becomes ours at once, Authors off hides them; one author: none.
    #[test]
    fn line_authors_come_from_the_room_and_follow_the_text() {
        let _ = crate::layout::FONTS.set(crate::layout::Fonts { list: &[], sans: "Inter", mono: "Inter" });
        let (mut app, m) = mock_app(&[("a.md", "# Title\none\ntwo\n\nthree")]);
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), "Team".into(), None, &mut tx);
        let blame = |lines: serde_json::Value| {
            collab::protocol::control_frame(&serde_json::json!({
                "t": "blame", "authors": [{ "id": "ada", "name": "Ada", "kind": "human", "color": "#d6409f" }, { "id": "bob", "name": "Bob Builder", "kind": "guest" }], "lines": lines,
            }))
        };
        m.borrow_mut().to_app.push_back(blame(serde_json::json!([0, 0, 1, -1, 1])));
        app.pump_mock();
        let names = |app: &App| -> Vec<String> {
            let geo = app.geometry();
            crate::authors::names(app, &geo, 1000.0).into_iter().map(|n| format!("author:{}", n.0)).collect()
        };
        assert_eq!(names(&app), ["author:1", "author:2"], "the heading and the empty line show nothing; three is Bob's, as two");
        // our typing on line "one" makes it ours at once (a third author)
        let at = app.ed.text().find("one").unwrap();
        app.ed.set_selection(editor_core::Sel::caret(at));
        app.ed.insert_text("x");
        app.handled(&mut tx);
        let la = app.remote.as_ref().unwrap().authors.clone().unwrap();
        assert_eq!(la.values, [0, 2, 1, -1, 1]);
        assert_eq!(la.authors[2].id, app.remote.as_ref().unwrap().user["id"].as_str().unwrap());
        // Authors off: no names; on again: back
        app.toggle_authors(&mut tx);
        assert!(names(&app).is_empty() && app.store.hide_authors);
        app.toggle_authors(&mut tx);
        assert_eq!(names(&app), ["author:1", "author:2"], "ours on one, Bob on two");
        // a narrow pane: no room, no names
        let geo = app.geometry();
        assert!(crate::authors::names(&app, &geo, crate::layout::surface_w()).is_empty());
        // one author in the whole note: none
        m.borrow_mut().to_app.push_back(blame(serde_json::json!([1, 1, 1, -1, 1])));
        app.pump_mock();
        assert!(names(&app).is_empty());
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
        // Open… → URL: a bad URL, then a good one
        app.toggle_switcher();
        app.run_act(crate::menu::Act::Open, &mut tx);
        crate::actions::pick_open(&mut app, crate::dialogs::OpenChoice::Remote, &mut tx);
        assert!(!app.switcher.open);
        let field = |app: &mut App, t: &str| *app.dialog.as_mut().unwrap().field(0).unwrap() = crate::dialogs::field_edit(t);
        field(&mut app, "https://g.example/settings");
        crate::actions::submit_open(&mut app, &mut tx);
        assert!(matches!(&app.dialog, Some(crate::dialogs::Dialog::Open(d)) if d.error.is_some()));
        field(&mut app, "https://g.example/app/team/a.md");
        crate::actions::submit_open(&mut app, &mut tx);
        assert!(app.dialog.is_none());
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("a.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The browser's part of the connect flow, without a browser: sign in by name (dev login) as "Mac user",
    /// approve on /connect, and follow the redirect to our loopback listener.
    /// A `w`×`h` PNG.
    pub fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([200, 40, 40, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn images_of(app: &App) -> Vec<(crate::layout::ImgKind, String, f32)> {
        app.geometry().lines.iter().flat_map(|l| l.images.iter().map(|i| (i.kind.clone(), i.label.clone(), i.w))).collect()
    }

    /// A remote note's images come from the server's `/raw` (relative to the note, root-relative with `/`), are
    /// cached on disk and drawn like local ones; a missing one shows the web's placeholder.
    #[test]
    fn remote_images_load_from_the_server() {
        crate::images::set_sync(true);
        let (mut app, m) = mock_app(&[("dir/n.md", "![cat](images/cat.png)\n\n![logo](/assets/logo.png)\n\n![gone](nope.png)\n")]);
        m.borrow_mut().files.push(("dir/images/cat.png".into(), png(40, 20)));
        m.borrow_mut().files.push(("assets/logo.png".into(), png(10, 10)));
        let mut tx = Tx::default();
        app.open_remote("https://img.example".into(), "team".into(), "Team".into(), Some("dir/n.md".into()), &mut tx);
        let imgs = images_of(&app);
        assert_eq!(imgs.len(), 3);
        let cat = crate::rimages::cache_file("https://img.example/api/repos/team/raw?path=dir%2Fimages%2Fcat.png");
        assert_eq!((imgs[0].0.clone(), imgs[0].2), (crate::layout::ImgKind::Ready(cat.clone()), 40.0));
        assert_eq!(std::fs::read(&cat).unwrap(), png(40, 20), "cached on disk");
        assert!(matches!(imgs[1].0, crate::layout::ImgKind::Ready(_)) && imgs[1].2 == 10.0, "root-relative");
        assert_eq!((imgs[2].0.clone(), imgs[2].1.as_str()), (crate::layout::ImgKind::Missing, "Image not found: gone"));
        crate::rimages::set_fake(None);
    }

    /// Dropped or pasted images go up to the server; an "Uploading…" mark follows everyone's edits meanwhile, then
    /// the server's Markdown goes in there and shows the image.
    #[test]
    fn images_upload_into_remote_notes_where_they_were_put() {
        crate::images::set_sync(true);
        let (mut app, m) = mock_app(&[("dir/n.md", "Hello world\n")]);
        let ada = m.borrow_mut().add_peer("dir/n.md", 77, "Ada", "#d6409f");
        let mut tx = Tx::default();
        app.open_remote("https://up.example".into(), "team".into(), "Team".into(), Some("dir/n.md".into()), &mut tx);
        m.borrow_mut().hold_uploads = true;
        app.ed.set_selection(Sel::caret(5));
        let shot = rune::ClipboardImage::from_png(png(30, 10)).unwrap();
        crate::uploads::paste(&mut app, &rune::ClipboardContent::default().with_image(shot), &mut tx);
        assert_eq!(app.uploads.iter().map(|u| (u.from, u.label.as_str())).collect::<Vec<_>>(), vec![(5, "Uploading…")]);
        assert_eq!(app.ed.text(), "Hello world\n", "nothing inserted yet");
        // Ada types before it, we type after it: the mark follows
        m.borrow_mut().peer(ada, |ed| {
            ed.editor_mut().set_selection(Sel::caret(0));
            ed.editor_mut().insert_text("Oh, ");
        });
        app.pump_mock();
        let at = app.ed.text().len() - 1;
        app.ed.set_selection(Sel::caret(at));
        app.ed.insert_text("!");
        app.handled(&mut tx);
        assert_eq!(app.uploads[0].from, 9);
        app.finish_mock_uploads(&mut tx);
        assert!(app.uploads.is_empty());
        assert_eq!(app.ed.text(), "Oh, Hello![image](images/image.png) world!\n");
        assert_eq!(m.borrow().text("dir/n.md").unwrap(), app.ed.text(), "one edit, in the room");
        assert_eq!(m.borrow().uploads, vec![format!("dir/n.md image.png {}", png(30, 10).len())]);
        let imgs = images_of(&app);
        assert!(matches!(imgs[0].0, crate::layout::ImgKind::Ready(_)) && imgs[0].2 == 30.0, "shown from the server");

        // files dropped: images uploaded (another picture under the same name gets -2), the rest refused
        m.borrow_mut().hold_uploads = false;
        let dir = std::env::temp_dir().join(format!("grimoire-up-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("image.png"), png(5, 5)).unwrap();
        std::fs::write(dir.join("doc.pdf"), b"%PDF").unwrap();
        let end = app.ed.text().len();
        app.add_images(vec![NewImage::File(dir.join("image.png")), NewImage::File(dir.join("doc.pdf"))], end, end, &mut tx);
        assert!(app.ed.text().ends_with("\n![image](images/image-2.png)"));
        assert_eq!(app.toast.as_deref(), Some("Skipped doc.pdf: only images can be added to a note."));
        app.add_images(vec![NewImage::File(dir.join("doc.pdf"))], 0, 0, &mut tx);
        assert_eq!(app.toast.as_deref(), Some("Only images can be added to a note (doc.pdf isn't one)."));
        let _ = std::fs::remove_dir_all(&dir);

        // a failed upload says so; a read-only note takes none
        m.borrow_mut().hold_uploads = true;
        app.add_images(vec![NewImage::Png { name: "image.png".into(), bytes: Vec::new() }], 0, 0, &mut tx);
        app.finish_mock_uploads(&mut tx);
        assert_eq!(app.toast.as_deref(), Some("Couldn't upload image.png: the file is empty"));
        app.remote.as_mut().unwrap().read_only = true;
        app.add_images(vec![NewImage::Png { name: "image.png".into(), bytes: png(2, 2) }], 0, 0, &mut tx);
        assert_eq!(app.toast.as_deref(), Some("This note is read-only."));
        assert!(app.uploads.is_empty());
        crate::rimages::set_fake(None);
    }

    /// An upload finishing after its note was left isn't inserted anywhere else.
    #[test]
    fn an_upload_for_a_note_left_meanwhile_isnt_inserted() {
        let (mut app, m) = mock_app(&[("a.md", "a\n"), ("b.md", "b\n")]);
        let mut tx = Tx::default();
        app.open_remote("https://up2.example".into(), "team".into(), "Team".into(), Some("a.md".into()), &mut tx);
        m.borrow_mut().hold_uploads = true;
        app.add_images(vec![NewImage::Png { name: "image.png".into(), bytes: png(2, 2) }], 0, 0, &mut tx);
        app.open_note(app.root.clone().unwrap().join("b.md"), &mut tx);
        app.finish_mock_uploads(&mut tx);
        assert_eq!(app.ed.text(), "b\n");
        assert_eq!(app.toast.as_deref(), Some("The image was uploaded but the note changed before it could be inserted."));
        crate::rimages::set_fake(None);
    }

    /// Links between a remote folder's notes open them (case-insensitive, `.md` added, `#heading` once synced);
    /// a missing one offers "Create it"; other files open the server's copy; Grimoire app links on a server we're
    /// signed in to open here.
    #[test]
    fn links_between_remote_notes() {
        let (mut app, m) = mock_app(&[("a.md", "home\n"), ("dir/b.md", "# One\n\ntext\n\n# Two\n")]);
        m.borrow_mut().tree.push("dir/images/cat.png".into());
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), "Team".into(), Some("a.md".into()), &mut tx);
        let note = |app: &App| app.remote.as_ref().unwrap().note.clone().unwrap();
        app.follow_link("dir/B", &mut tx);
        assert_eq!(note(&app), "dir/b.md");
        app.follow_link("../a.md", &mut tx);
        assert_eq!(note(&app), "a.md");
        app.follow_link("dir/b.md#two", &mut tx);
        assert_eq!(note(&app), "dir/b.md");
        assert_eq!(app.ed.selection(), Sel::caret(app.ed.text().find("Two").unwrap()), "at the heading");
        app.follow_link("images/cat.png", &mut tx);
        assert_eq!(app.link_log.last().unwrap(), "open https://g.example/api/repos/team/raw?path=dir%2Fimages%2Fcat.png");

        // missing: Create it makes the note with its heading and opens it
        app.follow_link("plans/Trip", &mut tx);
        assert_eq!(app.toast.as_deref(), Some("No note at “dir/plans/Trip.md”"));
        app.run_toast_action(&mut tx);
        assert_eq!(note(&app), "dir/plans/Trip.md");
        assert_eq!(app.ed.text(), "# Trip\n");
        assert!(app.remote.as_ref().unwrap().tree_list.contains(&"dir/plans/Trip.md".to_string()));

        // app links: this folder's notes here, a missing one offers Create it, another folder opens here
        app.follow_link("https://g.example/app/team/a.md", &mut tx);
        assert_eq!(note(&app), "a.md");
        app.follow_link("https://g.example/app/team/dir/b.md#One", &mut tx);
        assert_eq!((note(&app), app.ed.selection()), ("dir/b.md".to_string(), Sel::caret(2)));
        app.follow_link("https://g.example/r/team/nope", &mut tx);
        assert_eq!(app.toast.as_deref(), Some("No note at “nope.md”"));
        app.follow_link("https://g.example/app/other/a.md", &mut tx);
        assert_eq!((app.remote.as_ref().unwrap().id(), note(&app).as_str()), ("other", "a.md"));
        // another server (not signed in there), or not an app link: the browser
        app.follow_link("https://elsewhere.example/app/team/a.md", &mut tx);
        assert_eq!(app.link_log.last().unwrap(), "open https://elsewhere.example/app/team/a.md");
        app.follow_link("https://g.example/docs", &mut tx);
        assert_eq!(app.link_log.last().unwrap(), "open https://g.example/docs");

        // read-only folders offer no Create it
        app.remote.as_mut().unwrap().read_only = true;
        app.follow_link("nope", &mut tx);
        assert_eq!((app.toast.as_deref(), app.toast_action.as_ref()), (Some("No note at “nope.md”"), None));
    }

    /// The upload request is the web's: raw body, name and note in the query, the token, the server's Markdown back.
    #[test]
    fn upload_requests_match_the_web() {
        let (server, rx) = mock_server(vec![(200, json!({ "path": "dir/images/a b.png", "markdownPath": "images/a%20b.png", "markdown": "![a b](images/a%20b.png)" }).to_string()), (413, json!({ "error": "images can be at most 10 MB" }).to_string())]);
        let api = Api::new(server, Some("tok".into()));
        assert_eq!(api.upload_image("my ws", "dir/n.md", "a b.png", b"PNGDATA").unwrap(), "![a b](images/a%20b.png)");
        let req = rx.recv().unwrap();
        assert!(req.starts_with("POST /api/repos/my%20ws/images?note=dir%2Fn.md&name=a%20b.png HTTP/1.1"), "{req}");
        assert!(req.contains("Authorization: Bearer tok") && req.contains("Content-Type: image/png") && req.ends_with("PNGDATA"), "{req}");
        assert_eq!(api.upload_image("w", "n.md", "x.png", b"x"), Err(ApiError::Other("images can be at most 10 MB".into())));
        // a guest sends the guest headers instead of a token
        let (server, rx) = mock_server(vec![(200, json!({ "markdown": "![x](images/x.png)" }).to_string())]);
        let g = crate::workspaces::Guest { id: "abcdef123456".into(), name: "moist noodle".into(), color: "#296d9a".into() };
        let api = Api { guest: Some(g), ..Api::new(server.clone(), None) };
        assert_eq!(api.upload_image("w", "n.md", "x.png", b"x").unwrap(), "![x](images/x.png)");
        let req = rx.recv().unwrap();
        assert!(!req.contains("Authorization") && req.contains("X-Grimoire-Guest: abcdef123456\r\n") && req.contains("X-Grimoire-Guest-Name: moist%20noodle\r\n") && req.contains(&format!("Origin: {server}\r\n")), "{req}");
    }

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

