//! The collab Engine (`Engine::collab_rs`) against an in-process Grimoire room (a yrs doc answering sync like
//! the server): patches from remote frames, outgoing frames after commands, notices, cursors, lifecycle.

use super::*;
use collab::YrsStore;
use collab::protocol::{MSG_AWARENESS, MSG_CONTROL, MSG_SYNC, awareness_frame, control_frame};
use editor_core::MonoLayout;
use serde_json::json;
use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::SyncMessage;
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};

struct Room {
    doc: YrsStore,
    generation: String,
    read_only: bool,
}

fn sync_frame(msg: SyncMessage) -> Vec<u8> {
    let mut enc = EncoderV1::new();
    enc.write_var(MSG_SYNC);
    msg.encode(&mut enc);
    enc.to_vec()
}

impl Room {
    fn new(text: &str) -> Room {
        let mut doc = YrsStore::without_undo(999);
        doc.replace(0, 0, text);
        doc.take_updates();
        Room { doc, generation: "g1".into(), read_only: false }
    }

    fn greet(&self) -> Vec<Vec<u8>> {
        let hello = control_frame(&json!({
            "t": "hello", "generation": self.generation, "readOnly": self.read_only,
            "dirty": false, "saving": false, "commit": "c0", "savedAt": null,
        }));
        vec![hello, sync_frame(SyncMessage::SyncStep1(self.doc.state_vector()))]
    }

    /// Replies to a client frame (updates are applied).
    fn handle(&mut self, frame: &[u8]) -> Vec<Vec<u8>> {
        let mut dec = DecoderV1::new(Cursor::new(frame));
        let tag: u8 = dec.read_var().unwrap();
        match tag {
            MSG_SYNC => match SyncMessage::decode(&mut dec).unwrap() {
                SyncMessage::SyncStep1(sv) => vec![sync_frame(SyncMessage::SyncStep2(self.doc.diff(&sv)))],
                SyncMessage::SyncStep2(u) | SyncMessage::Update(u) => {
                    assert!(!self.read_only, "a read-only client sent an update");
                    self.doc.apply_remote_update(&u).unwrap();
                    self.doc.take_changes();
                    vec![]
                }
            },
            MSG_AWARENESS | MSG_CONTROL => vec![],
            _ => panic!("unknown frame"),
        }
    }

    /// An edit by another client (999), as the broadcast update frame.
    fn remote_edit(&mut self, from: u32, to: u32, insert: &str) -> Vec<u8> {
        self.doc.replace(from, to, insert);
        let u = self.doc.take_updates();
        sync_frame(SyncMessage::Update(yrs::merge_updates_v1(&u).unwrap()))
    }
}

/// Connect `e` to `room`: deliver the greeting and everything the two exchange until quiet. Returns the
/// notices and the last patch.
fn connect(e: &mut Engine, room: &mut Room) -> (Vec<NoticeJs>, Option<PatchJs>) {
    e.connecting();
    let mut down: Vec<Vec<u8>> = room.greet();
    let (mut notices, mut patch) = (vec![], None);
    while !down.is_empty() {
        let f = down.remove(0);
        let r = e.receive_rs(&f);
        assert!(r.error.is_none(), "{:?}", r.error);
        notices.extend(r.notices);
        if r.patch.is_some() {
            patch = r.patch;
        }
        for up in r.frames {
            down.extend(room.handle(&up));
        }
    }
    (notices, patch)
}

/// Send what the engine has after a command.
fn flush(e: &mut Engine, room: &mut Room, now: f64) -> usize {
    let o = e.take_outgoing_rs(now);
    let n = o.frames.len();
    for f in o.frames {
        assert!(room.handle(&f).is_empty());
    }
    n
}

fn apply(list: &mut Vec<LineViewJs>, p: &PatchJs) {
    if let Some(l) = &p.lines {
        let s = l.start as usize;
        list.splice(s..s + l.delete_count as usize, l.insert.iter().cloned());
    }
}

