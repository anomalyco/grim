//! Grim's tools for OpenCode sessions (experimental, Mac only): while a pairing exists (`opencode.rs`) and a
//! **voice session** (the delegator) is picked, the app hosts an MCP server named `grim` on the paired OpenCode
//! server, for that session (and its subagents) alone. The pattern is the OpenCode TUI's (`packages/tui/src/context/
//! client-mcp.tsx`): one connection for one directory, and every tool call checked against the session it serves.
//!
//! How OpenCode does it (anomalyco/opencode, `packages/protocol/src/groups/mcp.ts`, `packages/server/src/handlers/
//! mcp.ts`, `packages/core/src/mcp/index.ts` and `client.ts`, `packages/client/src/mcp.ts`; servers from 2.2.0):
//!
//! - **The socket.** `GET /api/experimental/client-mcp?name=grim&location[directory]=<dir>` upgraded to a
//!   WebSocket that the client opens. The direction is reversed: the OpenCode server is the MCP *client*, Grim the
//!   MCP *server*. One JSON-RPC message per text frame: the server sends `initialize`, `notifications/initialized`,
//!   `tools/list`, `tools/call` (and `ping`); Grim answers. It sends the calling session in
//!   `params._meta["ai.opencode/sessionID"]`.
//! - **Auth.** The pairing's HTTP Basic `opencode:<token>` on the upgrade, like any request (browsers, which can't
//!   send headers, use a single-use ticket from `POST …/client-mcp/token` instead). No `Origin` or the server's own.
//! - **Scope.** MCP is per location (directory) on the server: the tools reach every session working in the
//!   directory the socket names. So there is one socket, for the voice session's directory (none without a voice
//!   session), and each call is checked: the caller's root session (`parentID` followed up, so subagents count)
//!   must be the voice session, else the call fails ("Grim's tools are only available to the voice session …").
//! - **Names.** A tool `ping` of the client `grim` is `grim_ping` to the model (`<name>_<tool>`).
//! - **Lifetime.** The tools exist while the socket is open; when it closes they're gone (a second socket under the
//!   same name stacks: the newest serves). Listing tools has the MCP client's 30 s; a call may take 10 minutes.
//! - **Results.** MCP `content` (text, or `image` with base64 `data` and `mimeType`) and `isError`.
//!
//! Tools are `Tool`s in `TOOLS`: a name, a description, a JSON schema and a handler run on the UI thread with the
//! app. A handler answers through its `Call` (`ok`, `error`, `image`), at once or later from another thread.
//!
//! The voice session is `delegator()` / `set_delegator(…)`, kept with the pairing (`app.tokens`, account
//! `opencode-delegator`) and forgotten with it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rune::Tx;
use serde_json::{Value, json};

use crate::App;
use crate::net;
use crate::opencode::{self, Client, OcError, Pairing};
use crate::remote::Handle;
use crate::workspaces::Tokens;
use crate::wsock::{self, SockEvents, SockTx, ToSock};

/// The client's name on the server: the model sees `grim_<tool>`.
pub const NAME: &str = "grim";
pub const PATH: &str = "/api/experimental/client-mcp";
const PROTOCOL_VERSION: &str = "2025-11-25";
const SESSION_META: &str = "ai.opencode/sessionID";
/// Where the voice session is kept (`Tokens`, next to `opencode::KEYCHAIN_ACCOUNT`).
pub const DELEGATOR_ACCOUNT: &str = "opencode-delegator";
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A server without the endpoint (before 2.2) is asked again this rarely.
const UNSUPPORTED_RETRY: Duration = Duration::from_secs(600);
/// Parents followed at most, looking for a session's root.
const MAX_DEPTH: usize = 32;

// ---- the registry ----

/// A tool Grim offers to OpenCode sessions.
pub struct Tool {
    /// `[a-zA-Z0-9_-]+`, without the `grim_` the model sees.
    pub name: &'static str,
    /// What it does and when to use it, for the model.
    pub description: &'static str,
    /// The arguments' JSON Schema (`type: "object"`).
    pub schema: fn() -> Value,
    /// Runs on the UI thread; answers through `call`, now or later (move it to a thread).
    pub run: fn(&mut App, &Value, Call, &mut Tx),
}

/// Grim's tools.
pub const TOOLS: &[Tool] = &[Tool {
    name: "ping",
    description: "Check that the Grim notes app on the user's Mac is connected to this session. Returns \"pong from Grim\" and the app's version.",
    schema: || json!({ "type": "object", "properties": {} }),
    run: |_app, _args, call, _tx| {
        let to = call.session.as_deref().map(|s| format!(" (to session {s})")).unwrap_or_default();
        call.ok(format!("pong from Grim {}{to}", env!("CARGO_PKG_VERSION")))
    },
}];

