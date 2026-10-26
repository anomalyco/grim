//! The editor engine on a shared document: `CollabStore` (editor-core's `TextStore` over a yrs `Text`) and
//! `CollabEditor`, which owns an `Editor<CollabStore>` and the protocol `Session` and does what the web
//! client's provider.ts + view.ts do around Yjs: applies remote edits to the editor, sends local edits,
//! publishes the local cursor while focused, resolves remote cursors, reconnects and resets.
//!
//! Undo is editor-core's own `History` (remote edits rebase it); its undo/redo are ordinary local edits,
//! so they reach yrs through `CollabStore::replace` like typing. yrs's UndoManager isn't used.
//!
//! Sans-IO: the shell owns the socket and the timers. After every editor command call
//! `take_outgoing`; feed every frame from the server to `receive` and send what it returns.

use std::cell::Ref;
use std::ops::Range;

use editor_core::text::{byte_to_utf16, utf16_to_byte};
use editor_core::{Editor, TextStore};
use serde_json::Value;

use crate::protocol::{Event, Session, SharedStore};
use crate::store::{Change, Edit, YrsStore};

/// editor-core's text store over the shared yrs text. Keeps a plain `String` copy (what the editor sees,
/// byte offsets); local changes go into yrs (origin local → sent), remote ones only update the copy.
pub struct CollabStore {
    yrs: SharedStore,
    mirror: String,
}

impl CollabStore {
    pub fn new(yrs: SharedStore) -> Self {
        let mirror = yrs.borrow().text();
        CollabStore { yrs, mirror }
    }

    pub fn yrs(&self) -> Ref<'_, YrsStore> {
        self.yrs.borrow()
    }
}

impl std::fmt::Debug for CollabStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CollabStore").field("mirror", &self.mirror).finish()
    }
}

impl TextStore for CollabStore {
    fn text(&self) -> &str {
        &self.mirror
    }

    fn replace(&mut self, range: Range<usize>, s: &str) {
        let a = byte_to_utf16(&self.mirror, range.start) as u32;
        let b = byte_to_utf16(&self.mirror, range.end) as u32;
        self.yrs.borrow_mut().replace(a, b, s);
        self.mirror.replace_range(range, s);
    }

    fn replace_remote(&mut self, range: Range<usize>, s: &str) {
        // yrs has it already
        self.mirror.replace_range(range, s);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnStatus {
    Connecting,
    Connected,
    Disconnected,
}

/// Something the app shell shows or acts on (provider.ts events).
#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    /// The room answered; `msg` holds the save state (`dirty`, `saving`, `commit`, `savedAt`).
    Hello { read_only: bool, msg: Value },
    /// The initial state arrived (provider.ts `synced`, once): the editor now shows the note.
    Synced,
    /// The connection became read-only or writable (the editor follows).
    ReadOnly(bool),
    /// Save state changed (`status`).
    SaveState(Value),
    /// The file changed outside (`external`, the new commit).
    External(Option<String>),
    /// The room was recreated or read-only would drop offline edits: close the socket, toast "This note was
    /// reloaded from the server.", call `reset(new_client_id)` and connect again.
    Reset,
}

/// What `receive` did.
#[derive(Debug, Default)]
pub struct Received {
    /// Frames to send now.
    pub outgoing: Vec<Vec<u8>>,
    /// Remote edits applied to the editor, sequential (each against the text left by the ones before), in
    /// bytes and in UTF-16. Empty when `reloaded`.
    pub edits: Vec<(Range<usize>, String)>,
    pub edits_utf16: Vec<Edit>,
    /// The editor was rebuilt (initial sync): render everything.
    pub reloaded: bool,
    /// Remote presence changed: redraw remote cursors / participants.
    pub awareness: bool,
    pub notices: Vec<Notice>,
}

/// What `take_outgoing` produced.
#[derive(Debug, Default)]
pub struct Outgoing {
    pub frames: Vec<Vec<u8>>,
    /// Call `take_outgoing` again after this many ms (a throttled cursor publish, the 15 s presence renewal,
    /// or a remote presence timeout is due).
    pub wake_in_ms: Option<f64>,
    /// Remote presence timed out: redraw remote cursors / participants.
    pub awareness: bool,
}

/// After the socket closed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AfterClose {
    /// Reconnect after `delay_ms` (or right away when `online()` says so).
    Retry { delay_ms: u32 },
    /// The session ended (deleted, renamed (`to`), removed, unauthorized, forbidden, notfound, toolarge).
    Closed { reason: String, to: Option<String> },
}

