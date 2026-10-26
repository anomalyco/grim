//! Grimoire's WebSocket protocol as a sans-IO state machine (the transport feeds bytes in and sends the
//! queued frames out, so the same code runs over tungstenite natively and over a browser WebSocket in wasm).
//! Ported from the web client's `provider.ts`.
//!
//! Frames: `varuint type` then
//! - 0 sync: y-protocols sync (step1 = state vector, step2 = update, update),
//! - 1 awareness: `varbuf` awareness update (`[n, (client, clock, json)*]`),
//! - 2 control: `varstring` JSON (`hello`, `status`, `external`, `closed`; client → server `flush`).
//!   Note: y-sync uses 2 for auth, so the generic `yrs::sync::Message` decoder can't be used as-is.

use std::cell::{Ref, RefCell, RefMut};
use std::collections::BTreeMap;
use std::rc::Rc;

use serde_json::{Value, json};
use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::awareness::AwarenessUpdateEntry;
use yrs::sync::{AwarenessUpdate, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{ClientID, StickyIndex};

use crate::store::{Change, YrsStore};

pub const MSG_SYNC: u8 = 0;
pub const MSG_AWARENESS: u8 = 1;
pub const MSG_CONTROL: u8 = 2;

/// The store shared by the session and the editor's `CollabStore`.
pub type SharedStore = Rc<RefCell<YrsStore>>;

#[derive(Debug, Clone)]
pub enum Event {
    /// The server confirmed the room (sync starts now). `msg` is the whole hello (save state fields too).
    Hello { generation: String, read_only: bool, msg: Value },
    /// The server's state has been received (initial load done; once per session).
    Synced,
    /// Remote or undo/redo text changes.
    Changes(Vec<Change>),
    /// Someone's awareness state (cursor, presence) changed.
    Awareness,
    /// The room was recreated (new generation), or a read-only connection would drop our offline edits:
    /// the session stopped. Close the socket, throw the doc away and start over (provider.ts `reset`).
    Reset,
    /// Other control messages (`status`, `external`, `closed`).
    Control(Value),
}

#[derive(Debug, Clone)]
pub struct RemoteCursor {
    pub client: u64,
    pub user: Value,
    /// UTF-16 offsets (None when the position can't be resolved).
    pub anchor: Option<u32>,
    pub head: Option<u32>,
}

/// Renew our awareness state this often (y-protocols: outdatedTimeout / 2), or the server drops it.
pub const AWARENESS_RENEW_MS: f64 = 15_000.0;
/// Remote states not renewed for this long are removed (y-protocols outdatedTimeout).
pub const AWARENESS_TIMEOUT_MS: f64 = 30_000.0;

#[derive(Debug)]
struct Peer {
    clock: u32,
    /// None = removed (the clock is kept).
    state: Option<String>,
    updated: f64,
}

/// Awareness states, with Yjs's clock and timeout rules (y-protocols/awareness). yrs's `Awareness` can't forget
/// a peer's clock, which provider.ts does on disconnect (so the states the server re-sends aren't dropped as
/// stale), and it has no timeouts.
#[derive(Debug, Default)]
struct Presence {
    clock: u32,
    /// Our state as JSON; None = removed (we left).
    state: Option<String>,
    peers: BTreeMap<u64, Peer>,
}

impl Presence {
    fn set_local(&mut self, state: Option<String>) {
        self.clock += 1;
        self.state = state;
    }

    /// Returns whether a remote state changed.
    fn apply(&mut self, me: u64, update: AwarenessUpdate, now: f64) -> bool {
        let mut changed = false;
        for (id, entry) in update.clients {
            let id = id.get();
            let state = (&*entry.json != "null").then(|| entry.json.to_string());
            if id == me {
                // never let a remote client remove our state: just get ahead of its clock
                if state.is_none() && self.state.is_some() && entry.clock >= self.clock {
                    self.clock = entry.clock + 1;
                }
                continue;
            }
            let newer = match self.peers.get(&id) {
                None => true,
                Some(p) => p.clock < entry.clock || (p.clock == entry.clock && state.is_none() && p.state.is_some()),
            };
            if newer {
                let had = self.peers.get(&id).is_some_and(|p| p.state.is_some());
                changed |= had || state.is_some();
                self.peers.insert(id, Peer { clock: entry.clock, state, updated: now });
            }
        }
        changed
    }

    fn local_update(&self, me: u64) -> AwarenessUpdate {
        let json = self.state.clone().unwrap_or_else(|| "null".into());
        let mut u = AwarenessUpdate { clients: Default::default() };
        u.clients.insert(ClientID::new(me), AwarenessUpdateEntry { clock: self.clock, json: json.into() });
        u
    }
}

pub struct Session {
    store: SharedStore,
    presence: Presence,
    /// `hello` seen on the current connection (nothing else is trusted before it).
    pub hello: bool,
    pub synced: bool,
    pub read_only: bool,
    pub generation: Option<String>,
    /// Local edits the server hasn't received (made while disconnected); sent by our step2 reply.
    pub unsent: bool,
    /// After a reset: everything is ignored.
    pub stopped: bool,
    /// The shell's monotonic clock (ms), as last given to `tick`.
    now: f64,
    /// When our awareness state was last sent.
    last_announce: f64,
    /// We announced that we left; the cursor isn't published any more.
    left: bool,
    outbox: Vec<Vec<u8>>,
    user: Value,
    cursor: Option<(StickyIndex, StickyIndex)>,
}

impl Session {
    /// `user` is our presence user (`{id, name, color, kind}`); the server replaces it with the signed-in
    /// account's, so it only matters for local display.
    pub fn new(store: YrsStore, user: Value) -> Self {
        Self::with_shared(Rc::new(RefCell::new(store)), user)
    }

    pub fn with_shared(store: SharedStore, user: Value) -> Self {
        let mut s = Session {
            store,
            presence: Presence::default(),
            hello: false,
            synced: false,
            read_only: false,
            generation: None,
            unsent: false,
            stopped: false,
            now: 0.0,
            last_announce: 0.0,
            left: false,
            outbox: Vec::new(),
            user,
            cursor: None,
        };
        s.presence.set_local(Some(s.local_state()));
        s
    }

    pub fn store(&self) -> Ref<'_, YrsStore> {
        self.store.borrow()
    }

    pub fn store_mut(&self) -> RefMut<'_, YrsStore> {
        self.store.borrow_mut()
    }

    pub fn shared_store(&self) -> SharedStore {
        self.store.clone()
    }

    pub fn user(&self) -> &Value {
        &self.user
    }

    fn me(&self) -> u64 {
        self.store.borrow().client_id()
    }

    /// Feed one binary frame from the server.
    pub fn receive(&mut self, data: &[u8]) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        if self.stopped {
            return Ok(events);
        }
        let mut dec = DecoderV1::new(Cursor::new(data));
        let tag: u8 = dec.read_var().map_err(err)?;
        match tag {
            MSG_CONTROL => {
                let msg: Value = serde_json::from_str(dec.read_string().map_err(err)?).map_err(err)?;
                if msg["t"] == "hello" {
                    let generation = msg["generation"].as_str().unwrap_or_default().to_string();
                    let read_only = msg["readOnly"].as_bool().unwrap_or(false);
                    // A recreated room can't absorb our doc, and a read-only connection would silently drop our
                    // offline edits: either way start over with a fresh doc.
                    if self.generation.as_ref().is_some_and(|g| *g != generation) || (read_only && self.unsent) {
                        self.stopped = true;
                        self.disconnected();
                        events.push(Event::Reset);
                        return Ok(events);
                    }
                    self.hello = true;
                    self.read_only = read_only;
                    self.generation = Some(generation.clone());
                    let sv = self.store.borrow().state_vector();
                    self.send_sync(SyncMessage::SyncStep1(sv));
                    // (Re-)announce with a bumped clock so the server doesn't drop it as stale.
                    if !self.left {
                        self.publish();
                    }
                    events.push(Event::Hello { generation, read_only, msg });
                } else {
                    events.push(Event::Control(msg));
                }
            }
            // Nothing else is trusted before hello (provider.ts does the same).
            _ if !self.hello => {}
            MSG_SYNC => match SyncMessage::decode(&mut dec).map_err(err)? {
                SyncMessage::SyncStep1(sv) => {
                    // Read-only: never answer with our own contents.
                    if !self.read_only {
                        let diff = self.store.borrow().diff(&sv);
                        self.send_sync(SyncMessage::SyncStep2(diff));
                        // our step2 carries everything we had offline
                        self.unsent = false;
                    }
                }
                SyncMessage::SyncStep2(u) => {
                    self.store.borrow_mut().apply_remote_update(&u)?;
                    if !self.synced {
                        self.synced = true;
                        events.push(Event::Synced);
                    }
                }
                SyncMessage::Update(u) => self.store.borrow_mut().apply_remote_update(&u)?,
            },
            MSG_AWARENESS => {
                let buf = dec.read_buf().map_err(err)?;
                let update = AwarenessUpdate::decode_v1(buf).map_err(err)?;
                let me = self.me();
                if self.presence.apply(me, update, self.now) {
                    events.push(Event::Awareness);
                }
            }
            _ => {}
        }
        let changes = self.store.borrow_mut().take_changes();
        if !changes.is_empty() {
            events.insert(0, Event::Changes(changes));
        }
        Ok(events)
    }

    /// Frames to send: local updates since the last call (merged into one), plus queued protocol replies.
    pub fn take_outgoing(&mut self) -> Vec<Vec<u8>> {
        let updates = self.store.borrow_mut().take_updates();
        if !updates.is_empty() && !self.read_only && !self.stopped {
            if self.hello {
                match yrs::merge_updates_v1(&updates) {
                    Ok(u) => self.send_sync(SyncMessage::Update(u)),
                    Err(_) => {
                        for u in updates {
                            self.send_sync(SyncMessage::Update(u));
                        }
                    }
                }
            } else {
                // Before hello, local edits reach the server through our step2 answer to its step1.
                self.unsent = true;
            }
        }
        std::mem::take(&mut self.outbox)
    }

    /// Advance the clock (`now_ms`, monotonic): renews our awareness state every 15 s while connected and
    /// removes remote states not renewed for 30 s (y-protocols' check interval). Returns whether remote
    /// presence changed, and in how many ms to tick again.
    pub fn tick(&mut self, now_ms: f64) -> (bool, Option<f64>) {
        self.now = now_ms;
        let mut wake: Option<f64> = None;
        let mut soonest = |ms: f64| wake = Some(wake.map_or(ms, |w: f64| w.min(ms)));
        if self.hello && !self.left && !self.stopped {
            if now_ms - self.last_announce >= AWARENESS_RENEW_MS {
                self.publish();
            }
            soonest(AWARENESS_RENEW_MS - (now_ms - self.last_announce));
        }
        let mut changed = false;
        for p in self.presence.peers.values_mut() {
            if p.state.is_none() {
                continue;
            }
            let age = now_ms - p.updated;
            if age >= AWARENESS_TIMEOUT_MS {
                p.state = None;
                changed = true;
            } else {
                soonest(AWARENESS_TIMEOUT_MS - age);
            }
        }
        (changed, wake.map(|w| w.max(0.0)))
    }

    /// The socket closed: wait for a new hello, forget the others' presence (and their clocks), drop queued
    /// frames (local edits stay in the doc and go out with the next step2).
    pub fn disconnected(&mut self) {
        self.hello = false;
        self.outbox.clear();
        self.presence.peers.clear();
    }

    /// Show our caret/selection (UTF-16) to others (None = not focused).
    pub fn set_cursor(&mut self, sel: Option<(u32, u32)>) {
        self.cursor = sel.map(|(a, h)| {
            let r = self.store.borrow().sel_rel(a, h);
            (r.anchor, r.head)
        });
        if !self.left {
            self.publish();
        }
    }

    /// The published cursor resolved against the current text (UTF-16).
    pub fn cursor(&self) -> Option<(u32, u32)> {
        let (a, h) = self.cursor.as_ref()?;
        let st = self.store.borrow();
        Some((st.resolve(a)?, st.resolve(h)?))
    }

    /// Our cursor as published (Yjs `relativePositionToJSON` format), if any.
    pub fn cursor_json(&self) -> Value {
        match &self.cursor {
            Some((a, h)) => json!({ "anchor": a, "head": h }),
            None => Value::Null,
        }
    }

    /// Ask the server to commit now.
    pub fn request_flush(&mut self) {
        self.send_control(&json!({ "t": "flush" }));
    }

    /// Announce that we left (call before closing the socket).
    pub fn leave(&mut self) {
        self.left = true;
        self.presence.set_local(None);
        if self.hello {
            self.send_awareness();
        }
    }

    pub fn remote_cursors(&self) -> Vec<RemoteCursor> {
        let mut out = Vec::new();
        for (v, &client) in self.peer_states() {
            let pos = |k: &str| -> Option<u32> {
                let idx: StickyIndex = serde_json::from_value(v["cursor"][k].clone()).ok()?;
                self.store.borrow().resolve(&idx)
            };
            out.push(RemoteCursor { client, user: v["user"].clone(), anchor: pos("anchor"), head: pos("head") });
        }
        out
    }

    /// The other clients' awareness states (parsed JSON), by client id.
    pub fn peers(&self) -> Vec<(u64, Value)> {
        self.peer_states().into_iter().map(|(v, &c)| (c, v)).collect()
    }

    fn peer_states(&self) -> Vec<(Value, &u64)> {
        self.presence
            .peers
            .iter()
            .filter_map(|(c, p)| Some((serde_json::from_str::<Value>(p.state.as_deref()?).ok()?, c)))
            .collect()
    }

    fn local_state(&self) -> String {
        json!({ "user": self.user, "cursor": self.cursor_json() }).to_string()
    }

    fn publish(&mut self) {
        let state = self.local_state();
        self.presence.set_local(Some(state));
        if self.hello {
            self.send_awareness();
        }
    }

    fn send_awareness(&mut self) {
        self.last_announce = self.now;
        let update = self.presence.local_update(self.me());
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

/// Build a control frame (tests / tools).
pub fn control_frame(msg: &Value) -> Vec<u8> {
    let mut enc = EncoderV1::new();
    enc.write_var(MSG_CONTROL);
    enc.write_string(&msg.to_string());
    enc.to_vec()
}