/// One tool call: who made it, and how to answer it (once; dropping it unanswered answers with an error).
pub struct Call {
    /// The OpenCode session that called.
    pub session: Option<String>,
    reply: Option<Box<dyn FnOnce(Value) + Send>>,
}

impl Call {
    pub fn ok(self, text: impl Into<String>) {
        self.result(json!({ "content": [{ "type": "text", "text": text.into() }] }));
    }

    pub fn error(self, text: impl Into<String>) {
        self.result(json!({ "content": [{ "type": "text", "text": text.into() }], "isError": true }));
    }

    /// An image (base64 `data`), with an optional caption.
    #[allow(dead_code)]
    pub fn image(self, data: String, mime: &str, caption: Option<&str>) {
        let mut content = vec![json!({ "type": "image", "data": data, "mimeType": mime })];
        if let Some(c) = caption {
            content.push(json!({ "type": "text", "text": c }));
        }
        self.result(json!({ "content": content }));
    }

    /// A whole MCP `CallToolResult`.
    pub fn result(mut self, v: Value) {
        if let Some(f) = self.reply.take() {
            f(v);
        }
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if let Some(f) = self.reply.take() {
            f(json!({ "content": [{ "type": "text", "text": "Grim didn't answer this call." }], "isError": true }));
        }
    }
}

fn tool_list() -> Value {
    Value::Array(TOOLS.iter().map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() })).collect())
}

// ---- the voice session (delegator) ----

/// An OpenCode session, as Grim keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRef {
    pub id: String,
    /// Where it works on the server's machine ("" is the server's default).
    pub directory: String,
    pub title: String,
}

impl SessionRef {
    pub fn of(s: &opencode::Session) -> SessionRef {
        SessionRef { id: s.id.clone(), directory: s.directory.clone(), title: s.title.clone() }
    }

    /// The title, or "Untitled session".
    pub fn name(&self) -> String {
        if self.title.trim().is_empty() { "Untitled session".into() } else { self.title.clone() }
    }

    /// The kept value: base64url of `{"server","id","directory","title"}` (the title shortened to fit).
    fn encode(&self, server: &str) -> Option<String> {
        let mut title: String = self.title.chars().take(80).collect();
        loop {
            let v = net::base64url(json!({ "server": server, "id": self.id, "directory": self.directory, "title": title }).to_string().as_bytes());
            if crate::workspaces::valid_token(&v) {
                return Some(v);
            }
            if title.is_empty() {
                return None;
            }
            title = title.chars().take(title.chars().count() / 2).collect();
        }
    }

    /// A kept value, if it's for `server`.
    fn decode(s: &str, server: &str) -> Option<SessionRef> {
        let v: Value = serde_json::from_slice(&opencode::base64url_decode(s)?).ok()?;
        if v["server"].as_str()? != server {
            return None;
        }
        Some(SessionRef { id: v["id"].as_str()?.to_string(), directory: v["directory"].as_str().unwrap_or("").to_string(), title: v["title"].as_str().unwrap_or("").to_string() })
    }
}

/// The voice session, and where it's kept (the pairing's server and the app's tokens; none: not kept).
struct Delegator {
    session: Option<SessionRef>,
    store: Option<(Tokens, String)>,
}

static DELEGATOR: Mutex<Delegator> = Mutex::new(Delegator { session: None, store: None });

/// The voice session: the one OpenCode session whose calls Grim's tools take (and whose subagents'), and the one voice
/// will delegate to. None until one is picked.
pub fn delegator() -> Option<SessionRef> {
    DELEGATOR.lock().unwrap().session.clone()
}

/// Pick the voice session (None: no voice session, so no tools). Kept with the pairing; the socket follows it (a new
/// directory: the old socket closes and one opens there; the same directory: it stays).
pub fn set_delegator(session: Option<SessionRef>) {
    {
        let mut d = DELEGATOR.lock().unwrap();
        if d.session == session {
            return;
        }
        d.session = session.clone();
        if let Some((tokens, server)) = &d.store {
            match session.as_ref().and_then(|s| s.encode(server)) {
                Some(v) => {
                    let _ = tokens.set(DELEGATOR_ACCOUNT, &v);
                }
                None => tokens.remove(DELEGATOR_ACCOUNT),
            }
        }
    }
    let cur = CURRENT.lock().unwrap().clone();
    if let Some(sh) = cur {
        retarget(&sh);
        sh.handle.update(|_, tx| tx.instant());
    }
}

