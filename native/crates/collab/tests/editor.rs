//! `CollabEditor` end to end: editors exchanging protocol frames through an in-process relay server (a yrs
//! doc that answers sync like the Grimoire server). Verifies the history.ts behaviours on editor-core's
//! History (local-only undo, selection restore, groups across remote edits, conversion marks), the
//! provider.ts lifecycle (reconnect, reset, read-only), presence, and convergence under random delivery.

use std::collections::VecDeque;

use collab::protocol::{MSG_AWARENESS, MSG_CONTROL, MSG_SYNC, control_frame};
use collab::{AfterClose, CollabEditor, ConnStatus, Notice, YrsStore};
use editor_core::{BlockType, Key, Mods, MonoLayout, Sel, TextStore};
use serde_json::{Value, json};
use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::{AwarenessUpdate, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};

// ---------------------------------------------------------------------------------------------
// Relay server + network

struct Server {
    doc: YrsStore,
    generation: String,
    read_only: bool,
}

impl Server {
    fn new(text: &str) -> Server {
        let mut doc = YrsStore::without_undo(999);
        doc.replace(0, 0, text);
        doc.take_updates();
        Server { doc, generation: "g1".into(), read_only: false }
    }

    /// What a new connection gets: hello, then the server's step1.
    fn greet(&self) -> Vec<Vec<u8>> {
        let hello = control_frame(&json!({
            "t": "hello", "generation": self.generation, "readOnly": self.read_only,
            "dirty": false, "saving": false, "commit": "c0", "savedAt": null,
        }));
        vec![hello, sync_frame(SyncMessage::SyncStep1(self.doc.state_vector()))]
    }

    /// A frame from a client: (reply to it, broadcast to the others).
    fn handle(&mut self, frame: &[u8]) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
        let mut dec = DecoderV1::new(Cursor::new(frame));
        let tag: u8 = dec.read_var().unwrap();
        match tag {
            MSG_SYNC => match SyncMessage::decode(&mut dec).unwrap() {
                SyncMessage::SyncStep1(sv) => (vec![sync_frame(SyncMessage::SyncStep2(self.doc.diff(&sv)))], vec![]),
                SyncMessage::SyncStep2(u) | SyncMessage::Update(u) => {
                    assert!(!self.read_only, "a read-only client sent an update");
                    self.doc.apply_remote_update(&u).unwrap();
                    self.doc.take_changes();
                    (vec![], vec![sync_frame(SyncMessage::Update(u))])
                }
            },
            MSG_AWARENESS => (vec![], vec![frame.to_vec()]),
            MSG_CONTROL => (vec![], vec![]),
            _ => panic!("unknown frame"),
        }
    }
}

fn sync_frame(msg: SyncMessage) -> Vec<u8> {
    let mut enc = EncoderV1::new();
    enc.write_var(MSG_SYNC);
    msg.encode(&mut enc);
    enc.to_vec()
}

struct Net {
    server: Server,
    eds: Vec<CollabEditor>,
    /// client → server, server → client
    up: Vec<VecDeque<Vec<u8>>>,
    down: Vec<VecDeque<Vec<u8>>>,
    connected: Vec<bool>,
    now: f64,
}

fn user(n: usize) -> Value {
    let names = ["Ann", "Bob", "Cid"];
    json!({ "id": format!("u{n}"), "name": names[n % 3], "color": "#f80", "kind": "human" })
}

impl Net {
    fn new(text: &str, n: usize) -> Net {
        let mut net = Net {
            server: Server::new(text),
            eds: (0..n).map(|i| CollabEditor::new(100 + i as u32, user(i))).collect(),
            up: vec![VecDeque::new(); n],
            down: vec![VecDeque::new(); n],
            connected: vec![false; n],
            now: 0.0,
        };
        for i in 0..n {
            net.connect(i);
        }
        net.settle();
        net
    }

    fn connect(&mut self, i: usize) {
        self.eds[i].connecting();
        self.connected[i] = true;
        self.down[i].extend(self.server.greet());
    }

