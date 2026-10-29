//! A note over a v2 workspace socket: `CollabEditor` + `mux::WorkspaceClient` against `relay::MuxFake`.

use collab::mux::{MuxEvent, WorkspaceClient};
use collab::relay::{MuxFake, Relay};
use collab::{AfterClose, CollabEditor};
use serde_json::json;

struct Client {
    mux: WorkspaceClient,
    eds: Vec<(String, CollabEditor)>,
    now: f64,
}

impl Client {
    fn ed(&mut self, path: &str) -> &mut CollabEditor {
        &mut self.eds.iter_mut().find(|e| e.0 == path).unwrap().1
    }

    /// Feed server frames; returns the events that aren't frames, and queues the editors' replies on the socket.
    fn receive(&mut self, frames: Vec<Vec<u8>>) -> Vec<MuxEvent> {
        let mut other = Vec::new();
        for f in frames {
            for ev in self.mux.receive(&f) {
                match ev {
                    MuxEvent::Frame { path, body } => {
                        let now = self.now;
                        let out = self.ed(&path).receive(&body, now).unwrap().outgoing;
                        for o in out {
                            self.mux.send(&path, &o);
                        }
                    }
                    e => other.push(e),
                }
            }
        }
        other
    }

    fn flush(&mut self, path: &str) {
        let now = self.now;
        let out = self.ed(path).take_outgoing(now).frames;
        for o in out {
            self.mux.send(path, &o);
        }
    }
}

/// Run the socket until nothing moves.
fn settle(c: &mut Client, s: &mut MuxFake, rooms: &mut [(String, Relay)]) -> Vec<MuxEvent> {
    let mut events = Vec::new();
    loop {
        let out = c.mux.take_outgoing();
        if out.is_empty() {
            return events;
        }
        let mut back = Vec::new();
        for f in out {
            back.extend(s.handle(&f, rooms).0);
        }
        events.extend(c.receive(back));
    }
}

#[test]
fn one_round_trip_to_the_text_and_no_edits_lost_across_a_reconnect() {
    let mut rooms = vec![("a.md".to_string(), Relay::new("# A\n")), ("b.md".to_string(), Relay::new("# B\n"))];
    let mut s = MuxFake::new(json!({ "id": "u", "name": "U" }));
    let mut c = Client { mux: WorkspaceClient::new(), eds: Vec::new(), now: 0.0 };
    for p in ["a.md", "b.md"] {
        let mut e = CollabEditor::new(7, json!({ "id": "u", "name": "U" }));
        e.connecting();
        c.eds.push((p.into(), e));
    }
    // welcome: the server's timing goes to the editors
    let ev = c.receive(vec![s.welcome()]);
    let MuxEvent::Welcome(w) = &ev[0] else { panic!() };
    for e in &mut c.eds {
        e.1.set_awareness_timing(w.renew_ms, w.awareness_timeout_ms);
    }
    c.mux.open("a.md", false, false, None);
    c.mux.open("b.md", true, false, None);
    // one flight out; the text arrives with the replies (hello + step 2 right after opened)
    let out = c.mux.take_outgoing();
    assert_eq!(out.len(), 2, "both opens in one flight");
    let mut back = Vec::new();
    for f in out {
        back.extend(s.handle(&f, &mut rooms).0);
    }
    c.receive(back);
    assert_eq!(c.ed("a.md").editor().text(), "# A\n", "the text after one round trip");
    assert_eq!(c.ed("b.md").editor().text(), "# B\n");
    settle(&mut c, &mut s, &mut rooms);
    assert_eq!(c.ed("a.md").awareness_timing(), (300_000.0, 720_000.0));

    // offline edit: the socket drops, the note is edited, then a reconnect reopens every note with its sv
    c.mux.disconnected();
    s.disconnect();
    for e in &mut c.eds {
        assert!(matches!(e.1.disconnected(1006, ""), AfterClose::Retry { .. }));
    }
    let end = c.ed("a.md").editor().text().len();
    c.ed("a.md").editor_mut().set_selection(editor_core::Sel::caret(end));
    c.ed("a.md").editor_mut().insert_text("offline");
    c.flush("a.md");
    assert!(c.mux.take_outgoing().is_empty(), "nothing goes out while away");
    let opens = s.opens.len();
    let svs: Vec<(String, Vec<u8>)> = c.eds.iter().map(|e| (e.0.clone(), e.1.state_vector())).collect();
    c.receive(vec![s.welcome()]);
    for e in &mut c.eds {
        e.1.connecting();
    }
    c.mux.reopen_all(|p| svs.iter().find(|x| x.0 == p).map(|x| x.1.clone()));
    settle(&mut c, &mut s, &mut rooms);
    assert_eq!(&s.opens[opens..], &[("a.md".to_string(), true), ("b.md".to_string(), true)], "reopened with their svs");
    assert_eq!(rooms[0].1.text(), "# A\noffline", "the offline edit reached the room");
    assert!(s.channel("b.md").is_some());

    // end 1013 (the room was reset): the shell reopens with its sv on a new channel
    let old = s.channel("a.md").unwrap();
    let ev = c.receive(s.end("a.md", 1013, "reset"));
    assert_eq!(ev, vec![MuxEvent::End { path: "a.md".into(), code: 1013, reason: "reset".into() }]);
    let sv = c.ed("a.md").state_vector();
    c.mux.open("a.md", false, false, Some(&sv));
    settle(&mut c, &mut s, &mut rooms);
    assert!(s.channel("a.md").is_some_and(|ch| ch != old), "a new channel id");
}

#[test]
fn a_hidden_note_sends_no_awareness_until_shown() {
    let mut rooms = vec![("a.md".to_string(), Relay::new("x"))];
    let mut s = MuxFake::new(json!({ "id": "u", "name": "U" }));
    let mut c = Client { mux: WorkspaceClient::new(), eds: Vec::new(), now: 0.0 };
    let mut e = CollabEditor::new(7, json!({ "id": "u", "name": "U" }));
    e.connecting();
    c.eds.push(("a.md".into(), e));
    c.receive(vec![s.welcome()]);
    c.mux.open("a.md", true, false, None);
    // count what reaches the room: no awareness from a hidden channel
    let mut awareness = 0;
    for _ in 0..3 {
        let out = c.mux.take_outgoing();
        awareness += out.iter().filter(|f| collab::mux::decode_frame(f).is_some_and(|(ch, b)| ch > 0 && b[0] == 1)).count();
        let mut back = Vec::new();
        for f in out {
            back.extend(s.handle(&f, &mut rooms).0);
        }
        c.receive(back);
    }
    assert_eq!(awareness, 0, "hidden: no awareness");
    // shown: its awareness goes (focus publishes the caret)
    c.mux.view("a.md", false);
    c.ed("a.md").rejoin();
    let out = c.ed("a.md").set_focused(true, 100.0);
    for o in out {
        c.mux.send("a.md", &o);
    }
    let out = c.mux.take_outgoing();
    assert!(out.iter().any(|f| collab::mux::decode_control(&f[1..]).is_some_and(|m| m["t"] == "view")));
    assert!(out.iter().any(|f| collab::mux::decode_frame(f).is_some_and(|(ch, b)| ch > 0 && b[0] == 1)), "awareness once shown");
}
