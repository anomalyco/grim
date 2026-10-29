//! Protocol v2 in the app (grim `docs/07-workspace-socket.md`): one WebSocket for the workspace selected in this
//! window, its notes on channels. The open note is still driven by the room code in `remote.rs` (`room_frame`,
//! `room_closed`, `connect_room`), its frames routed here by path; notes shown before (warm) and the tree neighbour
//! (a prefetch) stay open as hidden channels with editors of their own, so going to one swaps its synced editor in
//! without a round trip. Channel 0 carries the workspace events that replace the `/api/events` stream.
//!
//! Only the selected workspace has a socket: `Mux` lives in `Remote` and closes its socket when dropped, so leaving
//! or switching the workspace (or losing it) closes the socket with its channels and prefetches. Local workspaces
//! have none.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use collab::Notice;
use collab::mux::{self, MuxEvent, Welcome, WorkspaceClient};
use rune::Tx;
use serde_json::{Value, json};

use crate::note::Collab;
use crate::remote::{Backend, Handle, MockRef, Problem, ToSock, client_id, guest_query, workspace_ws_url};
use crate::wsock::{self, Heartbeat, SockEvents, SockTx};
use crate::{App, files, keys};

/// Opens per socket the server allows in `OPEN_WINDOW_MS` (reopens of a path closed in the last `REOPEN_FREE_MS`
/// aren't counted); prefetches use at most half.
pub const OPEN_RATE_MAX: usize = 32;
pub const OPEN_WINDOW_MS: f64 = 10_000.0;
pub const REOPEN_FREE_MS: f64 = 60_000.0;

/// A note open on the socket but not shown: one shown before (warm) or a prefetch.
pub struct Hidden {
    pub path: String,
    pub ed: Box<Collab>,
    pub synced: bool,
    /// Shown in this window before (warm), not only prefetched.
    pub shown: bool,
    /// Its room's last `blame` (the authors when it's shown).
    pub blame: Option<collab::blame::Blame>,
}

/// The workspace socket and its notes.
pub struct Mux {
    pub sock: Option<SockTx>,
    pub client: WorkspaceClient,
    pub hidden: Vec<Hidden>,
    /// The heartbeat interval (`welcome.pingMs`), read by the socket thread.
    pub ping: Arc<AtomicU64>,
    /// Reconnect attempts since the last `welcome`.
    pub attempt: u32,
    /// This connection (frames and closes of older ones are dropped).
    pub conn: u64,
    /// A `welcome` came on some connection: the next one is a reconnect.
    pub welcomed: bool,
    /// `welcome`'s awareness timing (renew, timeout), for editors made later.
    pub timing: Option<(f64, f64)>,
    /// Counted opens (ms), and paths closed lately (path, ms): the server's open rate.
    opens: VecDeque<f64>,
    closed: Vec<(String, f64)>,
    /// The mock server's end, in tests and headless runs.
    mock: Option<MockRef>,
}

impl Mux {
    pub fn new() -> Mux {
        Mux {
            sock: None,
            client: WorkspaceClient::new(),
            hidden: Vec::new(),
            ping: Arc::new(AtomicU64::new(mux::PING_MS as u64)),
            attempt: 0,
            conn: 0,
            welcomed: false,
            timing: None,
            opens: VecDeque::new(),
            closed: Vec::new(),
            mock: None,
        }
    }

    /// Opens counted against the rate in the last window.
    fn recent_opens(&mut self, now: f64) -> usize {
        while self.opens.front().is_some_and(|&t| now - t >= OPEN_WINDOW_MS) {
            self.opens.pop_front();
        }
        self.opens.len()
    }

    fn count_open(&mut self, path: &str, now: f64) {
        self.closed.retain(|c| now - c.1 < REOPEN_FREE_MS);
        if !self.closed.iter().any(|c| c.0 == path) {
            self.opens.push_back(now);
        }
    }

    fn close(&mut self, path: &str, now: f64) {
        self.client.close(path);
        self.closed.push((path.to_string(), now));
    }

    /// Hidden notes the client closed to make room: (path, text when synced) for the cache.
    fn forget(&mut self, paths: Vec<String>) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for p in paths {
            if let Some(i) = self.hidden.iter().position(|h| h.path == p) {
                let h = self.hidden.remove(i);
                if h.synced {
                    out.push((p, h.ed.editor().text().to_string()));
                }
            }
        }
        out
    }
}

impl Default for Mux {
    fn default() -> Mux {
        Mux::new()
    }
}

impl Drop for Mux {
    fn drop(&mut self) {
        if let Some(s) = self.sock.take() {
            s.send(ToSock::Close);
        }
        if let Some(m) = self.mock.take()
            && let Ok(mut m) = m.try_borrow_mut()
        {
            m.ws_close();
        }
    }
}

/// The socket thread's events, back on the UI thread tagged with the workspace opening and the connection.
struct MuxEvents {
    handle: Handle,
    session: u64,
    conn: u64,
}

impl SockEvents for MuxEvents {
    fn frame(&mut self, data: Vec<u8>) {
        let (s, c) = (self.session, self.conn);
        self.handle.update(move |app, tx| app.v2_frame(s, c, &data, tx));
    }

    fn closed(self, code: u16, reason: String) {
        let (s, c) = (self.session, self.conn);
        self.handle.update(move |app, tx| app.v2_closed(s, c, code, &reason, tx));
    }
}

impl App {
    /// The open workspace speaks v2 (it has a socket, or is getting one).
    pub fn v2(&self) -> bool {
        self.remote.as_ref().is_some_and(|r| r.mux.is_some())
    }

    /// The workspace's socket (the server advertises `ws: [.., 2]`), instead of the event stream.
    pub fn v2_start(&mut self) {
        let Some(rem) = self.remote.as_mut() else { return };
        match &rem.mux {
            // started early and down (it was offline): the load got through, so try now, not at the next backoff
            Some(m) if m.sock.is_none() && m.mock.is_none() && matches!(self.backend, Backend::Net(_)) => {}
            Some(_) => return,
            None => rem.mux = Some(Mux::new()),
        }
        self.v2_connect();
    }

    fn v2_connect(&mut self) {
        let Some(rem) = self.remote.as_mut() else { return };
        let (session, api, id, user) = (rem.session, rem.api.clone(), rem.id().to_string(), rem.user.clone());
        let Some(mux) = rem.mux.as_mut() else { return };
        mux.conn = crate::remote::next_gen();
        let conn = mux.conn;
        match &self.backend {
            Backend::Net(h) => {
                let url = workspace_ws_url(&api.server, &id) + &guest_query(&api);
                let hb = Heartbeat { ms: mux.ping.clone(), timeout: Duration::from_millis(mux::PONG_TIMEOUT_MS as u64) };
                mux.sock = Some(wsock::spawn(api.server.clone(), url, api.token.clone(), Some(hb), MuxEvents { handle: h.clone(), session, conn }));
            }
            Backend::Mock(m) => {
                m.borrow_mut().ws_open(user);
                mux.mock = Some(m.clone());
                self.pump_mock();
            }
            Backend::None => {}
        }
    }

    pub fn v2_reconnect(&mut self, session: u64, conn: u64) {
        let ok = self.remote.as_ref().filter(|r| r.session == session).and_then(|r| r.mux.as_ref()).is_some_and(|m| m.conn == conn && m.sock.is_none());
        if ok {
            self.v2_connect();
        }
    }

    /// A frame from the workspace socket.
    pub fn v2_frame(&mut self, session: u64, conn: u64, data: &[u8], tx: &mut Tx) {
        let Some(mux) = self.remote.as_mut().filter(|r| r.session == session).and_then(|r| r.mux.as_mut()).filter(|m| m.conn == conn) else { return };
        for ev in mux.client.receive(data) {
            self.v2_event(ev, tx);
        }
        self.v2_flush();
    }

    fn v2_event(&mut self, ev: MuxEvent, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        let current = |p: &str| rem.note.as_deref() == Some(p);
        let generation = rem.generation;
        match ev {
            MuxEvent::Welcome(w) => self.v2_welcome(w, tx),
            MuxEvent::Opened { .. } => {}
            MuxEvent::Frame { path, body } => {
                if current(&path) {
                    self.room_frame(generation, &body, tx);
                } else {
                    self.hidden_frame(&path, &body);
                }
            }
            MuxEvent::Failed { path, code, reason } => {
                if current(&path) {
                    self.room_closed(generation, code, &reason, tx);
                } else {
                    self.hidden_closed(&path, code, false);
                }
            }
            MuxEvent::End { path, code, reason } => {
                if current(&path) {
                    self.room_closed(generation, code, &reason, tx);
                } else {
                    self.hidden_closed(&path, code, true);
                }
            }
            MuxEvent::Renew { path, ms } => {
                let ce = if current(&path) {
                    crate::remote::room_ed!(self)
                } else {
                    rem.mux.as_mut().and_then(|m| m.hidden.iter_mut().find(|h| h.path == path)).map(|h| &mut *h.ed)
                };
                if let Some(ce) = ce {
                    let (_, timeout) = ce.awareness_timing();
                    ce.set_awareness_timing(ms, timeout);
                }
            }
            MuxEvent::Event(v) => self.v2_workspace_event(&v, tx),
        }
    }

