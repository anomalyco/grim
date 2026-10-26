//! Phase C review findings (docs/rust-engine/review-C.md on the web repo): unsent/pre-sync races, malformed
//! frames, the clock passed to `receive`, embeds and split surrogate pairs from JS peers, awareness removal,
//! read-only, reset with focus, initial sync work.

use collab::protocol::{MSG_AWARENESS, MSG_SYNC, awareness_frame, control_frame};
use collab::{CollabEditor, Notice, YrsStore};
use serde_json::{Value, json};
use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::{AwarenessUpdate, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn sync_frame(msg: SyncMessage) -> Vec<u8> {
    let mut enc = EncoderV1::new();
    enc.write_var(MSG_SYNC);
    msg.encode(&mut enc);
    enc.to_vec()
}

fn hello(read_only: bool) -> Vec<u8> {
    control_frame(&json!({ "t": "hello", "generation": "g1", "readOnly": read_only, "dirty": false, "saving": false, "commit": null, "savedAt": null }))
}

fn user() -> Value {
    json!({ "id": "u1", "name": "Ann", "color": "#f80", "kind": "human" })
}

/// The sync messages in `frames` (sub type, payload).
fn syncs(frames: &[Vec<u8>]) -> Vec<SyncMessage> {
    frames
        .iter()
        .filter(|f| f[0] == MSG_SYNC)
        .map(|f| {
            let mut dec = DecoderV1::new(Cursor::new(&f[1..]));
            SyncMessage::decode(&mut dec).unwrap()
        })
        .collect()
}

fn awareness_states(frames: &[Vec<u8>]) -> Vec<(u32, Value)> {
    frames
        .iter()
        .filter(|f| f[0] == MSG_AWARENESS)
        .flat_map(|f| {
            let mut dec = DecoderV1::new(Cursor::new(&f[1..]));
            let buf = dec.read_buf().unwrap();
            let u = AwarenessUpdate::decode_v1(buf).unwrap();
            u.clients.into_values().map(|e| (e.clock, serde_json::from_str::<Value>(&e.json).unwrap())).collect::<Vec<_>>()
        })
        .collect()
}

/// A server doc holding `text`, and an editor synced with it (hello + step1 + step2 delivered).
fn synced(text: &str, now: f64) -> (YrsStore, CollabEditor) {
    let mut server = YrsStore::without_undo(999);
    server.replace(0, 0, text);
    server.take_updates();
    let mut ed = CollabEditor::new(7, user());
    ed.connecting();
    ed.receive(&hello(false), now).unwrap();
    ed.receive(&sync_frame(SyncMessage::SyncStep1(server.state_vector())), now).unwrap();
    let sv = ed.session().store().state_vector();
    ed.receive(&sync_frame(SyncMessage::SyncStep2(server.diff(&sv))), now).unwrap();
    ed.take_outgoing(now);
    (server, ed)
}

// ---- 2. unsent / pre-sync races ----

#[test]
fn offline_edits_then_read_only_hello_resets_even_before_take_outgoing() {
    let (_server, mut ed) = synced("hello", 0.0);
    ed.disconnected(1006, "");
    ed.editor_mut().set_selection(editor_core::Sel::caret(5));
    ed.editor_mut().insert_text("!");
    // no take_outgoing yet: the edit is still pending in the store
    ed.connecting();
    let r = ed.receive(&hello(true), 1.0).unwrap();
    assert!(r.notices.contains(&Notice::Reset), "read-only hello with unsent edits resets: {:?}", r.notices);
}

#[test]
fn offline_edits_are_sent_once_in_step2_not_again_as_update() {
    let (server, mut ed) = synced("hello", 0.0);
    ed.disconnected(1006, "");
    ed.editor_mut().set_selection(editor_core::Sel::caret(5));
    ed.editor_mut().insert_text("!");
    ed.connecting();
    let mut out = ed.receive(&hello(false), 1.0).unwrap().outgoing;
    out.extend(ed.take_outgoing(1.0).frames);
    out.extend(ed.receive(&sync_frame(SyncMessage::SyncStep1(server.state_vector())), 2.0).unwrap().outgoing);
    out.extend(ed.take_outgoing(2.0).frames);
    let s = syncs(&out);
    let updates = s.iter().filter(|m| matches!(m, SyncMessage::Update(_))).count();
    let step2 = s.iter().filter(|m| matches!(m, SyncMessage::SyncStep2(_))).count();
    assert_eq!((step2, updates), (1, 0), "{s:?}");
}

#[test]
fn edits_between_hello_and_step1_go_out_with_step2() {
    let (server, mut ed) = synced("hello", 0.0);
    ed.disconnected(1006, "");
    ed.connecting();
    let mut out = ed.receive(&hello(false), 1.0).unwrap().outgoing;
    ed.editor_mut().set_selection(editor_core::Sel::caret(0));
    ed.editor_mut().insert_text("X");
    out.extend(ed.take_outgoing(1.0).frames);
    assert!(syncs(&out).iter().all(|m| !matches!(m, SyncMessage::Update(_))), "no update before step1 is answered");
    let out = ed.receive(&sync_frame(SyncMessage::SyncStep1(server.state_vector())), 2.0).unwrap().outgoing;
    let mut s2 = YrsStore::without_undo(5);
    s2.apply_remote_update(&server.diff(&yrs::StateVector::default())).unwrap();
    for m in syncs(&out) {
        if let SyncMessage::SyncStep2(u) = m {
            s2.apply_remote_update(&u).unwrap();
        }
    }
    assert_eq!(s2.text(), "Xhello");
}

#[test]
fn frames_lost_on_a_closing_socket_count_as_unsent() {
    let (_server, mut ed) = synced("hello", 0.0);
    ed.editor_mut().set_selection(editor_core::Sel::caret(5));
    ed.editor_mut().insert_text("!");
    // the shell couldn't send them (socket CLOSING)
    let _lost = ed.take_outgoing(1.0);
    ed.frames_lost();
    ed.disconnected(1006, "");
    ed.connecting();
    let r = ed.receive(&hello(true), 2.0).unwrap();
    assert!(r.notices.contains(&Notice::Reset));
}

#[test]
fn read_only_step1_from_a_server_missing_our_edits_resets() {
    // the update went out but never reached the server; the next connection is read-only
    let (server, mut ed) = synced("hello", 0.0);
    ed.editor_mut().set_selection(editor_core::Sel::caret(5));
    ed.editor_mut().insert_text("!");
    ed.take_outgoing(1.0);
    ed.disconnected(1006, "");
    ed.connecting();
    let r = ed.receive(&hello(true), 2.0).unwrap();
    assert!(!r.notices.contains(&Notice::Reset));
    let r = ed.receive(&sync_frame(SyncMessage::SyncStep1(server.state_vector())), 2.0).unwrap();
    assert!(r.notices.contains(&Notice::Reset), "{:?}", r.notices);
}

// ---- 3. malformed frames never panic ----

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

#[test]
fn random_and_truncated_frames_never_panic() {
    let (mut server, _) = synced("hello 😀 world", 0.0);
    // valid frames to mutate
    let mut seeds: Vec<Vec<u8>> = vec![hello(false), awareness_frame(5, 3, r#"{"user":{"id":"x"},"cursor":null}"#)];
    server.replace(3, 0, "abc");
    seeds.push(sync_frame(SyncMessage::Update(yrs::merge_updates_v1(server.take_updates()).unwrap())));
    seeds.push(sync_frame(SyncMessage::SyncStep2(server.diff(&yrs::StateVector::default()))));
    seeds.push(sync_frame(SyncMessage::SyncStep1(server.state_vector())));
    seeds.push(hex("0002010101000401026d640661f09f98806200"));
    let mut rng = Rng(0x9e3779b97f4a7c15);
    let mut panics = Vec::new();
    for i in 0..4000 {
        let base = &seeds[(rng.next() as usize) % seeds.len()];
        let mut f = base.clone();
        match i % 4 {
            0 => f.truncate((rng.next() as usize) % (f.len() + 1)),
            1 => {
                for _ in 0..1 + rng.next() % 4 {
                    let k = (rng.next() as usize) % f.len();
                    f[k] = rng.next() as u8;
                }
            }
            2 => f = (0..(rng.next() % 40)).map(|_| rng.next() as u8).collect(),
            _ => {
                let k = 1 + (rng.next() as usize) % (f.len().max(2) - 1);
                f.insert(k.min(f.len()), rng.next() as u8);
            }
        }
        let r = std::panic::catch_unwind(|| {
            let (_s, mut ed) = synced("hello 😀 world", 0.0);
            let _ = ed.receive(&f, 1.0);
            let _ = ed.take_outgoing(2.0);
            assert!(ed.is_consistent());
        });
        if r.is_err() {
            panics.push(f);
        }
    }
    let hexes: Vec<String> = panics.iter().take(5).map(|f| f.iter().map(|b| format!("{b:02x}")).collect()).collect();
    assert!(panics.is_empty(), "{} frames panicked, e.g. {hexes:?}", panics.len());
}

// ---- 4. the clock passed to receive ----

#[test]
fn hello_announces_once_with_a_fresh_clock() {
    let mut ed = CollabEditor::new(7, user());
    ed.connecting();
    ed.take_outgoing(0.0);
    let mut out = ed.receive(&hello(false), 100_000.0).unwrap().outgoing;
    out.extend(ed.take_outgoing(100_000.0).frames);
    assert_eq!(awareness_states(&out).len(), 1, "one announce on hello");
}

#[test]
fn peer_states_are_stamped_when_received() {
    let (_s, mut ed) = synced("x", 0.0);
    let st = json!({ "user": { "id": "u2", "name": "Bob", "color": "#00f" }, "cursor": null }).to_string();
    ed.receive(&awareness_frame(55, 1, &st), 14_000.0).unwrap();
    let o = ed.take_outgoing(40_000.0);
    assert!(!o.awareness, "not expired 26 s after it arrived");
    assert_eq!(ed.peers().len(), 1);
    let o = ed.take_outgoing(44_001.0);
    assert!(o.awareness);
    assert_eq!(ed.peers().len(), 0);
}

// ---- 5. embeds and split surrogate pairs from JS peers ----

const BASE: &str = "010101000401026d640661f09f98806200"; // client 1: "a😀b"
const SPLIT: &str = "01010200c401010102015800"; // client 2 inserts "X" at UTF-16 2 (inside the pair)
const DELHALF: &str = "000101010201"; // client 3 deletes UTF-16 2..3 (half the pair)
const EMBED: &str = "01010400c501000101097b22696d67223a317d00"; // client 4 inserts an embed at 1

fn synced_js() -> CollabEditor {
    let mut ed = CollabEditor::new(7, user());
    ed.connecting();
    ed.receive(&hello(false), 0.0).unwrap();
    ed.receive(&sync_frame(SyncMessage::SyncStep2(hex(BASE))), 0.0).unwrap();
    ed.take_outgoing(0.0);
    assert_eq!(ed.editor().text(), "a😀b");
    ed
}

/// Type something (undo history), apply a JS update, check the editor stays consistent without a rebuild.
fn remote_keeps_undo(update: &str) -> CollabEditor {
    let mut ed = synced_js();
    let end = ed.editor().text().len();
    ed.editor_mut().set_selection(editor_core::Sel::caret(end));
    ed.editor_mut().insert_text("z");
    ed.take_outgoing(1.0);
    let r = ed.receive(&sync_frame(SyncMessage::Update(hex(update))), 2.0).unwrap();
    assert!(ed.is_consistent(), "editor {:?} vs yrs {:?}", ed.editor().text(), ed.session().store().text());
    assert!(!r.reloaded, "no rebuild");
    assert!(ed.editor().can_undo(), "undo history kept");
    ed
}

#[test]
fn js_insert_inside_a_surrogate_pair_keeps_the_editor_consistent() {
    remote_keeps_undo(SPLIT);
}

#[test]
fn js_delete_of_half_a_surrogate_pair_keeps_the_editor_consistent() {
    remote_keeps_undo(DELHALF);
}

#[test]
fn js_edits_at_any_utf16_offset_keep_the_editor_consistent() {
    // tests/fixtures/js_surrogates.txt: (base doc, JS Yjs update with inserts / deletes at random UTF-16 offsets,
    // inside surrogate pairs too), made with the yjs package
    let mut bad = Vec::new();
    for (i, line) in include_str!("fixtures/js_surrogates.txt").lines().enumerate() {
        let (base, upd) = line.split_once(' ').unwrap();
        let mut ed = CollabEditor::new(7, user());
        ed.connecting();
        ed.receive(&hello(false), 0.0).unwrap();
        ed.receive(&sync_frame(SyncMessage::SyncStep2(hex(base))), 0.0).unwrap();
        let end = ed.editor().text().len();
        ed.editor_mut().set_selection(editor_core::Sel::caret(end));
        ed.editor_mut().insert_text("z");
        ed.take_outgoing(1.0);
        let r = ed.receive(&sync_frame(SyncMessage::Update(hex(upd))), 2.0).unwrap();
        if r.reloaded || !ed.is_consistent() || !ed.editor().can_undo() {
            bad.push(i);
        }
    }
    assert!(bad.is_empty(), "{} cases rebuilt / diverged: {bad:?}", bad.len());
}

#[test]
fn embeds_keep_offsets_consistent() {
    let mut ed = remote_keeps_undo(EMBED);
    // a local edit after the embed lands at the same place in yrs
    let end = ed.editor().text().len();
    ed.editor_mut().set_selection(editor_core::Sel::caret(end));
    ed.editor_mut().insert_text("!");
    assert!(ed.is_consistent(), "editor {:?} vs yrs {:?}", ed.editor().text(), ed.session().store().text());
}

// ---- 7. remote removal of our awareness state ----

#[test]
fn a_remote_removal_of_our_state_is_answered_with_a_re_announce() {
    let (_s, mut ed) = synced("x", 0.0);
    let me = ed.client_id();
    let out = ed.receive(&awareness_frame(me, 50, "null"), 1.0).unwrap().outgoing;
    let st = awareness_states(&out);
    assert_eq!(st.len(), 1, "re-announced");
    assert!(st[0].0 > 50 && !st[0].1.is_null());
    // a clock at u32::MAX doesn't overflow
    let out = ed.receive(&awareness_frame(me, u32::MAX, "null"), 2.0).unwrap().outgoing;
    assert_eq!(awareness_states(&out)[0].0, u32::MAX);
}

// ---- 11. local read-only on a collab engine ----

#[test]
fn local_read_only_blocks_edits_on_a_writable_room() {
    let (_s, mut ed) = synced("hello", 0.0);
    ed.set_local_read_only(true);
    ed.editor_mut().insert_text("x");
    assert_eq!(ed.editor().text(), "hello");
    // a hello (writable) keeps it read-only
    ed.disconnected(1006, "");
    ed.connecting();
    ed.receive(&hello(false), 1.0).unwrap();
    assert!(ed.editor().is_read_only());
    ed.set_local_read_only(false);
    assert!(!ed.editor().is_read_only());
}

// ---- 12. reset keeps the focused cursor ----

#[test]
fn reset_while_focused_announces_a_cursor_not_null() {
    let (_s, mut ed) = synced("hello", 0.0);
    ed.set_focused(true, 1.0);
    ed.receive(&control_frame(&json!({ "t": "hello", "generation": "g2", "readOnly": false })), 2.0).unwrap();
    ed.reset(8);
    ed.connecting();
    let mut out = ed.receive(&hello(false), 3.0).unwrap().outgoing;
    out.extend(ed.take_outgoing(3.0).frames);
    let st = awareness_states(&out);
    assert!(!st.is_empty());
    assert!(st.iter().all(|(_, s)| !s["cursor"].is_null()), "{st:?}");
}

// ---- 8. initial sync ----

#[test]
fn initial_sync_does_not_apply_the_remote_changes_before_rebuilding() {
    let (_, ed) = synced("# big\n".repeat(10).as_str(), 0.0);
    assert_eq!(ed.remote_applies(), 0, "the sync rebuilds the editor instead of applying the edits first");
}

// ---- 3b. structured fuzz: crafted (well-formed but bogus) updates ----

/// A crafted v1 update: random structs (GC, Skip, Deleted, String, Embed) with small clocks / lengths
/// (zero included), random origins, and a random delete set.
fn crafted_update(rng: &mut Rng) -> Vec<u8> {
    let clients = [1u64, 5, 7, 999];
    let mut enc = EncoderV1::new();
    let n_clients = 1 + rng.next() % 2;
    enc.write_var(n_clients);
    for _ in 0..n_clients {
        let n = 1 + rng.next() % 3;
        enc.write_var(n);
        enc.write_var(clients[(rng.next() % 4) as usize]);
        enc.write_var(rng.next() % 6);
        for _ in 0..n {
            let small = |r: &mut Rng| r.next() % 4;
            match rng.next() % 6 {
                0 => {
                    enc.write_u8(0);
                    enc.write_var(small(rng));
                }
                1 => {
                    enc.write_u8(10);
                    enc.write_var(small(rng));
                }
                k => {
                    let content = [1u8, 4, 4, 5][(k - 2) as usize];
                    let origin = rng.next().is_multiple_of(2);
                    let right = rng.next().is_multiple_of(2);
                    enc.write_u8(content | if origin { 0x80 } else { 0 } | if right { 0x40 } else { 0 });
                    if origin {
                        enc.write_var(clients[(rng.next() % 4) as usize]);
                        enc.write_var(rng.next() % 8);
                    }
                    if right {
                        enc.write_var(clients[(rng.next() % 4) as usize]);
                        enc.write_var(rng.next() % 8);
                    }
                    if !origin && !right {
                        enc.write_var(1u8);
                        enc.write_string(if rng.next().is_multiple_of(4) { "other" } else { "md" });
                    }
                    match content {
                        1 => enc.write_var(small(rng)),
                        4 => enc.write_string(["", "a", "😀", "xy"][(rng.next() % 4) as usize]),
                        _ => enc.write_string("{\"a\":1}"),
                    }
                }
            }
        }
    }
    let n_del = rng.next() % 2;
    enc.write_var(n_del);
    for _ in 0..n_del {
        enc.write_var(clients[(rng.next() % 4) as usize]);
        enc.write_var(1u8);
        enc.write_var(rng.next() % 8);
        enc.write_var(rng.next() % 4);
    }
    enc.to_vec()
}

#[test]
fn crafted_updates_never_panic() {
    let mut rng = Rng(0x2545f4914f6cdd1d);
    let mut panics: Vec<(String, String)> = Vec::new();
    std::panic::set_hook(Box::new(|_| {}));
    let iters: usize = std::env::var("FUZZ_N").ok().and_then(|v| v.parse().ok()).unwrap_or(3000);
    for i in 0..iters {
        let updates: Vec<Vec<u8>> = (0..1 + rng.next() % 3).map(|_| crafted_update(&mut rng)).collect();
        let step2 = i % 2 == 0;
        let r = std::panic::catch_unwind(|| {
            let (_s, mut ed) = synced("hello 😀 world", 0.0);
            for u in &updates {
                let f = sync_frame(if step2 { SyncMessage::SyncStep2(u.clone()) } else { SyncMessage::Update(u.clone()) });
                let _ = ed.receive(&f, 1.0);
                let _ = ed.take_outgoing(2.0);
                ed.editor_mut().insert_text("q");
                let _ = ed.take_outgoing(3.0);
                assert!(ed.is_consistent(), "consistent");
            }
        });
        if let Err(e) = r {
            let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            let hex: Vec<String> = updates.iter().map(|u| u.iter().map(|b| format!("{b:02x}")).collect()).collect();
            panics.push((msg, hex.join(" ")));
        }
    }
    let _ = std::panic::take_hook();
    let mut kinds: Vec<&str> = panics.iter().map(|(m, _)| m.as_str()).collect();
    kinds.sort();
    kinds.dedup();
    for k in &kinds {
        let ex = panics.iter().find(|(m, _)| m == k).unwrap();
        eprintln!("PANIC {k:?} e.g. {}", ex.1);
    }
    assert!(panics.is_empty(), "{} crafted updates panicked ({} kinds)", panics.len(), kinds.len());
}

#[test]
#[ignore]
fn one_crafted() {
    let (_s, mut ed) = synced("hello 😀 world", 0.0);
    for u in std::env::var("UPD").unwrap().split(' ') {
        let _ = ed.receive(&sync_frame(SyncMessage::SyncStep2(hex(u))), 1.0);
        ed.take_outgoing(2.0);
        ed.editor_mut().insert_text("q");
        ed.take_outgoing(3.0);
    }
}