    fn disconnect(&mut self, i: usize) -> AfterClose {
        self.connected[i] = false;
        self.up[i].clear();
        self.down[i].clear();
        self.eds[i].disconnected(1006, "")
    }

    /// Queue what editor `i` has to send (after local commands).
    fn flush(&mut self, i: usize) {
        self.now += 1.0;
        let out = self.eds[i].take_outgoing(self.now);
        if self.connected[i] {
            self.up[i].extend(out.frames);
        }
    }

    fn deliver_up(&mut self, i: usize, k: usize) {
        let Some(f) = self.up[i].remove(k) else { return };
        let (reply, bcast) = self.server.handle(&f);
        self.down[i].extend(reply);
        for j in 0..self.eds.len() {
            if j != i && self.connected[j] {
                self.down[j].extend(bcast.iter().cloned());
            }
        }
    }

    fn deliver_down(&mut self, i: usize, k: usize) -> collab::Received {
        let f = self.down[i].remove(k).unwrap();
        let r = self.eds[i].receive(&f).unwrap();
        assert!(self.eds[i].is_consistent(), "editor text == yrs text");
        if self.connected[i] {
            self.up[i].extend(r.outgoing.iter().cloned());
        }
        r
    }

    /// Deliver everything (FIFO), collecting what the editors reported.
    fn settle(&mut self) -> Vec<Vec<collab::Received>> {
        let mut got: Vec<Vec<collab::Received>> = (0..self.eds.len()).map(|_| vec![]).collect();
        for i in 0..self.eds.len() {
            self.flush(i);
        }
        loop {
            let mut moved = false;
            for (i, got) in got.iter_mut().enumerate() {
                while !self.up[i].is_empty() {
                    self.deliver_up(i, 0);
                    moved = true;
                }
                while !self.down[i].is_empty() {
                    got.push(self.deliver_down(i, 0));
                    moved = true;
                }
            }
            if !moved {
                break;
            }
        }
        got
    }

    fn text(&self, i: usize) -> &str {
        self.eds[i].editor().text()
    }

    fn assert_converged(&self) {
        let t = self.server.doc.text();
        for (i, e) in self.eds.iter().enumerate() {
            assert_eq!(e.editor().text(), t, "editor {i} == server");
            assert_eq!(e.editor().store().text(), t, "editor {i} mirror == server");
            assert!(e.is_consistent());
        }
    }

    // ---- editing helpers (then queue the frames) ----

    fn typ(&mut self, i: usize, s: &str) {
        for c in s.chars() {
            let e = self.eds[i].editor_mut();
            if c == '\n' {
                let l = MonoLayout::new(e);
                e.key(Key::Enter, Mods::NONE, &l);
            } else {
                e.insert_text(&c.to_string());
            }
        }
        self.flush(i);
    }

    fn caret(&mut self, i: usize, pos: usize) {
        self.eds[i].editor_mut().set_selection(Sel::caret(pos));
        self.flush(i);
    }

    fn select(&mut self, i: usize, a: usize, h: usize) {
        self.eds[i].editor_mut().set_selection(Sel::new(a, h));
        self.flush(i);
    }

    fn key(&mut self, i: usize, k: Key) {
        let e = self.eds[i].editor_mut();
        let l = MonoLayout::new(e);
        e.key(k, Mods::NONE, &l);
        self.flush(i);
    }

    fn undo(&mut self, i: usize) -> bool {
        let r = self.eds[i].editor_mut().undo();
        self.flush(i);
        r
    }

    fn redo(&mut self, i: usize) -> bool {
        let r = self.eds[i].editor_mut().redo();
        self.flush(i);
        r
    }

    fn focus(&mut self, i: usize) {
        self.now += 1.0;
        let frames = self.eds[i].set_focused(true, self.now);
        if self.connected[i] {
            self.up[i].extend(frames);
        }
    }

    fn sel(&self, i: usize) -> (usize, usize) {
        let s = self.eds[i].editor().selection();
        (s.anchor, s.head)
    }
}

