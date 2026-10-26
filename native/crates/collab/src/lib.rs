//! Multiplayer for the editor engine: a Yjs-compatible text store (yrs) and Grimoire's WebSocket protocol.
//! Spike for phase C (see docs/rust-engine/yrs.md in the web repo).

pub mod protocol;
pub mod store;

pub use protocol::{Event, RemoteCursor, Session};
pub use store::{Change, ChangeKind, Edit, SelRel, UndoResult, YrsStore};

#[cfg(test)]
mod tests;