/// Read the kept voice session for `pairing` (another server's is dropped), and keep changes in `tokens`.
fn load_delegator(tokens: &Tokens, pairing: &Pairing) {
    let session = tokens.get(DELEGATOR_ACCOUNT).and_then(|v| SessionRef::decode(&v, &pairing.url));
    let mut d = DELEGATOR.lock().unwrap();
    d.session = session;
    d.store = Some((tokens.clone(), pairing.url.clone()));
}

// ---- the connection ----

/// The socket's state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DirState {
    /// No voice session: no socket.
    Off,
    Connecting,
    /// The server listed the tools: the voice session has them.
    Ready,
    /// Closed or couldn't connect (why); retrying.
    Lost(String),
    /// The server has no client MCP endpoint (OpenCode before 2.2).
    Unsupported,
    /// The server refused the pairing.
    Refused,
}

/// The one socket: which directory it's for (None: none), its generation (bumped when the directory changes; an
/// older generation's thread ends), state and sender.
struct Link {
    epoch: u64,
    dir: Option<String>,
    state: DirState,
    sock: Option<SockTx>,
}

struct Shared {
    pairing: Pairing,
    client: Client,
    handle: Handle,
    stop: AtomicBool,
    link: Mutex<Link>,
    /// Wakes the backoff when the directory changes or on `stop`.
    wake: Condvar,
    calls: AtomicU64,
    /// Sockets open now (between connecting and closed), by serial: their directories.
    open: Mutex<Vec<(u64, String)>>,
    /// Session → its parent (None: a root), as the server said; parents don't change.
    parents: Mutex<HashMap<String, Option<String>>>,
    /// Each tool call's check: the calling session, and the refusal if refused.
    checks: Mutex<Vec<(Option<String>, Option<String>)>>,
}

impl Shared {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Still the socket to keep: not stopped, the directory not changed since.
    fn current(&self, epoch: u64) -> bool {
        !self.stopped() && self.link.lock().unwrap().epoch == epoch
    }

    /// Sleep up to `d`; true when this generation is over. `stop` and a new directory cut it short.
    fn sleep(&self, epoch: u64, d: Duration) -> bool {
        let g = self.link.lock().unwrap();
        let (g, _) = self.wake.wait_timeout_while(g, d, |l| l.epoch == epoch && !self.stopped()).unwrap();
        drop(g);
        !self.current(epoch)
    }

    fn set(&self, epoch: u64, state: DirState) {
        {
            let mut l = self.link.lock().unwrap();
            if l.epoch != epoch || l.state == state {
                return;
            }
            l.state = state;
        }
        // the dialog's status row
        self.handle.update(|_, tx| tx.instant());
    }

    /// The root of `session`'s tree (itself for a top-level session; a subagent's: its parent's root).
    fn root_of(&self, session: &str) -> Result<String, OcError> {
        let mut id = session.to_string();
        for _ in 0..MAX_DEPTH {
            let known = self.parents.lock().unwrap().get(&id).cloned();
            let parent = match known {
                Some(p) => p,
                None => {
                    let p = self.client.session(&id)?.parent;
                    self.parents.lock().unwrap().insert(id.clone(), p.clone());
                    p
                }
            };
            match parent {
                Some(p) => id = p,
                None => return Ok(id),
            }
        }
        Ok(id)
    }
}

static CURRENT: Mutex<Option<Arc<Shared>>> = Mutex::new(None);
static SERIAL: AtomicU64 = AtomicU64::new(1);

/// Keep Grim's tools on `pairing`'s server for the voice session (until `stop`, or another pairing). Already
/// there: nothing.
pub fn start(pairing: Pairing, handle: Handle) {
    let sh = {
        let mut cur = CURRENT.lock().unwrap();
        if cur.as_ref().is_some_and(|s| s.pairing == pairing && !s.stopped()) {
            return;
        }
        if let Some(old) = cur.take() {
            shut(&old);
        }
        let sh = Arc::new(Shared {
            client: Client::new(pairing.clone()),
            pairing,
            handle,
            stop: AtomicBool::new(false),
            link: Mutex::new(Link { epoch: 0, dir: None, state: DirState::Off, sock: None }),
            wake: Condvar::new(),
            calls: AtomicU64::new(0),
            open: Mutex::default(),
            parents: Mutex::default(),
            checks: Mutex::default(),
        });
        *cur = Some(sh.clone());
        sh
    };
    retarget(&sh);
}