/// A remote participant's caret/selection, ready to draw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerCursor {
    pub client: u64,
    pub user_id: String,
    /// "anonymous" when missing.
    pub name: String,
    /// A `#rgb…` color ("#888888" when missing or invalid).
    pub color: String,
    /// Byte offsets.
    pub anchor: usize,
    pub head: usize,
    pub anchor_utf16: u32,
    pub head_utf16: u32,
}

/// Cursor publish throttle (view.ts publishCursor): at most one publish per 50 ms, trailing.
const PUBLISH_MS: f64 = 50.0;
const BACKOFF_MIN: u32 = 500;
const BACKOFF_MAX: u32 = 10_000;

pub struct CollabEditor {
    editor: Editor<CollabStore>,
    session: Session,
    focused: bool,
    last_publish: Option<f64>,
    status: ConnStatus,
    backoff: u32,
    retry_pending: bool,
    closed: Option<(String, Option<String>)>,
    save_state: Value,
}

impl CollabEditor {
    /// A new, empty document (it fills on sync). `client_id` must be random per session and below 2^32 (in
    /// wasm: `crypto.getRandomValues`). `user` is our presence user `{id, name, color, kind}`.
    pub fn new(client_id: u32, user: Value) -> Self {
        let session = Session::new(YrsStore::without_undo(client_id), user);
        let editor = Editor::with_store(CollabStore::new(session.shared_store()));
        CollabEditor {
            editor,
            session,
            focused: false,
            last_publish: None,
            status: ConnStatus::Disconnected,
            backoff: BACKOFF_MIN,
            retry_pending: false,
            closed: None,
            save_state: Value::Null,
        }
    }

    /// Start over with a fresh document after `Notice::Reset` (the socket must be reconnected).
    pub fn reset(&mut self, client_id: u32) {
        let user = self.session.user().clone();
        let focused = self.focused;
        *self = CollabEditor::new(client_id, user);
        self.focused = focused;
    }

    pub fn editor(&self) -> &Editor<CollabStore> {
        &self.editor
    }

