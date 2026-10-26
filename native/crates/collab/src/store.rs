//! `YrsStore`: the note's Markdown as a yrs `Text` named "md", counted in UTF-16 code units (like Yjs and the
//! DOM), with local-origin tagging, remote/undo change reporting as `(from, to, insert)` edits, outgoing
//! update capture, and an UndoManager driven by explicit group boundaries.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;

use yrs::types::Delta;
use yrs::undo::{Options as UndoOptions, UndoManager};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Assoc, ClientID, Doc, GetString, IndexScope, IndexedSequence, Observable, OffsetKind, Options, Origin,
    Out, ReadTxn, StateVector, StickyIndex, Text, TextRef, Transact, Update,
};

/// Name of the shared text (the server's `TEXT_NAME`).
pub const TEXT_NAME: &str = "md";
/// Origin of transactions made by the local editor (tracked by undo).
pub const LOCAL: &str = "local";
/// Origin of updates applied from the server (never sent back, never undoable).
pub const REMOTE: &str = "remote";

/// A text change in UTF-16 code units. A list of edits applies in order: each edit's offsets refer to the text
/// after the edits before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Remote,
    Undo,
    Redo,
}

/// A change the local editor didn't make itself (remote update, or text changed by undo/redo).
#[derive(Clone, Debug)]
pub struct Change {
    pub kind: ChangeKind,
    pub edits: Vec<Edit>,
}

/// A selection as positions that move with concurrent edits.
#[derive(Clone, Debug)]
pub struct SelRel {
    pub anchor: StickyIndex,
    pub head: StickyIndex,
    /// Fallback when the sticky indices can't be resolved.
    pub abs: (u32, u32),
}

/// Per undo-group metadata (history.ts's "sel" / "after" / "kind").
#[derive(Default, Debug)]
pub struct UndoMeta {
    /// Selection before the group's first edit (restored by undo).
    pub before: Option<SelRel>,
    /// Selection after the group's last edit (restored by redo). Shared so did_edit can fill it in after
    /// the transaction that created or extended the item.
    pub after: Rc<RefCell<Option<SelRel>>>,
    pub kind: String,
}

#[derive(Default)]
struct Shared {
    changes: Vec<Change>,
    updates: Vec<Vec<u8>>,
    popping: Option<ChangeKind>,
    /// For the next stack item: selection before / after and kind.
    sel_before: Option<SelRel>,
    sel_after: Option<SelRel>,
    kind: String,
    /// "after" cell of the item the last local edit went into.
    last_after: Option<Rc<RefCell<Option<SelRel>>>>,
    /// Selection to restore, set when an item is popped.
    restored: Option<SelRel>,
}

pub struct YrsStore {
    doc: Doc,
    text: TextRef,
    /// yrs's UndoManager (the spike's undo). `None` for stores driven by editor-core's own History.
    undo: Option<UndoManager<UndoMeta>>,
    shared: Rc<RefCell<Shared>>,
}

/// Result of undo/redo: the text edits it made and the selection to restore.
#[derive(Debug)]
pub struct UndoResult {
    pub edits: Vec<Edit>,
    pub sel: Option<(u32, u32)>,
}

impl YrsStore {
    /// `client_id` must fit in a uint32 (the Grimoire server ignores awareness ids >= 2^32) and be random per
    /// session; in wasm pass one from `crypto.getRandomValues` (yrs's own RNG may not be seeded there).
    pub fn new(client_id: u32) -> Self {
        Self::build(client_id, true)
    }

    /// A store without yrs's UndoManager (undo is editor-core's `History`, whose undo/redo are ordinary
    /// local edits). The undo methods below do nothing on it.
    pub fn without_undo(client_id: u32) -> Self {
        Self::build(client_id, false)
    }

    fn build(client_id: u32, with_undo: bool) -> Self {
        let mut opts = Options::with_client_id(ClientID::new(client_id as u64));
        opts.offset_kind = OffsetKind::Utf16;
        let doc = Doc::with_options(opts);
        let text = doc.get_or_insert_text(TEXT_NAME);
        let shared = Rc::new(RefCell::new(Shared::default()));
        let undo = with_undo.then(|| Self::undo_manager(&doc, &text, &shared));
        let undo_origin = undo.as_ref().map(|u| u.as_origin());

        let s = shared.clone();
        text.observe("collab", move |txn, ev| {
            let origin = txn.origin();
            if origin == Some(&Origin::from(LOCAL)) {
                return;
            }
            let mut sh = s.borrow_mut();
            let kind = if undo_origin.is_some() && origin == undo_origin.as_ref() {
                sh.popping.unwrap_or(ChangeKind::Undo)
            } else {
                ChangeKind::Remote
            };
            let edits = delta_to_edits(ev.delta(txn));
            if !edits.is_empty() {
                sh.changes.push(Change { kind, edits });
            }
        });
        let s = shared.clone();
        doc.observe_update_v1("collab", move |txn, e| {
            if txn.origin() != Some(&Origin::from(REMOTE)) {
                s.borrow_mut().updates.push(e.update.clone());
            }
        })
        .expect("observe updates");

        YrsStore { doc, text, undo, shared }
    }

