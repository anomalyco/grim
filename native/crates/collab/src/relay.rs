//! An in-process room server for tests and demos: a yrs doc that answers like a Grimoire room (hello, sync
//! step 1/2, updates and awareness relayed to the other connections). Apps use it to exercise their
//! `CollabEditor` shell without a network (the native app's headless remote demo and its unit tests).

use serde_json::json;
use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::SyncMessage;
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};

use crate::protocol::{MSG_AWARENESS, MSG_CONTROL, MSG_SYNC, control_frame};
use crate::store::YrsStore;

pub struct Relay {
    doc: YrsStore,
    pub generation: String,
    pub read_only: bool,
}

impl Relay {
    pub fn new(text: &str) -> Relay {
        let mut doc = YrsStore::without_undo(999);
        doc.replace(0, 0, text);
        doc.take_updates();
        Relay { doc, generation: "g1".into(), read_only: false }
    }

    /// The room's text.
    pub fn text(&self) -> String {
        self.doc.text()
    }

    /// What a new connection gets: hello, then the room's step 1.
    pub fn greet(&self) -> Vec<Vec<u8>> {
        let hello = control_frame(&json!({
            "t": "hello", "generation": self.generation, "readOnly": self.read_only,
            "dirty": false, "saving": false, "commit": "c0", "savedAt": null,
        }));
        vec![hello, sync_frame(SyncMessage::SyncStep1(self.doc.state_vector()))]
    }

    /// What a v2 channel gets right after `opened`: hello, step 2 for the client's state vector `sv` (everything when
    /// it has none), then the room's step 1. One round trip from `open` to the note's text.
    pub fn greet_with(&self, sv: Option<&[u8]>) -> Vec<Vec<u8>> {
        let mut out = self.greet();
        let theirs = sv.and_then(|b| yrs::StateVector::decode_v1(b).ok()).unwrap_or_default();
        out.insert(1, sync_frame(SyncMessage::SyncStep2(self.doc.diff(&theirs))));
        out
    }

    /// A frame from a client: (the reply to it, what to broadcast to the other connections). Malformed frames
    /// and updates from read-only rooms are dropped.
    pub fn handle(&mut self, frame: &[u8]) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
        let mut dec = DecoderV1::new(Cursor::new(frame));
        let Ok(tag) = dec.read_var::<u8>() else { return (vec![], vec![]) };
        match tag {
            MSG_SYNC => match SyncMessage::decode(&mut dec) {
                Ok(SyncMessage::SyncStep1(sv)) => (vec![sync_frame(SyncMessage::SyncStep2(self.doc.diff(&sv)))], vec![]),
                Ok(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) if !self.read_only => {
                    if self.doc.apply_remote_update(&u).is_err() {
                        return (vec![], vec![]);
                    }
                    self.doc.take_changes();
                    (vec![], vec![sync_frame(SyncMessage::Update(u))])
                }
                _ => (vec![], vec![]),
            },
            MSG_AWARENESS => (vec![], vec![frame.to_vec()]),
            MSG_CONTROL => (vec![], vec![]),
            _ => (vec![], vec![]),
        }
    }
}

pub fn sync_frame(msg: SyncMessage) -> Vec<u8> {
    let mut enc = EncoderV1::new();
    enc.write_var(MSG_SYNC);
    msg.encode(&mut enc);
    enc.to_vec()
}

/// v1 frames for notes: (path, frame).
pub type NoteFrames = Vec<(String, Vec<u8>)>;

/// A v2 workspace socket on the server side, for tests and demos (one client socket): `welcome`, `open` (a channel per
/// note, the note's room greeting it with step 2 for the client's `sv`), `close`, `view`, `ping`; its notes' rooms
/// are the caller's `Relay`s. Mirrors grim's `wsmux.ts` closely enough to drive `mux::WorkspaceClient`.
#[derive(Debug)]
pub struct MuxFake {
    /// Open channels: (channel id, path, hidden).
    pub chans: Vec<(u64, String, bool)>,
    next: u64,
    pub user: serde_json::Value,
    pub read_only: bool,
    pub max_channels: usize,
    /// Every `open` asked for (path, had an `sv`), for tests that count round trips.
    pub opens: Vec<(String, bool)>,
}

impl MuxFake {
    pub fn new(user: serde_json::Value) -> MuxFake {
        MuxFake { chans: Vec::new(), next: 1, user, read_only: false, max_channels: crate::mux::MAX_CHANNELS, opens: Vec::new() }
    }

    /// The first frame of a connection.
    pub fn welcome(&self) -> Vec<u8> {
        crate::mux::encode_control(0, &json!({
            "t": "welcome", "v": 2, "user": self.user, "readOnly": self.read_only, "status": "ready",
            "maxChannels": self.max_channels, "renewMs": 300000, "awarenessTimeoutMs": 720000, "pingMs": 30000,
        }))
    }

