//! An in-process room server for tests and demos: a yrs doc that answers like a Grimoire room (hello, sync
//! step 1/2, updates and awareness relayed to the other connections). Apps use it to exercise their
//! `CollabEditor` shell without a network (the native app's headless remote demo and its unit tests).

use serde_json::json;
use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::SyncMessage;
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};

use crate::protocol::{MSG_AWARENESS, MSG_CONTROL, MSG_SYNC, control_frame};
use crate::store::YrsStore;

pub struct Relay {
    doc: YrsStore,
    pub generation: String,
    pub read_only: bool,
}

impl Relay {
    pub fn new(text: &str) -> Relay {
        let mut doc = YrsStore::without_undo(999);
        doc.replace(0, 0, text);
        doc.take_updates();
        Relay { doc, generation: "g1".into(), read_only: false }
    }

    /// The room's text.
    pub fn text(&self) -> String {
        self.doc.text()
    }

    /// What a new connection gets: hello, then the room's step 1.
    pub fn greet(&self) -> Vec<Vec<u8>> {
        let hello = control_frame(&json!({
            "t": "hello", "generation": self.generation, "readOnly": self.read_only,
            "dirty": false, "saving": false, "commit": "c0", "savedAt": null,
        }));
        vec![hello, sync_frame(SyncMessage::SyncStep1(self.doc.state_vector()))]
    }

    /// A frame from a client: (the reply to it, what to broadcast to the other connections). Malformed frames
    /// and updates from read-only rooms are dropped.
    pub fn handle(&mut self, frame: &[u8]) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
        let mut dec = DecoderV1::new(Cursor::new(frame));
        let Ok(tag) = dec.read_var::<u8>() else { return (vec![], vec![]) };
        match tag {
            MSG_SYNC => match SyncMessage::decode(&mut dec) {
                Ok(SyncMessage::SyncStep1(sv)) => (vec![sync_frame(SyncMessage::SyncStep2(self.doc.diff(&sv)))], vec![]),
                Ok(SyncMessage::SyncStep2(u) | SyncMessage::Update(u)) if !self.read_only => {
                    if self.doc.apply_remote_update(&u).is_err() {
                        return (vec![], vec![]);
                    }
                    self.doc.take_changes();
                    (vec![], vec![sync_frame(SyncMessage::Update(u))])
                }
                _ => (vec![], vec![]),
            },
            MSG_AWARENESS => (vec![], vec![frame.to_vec()]),
            MSG_CONTROL => (vec![], vec![]),
            _ => (vec![], vec![]),
        }
    }
}

pub fn sync_frame(msg: SyncMessage) -> Vec<u8> {
    let mut enc = EncoderV1::new();
    enc.write_var(MSG_SYNC);
    msg.encode(&mut enc);
    enc.to_vec()
}