// ---------------------------------------------------------------------------------------------
// Sync basics

#[test]
fn initial_sync_loads_the_note_and_rebuilds_the_editor() {
    let mut net = Net::new("", 0);
    net.server = Server::new("# Title\nbody");
    net.eds.push(CollabEditor::new(7, user(0)));
    net.up.push(VecDeque::new());
    net.down.push(VecDeque::new());
    net.connected.push(false);
    net.connect(0);
    assert_eq!(net.eds[0].status(), ConnStatus::Connecting);
    let got = net.settle();
    let all: Vec<&Notice> = got[0].iter().flat_map(|r| &r.notices).collect();
    assert!(matches!(all[0], Notice::Hello { read_only: false, .. }));
    assert!(all.contains(&&Notice::Synced));
    assert!(got[0].iter().any(|r| r.reloaded));
    assert_eq!(net.eds[0].status(), ConnStatus::Connected);
    assert!(net.eds[0].synced());
    assert_eq!(net.text(0), "# Title\nbody");
    // a fresh editor: caret at the first line's text (after "# "), like mounting after sync
    assert_eq!(net.sel(0), (2, 2));
    assert_eq!(net.eds[0].save_state()["commit"], "c0");
}

#[test]
fn local_edits_become_one_merged_update_and_remote_edits_patch_the_editor() {
    let mut net = Net::new("hello\nworld", 2);
    net.caret(0, 5);
    net.eds[0].editor_mut().paste(" there, 😀 friend");
    let out = net.eds[0].take_outgoing(100.0);
    let updates: Vec<_> = out.frames.iter().filter(|f| f[..2] == [MSG_SYNC, 2]).collect();
    assert_eq!(updates.len(), 1, "one update frame per command");
    net.up[0].extend(out.frames);
    let got = net.settle();
    let r = got[1].iter().find(|r| !r.edits.is_empty()).expect("remote edits");
    assert_eq!(r.edits, vec![(5..5, " there, 😀 friend".to_string())]);
    assert_eq!(r.edits_utf16[0].from, 5);
    net.assert_converged();
    // an edit after the emoji: UTF-16 and byte offsets differ
    let at = net.text(0).find("friend").unwrap();
    net.caret(1, at);
    net.typ(1, "dear ");
    let got = net.settle();
    let r = got[0].iter().find(|r| !r.edits.is_empty()).unwrap();
    assert_eq!(r.edits[0].0, at..at);
    assert_eq!(r.edits_utf16[0].from as usize, at - 2, "😀 is 4 bytes, 2 UTF-16 units");
    net.assert_converged();
    assert_eq!(net.text(0), "hello there, 😀 dear friend\nworld");
}

// ---------------------------------------------------------------------------------------------
// history.ts behaviours

#[test]
fn undo_is_local_only_with_interleaved_remote_edits() {
    let mut net = Net::new("hello\nworld", 2);
    net.caret(0, 5);
    net.typ(0, " foo");
    net.caret(1, 11);
    net.typ(1, " bar");
    net.settle();
    net.caret(0, 9);
    net.typ(0, "d");
    // interleave: B's next edit arrives before A undoes
    net.caret(1, 0);
    net.typ(1, "> ");
    net.settle();
    assert_eq!(net.text(0), "> hello food\nworld bar");
    assert!(net.undo(0));
    assert!(net.undo(0));
    net.settle();
    assert_eq!(net.text(0), "> hello\nworld bar", "only A's own groups are undone");
    assert!(!net.undo(0), "remote edits are never undone");
    net.settle();
    net.assert_converged();
    assert!(net.redo(0));
    assert!(net.redo(0));
    net.settle();
    assert_eq!(net.text(1), "> hello food\nworld bar");
    net.assert_converged();
}

