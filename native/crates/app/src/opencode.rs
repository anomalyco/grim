//! OpenCode (experimental, Mac only): pairing with an OpenCode server and talking to it directly. No UI here (the
//! dialog is `opencode_ui.rs`); voice can drive a session through `Client` alone.
//!
//! Re-implemented from how the OpenCode app pairs (anomalyco/opencode: `packages/app/src/servers/connect/
//! pairing.ts`, the server's `packages/server/src/pairing.ts`, `auth.ts` and `middleware/authorization.ts`):
//!
//! - **Pairing links.** `opencode pair`, on the machine running OpenCode, asks its server for a single-use code
//!   (`POST /api/pair`, 5 minutes) and prints `<address>/auth/connect/<code>` for every address the server listens
//!   on, plus a QR code holding `{"code","urls"}` JSON with the addresses other devices can reach. Either pasted
//!   here pairs (`parse_pasted`). Redeeming the code, `GET /auth/connect/<code>` with `Accept: application/json`,
//!   answers `{"token"}`: a session token (30 days, signed with the server's password, so changing the password
//!   revokes it) that works wherever the password does. With several addresses all are tried at once (the code
//!   works once, so at most one succeeds); the first address wins when it answers within a second (`redeem`).
//! - **Password.** The fallback: the server's address and its password (`OPENCODE_SERVER_PASSWORD`).
//! - **Auth.** Every request sends HTTP Basic `opencode:<token or password>`; a server without a password needs
//!   none. 401 means the pairing no longer works.
//! - **API (v2).** `GET /api/info`, `GET /api/session`, `GET /api/session/:id/message`, `POST /api/session`,
//!   `POST /api/session/:id/prompt {text}`, and the event stream `GET /api/event?types=…` (server-sent events, a
//!   `server.connected` first, a heartbeat comment every 15 s; events missed while disconnected are gone).
//!
//! The pairing (`Pairing`: the address and the token or password) is kept in the Keychain like the app's Grim
//! tokens: the app's own generic-password item, service "Grimoire", account `opencode-pairing`.

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::net;
use crate::workspaces::Tokens;

/// The username OpenCode servers expect with the password or token.
pub const USERNAME: &str = "opencode";
/// The Keychain item (service "Grimoire") that holds the pairing.
pub const KEYCHAIN_ACCOUNT: &str = "opencode-pairing";
/// Redeeming a code, per address (the OpenCode app's).
const REDEEM_TIMEOUT: Duration = Duration::from_secs(5);
/// The server sends a heartbeat every 15 s: a read waiting longer than this means the stream is gone.
const EVENT_READ_TIMEOUT: Duration = Duration::from_secs(40);

/// The events a chat needs (`Client::events`' filter): a prompt admitted, a run starting and ending, the reply's
/// text as it streams.
pub const CHAT_EVENTS: &[&str] = &[
    "session.inbox.enqueued",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.text.started",
    "session.text.delta",
    "session.text.ended",
];

/// A paired server: where it is and what to sign requests with (a pairing link's session token, or the password).
#[derive(Clone, PartialEq, Eq)]
pub struct Pairing {
    /// `http(s)://host[:port][/prefix]`, no trailing slash.
    pub url: String,
    /// Empty for a server without a password.
    pub password: String,
}

impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pairing").field("url", &self.url).field("password", &"…").finish()
    }
}

impl Pairing {
    /// The Keychain value: base64url of `{"url","password"}`.
    pub fn encode(&self) -> String {
        net::base64url(json!({ "url": self.url, "password": self.password }).to_string().as_bytes())
    }

    pub fn decode(s: &str) -> Option<Pairing> {
        let v: Value = serde_json::from_slice(&base64url_decode(s)?).ok()?;
        Some(Pairing { url: server_address(v["url"].as_str()?)?, password: v["password"].as_str()?.to_string() })
    }

    /// `host:port` for display.
    pub fn host(&self) -> String {
        net::parse_url(&self.url).map(|u| u.display_host()).unwrap_or_else(|_| self.url.clone())
    }
}

/// The stored pairing, if any.
pub fn load(tokens: &Tokens) -> Option<Pairing> {
    tokens.get(KEYCHAIN_ACCOUNT).and_then(|s| Pairing::decode(&s))
}

/// Keep `p` (replacing any other); says where it went.
pub fn save(tokens: &Tokens, p: &Pairing) -> Result<&'static str, String> {
    let v = p.encode();
    if !crate::workspaces::valid_token(&v) {
        return Err("the address and password are too long to keep".into());
    }
    tokens.set(KEYCHAIN_ACCOUNT, &v)
}

