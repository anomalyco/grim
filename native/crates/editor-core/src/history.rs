//! Undo/redo with the TS editor's grouping rules (which sit on Y.UndoManager with an infinite
//! capture timeout): every local edit joins the current group until `stop()` ends it. There are no
//! time-based breaks.
//!
//! Each stack item stores two selections: `sel` (restored when the item is popped) and `after`
//! (the selection on the other side of the change, handed to the inverse item).
//!
//! Besides text items, the history holds "marks": local-only undo steps that change no text (an
//! auto-conversion shown literally again). A mark sits at a given depth of the undo/redo stack.

use crate::rules::{Change, EditKind};
use crate::units::Sel;

/// One applied text replacement, in the coordinates of the text at the time it was applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Op {
    pub from: usize,
    pub removed: String,
    pub inserted: String,
}

impl Op {
    pub fn inverse(&self) -> Op {
        Op { from: self.from, removed: self.inserted.clone(), inserted: self.removed.clone() }
    }
    pub fn as_change(&self) -> Change {
        Change::new(self.from, self.from + self.removed.len(), self.inserted.clone())
    }
    pub fn apply(&self, text: &mut String) {
        text.replace_range(self.from..self.from + self.removed.len(), &self.inserted);
    }
}

#[derive(Clone, Debug)]
struct Item {
    ops: Vec<Op>,
    sel: Option<Sel>,
    after: Sel,
    kind: EditKind,
}

/// What an undo/redo did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Popped {
    /// A mark (its id) was undone/redone; the text is unchanged.
    Mark(usize),
    /// Text was changed by `ops` (already applied, in order).
    Item { ops: Vec<Op>, kind: EditKind, restore: Option<Sel> },
}

#[derive(Clone, Debug)]
pub struct History {
    undo: Vec<Item>,
    redo: Vec<Item>,
    /// The next local edit joins the top undo item.
    capturing: bool,
    /// (depth, mark id)
    undo_marks: Vec<(usize, usize)>,
    redo_marks: Vec<(usize, usize)>,
    /// Selection captured right before the next recorded edit.
    pub sel_before: Option<Sel>,
    /// Kind of the next recorded edit.
    pub kind: EditKind,
}

impl Default for History {
    fn default() -> Self {
        History {
            undo: vec![],
            redo: vec![],
            capturing: false,
            undo_marks: vec![],
            redo_marks: vec![],
            sel_before: None,
            kind: EditKind::Input,
        }
    }
}

impl History {
    /// End the current undo group.
    pub fn stop(&mut self) {
        self.capturing = false;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty() || !self.undo_marks.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty() || !self.redo_marks.is_empty()
    }

    pub fn clear(&mut self) {
        *self = History::default();
    }

    /// Record a local edit (its applied ops) with the selection after it.
    pub fn record(&mut self, ops: Vec<Op>, after: Sel) {
        if ops.is_empty() {
            return;
        }
        self.redo.clear();
        self.redo_marks.clear();
        match self.undo.last_mut() {
            Some(last) if self.capturing => {
                last.ops.extend(ops);
                last.after = after;
            }
            _ => self.undo.push(Item { ops, sel: self.sel_before, after, kind: self.kind }),
        }
        self.capturing = true;
    }

    /// Push a local-only undo step on top of the undo stack.
    pub fn push_mark(&mut self, id: usize) {
        self.stop();
        self.undo_marks.push((self.undo.len(), id));
        self.redo_marks.clear();
    }

    /// Undo: a valid mark at the top of the stack, else the top text item (applied to `text`).
    pub fn undo(&mut self, text: &mut String, valid: &dyn Fn(usize) -> bool, current: Sel) -> Option<Popped> {
        let depth = self.undo.len();
        self.undo_marks.retain(|m| m.0 <= depth);
        // a mark whose line changed meanwhile is dropped, not a dead undo step
        while let Some(&(d, id)) = self.undo_marks.last()
            && d == depth
            && !valid(id)
        {
            self.undo_marks.pop();
        }
        if let Some(&(d, id)) = self.undo_marks.last()
            && d == depth
        {
            self.undo_marks.pop();
            self.redo_marks.push((self.redo.len(), id));
            self.stop();
            return Some(Popped::Mark(id));
        }
        self.pop(true, text, current)
    }

    pub fn redo(&mut self, text: &mut String, valid: &dyn Fn(usize) -> bool, current: Sel) -> Option<Popped> {
        let depth = self.redo.len();
        self.redo_marks.retain(|m| m.0 <= depth);
        while let Some(&(d, id)) = self.redo_marks.last()
            && d == depth
            && !valid(id)
        {
            self.redo_marks.pop();
        }
        if let Some(&(d, id)) = self.redo_marks.last()
            && d == depth
        {
            self.redo_marks.pop();
            self.undo_marks.push((self.undo.len(), id));
            self.stop();
            return Some(Popped::Mark(id));
        }
        self.pop(false, text, current)
    }

    fn pop(&mut self, undo: bool, text: &mut String, current: Sel) -> Option<Popped> {
        let (from, to) = if undo { (&mut self.undo, &mut self.redo) } else { (&mut self.redo, &mut self.undo) };
        let top = from.last()?;
        let sel_before = top.after;
        let after_next = top.sel;
        let kind = top.kind;
        self.capturing = false;
        // items whose inverse changes nothing (e.g. text typed and deleted again) are dropped
        let mut result = None;
        while let Some(item) = from.pop() {
            let inv: Vec<Op> = item.ops.iter().rev().map(Op::inverse).collect();
            let before = text.clone();
            for op in &inv {
                op.apply(text);
            }
            if *text != before {
                result = Some((item, inv));
                break;
            }
        }
        let (item, inv) = result?;
        to.push(Item { ops: inv.clone(), sel: Some(sel_before), after: after_next.unwrap_or(current), kind });
        self.capturing = false;
        Some(Popped::Item { ops: inv, kind: item.kind, restore: item.sel })
    }
}
