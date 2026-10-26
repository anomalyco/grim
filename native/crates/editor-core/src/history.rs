//! Undo/redo with the TS editor's grouping rules (which sit on Y.UndoManager with an infinite
//! capture timeout): every local edit joins the current group until `stop()` ends it. There are no
//! time-based breaks.
//!
//! Each stack item stores two selections: `sel` (restored when the item is popped) and `after`
//! (the selection on the other side of the change, handed to the inverse item).
//!
//! Besides text items, the history holds "marks": local-only undo steps that change no text (an
//! auto-conversion shown literally again). A mark sits at a given depth of the undo/redo stack.
//!
//! Remote changes (`map_remote`) aren't undoable: the stored ops are rebased onto them.

use crate::rules::{Change, EditKind, map_pos};
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
    /// Items whose inverse changes nothing (e.g. text a collaborator deleted since) are dropped on
    /// the way, and a mark below such an item comes before the next text item.
    pub fn undo(&mut self, text: &mut String, valid: &dyn Fn(usize) -> bool, current: Sel) -> Option<Popped> {
        self.step(true, text, valid, current)
    }

    pub fn redo(&mut self, text: &mut String, valid: &dyn Fn(usize) -> bool, current: Sel) -> Option<Popped> {
        self.step(false, text, valid, current)
    }

    fn step(&mut self, undo: bool, text: &mut String, valid: &dyn Fn(usize) -> bool, current: Sel) -> Option<Popped> {
        loop {
            let (from, to, marks, other_marks) = if undo {
                (&mut self.undo, &mut self.redo, &mut self.undo_marks, &mut self.redo_marks)
            } else {
                (&mut self.redo, &mut self.undo, &mut self.redo_marks, &mut self.undo_marks)
            };
            let depth = from.len();
            marks.retain(|m| m.0 <= depth);
            // a mark whose line changed meanwhile is dropped, not a dead undo step
            while let Some(&(d, id)) = marks.last()
                && d == depth
                && !valid(id)
            {
                marks.pop();
            }
            if let Some(&(d, id)) = marks.last()
                && d == depth
            {
                marks.pop();
                other_marks.push((to.len(), id));
                self.capturing = false;
                return Some(Popped::Mark(id));
            }
            // (nothing to undo/redo doesn't end the current group, as with Y.UndoManager)
            let item = from.pop()?;
            self.capturing = false;
            let inv: Vec<Op> = item.ops.iter().rev().map(Op::inverse).collect();
            let before = text.clone();
            for op in &inv {
                op.apply(text);
            }
            if *text == before {
                continue;
            }
            to.push(Item { ops: inv.clone(), sel: Some(item.after), after: item.sel.unwrap_or(current), kind: item.kind });
            return Some(Popped::Item { ops: inv, kind: item.kind, restore: item.sel });
        }
    }
}

/// Map a selection like the TS relative positions: a caret sticks to the character before it; a
/// selection's start sticks right and its end left.
pub(crate) fn map_sel(sel: Sel, changes: &[Change]) -> Sel {
    let collapsed = sel.is_empty();
    let fwd = sel.anchor <= sel.head;
    let a = if collapsed || !fwd { -1 } else { 1 };
    let h = if collapsed || fwd { -1 } else { 1 };
    Sel { anchor: map_pos(sel.anchor, changes, a), head: map_pos(sel.head, changes, h) }
}

/// `map_sel` through ops applied one after another.
pub(crate) fn map_sel_ops(sel: Sel, ops: &[Op]) -> Sel {
    ops.iter().fold(sel, |s, op| map_sel(s, &[op.as_change()]))
}

impl History {
    /// A remote change (applied to the current text, not undoable) was made: rebase every undo
    /// and redo item onto it, so that undo/redo still target the local text they changed and
    /// never revert remote text (like Y.UndoManager). Text a remote change inserted inside a
    /// range a local undo deletes is kept; text it deleted is not restored or deleted again.
    pub fn map_remote(&mut self, change: &Op) {
        map_stack(&mut self.undo, change);
        map_stack(&mut self.redo, change);
    }
}

/// The top item's ops lead to the current text; each item below leads to the text before the
/// one above it. Walk down, rebasing each item onto the remote change and the change onto the
/// text below the item.
fn map_stack(stack: &mut [Item], change: &Op) {
    let mut r = vec![change.clone()];
    for item in stack.iter_mut().rev() {
        if r.is_empty() {
            break;
        }
        item.after = map_sel_ops(item.after, &r);
        let inv: Vec<Op> = item.ops.iter().rev().map(Op::inverse).collect();
        let (inv, below) = transform(inv, r, true);
        item.ops = inv.iter().rev().map(Op::inverse).collect();
        item.sel = item.sel.map(|s| map_sel_ops(s, &below));
        r = below;
    }
}

/// Operational transform of two op sequences on the same text: `(a', b')` with `a'` applying
/// after `b` and `b'` after `a`, both reaching the same text. At the same position `a`'s
/// insertion goes first when `a_first`.
pub(crate) fn transform(a: Vec<Op>, b: Vec<Op>, a_first: bool) -> (Vec<Op>, Vec<Op>) {
    if a.len() == 1 && b.len() == 1 {
        return (rebase(&a[0], &b[0], a_first), rebase(&b[0], &a[0], !a_first));
    }
    if a.len() != 1 {
        let mut b = b;
        let mut out = Vec::new();
        for op in a {
            let (o, nb) = transform(vec![op], b, a_first);
            out.extend(o);
            b = nb;
        }
        return (out, b);
    }
    let mut a = a;
    let mut out = Vec::new();
    for op in b {
        let (na, o) = transform(a, vec![op], a_first);
        out.extend(o);
        a = na;
    }
    (a, out)
}

/// `a` moved onto the text after `b` (both apply to the same text): the parts of `a`'s removed
/// text that `b` left, and `a`'s insertion, ordered against `b`'s by position (ties: `a_first`).
/// Returned as sequential ops (in descending position, so each one's offsets stay valid).
fn rebase(a: &Op, b: &Op, a_first: bool) -> Vec<Op> {
    let (af, at) = (a.from, a.from + a.removed.len());
    let (bf, bt) = (b.from, b.from + b.removed.len());
    let shift = |p: usize| p + b.inserted.len() - (bt - bf);
    let mut ops: Vec<Op> = Vec::new();
    let le = at.min(bf);
    if af < le {
        ops.push(Op { from: af, removed: a.removed[..le - af].to_string(), inserted: String::new() });
    }
    let rs = af.max(bt);
    if rs < at {
        ops.push(Op { from: shift(rs), removed: a.removed[rs - af..].to_string(), inserted: String::new() });
    }
    if !a.inserted.is_empty() {
        let p = if af < bf || (af == bf && a_first) {
            af
        } else if af < bt {
            bf + b.inserted.len()
        } else {
            shift(af)
        };
        match ops.iter_mut().find(|o| o.from == p) {
            Some(o) => o.inserted = a.inserted.clone(),
            None => ops.push(Op { from: p, removed: String::new(), inserted: a.inserted.clone() }),
        }
    }
    ops.sort_by_key(|o| std::cmp::Reverse(o.from));
    ops
}