#[test]
fn undo_restores_the_selection_mapped_through_remote_edits() {
    let mut net = Net::new("hello\nworld", 2);
    // typed text: undo puts the caret back where typing started
    net.caret(0, 5);
    net.typ(0, "XYZ");
    net.caret(0, 0);
    net.caret(1, 0);
    net.typ(1, "++ ");
    net.settle();
    assert_eq!(net.text(0), "++ helloXYZ\nworld");
    net.undo(0);
    assert_eq!(net.sel(0), (8, 8));
    net.settle();
    net.assert_converged();

    // a deleted selection: undo re-inserts and selects it, mapped through a remote insert before it
    net.select(0, 9, 14);
    net.key(0, Key::Backspace);
    net.caret(1, 0);
    net.typ(1, "+");
    net.settle();
    assert_eq!(net.text(0), "+++ hello\n");
    net.undo(0);
    assert_eq!(net.text(0), "+++ hello\nworld");
    let (a, h) = net.sel(0);
    assert_eq!((a.min(h), a.max(h)), (10, 15), "\"world\" selected again");
    net.settle();
    net.assert_converged();
}

#[test]
fn a_group_spans_remote_edits() {
    let mut net = Net::new("hello\nworld", 2);
    net.caret(0, 11);
    net.typ(0, "ab");
    net.caret(1, 0);
    net.typ(1, "Z");
    net.settle();
    // A keeps typing after B's edit arrived: same group (remote edits don't end it)
    net.typ(0, "cd");
    net.settle();
    assert_eq!(net.text(0), "Zhello\nworldabcd");
    net.undo(0);
    assert_eq!(net.text(0), "Zhello\nworld");
    assert_eq!(net.sel(0), (12, 12));
    net.settle();
    net.assert_converged();
}

#[test]
fn undo_after_a_remote_delete_of_part_of_the_group() {
    let mut net = Net::new("start\n", 2);
    net.caret(0, 6);
    net.typ(0, "helloworld");
    net.settle();
    // B deletes "llowo"
    net.select(1, 8, 13);
    net.key(1, Key::Backspace);
    net.settle();
    assert_eq!(net.text(0), "start\nherld");
    net.undo(0);
    assert_eq!(net.text(0), "start\n", "the rest of the group goes, the remote delete stays");
    net.settle();
    net.assert_converged();
    // redo brings back only what A typed and B didn't delete
    net.redo(0);
    assert_eq!(net.text(0), "start\nherld");
    net.settle();
    net.assert_converged();
}

#[test]
fn remote_text_inside_an_undone_group_stays() {
    let mut net = Net::new("x\n", 2);
    net.caret(0, 2);
    net.typ(0, "helloworld");
    net.settle();
    net.caret(1, 7);
    net.typ(1, "XY");
    net.settle();
    assert_eq!(net.text(0), "x\nhelloXYworld");
    net.undo(0);
    assert_eq!(net.text(0), "x\nXY", "Y.UndoManager semantics: only our own insertions go");
    net.settle();
    net.assert_converged();
}

#[test]
fn redo_after_remote_edits() {
    let mut net = Net::new("one\ntwo", 2);
    net.caret(0, 3);
    net.typ(0, " foo");
    net.undo(0);
    net.settle();
    assert_eq!(net.text(1), "one\ntwo");
    // B edits before and right at A's spot
    net.caret(1, 0);
    net.typ(1, "0 ");
    net.caret(1, 5);
    net.typ(1, "!");
    net.settle();
    assert_eq!(net.text(0), "0 one!\ntwo");
    assert!(net.redo(0));
    assert_eq!(net.text(0), "0 one foo!\ntwo");
    assert_eq!(net.sel(0), (9, 9), "caret after the redone text");
    net.settle();
    net.assert_converged();
    // a new local edit clears redo; remote edits don't
    net.undo(0);
    net.caret(1, 0);
    net.typ(1, "#");
    net.settle();
    assert!(net.eds[0].editor().can_redo());
    net.caret(0, 0);
    net.typ(0, "x");
    assert!(!net.eds[0].editor().can_redo());
    net.settle();
    net.assert_converged();
}

fn line_ty(net: &Net, i: usize, line: usize) -> BlockType {
    net.eds[i].editor().doc().lines[line].ty
}