/// Start from the kept pairing and voice session, if any (the app's launch; a new pairing).
pub fn start_paired(app: &App) {
    if let (Some(p), crate::remote::Backend::Net(h)) = (opencode::load(&app.tokens), &app.backend) {
        load_delegator(&app.tokens, &p);
        start(p, h.clone());
    }
}

/// Close the socket (the app quits).
pub fn stop() {
    let cur = CURRENT.lock().unwrap().take();
    if let Some(sh) = cur {
        shut(&sh);
    }
}

/// The pairing was forgotten: close the socket and forget the voice session too.
pub fn forget(tokens: &Tokens) {
    stop();
    let mut d = DELEGATOR.lock().unwrap();
    d.session = None;
    d.store = None;
    tokens.remove(DELEGATOR_ACCOUNT);
}

fn shut(sh: &Shared) {
    sh.stop.store(true, Ordering::SeqCst);
    let sock = {
        let mut l = sh.link.lock().unwrap();
        l.epoch += 1;
        l.sock.take()
    };
    sh.wake.notify_all();
    if let Some(s) = sock {
        s.send(ToSock::Close);
    }
}

/// Point the socket at the voice session's directory: none, nothing; the same, as is; another, the old one closed
/// and a new one opened.
fn retarget(sh: &Arc<Shared>) {
    let want = delegator().map(|d| d.directory);
    let (epoch, old) = {
        let mut l = sh.link.lock().unwrap();
        if l.dir == want || sh.stopped() {
            return;
        }
        l.epoch += 1;
        l.dir = want.clone();
        l.state = if want.is_some() { DirState::Connecting } else { DirState::Off };
        (l.epoch, l.sock.take())
    };
    sh.wake.notify_all();
    if let Some(s) = old {
        s.send(ToSock::Close);
    }
    if let Some(dir) = want {
        let sh = sh.clone();
        std::thread::spawn(move || run_dir(sh, dir, epoch));
    }
}

/// The socket's state now, and its directory (None: no voice session; nothing while unpaired).
pub fn state() -> Option<(Option<String>, DirState)> {
    let sh = CURRENT.lock().unwrap().clone()?;
    let l = sh.link.lock().unwrap();
    Some((l.dir.clone(), l.state.clone()))
}

/// The directories of the sockets open now (one at most, but for a moment while one closes).
pub fn open_sockets() -> Vec<String> {
    let Some(sh) = CURRENT.lock().unwrap().clone() else { return Vec::new() };
    let o = sh.open.lock().unwrap();
    o.iter().map(|(_, d)| d.clone()).collect()
}

/// Calls answered since `start`.
pub fn calls() -> u64 {
    CURRENT.lock().unwrap().as_ref().map_or(0, |s| s.calls.load(Ordering::SeqCst))
}

/// Each tool call's session check since `start`: the caller, and why it was refused (None: allowed).
pub fn checks() -> Vec<(Option<String>, Option<String>)> {
    CURRENT.lock().unwrap().as_ref().map_or_else(Vec::new, |s| s.checks.lock().unwrap().clone())
}

/// The status line for the OpenCode dialog, while paired.
pub fn summary() -> Option<String> {
    let (_, st) = state()?;
    let name = delegator().map(|d| d.name()).unwrap_or_default();
    Some(match st {
        DirState::Off => "Tools: off (no voice session)".into(),
        DirState::Ready => format!("Tools: connected to {name}"),
        DirState::Connecting => format!("Tools: connecting to {name}…"),
        DirState::Lost(why) => format!("Tools: disconnected ({why}), retrying…"),
        DirState::Unsupported => "Tools: need OpenCode 2.2 or newer".into(),
        DirState::Refused => "Tools: the server refused the pairing".into(),
    })
}

/// The socket URL for `dir` ("": the server's default directory).
fn socket_url(base: &str, dir: &str) -> String {
    let ws = if let Some(r) = base.strip_prefix("https://") { format!("wss://{r}") } else { format!("ws://{}", base.strip_prefix("http://").unwrap_or(base)) };
    let mut url = format!("{ws}{PATH}?name={NAME}");
    if !dir.is_empty() {
        url.push_str(&format!("&location%5Bdirectory%5D={}", net::enc(dir)));
    }
    url
}