pub fn forget(tokens: &Tokens) {
    tokens.remove(KEYCHAIN_ACCOUNT);
}

// ---- what was pasted ----

/// A server address as the OpenCode app takes it: http(s) only (no scheme means http), no user info, query or
/// fragment; a path prefix allowed (servers behind a proxy); no trailing slash.
pub fn server_address(value: &str) -> Option<String> {
    let t = value.trim();
    if t.is_empty() || t.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    let with = if lower.starts_with("http://") || lower.starts_with("https://") {
        t.to_string()
    } else if t.contains("://") {
        return None;
    } else {
        format!("http://{t}")
    };
    let after = &with[with.find("://")? + 3..];
    let authority = after.split('/').next().unwrap_or("");
    if authority.contains('@') || with.contains(['?', '#']) {
        return None;
    }
    let u = net::parse_url(&with).ok()?;
    Some(format!("{}{}", u.origin(), u.path.trim_end_matches('/')))
}

/// What was typed or pasted into the pairing field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pasted {
    /// A pairing link (`<address>/auth/connect/<code>`) or the QR code's `{"code","urls"}`.
    Link { urls: Vec<String>, code: String },
    /// A bare server address: it belongs in the password form.
    Server(String),
    /// A link from servers before one-time codes (`/connect#…`, `/connect?data=…`).
    Legacy,
    Invalid,
}

fn valid_code(c: &str) -> bool {
    !c.is_empty() && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn parse_pasted(value: &str) -> Pasted {
    let t = value.trim();
    if t.starts_with('{') {
        let Ok(v) = serde_json::from_str::<Value>(t) else { return Pasted::Invalid };
        let (Some(code), Some(list)) = (v["code"].as_str(), v["urls"].as_array()) else { return Pasted::Invalid };
        if !valid_code(code) {
            return Pasted::Invalid;
        }
        let mut urls: Vec<String> = Vec::new();
        for u in list {
            let Some(a) = u.as_str().and_then(server_address) else { return Pasted::Invalid };
            if !urls.contains(&a) {
                urls.push(a);
            }
        }
        if urls.is_empty() {
            return Pasted::Invalid;
        }
        return Pasted::Link { urls, code: code.to_string() };
    }
    let lower = t.to_ascii_lowercase();
    let http = lower.starts_with("http://") || lower.starts_with("https://");
    if http && let Ok(u) = net::parse_url(t.split('#').next().unwrap_or(t)) {
        let path = u.path.split('?').next().unwrap_or("");
        if let Some(code) = path.strip_prefix("/auth/connect/")
            && valid_code(code)
            && let Some(a) = server_address(&u.origin())
        {
            return Pasted::Link { urls: vec![a], code: code.to_string() };
        }
        let after_path = &t[t.find("://").map_or(0, |i| i + 3)..];
        let raw_path = after_path.find('/').map_or("", |i| &after_path[i..]);
        if (raw_path.starts_with("/connect#") && raw_path.len() > "/connect#".len()) || (path == "/connect" && net::query_param(&u.path, "data").is_some()) {
            return Pasted::Legacy;
        }
    }
    if let Some(a) = server_address(t)
        && let Ok(u) = net::parse_url(&a)
        && u.path == "/"
        && (u.host == "localhost" || u.host.contains('.') || u.host.contains(':') || t.contains(':'))
    {
        return Pasted::Server(a);
    }
    Pasted::Invalid
}

// ---- errors ----

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OcError {
    /// 401: wrong password, or the pairing expired or was revoked (or, redeeming, the code was spent).
    Unauthorized,
    /// Another error status, with the server's message.
    Http(u16, String),
    /// The server couldn't be reached, or the connection broke.
    Net(String),
}

impl std::fmt::Display for OcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OcError::Unauthorized => write!(f, "the server refused the password or pairing"),
            OcError::Http(s, m) if m.is_empty() => write!(f, "HTTP {s}"),
            OcError::Http(s, m) => write!(f, "{m} (HTTP {s})"),
            OcError::Net(e) => write!(f, "{e}"),
        }
    }
}

/// An error body's message (`{"_tag","message"}`), else its first line.
fn error_message(body: &[u8]) -> String {
    if let Ok(v) = serde_json::from_slice::<Value>(body)
        && let Some(m) = v["message"].as_str().or_else(|| v["error"].as_str())
    {
        return m.to_string();
    }
    String::from_utf8_lossy(body).lines().next().unwrap_or("").chars().take(200).collect()
}

