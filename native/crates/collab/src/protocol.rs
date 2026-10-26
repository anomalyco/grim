//! Grimoire's WebSocket protocol as a sans-IO state machine (the transport feeds bytes in and sends the
//! queued frames out, so the same code runs over tungstenite natively and over a browser WebSocket in wasm).
//!
//! Frames: `varuint type` then
//! - 0 sync: y-protocols sync (step1 = state vector, step2 = update, update),
//! - 1 awareness: `varbuf` awareness update (`[n, (client, clock, json)*]`),
//! - 2 control: `varstring` JSON (`hello`, `status`, `external`, `closed`; client → server `flush`).
//!   Note: y-sync uses 2 for auth, so the generic `yrs::sync::Message` decoder can't be used as-is.

use serde_json::{Value, json};
use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::awareness::AwarenessUpdateEntry;
use yrs::sync::{Awareness, AwarenessUpdate, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{ClientID, StickyIndex};

use crate::store::{Change, YrsStore};

pub const MSG_SYNC: u8 = 0;
pub const MSG_AWARENESS: u8 = 1;
pub const MSG_CONTROL: u8 = 2;

#[derive(Debug, Clone)]
pub enum Event {
    /// The server confirmed the room (sync starts now).
    Hello { generation: String, read_only: bool },
    /// The server's state has been received (initial load done).
    Synced,
    /// Remote or undo/redo text changes.
    Changes(Vec<Change>),
    /// Someone's awareness state (cursor, presence) changed.
    Awareness,
    /// Other control messages (`status`, `external`, `closed`).
    Control(Value),
}

#[derive(Debug, Clone)]
pub struct RemoteCursor {
    pub client: u64,
    pub user: Value,
    pub anchor: Option<u32>,
    pub head: Option<u32>,
}

pub struct Session {
    pub store: YrsStore,
    awareness: Awareness,
    pub hello: bool,
    pub synced: bool,
    pub read_only: bool,
    pub generation: Option<String>,
    outbox: Vec<Vec<u8>>,
    user: Value,
    cursor: Option<(StickyIndex, StickyIndex)>,
}

impl Session {
    /// `user` is our presence user (`{id, name, color, kind}`); the server replaces it with the signed-in
    /// account's, so it only matters for local display.
    pub fn new(store: YrsStore, user: Value) -> Self {
        // The clock only stamps "last updated" (for timeouts this client doesn't run); keep it portable to wasm.
        let awareness = Awareness::with_clock(store.doc().clone(), || 0u64);
        Session {
            store,
            awareness,
            hello: false,
            synced: false,
            read_only: false,
            generation: None,
            outbox: Vec::new(),
            user,
            cursor: None,
        }
    }

    /// Feed one binary frame from the server.
    pub fn receive(&mut self, data: &[u8]) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        let mut dec = DecoderV1::new(Cursor::new(data));
        let tag: u8 = dec.read_var().map_err(err)?;
        match tag {
            MSG_CONTROL => {
                let msg: Value = serde_json::from_str(dec.read_string().map_err(err)?).map_err(err)?;
                if msg["t"] == "hello" {
                    let generation = msg["generation"].as_str().unwrap_or_default().to_string();
                    self.hello = true;
                    self.read_only = msg["readOnly"].as_bool().unwrap_or(false);
                    self.generation = Some(generation.clone());
                    self.send_sync(SyncMessage::SyncStep1(self.store.state_vector()));
                    // (Re-)announce with a bumped clock.
                    self.publish();
                    events.push(Event::Hello { generation, read_only: self.read_only });
                } else {
                    events.push(Event::Control(msg));
                }
            }
            // Nothing else is trusted before hello (provider.ts does the same).
            _ if !self.hello => {}
            MSG_SYNC => match SyncMessage::decode(&mut dec).map_err(err)? {
                SyncMessage::SyncStep1(sv) => {
                    if !self.read_only {
                        let diff = self.store.diff(&sv);
                        self.send_sync(SyncMessage::SyncStep2(diff));
                    }
                }
                SyncMessage::SyncStep2(u) => {
                    self.store.apply_remote_update(&u)?;
                    if !self.synced {
                        self.synced = true;
                        events.push(Event::Synced);
                    }
                }
                SyncMessage::Update(u) => self.store.apply_remote_update(&u)?,
            },
            MSG_AWARENESS => {
                let buf = dec.read_buf().map_err(err)?;
                let update = AwarenessUpdate::decode_v1(buf).map_err(err)?;
                self.awareness.apply_update(update).map_err(err)?;
                events.push(Event::Awareness);
            }
            _ => {}
        }
        let changes = self.store.take_changes();
        if !changes.is_empty() {
            events.insert(0, Event::Changes(changes));
        }
        Ok(events)
    }

    /// Frames to send: local updates since the last call, plus queued protocol replies.
    pub fn take_outgoing(&mut self) -> Vec<Vec<u8>> {
        let updates = self.store.take_updates();
        // Before hello, local edits reach the server through our step2 answer to its step1.
        if self.hello && !self.read_only {
            for u in updates {
                self.send_sync(SyncMessage::Update(u));
            }
        }
        std::mem::take(&mut self.outbox)
    }

    /// Show our caret/selection to others (None = not focused).
    pub fn set_cursor(&mut self, sel: Option<(u32, u32)>) {
        self.cursor = sel.map(|(a, h)| {
            let r = self.store.sel_rel(a, h);
            (r.anchor, r.head)
        });
        self.publish();
    }

    /// Ask the server to commit now.
    pub fn request_flush(&mut self) {
        self.send_control(&json!({ "t": "flush" }));
    }

    /// Announce that we left (call before closing the socket).
    pub fn leave(&mut self) {
        self.awareness.clean_local_state();
        self.send_awareness();
    }

    pub fn remote_cursors(&self) -> Vec<RemoteCursor> {
        let me = self.awareness.client_id();
        let mut out = Vec::new();
        for (id, state) in self.awareness.iter() {
            if id == me {
                continue;
            }
            let Some(json) = &state.data else { continue };
            let Ok(v) = serde_json::from_str::<Value>(json) else { continue };
            let pos = |k: &str| -> Option<u32> {
                let idx: StickyIndex = serde_json::from_value(v["cursor"][k].clone()).ok()?;
                self.store.resolve(&idx)
            };
            out.push(RemoteCursor { client: id.get(), user: v["user"].clone(), anchor: pos("anchor"), head: pos("head") });
        }
        out.sort_by_key(|c| c.client);
        out
    }

    fn publish(&mut self) {
        let cursor = match &self.cursor {
            Some((a, h)) => json!({ "anchor": a, "head": h }),
            None => Value::Null,
        };
        let state = json!({ "user": self.user, "cursor": cursor });
        self.awareness.set_local_state_raw(state.to_string());
        if self.hello {
            self.send_awareness();
        }
    }

    fn send_awareness(&mut self) {
        let me: ClientID = self.awareness.client_id();
        let Ok(update) = self.awareness.update_with_clients([me]) else { return };
        let mut enc = EncoderV1::new();
        enc.write_var(MSG_AWARENESS);
        enc.write_buf(update.encode_v1());
        self.outbox.push(enc.to_vec());
    }

    fn send_sync(&mut self, msg: SyncMessage) {
        let mut enc = EncoderV1::new();
        enc.write_var(MSG_SYNC);
        msg.encode(&mut enc);
        self.outbox.push(enc.to_vec());
    }

    fn send_control(&mut self, msg: &Value) {
        let mut enc = EncoderV1::new();
        enc.write_var(MSG_CONTROL);
        enc.write_string(&msg.to_string());
        self.outbox.push(enc.to_vec());
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Build an awareness frame by hand (tests / tools).
pub fn awareness_frame(client: u64, clock: u32, json: &str) -> Vec<u8> {
    let mut u = AwarenessUpdate { clients: Default::default() };
    u.clients.insert(ClientID::new(client), AwarenessUpdateEntry { clock, json: json.into() });
    let mut enc = EncoderV1::new();
    enc.write_var(MSG_AWARENESS);
    enc.write_buf(u.encode_v1());
    enc.to_vec()
}
