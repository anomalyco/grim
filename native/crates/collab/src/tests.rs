use serde_json::json;
use yrs::Assoc;

use crate::protocol::{MSG_CONTROL, awareness_frame};
use crate::store::{ChangeKind, Edit, YrsStore, apply_edits};
use crate::{Event, Session};

/// Deliver everything `from` produced to `to` (as the server would relay it).
fn relay(from: &mut YrsStore, to: &mut YrsStore) {
    for u in from.take_updates() {
        to.apply_remote_update(&u).unwrap();
    }
}

#[test]
fn utf16_offsets_and_remote_edits() {
    let mut a = YrsStore::new(1);
    let mut b = YrsStore::new(2);
    a.replace(0, 0, "a😀b");
    assert_eq!(a.len(), 4);
    relay(&mut a, &mut b);
    let ch = b.take_changes();
    assert_eq!(ch.len(), 1);
    assert_eq!(ch[0].kind, ChangeKind::Remote);
    assert_eq!(ch[0].edits, vec![Edit { from: 0, to: 0, insert: "a😀b".into() }]);
    // replace the emoji (2 code units)
    a.replace(1, 3, "é");
    assert_eq!(a.text(), "aéb");
    assert!(a.take_changes().is_empty(), "local edits are not reported back");
    relay(&mut a, &mut b);
    let ch = b.take_changes();
    assert_eq!(ch[0].edits, vec![Edit { from: 1, to: 3, insert: "é".into() }]);
    assert_eq!(b.text(), "aéb");
}

#[test]
fn edits_from_a_delta_replay_onto_a_mirror() {
    let mut a = YrsStore::new(1);
    let mut b = YrsStore::new(2);
    a.replace(0, 0, "hello world\nsecond line\n");
    relay(&mut a, &mut b);
    let mut mirror = b.text();
    b.take_changes();
    a.apply_local(&[
        Edit { from: 0, to: 5, insert: "HELLO".into() },
        Edit { from: 12, to: 18, insert: "2nd".into() },
        Edit { from: 0, to: 0, insert: "# ".into() },
    ]);
    relay(&mut a, &mut b);
    for c in b.take_changes() {
        apply_edits(&mut mirror, &c.edits);
    }
    assert_eq!(mirror, a.text());
    assert_eq!(mirror, b.text());
}

#[test]
fn concurrent_edits_at_the_same_spot_converge() {
    let mut a = YrsStore::new(1);
    let mut b = YrsStore::new(2);
    a.replace(0, 0, "abc");
    relay(&mut a, &mut b);
    a.replace(1, 1, "XX");
    b.replace(1, 2, "YY");
    let ua = a.take_updates();
    let ub = b.take_updates();
    for u in &ub {
        a.apply_remote_update(u).unwrap();
    }
    for u in &ua {
        b.apply_remote_update(u).unwrap();
    }
    assert_eq!(a.text(), b.text());
    assert!(a.text().contains("XX") && a.text().contains("YY") && !a.text().contains('b'));
}

#[test]
fn undo_tracks_local_groups_only_and_survives_remote_edits() {
    let mut a = YrsStore::new(1);
    let mut b = YrsStore::new(2);
    b.replace(0, 0, "line\n");
    relay(&mut b, &mut a);
    a.take_changes();

    // group 1: "foo" typed in three transactions
    a.will_edit(5, 5, "input");
    a.replace(5, 5, "f");
    a.did_edit(6, 6);
    a.replace(6, 6, "o");
    a.did_edit(7, 7);
    a.replace(7, 7, "o");
    a.did_edit(8, 8);
    a.stop_capturing();
    // group 2: " bar"
    a.will_edit(8, 8, "input");
    a.replace(8, 8, " bar");
    a.did_edit(12, 12);
    a.stop_capturing();
    assert_eq!(a.undo_depth(), (2, 0));
    relay(&mut a, &mut b);

    // remote edit before our text, then undo
    b.replace(0, 0, ">> ");
    relay(&mut b, &mut a);
    a.take_changes();
    assert_eq!(a.text(), ">> line\nfoo bar");

    let r = a.undo().unwrap();
    assert_eq!(a.text(), ">> line\nfoo");
    assert_eq!(r.edits, vec![Edit { from: 11, to: 15, insert: String::new() }]);
    assert_eq!(r.sel, Some((11, 11)), "selection before ' bar', mapped through the remote insert");
    let r = a.undo().unwrap();
    assert_eq!(a.text(), ">> line\n");
    assert_eq!(r.sel, Some((8, 8)));
    assert!(a.undo().is_none(), "remote edits are never undone");
    assert_eq!(a.text(), ">> line\n");

    // remote edit between undo and redo
    relay(&mut a, &mut b);
    b.replace(0, 3, "");
    relay(&mut b, &mut a);
    let r = a.redo().unwrap();
    assert_eq!(a.text(), "line\nfoo");
    assert_eq!(r.edits, vec![Edit { from: 5, to: 5, insert: "foo".into() }]);
    let r = a.redo().unwrap();
    assert_eq!(a.text(), "line\nfoo bar");
    assert_eq!(r.edits, vec![Edit { from: 8, to: 8, insert: " bar".into() }]);
    relay(&mut a, &mut b);
    assert_eq!(b.text(), a.text());
    // undo changes are reported to the other side as ordinary remote edits
    assert!(b.take_changes().iter().all(|c| c.kind == ChangeKind::Remote));
}