// ---- redeeming a pairing link ----

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Redeemed {
    Paired(Pairing),
    /// A server answered that the code was spent or expired.
    Expired,
    /// No address answered: why, per address.
    Unreachable(String),
}

fn redeem_one(url: &str, code: &str) -> Result<String, OcError> {
    let (status, _, body) = net::raw_within("GET", &format!("{url}/auth/connect/{code}"), &[("Accept", "application/json")], None, Some(REDEEM_TIMEOUT)).map_err(OcError::Net)?;
    match status {
        200..=299 => {
            let v: Value = serde_json::from_slice(&body).map_err(|e| OcError::Net(format!("bad JSON from the server: {e}")))?;
            v["token"].as_str().filter(|t| !t.is_empty()).map(str::to_string).ok_or_else(|| OcError::Net("the server sent no token".into()))
        }
        401 => Err(OcError::Unauthorized),
        s => Err(OcError::Http(s, error_message(&body))),
    }
}

/// Redeem `code` at every address at once; keep the first address when it answers (within a second of another
/// address pairing) and works with the token, as a local address stops working away from that network.
pub fn redeem(urls: &[String], code: &str) -> Redeemed {
    let (tx, rx) = mpsc::channel();
    for (i, url) in urls.iter().enumerate() {
        let (tx, url, code) = (tx.clone(), url.clone(), code.to_string());
        std::thread::spawn(move || {
            let r = redeem_one(&url, &code);
            let _ = tx.send((i, url, r));
        });
    }
    drop(tx);
    let (mut expired, mut errors) = (false, Vec::new());
    // whether the first address answered at all (a 401 there: another address spent the code first)
    let mut first: Option<bool> = None;
    let mut won: Option<(usize, Pairing)> = None;
    while let Ok((i, url, r)) = rx.recv() {
        match r {
            Ok(token) => {
                won = Some((i, Pairing { url, password: token }));
                break;
            }
            Err(OcError::Unauthorized) => {
                expired = true;
                if i == 0 {
                    first = Some(true);
                }
            }
            Err(e) => {
                errors.push(format!("{}: {e}", url));
                if i == 0 {
                    first = Some(false);
                }
            }
        }
    }
    let Some((i, p)) = won else {
        return if expired { Redeemed::Expired } else { Redeemed::Unreachable(errors.join("; ")) };
    };
    if i == 0 || urls.len() < 2 {
        return Redeemed::Paired(p);
    }
    if first.is_none() {
        let deadline = Instant::now() + Duration::from_secs(1);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok((0, _, r)) => {
                    first = Some(matches!(r, Ok(_) | Err(OcError::Unauthorized)));
                    break;
                }
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    }
    if first == Some(true) {
        let c = Client::new(Pairing { url: urls[0].clone(), password: p.password.clone() });
        if c.call_within("GET", "/api/info", None, Some(REDEEM_TIMEOUT)).is_ok() {
            return Redeemed::Paired(c.pairing);
        }
    }
    Redeemed::Paired(p)
}

// ---- the API ----

/// `GET /api/info`.
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub version: String,
    pub hostname: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: String,
    pub title: String,
    /// Where it works (`location.directory`).
    pub directory: String,
    /// Last change, ms since the epoch.
    pub updated: i64,
    /// A subagent's session: its parent's id.
    pub parent: Option<String>,
}

impl Session {
    fn from_json(v: &Value) -> Option<Session> {
        Some(Session {
            id: v["id"].as_str()?.to_string(),
            title: v["title"].as_str().unwrap_or("").to_string(),
            directory: v["location"]["directory"].as_str().unwrap_or("").to_string(),
            updated: v["time"]["updated"].as_i64().or_else(|| v["time"]["created"].as_i64()).unwrap_or(0),
            parent: v["parentID"].as_str().map(str::to_string),
        })
    }
}

/// A message of a session, as text: the prompt, or the reply's text with the tools it used. Other kinds of
/// message (agent or model switches, shell, compaction, idle markers) are left out.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub id: String,
    pub user: bool,
    pub text: String,
    /// The reply's tool calls, by name.
    pub tools: Vec<String>,
    pub error: Option<String>,
}