fn check_mirror(e: &Engine, list: &[LineViewJs]) {
    let snap = Snap::new(e.text());
    let want: Vec<LineViewJs> =
        e.render_lines().iter().zip(list).map(|(l, j)| conv::line_js(l, j.key.parse().unwrap(), &snap)).collect();
    assert_eq!(list.len(), e.render_lines().len());
    assert_eq!(list, &want[..]);
}

fn user() -> serde_json::Value {
    json!({ "id": "u1", "name": "Ann", "color": "#f80", "kind": "human" })
}

#[test]
fn syncs_edits_both_ways_with_patches() {
    let mut room = Room::new("# Hi 😀\n- a");
    let mut e = Engine::collab_rs(7, user());
    assert!(e.text().is_empty());
    let mut list = vec![];
    apply(&mut list, &e.render_all_rs());
    let (notices, patch) = connect(&mut e, &mut room);
    assert_eq!(
        notices,
        vec![
            NoticeJs::Hello {
                read_only: false,
                save_state: json!({"dirty": false, "saving": false, "commit": "c0", "savedAt": null})
            },
            NoticeJs::Synced
        ]
    );
    // the initial sync rebuilds the editor: a full render replacing what the front end had
    let p = patch.unwrap();
    assert_eq!(p.lines.as_ref().unwrap().delete_count, 1);
    apply(&mut list, &p);
    check_mirror(&e, &list);
    assert_eq!(e.text(), "# Hi 😀\n- a");
    assert!(e.synced_rs());
    assert_eq!(e.status(), "connected");

    // local typing → one update frame; the room has it
    apply(&mut list, &e.set_selection_rs(11, 11));
    let p = e.insert_text_rs("b");
    assert_eq!(p.edits, Some(vec![EditJs { from: 11, to: 11, insert: "b".into() }]));
    apply(&mut list, &p);
    assert!(flush(&mut e, &mut room, 1.0) >= 1);
    assert_eq!(room.doc.text(), "# Hi 😀\n- ab");
    // Enter with geometry (list continuation) is one more update
    let lay = MonoLayout::new(e.collab_editor().unwrap().editor());
    apply(&mut list, &e.key_rs("Enter", 0, &lay).unwrap());
    flush(&mut e, &mut room, 2.0);
    assert_eq!(room.doc.text(), "# Hi 😀\n- ab\n- ");

    // a remote edit before the caret: a patch with the edit (UTF-16) and the caret mapped
    let f = room.remote_edit(0, 0, "😁x ");
    let r = e.receive_rs(&f);
    let p = r.patch.unwrap();
    assert_eq!(p.edits, Some(vec![EditJs { from: 0, to: 0, insert: "😁x ".into() }]));
    assert_eq!(p.sel, SelJs { anchor: 19, head: 19 });
    apply(&mut list, &p);
    check_mirror(&e, &list);
    assert_eq!(e.text(), room.doc.text());

    // undo removes only our own group, and reaches the room
    apply(&mut list, &e.undo_rs());
    flush(&mut e, &mut room, 3.0);
    assert_eq!(e.text(), "😁x # Hi 😀\n- a");
    assert_eq!(room.doc.text(), e.text());
    check_mirror(&e, &list);
    apply(&mut list, &e.redo_rs());
    flush(&mut e, &mut room, 4.0);
    assert_eq!(room.doc.text(), "😁x # Hi 😀\n- ab\n- ");
    assert!(e.is_consistent());
}

#[test]
fn crlf_note_is_not_rewritten() {
    let mut room = Room::new("a\r\n- b\r\nc");
    let mut e = Engine::collab_rs(8, user());
    connect(&mut e, &mut room);
    assert_eq!(e.text(), "a\r\n- b\r\nc");
    // nothing was sent but the handshake: the room's text is untouched
    assert_eq!(flush(&mut e, &mut room, 1.0), 0);
    assert_eq!(room.doc.text(), "a\r\n- b\r\nc");
    let len = e.text().len() as u32;
    e.set_selection_rs(len, len);
    e.insert_text_rs("d");
    flush(&mut e, &mut room, 2.0);
    assert_eq!(room.doc.text(), "a\r\n- b\r\ncd");
}

