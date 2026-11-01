//! Grim's tools for OpenCode sessions (experimental, Mac only): while a pairing exists (`opencode.rs`), the app
//! hosts an MCP server named `grim` on the paired OpenCode server, so its sessions can call Grim's tools.
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
//! - **Scope.** MCP is per location (directory) on the server: the tools reach only sessions working in the
//!   directory the socket names (no directory: the server's own working directory). So this keeps one socket per
//!   directory: the server's default, the directories of its recent sessions (rescanned every minute), and any a
//!   caller asks for (`ensure_directory`, for a session about to be used).
//! - **Names.** A tool `ping` of the client `grim` is `grim_ping` to the model (`<name>_<tool>`).
//! - **Lifetime.** The tools exist while the socket is open; when it closes they're gone (a second socket under the
//!   same name stacks: the newest serves). Listing tools has the MCP client's 30 s; a call may take 10 minutes.
//! - **Results.** MCP `content` (text, or `image` with base64 `data` and `mimeType`) and `isError`.
//!
//! Tools are `Tool`s in `TOOLS`: a name, a description, a JSON schema and a handler run on the UI thread with the
//! app. A handler answers through its `Call` (`ok`, `error`, `image`), at once or later from another thread.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rune::Tx;
use serde_json::{Value, json};

use crate::App;
use crate::net;
use crate::opencode::{self, Client, Pairing};
use crate::remote::Handle;
use crate::wsock::{self, SockEvents, SockTx, ToSock};

/// The client's name on the server: the model sees `grim_<tool>`.
pub const NAME: &str = "grim";
pub const PATH: &str = "/api/experimental/client-mcp";
const PROTOCOL_VERSION: &str = "2025-11-25";
const SESSION_META: &str = "ai.opencode/sessionID";
/// Sockets for at most this many session directories (the most recent), besides the default and asked-for ones.
const MAX_DIRS: usize = 12;
const RESCAN: Duration = Duration::from_secs(60);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A server without the endpoint (before 2.2) is asked again this rarely.
const UNSUPPORTED_RETRY: Duration = Duration::from_secs(600);

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

    #[allow(dead_code)]
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

// ---- the connection ----

/// A directory's socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DirState {
    Connecting,
    /// The server listed the tools: sessions there have them.
    Ready,
    /// Closed or couldn't connect (why); retrying.
    Lost(String),
    /// The server has no client MCP endpoint (OpenCode before 2.2).
    Unsupported,
    /// The server refused the pairing.
    Refused,
}

struct Shared {
    pairing: Pairing,
    handle: Handle,
    stop: AtomicBool,
    /// Directory ("" is the server's default) → its state and socket.
    dirs: Mutex<HashMap<String, (DirState, Option<SockTx>)>>,
    /// Directories asked for (`ensure_directory`), and a wake-up for the manager and the backoffs.
    wanted: Mutex<Vec<String>>,
    wake: Condvar,
    calls: AtomicU64,
}

impl Shared {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Sleep up to `d`; true when stopped. `ensure_directory` and `stop` cut it short.
    fn sleep(&self, d: Duration) -> bool {
        let g = self.wanted.lock().unwrap();
        let _ = self.wake.wait_timeout(g, d).unwrap();
        self.stopped()
    }

    fn set(&self, dir: &str, state: DirState) {
        {
            let mut m = self.dirs.lock().unwrap();
            let e = m.entry(dir.to_string()).or_insert((DirState::Connecting, None));
            if e.0 == state {
                return;
            }
            e.0 = state;
        }
        // the dialog's status row
        self.handle.update(|_, tx| tx.instant());
    }
}

static CURRENT: Mutex<Option<Arc<Shared>>> = Mutex::new(None);

/// Keep Grim's tools on `pairing`'s server (until `stop`, or another pairing). Already there: nothing.
pub fn start(pairing: Pairing, handle: Handle) {
    let mut cur = CURRENT.lock().unwrap();
    if cur.as_ref().is_some_and(|s| s.pairing == pairing && !s.stopped()) {
        return;
    }
    if let Some(old) = cur.take() {
        shut(&old);
    }
    let sh = Arc::new(Shared { pairing, handle, stop: AtomicBool::new(false), dirs: Mutex::default(), wanted: Mutex::default(), wake: Condvar::new(), calls: AtomicU64::new(0) });
    *cur = Some(sh.clone());
    std::thread::spawn(move || manage(sh));
}

/// Start from the kept pairing, if any (the app's launch).
pub fn start_paired(app: &App) {
    if let (Some(p), crate::remote::Backend::Net(h)) = (opencode::load(&app.tokens), &app.backend) {
        start(p, h.clone());
    }
}

/// Close every socket (the pairing was forgotten, or the app quits).
pub fn stop() {
    if let Some(sh) = CURRENT.lock().unwrap().take() {
        shut(&sh);
    }
}

fn shut(sh: &Shared) {
    sh.stop.store(true, Ordering::SeqCst);
    sh.wake.notify_all();
    for (_, (_, sock)) in sh.dirs.lock().unwrap().iter() {
        if let Some(s) = sock {
            s.send(ToSock::Close);
        }
    }
}

