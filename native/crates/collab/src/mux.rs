//! Protocol v2, the client side: one WebSocket per workspace, notes on channels (grim `docs/07-workspace-socket.md`,
//! mirroring `src/shared/wsmux.ts`). Transport-free like `Session`: the shell feeds it the socket's binary frames and
//! sends what it queues.
//!
//! A binary frame is `varuint channel · varuint type · payload`; everything after the channel is the v1 frame byte for
//! byte, so a note's `CollabEditor` reads and writes its channel's frames unchanged. Channel 0 is the socket channel
//! (control JSON only): `welcome`, `open`/`opened`/`error`, `close`, `view` and the workspace events. On a note channel
//! the server also sends `end` (the channel is over: v1's close, as data; 1013 = reopen) and `renew`.

use serde_json::{Value, json};

use crate::protocol::MSG_CONTROL;

/// The protocol version (`welcome.v`, `/api/server` `ws`).
pub const WS_PROTOCOL: u64 = 2;
/// The socket channel: workspace-level control.
pub const SOCKET_CHANNEL: u64 = 0;
/// Open channels per socket (the server's `maxChannels`, until `welcome` says).
pub const MAX_CHANNELS: usize = 8;
/// Prefetched (hidden) channels opened at once.
pub const MAX_PREFETCH: usize = 2;
/// The heartbeat: send `PING` every `ping_ms`; reconnect when the `PONG` doesn't come within `PONG_TIMEOUT_MS`.
pub const PING_MS: f64 = 30_000.0;
pub const PONG_TIMEOUT_MS: f64 = 10_000.0;
pub const PING: &str = "ping";
pub const PONG: &str = "pong";
/// Reconnect backoff: doubling from min to max, reset on `welcome`.
pub const RECONNECT_MIN_MS: f64 = 500.0;
pub const RECONNECT_MAX_MS: f64 = 10_000.0;
/// `end`/`error` codes (v1's close codes, as data).
pub const CODE_CLOSED: u16 = 4000;
pub const CODE_RETRY: u16 = 1013;
pub const CODE_NOT_FOUND: u16 = 4404;
pub const CODE_TOO_MANY: u16 = 4429;

const MSG_AWARENESS: u8 = 1;

// ---- varuint (lib0: 7 bits per byte, low bits first, 0x80 = more) ----

pub fn write_varuint(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

/// `(value, next position)`, or None when truncated or too long.
pub fn read_varuint(buf: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let mut n: u64 = 0;
    let mut shift = 0;
    while pos < buf.len() {
        let b = buf[pos];
        pos += 1;
        if shift > 56 {
            return None;
        }
        n |= u64::from(b & 0x7f) << shift;
        if b < 0x80 {
            return Some((n, pos));
        }
        shift += 7;
    }
    None
}

/// A v1 frame (`type · payload`) on channel `ch`.
pub fn with_channel(ch: u64, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 2);
    write_varuint(&mut out, ch);
    out.extend_from_slice(body);
    out
}

/// A frame's channel and its body (the v1 frame), or None when the channel is malformed or there's no type.
pub fn decode_frame(data: &[u8]) -> Option<(u64, &[u8])> {
    let (ch, pos) = read_varuint(data, 0)?;
    let body = &data[pos..];
    read_varuint(body, 0)?;
    Some((ch, body))
}

/// A control frame (type 2, a varString of JSON) on `ch`.
pub fn encode_control(ch: u64, msg: &Value) -> Vec<u8> {
    let json = msg.to_string();
    let mut out = Vec::with_capacity(json.len() + 4);
    write_varuint(&mut out, ch);
    out.push(MSG_CONTROL);
    write_varuint(&mut out, json.len() as u64);
    out.extend_from_slice(json.as_bytes());
    out
}

/// The JSON of a control body (`2 · varString`), or None unless it's an object with a string `t`.
pub fn decode_control(body: &[u8]) -> Option<Value> {
    let (ty, pos) = read_varuint(body, 0)?;
    if ty != u64::from(MSG_CONTROL) {
        return None;
    }
    let (len, pos) = read_varuint(body, pos)?;
    let end = pos.checked_add(usize::try_from(len).ok()?)?;
    let v: Value = serde_json::from_slice(body.get(pos..end)?).ok()?;
    v["t"].is_string().then_some(v)
}