    /// `welcome` (on every connection): the server's timing to the editors, then every note open again with its
    /// state vector in one flight. After a reconnect the tree and the switcher's list load again (changes may have
    /// been missed); presence comes as a snapshot.
    fn v2_welcome(&mut self, w: Welcome, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        let (session, server, note) = (rem.session, rem.api.server.clone(), rem.note.clone());
        rem.offline = None;
        if rem.repo.is_object() {
            rem.repo["status"] = json!(w.status);
            rem.repo["error"] = w.error.as_ref().map_or(Value::Null, |e| json!(e));
        }
        let Some(mux) = rem.mux.as_mut() else { return };
        mux.attempt = 0;
        mux.ping.store(w.ping_ms as u64, Ordering::Relaxed);
        mux.timing = Some((w.renew_ms, w.awareness_timeout_ms));
        let reconnect = std::mem::replace(&mut mux.welcomed, true);
        let mut svs: Vec<(String, Vec<u8>)> = Vec::new();
        for h in &mut mux.hidden {
            h.ed.set_awareness_timing(w.renew_ms, w.awareness_timeout_ms);
            if reconnect {
                h.ed.connecting();
            }
            svs.push((h.path.clone(), h.ed.state_vector()));
        }
        let open = note.as_deref().is_some_and(|n| mux.client.is_open(n));
        if let Some(ce) = crate::remote::room_ed!(self) {
            ce.set_awareness_timing(w.renew_ms, w.awareness_timeout_ms);
            if open {
                if reconnect {
                    ce.connecting();
                }
                svs.push((note.unwrap_or_default(), ce.state_vector()));
            }
        }
        mux.client.reopen_all(|p| svs.iter().find(|s| s.0 == p).map(|s| s.1.clone()));
        self.presence.retain(|k, _| k.0 != rem.id());
        if reconnect {
            self.fetch_tree(session, tx);
            self.refresh_joined(&server);
        }
        tx.instant();
    }

    /// A frame for a hidden note: its editor syncs (its replies go out; the client drops its awareness).
    fn hidden_frame(&mut self, path: &str, body: &[u8]) {
        let now = self.now_ms();
        let Some(rem) = self.remote.as_mut() else { return };
        let key = crate::notecache::key(&rem.api.server, rem.id(), path);
        let Some(mux) = rem.mux.as_mut() else { return };
        let Some(i) = mux.hidden.iter().position(|h| h.path == path) else { return };
        let h = &mut mux.hidden[i];
        let Ok(r) = h.ed.receive(body, now) else { return };
        if r.reloaded {
            h.ed.editor_mut().set_key_table(Some(keys::table()));
        }
        let mut reset = false;
        for n in &r.notices {
            match n {
                Notice::Synced => {
                    h.synced = true;
                    self.note_cache.put(&key, h.ed.editor().text());
                }
                Notice::Blame(b) => h.blame = Some(b.clone()),
                Notice::Reset => reset = true,
                _ => {}
            }
        }
        for f in r.outgoing {
            mux.client.send(path, &f);
        }
        if reset {
            // another generation: not worth keeping warm; it opens fresh when shown
            mux.hidden.remove(i);
            mux.close(path, now);
        }
    }

    /// A hidden note's channel failed or ended: an `end` 1013 reopens it with its state vector (the room was reset or
    /// woke with another generation), anything else drops it.
    fn hidden_closed(&mut self, path: &str, code: u16, end: bool) {
        let now = self.now_ms();
        let Some(rem) = self.remote.as_mut() else { return };
        let key = crate::notecache::key(&rem.api.server, rem.id(), path);
        let Some(mux) = rem.mux.as_mut() else { return };
        let Some(i) = mux.hidden.iter().position(|h| h.path == path) else { return };
        if end && code == mux::CODE_RETRY {
            let h = &mut mux.hidden[i];
            h.ed.disconnected(code, "");
            h.ed.connecting();
            let sv = h.ed.state_vector();
            mux.count_open(path, now);
            let gone = mux.client.open(path, true, false, Some(&sv));
            for (p, t) in mux.forget(gone) {
                self.note_cache.put(&crate::notecache::key(&rem.api.server, rem.id(), &p), &t);
            }
            return;
        }
        let h = mux.hidden.remove(i);
        if h.synced {
            self.note_cache.put(&key, h.ed.editor().text());
        }
    }

    /// A workspace event on channel 0 (the web's socket `onEvent`).
    fn v2_workspace_event(&mut self, v: &Value, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut() else { return };
        let (session, id) = (rem.session, rem.id().to_string());
        let users = |u: &Value| -> Vec<crate::header::Person> { u.as_array().map(|a| a.iter().filter_map(|u| crate::header::Person::from_user(u, false)).collect()).unwrap_or_default() };
        match v["t"].as_str() {
            Some("tree") => self.fetch_tree(session, tx),
            Some("presence") => {
                if v["files"].is_array() {
                    // the snapshot (after `welcome`)
                    self.presence.retain(|k, _| k.0 != id);
                }
                let mut set = |path: &str, u: Vec<crate::header::Person>| {
                    let key = (id.clone(), path.to_string());
                    if u.is_empty() {
                        self.presence.remove(&key);
                    } else {
                        self.presence.insert(key, u);
                    }
                };
                if let Some(files) = v["files"].as_array() {
                    for f in files {
                        if let Some(p) = f["path"].as_str() {
                            set(p, users(&f["users"]));
                        }
                    }
                } else if let Some(p) = v["path"].as_str() {
                    set(p, users(&v["users"]));
                }
                tx.instant();
            }
            Some("saved") if rem.note.as_deref() == v["path"].as_str() => {
                let sha = v["sha"].as_str().map(str::to_string);
                self.history_saved(sha.as_deref(), tx);
            }
            Some("workspace") => {
                let status = v["status"].as_str().unwrap_or_default();
                if status == "removed" {
                    self.lose_workspace(Problem::Gone, tx);
                    return;
                }
                let was = rem.repo["status"].as_str().map(str::to_string);
                if rem.repo.is_object() {
                    if !status.is_empty() {
                        rem.repo["status"] = json!(status);
                    }
                    rem.repo["error"] = v["error"].clone();
                }
                if let Some(t) = v["title"].as_str() {
                    let t = t.to_string();
                    self.retitle_current(&t, tx);
                }
                // an import finished: its notes
                if status == "ready" && was.as_deref() != Some("ready") {
                    self.fetch_tree(session, tx);
                }
                tx.instant();
            }
            _ => {}
        }
    }