impl Message {
    pub fn from_json(v: &Value) -> Option<Message> {
        let id = v["id"].as_str()?.to_string();
        match v["type"].as_str()? {
            "user" => Some(Message { id, user: true, text: v["text"].as_str().unwrap_or("").to_string(), tools: Vec::new(), error: None }),
            "assistant" => {
                let mut texts = Vec::new();
                let mut tools = Vec::new();
                for part in v["content"].as_array().map(Vec::as_slice).unwrap_or_default() {
                    match part["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = part["text"].as_str().filter(|t| !t.trim().is_empty()) {
                                texts.push(t.to_string());
                            }
                        }
                        Some("tool") => tools.push(part["name"].as_str().unwrap_or("tool").to_string()),
                        _ => {}
                    }
                }
                let error = v["error"]["message"].as_str().map(str::to_string);
                Some(Message { id, user: false, text: texts.join("\n\n"), tools, error })
            }
            _ => None,
        }
    }
}

/// How a run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Failed(String),
    Interrupted(String),
}

/// One event of the stream, for chats (`CHAT_EVENTS`); the rest is `Other`.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The stream is up (`server.connected`).
    Connected,
    /// The server's keep-alive comment.
    Heartbeat,
    /// A prompt was admitted (`id` is its message's).
    UserQueued { session: String, id: String, text: String },
    /// The agent started working on the session.
    Started { session: String },
    TextStarted { session: String, message: String, ordinal: u64 },
    TextDelta { session: String, message: String, ordinal: u64, delta: String },
    TextEnded { session: String, message: String, ordinal: u64, text: String },
    Finished { session: String, outcome: Outcome },
    Other(String),
}

impl Event {
    /// The session it is about.
    pub fn session(&self) -> Option<&str> {
        match self {
            Event::UserQueued { session, .. }
            | Event::Started { session }
            | Event::TextStarted { session, .. }
            | Event::TextDelta { session, .. }
            | Event::TextEnded { session, .. }
            | Event::Finished { session, .. } => Some(session.as_str()),
            _ => None,
        }
    }
}

pub fn parse_event(v: &Value) -> Event {
    let ty = v["type"].as_str().unwrap_or("");
    let d = &v["data"];
    let s = |k: &str| d[k].as_str().unwrap_or("").to_string();
    let session = s("sessionID");
    let ordinal = d["ordinal"].as_u64().unwrap_or(0);
    match ty {
        "server.connected" => Event::Connected,
        "session.inbox.enqueued" => Event::UserQueued { session, id: s("inboxID"), text: d["item"]["payload"]["text"].as_str().unwrap_or("").to_string() },
        "session.execution.started" => Event::Started { session },
        "session.text.started" => Event::TextStarted { session, message: s("assistantMessageID"), ordinal },
        "session.text.delta" => Event::TextDelta { session, message: s("assistantMessageID"), ordinal, delta: s("delta") },
        "session.text.ended" => Event::TextEnded { session, message: s("assistantMessageID"), ordinal, text: s("text") },
        "session.execution.succeeded" => Event::Finished { session, outcome: Outcome::Succeeded },
        "session.execution.failed" => {
            let m = d["error"]["message"].as_str().unwrap_or("The run failed").to_string();
            Event::Finished { session, outcome: Outcome::Failed(m) }
        }
        "session.execution.interrupted" => Event::Finished { session, outcome: Outcome::Interrupted(s("reason")) },
        other => Event::Other(other.to_string()),
    }
}

/// Talks to a paired server. Every call blocks: run them off the UI thread.
#[derive(Clone, Debug)]
pub struct Client {
    pub pairing: Pairing,
}

impl Client {
    pub fn new(pairing: Pairing) -> Client {
        Client { pairing }
    }

    /// `Authorization: Basic base64(opencode:<password>)`, none without a password.
    fn auth(&self) -> Option<String> {
        (!self.pairing.password.is_empty()).then(|| format!("Basic {}", base64(format!("{USERNAME}:{}", self.pairing.password).as_bytes())))
    }