#[test]
fn conversion_marks_survive_remote_edits_elsewhere() {
    let mut net = Net::new("x\n", 2);
    net.caret(0, 2);
    net.typ(0, "- ");
    net.settle();
    assert_eq!(line_ty(&net, 0, 1), BlockType::Bullet);
    // B edits another line
    net.caret(1, 1);
    net.typ(1, "yz");
    net.settle();
    assert_eq!(net.text(0), "xyz\n- ");
    // undo: the conversion only (local view state), the text stays
    net.undo(0);
    assert_eq!(net.text(0), "xyz\n- ");
    assert_eq!(line_ty(&net, 0, 1), BlockType::Paragraph, "shown literally");
    assert_eq!(line_ty(&net, 1, 1), BlockType::Bullet, "only for A");
    // more remote edits elsewhere keep the literal line
    net.caret(1, 0);
    net.typ(1, "> ");
    net.settle();
    assert_eq!(line_ty(&net, 0, 2 - 1), BlockType::Paragraph);
    net.redo(0);
    assert_eq!(line_ty(&net, 0, 1), BlockType::Bullet);
    net.undo(0);
    net.undo(0);
    assert_eq!(net.text(0), "> xyz\n");
    net.settle();
    net.assert_converged();
}

#[test]
fn a_remote_edit_on_the_converted_line_drops_its_mark() {
    let mut net = Net::new("x\n", 2);
    net.caret(0, 2);
    net.typ(0, "- ");
    net.settle();
    // B types on that line
    net.caret(1, 4);
    net.typ(1, "y");
    net.settle();
    assert_eq!(net.text(0), "x\n- y");
    // the mark is no longer valid: undo skips it and reverts the typed "- "
    net.undo(0);
    assert_eq!(net.text(0), "x\ny");
    net.settle();
    net.assert_converged();
}

// ---------------------------------------------------------------------------------------------
// Presence

fn awareness_states(frames: &[Vec<u8>]) -> Vec<Value> {
    let mut out = vec![];
    for f in frames {
        if f[0] != MSG_AWARENESS {
            continue;
        }
        let mut dec = DecoderV1::new(Cursor::new(&f[..]));
        let _: u8 = dec.read_var().unwrap();
        let u = AwarenessUpdate::decode_v1(dec.read_buf().unwrap()).unwrap();
        for e in u.clients.values() {
            out.push(serde_json::from_str(&e.json).unwrap());
        }
    }
    out
}

#[test]
fn cursor_is_published_only_while_focused_and_throttled() {
    let mut net = Net::new("hello 😀 world", 2);
    net.eds[0].editor_mut().set_selection(Sel::caret(3));
    let out = net.eds[0].take_outgoing(1000.0);
    assert!(awareness_states(&out.frames).is_empty(), "not focused: nothing published");

    let frames = net.eds[0].set_focused(true, 1000.0);
    let st = awareness_states(&frames);
    assert_eq!(st.len(), 1);
    assert_eq!(st[0]["user"]["name"], "Ann");
    // Yjs relativePositionToJSON: a caret sticks to the char before it (assoc -1)
    assert_eq!(st[0]["cursor"]["head"]["assoc"], -1);
    assert!(st[0]["cursor"]["head"]["item"]["client"].is_number());

    // within 50 ms: delayed; then published
    net.eds[0].editor_mut().set_selection(Sel::caret(4));
    let out = net.eds[0].take_outgoing(1020.0);
    assert!(awareness_states(&out.frames).is_empty());
    assert_eq!(out.wake_in_ms, Some(30.0));
    let out = net.eds[0].take_outgoing(1050.0);
    assert_eq!(awareness_states(&out.frames).len(), 1);
    // unchanged selection: nothing
    let out = net.eds[0].take_outgoing(1200.0);
    assert!(awareness_states(&out.frames).is_empty() && out.wake_in_ms.unwrap() > PUBLISH_WAKE);

    // B sees A's cursor (bytes and UTF-16), after the emoji
    net.eds[0].editor_mut().set_selection(Sel::new(6, 15));
    let out = net.eds[0].take_outgoing(1300.0);
    net.up[0].extend(out.frames);
    let got = net.settle();
    assert!(got[1].iter().any(|r| r.awareness));
    let c = net.eds[1].remote_cursors();
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].name.as_str(), c[0].color.as_str(), c[0].user_id.as_str()), ("Ann", "#f80", "u0"));
    assert_eq!((c[0].anchor, c[0].head), (6, 15));
    assert_eq!((c[0].anchor_utf16, c[0].head_utf16), (6, 13));
    // the remote cursor follows remote text edits
    net.caret(1, 0);
    net.typ(1, "AB");
    net.settle();
    let c = net.eds[1].remote_cursors();
    assert_eq!((c[0].anchor, c[0].head), (8, 17));

    // blur: cursor null, B drops it
    let frames = net.eds[0].set_focused(false, 1400.0);
    assert_eq!(awareness_states(&frames)[0]["cursor"], Value::Null);
    net.up[0].extend(frames);
    net.settle();
    assert!(net.eds[1].remote_cursors().is_empty());
    assert_eq!(net.eds[1].peers().len(), 1, "still present (participants)");
}

