//! yrs 0.28 bug (upstream): updates from one peer applied out of order don't always integrate once the gap
//! is filled (structs stay pending; Yjs integrates them). Not reachable over Grimoire's WebSocket: the
//! server relays updates in order, so a client never holds pending structs (the convergence fuzz in
//! editor.rs therefore keeps each channel FIFO). Kept as a record for when yrs is upgraded.
use collab::YrsStore;

#[test]
#[ignore = "yrs 0.28 pending-update bug"]
fn out_of_order_updates_from_one_peer_converge() {
    let mut a = YrsStore::without_undo(1);
    let mut ups = vec![];
    for p in [0, 1, 1, 0] {
        a.replace(p, p, "ab");
        ups.extend(a.take_updates());
    }
    assert_eq!(a.text(), "abaababb");
    let mut b = YrsStore::without_undo(2);
    for i in [2, 0, 3, 1] {
        b.apply_remote_update(&ups[i]).unwrap();
    }
    assert_eq!(b.text(), "abaababb"); // yrs 0.28.0: "abaabb"
}