    fn call_within(&self, method: &str, path: &str, body: Option<&Value>, timeout: Option<Duration>) -> Result<Value, OcError> {
        let auth = self.auth();
        let mut headers: Vec<(&str, &str)> = vec![("Accept", "application/json")];
        if let Some(a) = &auth {
            headers.push(("Authorization", a));
        }
        let payload = body.map(Value::to_string);
        if payload.is_some() {
            headers.push(("Content-Type", "application/json"));
        }
        let url = format!("{}{path}", self.pairing.url);
        let (status, _, b) = net::raw_within(method, &url, &headers, payload.as_deref().map(str::as_bytes), timeout).map_err(OcError::Net)?;
        match status {
            200..=299 if b.is_empty() => Ok(Value::Null),
            200..=299 => serde_json::from_slice(&b).map_err(|e| OcError::Net(format!("bad JSON from the server: {e}"))),
            401 => Err(OcError::Unauthorized),
            s => Err(OcError::Http(s, error_message(&b))),
        }
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, OcError> {
        self.call_within(method, path, body, None)
    }

    /// `GET /api/info`: also checks the address and credentials.
    pub fn info(&self) -> Result<Info, OcError> {
        let v = self.call("GET", "/api/info", None)?;
        let version = v["version"].as_str().ok_or_else(|| OcError::Net("that isn't an OpenCode server (no version in /api/info)".into()))?;
        Ok(Info { version: version.to_string(), hostname: v["hostname"].as_str().map(str::to_string) })
    }

    /// `GET /api/session?limit=`: the newest sessions first, subagents' sessions included (`Session::parent`).
    pub fn sessions(&self, limit: usize) -> Result<Vec<Session>, OcError> {
        let v = self.call("GET", &format!("/api/session?limit={limit}"), None)?;
        let mut out: Vec<Session> = v["data"].as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(Session::from_json).collect();
        out.sort_by(|a, b| b.updated.cmp(&a.updated));
        Ok(out)
    }

    /// `GET /api/session/:id/message?limit=&order=desc`: the latest `limit` messages, oldest first.
    pub fn messages(&self, session: &str, limit: usize) -> Result<Vec<Message>, OcError> {
        let v = self.call("GET", &format!("/api/session/{}/message?limit={}&order=desc", net::enc(session), limit.clamp(1, 200)), None)?;
        let mut out: Vec<Message> = v["data"].as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(Message::from_json).collect();
        out.reverse();
        Ok(out)
    }

    /// `POST /api/session/:id/prompt {text}`: the prompt is admitted and the agent starts; the reply comes as
    /// events. Returns the prompt's message id.
    pub fn prompt(&self, session: &str, text: &str) -> Result<String, OcError> {
        let v = self.call("POST", &format!("/api/session/{}/prompt", net::enc(session)), Some(&json!({ "text": text })))?;
        Ok(v["data"]["id"].as_str().unwrap_or("").to_string())
    }

    /// `POST /api/session`: a new session (in `directory` on the server's machine, else the server's default).
    pub fn create_session(&self, title: Option<&str>, directory: Option<&str>) -> Result<Session, OcError> {
        let mut body = json!({});
        if let Some(t) = title {
            body["title"] = json!(t);
        }
        if let Some(d) = directory {
            body["location"] = json!({ "directory": d });
        }
        let v = self.call("POST", "/api/session", Some(&body))?;
        Session::from_json(&v["data"]).ok_or_else(|| OcError::Net("the server sent no session".into()))
    }

    /// `GET /api/session/:id`.
    pub fn session(&self, session: &str) -> Result<Session, OcError> {
        let v = self.call("GET", &format!("/api/session/{}", net::enc(session)), None)?;
        Session::from_json(&v["data"]).ok_or_else(|| OcError::Net("the server sent no session".into()))
    }

    /// `POST /api/session {parentID}`: a child session of `parent` (where it works), like a subagent's.
    pub fn create_child_session(&self, parent: &str, title: &str) -> Result<Session, OcError> {
        let v = self.call("POST", "/api/session", Some(&json!({ "parentID": parent, "title": title })))?;
        Session::from_json(&v["data"]).ok_or_else(|| OcError::Net("the server sent no session".into()))
    }

    /// `DELETE /api/session/:id`.
    pub fn delete_session(&self, session: &str) -> Result<(), OcError> {
        self.call("DELETE", &format!("/api/session/{}", net::enc(session)), None).map(|_| ())
    }

    /// `GET /api/event?types=…`: hands each event to `on` until it returns false or `stop` is set (Ok), or the
    /// stream fails or ends (Err). Blocks; `stop` is seen at the latest with the next heartbeat (15 s).
    pub fn events(&self, types: &[&str], stop: &AtomicBool, mut on: impl FnMut(Event) -> bool) -> Result<(), OcError> {
        let query: Vec<String> = types.iter().map(|t| format!("types={}", net::enc(t))).collect();
        let path = if query.is_empty() { "/api/event".to_string() } else { format!("/api/event?{}", query.join("&")) };
        let u = net::parse_url(&format!("{}{path}", self.pairing.url)).map_err(OcError::Net)?;
        let mut s = net::connect_within(&u, Some(Duration::from_secs(10))).map_err(OcError::Net)?;
        s.set_read_timeout(Some(EVENT_READ_TIMEOUT));
        let auth = self.auth();
        let mut headers: Vec<(&str, &str)> = vec![("Accept", "text/event-stream"), ("Cache-Control", "no-cache")];
        if let Some(a) = &auth {
            headers.push(("Authorization", a));
        }
        let head = net::request_head("GET", &u, &headers, None).map_err(OcError::Net)? + "\r\n";
        s.write_all(head.as_bytes()).and_then(|()| s.flush()).map_err(|e| OcError::Net(e.to_string()))?;
        let mut r = BufReader::new(s);
        let io = |e: std::io::Error| OcError::Net(if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) { "the event stream went quiet".into() } else { e.to_string() });
        let mut line = String::new();
        r.read_line(&mut line).map_err(io)?;
        let status: u16 = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or_else(|| OcError::Net("not an HTTP response".into()))?;
        let mut chunked = false;
        loop {
            line.clear();
            if r.read_line(&mut line).map_err(io)? == 0 {
                break;
            }
            let l = line.trim_end();
            if l.is_empty() {
                break;
            }
            if let Some((k, v)) = l.split_once(':')
                && k.trim().eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
        if status == 401 {
            return Err(OcError::Unauthorized);
        }
        if !(200..300).contains(&status) {
            let mut b = Vec::new();
            let _ = r.take(4096).read_to_end(&mut b);
            return Err(OcError::Http(status, error_message(&b)));
        }
        let mut body: Box<dyn BufRead> = if chunked { Box::new(BufReader::new(Chunked { inner: r, left: 0, done: false })) } else { Box::new(r) };
        let mut data = String::new();
        loop {
            if stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            line.clear();
            if body.read_line(&mut line).map_err(io)? == 0 {
                return Err(OcError::Net("the server closed the event stream".into()));
            }
            let l = line.trim_end_matches(['\r', '\n']);
            if l.is_empty() {
                if data.is_empty() {
                    continue;
                }
                let ev = serde_json::from_str::<Value>(&data).map(|v| parse_event(&v)).unwrap_or_else(|_| Event::Other("unreadable".into()));
                data.clear();
                if !on(ev) {
                    return Ok(());
                }
            } else if l.starts_with(':') {
                if !on(Event::Heartbeat) {
                    return Ok(());
                }
            } else if let Some(d) = l.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(d.strip_prefix(' ').unwrap_or(d));
            }
        }
    }
}