    /// Run editor commands here, then call `take_outgoing`. Don't call `apply_remote` on it (remote edits
    /// come in through `receive`).
    pub fn editor_mut(&mut self) -> &mut Editor<CollabStore> {
        &mut self.editor
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn client_id(&self) -> u64 {
        self.session.store().client_id()
    }

    pub fn status(&self) -> ConnStatus {
        self.status
    }

    pub fn synced(&self) -> bool {
        self.session.synced
    }

    pub fn read_only(&self) -> bool {
        self.session.read_only
    }

    /// The last save state from `hello` / `status` (`{dirty, saving, commit, savedAt}`), Null before.
    pub fn save_state(&self) -> &Value {
        &self.save_state
    }

    /// Whether the editor's text equals the shared document's (always, unless a remote edit split a
    /// surrogate pair).
    pub fn is_consistent(&self) -> bool {
        self.editor.text() == self.session.store().text()
    }

    // ---- connection lifecycle ----

    /// Opening a socket (status → connecting). Then wait for frames; nothing is sent before `hello`.
    pub fn connecting(&mut self) {
        self.status = ConnStatus::Connecting;
        self.retry_pending = false;
    }

    /// The socket closed with `code` / `reason`.
    pub fn disconnected(&mut self, code: u16, reason: &str) -> AfterClose {
        self.session.disconnected();
        self.status = ConnStatus::Disconnected;
        if code == 4000 || self.closed.is_some() {
            let (reason, to) =
                self.closed.clone().unwrap_or_else(|| (if reason.is_empty() { "removed" } else { reason }.to_string(), None));
            self.session.stopped = true;
            return AfterClose::Closed { reason, to };
        }
        let stop = match code {
            4401 => Some("unauthorized"),
            4403 => Some("forbidden"),
            4404 => Some("notfound"),
            4413 => Some("toolarge"),
            _ => None,
        };
        if let Some(stop) = stop {
            self.session.stopped = true;
            return AfterClose::Closed { reason: stop.to_string(), to: (!reason.is_empty()).then(|| reason.to_string()) };
        }
        let delay_ms = self.backoff;
        self.backoff = (self.backoff * 2).min(BACKOFF_MAX);
        self.retry_pending = true;
        AfterClose::Retry { delay_ms }
    }

    /// The browser went online: true when a retry is pending and the shell should reconnect now.
    pub fn online(&mut self) -> bool {
        if !self.retry_pending || self.session.stopped {
            return false;
        }
        self.backoff = BACKOFF_MIN;
        true
    }

    /// Ask the server to commit now.
    pub fn request_flush(&mut self) -> Vec<Vec<u8>> {
        self.session.request_flush();
        self.session.take_outgoing()
    }

    /// Announce that we leave (send before closing the socket).
    pub fn leave(&mut self) -> Vec<Vec<u8>> {
        self.session.leave();
        self.session.take_outgoing()
    }

    // ---- frames ----

    /// Feed one binary frame from the server.
    pub fn receive(&mut self, frame: &[u8]) -> Result<Received, String> {
        let mut out = Received::default();
        let events = self.session.receive(frame)?;
        for ev in events {
            match ev {
                Event::Changes(changes) => self.apply_changes(changes, &mut out),
                Event::Hello { read_only, msg, .. } => {
                    self.status = ConnStatus::Connected;
                    self.backoff = BACKOFF_MIN;
                    self.retry_pending = false;
                    if read_only != self.editor.is_read_only() {
                        self.editor.set_read_only(read_only);
                        out.notices.push(Notice::ReadOnly(read_only));
                    }
                    self.save_state = save_state(&msg);
                    out.notices.push(Notice::Hello { read_only, msg });
                }
                Event::Synced => {
                    // provider.ts mounts the editor only now: start fresh (caret at the start) unless the
                    // editor was used before the sync.
                    if !self.editor.can_undo() && !self.editor.can_redo() {
                        let ro = self.editor.is_read_only();
                        self.editor = Editor::with_store(CollabStore::new(self.session.shared_store()));
                        self.editor.set_read_only(ro);
                        out.reloaded = true;
                        out.edits.clear();
                        out.edits_utf16.clear();
                    }
                    out.notices.push(Notice::Synced);
                }
                Event::Awareness => out.awareness = true,
                Event::Reset => {
                    self.status = ConnStatus::Disconnected;
                    out.notices.push(Notice::Reset);
                }
                Event::Control(msg) => match msg["t"].as_str() {
                    Some("status") => {
                        self.save_state = save_state(&msg);
                        out.notices.push(Notice::SaveState(self.save_state.clone()));
                    }
                    Some("external") => out.notices.push(Notice::External(msg["commit"].as_str().map(str::to_string))),
                    Some("closed") => {
                        self.closed = Some((
                            msg["reason"].as_str().unwrap_or("removed").to_string(),
                            msg["to"].as_str().map(str::to_string),
                        ));
                    }
                    _ => {}
                },
            }
        }
        out.outgoing = self.session.take_outgoing();
        Ok(out)
    }

    fn apply_changes(&mut self, changes: Vec<Change>, out: &mut Received) {
        let mut scratch = self.editor.text().to_string();
        let mut edits = Vec::new();
        for c in changes {
            for e in c.edits {
                let a = utf16_to_byte(&scratch, e.from as usize);
                let b = utf16_to_byte(&scratch, e.to as usize).max(a);
                scratch.replace_range(a..b, &e.insert);
                edits.push((a..b, e.insert.clone()));
                out.edits_utf16.push(e);
            }
        }
        self.editor.apply_remote(&edits);
        out.edits.extend(edits);
    }

    /// Frames to send after local edits / selection changes (one merged update, the cursor while focused).
    /// `now_ms` is a monotonic clock (performance.now()).
    pub fn take_outgoing(&mut self, now_ms: f64) -> Outgoing {
        let mut wake_in_ms = None;
        let (awareness, wake) = self.session.tick(now_ms);
        if self.focused {
            let cur = self.sel_utf16();
            if self.session.cursor() != Some(cur) {
                match self.last_publish {
                    Some(t) if now_ms - t < PUBLISH_MS && now_ms >= t => wake_in_ms = Some(PUBLISH_MS - (now_ms - t)),
                    _ => {
                        self.session.set_cursor(Some(cur));
                        self.last_publish = Some(now_ms);
                    }
                }
            }
        }
        let wake_in_ms = match (wake_in_ms, wake) {
            (Some(a), Some(b)) => Some(f64::min(a, b)),
            (a, b) => a.or(b),
        };
        Outgoing { frames: self.session.take_outgoing(), wake_in_ms, awareness }
    }

    /// Focus / blur (view.ts setPresence): our cursor is shown to others only while focused.
    pub fn set_focused(&mut self, focused: bool, now_ms: f64) -> Vec<Vec<u8>> {
        self.focused = focused;
        self.session.tick(now_ms);
        if focused {
            let cur = self.sel_utf16();
            self.session.set_cursor(Some(cur));
            self.last_publish = Some(now_ms);
        } else if self.session.cursor_json() != Value::Null {
            self.session.set_cursor(None);
        }
        self.session.take_outgoing()
    }

    fn sel_utf16(&self) -> (u32, u32) {
        let s = self.editor.selection();
        let t = self.editor.text();
        (byte_to_utf16(t, s.anchor) as u32, byte_to_utf16(t, s.head) as u32)
    }

    // ---- presence ----

    /// Remote carets/selections to draw: not our own user's (other tabs), only those with a cursor that
    /// resolves (cursors.ts).
    pub fn remote_cursors(&self) -> Vec<PeerCursor> {
        let me = self.session.user()["id"].as_str().map(str::to_string);
        let text = self.editor.text();
        let len16 = byte_to_utf16(text, text.len()) as u32;
        let mut out = Vec::new();
        for c in self.session.remote_cursors() {
            if !c.user.is_object() {
                continue;
            }
            let user_id = c.user["id"].as_str().unwrap_or_default().to_string();
            if me.as_deref().is_some_and(|m| m == user_id) {
                continue;
            }
            let (Some(a), Some(h)) = (c.anchor, c.head) else { continue };
            let (a, h) = (a.min(len16), h.min(len16));
            let color = c.user["color"].as_str().filter(|s| valid_color(s)).unwrap_or("#888888").to_string();
            let name = c.user["name"].as_str().filter(|s| !s.is_empty()).unwrap_or("anonymous").to_string();
            out.push(PeerCursor {
                client: c.client,
                user_id,
                name,
                color,
                anchor: utf16_to_byte(text, a as usize),
                head: utf16_to_byte(text, h as usize),
                anchor_utf16: a,
                head_utf16: h,
            });
        }
        out
    }

    /// Other clients' presence states (`{user, cursor}` JSON) for the participants list.
    pub fn peers(&self) -> Vec<(u64, Value)> {
        self.session.peers()
    }
}

fn save_state(msg: &Value) -> Value {
    serde_json::json!({ "dirty": msg["dirty"], "saving": msg["saving"], "commit": msg["commit"], "savedAt": msg["savedAt"] })
}

/// `^#[0-9a-f]{3,8}$`i
fn valid_color(s: &str) -> bool {
    let Some(hex) = s.strip_prefix('#') else { return false };
    (3..=8).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}