/// The socket for `dir`, reconnecting with backoff (1 s doubling to a minute; back to 1 s after a socket that got
/// as far as listing the tools) until stopped or the voice session moves to another directory. A refused pairing
/// ends it.
fn run_dir(sh: Arc<Shared>, dir: String, epoch: u64) {
    let origin = net::parse_url(&sh.pairing.url).map(|u| u.origin()).unwrap_or_else(|_| sh.pairing.url.clone());
    let auth = (!sh.pairing.password.is_empty()).then(|| format!("Basic {}", opencode::base64(format!("{}:{}", opencode::USERNAME, sh.pairing.password).as_bytes())));
    let url = socket_url(&sh.pairing.url, &dir);
    let mut delay = BACKOFF_MIN;
    loop {
        if !sh.current(epoch) {
            return;
        }
        sh.set(epoch, DirState::Connecting);
        let (dtx, drx) = mpsc::channel();
        let serial = SERIAL.fetch_add(1, Ordering::SeqCst);
        sh.open.lock().unwrap().push((serial, dir.clone()));
        let conn = Conn { sh: sh.clone(), epoch, serial, tx: None, ready: false, done: dtx };
        let sock = wsock::spawn_auth(origin.clone(), url.clone(), auth.clone(), None, conn);
        let kept = {
            let mut l = sh.link.lock().unwrap();
            let kept = l.epoch == epoch && !sh.stopped();
            if kept {
                l.sock = Some(sock.clone());
            }
            kept
        };
        if !kept {
            sock.send(ToSock::Close);
        }
        let (_code, reason, ready) = drx.recv().unwrap_or((1006, "gone".into(), false));
        {
            let mut l = sh.link.lock().unwrap();
            if l.epoch == epoch {
                l.sock = None;
            }
        }
        if !sh.current(epoch) {
            return;
        }
        if ready {
            delay = BACKOFF_MIN;
        }
        let state = if reason.contains("401") {
            DirState::Refused
        } else if reason.contains("404") {
            DirState::Unsupported
        } else {
            DirState::Lost(if reason.is_empty() { "closed".into() } else { reason })
        };
        eprintln!("grimoire: OpenCode tools ({}): {state:?}", if dir.is_empty() { "default directory" } else { &dir });
        let wait = match state {
            DirState::Refused => {
                sh.set(epoch, state);
                return;
            }
            DirState::Unsupported => UNSUPPORTED_RETRY,
            _ => delay,
        };
        sh.set(epoch, state);
        if sh.sleep(epoch, wait) {
            return;
        }
        delay = (delay * 2).min(BACKOFF_MAX);
    }
}

/// Whether `session` may use Grim's tools: its root is the voice session. Blocks (asks the server for parents).
fn check(sh: &Shared, session: Option<&str>) -> Result<(), String> {
    let Some(d) = delegator() else { return Err("Grim's tools are only available to the voice session (none is picked in Grim)".into()) };
    let refused = || format!("Grim's tools are only available to the voice session ({})", d.name());
    let Some(s) = session else { return Err(refused()) };
    if s == d.id {
        return Ok(());
    }
    match sh.root_of(s) {
        Ok(root) if root == d.id => Ok(()),
        Ok(_) => Err(refused()),
        Err(e) => Err(format!("Grim couldn't check the calling session ({e}). {}", refused())),
    }
}

/// The socket's events: answers the server's MCP requests (tool calls checked, then run on the UI thread).
struct Conn {
    sh: Arc<Shared>,
    epoch: u64,
    serial: u64,
    tx: Option<SockTx>,
    ready: bool,
    done: mpsc::Sender<(u16, String, bool)>,
}

fn send(tx: &SockTx, id: Value, answer: Result<Value, (i64, String)>) {
    let msg = match answer {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    };
    tx.send(ToSock::Text(msg.to_string()));
}

impl SockEvents for Conn {
    fn attach(&mut self, tx: SockTx) {
        self.tx = Some(tx);
    }

    fn frame(&mut self, data: Vec<u8>) {
        // frames should be text; binary ones are read as UTF-8, as the server does
        if let Ok(t) = String::from_utf8(data) {
            self.text(t);
        }
    }