/// A chunked body read as it arrives (the event stream never ends).
struct Chunked<R: BufRead> {
    inner: R,
    left: usize,
    done: bool,
}

impl<R: BufRead> Read for Chunked<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            let mut size = String::new();
            // the CRLF that ends the previous chunk, then the next chunk's size
            while size.trim().is_empty() {
                size.clear();
                if self.inner.read_line(&mut size)? == 0 {
                    self.done = true;
                    return Ok(0);
                }
            }
            let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or(""), 16).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad chunk"))?;
            if n == 0 {
                self.done = true;
                return Ok(0);
            }
            self.left = n;
        }
        let want = buf.len().min(self.left);
        let got = self.inner.read(&mut buf[..want])?;
        if got == 0 {
            self.done = true;
        }
        self.left -= got;
        Ok(got)
    }
}

/// Standard base64 with padding (HTTP Basic).
pub fn base64(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// Base64url without padding, decoded (`net::base64url`'s inverse).
pub(crate) fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32)
    };
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for c in s.chunks(4) {
        if c.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, &x) in c.iter().enumerate() {
            n |= val(x)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if c.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if c.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// `--opencode-selftest=<pairing link, QR text or server URL>` (`--opencode-password=…` with a URL;
/// `--opencode-session=<id>` or `--opencode-dir=<directory on the server>`; `--opencode-prompt=…`): the app's
/// pairing and API code against a real server, headless. Pairs, keeps and reads back the pairing (a file in a
/// temporary folder, and with `--opencode-keychain` the Keychain under a test account), lists sessions, sends a
/// prompt and prints the reply as it streams. Exit status 0 when a reply arrived.
pub fn selftest(args: &[String]) -> i32 {
    let arg = |name: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_string));
    let Some(input) = arg("opencode-selftest") else {
        eprintln!("opencode selftest: --opencode-selftest=<pairing link | QR text | server URL>");
        return 2;
    };
    let t0 = Instant::now();
    let pairing = match parse_pasted(&input) {
        Pasted::Link { urls, code } => {
            eprintln!("opencode selftest: pairing link, {} address(es): {}", urls.len(), urls.join(", "));
            match redeem(&urls, &code) {
                Redeemed::Paired(p) => {
                    eprintln!("opencode selftest: paired with {} ({} ms); token {} characters", p.url, t0.elapsed().as_millis(), p.password.len());
                    p
                }
                Redeemed::Expired => {
                    eprintln!("opencode selftest: the code expired or was already used");
                    return 1;
                }
                Redeemed::Unreachable(e) => {
                    eprintln!("opencode selftest: unreachable: {e}");
                    return 1;
                }
            }
        }
        Pasted::Server(url) => Pairing { url, password: arg("opencode-password").unwrap_or_default() },
        other => {
            eprintln!("opencode selftest: not a pairing link or server address: {other:?}");
            return 2;
        }
    };
    // keep it and read it back the way the app does
    let dir = std::env::temp_dir().join(format!("grim-opencode-selftest-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let file = Tokens::File(dir.join("tokens.json"));
    let stored = save(&file, &pairing).and_then(|w| if load(&file).as_ref() == Some(&pairing) { Ok(w) } else { Err("read back differs".into()) });
    forget(&file);
    eprintln!("opencode selftest: stored and read back (file): {stored:?}; after forget: {}", load(&file).is_none());
    let _ = std::fs::remove_dir_all(&dir);
    if args.iter().any(|a| a == "--opencode-keychain") {
        let account = format!("{KEYCHAIN_ACCOUNT}-selftest-{}", std::process::id());
        let set = crate::workspaces::keychain::set(&account, &pairing.encode());
        let back = crate::workspaces::keychain::get(&account).and_then(|v| Pairing::decode(&v));
        crate::workspaces::keychain::remove(&account);
        eprintln!("opencode selftest: Keychain: set {set:?}; read back {}; after delete {}", back.as_ref() == Some(&pairing), crate::workspaces::keychain::get(&account).is_none());
    }
    let client = Client::new(pairing);
    match client.info() {
        Ok(i) => eprintln!("opencode selftest: OpenCode {} on {}", i.version, i.hostname.as_deref().unwrap_or("?")),
        Err(e) => {
            eprintln!("opencode selftest: /api/info: {e}");
            return 1;
        }
    }
    match client.sessions(50) {
        Ok(list) => {
            eprintln!("opencode selftest: {} sessions ({} top-level)", list.len(), list.iter().filter(|s| s.parent.is_none()).count());
            for s in list.iter().filter(|s| s.parent.is_none()).take(3) {
                eprintln!("  {} {:?} in {}", s.id, s.title, s.directory);
            }
        }
        Err(e) => {
            eprintln!("opencode selftest: sessions: {e}");
            return 1;
        }
    }
    let session = match arg("opencode-session") {
        Some(id) => id,
        None => match client.create_session(Some("Grim pairing selftest"), arg("opencode-dir").as_deref()) {
            Ok(s) => {
                eprintln!("opencode selftest: created session {} in {}", s.id, s.directory);
                s.id
            }
            Err(e) => {
                eprintln!("opencode selftest: create session: {e}");
                return 1;
            }
        },
    };
    match client.messages(&session, 30) {
        Ok(m) => eprintln!("opencode selftest: {} recent messages", m.len()),
        Err(e) => {
            eprintln!("opencode selftest: messages: {e}");
            return 1;
        }
    }
    // the stream first, then the prompt: the reply as it streams
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let (etx, erx) = mpsc::channel::<Result<Event, OcError>>();
    {
        let (client, stop, etx) = (client.clone(), stop.clone(), etx.clone());
        std::thread::spawn(move || {
            let r = client.events(CHAT_EVENTS, &stop, |ev| etx.send(Ok(ev)).is_ok());
            if let Err(e) = r {
                let _ = etx.send(Err(e));
            }
        });
    }
    match erx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(Event::Connected)) => eprintln!("opencode selftest: event stream connected"),
        other => {
            eprintln!("opencode selftest: event stream: {other:?}");
            return 1;
        }
    }
    let text = arg("opencode-prompt").unwrap_or_else(|| "Reply with exactly: pong from opencode".into());
    let sent = Instant::now();
    match client.prompt(&session, &text) {
        Ok(id) => eprintln!("opencode selftest: prompt sent ({id})"),
        Err(e) => {
            eprintln!("opencode selftest: prompt: {e}");
            return 1;
        }
    }
    let mut reply = String::new();
    let mut first_delta = None;
    let mut outcome = None;
    while sent.elapsed() < Duration::from_secs(180) {
        match erx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(ev)) if ev.session() == Some(session.as_str()) => match ev {
                Event::TextDelta { delta, .. } => {
                    first_delta.get_or_insert(sent.elapsed());
                    eprintln!("opencode selftest: delta {delta:?}");
                    reply.push_str(&delta);
                }
                Event::Finished { outcome: o, .. } => {
                    outcome = Some(o);
                    break;
                }
                other => eprintln!("opencode selftest: {other:?}"),
            },
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                eprintln!("opencode selftest: event stream: {e}");
                break;
            }
            Err(_) => {}
        }
    }
    stop.store(true, Ordering::SeqCst);
    eprintln!("opencode selftest: outcome {outcome:?}; first text after {first_delta:?}; reply {reply:?}");
    if let Ok(m) = client.messages(&session, 5) {
        if let Some(last) = m.iter().rev().find(|m| !m.user) {
            eprintln!("opencode selftest: last reply as stored: {:?} (tools {:?})", last.text, last.tools);
        }
    }
    if reply.is_empty() { 1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_links_and_qr_text() {
        assert_eq!(
            parse_pasted(" http://100.73.96.98:49374/auth/connect/MWClz7TUU2yW3U88stV_Iw "),
            Pasted::Link { urls: vec!["http://100.73.96.98:49374".into()], code: "MWClz7TUU2yW3U88stV_Iw".into() }
        );
        assert_eq!(
            parse_pasted(r#"{"code":"ab-C_1","urls":["http://10.0.0.2:4096","https://x.example/","http://10.0.0.2:4096"]}"#),
            Pasted::Link { urls: vec!["http://10.0.0.2:4096".into(), "https://x.example".into()], code: "ab-C_1".into() }
        );
        assert_eq!(parse_pasted(r#"{"code":"a b","urls":["http://h:1"]}"#), Pasted::Invalid);
        assert_eq!(parse_pasted(r#"{"code":"ab","urls":["ftp://h"]}"#), Pasted::Invalid);
        assert_eq!(parse_pasted("http://h.example:4096/connect#abc"), Pasted::Legacy);
        assert_eq!(parse_pasted("http://h.example:4096/connect?data=abc"), Pasted::Legacy);
        assert_eq!(parse_pasted("192.168.1.20:4096"), Pasted::Server("http://192.168.1.20:4096".into()));
        assert_eq!(parse_pasted("localhost"), Pasted::Server("http://localhost".into()));
        assert_eq!(parse_pasted("MWClz7TUU2yW3U88stV_Iw"), Pasted::Invalid);
        assert_eq!(server_address("https://u:p@h.example/"), None);
        assert_eq!(server_address("HTTPS://H.example:443/oc/"), Some("https://h.example/oc".into()));
    }

    #[test]
    fn the_pairing_round_trips_and_basic_auth_is_standard_base64() {
        let p = Pairing { url: "http://100.73.96.98:49374".into(), password: "1796151014.4BUQ0pZeksDebTpr2pbVwg5UiQDtd1Gmw80gIIkRrrs".into() };
        assert_eq!(Pairing::decode(&p.encode()), Some(p.clone()));
        assert!(crate::workspaces::valid_token(&p.encode()));
        assert_eq!(base64(b"opencode:pw"), "b3BlbmNvZGU6cHc=");
        assert_eq!((base64(b"f"), base64(b"fo"), base64(b"foo")), ("Zg==".into(), "Zm8=".into(), "Zm9v".into()));
        assert!(!format!("{p:?}").contains("4BUQ"));
    }

    #[test]
    fn events_from_the_stream() {
        let v: Value = serde_json::from_str(r#"{"type":"session.text.delta","data":{"sessionID":"ses_1","assistantMessageID":"msg_2","ordinal":0,"delta":"pong"}}"#).unwrap();
        assert_eq!(parse_event(&v), Event::TextDelta { session: "ses_1".into(), message: "msg_2".into(), ordinal: 0, delta: "pong".into() });
        let v: Value = serde_json::from_str(r#"{"type":"session.execution.failed","data":{"sessionID":"ses_1","error":{"type":"x","message":"no model"}}}"#).unwrap();
        assert_eq!(parse_event(&v), Event::Finished { session: "ses_1".into(), outcome: Outcome::Failed("no model".into()) });
    }
}