/// Base64 (standard, padded) of a state vector, for `open.sv`.
pub fn encode_sv(sv: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(sv.len().div_ceil(3) * 4);
    for c in sv.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= c.len() {
                s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// What `welcome` says: who we are on this socket and the server's policy.
#[derive(Clone, Debug, PartialEq)]
pub struct Welcome {
    pub user: Value,
    /// The whole workspace is read-only.
    pub read_only: bool,
    pub status: String,
    pub error: Option<String>,
    pub max_channels: usize,
    pub renew_ms: f64,
    pub awareness_timeout_ms: f64,
    pub ping_ms: f64,
}

/// What a frame from the server means to the shell.
#[derive(Clone, Debug, PartialEq)]
pub enum MuxEvent {
    /// The first frame of a connection (also after each reconnect): call `reopen_all` with the documents' state vectors.
    Welcome(Welcome),
    /// A note's channel is open; its frames follow (hello, blame, step 2, step 1, awareness).
    Opened { path: String, generation: String, read_only: bool },
    /// A v1 frame for a note (as its `CollabEditor` reads it).
    Frame { path: String, body: Vec<u8> },
    /// Opening the note failed (`error`): v1's close codes (4404 not found, 4413 too large, 1013 retry, 4429 too many…).
    Failed { path: String, code: u16, reason: String },
    /// The note's channel is over (`end`): 4000 after `closed`, 1013 = reopen with its state vector, others as v1.
    End { path: String, code: u16, reason: String },
    /// Renew our awareness on this note this often (`renew`).
    Renew { path: String, ms: f64 },
    /// A workspace event (`presence`, `tree`, `saved`, `workspace`), as sent.
    Event(Value),
}

#[derive(Debug)]
struct Chan {
    /// The path as we asked for it (what the shell knows the note by).
    path: String,
    /// The server's channel id, once `opened` (never reused on a socket).
    ch: Option<u64>,
    hidden: bool,
    read_only: bool,
    /// `open` sent on this connection, waiting for `opened` / `error`.
    asked: bool,
    /// When it was last shown (for the LRU of hidden channels).
    shown: u64,
}

/// One workspace socket's channels (a note each), across reconnects.
#[derive(Debug, Default)]
pub struct WorkspaceClient {
    welcome: Option<Welcome>,
    chans: Vec<Chan>,
    clock: u64,
    out: Vec<Vec<u8>>,
}

impl WorkspaceClient {
    pub fn new() -> WorkspaceClient {
        WorkspaceClient::default()
    }

    /// The last `welcome` on this connection (None before it and after a disconnect).
    pub fn welcome(&self) -> Option<&Welcome> {
        self.welcome.as_ref()
    }

    /// The socket closed: channel ids are gone (they're new after a reconnect); the notes stay, to reopen after the
    /// next `welcome`. Queued frames are dropped (the documents keep the edits; their step 2 carries them).
    pub fn disconnected(&mut self) {
        self.welcome = None;
        self.out.clear();
        for c in &mut self.chans {
            c.ch = None;
            c.asked = false;
        }
    }

    fn max_channels(&self) -> usize {
        self.welcome.as_ref().map_or(MAX_CHANNELS, |w| w.max_channels.max(1))
    }

    fn find(&self, path: &str) -> Option<usize> {
        self.chans.iter().position(|c| c.path == path)
    }

    /// The notes open on this socket (asked for, open or reopening), with whether each is hidden.
    pub fn notes(&self) -> Vec<(String, bool)> {
        self.chans.iter().map(|c| (c.path.clone(), c.hidden)).collect()
    }

    pub fn is_open(&self, path: &str) -> bool {
        self.find(path).is_some()
    }

    /// The note has its channel (`opened` came on this connection).
    pub fn is_live(&self, path: &str) -> bool {
        self.find(path).is_some_and(|i| self.chans[i].ch.is_some())
    }

    pub fn is_hidden(&self, path: &str) -> bool {
        self.find(path).is_some_and(|i| self.chans[i].hidden)
    }

    /// Open a note (idempotent per path: an open one is only shown or hidden). `sv`: its document's state vector
    /// when it has one. Past `max_channels`, the least recently shown hidden channel is closed first: the notes closed
    /// that way are returned (the shell drops their documents).
    pub fn open(&mut self, path: &str, hidden: bool, read_only: bool, sv: Option<&[u8]>) -> Vec<String> {
        if self.find(path).is_some() {
            self.view(path, hidden);
            return Vec::new();
        }
        let mut evicted = Vec::new();
        while self.chans.len() >= self.max_channels() {
            let Some(i) = self.chans.iter().enumerate().filter(|(_, c)| c.hidden).min_by_key(|(_, c)| c.shown).map(|(i, _)| i) else { break };
            let p = self.chans[i].path.clone();
            self.close(&p);
            evicted.push(p);
        }
        self.clock += 1;
        self.chans.push(Chan { path: path.to_string(), ch: None, hidden, read_only, asked: false, shown: if hidden { 0 } else { self.clock } });
        if self.welcome.is_some() {
            self.ask(self.chans.len() - 1, sv);
        }
        evicted
    }

    fn ask(&mut self, i: usize, sv: Option<&[u8]>) {
        let c = &mut self.chans[i];
        c.asked = true;
        let mut m = json!({ "t": "open", "path": c.path });
        if let Some(sv) = sv {
            m["sv"] = json!(encode_sv(sv));
        }
        if c.read_only {
            m["readOnly"] = json!(true);
        }
        if c.hidden {
            m["hidden"] = json!(true);
        }
        self.out.push(encode_control(SOCKET_CHANNEL, &m));
    }

    /// After `welcome`: open every note again in one flight, each with its document's state vector (`sv(path)`), so the
    /// edits made while away go out in the step 2 answering the server's step 1.
    pub fn reopen_all(&mut self, sv: impl Fn(&str) -> Option<Vec<u8>>) {
        for i in 0..self.chans.len() {
            if !self.chans[i].asked && self.chans[i].ch.is_none() {
                let v = sv(&self.chans[i].path);
                self.ask(i, v.as_deref());
            }
        }
    }

    /// Show or hide a note (prefetch ↔ visible). Hidden: no awareness goes out for it (the shell clears its state
    /// first: a null awareness, `CollabEditor::leave`).
    pub fn view(&mut self, path: &str, hidden: bool) {
        let Some(i) = self.find(path) else { return };
        self.clock += 1;
        let c = &mut self.chans[i];
        if !hidden {
            c.shown = self.clock;
        }
        if c.hidden == hidden {
            return;
        }
        c.hidden = hidden;
        if let Some(ch) = c.ch {
            self.out.push(encode_control(SOCKET_CHANNEL, &json!({ "t": "view", "ch": ch, "hidden": hidden })));
        }
    }

    /// Done with a note: its channel closes (no reply; frames for it are dropped from now on).
    pub fn close(&mut self, path: &str) {
        let Some(i) = self.find(path) else { return };
        let c = self.chans.remove(i);
        if let Some(ch) = c.ch {
            self.out.push(encode_control(SOCKET_CHANNEL, &json!({ "t": "close", "ch": ch })));
        }
    }

    /// Queue a v1 frame for a note (what its `CollabEditor` sends). Dropped (false) while the note has no channel: the
    /// document keeps the edits for its next step 2. A hidden note's awareness is dropped too.
    pub fn send(&mut self, path: &str, body: &[u8]) -> bool {
        let Some(c) = self.find(path).map(|i| &self.chans[i]) else { return false };
        let Some(ch) = c.ch else { return false };
        if c.hidden && body.first() == Some(&MSG_AWARENESS) {
            return true;
        }
        self.out.push(with_channel(ch, body));
        true
    }

    /// What to send on the socket now.
    pub fn take_outgoing(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.out)
    }

    /// A binary frame from the server.
    pub fn receive(&mut self, data: &[u8]) -> Vec<MuxEvent> {
        let Some((ch, body)) = decode_frame(data) else { return Vec::new() };
        if ch == SOCKET_CHANNEL {
            return self.socket_message(body).into_iter().collect();
        }
        // frames for a channel that isn't open on this socket are dropped
        let Some(i) = self.chans.iter().position(|c| c.ch == Some(ch)) else { return Vec::new() };
        let path = self.chans[i].path.clone();
        if let Some(m) = decode_control(body) {
            match m["t"].as_str() {
                Some("end") => {
                    self.chans.remove(i);
                    return vec![MuxEvent::End { path, code: code_of(&m), reason: m["reason"].as_str().unwrap_or("").to_string() }];
                }
                Some("renew") => {
                    return match m["ms"].as_f64().filter(|v| v.is_finite() && *v > 0.0) {
                        Some(ms) => vec![MuxEvent::Renew { path, ms }],
                        None => Vec::new(),
                    };
                }
                _ => {}
            }
        }
        vec![MuxEvent::Frame { path, body: body.to_vec() }]
    }

    fn socket_message(&mut self, body: &[u8]) -> Option<MuxEvent> {
        let m = decode_control(body)?;
        match m["t"].as_str()? {
            "welcome" => {
                let num = |k: &str| m[k].as_f64().filter(|v| v.is_finite() && *v > 0.0);
                let w = Welcome {
                    user: m["user"].clone(),
                    read_only: m["readOnly"].as_bool().unwrap_or(false),
                    status: m["status"].as_str().unwrap_or("ready").to_string(),
                    error: m["error"].as_str().map(str::to_string),
                    max_channels: num("maxChannels").map_or(MAX_CHANNELS, |v| v as usize),
                    renew_ms: num("renewMs").unwrap_or(crate::protocol::AWARENESS_RENEW_MS),
                    awareness_timeout_ms: num("awarenessTimeoutMs").unwrap_or(crate::protocol::AWARENESS_TIMEOUT_MS),
                    ping_ms: num("pingMs").unwrap_or(PING_MS),
                };
                self.welcome = Some(w.clone());
                Some(MuxEvent::Welcome(w))
            }
            "opened" => {
                let (req, ch) = (m["req"].as_str()?, m["ch"].as_u64().filter(|&c| c > 0)?);
                let path = m["path"].as_str().unwrap_or(req);
                match self.chans.iter_mut().find(|c| c.ch.is_none() && (c.path == req || c.path == path)) {
                    Some(c) => {
                        c.ch = Some(ch);
                        c.asked = false;
                        Some(MuxEvent::Opened { path: c.path.clone(), generation: m["generation"].as_str().unwrap_or("").to_string(), read_only: m["readOnly"].as_bool().unwrap_or(false) })
                    }
                    None => {
                        // closed while the open was on its way, or a repeat: give the channel back, unless it's ours
                        if !self.chans.iter().any(|c| c.ch == Some(ch)) {
                            self.out.push(encode_control(SOCKET_CHANNEL, &json!({ "t": "close", "ch": ch })));
                        }
                        None
                    }
                }
            }
            "error" => {
                let req = m["req"].as_str()?;
                let path = m["path"].as_str().unwrap_or(req);
                let i = self.chans.iter().position(|c| c.ch.is_none() && (c.path == req || c.path == path))?;
                let c = self.chans.remove(i);
                Some(MuxEvent::Failed { path: c.path, code: code_of(&m), reason: m["reason"].as_str().unwrap_or("").to_string() })
            }
            "presence" | "tree" | "saved" | "workspace" => Some(MuxEvent::Event(m)),
            _ => None,
        }
    }
}

fn code_of(m: &Value) -> u16 {
    m["code"].as_u64().and_then(|c| u16::try_from(c).ok()).unwrap_or(1011)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctl(ch: u64, v: Value) -> Vec<u8> {
        encode_control(ch, &v)
    }

    fn welcome(max: usize) -> Vec<u8> {
        ctl(0, json!({ "t": "welcome", "v": 2, "user": { "id": "u", "name": "U" }, "readOnly": false, "status": "ready", "maxChannels": max, "renewMs": 300000, "awarenessTimeoutMs": 720000, "pingMs": 30000 }))
    }

    fn sent(c: &mut WorkspaceClient) -> Vec<Value> {
        c.take_outgoing().iter().map(|f| {
            let (ch, body) = decode_frame(f).unwrap();
            assert_eq!(ch, 0);
            decode_control(body).unwrap()
        }).collect()
    }

    #[test]
    fn varuints_and_frames_match_lib0() {
        for n in [0u64, 1, 127, 128, 300, 16_383, 16_384, u32::MAX as u64] {
            let mut b = Vec::new();
            write_varuint(&mut b, n);
            assert_eq!(read_varuint(&b, 0), Some((n, b.len())));
        }
        let mut b = Vec::new();
        write_varuint(&mut b, 300);
        assert_eq!(b, [0xac, 0x02], "lib0's bytes");
        assert_eq!(read_varuint(&[0x80], 0), None, "truncated");
        // one byte of prefix for channels 1..127; the body is the v1 frame byte for byte
        let body = [0u8, 2, 9, 9];
        let f = with_channel(5, &body);
        assert_eq!(f, [5, 0, 2, 9, 9]);
        assert_eq!(decode_frame(&f), Some((5, &body[..])));
        assert_eq!(decode_frame(&[5]), None, "no type");
        let c = encode_control(0, &json!({ "t": "close", "ch": 3 }));
        assert_eq!(decode_control(&c[1..]).unwrap()["ch"], 3);
        assert_eq!(decode_control(&encode_control(0, &json!({ "x": 1 }))[1..]), None, "no t");
        assert_eq!(encode_sv(b"\x01\x02\x03\x04"), "AQIDBA==");
        assert_eq!(encode_sv(b""), "");
    }

    #[test]
    fn opens_wait_for_welcome_and_match_replies_out_of_order() {
        let mut c = WorkspaceClient::new();
        c.open("a.md", false, false, None);
        assert!(c.take_outgoing().is_empty(), "nothing before welcome");
        let ev = c.receive(&welcome(8));
        assert!(matches!(&ev[0], MuxEvent::Welcome(w) if w.renew_ms == 300_000.0 && w.awareness_timeout_ms == 720_000.0));
        c.reopen_all(|_| None);
        c.open("dir/b.md", true, false, Some(&[1, 2]));
        let out = sent(&mut c);
        assert_eq!(out[0], json!({ "t": "open", "path": "a.md" }));
        assert_eq!(out[1], json!({ "t": "open", "path": "dir/b.md", "sv": "AQI=", "hidden": true }));
        // replies out of order; the cleaned path differs from the asked one
        c.receive(&ctl(0, json!({ "t": "opened", "req": "dir/b.md", "path": "dir/b.md", "ch": 2, "generation": "g", "readOnly": false })));
        let ev = c.receive(&ctl(0, json!({ "t": "opened", "req": "a.md", "path": "a.md", "ch": 1, "generation": "g1", "readOnly": true })));
        assert_eq!(ev, vec![MuxEvent::Opened { path: "a.md".into(), generation: "g1".into(), read_only: true }]);
        // frames route by channel; unknown channels are dropped
        let hello = encode_control(1, &json!({ "t": "hello", "generation": "g1" }));
        assert!(matches!(&c.receive(&hello)[0], MuxEvent::Frame { path, body } if path == "a.md" && body[..] == hello[1..]));
        assert!(c.receive(&with_channel(9, &[0, 2, 1])).is_empty());
        // sends get the channel prefix; a hidden note's awareness is dropped, its sync goes
        assert!(c.send("a.md", &[1, 7]));
        assert!(c.send("dir/b.md", &[1, 7]) && c.send("dir/b.md", &[0, 0, 1]));
        assert_eq!(c.take_outgoing(), vec![vec![1, 1, 7], vec![2, 0, 0, 1]]);
        // idempotent open: only shows it
        c.open("dir/b.md", false, false, None);
        assert_eq!(sent(&mut c), vec![json!({ "t": "view", "ch": 2, "hidden": false })]);
        // an open that fails
        c.open("gone.md", false, false, None);
        c.take_outgoing();
        let ev = c.receive(&ctl(0, json!({ "t": "error", "req": "gone.md", "code": 4404, "reason": "file not found" })));
        assert_eq!(ev, vec![MuxEvent::Failed { path: "gone.md".into(), code: 4404, reason: "file not found".into() }]);
        assert!(!c.is_open("gone.md"));
    }

    #[test]
    fn end_renew_close_and_late_replies() {
        let mut c = WorkspaceClient::new();
        c.receive(&welcome(8));
        c.open("a.md", false, false, None);
        c.receive(&ctl(0, json!({ "t": "opened", "req": "a.md", "path": "a.md", "ch": 1, "generation": "g", "readOnly": false })));
        assert_eq!(c.receive(&ctl(1, json!({ "t": "renew", "ms": 15000 }))), vec![MuxEvent::Renew { path: "a.md".into(), ms: 15000.0 }]);
        // end 1013: the channel is gone; the shell reopens with its sv (a new channel id)
        let ev = c.receive(&ctl(1, json!({ "t": "end", "code": 1013, "reason": "reset" })));
        assert_eq!(ev, vec![MuxEvent::End { path: "a.md".into(), code: 1013, reason: "reset".into() }]);
        assert!(!c.is_open("a.md") && c.receive(&with_channel(1, &[0, 2, 0])).is_empty());
        c.take_outgoing();
        c.open("a.md", false, false, Some(&[0]));
        assert_eq!(sent(&mut c)[0]["sv"], "AA==");
        c.receive(&ctl(0, json!({ "t": "opened", "req": "a.md", "path": "a.md", "ch": 2, "generation": "g2", "readOnly": false })));
        c.close("a.md");
        assert_eq!(sent(&mut c), vec![json!({ "t": "close", "ch": 2 })]);
        // an opened for a note closed meanwhile: the channel is given back
        c.open("b.md", false, false, None);
        c.close("b.md");
        c.take_outgoing();
        c.receive(&ctl(0, json!({ "t": "opened", "req": "b.md", "path": "b.md", "ch": 3, "generation": "g", "readOnly": false })));
        assert_eq!(sent(&mut c), vec![json!({ "t": "close", "ch": 3 })]);
        // workspace events pass through; unknown messages are ignored
        assert!(matches!(&c.receive(&ctl(0, json!({ "t": "tree", "head": "h" })))[0], MuxEvent::Event(v) if v["head"] == "h"));
        assert!(c.receive(&ctl(0, json!({ "t": "future" }))).is_empty());
    }

    #[test]
    fn reconnect_reopens_every_note_with_its_state_vector() {
        let mut c = WorkspaceClient::new();
        c.receive(&welcome(8));
        c.open("a.md", false, false, None);
        c.open("b.md", true, false, None);
        c.receive(&ctl(0, json!({ "t": "opened", "req": "a.md", "path": "a.md", "ch": 1, "generation": "g", "readOnly": false })));
        c.receive(&ctl(0, json!({ "t": "opened", "req": "b.md", "path": "b.md", "ch": 2, "generation": "g", "readOnly": false })));
        c.take_outgoing();
        c.disconnected();
        assert!(!c.send("a.md", &[0, 2, 1]), "no channel while away");
        assert!(c.is_open("a.md") && !c.is_live("a.md"));
        c.receive(&welcome(8));
        c.reopen_all(|p| Some(if p == "a.md" { vec![1] } else { vec![2] }));
        assert_eq!(sent(&mut c), vec![json!({ "t": "open", "path": "a.md", "sv": "AQ==" }), json!({ "t": "open", "path": "b.md", "sv": "Ag==", "hidden": true })]);
        // channel ids are new after a reconnect
        c.receive(&ctl(0, json!({ "t": "opened", "req": "a.md", "path": "a.md", "ch": 5, "generation": "g", "readOnly": false })));
        assert!(c.send("a.md", &[0, 2, 1]));
        assert_eq!(c.take_outgoing(), vec![vec![5, 0, 2, 1]]);
    }

    #[test]
    fn the_least_recently_shown_hidden_note_goes_past_max_channels() {
        let mut c = WorkspaceClient::new();
        c.receive(&welcome(3));
        c.open("visible.md", false, false, None);
        c.open("h1.md", true, false, None);
        c.open("h2.md", true, false, None);
        // h1 shown once since: h2 is now the least recently shown hidden one
        c.view("h1.md", false);
        c.view("h1.md", true);
        assert_eq!(c.open("new.md", true, false, None), vec!["h2.md".to_string()]);
        assert_eq!(c.notes().iter().map(|n| n.0.as_str()).collect::<Vec<_>>(), ["visible.md", "h1.md", "new.md"]);
        // nothing hidden to close: the open goes out anyway (the server answers 4429)
        c.view("h1.md", false);
        c.view("new.md", false);
        assert!(c.open("fourth.md", false, false, None).is_empty());
    }
}