#[test]
fn offline_edits_merge_on_reconnect() {
    let mut room = Room::new("hello");
    let mut e = Engine::collab_rs(9, user());
    connect(&mut e, &mut room);
    assert_eq!(e.disconnected_rs(1006, ""), AfterCloseJs::Retry { retry: 500 });
    assert_eq!(e.status(), "disconnected");
    e.set_selection_rs(5, 5);
    e.insert_text_rs(" world");
    // offline: nothing to send
    assert_eq!(e.take_outgoing_rs(1.0).frames.len(), 0);
    // meanwhile someone else edits
    room.remote_edit(0, 0, ">> ");
    assert_eq!(e.disconnected_rs(1006, ""), AfterCloseJs::Retry { retry: 1000 });
    assert!(e.online());
    let (notices, patch) = connect(&mut e, &mut room);
    assert!(matches!(notices[0], NoticeJs::Hello { .. }));
    // not reloaded (the editor was used): the remote edit came as an edit patch
    assert_eq!(patch.unwrap().edits, Some(vec![EditJs { from: 0, to: 0, insert: ">> ".into() }]));
    assert_eq!(e.text(), ">> hello world");
    assert_eq!(room.doc.text(), ">> hello world");
    // backoff starts over after hello
    assert_eq!(e.disconnected_rs(1006, ""), AfterCloseJs::Retry { retry: 500 });
}

#[test]
fn generation_change_resets() {
    let mut room = Room::new("one");
    let mut e = Engine::collab_rs(10, user());
    connect(&mut e, &mut room);
    e.disconnected_rs(1006, "");
    let mut room2 = Room::new("two");
    room2.generation = "g2".into();
    let r = e.receive_rs(&room2.greet()[0]);
    assert_eq!(r.notices, vec![NoticeJs::Reset]);
    let p = e.reset_rs(11);
    assert_eq!(e.text(), "");
    assert_eq!(p.lines.as_ref().unwrap().insert.len(), 1);
    assert_eq!(e.collab_editor().unwrap().client_id(), 11);
    connect(&mut e, &mut room2);
    assert_eq!(e.text(), "two");
}

#[test]
fn read_only_room() {
    let mut room = Room::new("ro");
    room.read_only = true;
    let mut e = Engine::collab_rs(12, user());
    let (notices, _) = connect(&mut e, &mut room);
    assert_eq!(notices[0], NoticeJs::ReadOnly { read_only: true });
    assert!(e.read_only());
    let p = e.insert_text_rs("x");
    assert_eq!(p.edits, None);
    flush(&mut e, &mut room, 1.0); // the room asserts nothing but presence comes
    assert_eq!(e.text(), "ro");
    // remote edits still show
    let f = room.remote_edit(2, 2, "!");
    assert!(e.receive_rs(&f).patch.is_some());
    assert_eq!(e.text(), "ro!");
}