#[test]
fn a_new_local_edit_clears_redo() {
    let mut a = YrsStore::new(1);
    a.replace(0, 0, "abc");
    a.stop_capturing();
    a.undo().unwrap();
    assert!(a.can_redo());
    a.replace(0, 0, "x");
    assert!(!a.can_redo());
}

#[test]
fn sticky_index_json_matches_yjs() {
    let mut a = YrsStore::new(7);
    a.replace(0, 0, "abc");
    // Yjs: createRelativePositionFromTypeIndex(text, 1, -1) → item = id of 'a' (clock 0), assoc -1
    let v = serde_json::to_value(a.sticky(1, Assoc::Before)).unwrap();
    assert_eq!(v, json!({ "item": { "client": 7, "clock": 0 }, "assoc": -1 }));
    let v = serde_json::to_value(a.sticky(1, Assoc::After)).unwrap();
    assert_eq!(v, json!({ "item": { "client": 7, "clock": 1 }, "assoc": 0 }));
    // end of text, assoc 0: Yjs uses the type ({ tname: "md" })
    let v = serde_json::to_value(a.sticky(3, Assoc::After)).unwrap();
    assert_eq!(v, json!({ "tname": "md", "assoc": 0 }));
    // start, assoc -1: also the type
    let v = serde_json::to_value(a.sticky(0, Assoc::Before)).unwrap();
    assert_eq!(v, json!({ "tname": "md", "assoc": -1 }));
    // what the JS client sends (relativePositionToJSON omits nulls; tolerate explicit nulls too)
    let js: yrs::StickyIndex = serde_json::from_value(json!({ "type": null, "tname": null, "item": { "client": 7, "clock": 2 }, "assoc": -1 })).unwrap();
    assert_eq!(a.resolve(&js), Some(3));
}

fn control(msg: serde_json::Value) -> Vec<u8> {
    let mut v = vec![MSG_CONTROL];
    let s = msg.to_string();
    // varuint length (short strings)
    assert!(s.len() < 128);
    v.push(s.len() as u8);
    v.extend_from_slice(s.as_bytes());
    v
}

#[test]
fn session_handshake_and_awareness() {
    let mut s = Session::new(YrsStore::new(42), json!({ "name": "Rust" }));
    // ignored before hello
    assert!(s.receive(&awareness_frame(5, 1, "{}")).unwrap().is_empty());
    let ev = s.receive(&control(json!({ "t": "hello", "generation": "g1", "readOnly": false }))).unwrap();
    assert!(matches!(ev[0], Event::Hello { .. }));
    let out = s.take_outgoing();
    assert_eq!(out[0][..2], [0, 0], "sync step 1");
    assert_eq!(out[1][0], 1, "awareness");

    // server step1/step2 via a server-side store
    let mut server = YrsStore::new(9);
    server.replace(0, 0, "# Welcome\n");
    let mut step2 = vec![0u8, 1];
    let diff = server.diff(&yrs::StateVector::default());
    yrs::encoding::write::Write::write_buf(&mut step2, &diff);
    let ev = s.receive(&step2).unwrap();
    assert!(matches!(&ev[0], Event::Changes(c) if c[0].edits[0].insert == "# Welcome\n"));
    assert!(matches!(ev[1], Event::Synced));
    assert_eq!(s.store.text(), "# Welcome\n");

    // remote cursor in the JS format
    let cur = json!({ "user": { "name": "Ann", "color": "#f00" }, "cursor": { "anchor": { "item": { "client": 9, "clock": 1 }, "assoc": -1 }, "head": { "item": { "client": 9, "clock": 1 }, "assoc": -1 } } });
    s.receive(&awareness_frame(77, 1, &cur.to_string())).unwrap();
    let c = s.remote_cursors();
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].anchor, c[0].head), (Some(2), Some(2)));

    // local edit → one update frame
    s.store.replace(10, 10, "hi");
    let out = s.take_outgoing();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0][..2], [0, 2]);
}

/// yrs 0.28 bug: `Store::follow_redone` drops the offset inside the redone block (Yjs's followRedone keeps
/// it as `diff`), so a sticky index into the middle of re-inserted text resolves to the block's start.
/// The caret saved after "foo" comes back after "f". Fix: carry `slice.start` into the redone id.
#[test]
#[ignore = "yrs follow_redone bug"]
fn redo_restores_selection_inside_redone_text() {
    let mut a = YrsStore::new(1);
    a.will_edit(0, 0, "input");
    a.replace(0, 0, "foo");
    a.did_edit(3, 3);
    a.stop_capturing();
    a.undo().unwrap();
    let r = a.redo().unwrap();
    assert_eq!(a.text(), "foo");
    assert_eq!(r.sel, Some((3, 3)));
}