    fn undo_manager(doc: &Doc, text: &TextRef, shared: &Rc<RefCell<Shared>>) -> UndoManager<UndoMeta> {
        let mut tracked = HashSet::new();
        tracked.insert(Origin::from(LOCAL));
        let mut undo = UndoManager::with_options(UndoOptions {
            // Never merge by time: groups end only at stop_capturing() (history.ts: captureTimeout = MAX).
            // The clock must be non-zero (last_change == 0 means "boundary").
            capture_timeout_millis: u64::MAX,
            tracked_origins: tracked,
            capture_transaction: None,
            timestamp: Arc::new(|| 1u64),
            init_undo_stack: Vec::new(),
            init_redo_stack: Vec::new(),
        });
        undo.expand_scope(doc, text);

        let s = shared.clone();
        undo.observe_item_added("collab", move |_txn: &yrs::TransactionMut, e: &mut yrs::undo::Event<UndoMeta>| {
            let mut sh = s.borrow_mut();
            let meta = e.meta_mut();
            if meta.before.is_none() {
                meta.before = sh.sel_before.take();
            }
            if let Some(after) = sh.sel_after.take() {
                *meta.after.borrow_mut() = Some(after);
            }
            meta.kind = std::mem::take(&mut sh.kind);
            sh.last_after = Some(meta.after.clone());
        });
        let s = shared.clone();
        undo.observe_item_updated("collab", move |_txn: &yrs::TransactionMut, e: &mut yrs::undo::Event<UndoMeta>| {
            let mut sh = s.borrow_mut();
            sh.sel_before = None;
            sh.last_after = Some(e.meta_mut().after.clone());
        });
        let s = shared.clone();
        undo.observe_item_popped("collab", move |_txn: &yrs::TransactionMut, e: &mut yrs::undo::Event<UndoMeta>| {
            let mut sh = s.borrow_mut();
            sh.restored = e.meta_mut().before.clone();
        });

        undo
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    pub fn client_id(&self) -> u64 {
        self.doc.client_id().get()
    }

    pub fn text(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }

    /// Length in UTF-16 code units.
    pub fn len(&self) -> u32 {
        self.text.len(&self.doc.transact())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Replace `from..to` (UTF-16) with `insert` as one local transaction.
    pub fn replace(&mut self, from: u32, to: u32, insert: &str) {
        self.apply_local(&[Edit { from, to, insert: insert.to_string() }]);
    }

    /// Apply edits (in order) as one local transaction.
    pub fn apply_local(&mut self, edits: &[Edit]) {
        let mut txn = self.doc.transact_mut_with(LOCAL);
        for e in edits {
            if e.to > e.from {
                self.text.remove_range(&mut txn, e.from, e.to - e.from);
            }
            if !e.insert.is_empty() {
                self.text.insert(&mut txn, e.from, &e.insert);
            }
        }
    }

    /// Apply a Yjs v1 update received from the server.
    pub fn apply_remote_update(&mut self, update: &[u8]) -> Result<(), String> {
        let u = Update::decode_v1(update).map_err(|e| e.to_string())?;
        let mut txn = self.doc.transact_mut_with(REMOTE);
        txn.apply_update(u).map_err(|e| e.to_string())
    }

    pub fn state_vector(&self) -> StateVector {
        self.doc.transact().state_vector()
    }

    /// Everything the holder of `sv` is missing (sync step 2 payload).
    pub fn diff(&self, sv: &StateVector) -> Vec<u8> {
        self.doc.transact().encode_diff_v1(sv)
    }

    /// Remote and undo/redo changes since the last call.
    pub fn take_changes(&mut self) -> Vec<Change> {
        std::mem::take(&mut self.shared.borrow_mut().changes)
    }

    /// Updates made here (local edits, undo/redo) not yet sent to the server.
    pub fn take_updates(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.shared.borrow_mut().updates)
    }

    // ---- positions ----

    /// A position that moves with edits. `Assoc::Before` sticks to the character before (a caret).
    pub fn sticky(&self, pos: u32, assoc: Assoc) -> StickyIndex {
        let txn = self.doc.transact();
        let pos = pos.min(self.text.len(&txn));
        self.text
            .sticky_index(&txn, pos, assoc)
            // yrs returns None for After at the very end; Yjs uses the type itself there.
            .unwrap_or_else(|| StickyIndex::new(IndexScope::Root(TEXT_NAME.into()), assoc))
    }

    pub fn resolve(&self, idx: &StickyIndex) -> Option<u32> {
        let txn = self.doc.transact();
        idx.get_offset(&txn).map(|o| o.index.min(self.text.len(&txn)))
    }

    /// history.ts / view.ts toRel: a caret sticks to the character before it; a selection's start sticks
    /// right and its end left.
    pub fn sel_rel(&self, anchor: u32, head: u32) -> SelRel {
        let collapsed = anchor == head;
        let fwd = anchor <= head;
        let a = if collapsed || !fwd { Assoc::Before } else { Assoc::After };
        let h = if collapsed || fwd { Assoc::Before } else { Assoc::After };
        SelRel { anchor: self.sticky(anchor, a), head: self.sticky(head, h), abs: (anchor, head) }
    }

    pub fn resolve_sel(&self, r: &SelRel) -> (u32, u32) {
        let len = self.len();
        let a = self.resolve(&r.anchor).unwrap_or(r.abs.0).min(len);
        let h = self.resolve(&r.head).unwrap_or(r.abs.1).min(len);
        (a, h)
    }

    // ---- undo ----

    /// Call before a local edit with the selection as it is now and the kind of edit; only the first edit of
    /// a group keeps its "before" selection.
    pub fn will_edit(&mut self, anchor: u32, head: u32, kind: &str) {
        let r = self.sel_rel(anchor, head);
        let mut sh = self.shared.borrow_mut();
        sh.sel_before = Some(r);
        sh.kind = kind.to_string();
    }

    /// Call after a local edit with the resulting selection.
    pub fn did_edit(&mut self, anchor: u32, head: u32) {
        let r = self.sel_rel(anchor, head);
        let mut sh = self.shared.borrow_mut();
        sh.sel_before = None;
        if let Some(cell) = sh.last_after.take() {
            *cell.borrow_mut() = Some(r);
        }
    }

    /// End the current undo group (history.ts stop()).
    pub fn stop_capturing(&mut self) {
        if let Some(u) = &mut self.undo {
            u.reset();
        }
    }

    pub fn can_undo(&self) -> bool {
        self.undo.as_ref().is_some_and(|u| u.can_undo())
    }

    pub fn can_redo(&self) -> bool {
        self.undo.as_ref().is_some_and(|u| u.can_redo())
    }

    pub fn undo_depth(&self) -> (usize, usize) {
        self.undo.as_ref().map_or((0, 0), |u| (u.undo_stack().len(), u.redo_stack().len()))
    }

    pub fn undo(&mut self) -> Option<UndoResult> {
        self.pop(ChangeKind::Undo)
    }

    pub fn redo(&mut self) -> Option<UndoResult> {
        self.pop(ChangeKind::Redo)
    }

    fn pop(&mut self, kind: ChangeKind) -> Option<UndoResult> {
        let undo = self.undo.as_mut()?;
        undo.reset();
        {
            // The inverse item (pushed during the pop, before the popped event) gets this item's selections
            // swapped, like history.ts pop().
            let top = match kind {
                ChangeKind::Undo => undo.undo_stack().last(),
                _ => undo.redo_stack().last(),
            };
            let mut sh = self.shared.borrow_mut();
            if let Some(top) = top {
                sh.sel_before = top.meta().after.borrow().clone();
                sh.sel_after = top.meta().before.clone();
                sh.kind = top.meta().kind.clone();
            }
            sh.popping = Some(kind);
        }
        let done = match kind {
            ChangeKind::Undo => undo.undo_blocking(),
            _ => undo.redo_blocking(),
        };
        undo.reset();
        let mut sh = self.shared.borrow_mut();
        sh.popping = None;
        let restored = sh.restored.take();
        sh.sel_before = None;
        sh.sel_after = None;
        sh.last_after = None;
        if !done {
            return None;
        }
        let mut edits = Vec::new();
        sh.changes.retain(|c| {
            if c.kind == kind {
                edits.extend(c.edits.iter().cloned());
                false
            } else {
                true
            }
        });
        drop(sh);
        let sel = restored.map(|r| self.resolve_sel(&r));
        Some(UndoResult { edits, sel })
    }
}

pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// A text delta as sequential edits, merging a delete and an insert at the same spot into one replace.
pub fn delta_to_edits(delta: &[Delta]) -> Vec<Edit> {
    let mut out: Vec<Edit> = Vec::new();
    let mut pos = 0u32;
    for d in delta {
        match d {
            Delta::Retain(n, _) => pos += n,
            Delta::Deleted(n) => {
                match out.last_mut() {
                    Some(last) if last.from + utf16_len(&last.insert) == pos => last.to += n,
                    _ => out.push(Edit { from: pos, to: pos + n, insert: String::new() }),
                }
            }
            Delta::Inserted(v, _) => {
                let s = match v {
                    Out::Any(Any::String(s)) => s.to_string(),
                    _ => "\u{FFFC}".to_string(),
                };
                let n = utf16_len(&s);
                match out.last_mut() {
                    Some(last) if last.from + utf16_len(&last.insert) == pos => last.insert.push_str(&s),
                    _ => out.push(Edit { from: pos, to: pos, insert: s }),
                }
                pos += n;
            }
        }
    }
    out
}

/// Apply sequential UTF-16 edits to a String (for mirrors and tests).
pub fn apply_edits(text: &mut String, edits: &[Edit]) {
    for e in edits {
        let from = utf16_to_byte(text, e.from);
        let to = utf16_to_byte(text, e.to);
        text.replace_range(from..to, &e.insert);
    }
}

/// UTF-16 offset -> byte offset (inside a surrogate pair: the start of its char), as editor-core.
pub fn utf16_to_byte(s: &str, u: u32) -> usize {
    editor_core::text::utf16_to_byte(s, u as usize)
}