#[test]
fn remote_cursors_and_focus() {
    let mut room = Room::new("abc def");
    let mut e = Engine::collab_rs(13, user());
    connect(&mut e, &mut room);
    // a peer's cursor (sticky index JSON as Yjs writes it) at offset 4
    let sticky = room.doc.sticky(4, yrs::Assoc::Before);
    let state = json!({ "user": {"id": "u2", "name": "Bob", "color": "#00ff00", "kind": "human"},
                        "cursor": {"anchor": sticky, "head": sticky} });
    let r = e.receive_rs(&awareness_frame(55, 1, &state.to_string()));
    assert!(r.awareness);
    let c = e.remote_cursors_rs();
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].client, c[0].name.as_str(), c[0].color.as_str(), c[0].anchor, c[0].head), (55.0, "Bob", "#00ff00", 4, 4));
    let key = c[0].key.clone();
    // a remote insert before it moves the resolved offset, not the key
    let f = room.remote_edit(0, 0, "XY");
    e.receive_rs(&f);
    let c = e.remote_cursors_rs();
    assert_eq!((c[0].anchor, c[0].key == key), (6, true));
    assert_eq!(e.peers_rs().len(), 1);
    // our own cursor is published only while focused
    let f = e.set_focused_rs(true, 10.0);
    assert_eq!(f.len(), 1);
    e.set_selection_rs(3, 3);
    // throttled: within 50 ms nothing, but a wake-up
    let o = e.take_outgoing_rs(20.0);
    assert_eq!((o.frames.len(), o.wake_in_ms), (0, Some(40.0)));
    assert_eq!(e.take_outgoing_rs(60.0).frames.len(), 1);
    assert_eq!(e.set_focused_rs(false, 100.0).len(), 1);
    e.set_selection_rs(1, 1);
    assert_eq!(e.take_outgoing_rs(200.0).frames.len(), 0);
    // leaving sends a null state
    assert_eq!(e.leave_rs().len(), 1);
}

#[test]
fn closed_codes_end_the_session() {
    let mut room = Room::new("x");
    let mut e = Engine::collab_rs(14, user());
    connect(&mut e, &mut room);
    assert_eq!(e.disconnected_rs(4404, ""), AfterCloseJs::Closed { closed: "notfound".into(), to: None });
    let mut e = Engine::collab_rs(15, user());
    connect(&mut e, &mut room);
    e.receive_rs(&control_frame(&json!({"t": "closed", "reason": "renamed", "to": "b.md"})));
    assert_eq!(e.disconnected_rs(1000, ""), AfterCloseJs::Closed { closed: "renamed".into(), to: Some("b.md".into()) });
    let r = e.receive_rs(&control_frame(&json!({"t": "external", "commit": "abc"})));
    // stopped after close: ignored
    assert!(r.notices.is_empty());
}

#[test]
fn save_state_and_external_notices() {
    let mut room = Room::new("x");
    let mut e = Engine::collab_rs(16, user());
    connect(&mut e, &mut room);
    let r = e.receive_rs(&control_frame(&json!({"t": "status", "dirty": true, "saving": false, "commit": "c0", "savedAt": 5})));
    assert_eq!(r.notices, vec![NoticeJs::SaveState { save_state: json!({"dirty": true, "saving": false, "commit": "c0", "savedAt": 5}) }]);
    let r = e.receive_rs(&control_frame(&json!({"t": "external", "commit": "c1"})));
    assert_eq!(r.notices, vec![NoticeJs::External { commit: Some("c1".into()) }]);
    assert_eq!(e.request_flush_rs().len(), 1);
}

#[test]
fn plain_engine_ignores_collab_calls() {
    let mut e = Engine::new("abc");
    assert!(e.receive_rs(&[0]).error.is_some());
    assert!(e.take_outgoing_rs(0.0).frames.is_empty());
    assert!(e.remote_cursors_rs().is_empty());
    e.set_read_only(true);
    assert!(e.read_only());
}

#[test]
fn a_remote_edit_inside_a_surrogate_pair_stays_consistent() {
    let mut room = Room::new("a😀b");
    let mut e = Engine::collab_rs(17, user());
    connect(&mut e, &mut room);
    e.set_selection_rs(4, 4);
    e.insert_text_rs("c");
    flush(&mut e, &mut room, 1.0);
    // a peer inserts between the two halves of the emoji (UTF-16 offset 2): yrs moves it past the pair; had
    // the editor and the shared text disagreed, `receive` would rebuild the editor (`reloaded`)
    let f = room.remote_edit(2, 2, "X");
    let r = e.receive_rs(&f);
    assert!(e.is_consistent());
    assert_eq!(e.text(), room.doc.text());
    assert!(r.patch.is_some());
}
