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

use crate::store::{Change, TEXT_NAME, YrsStore};
use crate::validate::check_update;

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
    /// The cursor as published (JSON text): changes only when that participant moves it.
    pub key: String,
}

/// Updates held back at most (see `Session::held`).
const MAX_HELD: usize = 1000;

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
        self.clock = self.clock.saturating_add(1);
        self.state = state;
    }

    /// Returns whether a remote state changed, and whether ours must be announced again (someone removed it).
    fn apply(&mut self, me: u64, update: AwarenessUpdate, now: f64) -> (bool, bool) {
        let mut changed = false;
        let mut reannounce = false;
        for (id, entry) in update.clients {
            let id = id.get();
            let state = (&*entry.json != "null").then(|| entry.json.to_string());
            if id == me {
                // never let a remote client remove our state: get ahead of its clock and say we're still here
                if state.is_none() && self.state.is_some() && entry.clock >= self.clock {
                    self.clock = entry.clock.saturating_add(1);
                    reannounce = true;
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
        (changed, reannounce)
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
    /// Local edits the server may not have (made or queued while not connected, or lost with a closing
    /// socket); sent by our step2 reply. Updates still pending in the store count too (`has_unsent`).
    pub unsent: bool,
    /// The server's step1 on this connection has been answered (our step2 carried everything): only then do
    /// local edits go out as updates.
    answered: bool,
    /// After a reset: everything is ignored.
    pub stopped: bool,
    /// The shell's monotonic clock (ms), as last given to `tick`.
    now: f64,
    /// When our awareness state was last sent.
    last_announce: f64,
    /// We announced that we left; the cursor isn't published any more.
    left: bool,
    outbox: Vec<Vec<u8>>,
    /// Updates that arrived before the ones they follow (a client's clock jumps past what we have, e.g. a
    /// broadcast overtaking our step2): applied once the gap is filled. yrs would integrate them now with a
    /// "skip" hole, a path that loses text or panics when the hole fills (see tests/pending.rs).
    held: Vec<Vec<u8>>,
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
            answered: false,
            stopped: false,
            now: 0.0,
            last_announce: 0.0,
            left: false,
            outbox: Vec::new(),
            held: Vec::new(),
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

    /// Whether the server may lack local edits (see `unsent`).
    pub fn has_unsent(&self) -> bool {
        self.unsent || self.store.borrow().has_updates()
    }

    /// The shell couldn't send frames (the socket was closing): the edits in them are unsent again.
    pub fn frames_lost(&mut self) {
        self.unsent = true;
    }

    fn reset(&mut self, events: &mut Vec<Event>) {
        self.stopped = true;
        self.disconnected();
        events.push(Event::Reset);
    }

    /// Feed one binary frame from the server. `now_ms`: the shell's monotonic clock (presence timestamps).
    pub fn receive(&mut self, data: &[u8], now_ms: f64) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        if self.stopped {
            return Ok(events);
        }
        self.now = now_ms;
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
                    if self.generation.as_ref().is_some_and(|g| *g != generation) || (read_only && self.has_unsent()) {
                        self.reset(&mut events);
                        return Ok(events);
                    }
                    self.hello = true;
                    self.answered = false;
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
                    if self.read_only {
                        // Read-only: never answer with our own contents. A server lacking some of them (an
                        // update lost on the way) would drop them silently: start over instead.
                        if self.has_unsent() || self.store.borrow().is_ahead_of(&sv) {
                            self.reset(&mut events);
                            return Ok(events);
                        }
                    } else {
                        // our step2 carries everything we had offline, and the updates not sent yet
                        self.store.borrow_mut().take_updates();
                        let diff = self.store.borrow().diff(&sv);
                        self.send_sync(SyncMessage::SyncStep2(diff));
                        self.unsent = false;
                        self.answered = true;
                    }
                }
                SyncMessage::SyncStep2(u) => {
                    self.apply_update(u)?;
                    if !self.synced {
                        self.synced = true;
                        events.push(Event::Synced);
                    }
                }
                SyncMessage::Update(u) => self.apply_update(u)?,
            },
            MSG_AWARENESS => {
                let buf = dec.read_buf().map_err(err)?;
                let update = AwarenessUpdate::decode_v1(buf).map_err(err)?;
                let me = self.me();
                let (changed, reannounce) = self.presence.apply(me, update, self.now);
                if changed {
                    events.push(Event::Awareness);
                }
                if reannounce && !self.left {
                    self.send_awareness();
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

    /// Apply a remote update after checking it (`validate`), or hold it while it'd leave a gap; then apply the
    /// held updates whose gaps are filled now.
    fn apply_update(&mut self, u: Vec<u8>) -> Result<(), String> {
        let starts = check_update(&u, TEXT_NAME)?;
        if self.has_gap(&starts) {
            if self.held.len() >= MAX_HELD {
                return Err("too many updates out of order".into());
            }
            self.held.push(u);
            return Ok(());
        }
        self.store.borrow_mut().apply_remote_update(&u)?;
        while let Some(i) = self.held.iter().position(|h| check_update(h, TEXT_NAME).is_ok_and(|s| !self.has_gap(&s))) {
            let h = self.held.remove(i);
            self.store.borrow_mut().apply_remote_update(&h)?;
        }
        Ok(())
    }

    fn has_gap(&self, starts: &[(u64, u32)]) -> bool {
        let sv = self.store.borrow().state_vector();
        starts.iter().any(|&(client, clock)| clock > sv.get(&ClientID::new(client)))
    }

    /// Frames to send: local updates since the last call (merged into one), plus queued protocol replies.
    pub fn take_outgoing(&mut self) -> Vec<Vec<u8>> {
        let updates = self.store.borrow_mut().take_updates();
        if !updates.is_empty() && !self.stopped {
            if self.hello && self.answered && !self.read_only {
                match yrs::merge_updates_v1(&updates) {
                    Ok(u) => self.send_sync(SyncMessage::Update(u)),
                    Err(_) => {
                        for u in updates {
                            self.send_sync(SyncMessage::Update(u));
                        }
                    }
                }
            } else {
                // Until the server's step1 is answered (and while read-only), local edits stay in the doc and
                // reach the server through a step2.
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
        self.answered = false;
        self.held.clear();
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
            out.push(RemoteCursor { client, user: v["user"].clone(), anchor: pos("anchor"), head: pos("head"), key: v["cursor"].to_string() });
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