    /// The socket closed: the workspace is gone (4404) or the token refused (4401), else offline until a reconnect
    /// (500 ms, doubling to 10 s) reopens every note with its state vector.
    pub fn v2_closed(&mut self, session: u64, conn: u64, code: u16, reason: &str, tx: &mut Tx) {
        let Some(rem) = self.remote.as_mut().filter(|r| r.session == session) else { return };
        let Some(mux) = rem.mux.as_mut().filter(|m| m.conn == conn) else { return };
        mux.sock = None;
        mux.client.disconnected();
        match code {
            4404 => self.lose_workspace(Problem::Gone, tx),
            4403 => self.lose_workspace(Problem::Missing, tx),
            4401 => match rem.api.token.is_some().then(|| rem.api.server.clone()) {
                Some(server) => self.signed_out(&server, tx),
                None => self.lose_workspace(Problem::SignedOut, tx),
            },
            _ => {
                mux.attempt += 1;
                let delay = (mux::RECONNECT_MIN_MS * 2f64.powi(mux.attempt as i32 - 1)).min(mux::RECONNECT_MAX_MS);
                for h in &mut mux.hidden {
                    h.ed.disconnected(1006, "");
                }
                if rem.offline.is_none() {
                    rem.offline = Some(if reason.is_empty() { "The connection to the server was lost.".into() } else { reason.to_string() });
                }
                rem.focused = false;
                let id = rem.id().to_string();
                if let Some(ce) = crate::remote::room_ed!(self) {
                    ce.disconnected(1006, reason);
                }
                // no typing while away (what was typed before syncs when it's back)
                if self.remote.as_ref().is_some_and(|r| r.synced) {
                    self.note_offline();
                }
                self.presence.retain(|k, _| k.0 != id);
                if let Backend::Net(h) = &self.backend {
                    let h = h.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(delay as u64));
                        h.update(move |app, _| app.v2_reconnect(session, conn));
                    });
                }
            }
        }
        tx.instant();
    }

    /// Send what the client has queued.
    pub fn v2_flush(&mut self) {
        let Some(mux) = self.remote.as_mut().and_then(|r| r.mux.as_mut()) else { return };
        let out = mux.client.take_outgoing();
        if out.is_empty() {
            return;
        }
        if let Some(s) = &mux.sock {
            for f in out {
                s.send(ToSock::Frame(f));
            }
        } else if let Some(m) = mux.mock.clone() {
            m.borrow_mut().ws_in(out);
            self.pump_mock();
        }
    }

    /// Open the current note's channel (its editor's state vector: only what it lacks comes back).
    pub fn v2_open_current(&mut self, note: &str) {
        let now = self.now_ms();
        let sv = crate::remote::room_ed_ref!(self).map(|c| c.state_vector());
        let Some(rem) = self.remote.as_mut() else { return };
        let (server, id) = (rem.api.server.clone(), rem.id().to_string());
        let Some(mux) = rem.mux.as_mut() else { return };
        if !mux.client.is_open(note) {
            mux.count_open(note, now);
        }
        let gone = mux.client.open(note, false, false, sv.as_deref());
        for (p, t) in mux.forget(gone) {
            self.note_cache.put(&crate::notecache::key(&server, &id, &p), &t);
        }
        self.v2_flush();
    }

    /// Frames from the current note's editor onto its channel (false: they couldn't go, e.g. no channel now).
    pub fn v2_send(&mut self, frames: Vec<Vec<u8>>) -> bool {
        let Some(rem) = self.remote.as_mut() else { return false };
        let note = rem.note.clone();
        let Some(mux) = rem.mux.as_mut() else { return false };
        let mut ok = true;
        for f in frames {
            ok &= note.as_deref().is_some_and(|n| mux.client.send(n, &f));
        }
        self.v2_flush();
        ok
    }

    /// Leave the current note. `keep`: going to another note — it stays open hidden (warm) when it's synced and
    /// still open, so coming back costs nothing; the least recently shown warm note goes past `maxChannels − 3`.
    pub fn v2_close_note(&mut self, keep: bool) {
        let now = self.now_ms();
        let Some(rem) = self.remote.as_mut() else { return };
        rem.generation = crate::remote::next_gen();
        let Some(note) = rem.note.take() else { return };
        let keep = keep && rem.synced && rem.notice.is_none() && self.staged.is_none();
        let blame = rem.blame.take();
        let Some(mux) = rem.mux.as_mut() else { return };
        let keep = keep && mux.client.is_live(&note);
        let mut frames = Vec::new();
        if let Some(ce) = crate::remote::room_ed!(self) {
            if keep {
                frames.extend(ce.take_outgoing(now).frames);
            }
            frames.extend(ce.leave());
        }
        for f in frames {
            mux.client.send(&note, &f);
        }
        let ed = keep.then(|| std::mem::replace(&mut self.ed, crate::note::Ed::local(""))).and_then(|e| match e {
            crate::note::Ed::Remote(ce) => Some(ce),
            crate::note::Ed::Local(_) => None,
        });
        match ed {
            Some(ed) => {
                mux.client.view(&note, true);
                let warm = mux.hidden.iter().filter(|h| h.shown).count();
                if warm + 3 >= mux.client.max_channels()
                    && let Some(i) = mux.hidden.iter().position(|h| h.shown)
                {
                    let p = mux.hidden[i].path.clone();
                    mux.hidden.remove(i);
                    mux.close(&p, now);
                }
                mux.hidden.push(Hidden { path: note, ed, synced: true, shown: true, blame });
            }
            None => mux.close(&note, now),
        }
        self.v2_flush();
    }

    /// Going to `rel`: its hidden editor when it has one (warm or prefetched).
    pub fn v2_take_hidden(&mut self, rel: &str) -> Option<Hidden> {
        let mux = self.remote.as_mut()?.mux.as_mut()?;
        let i = mux.hidden.iter().position(|h| h.path == rel)?;
        let mut h = mux.hidden.remove(i);
        mux.client.view(rel, false);
        h.ed.rejoin();
        Some(h)
    }

    /// Prefetch the open note's tree neighbour (below first, else above) as a hidden channel: at most
    /// `MAX_PREFETCH` syncing at once, within half the open rate.
    pub fn v2_prefetch(&mut self, rel: &str) {
        let now = self.now_ms();
        let root = self.root.clone().unwrap_or_default();
        let order: Vec<String> = files::notes_under(&self.files, &root).iter().filter_map(|p| p.strip_prefix(&root).ok()).map(|p| p.to_string_lossy().into_owned()).collect();
        let Some(rem) = self.remote.as_mut() else { return };
        let (server, id, user) = (rem.api.server.clone(), rem.id().to_string(), rem.user.clone());
        let Some(mux) = rem.mux.as_mut() else { return };
        if mux.hidden.iter().filter(|h| !h.synced && !h.shown).count() >= mux::MAX_PREFETCH || mux.recent_opens(now) >= OPEN_RATE_MAX / 2 {
            return;
        }
        let Some(i) = order.iter().position(|p| p == rel) else { return };
        let next = [i + 1, i.wrapping_sub(1)].into_iter().filter_map(|j| order.get(j)).find(|p| !mux.client.is_open(p)).cloned();
        let Some(p) = next else { return };
        let mut ed = Box::new(Collab::new_in(client_id(), user));
        ed.set_local_read_only(true);
        ed.editor_mut().set_key_table(Some(keys::table()));
        if let Some((renew, timeout)) = mux.timing {
            ed.set_awareness_timing(renew, timeout);
        }
        ed.connecting();
        mux.count_open(&p, now);
        let gone = mux.client.open(&p, true, false, None);
        mux.hidden.push(Hidden { path: p, ed, synced: false, shown: false, blame: None });
        for (p, t) in mux.forget(gone) {
            self.note_cache.put(&crate::notecache::key(&server, &id, &p), &t);
        }
        self.v2_flush();
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use editor_core::Sel;
    use rune::Tx;
    use serde_json::json;

    use crate::App;
    use crate::remote::{Backend, Mock, MockRef, Problem};

    fn app(notes: &[(&str, &str)], v2: bool) -> (App, MockRef, Tx) {
        let m = Rc::new(RefCell::new(Mock::new(notes)));
        m.borrow_mut().v2 = v2;
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(m.clone());
        (app, m, Tx::default())
    }

    fn open(app: &mut App, tx: &mut Tx, id: &str, note: Option<&str>) {
        app.open_remote("https://g.example".into(), id.into(), String::new(), note.map(str::to_string), tx);
    }

    fn go(app: &mut App, tx: &mut Tx, rel: &str) {
        let p = app.root.clone().unwrap().join(rel);
        app.open_note(p, tx);
        app.handled(tx);
    }

    fn opens(m: &MockRef, path: &str) -> usize {
        m.borrow().mux.as_ref().map_or(0, |x| x.opens.iter().filter(|o| o.0 == path).count())
    }

    fn hidden(app: &App) -> Vec<(String, bool)> {
        app.remote.as_ref().and_then(|r| r.mux.as_ref()).map_or(Vec::new(), |m| m.hidden.iter().map(|h| (h.path.clone(), h.synced)).collect())
    }

    /// One socket for the workspace; the note opens on a channel, its tree neighbour is prefetched hidden; going to
    /// the neighbour, and back to a note shown before (warm), swaps a synced editor in: no open, no round trip. A
    /// warm note keeps up with others' edits meanwhile.
    #[test]
    fn notes_switch_over_one_socket_without_opening_again() {
        let (mut app, m, mut tx) = app(&[("a.md", "A\n"), ("b.md", "B\n"), ("c.md", "C\n"), ("d.md", "D\n")], true);
        open(&mut app, &mut tx, "team", Some("a.md"));
        let rem = app.remote.as_ref().unwrap();
        assert!(rem.mux.is_some() && rem.synced && app.ed.text() == "A\n" && !app.ed.is_read_only());
        assert_eq!((m.borrow().sockets_open, m.borrow().sockets_opened), (1, 1));
        assert_eq!(m.borrow().app_note, None, "no v1 room socket");
        assert_eq!(hidden(&app), [("b.md".to_string(), true)], "the neighbour below, synced hidden");
        // the neighbour: swapped in, live and editable at once
        go(&mut app, &mut tx, "b.md");
        assert!(app.remote.as_ref().unwrap().synced && app.ed.text() == "B\n" && !app.ed.is_read_only());
        assert_eq!(opens(&m, "b.md"), 1, "no second open");
        assert!(app.staged.is_none(), "no preview needed");
        let warm = hidden(&app);
        assert!(warm.contains(&("a.md".to_string(), true)) && warm.contains(&("c.md".to_string(), true)), "{warm:?}");
        // our edit goes out on b's channel
        app.ed.set_selection(Sel::caret(1));
        app.ed.insert_text("!");
        app.handled(&mut tx);
        assert_eq!(m.borrow().text("b.md").unwrap(), "B!\n");
        // someone edits a (warm) meanwhile; going back shows it, still without an open
        let ada = m.borrow_mut().add_peer("a.md", 9, "Ada", "#d6409f");
        m.borrow_mut().peer(ada, |ed| {
            ed.editor_mut().set_selection(Sel::caret(0));
            ed.editor_mut().insert_text("Ada ");
        });
        app.pump_mock();
        go(&mut app, &mut tx, "a.md");
        assert_eq!(app.ed.text(), "Ada A\n");
        assert_eq!(opens(&m, "a.md"), 1);
        // a hidden note sends no awareness: the room sees us only in the note shown
        let chans = m.borrow().mux.as_ref().unwrap().chans.clone();
        assert!(chans.iter().any(|c| c.1 == "a.md" && !c.2) && chans.iter().any(|c| c.1 == "b.md" && c.2), "{chans:?}");
        assert_eq!(m.borrow().sockets_opened, 1, "one socket all along");
    }

    /// The socket drops: what was typed before the app noticed stays, but no more typing until it's back ("Offline:
    /// read-only"); the reconnect reopens every note with its state vector in one flight, the edit reaches the room
    /// and the note is editable again. `end` 1013 (a reset) reopens the note on a new channel.
    #[test]
    fn a_reconnect_reopens_with_state_vectors_and_end_1013_reopens() {
        let (mut app, m, mut tx) = app(&[("a.md", "A\n"), ("b.md", "B\n")], true);
        open(&mut app, &mut tx, "team", Some("a.md"));
        let (s, conn) = (app.remote.as_ref().unwrap().session, app.remote.as_ref().unwrap().mux.as_ref().unwrap().conn);
        m.borrow_mut().ws_close();
        // typed as the connection went, before the app knew: it doesn't reach the server now
        app.ed.set_selection(Sel::caret(1));
        app.ed.insert_text(" offline");
        app.handled(&mut tx);
        assert_eq!(m.borrow().text("a.md").unwrap(), "A\n");
        app.v2_closed(s, conn, 1006, "", &mut tx);
        assert!(app.remote.as_ref().unwrap().offline.is_some());
        assert_eq!(app.save_status(), Some(("Offline: read-only".into(), false)));
        assert!(app.ed.is_read_only() && app.ed.text() == "A offline\n", "kept, but no more typing");
        app.v2_reconnect(s, conn);
        assert_eq!(m.borrow().sockets_opened, 2);
        let reopened: Vec<(String, bool)> = m.borrow().mux.as_ref().unwrap().opens.clone();
        assert!(reopened.contains(&("a.md".to_string(), true)) && reopened.contains(&("b.md".to_string(), true)), "with svs: {reopened:?}");
        assert_eq!(m.borrow().text("a.md").unwrap(), "A offline\n", "the offline edit reached the room");
        assert!(!app.ed.is_read_only(), "editable again");
        assert!(app.remote.as_ref().unwrap().offline.is_none() && app.save_status().is_none());
        // a stale connection's close does nothing
        app.v2_closed(s, conn, 1006, "", &mut tx);
        assert!(app.remote.as_ref().unwrap().offline.is_none());
        // end 1013: the note reopens (the collab session's retry; the mock has no timer, so as it would fire)
        let old = m.borrow().mux.as_ref().unwrap().channel("a.md").unwrap();
        m.borrow_mut().ws_end("a.md", 1013, "reset");
        app.pump_mock();
        let g = app.remote.as_ref().unwrap().generation;
        app.connect_room(g);
        assert!(m.borrow().mux.as_ref().unwrap().channel("a.md").is_some_and(|c| c != old), "a new channel");
        app.ed.insert_text("?");
        app.handled(&mut tx);
        assert!(m.borrow().text("a.md").unwrap().contains('?'));
    }

    /// Channel 0's events replace `/api/events`: presence (the snapshot after welcome, then changes), tree, saved,
    /// and the workspace's removal (then its socket is closed).
    #[test]
    fn workspace_events_come_on_the_socket() {
        let (mut app, m, mut tx) = app(&[("a.md", "A\n")], true);
        open(&mut app, &mut tx, "team", Some("a.md"));
        let key = ("team".to_string(), "a.md".to_string());
        m.borrow_mut().ws_event(json!({ "t": "presence", "files": [{ "path": "a.md", "users": [{ "id": "ada", "name": "Ada", "color": "#d6409f" }] }] }));
        app.pump_mock();
        assert_eq!(app.presence.get(&key).map(|p| p[0].name.clone()).as_deref(), Some("Ada"));
        m.borrow_mut().ws_event(json!({ "t": "presence", "path": "a.md", "users": [] }));
        app.pump_mock();
        assert!(app.presence.is_empty());
        m.borrow_mut().tree.push("new.md".into());
        m.borrow_mut().ws_event(json!({ "t": "tree", "head": "h2" }));
        app.pump_mock();
        assert!(app.tree_rows().iter().any(|r| r.rel == "new.md"));
        m.borrow_mut().ws_event(json!({ "t": "workspace", "status": "removed" }));
        app.pump_mock();
        assert_eq!(app.remote.as_ref().unwrap().problem, Some(Problem::Gone));
        assert_eq!(m.borrow().sockets_open, 0, "its socket closed");
    }

    /// A server without v2 (`ws: [1]`): the v1 room socket per note, no workspace socket.
    #[test]
    fn a_v1_server_gets_the_v1_client() {
        let (mut app, m, mut tx) = app(&[("a.md", "A\n"), ("b.md", "B\n")], false);
        open(&mut app, &mut tx, "team", Some("a.md"));
        assert!(app.remote.as_ref().unwrap().mux.is_none() && app.ed.text() == "A\n");
        assert_eq!(m.borrow().app_note.as_deref(), Some("a.md"));
        go(&mut app, &mut tx, "b.md");
        assert_eq!((m.borrow().app_note.as_deref(), app.ed.text()), (Some("b.md"), "B\n"));
        assert_eq!(m.borrow().sockets_opened, 0);
    }

    /// Owner rule: only the workspace selected in the window has a socket. Another remote workspace closes the
    /// previous one's (with its channels and prefetches); a local one has none.
    #[test]
    fn only_the_selected_workspace_has_a_socket() {
        let dir = std::env::temp_dir().join(format!("grimoire-v2-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::doc::write(&dir.join("local.md"), "local").unwrap();
        let (mut app, m, mut tx) = app(&[("a.md", "A\n"), ("b.md", "B\n")], true);
        open(&mut app, &mut tx, "team", Some("a.md"));
        assert_eq!((m.borrow().sockets_open, m.borrow().sockets_opened), (1, 1));
        open(&mut app, &mut tx, "other", Some("b.md"));
        assert_eq!((m.borrow().sockets_open, m.borrow().sockets_opened), (1, 2), "the previous one closed");
        let fresh: Vec<String> = m.borrow().mux.as_ref().unwrap().opens.iter().map(|o| o.0.clone()).collect();
        assert_eq!(fresh, ["b.md", "a.md"], "a new socket: its note and its prefetch, nothing carried over");
        app.open_local(dir.clone(), &mut tx);
        assert_eq!(m.borrow().sockets_open, 0, "a local workspace has none");
        let w = app.store.recent.iter().find(|r| matches!(&r.0, crate::workspaces::WsRef::Remote { id, .. } if id == "team")).unwrap().0.clone();
        app.choose(w, &mut tx);
        assert_eq!((m.borrow().sockets_open, m.borrow().sockets_opened), (1, 3));
        app.leave_workspace();
        assert_eq!(m.borrow().sockets_open, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Instant open (v1 and v2 alike when the note isn't warm): its cached text shows at once, read-only, with no
    /// "Connecting…" in the first 300 ms; at the sync the live editor takes over, its text winning when it differs
    /// (no merge), the caret kept only when it's the same.
    #[test]
    fn a_note_seen_before_shows_its_cached_text_until_it_syncs() {
        for v2 in [false, true] {
            let (mut app, m, mut tx) = app(&[("a.md", "A\nline two\n"), ("b.md", "B\n"), ("c.md", "C\n")], v2);
            open(&mut app, &mut tx, "team", Some("a.md"));
            app.ed.set_selection(Sel::caret(4));
            go(&mut app, &mut tx, "c.md");
            // a closes on v2 too: push it out of the warm set by closing the socket's channel for it
            if let Some(mux) = app.remote.as_mut().unwrap().mux.as_mut() {
                mux.hidden.retain(|h| h.path != "a.md");
                mux.client.close("a.md");
            }
            app.v2_flush();
            m.borrow_mut().hold = true;
            go(&mut app, &mut tx, "a.md");
            assert_eq!(app.ed.text(), "A\nline two\n", "v2={v2}: the cached text at once");
            assert!(app.ed.is_read_only() && app.ed.collab().is_none() && app.staged.is_some());
            assert_eq!(app.save_status(), None, "no Connecting… in the first 300 ms");
            app.ed.set_selection(Sel::caret(4));
            m.borrow_mut().hold = false;
            app.pump_mock();
            assert!(app.ed.collab().is_some() && app.staged.is_none() && !app.ed.is_read_only(), "v2={v2}: live");
            assert_eq!((app.ed.text(), app.ed.selection()), ("A\nline two\n", Sel::caret(4)), "same text: the caret stays");

            // changed meanwhile: the live text wins, nothing doubled
            go(&mut app, &mut tx, "c.md");
            if let Some(mux) = app.remote.as_mut().unwrap().mux.as_mut() {
                mux.hidden.retain(|h| h.path != "a.md");
                mux.client.close("a.md");
            }
            app.v2_flush();
            let ada = m.borrow_mut().add_peer("a.md", 9, "Ada", "#d6409f");
            m.borrow_mut().peer(ada, |ed| {
                let end = ed.editor().text().len();
                ed.editor_mut().set_selection(Sel::caret(end));
                ed.editor_mut().insert_text("three\n");
            });
            m.borrow_mut().hold = true;
            go(&mut app, &mut tx, "a.md");
            assert_eq!(app.ed.text(), "A\nline two\n");
            m.borrow_mut().hold = false;
            app.pump_mock();
            assert_eq!(app.ed.text(), "A\nline two\nthree\n", "v2={v2}: the live text, once");
        }
    }

    /// grim's Bun server (`native-bench.mjs` in `GRIM`, default /tmp/grim-main), killed when dropped: (it, the
    /// server's URL for the app, the "Bench" workspace, the "Second" one).
    pub struct Bun(std::process::Child);

    /// The Bun tests one at a time (the socket counters are the process's).
    static BUN_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    impl Drop for Bun {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    pub fn bun() -> (Bun, String, String, String) {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let grim = std::env::var("GRIM").unwrap_or_else(|_| "/tmp/grim-main".into());
        let bun = format!("{}/.bun/bin/bun", std::env::var("HOME").unwrap());
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut child = Command::new(bun).arg("native-bench.mjs").current_dir(&grim).env("PORT", port.to_string()).stdout(Stdio::piped()).spawn().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let server = Bun(child);
        let ready = lines.find_map(|l| l.ok().filter(|l| l.starts_with("READY"))).expect("the server's READY");
        println!("BUN {ready}");
        let w: Vec<String> = ready.split(' ').map(str::to_string).collect();
        (server, format!("http://127.0.0.1:{}", w[1]), w[2].clone(), w[3].clone())
    }

    /// An app on the real network code whose threads' updates come through a channel the test blocks on.
    pub fn net_app(dir: &std::path::Path) -> (App, std::sync::mpsc::Receiver<crate::remote::Update>) {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        let (utx, urx) = std::sync::mpsc::channel();
        let mut app = App::new("", None, true);
        app.backend = Backend::Net(crate::remote::Handle::Chan(utx));
        app.tokens = crate::workspaces::Tokens::File(dir.join("tokens.json"));
        app.store = crate::workspaces::Store::load(Some(dir.to_path_buf()));
        app.store.ensure_guest();
        (app, urx)
    }

    /// What a complete view has: the tree, the note's text, no placeholder.
    fn complete(app: &App, note: &str, first_line: &str) -> Result<(), String> {
        let rem = app.remote.as_ref().ok_or("no workspace")?;
        let checks = [
            (rem.loaded, "loaded"),
            (!app.files.is_empty(), "a tree"),
            (app.tree_note().is_none(), "no tree placeholder"),
            (rem.note.as_deref() == Some(note), "the note open"),
            (app.ed.text().starts_with(first_line), "its text"),
            (rem.problem.is_none(), "no problem"),
        ];
        match checks.iter().find(|c| !c.0) {
            Some(c) => Err(format!("missing {}: text {:?}", c.1, app.ed.text().chars().take(30).collect::<String>())),
            None => Ok(()),
        }
    }

    /// Launch and workspace switch against grim's Bun server: sampling what the window shows after every update
    /// (each is a frame), only two phases — the launch screen (or the old view), then the complete view, which
    /// already has the tree and the note's text; never "Loading…", an empty tree or a blank note in between.
    /// `cargo test --release -p grimoire two_phases -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn launch_and_switch_show_two_phases_against_bun() {
        use crate::boot::Phase;
        use std::time::{Duration, Instant};
        let _one = BUN_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let (_server, server, bench, second) = bun();
        let dir = std::env::temp_dir().join(format!("grimoire-two-phases-{}", std::process::id()));
        let (mut app, urx) = net_app(&dir);
        let mut tx = Tx::default();
        let run = |app: &mut App, tx: &mut Tx, note: &str, first: &str| -> Vec<Phase> {
            let mut seen = vec![app.phase()];
            let t = Instant::now();
            while app.phase() != Phase::Complete {
                let f = urx.recv_timeout(Duration::from_secs(10).saturating_sub(t.elapsed())).expect("the view completes");
                f(app, tx);
                if seen.last() != Some(&app.phase()) {
                    seen.push(app.phase());
                }
                // every frame of the complete view is complete, from the first
                if app.phase() == Phase::Complete {
                    complete(app, note, first).unwrap_or_else(|e| panic!("the first complete frame: {e}"));
                }
            }
            println!("PHASES {note}: {seen:?} in {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
            seen
        };
        // launch: as main does with a remote workspace to open
        app.close_gate(true);
        app.open_remote(server.clone(), bench.clone(), String::new(), Some("N02.md".into()), &mut tx);
        assert_eq!(run(&mut app, &mut tx, "N02.md", "# Note 02"), [Phase::Launch, Phase::Complete]);
        // a frame of it exists to keep (render stores it; here, any El)
        *app.last_view.borrow_mut() = Some(rune::el());
        // switch: the old view stays until the new workspace is ready
        app.open_remote(server.clone(), second.clone(), String::new(), Some("Other.md".into()), &mut tx);
        assert_eq!(run(&mut app, &mut tx, "Other.md", "# Other"), [Phase::Old, Phase::Complete]);
        // and back (its note's text cached: the switch completes on it)
        app.open_remote(server.clone(), bench.clone(), String::new(), Some("N02.md".into()), &mut tx);
        assert_eq!(run(&mut app, &mut tx, "N02.md", "# Note 02"), [Phase::Old, Phase::Complete]);
        app.leave_workspace();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A local workspace is complete in the first frame (its tree and note are read before the window draws); a
    /// problem page shows at once, not after the cap.
    #[test]
    fn local_launches_complete_and_problems_show_at_once() {
        let dir = std::env::temp_dir().join(format!("grimoire-launch-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::doc::write(&dir.join("a.md"), "# A\n").unwrap();
        let (mut app, _m, mut tx) = app(&[("a.md", "A\n")], true);
        app.open_local(dir.clone(), &mut tx);
        assert_eq!(app.phase(), crate::boot::Phase::Complete);
        assert_eq!(app.ed.text(), "# A\n");
        // a remote workspace that fails: its page at once
        let (mut app, m, mut tx) = self::app(&[("a.md", "A\n")], true);
        m.borrow_mut().fail = Some(crate::remote::ApiError::NotFound("no".into()));
        app.close_gate(true);
        open(&mut app, &mut tx, "team", None);
        assert_eq!(app.phase(), crate::boot::Phase::Complete);
        assert!(app.problem_page().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn disk_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("grimoire-diskcache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// Launch offline with the workspace on disk: its tree and the note's text show at once, read-only, with
    /// "Offline: read-only"; a note never cached shows the offline page; when a retry gets through, the note goes
    /// live in place (same text, caret kept) and is editable. v1 and v2 alike.
    #[test]
    fn an_offline_launch_reads_from_the_disk_cache_then_goes_live() {
        for v2 in [false, true] {
            let dir = disk_dir(if v2 { "launch2" } else { "launch1" });
            let notes = [("a.md", "A\nsecond line\n"), ("b.md", "B\n"), ("c.md", "C\n"), ("d.md", "D\n")];
            // a first session online fills the cache
            {
                let (mut app, _m, mut tx) = app(&notes, v2);
                app.note_cache.disk = crate::diskcache::DiskCache::new(Some(dir.clone()));
                open(&mut app, &mut tx, "team", Some("a.md"));
                app.leave_workspace();
                app.flush_disk();
                assert_eq!(app.note_cache.disk.tree("https://g.example", "team").map(|t| t.len()), Some(4));
            }
            // relaunch offline
            let (mut app, m, mut tx) = app(&notes, v2);
            app.note_cache.disk = crate::diskcache::DiskCache::new(Some(dir.clone()));
            m.borrow_mut().fail = Some(crate::remote::ApiError::Network("can't reach g.example:443".into()));
            app.close_gate(true);
            open(&mut app, &mut tx, "team", Some("a.md"));
            let rem = app.remote.as_ref().unwrap();
            assert!(rem.cached && rem.loaded, "v2={v2}");
            assert_eq!(app.phase(), crate::boot::Phase::Complete, "the cached view is a complete first view");
            assert_eq!(app.tree_rows().iter().map(|r| r.rel.clone()).collect::<Vec<_>>(), ["a.md", "b.md", "c.md", "d.md"]);
            assert_eq!(app.ed.text(), "A\nsecond line\n");
            assert!(app.ed.is_read_only() && app.problem_page().is_none());
            assert_eq!(app.save_status(), Some(("Offline: read-only".into(), false)));
            // a note not on this Mac: the offline page for it
            go(&mut app, &mut tx, "d.md");
            let (title, detail, _) = app.problem_page().expect("the offline page");
            assert_eq!(title, "Can't reach g.example");
            assert!(detail.contains("isn't saved on this Mac"), "{detail}");
            go(&mut app, &mut tx, "a.md");
            assert_eq!(app.ed.text(), "A\nsecond line\n");
            app.ed.set_selection(Sel::caret(4));
            // back online: a retry loads it; the note goes live where it is
            m.borrow_mut().fail = None;
            let (s, attempt) = match &app.remote.as_ref().unwrap().problem {
                Some(Problem::Offline { attempt, .. }) => (app.remote.as_ref().unwrap().session, *attempt),
                p => panic!("{p:?}"),
            };
            app.retry_load(s, Some(attempt), &mut tx);
            let rem = app.remote.as_ref().unwrap();
            assert!(!rem.cached && rem.synced && rem.problem.is_none(), "v2={v2}");
            assert!(app.ed.collab().is_some() && !app.ed.is_read_only());
            assert_eq!((app.ed.text(), app.ed.selection()), ("A\nsecond line\n", Sel::caret(4)), "no flash, no caret jump");
            assert_eq!(app.save_status(), None);
            assert_eq!(app.remote.as_ref().unwrap().mux.is_some(), v2);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Without a cache, an offline launch is the offline page as before.
    #[test]
    fn an_offline_launch_without_a_cache_shows_the_offline_page() {
        let dir = disk_dir("miss");
        let (mut app, m, mut tx) = app(&[("a.md", "A\n")], true);
        app.note_cache.disk = crate::diskcache::DiskCache::new(Some(dir.clone()));
        m.borrow_mut().fail = Some(crate::remote::ApiError::Network("can't reach g.example:443".into()));
        open(&mut app, &mut tx, "team", Some("a.md"));
        assert!(!app.remote.as_ref().unwrap().cached);
        assert_eq!(app.problem_page().map(|p| p.0).as_deref(), Some("Can't reach g.example"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Accounts and workspaces (docs/app.md): signing in from a guest keeps the guest's workspaces there; the
    /// same account again keeps everything; another account first signs the previous one out completely (token,
    /// socket, workspaces, cached notes) and starts with only its own; signing out does the same. Local folders
    /// never change.
    #[test]
    fn accounts_never_mix_workspaces_and_local_folders_stay() {
        use crate::remote::Connected;
        use crate::workspaces::WsRef;
        let dir = disk_dir("accounts");
        std::fs::create_dir_all(dir.join("local")).unwrap();
        let (mut app, m, mut tx) = app(&[("a.md", "A\n"), ("b.md", "B\n")], true);
        app.tokens = crate::workspaces::Tokens::File(dir.join("tokens.json"));
        app.note_cache.disk = crate::diskcache::DiskCache::new(Some(dir.join("cache")));
        let server = "https://g.example";
        let local = WsRef::Local { path: dir.join("local") };
        app.store.touch(&local, None);
        let remotes = |app: &App| app.store.recent.iter().filter_map(|(r, _)| if let WsRef::Remote { id, .. } = r { Some(id.clone()) } else { None }).collect::<Vec<_>>();
        let has_local = |app: &App| app.store.recent.iter().any(|(r, _)| r.same(&local));
        let who = |token: &str, name: &str, email: &str| Connected { name: "G".into(), token: token.into(), token_id: Some(format!("id-{token}")), account: Some(name.into()), email: Some(email.into()) };
        // a guest with a workspace open there
        m.borrow_mut().guest = true;
        open(&mut app, &mut tx, "team", Some("a.md"));
        assert!(app.is_guest() && remotes(&app) == ["team"]);
        // signs in as Ann: the guest's workspace stays (and is open, signed in)
        m.borrow_mut().guest = false;
        app.connected(app.switcher.connect_gen, server, Ok(who("t_ann", "Ann", "ann@example.com")), &mut tx);
        assert!(!app.is_guest() && remotes(&app) == ["team"] && has_local(&app));
        assert_eq!(app.tokens.get(server).as_deref(), Some("t_ann"));
        // Ann again (Reconnect): nothing goes
        app.connected(app.switcher.connect_gen, server, Ok(who("t_ann2", "Ann", "ANN@example.com")), &mut tx);
        assert!(remotes(&app) == ["team"] && app.remote.is_some());
        assert_eq!(app.tokens.get(server).as_deref(), Some("t_ann2"));
        assert!(app.note_cache.disk.note(server, "team", "a.md").is_some(), "Ann's note cached");
        let team = crate::remote::virtual_root(server, "team");
        app.store.set_folder(&team.join("sub"), Some(true));
        app.store.set_folder(&dir.join("local/sub"), Some(true));
        // Bob: Ann's token, socket, workspaces and cached notes go first; the local folder opens meanwhile
        app.connected(app.switcher.connect_gen, server, Ok(who("t_bob", "Bob", "bob@example.com")), &mut tx);
        assert_eq!(app.tokens.get(server).as_deref(), Some("t_bob"));
        assert!(remotes(&app).is_empty(), "{:?}", remotes(&app));
        assert!(!app.store.folders.iter().any(|(p, _)| p.contains(".grimoire-remote")), "{:?}", app.store.folders);
        assert!(app.remote.is_none() && m.borrow().sockets_open == 0);
        assert!(matches!(&app.current, Some(WsRef::Local { .. })), "{:?}", app.current);
        assert!(app.note_cache.disk.note(server, "team", "a.md").is_none() && app.note_cache.disk.tree(server, "team").is_none());
        assert!(app.store.folder_open(&dir.join("local/sub")) == Some(true), "the local folder's state stays");
        assert_eq!(app.store.server(server).and_then(|s| s.email.clone()).as_deref(), Some("bob@example.com"));
        assert_eq!(app.switcher.open_first.as_deref(), Some(server), "Bob's first workspace opens when his list arrives");
        // Bob opens a workspace, then signs out: it goes, the local folder stays and opens
        open(&mut app, &mut tx, "team", Some("b.md"));
        assert!(remotes(&app) == ["team"] && has_local(&app));
        app.disconnect(server, &mut tx);
        assert!(remotes(&app).is_empty() && app.tokens.get(server).is_none() && app.store.server(server).is_none());
        assert!(app.remote.is_none() && m.borrow().sockets_open == 0 && app.note_cache.disk.tree(server, "team").is_none());
        assert!(has_local(&app) && matches!(&app.current, Some(WsRef::Local { .. })), "{:?}", app.current);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cache follows the server: updates received, renames and deletes; removing a workspace from the list and
    /// signing out of a server remove theirs.
    #[test]
    fn the_disk_cache_follows_updates_renames_deletes_and_forgets() {
        let dir = disk_dir("follow");
        let (mut app, m, mut tx) = app(&[("a.md", "A\n"), ("b.md", "B\n")], true);
        app.note_cache.disk = crate::diskcache::DiskCache::new(Some(dir.clone()));
        let disk = |app: &App, p: &str| app.note_cache.disk.note("https://g.example", "team", p).map(|n| n.0);
        open(&mut app, &mut tx, "team", Some("a.md"));
        assert_eq!(disk(&app, "a.md").as_deref(), Some("A\n"), "on sync");
        // someone's edit: cached (debounced; at once without a network)
        let ada = m.borrow_mut().add_peer("a.md", 9, "Ada", "#d6409f");
        m.borrow_mut().peer(ada, |ed| {
            ed.editor_mut().set_selection(Sel::caret(0));
            ed.editor_mut().insert_text("Ada ");
        });
        app.pump_mock();
        app.handled(&mut tx);
        assert_eq!(disk(&app, "a.md").as_deref(), Some("Ada A\n"), "on an update");
        // ours too
        app.ed.set_selection(Sel::caret(0));
        app.ed.insert_text("1 ");
        app.handled(&mut tx);
        assert_eq!(disk(&app, "a.md").as_deref(), Some("1 Ada A\n"));
        // renamed: the text goes with it
        app.remote_rename("a.md".into(), "c.md".into(), &mut tx);
        app.pump_mock();
        app.handled(&mut tx);
        assert_eq!((disk(&app, "a.md"), disk(&app, "c.md").as_deref()), (None, Some("1 Ada A\n")));
        assert!(app.note_cache.disk.tree("https://g.example", "team").unwrap().contains(&"c.md".to_string()));
        // deleted: gone
        app.remote_delete_path("c.md".into(), false, &mut tx);
        app.handled(&mut tx);
        assert_eq!(disk(&app, "c.md"), None);
        assert!(!app.note_cache.disk.tree("https://g.example", "team").unwrap().contains(&"c.md".to_string()));
        // removed from the list
        let w = app.current.clone().unwrap();
        app.remove_recent(&w, &mut tx);
        assert_eq!(app.note_cache.disk.tree("https://g.example", "team"), None);
        // signed out of the server: all of it
        open(&mut app, &mut tx, "team", Some("b.md"));
        assert!(disk(&app, "b.md").is_some());
        app.disconnect("https://g.example", &mut tx);
        assert_eq!((disk(&app, "b.md"), app.note_cache.disk.tree("https://g.example", "team")), (None, None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cap: 3 s after launch the app shows with what's ready — an empty, quiet tree and the thin bar, not
    /// "Loading…" — rather than the launch screen for ever. "Connecting…" waits 3 s while the note's text shows (its
    /// cached copy), 300 ms with nothing on screen.
    #[test]
    fn the_cap_shows_quiet_placeholders_and_connecting_waits_while_text_shows() {
        use crate::boot::{Gate, Phase};
        use std::time::{Duration, Instant};
        let (mut app, _m, mut tx) = self::app(&[("a.md", "A\n")], true);
        app.backend = Backend::None;
        app.close_gate(true);
        open(&mut app, &mut tx, "team", Some("a.md"));
        assert_eq!(app.phase(), Phase::Launch, "nothing ready: the launch screen");
        app.gate = Gate::Launch(Instant::now() - Duration::from_secs(4));
        app.handled(&mut tx);
        assert_eq!(app.phase(), Phase::Complete, "past the cap");
        assert_eq!(app.tree_note(), None, "an empty tree, not Loading…");
        assert!(app.note_pending(), "the thin bar in the note area");

        let (mut app, m, mut tx) = self::app(&[("a.md", "A\n"), ("b.md", "B\n"), ("c.md", "C\n")], false);
        open(&mut app, &mut tx, "team", Some("a.md"));
        go(&mut app, &mut tx, "b.md");
        m.borrow_mut().hold = true;
        // a's cached text shows while its room connects
        go(&mut app, &mut tx, "a.md");
        assert_eq!(app.ed.text(), "A\n");
        let now = app.now_ms();
        app.remote.as_mut().unwrap().opened_at = now - 1_000.0;
        assert_eq!(app.save_status(), None, "text shows: no Connecting… before 3 s");
        assert!(!app.note_pending());
        app.remote.as_mut().unwrap().opened_at = now - 3_100.0;
        assert_eq!(app.save_status().map(|s| s.0).as_deref(), Some("Connecting…"));
        // c never seen: nothing to show, so after 300 ms
        go(&mut app, &mut tx, "c.md");
        assert!(app.ed.text().is_empty() && app.note_pending());
        let now = app.now_ms();
        app.remote.as_mut().unwrap().opened_at = now - 400.0;
        assert_eq!(app.save_status().map(|s| s.0).as_deref(), Some("Connecting…"));
    }

    /// Production (https://grimnotes.app, Cloudflare; `GRIMOIRE_PROD` for another), read-only plus the demo: the
    /// demo opened by its URL in two phases on one v2 socket, note switches timed, an edit that lands on the server
    /// (then taken out again), and an offline relaunch reading the demo from the disk cache, read-only, until the
    /// network is back. `cargo test --release -p grimoire against_production -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn against_production() {
        use crate::boot::Phase;
        use std::time::{Duration, Instant};
        let _one = BUN_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let base = crate::wsock::live();
        let server = std::env::var("GRIMOIRE_PROD").unwrap_or_else(|_| "https://grimnotes.app".into());
        let r = crate::workspaces::parse_remote_url(&format!("{server}/app/demo")).expect("the demo's URL");
        let dir = std::env::temp_dir().join(format!("grimoire-prod-{}", std::process::id()));
        let (mut app, urx) = net_app(&dir.join("support"));
        app.note_cache.disk = crate::diskcache::DiskCache::new(Some(dir.join("cache")));
        let mut tx = Tx::default();
        let until = |app: &mut App, tx: &mut Tx, what: &str, ok: &dyn Fn(&App) -> bool| -> Duration {
            let t = Instant::now();
            while !ok(app) {
                let left = Duration::from_secs(20).checked_sub(t.elapsed()).unwrap_or_else(|| panic!("timed out: {what}"));
                let f = urx.recv_timeout(left).unwrap_or_else(|_| panic!("timed out: {what}"));
                f(app, tx);
            }
            t.elapsed()
        };
        let settle = |app: &mut App, tx: &mut Tx, ms: u64| {
            let quiet = Instant::now() + Duration::from_millis(ms);
            while let Ok(f) = urx.recv_timeout(quiet.saturating_duration_since(Instant::now())) {
                f(app, tx);
            }
        };
        let live_any = |a: &App| a.remote.as_ref().is_some_and(|r| r.synced && r.note.is_some()) && a.staged.is_none() && a.ed.collab().is_some();

        // launch on the demo's URL: launch screen, then the complete view
        app.close_gate(true);
        let t = Instant::now();
        app.open_remote(r.server.clone(), r.id.clone(), String::new(), r.note.clone(), &mut tx);
        let mut phases = vec![app.phase()];
        until(&mut app, &mut tx, "loaded", &|a| a.remote.as_ref().is_some_and(|r| r.loaded));
        let loaded = t.elapsed();
        until(&mut app, &mut tx, "the first view", &|a| a.phase() == Phase::Complete);
        let shown = t.elapsed();
        phases.push(app.phase());
        until(&mut app, &mut tx, "live", &live_any);
        println!(
            "PROD first launch (no cache) → workspace loaded {:.0} ms, complete view {:.0} ms, live {:.0} ms ({:?}); v2 {}",
            loaded.as_secs_f64() * 1000.0,
            shown.as_secs_f64() * 1000.0,
            t.elapsed().as_secs_f64() * 1000.0,
            phases,
            app.v2()
        );
        assert_eq!(phases, [Phase::Launch, Phase::Complete]);
        assert!(app.v2(), "production speaks v2");
        assert!(!app.files.is_empty() && !app.ed.text().is_empty());
        settle(&mut app, &mut tx, 500);
        assert_eq!(crate::wsock::live().0, 1, "one socket");

        // note switches: each note once (cold or prefetched), back and forth, down the tree
        let notes: Vec<String> = app.remote.as_ref().unwrap().tree_list.clone();
        let mut times: Vec<(&str, f64, bool)> = Vec::new();
        let mut click = |app: &mut App, tx: &mut Tx, kind: &'static str, rel: &str| {
            let warm = hidden(app).iter().any(|h| h.0 == rel && h.1);
            let t = Instant::now();
            go(app, tx, rel);
            until(app, tx, rel, &|a| live_any(a) && a.remote.as_ref().unwrap().note.as_deref() == Some(rel));
            times.push((kind, t.elapsed().as_secs_f64() * 1000.0, warm));
            settle(app, tx, 400);
        };
        for n in notes.iter().step_by(2) {
            click(&mut app, &mut tx, "cold", n);
        }
        let (a, b) = (notes[0].clone(), notes[2.min(notes.len() - 1)].clone());
        for _ in 0..3 {
            click(&mut app, &mut tx, "previous", &a);
            click(&mut app, &mut tx, "previous", &b);
        }
        for n in &notes {
            click(&mut app, &mut tx, "next", n);
        }
        for kind in ["cold", "previous", "next"] {
            let mut v: Vec<f64> = times.iter().filter(|t| t.0 == kind).map(|t| t.1).collect();
            let warm = times.iter().filter(|t| t.0 == kind && t.2).count();
            let n = v.len();
            println!("PROD switch {kind:8} n={n:2} warm={warm:2}  live p50 {:6.1} p95 {:6.1} max {:6.1} ms", pct(&mut v, 0.5), pct(&mut v, 0.95), pct(&mut v, 1.0));
        }
        assert_eq!((crate::wsock::live().0, crate::wsock::live().1 - base.1), (1, 1), "one socket for every switch");

        // an edit lands on the server (the demo is in memory, for everyone), then goes again
        let target = "Welcome.md";
        go(&mut app, &mut tx, target);
        until(&mut app, &mut tx, "Welcome live", &|a| live_any(a) && a.remote.as_ref().unwrap().note.as_deref() == Some(target));
        // earlier runs' marks out first
        while let Some(at) = app.ed.text().find("\nnative cf-37 check ") {
            let stop = app.ed.text()[at + 1..].find('\n').map_or(app.ed.text().len(), |i| at + 1 + i);
            app.ed.set_selection(Sel::new(at, stop));
            app.ed.delete_backward();
            app.handled(&mut tx);
        }
        settle(&mut app, &mut tx, 300);
        let mark = format!("\nnative cf-37 check {}\n", std::process::id());
        let end = app.ed.text().len();
        app.ed.set_selection(Sel::caret(end));
        app.ed.insert_text(&mark);
        app.handled(&mut tx);
        let api = app.remote.as_ref().unwrap().api.clone();
        let t = Instant::now();
        let landed = loop {
            settle(&mut app, &mut tx, 150);
            let text = api.file("demo", target).unwrap_or_default();
            if text.contains(mark.trim()) || t.elapsed() > Duration::from_secs(10) {
                break text.contains(mark.trim());
            }
        };
        println!("PROD edit on the server after {:.0} ms (GET /api/repos/demo/file)", t.elapsed().as_secs_f64() * 1000.0);
        assert!(landed, "the edit reached the server");
        let text = app.ed.text().to_string();
        let at = text.find(&mark).unwrap();
        app.ed.set_selection(Sel::new(at, at + mark.len()));
        app.ed.delete_backward();
        app.handled(&mut tx);
        let t = Instant::now();
        let gone = loop {
            settle(&mut app, &mut tx, 150);
            if !api.file("demo", target).unwrap_or_default().contains("native cf-37 check") || t.elapsed() > Duration::from_secs(10) {
                break !api.file("demo", target).unwrap_or_default().contains("native cf-37 check");
            }
        };
        assert!(gone, "taken out again");
        app.leave_workspace();
        app.flush_disk();
        drop(app);

        // relaunch online with the disk cache: its tree and text are the first view; the socket starts with the load
        let (mut app, urx3) = net_app(&dir.join("support3"));
        app.note_cache.disk = crate::diskcache::DiskCache::new(Some(dir.join("cache")));
        app.close_gate(true);
        let t = Instant::now();
        app.open_remote(r.server.clone(), r.id.clone(), String::new(), Some(target.into()), &mut tx);
        let early = app.v2();
        let mut shown = (app.phase() == Phase::Complete).then(|| t.elapsed());
        while !live_any(&app) {
            let f = urx3.recv_timeout(Duration::from_secs(20)).expect("live after a relaunch");
            f(&mut app, &mut tx);
            if shown.is_none() && app.phase() == Phase::Complete {
                shown = Some(t.elapsed());
            }
        }
        println!(
            "PROD relaunch (cache, socket early {early}) → complete view {:.0} ms, live {:.0} ms",
            shown.unwrap_or_default().as_secs_f64() * 1000.0,
            t.elapsed().as_secs_f64() * 1000.0
        );
        assert!(early, "the socket started with the load");
        app.leave_workspace();
        app.flush_disk();
        drop(app);

        // relaunch offline: the demo from the disk cache, read-only; the network back → live and editable
        crate::net::OFFLINE.store(true, std::sync::atomic::Ordering::SeqCst);
        let (mut app, urx2) = net_app(&dir.join("support2"));
        app.note_cache.disk = crate::diskcache::DiskCache::new(Some(dir.join("cache")));
        app.close_gate(true);
        let t = Instant::now();
        app.open_remote(r.server.clone(), r.id.clone(), String::new(), Some(target.into()), &mut tx);
        let shown = (app.phase() == Phase::Complete).then(|| t.elapsed());
        // the load fails (offline): the cached view says so
        while !matches!(app.remote.as_ref().unwrap().problem, Some(Problem::Offline { .. })) {
            let f = urx2.recv_timeout(Duration::from_secs(10)).expect("the offline view");
            f(&mut app, &mut tx);
        }
        println!("PROD offline relaunch: cached view shown at {:.1} ms (complete in the launch frame: {})", shown.unwrap_or_default().as_secs_f64() * 1000.0, shown.is_some());
        let rem = app.remote.as_ref().unwrap();
        println!("PROD offline relaunch → cached view {:.1} ms: cached {} read-only {} status {:?} tree {}", t.elapsed().as_secs_f64() * 1000.0, rem.cached, app.ed.is_read_only(), app.save_status(), app.files.len());
        assert!(rem.cached && app.ed.is_read_only() && app.ed.text().len() > 10);
        assert_eq!(app.save_status().map(|s| s.0).as_deref(), Some("Offline: read-only"));
        crate::net::OFFLINE.store(false, std::sync::atomic::Ordering::SeqCst);
        let (s, attempt) = match &app.remote.as_ref().unwrap().problem {
            Some(Problem::Offline { attempt, .. }) => (app.remote.as_ref().unwrap().session, *attempt),
            p => panic!("{p:?}"),
        };
        app.retry_load(s, Some(attempt), &mut tx);
        let t = Instant::now();
        while !live_any(&app) || app.ed.is_read_only() {
            let f = urx2.recv_timeout(Duration::from_secs(10)).expect("live again");
            f(&mut app, &mut tx);
        }
        println!("PROD back online → live and editable in {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
        app.leave_workspace();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The tree's Delete key in a remote workspace: the remote confirm ("stays in the Git history"), Return deletes
    /// on the server, the next row has the focus and the next note opens; read-only: nothing.
    #[test]
    fn the_delete_key_deletes_remote_notes_and_does_nothing_read_only() {
        let (mut app, m, mut tx) = app(&[("a.md", "A\n"), ("b.md", "B\n"), ("c.md", "C\n")], true);
        open(&mut app, &mut tx, "team", Some("b.md"));
        let root = app.root.clone().unwrap();
        app.focus_tree();
        app.tree_cur = Some(root.join("b.md"));
        let key = |k: rune::Key| rune::KeyEvent { key: k, mods: rune::Mods::default() };
        crate::input::on_key(&mut app, &key(rune::Key::Backspace), &mut tx);
        let Some(crate::dialogs::Dialog::Confirm(c)) = &app.dialog else { panic!("the confirm") };
        assert_eq!(c.message, "Delete “b.md”? It stays in the Git history.");
        crate::input::on_key(&mut app, &key(rune::Key::Enter), &mut tx);
        app.pump_mock();
        app.handled(&mut tx);
        assert!(!m.borrow().tree.contains(&"b.md".to_string()), "deleted on the server");
        assert_eq!(app.tree_cur, Some(root.join("c.md")), "the next row");
        assert_eq!(app.remote.as_ref().unwrap().note.as_deref(), Some("c.md"), "the next note opens");
        // read-only: no confirm
        app.remote.as_mut().unwrap().read_only = true;
        app.tree_focus = true;
        crate::input::on_key(&mut app, &key(rune::Key::Delete), &mut tx);
        assert!(app.dialog.is_none());
    }

    /// Guests read and edit notes, but outside workspaces open to guests creating, renaming, deleting and adding
    /// images ask them to sign in (the web's lines), with nothing sent; an untitled note isn't renamed after its
    /// heading; the demo (`guestCreate`) is open. After connecting, what they tried happens.
    #[test]
    fn guests_are_asked_to_sign_in_and_their_action_runs_after() {
        use crate::dialogs::{ConfirmKind, Dialog, GuestAction};
        let dir = disk_dir("guest");
        let (mut app, m, mut tx) = app(&[("a.md", "A\n"), ("sub/b.md", "B\n"), ("Untitled.md", "")], true);
        std::fs::create_dir_all(&dir).unwrap();
        app.tokens = crate::workspaces::Tokens::File(dir.join("tokens.json"));
        m.borrow_mut().guest = true;
        open(&mut app, &mut tx, "team", Some("a.md"));
        assert!(app.is_guest() && app.guest_limited());
        let prompt = |app: &App| match &app.dialog {
            Some(Dialog::Confirm(c)) => match &c.kind {
                ConfirmKind::SignIn { action, .. } => Some((c.title.clone(), c.message.clone(), c.confirm.clone(), c.cancel.clone(), action.clone())),
                _ => None,
            },
            _ => None,
        };
        let tree = |m: &crate::remote::MockRef| m.borrow().tree.clone();
        let before = tree(&m);
        app.new_note(&mut tx);
        assert_eq!(prompt(&app), Some(("Sign in".into(), "Sign in to create notes and folders. It's free.".into(), "Sign in".into(), "Close".into(), GuestAction::NewNote(Some("a.md".into())))));
        app.dialog = None;
        app.new_folder(&mut tx);
        assert_eq!(prompt(&app).map(|p| p.1), Some("Sign in to create notes and folders. It's free.".into()));
        app.dialog = None;
        app.start_rename("a.md");
        assert_eq!(prompt(&app).map(|p| p.4), Some(GuestAction::Rename("a.md".into())));
        assert!(app.renaming.is_none(), "no rename field");
        app.dialog = None;
        // the Delete key on a row, as the row menu's Delete
        app.focus_tree();
        app.tree_cur = Some(app.root.clone().unwrap().join("a.md"));
        crate::input::on_key(&mut app, &rune::KeyEvent { key: rune::Key::Backspace, mods: rune::Mods::default() }, &mut tx);
        assert_eq!(prompt(&app).map(|p| (p.1, p.4)), Some(("Sign in to delete notes and folders. It's free.".into(), GuestAction::Delete("a.md".into()))));
        app.dialog = None;
        app.tree_focus = false;
        app.add_images(vec![crate::uploads::NewImage::Png { name: "x.png".into(), bytes: vec![0u8; 4] }], 0, 0, &mut tx);
        assert_eq!(prompt(&app).map(|p| p.1), Some("Sign in to add images. It's free.".into()));
        app.dialog = None;
        assert_eq!(tree(&m), before, "nothing was sent");
        assert!(m.borrow().uploads.is_empty());
        // editing stays open
        assert!(!app.ed.is_read_only());
        app.ed.set_selection(Sel::caret(1));
        app.ed.insert_text("!");
        app.handled(&mut tx);
        assert_eq!(m.borrow().text("a.md").unwrap(), "A!\n");
        // an untitled note keeps its name
        go(&mut app, &mut tx, "Untitled.md");
        app.ed.insert_text("# Trip\n");
        app.handled(&mut tx);
        app.auto_name(&mut tx);
        assert!(tree(&m).contains(&"Untitled.md".to_string()) && app.dialog.is_none(), "not renamed, not asked");
        // the server's 401s say the same
        app.remote_created(0, "sub/x.md".into(), None, Err(crate::remote::ApiError::Unauthorized), &mut tx);
        assert_eq!(prompt(&app).map(|p| p.4), Some(GuestAction::NewNote(Some("sub".into()))));
        app.dialog = None;
        app.remote_renamed(0, "a.md".into(), "c.md".into(), false, Err(crate::remote::ApiError::Unauthorized), &mut tx);
        assert_eq!(prompt(&app).map(|p| p.4), Some(GuestAction::Rename("a.md".into())));
        app.dialog = None;
        app.remote_deleted(0, "sub".into(), true, Err(crate::remote::ApiError::Unauthorized), &mut tx);
        assert_eq!(prompt(&app).map(|p| p.4), Some(GuestAction::Delete("sub".into())));
        app.dialog = None;
        // the demo: open to guests
        app.remote.as_mut().unwrap().repo = json!({ "guestCreate": true });
        assert!(!app.guest_limited());
        app.start_rename("a.md");
        assert!(app.dialog.is_none() && app.renaming.is_some());
        app.renaming = None;
        app.remote.as_mut().unwrap().repo = serde_json::Value::Null;
        // Sign in from New note in sub: the connect flow (the browser's /connect), then the note is made there
        app.tree_cur = Some(app.root.clone().unwrap().join("sub/b.md"));
        app.new_note(&mut tx);
        crate::actions::confirm(&mut app, &mut tx);
        assert_eq!(app.after_sign_in.as_ref().map(|a| a.1.clone()), Some(GuestAction::NewNote(Some("sub/b.md".into()))));
        m.borrow_mut().guest = false;
        let gen_ = app.switcher.connect_gen;
        let c = crate::remote::Connected { name: "Grimoire".into(), token: "t_new".into(), token_id: None, account: Some("Me".into()), email: None };
        app.connected(gen_, "https://g.example", Ok(c), &mut tx);
        assert!(!app.is_guest() && app.after_sign_in.is_none());
        assert!(tree(&m).iter().any(|p| p.starts_with("sub/Untitled")), "made after signing in: {:?}", tree(&m));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Production, read-only: the demo is open to guests (`guestCreate`). `cargo test --release -p grimoire guest_limits_on_production -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn guest_limits_on_production() {
        let server = std::env::var("GRIMOIRE_PROD").unwrap_or_else(|_| "https://grimnotes.app".into());
        let g = crate::workspaces::Guest { id: format!("native{}", std::process::id()), name: "native-check".into(), color: "#296d9a".into() };
        let api = crate::remote::Api { guest: Some(g), ..crate::remote::Api::new(server, None) };
        assert_eq!(api.repo("demo").unwrap()["guestCreate"], true);
        // (a guest's 401 "Sign in to …" needs a real workspace other than the demo; none is public without making one)
        println!("PROD guest: demo guestCreate true");
    }

    fn live(app: &App, rel: &str) -> bool {
        app.remote.as_ref().is_some_and(|r| r.synced && r.note.as_deref() == Some(rel)) && app.staged.is_none() && app.ed.collab().is_some() && app.ed.text().starts_with("# ")
    }

    fn pct(v: &mut [f64], p: f64) -> f64 {
        v.sort_by(f64::total_cmp);
        v[((v.len() - 1) as f64 * p).round() as usize]
    }

    /// Note switches against grim's own Bun server (`native-bench.mjs` in a grim checkout, `GRIM`, default
    /// /tmp/grim-main; `RTT_MS` adds a delaying proxy; `GRIMOIRE_WS=1` for the v1 client): click → the note's text
    /// visible and click → live and editable, p50/p95/max per kind (cold: never shown; previous: back and forth;
    /// next: down the tree), and how many clicks were warm. Then the owner's rule on the real server: one socket,
    /// for the selected workspace only. `cargo test --release -p grimoire switch_time -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn switch_time_against_bun() {
        use std::time::{Duration, Instant};
        let _one = BUN_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let base = crate::wsock::live();

        use crate::wsock;

        let (_server, server, bench, second) = bun();
        let v2 = std::env::var("GRIMOIRE_WS").as_deref() != Ok("1");

        let dir = std::env::temp_dir().join(format!("grimoire-switch-time-{}", std::process::id()));
        let (mut app, urx) = net_app(&dir);
        let mut tx = Tx::default();
        // run what the threads send until `ok`, blocking on the channel
        let until = |app: &mut App, tx: &mut Tx, what: &str, ok: &dyn Fn(&App) -> bool| -> Duration {
            let t = Instant::now();
            while !ok(app) {
                let left = Duration::from_secs(15).checked_sub(t.elapsed()).unwrap_or_else(|| panic!("timed out: {what}"));
                let f = urx.recv_timeout(left).unwrap_or_else(|_| panic!("timed out: {what}"));
                f(app, tx);
            }
            t.elapsed()
        };

        let t = Instant::now();
        app.open_remote(server.clone(), bench.clone(), String::new(), Some("N01.md".into()), &mut tx);
        until(&mut app, &mut tx, "N01 live", &|a| live(a, "N01.md"));
        println!("FIRST workspace open → N01 live: {:.1} ms (v2 {})", t.elapsed().as_secs_f64() * 1000.0, app.v2());
        assert_eq!(app.v2(), v2);
        // let the neighbour prefetch land, as a reader would in the second after a click
        let settle = |app: &mut App, tx: &mut Tx| {
            let quiet = Instant::now() + Duration::from_millis(300);
            while let Ok(f) = urx.recv_timeout(quiet.saturating_duration_since(Instant::now())) {
                f(app, tx);
            }
        };
        settle(&mut app, &mut tx);

        let mut results: Vec<(&str, f64, f64, bool)> = Vec::new();
        let mut click = |app: &mut App, tx: &mut Tx, kind: &'static str, n: u32| {
            let rel = format!("N{n:02}.md");
            let warm = hidden(app).iter().any(|h| h.0 == rel && h.1);
            let want = format!("# Note {n:02}");
            let t = Instant::now();
            go(app, tx, &rel);
            let shown = until(app, tx, "visible", &|a| a.ed.text().starts_with(&want));
            let editable = until(app, tx, "live", &|a| live(a, &rel));
            let _ = shown;
            results.push((kind, shown.as_secs_f64() * 1000.0, (t.elapsed()).as_secs_f64() * 1000.0, warm));
            assert!(editable <= t.elapsed());
            settle(app, tx);
        };
        for n in [3, 5, 7] {
            click(&mut app, &mut tx, "cold", n);
        }
        for _ in 0..3 {
            for n in [5, 7, 5, 7] {
                click(&mut app, &mut tx, "previous", n);
            }
            for n in 1..=8 {
                click(&mut app, &mut tx, "next", n);
            }
        }
        for kind in ["cold", "previous", "next"] {
            let r: Vec<_> = results.iter().filter(|r| r.0 == kind).collect();
            let mut vis: Vec<f64> = r.iter().map(|r| r.1).collect();
            let mut ed: Vec<f64> = r.iter().map(|r| r.2).collect();
            let warm = r.iter().filter(|r| r.3).count();
            println!(
                "SWITCH {kind:8} n={:2} warm={warm:2}  visible p50 {:6.1} p95 {:6.1}  live p50 {:6.1} p95 {:6.1} max {:6.1} ms",
                r.len(),
                pct(&mut vis, 0.5),
                pct(&mut vis, 0.95),
                pct(&mut ed, 0.5),
                pct(&mut ed, 0.95),
                pct(&mut ed, 1.0)
            );
        }
        let (now, all) = wsock::live();
        let all = all - base.1;
        println!("SOCKETS after {} clicks: {now} open, {all} opened in all", results.len());

        // the owner's rule, on the real server
        if v2 {
            assert_eq!((now, all), (1, 1), "one socket for all the switches");
            app.open_remote(server.clone(), second.clone(), String::new(), Some("Other.md".into()), &mut tx);
            until(&mut app, &mut tx, "Other live", &|a| live(a, "Other.md"));
            assert_eq!(wsock::wait_live(|l| l.0 == 1 && l.1 - base.1 == 2, Duration::from_secs(5)), (1, base.1 + 2), "the first workspace's socket closed");
            app.open_local(dir.clone(), &mut tx);
            assert_eq!(wsock::wait_live(|l| l.0 == 0, Duration::from_secs(5)).0, 0, "a local workspace has none");
            let w = app.store.recent.iter().find(|r| matches!(&r.0, crate::workspaces::WsRef::Remote { id, .. } if *id == bench)).unwrap().0.clone();
            app.choose(w, &mut tx);
            until(&mut app, &mut tx, "back", &|a| a.remote.as_ref().is_some_and(|r| r.synced));
            assert_eq!(wsock::wait_live(|l| l.0 == 1, Duration::from_secs(5)), (1, base.1 + 3));
            println!("SOCKETS rule ok: bench → second → local → bench = 1, 1, 0, 1 open (3 opened)");
        }
        app.leave_workspace();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