const PUBLISH_WAKE: f64 = 50.0;

#[test]
fn presence_is_renewed_every_15s_and_silent_peers_expire_after_30s() {
    let mut net = Net::new("abc", 3);
    for i in 0..3 {
        net.focus(i);
    }
    net.settle();
    assert_eq!(net.eds[0].remote_cursors().len(), 2);
    let t0 = net.now;
    // editor 1 keeps ticking (renewing); editor 2 stays connected but goes silent
    let mut expired_at = vec![];
    for step in 1..=8 {
        let now = t0 + step as f64 * 5_000.0;
        let out = net.eds[1].take_outgoing(now);
        assert_eq!(awareness_states(&out.frames).len(), usize::from(step % 3 == 0), "renewed every 15 s");
        assert!(out.wake_in_ms.unwrap() <= 15_000.0);
        net.up[1].extend(out.frames);
        while !net.up[1].is_empty() {
            net.deliver_up(1, 0);
        }
        while !net.down[0].is_empty() {
            net.deliver_down(0, 0);
        }
        if net.eds[0].take_outgoing(now).awareness {
            expired_at.push(step);
        }
    }
    assert_eq!(expired_at, vec![6], "editor 2 removed 30 s after its last update");
    let c: Vec<u64> = net.eds[0].remote_cursors().iter().map(|c| c.client).collect();
    assert_eq!(c, vec![101]);
}

#[test]
fn cursors_of_the_same_user_are_hidden_and_bad_colors_replaced() {
    let mut net = Net::new("abc", 3);
    // editor 2 is the same person as editor 0 (another tab)
    net.eds[2] = CollabEditor::new(102, user(0));
    net.connect(2);
    net.settle();
    for i in [1, 2] {
        net.focus(i);
    }
    net.settle();
    let c = net.eds[0].remote_cursors();
    assert_eq!(c.iter().map(|c| c.client).collect::<Vec<_>>(), vec![101]);

    let bad = json!({ "user": { "id": "x", "name": "", "color": "red" }, "cursor": { "anchor": { "tname": "md", "assoc": -1 }, "head": { "tname": "md", "assoc": -1 } } });
    net.eds[0].receive(&collab::protocol::awareness_frame(555, 1, &bad.to_string())).unwrap();
    let c = net.eds[0].remote_cursors();
    let x = c.iter().find(|c| c.client == 555).unwrap();
    assert_eq!((x.name.as_str(), x.color.as_str(), x.head), ("anonymous", "#888888", 0));
}

// ---------------------------------------------------------------------------------------------
// Connection lifecycle (provider.ts)