/// Make the tools reach sessions in `directory` (on the server's machine) too, e.g. a session about to be used.
pub fn ensure_directory(directory: &str) {
    let Some(sh) = CURRENT.lock().unwrap().clone() else { return };
    let mut w = sh.wanted.lock().unwrap();
    if !w.iter().any(|d| d == directory) {
        w.push(directory.to_string());
        sh.wake.notify_all();
    }
}

/// Each directory's state now ("" is the server's default).
pub fn states() -> Vec<(String, DirState)> {
    let Some(sh) = CURRENT.lock().unwrap().clone() else { return Vec::new() };
    let mut v: Vec<(String, DirState)> = sh.dirs.lock().unwrap().iter().map(|(d, (s, _))| (d.clone(), s.clone())).collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

/// Calls answered since `start`.
pub fn calls() -> u64 {
    CURRENT.lock().unwrap().as_ref().map_or(0, |s| s.calls.load(Ordering::SeqCst))
}

/// The status line for the OpenCode dialog, while running.
pub fn summary() -> Option<String> {
    CURRENT.lock().unwrap().as_ref()?;
    let st = states();
    let ready = st.iter().filter(|(_, s)| *s == DirState::Ready).count();
    Some(if ready > 0 {
        format!("Tools: connected ({ready} folder{} on the server)", if ready == 1 { "" } else { "s" })
    } else if st.iter().any(|(_, s)| *s == DirState::Refused) {
        "Tools: the server refused the pairing".into()
    } else if !st.is_empty() && st.iter().all(|(_, s)| *s == DirState::Unsupported) {
        "Tools: need OpenCode 2.2 or newer".into()
    } else if let Some((_, DirState::Lost(why))) = st.iter().find(|(_, s)| matches!(s, DirState::Lost(_))) {
        format!("Tools: disconnected ({why}), retrying…")
    } else {
        "Tools: connecting…".into()
    })
}

/// The directories to serve, a socket each; rescanned every minute and when one is asked for.
fn manage(sh: Arc<Shared>) {
    let client = Client::new(sh.pairing.clone());
    let mut started: HashSet<String> = HashSet::new();
    loop {
        if sh.stopped() {
            return;
        }
        let mut want = vec![String::new()];
        want.extend(sh.wanted.lock().unwrap().iter().cloned());
        if let Ok(list) = client.sessions(200) {
            let mut n = 0;
            for s in list {
                if n < MAX_DIRS && !s.directory.is_empty() && !want.contains(&s.directory) {
                    want.push(s.directory);
                    n += 1;
                }
            }
        }
        for d in want {
            if started.insert(d.clone()) {
                let sh = sh.clone();
                std::thread::spawn(move || run_dir(sh, d));
            }
        }
        if sh.sleep(RESCAN) {
            return;
        }
    }
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

/// One directory's socket, reconnecting with backoff (1 s doubling to a minute; back to 1 s after a socket that
/// got as far as listing the tools) until stopped. A refused pairing ends it.
fn run_dir(sh: Arc<Shared>, dir: String) {
    let origin = net::parse_url(&sh.pairing.url).map(|u| u.origin()).unwrap_or_else(|_| sh.pairing.url.clone());
    let auth = (!sh.pairing.password.is_empty()).then(|| format!("Basic {}", opencode::base64(format!("{}:{}", opencode::USERNAME, sh.pairing.password).as_bytes())));
    let url = socket_url(&sh.pairing.url, &dir);
    let mut delay = BACKOFF_MIN;
    loop {
        if sh.stopped() {
            return;
        }
        sh.set(&dir, DirState::Connecting);
        let (dtx, drx) = mpsc::channel();
        let conn = Conn { sh: sh.clone(), dir: dir.clone(), tx: None, ready: false, done: dtx };
        let sock = wsock::spawn_auth(origin.clone(), url.clone(), auth.clone(), None, conn);
        sh.dirs.lock().unwrap().entry(dir.clone()).or_insert((DirState::Connecting, None)).1 = Some(sock.clone());
        if sh.stopped() {
            sock.send(ToSock::Close);
        }
        let (_code, reason, ready) = drx.recv().unwrap_or((1006, "gone".into(), false));
        if let Some(e) = sh.dirs.lock().unwrap().get_mut(&dir) {
            e.1 = None;
        }
        if sh.stopped() {
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
                sh.set(&dir, state);
                return;
            }
            DirState::Unsupported => UNSUPPORTED_RETRY,
            _ => delay,
        };
        sh.set(&dir, state);
        if sh.sleep(wait) {
            return;
        }
        delay = (delay * 2).min(BACKOFF_MAX);
    }
}

/// The socket's events: answers the server's MCP requests (tool calls on the UI thread).
struct Conn {
    sh: Arc<Shared>,
    dir: String,
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
            self.sh.set(&self.dir, DirState::Ready);
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
                let call = Call {
                    session,
                    reply: Some(Box::new(move |result| {
                        sh.calls.fetch_add(1, Ordering::SeqCst);
                        send(&tx, id, Ok(result));
                    })),
                };
                let run = tool.run;
                self.sh.handle.update(move |app, tx| run(app, &args, call, tx));
            }
            _ => send(&tx, id, Err((-32601, format!("Method not found: {method}")))),
        }
    }

    fn closed(self, code: u16, reason: String) {
        let _ = self.done.send((code, reason, self.ready));
    }
}