    /// The connection dropped: its channels are gone (ids are never reused).
    pub fn disconnect(&mut self) {
        self.chans.clear();
    }

    /// The channel open on `path`.
    pub fn channel(&self, path: &str) -> Option<u64> {
        self.chans.iter().find(|c| c.1 == path).map(|c| c.0)
    }

    /// A frame from the client: (frames back to it, v1 frames to broadcast to the note's other connections).
    pub fn handle(&mut self, frame: &[u8], rooms: &mut [(String, Relay)]) -> (Vec<Vec<u8>>, NoteFrames) {
        let Some((ch, body)) = crate::mux::decode_frame(frame) else { return (vec![], vec![]) };
        if ch == 0 {
            let Some(m) = crate::mux::decode_control(body) else { return (vec![], vec![]) };
            return (self.control(&m, rooms), vec![]);
        }
        let Some(path) = self.chans.iter().find(|c| c.0 == ch).map(|c| c.1.clone()) else { return (vec![], vec![]) };
        let Some(room) = rooms.iter_mut().find(|r| r.0 == path).map(|r| &mut r.1) else { return (vec![], vec![]) };
        let (reply, bcast) = room.handle(body);
        let mut back: Vec<Vec<u8>> = reply.iter().map(|f| crate::mux::with_channel(ch, f)).collect();
        // the note's other channels on this socket (none in practice) and the room's other connections
        for f in &bcast {
            for c in self.chans.iter().filter(|c| c.1 == path && c.0 != ch) {
                back.push(crate::mux::with_channel(c.0, f));
            }
        }
        (back, bcast.into_iter().map(|f| (path.clone(), f)).collect())
    }

    fn control(&mut self, m: &serde_json::Value, rooms: &mut [(String, Relay)]) -> Vec<Vec<u8>> {
        let ctl = |v: serde_json::Value| crate::mux::encode_control(0, &v);
        match m["t"].as_str() {
            Some("open") => {
                let path = m["path"].as_str().unwrap_or("").to_string();
                let sv = m["sv"].as_str().and_then(decode_b64);
                self.opens.push((path.clone(), sv.is_some()));
                let hidden = m["hidden"].as_bool().unwrap_or(false);
                if let Some(&(ch, _, _)) = self.chans.iter().find(|c| c.1 == path) {
                    let generation = rooms.iter().find(|r| r.0 == path).map_or(String::new(), |r| r.1.generation.clone());
                    return vec![ctl(json!({ "t": "opened", "req": path, "path": path, "ch": ch, "generation": generation, "readOnly": self.read_only }))];
                }
                let Some(room) = rooms.iter().find(|r| r.0 == path).map(|r| &r.1) else {
                    return vec![ctl(json!({ "t": "error", "req": path, "code": 4404, "reason": "file not found" }))];
                };
                if self.chans.len() >= self.max_channels {
                    return vec![ctl(json!({ "t": "error", "req": path, "code": 4429, "reason": "too many channels" }))];
                }
                let ch = self.next;
                self.next += 1;
                self.chans.push((ch, path.clone(), hidden));
                let mut out = vec![ctl(json!({ "t": "opened", "req": path, "path": path, "ch": ch, "generation": room.generation, "readOnly": self.read_only || room.read_only }))];
                out.extend(room.greet_with(sv.as_deref()).iter().map(|f| crate::mux::with_channel(ch, f)));
                out
            }
            Some("close") => {
                if let Some(ch) = m["ch"].as_u64() {
                    self.chans.retain(|c| c.0 != ch);
                }
                vec![]
            }
            Some("view") => {
                if let (Some(ch), Some(h)) = (m["ch"].as_u64(), m["hidden"].as_bool())
                    && let Some(c) = self.chans.iter_mut().find(|c| c.0 == ch)
                {
                    c.2 = h;
                }
                vec![]
            }
            _ => vec![],
        }
    }

    /// v1 frames the room `path` broadcasts (another connection's edit or caret): the client's channels on it get them.
    pub fn deliver(&self, path: &str, frames: &[Vec<u8>]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for c in self.chans.iter().filter(|c| c.1 == path) {
            out.extend(frames.iter().map(|f| crate::mux::with_channel(c.0, f)));
        }
        out
    }

    /// End the channels on `path` (`end`, e.g. 1013 after a reset): they're gone.
    pub fn end(&mut self, path: &str, code: u16, reason: &str) -> Vec<Vec<u8>> {
        let out = self.chans.iter().filter(|c| c.1 == path).map(|c| crate::mux::encode_control(c.0, &json!({ "t": "end", "code": code, "reason": reason }))).collect();
        self.chans.retain(|c| c.1 != path);
        out
    }

    /// A workspace event on channel 0.
    pub fn event(&self, msg: serde_json::Value) -> Vec<u8> {
        crate::mux::encode_control(0, &msg)
    }
}

fn decode_b64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= u32::from(val(c)?) << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}