#[test]
fn reconnect_resyncs_offline_edits_and_forgets_remote_presence() {
    let mut net = Net::new("hello", 2);
    net.focus(1);
    net.settle();
    assert_eq!(net.eds[0].remote_cursors().len(), 1);

    assert_eq!(net.disconnect(0), AfterClose::Retry { delay_ms: 500 });
    assert_eq!(net.eds[0].status(), ConnStatus::Disconnected);
    assert!(net.eds[0].remote_cursors().is_empty(), "remote presence removed on disconnect");
    // offline edits on both sides
    net.caret(0, 5);
    net.typ(0, " offline");
    assert!(net.eds[0].session().unsent);
    net.caret(1, 0);
    net.typ(1, "online ");
    net.settle();
    // a failed reconnect doubles the backoff; online() asks for an immediate retry
    assert_eq!(net.disconnect(0), AfterClose::Retry { delay_ms: 1000 });
    assert!(net.eds[0].online());
    net.connect(0);
    let got = net.settle();
    assert!(!got[0].iter().any(|r| r.reloaded), "no rebuild on reconnect");
    assert_eq!(net.text(0), "online hello offline");
    assert!(!net.eds[0].session().unsent);
    net.assert_converged();
    // presence is re-sent by the others after a reconnect in the real server; ours is re-announced
    assert_eq!(net.disconnect(0), AfterClose::Retry { delay_ms: 500 }, "hello reset the backoff");
}

#[test]
fn a_new_room_generation_resets_the_doc() {
    let mut net = Net::new("hello", 1);
    net.disconnect(0);
    net.server = Server::new("recreated");
    net.server.generation = "g2".into();
    net.connect(0);
    let got = net.settle();
    let notices: Vec<&Notice> = got[0].iter().flat_map(|r| &r.notices).collect();
    assert_eq!(notices, vec![&Notice::Reset]);
    assert_eq!(net.text(0), "hello", "nothing from the new room was trusted");
    // the shell closes the socket, starts over with a fresh doc and connects again
    net.disconnect(0);
    net.eds[0].reset(4242);
    assert_eq!(net.eds[0].client_id(), 4242);
    net.connect(0);
    net.settle();
    assert_eq!(net.text(0), "recreated");
    net.assert_converged();
}

#[test]
fn read_only_hello_with_unsent_edits_resets() {
    let mut net = Net::new("hello", 1);
    net.disconnect(0);
    net.caret(0, 5);
    net.typ(0, "!");
    net.server.read_only = true;
    net.connect(0);
    let got = net.settle();
    assert!(got[0].iter().any(|r| r.notices.contains(&Notice::Reset)));
}

#[test]
fn read_only_connection_never_sends_and_blocks_edits() {
    let mut net = Net::new("", 0);
    net.server = Server::new("hello");
    net.server.read_only = true;
    net.eds.push(CollabEditor::new(9, user(0)));
    net.up.push(VecDeque::new());
    net.down.push(VecDeque::new());
    net.connected.push(false);
    net.connect(0);
    let got = net.settle();
    assert!(got[0].iter().any(|r| r.notices.contains(&Notice::ReadOnly(true))));
    assert!(net.eds[0].read_only() && net.eds[0].editor().is_read_only());
    assert_eq!(net.text(0), "hello");
    net.caret(0, 5);
    net.typ(0, "x");
    assert_eq!(net.text(0), "hello");
    net.settle(); // the relay asserts no update arrives
}

#[test]
fn closed_reasons() {
    let mut net = Net::new("hello", 1);
    let f = control_frame(&json!({ "t": "closed", "reason": "renamed", "to": "New.md" }));
    net.eds[0].receive(&f).unwrap();
    assert_eq!(net.eds[0].disconnected(1000, ""), AfterClose::Closed { reason: "renamed".into(), to: Some("New.md".into()) });

    let mut ed = CollabEditor::new(1, user(0));
    assert_eq!(ed.disconnected(4403, ""), AfterClose::Closed { reason: "forbidden".into(), to: None });
    let mut ed = CollabEditor::new(1, user(0));
    assert_eq!(ed.disconnected(4000, ""), AfterClose::Closed { reason: "removed".into(), to: None });
    let mut ed = CollabEditor::new(1, user(0));
    assert_eq!(ed.disconnected(1013, "busy"), AfterClose::Retry { delay_ms: 500 });
}