    fn text(&mut self, text: String) {
        let Ok(msg) = serde_json::from_str::<Value>(&text) else { return };
        let Some(method) = msg["method"].as_str() else { return };
        if method == "notifications/initialized" {
            self.ready = true;
            self.sh.set(self.epoch, DirState::Ready);
            return;
        }
        // notifications and responses need no answer
        let Some(id) = msg.get("id").filter(|i| i.is_string() || i.is_number()).cloned() else { return };
        let Some(tx) = self.tx.clone() else { return };
        let params = &msg["params"];
        match method {
            "initialize" => {
                // the server only offers versions it speaks: echo its choice
                let version = params["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION);
                send(&tx, id, Ok(json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": NAME, "version": env!("CARGO_PKG_VERSION") } })));
            }
            "ping" => send(&tx, id, Ok(json!({}))),
            "tools/list" => send(&tx, id, Ok(json!({ "tools": tool_list() }))),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or("").to_string();
                let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
                    send(&tx, id, Err((-32602, format!("Unknown tool: {name}"))));
                    return;
                };
                let args = if params["arguments"].is_object() { params["arguments"].clone() } else { json!({}) };
                let session = params["_meta"][SESSION_META].as_str().map(str::to_string);
                let sh = self.sh.clone();
                let run = tool.run;
                // the check may ask the server for parents: off the socket's thread
                std::thread::spawn(move || {
                    let verdict = check(&sh, session.as_deref());
                    sh.checks.lock().unwrap().push((session.clone(), verdict.clone().err()));
                    let reply_sh = sh.clone();
                    let call = Call {
                        session,
                        reply: Some(Box::new(move |result| {
                            reply_sh.calls.fetch_add(1, Ordering::SeqCst);
                            send(&tx, id, Ok(result));
                        })),
                    };
                    match verdict {
                        Ok(()) => sh.handle.update(move |app, tx| run(app, &args, call, tx)),
                        Err(why) => call.error(why),
                    }
                });
            }
            _ => send(&tx, id, Err((-32601, format!("Method not found: {method}")))),
        }
    }

    fn closed(self, code: u16, reason: String) {
        self.sh.open.lock().unwrap().retain(|(s, _)| *s != self.serial);
        let _ = self.done.send((code, reason, self.ready));
    }
}

/// `--oc-tools-selftest=<server URL>` (`--opencode-password=…`, `--opencode-dir=<a directory on the server>`,
/// `--opencode-dir2=<another>`, `--opencode-keep`): this module against a real server, headless, the pairing and
/// voice session kept in a temporary file, tool calls run from a channel as on the UI thread. Sessions A and B in
/// the first directory, C in the second, and A1, a child of A:
/// (a) no voice session: no socket; (b) A the voice session: one socket, for A's directory, and A's `grim_ping`
/// answered; (c) B's refused; (e) A1's answered (its root is A); (d) C the voice session: the old socket closed, one
/// for C's directory, C's answered; then another voice session in the same directory keeps the socket, and Forget
/// drops it all. The sessions are deleted afterwards unless kept. Exit status 0 when every step passed.
pub fn selftest(args: &[String]) -> i32 {
    use crate::opencode::{CHAT_EVENTS, Event, Outcome};
    use crate::remote::{Backend, Update};
    use std::time::Instant;
    let arg = |name: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_string));
    let Some(url) = arg("oc-tools-selftest").and_then(|u| opencode::server_address(&u)) else {
        eprintln!("oc-tools selftest: --oc-tools-selftest=<server URL> --opencode-dir2=<directory>");
        return 2;
    };
    let Some(dir2) = arg("opencode-dir2") else {
        eprintln!("oc-tools selftest: --opencode-dir2=<a second directory on the server> (for switching directories)");
        return 2;
    };
    let pairing = Pairing { url, password: arg("opencode-password").unwrap_or_default() };
    let client = Client::new(pairing.clone());
    match client.info() {
        Ok(i) => eprintln!("oc-tools selftest: OpenCode {} on {}", i.version, i.hostname.as_deref().unwrap_or("?")),
        Err(e) => {
            eprintln!("oc-tools selftest: /api/info: {e}");
            return 1;
        }
    }
    let tmp = std::env::temp_dir().join(format!("grim-oc-tools-selftest-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&tmp);
    let (utx, urx) = mpsc::channel::<Update>();
    let mut app = App::new("", None, true);
    app.backend = Backend::Net(Handle::Chan(utx));
    app.tokens = Tokens::File(tmp.join("tokens.json"));
    let _ = opencode::save(&app.tokens, &pairing);
    let mut tx = Tx::default();
    let mut ok = true;
    let mut check_ = |pass: bool, what: &str| {
        eprintln!("oc-tools selftest: {} {what}", if pass { "ok" } else { "FAILED" });
        ok &= pass;
    };
    // the UI thread: tool calls and redraws, until `cond` or `secs`
    let pump = |app: &mut App, tx: &mut Tx, secs: u64, cond: &dyn Fn() -> bool| -> bool {
        let until = Instant::now() + Duration::from_secs(secs);
        loop {
            if cond() {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            if let Ok(u) = urx.recv_timeout(Duration::from_millis(100)) {
                u(app, tx);
            }
        }
    };
    let ready_in = |dir: &str| state() == Some((Some(dir.to_string()), DirState::Ready)) && open_sockets() == vec![dir.to_string()];

    // (a) paired, no voice session
    start_paired(&app);
    pump(&mut app, &mut tx, 3, &|| false);
    check_(delegator().is_none() && open_sockets().is_empty() && state() == Some((None, DirState::Off)), &format!("(a) no voice session: no socket ({:?}, {:?}, {:?})", state(), open_sockets(), summary()));

    // the sessions
    let dir1 = arg("opencode-dir");
    let mut made: Vec<String> = Vec::new();
    let mut mk = |title: &str, dir: Option<&str>, parent: Option<&str>| -> Option<opencode::Session> {
        let r = match parent {
            Some(p) => client.create_child_session(p, title),
            None => client.create_session(Some(title), dir),
        };
        match r {
            Ok(s) => {
                eprintln!("oc-tools selftest: session {} {:?} in {} (parent {:?})", s.id, s.title, s.directory, s.parent);
                made.push(s.id.clone());
                Some(s)
            }
            Err(e) => {
                eprintln!("oc-tools selftest: create {title}: {e}");
                None
            }
        }
    };
    let a = mk("Grim tools selftest A", dir1.as_deref(), None);
    let b = a.as_ref().and_then(|a| mk("Grim tools selftest B", Some(&a.directory), None));
    let c = mk("Grim tools selftest C", Some(&dir2), None);
    let a1 = a.as_ref().and_then(|a| mk("Grim tools selftest A1 (child)", None, Some(&a.id)));
    let (Some(a), Some(b), Some(c), Some(a1)) = (a, b, c, a1) else {
        cleanup(&client, &made, args, &tmp);
        return 1;
    };
    check_(a.directory != c.directory, &format!("two directories: {} and {}", a.directory, c.directory));

    // the replies, by session
    let stop_events = Arc::new(AtomicBool::new(false));
    let (etx, erx) = mpsc::channel::<Event>();
    {
        let (client, stop_events) = (client.clone(), stop_events.clone());
        std::thread::spawn(move || {
            let _ = client.events(CHAT_EVENTS, &stop_events, |ev| etx.send(ev).is_ok());
        });
    }
    std::thread::sleep(Duration::from_millis(500));
    let prompt = arg("opencode-prompt").unwrap_or_else(|| "Call the grim_ping tool once, then reply with exactly the text it returned, or its error message if it failed.".into());
    // prompt `s`, run its tool calls, until its run ends: the reply and this session's checks
    let ask = |app: &mut App, tx: &mut Tx, s: &opencode::Session| -> (String, Vec<Option<String>>) {
        if let Err(e) = client.prompt(&s.id, &prompt) {
            eprintln!("oc-tools selftest: prompt {}: {e}", s.id);
            return (String::new(), Vec::new());
        }
        let mut reply = String::new();
        let mut outcome: Option<Outcome> = None;
        let sent = Instant::now();
        while outcome.is_none() && sent.elapsed() < Duration::from_secs(240) {
            if let Ok(u) = urx.recv_timeout(Duration::from_millis(100)) {
                u(app, tx);
            }
            while let Ok(ev) = erx.try_recv() {
                if ev.session() != Some(s.id.as_str()) {
                    continue;
                }
                match ev {
                    Event::TextDelta { delta, .. } => reply.push_str(&delta),
                    Event::Finished { outcome: o, .. } => outcome = Some(o),
                    _ => {}
                }
            }
        }
        // answers still on their way
        pump(app, tx, 1, &|| false);
        let mine: Vec<Option<String>> = checks().into_iter().filter(|(who, _)| who.as_deref() == Some(s.id.as_str())).map(|(_, why)| why).collect();
        eprintln!("oc-tools selftest: {} ({}): outcome {outcome:?}; checks {mine:?}; reply {reply:?}", s.title, s.id);
        (reply, mine)
    };

    // (b) A the voice session
    set_delegator(Some(SessionRef::of(&a)));
    let t = Instant::now();
    let up = pump(&mut app, &mut tx, 30, &|| ready_in(&a.directory));
    check_(up, &format!("(b) A the voice session: one socket, for {} ({:?}, {:?}) after {} ms; {:?}", a.directory, state(), open_sockets(), t.elapsed().as_millis(), summary()));
    let kept = app.tokens.get(DELEGATOR_ACCOUNT).and_then(|v| SessionRef::decode(&v, &pairing.url));
    check_(kept.as_ref().is_some_and(|k| k.id == a.id && k.directory == a.directory), &format!("(b) kept with the pairing: {kept:?}"));
    let (reply, mine) = ask(&mut app, &mut tx, &a);
    check_(mine.iter().any(Option::is_none) && reply.contains("pong from Grim"), "(b) A's grim_ping answered");

    // (c) B, same directory, refused
    let (reply, mine) = ask(&mut app, &mut tx, &b);
    let refused = format!("Grim's tools are only available to the voice session ({})", a.title);
    check_(!mine.is_empty() && mine.iter().all(|w| w.as_deref() == Some(refused.as_str())), &format!("(c) B's grim_ping refused with {refused:?} (reply {reply:?})"));

    // (e) A1, a child of A: its root is A
    let sh = CURRENT.lock().unwrap().clone();
    let root = sh.as_ref().map(|sh| sh.root_of(&a1.id));
    check_(matches!(&root, Some(Ok(r)) if *r == a.id), &format!("(e) A1's root resolves to A ({root:?})"));
    let (reply, mine) = ask(&mut app, &mut tx, &a1);
    check_(!mine.is_empty() && mine.iter().all(Option::is_none) && reply.contains("pong from Grim"), "(e) A1's grim_ping answered");

    // (d) C, another directory
    let epoch0 = generation();
    set_delegator(Some(SessionRef::of(&c)));
    let t = Instant::now();
    let moved = pump(&mut app, &mut tx, 30, &|| ready_in(&c.directory));
    check_(moved && generation() == epoch0 + 1, &format!("(d) C the voice session: the old socket closed, one for {} ({:?}) after {} ms; {:?}", c.directory, open_sockets(), t.elapsed().as_millis(), summary()));
    let (reply, mine) = ask(&mut app, &mut tx, &c);
    check_(mine.iter().any(Option::is_none) && reply.contains("pong from Grim"), "(d) C's grim_ping answered");
    // the same directory: the socket stays
    let epoch1 = generation();
    set_delegator(Some(SessionRef { id: b.id.clone(), directory: c.directory.clone(), title: "same directory".into() }));
    pump(&mut app, &mut tx, 2, &|| false);
    check_(generation() == epoch1 && ready_in(&c.directory), "another voice session in the same directory keeps the socket");
    set_delegator(None);
    pump(&mut app, &mut tx, 5, &|| open_sockets().is_empty());
    check_(open_sockets().is_empty() && state() == Some((None, DirState::Off)) && app.tokens.get(DELEGATOR_ACCOUNT).is_none(), &format!("None: no socket, nothing kept ({:?})", summary()));
    eprintln!("oc-tools selftest: calls answered by the app {}", calls());
    set_delegator(Some(SessionRef::of(&a)));
    forget(&app.tokens);
    check_(delegator().is_none() && app.tokens.get(DELEGATOR_ACCOUNT).is_none() && state().is_none(), "Forget: the voice session forgotten, the socket closed");

    stop_events.store(true, Ordering::SeqCst);
    cleanup(&client, &made, args, &tmp);
    eprintln!("oc-tools selftest: {}", if ok { "PASSED" } else { "FAILED" });
    if ok { 0 } else { 1 }
}

/// The current socket's generation (bumped on each new directory).
fn generation() -> u64 {
    CURRENT.lock().unwrap().as_ref().map_or(0, |s| s.link.lock().unwrap().epoch)
}

fn cleanup(client: &Client, made: &[String], args: &[String], tmp: &std::path::Path) {
    stop();
    if !args.iter().any(|a| a == "--opencode-keep") {
        for id in made.iter().rev() {
            eprintln!("oc-tools selftest: delete session {id}: {:?}", client.delete_session(id));
        }
    }
    let _ = std::fs::remove_dir_all(tmp);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_urls() {
        assert_eq!(socket_url("http://127.0.0.1:4096", ""), "ws://127.0.0.1:4096/api/experimental/client-mcp?name=grim");
        assert_eq!(socket_url("https://h.example/oc", "/Users/j/a b"), format!("wss://h.example/oc/api/experimental/client-mcp?name=grim&location%5Bdirectory%5D={}", net::enc("/Users/j/a b")));
    }

    #[test]
    fn kept_voice_session() {
        let s = SessionRef { id: "ses_1".into(), directory: "/Users/j/p".into(), title: "é".repeat(300) };
        let v = s.encode("http://h:1").unwrap();
        let back = SessionRef::decode(&v, "http://h:1").unwrap();
        assert_eq!((back.id.as_str(), back.directory.as_str()), ("ses_1", "/Users/j/p"));
        assert!(SessionRef::decode(&v, "http://other:1").is_none());
    }
}
