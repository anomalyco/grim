//! Multiplayer for the editor engine: a Yjs-compatible text store (yrs), Grimoire's WebSocket protocol, and
//! `CollabEditor`, editor-core's `Editor` on the shared document (see docs/rust-engine/yrs.md in the web repo).

pub mod blame;
pub mod editor;
pub mod protocol;
pub mod relay;
pub mod store;
pub mod validate;

pub use blame::{Blame, BlameAuthor};
pub use editor::{AfterClose, CollabEditor, CollabStore, ConnStatus, Notice, Outgoing, PeerCursor, Received};
pub use protocol::{Event, RemoteCursor, Session, SharedStore};
pub use store::{Change, ChangeKind, Edit, SelRel, UndoResult, YrsStore, recover_local_updates};

#[cfg(test)]
mod tests;