/// `--oc-tools-selftest=<server URL>` (`--opencode-password=…`, `--opencode-dir=<directory on the server>`,
/// `--opencode-keep`): this module against a real server, headless: the sockets come up, a new session is asked
/// to call `grim_ping`, the call reaches the app (its update queue, as the UI thread) and the reply has the
/// answer. The session is deleted afterwards unless kept. Exit status 0 when all of that happened.
pub fn selftest(args: &[String]) -> i32 {
    use crate::opencode::{CHAT_EVENTS, Event};
    use crate::remote::{Backend, Update};
    use std::time::Instant;
    let arg = |name: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_string));
    let Some(url) = arg("oc-tools-selftest").and_then(|u| opencode::server_address(&u)) else {
        eprintln!("oc-tools selftest: --oc-tools-selftest=<server URL>");
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
    let (utx, urx) = mpsc::channel::<Update>();
    let mut app = App::new("", None, true);
    app.backend = Backend::Net(Handle::Chan(utx.clone()));
    let mut tx = Tx::default();
    let dir = arg("opencode-dir");
    start(pairing, Handle::Chan(utx));
    if let Some(d) = &dir {
        ensure_directory(d);
    }
    let key = dir.clone().unwrap_or_default();
    let t = Instant::now();
    while !states().iter().any(|(d, s)| *d == key && *s == DirState::Ready) && t.elapsed() < Duration::from_secs(30) {
        if let Ok(u) = urx.recv_timeout(Duration::from_millis(200)) {
            u(&mut app, &mut tx);
        }
    }
    eprintln!("oc-tools selftest: sockets after {} ms: {:?}; {:?}", t.elapsed().as_millis(), states(), summary());
    if !states().iter().any(|(d, s)| *d == key && *s == DirState::Ready) {
        stop();
        return 1;
    }
    let session = match client.create_session(Some("Grim tools selftest"), dir.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("oc-tools selftest: create session: {e}");
            stop();
            return 1;
        }
    };
    eprintln!("oc-tools selftest: session {} in {}", session.id, session.directory);
    let stop_events = Arc::new(AtomicBool::new(false));
    let (etx, erx) = mpsc::channel::<Event>();
    {
        let (client, stop_events) = (client.clone(), stop_events.clone());
        std::thread::spawn(move || {
            let _ = client.events(CHAT_EVENTS, &stop_events, |ev| etx.send(ev).is_ok());
        });
    }
    std::thread::sleep(Duration::from_millis(500));
    let prompt = arg("opencode-prompt").unwrap_or_else(|| "Call the grim_ping tool, then reply with exactly the text it returned.".into());
    if let Err(e) = client.prompt(&session.id, &prompt) {
        eprintln!("oc-tools selftest: prompt: {e}");
    }
    let mut reply = String::new();
    let mut outcome = None;
    let sent = Instant::now();
    while outcome.is_none() && sent.elapsed() < Duration::from_secs(240) {
        // tool calls run here, as on the UI thread
        if let Ok(u) = urx.recv_timeout(Duration::from_millis(100)) {
            u(&mut app, &mut tx);
        }
        while let Ok(ev) = erx.try_recv() {
            if ev.session() != Some(session.id.as_str()) {
                continue;
            }
            match ev {
                Event::TextDelta { delta, .. } => reply.push_str(&delta),
                Event::Finished { outcome: o, .. } => outcome = Some(o),
                _ => {}
            }
        }
    }
    stop_events.store(true, Ordering::SeqCst);
    let tools = client.messages(&session.id, 10).map(|m| m.iter().flat_map(|m| m.tools.clone()).collect::<Vec<_>>()).unwrap_or_default();
    let n = calls();
    eprintln!("oc-tools selftest: outcome {outcome:?}; tools used {tools:?}; calls answered by the app {n}; reply {reply:?}");
    if !args.iter().any(|a| a == "--opencode-keep") {
        eprintln!("oc-tools selftest: delete session: {:?}", client.delete_session(&session.id));
    }
    stop();
    // with code mode the model reaches grim_ping through `execute`, so the call counts, not the tool's name
    let ok = n > 0 && !tools.is_empty() && reply.contains("pong from Grim");
    eprintln!("oc-tools selftest: {}", if ok { "PASSED" } else { "FAILED" });
    if ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_urls() {
        assert_eq!(socket_url("http://127.0.0.1:4096", ""), "ws://127.0.0.1:4096/api/experimental/client-mcp?name=grim");
        assert_eq!(socket_url("https://h.example/oc", "/Users/j/a b"), format!("wss://h.example/oc/api/experimental/client-mcp?name=grim&location%5Bdirectory%5D={}", net::enc("/Users/j/a b")));
    }
}