#[test]
fn leave_announces_null_presence() {
    let mut net = Net::new("hello", 2);
    net.focus(0);
    net.settle();
    assert_eq!(net.eds[1].peers().len(), 1);
    let frames = net.eds[0].leave();
    assert_eq!(awareness_states(&frames), vec![Value::Null], "the state is the JSON null");
    net.up[0].extend(frames);
    net.settle();
    assert!(net.eds[1].peers().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Convergence fuzz

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const PIECES: &[&str] = &["a", "b", " ", "xy", "😀", "é", "\n", "- ", "# ", "**", "[ ] ", "> ", "`", "1. "];

fn random_command(net: &mut Net, i: usize, rng: &mut Rng) {
    let len = net.text(i).len();
    let pos = |rng: &mut Rng, t: &str| editor_core::text::floor_boundary(t, rng.below(len + 1));
    match rng.below(14) {
        0..=4 => {
            let s = PIECES[rng.below(PIECES.len())];
            net.typ(i, s);
        }
        5 => net.key(i, Key::Backspace),
        6 => net.key(i, Key::Delete),
        7 => {
            let t = net.text(i).to_string();
            let p = pos(rng, &t);
            net.caret(i, p);
        }
        8 => {
            let t = net.text(i).to_string();
            let (a, b) = (pos(rng, &t), pos(rng, &t));
            net.select(i, a, b);
        }
        9 | 10 => {
            net.undo(i);
        }
        11 => {
            net.redo(i);
        }
        12 => {
            net.eds[i].editor_mut().paste("pasted 😀\ntext");
            net.flush(i);
        }
        _ => net.key(i, Key::Tab),
    }
}

/// Random local commands (typing incl. auto-conversions, deletes, selections, paste, Tab, undo, redo) on
/// 2-3 editors, random interleaving of the deliveries (each socket FIFO, like a WebSocket; see pending.rs),
/// and random reconnects that lose the frames in flight.
fn fuzz(seed: u64, n: usize, steps: usize) {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut net = Net::new("# Notes\n- one\n- two\n\nplain 😀 text\n", n);
    for _ in 0..steps {
        let i = rng.below(n);
        match rng.below(10) {
            0..=4 => random_command(&mut net, i, &mut rng),
            5..=6 => {
                if !net.up[i].is_empty() {
                    net.deliver_up(i, 0);
                }
            }
            7..=8 => {
                if !net.down[i].is_empty() {
                    net.deliver_down(i, 0);
                }
            }
            _ => {
                // occasionally drop the connection and reconnect
                if rng.below(8) == 0 && net.connected[i] {
                    net.disconnect(i);
                    net.connect(i);
                }
            }
        }
    }
    net.settle();
    net.assert_converged();
    // then everyone undoes all they can (rebased history on the merged text), and it still converges
    for i in 0..n {
        let mut k = 0;
        while net.undo(i) {
            k += 1;
            assert!(k < 1000);
        }
        if rng.below(2) == 0 {
            net.settle();
        }
    }
    net.settle();
    net.assert_converged();
}

#[test]
fn convergence_fuzz() {
    for seed in 1..=300 {
        fuzz(seed, 2 + (seed as usize % 2), 250);
    }
}

#[test]
fn rebuild_keeps_selection_and_read_only() {
    let mut net = Net::new("hello 😀 world", 1);
    let ed = &mut net.eds[0];
    ed.editor_mut().set_selection(Sel::new(6, 10));
    ed.editor_mut().set_read_only(true);
    ed.rebuild();
    assert_eq!(ed.editor().text(), "hello 😀 world");
    assert_eq!(ed.editor().selection(), Sel::new(6, 10));
    assert!(ed.editor().is_read_only());
    assert!(ed.is_consistent());
}
