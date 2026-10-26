//! The editor model: raw markdown text, the selection, undo history and the command API the UI
//! calls. Mirrors the TS `EditorView` + input controller, minus the DOM.

use std::ops::Range;

use crate::history::{History, Op, Popped, map_sel};
use crate::keymap::{Command, Key, Mods, resolve};
use crate::layout::Layout;
use crate::navigation::{self as nav, HUnit};
use crate::parser::{BlockState, BlockType, Doc, Line, Reparsed, line_at, literal_line, parse_blocks_with_states, reparse_until};
use crate::render::{LineView, render_lines};
use crate::reveal::{RevealMap, compute_reveal};
use crate::rules::{self, Edit, EditKind, FormatType, map_pos};
use crate::store::{StringStore, TextStore};
use crate::text::floor_boundary;
use crate::units::{Sel, snap_sel, word_range};

/// A line shown literally after its auto-conversion was undone (local view state only).
#[derive(Clone, Debug)]
struct Literal {
    /// Start of the line (mapped through every edit).
    line_from: usize,
    /// The line's text when it was suppressed; any change to it ends the literal state.
    text: String,
    /// Block type before the conversion (a todo converted from a bullet stays a bullet).
    from: BlockType,
    /// Selection right after the conversion, restored by undo/redo of the mark.
    sel: Sel,
}

/// The editor over a `TextStore` (`StringStore` by default). The text is parsed into `doc`;
/// every change to it is mirrored into the store.
#[derive(Clone, Debug)]
pub struct Editor<S: TextStore = StringStore> {
    store: S,
    doc: Doc,
    sel: Sel,
    goal_x: Option<f64>,
    read_only: bool,
    history: History,
    lits: Vec<Literal>,
    active_lits: Vec<usize>,
    /// Position right after an auto-inserted "> ": a space typed there next is swallowed.
    swallow_space_at: Option<usize>,
    /// Caret position after the last edit: an edit elsewhere (a caret jump) starts a new undo group.
    last_edit_pos: Option<usize>,
    /// Where the first click of the current click sequence landed.
    click_pos: Option<usize>,
    /// The source range of the image the first click of the sequence hit.
    click_image: Option<(usize, usize)>,
    /// Where (x, y) the first click of the current click sequence was pressed.
    click_xy: Option<(f64, f64)>,
    /// Selection when an IME composition started.
    composing: Option<Sel>,
    /// Block-pass state at the start of every line of `doc` (for incremental re-parsing).
    states: Vec<BlockState>,
    /// Lines of `doc` shown literally: (line index, the line as parsed).
    lit_raw: Vec<(usize, Line)>,
    /// Text changed since the last parse: bytes `lo..hi` of the current text and the length change, per
    /// changed stretch (in order, apart), so edits far apart re-parse only the lines around each.
    dirty: Vec<(usize, usize, isize)>,
    /// `set_edit_log(true)`: the text edits since the last `take_edits`.
    edit_log: Option<Vec<(Range<usize>, String)>>,
    /// Lines changed since the last `take_line_changes`.
    changes: Option<LineChanges>,
}

/// Lines `start..old_end` of the document (as of the last `Editor::take_line_changes`) are now lines
/// `start..new_end`; every other line is unchanged apart from a shift of its offsets and line index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineChanges {
    pub start: usize,
    pub old_end: usize,
    pub new_end: usize,
}

impl LineChanges {
    /// `self` followed by `next` (whose line numbers are those after `self`).
    fn then(self, next: LineChanges) -> LineChanges {
        let end = self.new_end.max(next.old_end);
        LineChanges {
            start: self.start.min(next.start),
            old_end: end + self.old_end - self.new_end,
            new_end: end + next.new_end - next.old_end,
        }
    }
}

/// Separately re-parsed stretches at most (more scattered edits merge the closest ones).
const MAX_DIRTY: usize = 8;

/// How far (in layout units) the presses of one multi-click may be apart.
const CLICK_SLOP: f64 = 6.0;

impl Editor {
    pub fn new(text: &str) -> Editor {
        Editor::with_store(StringStore::new(text))
    }
}

impl<S: TextStore> Editor<S> {
    /// An editor over `store`'s text. The text is never rewritten: a `\r` stays part of its line,
    /// as in the TS parser (only "\n" ends a line), so a shared note stays byte-identical.
    pub fn with_store(store: S) -> Editor<S> {
        let text = store.text().to_string();
        let (lines, states) = parse_blocks_with_states(&text);
        let doc = Doc { text, lines };
        // start at the first line's text, after any block prefix
        let sel = Sel::caret(doc.lines[0].text_from);
        Editor {
            store,
            doc,
            sel,
            goal_x: None,
            read_only: false,
            history: History::default(),
            lits: vec![],
            active_lits: vec![],
            swallow_space_at: None,
            last_edit_pos: None,
            click_pos: None,
            click_image: None,
            click_xy: None,
            composing: None,
            states,
            lit_raw: vec![],
            dirty: Vec::new(),
            edit_log: None,
            changes: None,
        }
    }

    // ------------------------------------------------------------------------------------------
    // State

    pub fn text(&self) -> &str {
        &self.doc.text
    }

    /// The text store (it always holds `text()`).
    pub fn store(&self) -> &S {
        &self.store
    }

    /// Apply a local op to the text and mirror it into the store.
    fn apply_op(&mut self, op: &Op) {
        op.apply(&mut self.doc.text);
        self.note_change(op);
        self.store.replace(op.from..op.from + op.removed.len(), &op.inserted);
    }

    /// Record an op applied to `doc.text` (for the next `reparse`, and the edit log).
    fn note_change(&mut self, op: &Op) {
        let (from, removed, ins) = (op.from, op.removed.len(), op.inserted.len());
        if let Some(log) = &mut self.edit_log {
            log.push((from..from + removed, op.inserted.clone()));
        }
        let d = ins as isize - removed as isize;
        // stretches before the op stay, those after it move, those touching it merge with it
        let mut merged = (from, from + ins, d);
        let mut before = 0;
        let mut out = Vec::with_capacity(self.dirty.len() + 1);
        for &(lo, hi, delta) in &self.dirty {
            if hi < from {
                out.push((lo, hi, delta));
                before += 1;
            } else if lo > from + removed {
                out.push(((lo as isize + d) as usize, (hi as isize + d) as usize, delta));
            } else {
                let hi = if hi >= from + removed { (hi as isize + d) as usize } else { from + ins };
                merged = (merged.0.min(lo), merged.1.max(hi), merged.2 + delta);
            }
        }
        out.insert(before, merged);
        // many scattered edits (a replace-all): merge the closest stretches
        while out.len() > MAX_DIRTY {
            let k = (0..out.len() - 1).min_by_key(|&k| out[k + 1].0 - out[k].1).unwrap_or(0);
            let next = out.remove(k + 1);
            out[k] = (out[k].0, next.1, out[k].2 + next.2);
        }
        self.dirty = out;
    }

    /// Keep a log of every text edit (local, undo/redo, remote), for `take_edits`.
    pub fn set_edit_log(&mut self, on: bool) {
        self.edit_log = on.then(Vec::new);
    }

    /// The text edits since the last call, in order (each a byte range of the text left by the ones
    /// before it, and its replacement). Empty unless `set_edit_log(true)`.
    pub fn take_edits(&mut self) -> Vec<(Range<usize>, String)> {
        self.edit_log.as_mut().map(std::mem::take).unwrap_or_default()
    }

    /// Lines changed since the last call (None: no line changed), for front ends that redraw only
    /// changed lines. Reveal changes aren't included (compare `reveal()`).
    pub fn take_line_changes(&mut self) -> Option<LineChanges> {
        self.changes.take()
    }

    fn line_changed(&mut self, c: LineChanges) {
        self.changes = Some(self.changes.map_or(c, |p| p.then(c)));
    }

    /// The parsed document (with lines whose conversion was undone shown literally).
    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    pub fn selection(&self) -> Sel {
        self.sel
    }

    pub fn selected_text(&self) -> Option<&str> {
        (!self.sel.is_empty()).then(|| &self.doc.text[self.sel.from()..self.sel.to()])
    }

    pub fn goal_x(&self) -> Option<f64> {
        self.goal_x
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn set_read_only(&mut self, ro: bool) {
        self.read_only = ro;
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    /// Reveal state for the current selection.
    pub fn reveal(&self) -> RevealMap {
        compute_reveal(&self.doc, Some(self.sel))
    }

    /// Everything the UI needs to draw the document in its current reveal state.
    pub fn render_lines(&self) -> Vec<LineView> {
        render_lines(&self.doc, &self.reveal())
    }

    /// A selection change made by the UI/program (not by an edit or arrow key): snapped to caret
    /// stops, and it ends the current undo group.
    pub fn set_selection(&mut self, sel: Sel) {
        self.history.stop();
        let s = snap_sel(&self.doc, self.clamp(sel), 0);
        self.set_sel(s, false);
    }

    /// Replace the whole text from outside (e.g. a remote update): keeps the caret by mapping it
    /// through the minimal change, and clears the undo history. Lines shown literally stay literal
    /// while unchanged (as with a remote edit in the TS); an IME composition range is mapped too.
    pub fn set_text(&mut self, text: &str) {
        let old = &self.doc.text;
        let mut p = old.bytes().zip(text.bytes()).take_while(|(a, b)| a == b).count();
        p = floor_boundary(old, p.min(text.len()));
        while !text.is_char_boundary(p) {
            p -= 1;
        }
        let max_s = (old.len() - p).min(text.len() - p);
        let mut s = old.bytes().rev().zip(text.bytes().rev()).take(max_s).take_while(|(a, b)| a == b).count();
        while !old.is_char_boundary(old.len() - s) || !text.is_char_boundary(text.len() - s) {
            s -= 1;
        }
        let op = Op { from: p, removed: old[p..old.len() - s].to_string(), inserted: text[p..text.len() - s].to_string() };
        let ch = [op.as_change()];
        self.apply_op(&op);
        self.map_positions(std::slice::from_ref(&op));
        let sel = map_sel(self.sel, &ch);
        self.composing = self.composing.map(|c| map_sel(c, &ch));
        self.swallow_space_at = self.swallow_space_at.map(|q| map_pos(q, &ch, -1));
        self.last_edit_pos = None;
        self.click_pos = None;
        self.click_image = None;
        self.click_xy = None;
        self.history.clear();
        // without history, only the literals currently shown matter
        let active = std::mem::take(&mut self.active_lits);
        let lits = std::mem::take(&mut self.lits);
        self.lits = active.iter().map(|&id| lits[id].clone()).collect();
        self.active_lits = (0..self.lits.len()).collect();
        self.reparse();
        let sel = snap_sel(&self.doc, self.clamp(sel), 0);
        self.set_sel(sel, false);
    }

    /// Text edits made elsewhere (a collaborator): each a byte range of the text as left by the
    /// edits before it, and its replacement (ranges are clamped to char boundaries). They aren't
    /// undoable, even when read-only they apply, and they don't end the current undo group. The
    /// selection, an IME composition range and lines shown literally are mapped through them (a
    /// caret at an insertion point stays before the inserted text), the goal x is kept, and the
    /// undo/redo history is rebased onto them: undo still reverts exactly the local changes and
    /// never remote text (text inserted remotely inside a range an undo deletes stays).
    pub fn apply_remote(&mut self, edits: &[(Range<usize>, String)]) {
        let mut sel = self.sel;
        let mut changed = false;
        for (range, insert) in edits {
            let len = self.doc.text.len();
            let from = floor_boundary(&self.doc.text, range.start.min(len));
            let to = floor_boundary(&self.doc.text, range.end.min(len)).max(from);
            if from == to && insert.is_empty() {
                continue;
            }
            let op = Op { from, removed: self.doc.text[from..to].to_string(), inserted: insert.clone() };
            op.apply(&mut self.doc.text);
            self.note_change(&op);
            self.store.replace_remote(from..to, insert);
            let ch = [op.as_change()];
            self.map_positions(std::slice::from_ref(&op));
            sel = map_sel(sel, &ch);
            self.composing = self.composing.map(|c| map_sel(c, &ch));
            let map = |p: usize| map_pos(p, &ch, -1);
            self.swallow_space_at = self.swallow_space_at.map(map);
            self.last_edit_pos = self.last_edit_pos.map(map);
            self.click_pos = self.click_pos.map(map);
            self.click_image = self.click_image.map(|(a, b)| {
                let a = map_pos(a, &ch, 1);
                (a, map(b).max(a))
            });
            self.history.map_remote(&op);
            changed = true;
        }
        if !changed {
            return;
        }
        self.reparse();
        let sel = snap_sel(&self.doc, self.clamp(sel), 0);
        self.set_sel(sel, true);
    }

    fn clamp(&self, s: Sel) -> Sel {
        Sel { anchor: floor_boundary(&self.doc.text, s.anchor), head: floor_boundary(&self.doc.text, s.head) }
    }

    fn set_sel(&mut self, sel: Sel, keep_goal: bool) {
        let sel = self.clamp(sel);
        self.sel = sel;
        if self.swallow_space_at.is_some_and(|p| sel.head != p || !sel.is_empty()) {
            self.swallow_space_at = None;
        }
        if !keep_goal {
            self.goal_x = None;
        }
    }

    /// Re-parse the text (only the lines around what changed since the last parse) and apply the
    /// local literal-line state.
    fn reparse(&mut self) {
        // lines shown literally go back to their parse first
        let mut was_lit = Vec::with_capacity(self.lit_raw.len());
        for (li, raw) in std::mem::take(&mut self.lit_raw).into_iter().rev() {
            self.doc.lines[li] = raw;
            was_lit.push(li);
        }
        let mut windows: Vec<Reparsed> = Vec::new();
        let mut regions = std::mem::take(&mut self.dirty);
        let mut k = 0;
        while k < regions.len() {
            let (lo, hi, delta) = regions[k];
            let limit = regions.get(k + 1).map_or(usize::MAX, |r| r.0);
            match reparse_until(&mut self.doc.lines, &mut self.states, &self.doc.text, lo, hi, delta, limit) {
                Some(r) => {
                    self.line_changed(LineChanges { start: r.start, old_end: r.old_end, new_end: r.new_end });
                    windows.push(r);
                    k += 1;
                }
                None => {
                    // the lines to re-parse reach the next edit: one stretch
                    let next = regions.remove(k + 1);
                    regions[k] = (lo, next.1, delta + next.2);
                }
            }
        }
        #[cfg(debug_assertions)]
        if !windows.is_empty() {
            let (lines, states) = parse_blocks_with_states(&self.doc.text);
            assert!(lines == self.doc.lines && states == self.states, "incremental parse differs from a full parse");
        }
        // where the lines shown literally before are now (None: re-parsed anyway)
        let moved = |li: usize| {
            windows.iter().try_fold(li, |li, &Reparsed { start, old_end, new_end }| {
                if li < start {
                    Some(li)
                } else {
                    (li >= old_end).then(|| li + new_end - old_end)
                }
            })
        };
        let was_lit: Vec<usize> = was_lit.into_iter().filter_map(moved).collect();
        let mut keep = Vec::new();
        for &id in &self.active_lits {
            if let Some(li) = self.literal_line_index(id) {
                let lit = literal_line(&self.doc.text, &self.doc.lines[li], self.lits[id].from);
                self.lit_raw.push((li, std::mem::replace(&mut self.doc.lines[li], lit)));
                keep.push(id);
            }
        }
        self.active_lits = keep;
        // lines that started or stopped being shown literally
        let now_lit: Vec<usize> = self.lit_raw.iter().map(|&(li, _)| li).collect();
        for &li in was_lit.iter().filter(|li| !now_lit.contains(li)).chain(now_lit.iter().filter(|li| !was_lit.contains(li))) {
            self.line_changed(LineChanges { start: li, old_end: li + 1, new_end: li + 1 });
        }
    }

    /// The line a literal applies to, if it still exists unchanged.
    fn literal_line_index(&self, id: usize) -> Option<usize> {
        let lit = &self.lits[id];
        if lit.line_from > self.doc.text.len() {
            return None;
        }
        let li = line_at(&self.doc.lines, lit.line_from);
        let line = &self.doc.lines[li];
        (line.from == lit.line_from && line.text(&self.doc.text) == lit.text).then_some(li)
    }

    /// Map stored positions (literal lines and their selections) through applied ops.
    fn map_positions(&mut self, ops: &[Op]) {
        for op in ops {
            let ch = [op.as_change()];
            for lit in &mut self.lits {
                lit.line_from = map_pos(lit.line_from, &ch, 1);
                lit.sel = map_sel(lit.sel, &ch);
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Edits

    /// Apply an edit produced by the rules as one local transaction (with its undo grouping).
    pub fn apply_edit(&mut self, e: Option<Edit>) {
        let Some(e) = e else { return };
        if self.read_only {
            return;
        }
        self.swallow_space_at = None;
        if e.changes.is_empty() {
            self.set_sel(e.sel, false);
            return;
        }
        let jumped = self.last_edit_pos.is_some_and(|p| p != self.sel.head);
        let separate = e.kind.is_separate();
        if jumped || separate {
            self.history.stop();
        }
        self.history.sel_before = Some(self.sel);
        self.history.kind = e.kind;
        let mut sorted = e.changes.clone();
        sorted.sort_by_key(|c| std::cmp::Reverse(c.from));
        let mut ops = Vec::with_capacity(sorted.len());
        for c in sorted {
            let op = Op { from: c.from, removed: self.doc.text[c.from..c.to].to_string(), inserted: c.insert };
            self.apply_op(&op);
            ops.push(op);
        }
        self.map_positions(&ops);
        self.reparse();
        let sel = snap_sel(&self.doc, self.clamp(e.sel), 0);
        self.sel = sel;
        self.history.record(ops, sel);
        self.set_sel(sel, false);
        if separate {
            self.history.stop();
        }
        self.last_edit_pos = Some(self.sel.head);
        self.goal_x = None;
        if let Some(from) = e.converts {
            let line = self.doc.line_of(self.sel.head);
            self.lits.push(Literal { line_from: line.from, text: line.text(&self.doc.text).to_string(), from, sel: self.sel });
            self.history.push_mark(self.lits.len() - 1);
        }
        if let Some(then) = e.then {
            self.apply_edit(Some(*then));
        }
    }

    /// Typed text (from the keyboard / IME commit), with Bear's typing rules.
    pub fn insert_text(&mut self, s: &str) {
        if self.read_only || s.is_empty() {
            return;
        }
        if s == " " && self.sel.is_empty() && self.swallow_space_at == Some(self.sel.head) {
            self.swallow_space_at = None;
            return;
        }
        let ed = rules::insert_text(&self.doc, self.sel, s);
        let quote = s == ">" && ed.then.as_ref().is_some_and(|t| t.kind == EditKind::Convert);
        self.apply_edit(Some(ed));
        if quote {
            self.swallow_space_at = Some(self.sel.head);
        }
    }

    /// Enter.
    pub fn insert_paragraph(&mut self) {
        let e = rules::insert_paragraph(&self.doc, self.sel);
        self.apply_edit(e);
    }

    /// Shift-Enter: a raw newline.
    pub fn insert_line_break(&mut self) {
        let e = rules::insert_line_break(&self.doc, self.sel);
        self.apply_edit(Some(e));
    }

    pub fn delete_backward(&mut self) {
        let e = rules::delete_backward(&self.doc, self.sel);
        self.apply_edit(e);
    }

    pub fn delete_forward(&mut self) {
        let e = rules::delete_forward(&self.doc, self.sel);
        self.apply_edit(e);
    }

    pub fn delete_word_backward(&mut self) {
        let e = rules::delete_word_backward(&self.doc, self.sel);
        self.apply_edit(e);
    }

    pub fn delete_word_forward(&mut self) {
        let e = rules::delete_word_forward(&self.doc, self.sel);
        self.apply_edit(e);
    }

    pub fn delete_to_line_start(&mut self) {
        let e = rules::delete_to_line_start(&self.doc, self.sel);
        self.apply_edit(e);
    }

    pub fn delete_to_line_end(&mut self) {
        let e = rules::delete_to_line_end(&self.doc, self.sel);
        self.apply_edit(e);
    }

    /// Tab / Shift-Tab.
    pub fn tab(&mut self, shift: bool) {
        let e = rules::tab(&self.doc, self.sel, shift);
        self.apply_edit(e);
    }

    /// Paste plain text (raw markdown); its own undo step.
    pub fn paste(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        let e = rules::paste(&self.doc, self.sel, s);
        self.apply_edit(Some(e));
    }

    /// Cut: returns the raw selected text (put it on the clipboard) and deletes it.
    pub fn cut(&mut self) -> Option<String> {
        let t = self.selected_text()?.to_string();
        if !self.read_only {
            let e = rules::replace_selection(&self.doc, self.sel, "", EditKind::Paste);
            self.apply_edit(Some(e));
        }
        Some(t)
    }

    /// Copy: the raw selected text.
    pub fn copy(&self) -> Option<String> {
        self.selected_text().map(str::to_string)
    }

    /// Replace a range (spelling correction, `insertReplacementText`).
    pub fn replace_range(&mut self, from: usize, to: usize, s: &str) {
        let sel = self.clamp(Sel::new(from, to));
        let e = rules::replace_selection(&self.doc, sel, s, EditKind::Input);
        self.apply_edit(Some(e));
    }

    /// Cmd-B / Cmd-I / Cmd-U (and strike / highlight, which have no shortcut).
    pub fn toggle_format(&mut self, ty: FormatType) {
        let e = rules::toggle_format(&self.doc, self.sel, ty);
        self.apply_edit(e);
    }

    /// Click on a todo checkbox (the gutter token of line `line`).
    pub fn toggle_todo(&mut self, line: usize) {
        let e = rules::toggle_todo(&self.doc, line);
        self.apply_edit(e);
    }

    pub fn select_all(&mut self) {
        self.history.stop();
        self.set_sel(Sel::new(0, self.doc.text.len()), false);
    }

    // ------------------------------------------------------------------------------------------
    // Undo / redo

    pub fn undo(&mut self) -> bool {
        if self.read_only {
            return false;
        }
        let valid: Vec<bool> = (0..self.lits.len()).map(|id| self.literal_line_index(id).is_some()).collect();
        let cur = self.sel;
        let popped = self.history.undo(&mut self.doc.text, &|id| valid[id], cur);
        let done = self.after_pop(popped, true);
        self.last_edit_pos = None;
        done
    }

    pub fn redo(&mut self) -> bool {
        if self.read_only {
            return false;
        }
        let valid: Vec<bool> = (0..self.lits.len()).map(|id| self.active_lits.contains(&id)).collect();
        let cur = self.sel;
        let popped = self.history.redo(&mut self.doc.text, &|id| valid[id], cur);
        let done = self.after_pop(popped, false);
        self.last_edit_pos = None;
        done
    }

    fn after_pop(&mut self, popped: Option<Popped>, undo: bool) -> bool {
        match popped {
            None => false,
            Some(Popped::Mark(id)) => {
                if undo {
                    self.active_lits.push(id);
                } else {
                    self.active_lits.retain(|&x| x != id);
                }
                self.reparse();
                let s = snap_sel(&self.doc, self.clamp(self.lits[id].sel), 0);
                self.set_sel(s, false);
                true
            }
            Some(Popped::Item { ops, kind, restore }) => {
                // the history changed `doc.text` already
                for op in &ops {
                    self.note_change(op);
                    self.store.replace(op.from..op.from + op.removed.len(), &op.inserted);
                }
                self.map_positions(&ops);
                let mut sel = self.sel;
                let mut inserted: Vec<(usize, usize)> = Vec::new();
                for op in &ops {
                    let ch = [op.as_change()];
                    sel = map_sel(sel, &ch);
                    for r in &mut inserted {
                        *r = (map_pos(r.0, &ch, 1), map_pos(r.1, &ch, -1).max(map_pos(r.0, &ch, 1)));
                    }
                    if !op.inserted.is_empty() {
                        inserted.push((op.from, op.from + op.inserted.len()));
                    }
                }
                self.reparse();
                self.sel = snap_sel(&self.doc, self.clamp(sel), 0);
                let ins = inserted.iter().filter(|r| r.0 < r.1).fold(None, |acc: Option<(usize, usize)>, r| {
                    Some(acc.map_or(*r, |a| (a.0.min(r.0), a.1.max(r.1))))
                });
                if let (true, Some((a, b))) = (undo && kind != EditKind::Convert, ins) {
                    // text re-inserted by undo is selected
                    self.set_sel(Sel::new(a, b), false);
                } else if let Some(r) = restore {
                    let s = snap_sel(&self.doc, self.clamp(r), 0);
                    self.set_sel(s, false);
                } else {
                    self.set_sel(self.sel, false);
                }
                true
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Navigation

    /// Left/Right by unit (dir -1 / +1).
    pub fn move_horizontal(&mut self, dir: i32, extend: bool, unit: HUnit) {
        let s = nav::move_horizontal(&self.doc, self.sel, dir, extend, unit);
        self.set_sel(s, false);
    }

    /// Option-Up/Down.
    pub fn move_paragraph(&mut self, dir: i32, extend: bool) {
        let s = nav::move_paragraph(&self.doc, self.sel, dir, extend);
        self.set_sel(s, false);
    }

    /// Up/Down by visual line, keeping the goal x. `layout` must reflect the current render.
    pub fn move_vertical(&mut self, layout: &dyn Layout, dir: i32, extend: bool) {
        let reveal = self.reveal();
        let mut goal = self.goal_x;
        let s = nav::move_vertical(&self.doc, &reveal, layout, &mut goal, self.sel, dir, extend);
        self.goal_x = goal;
        self.set_sel(s, true);
    }

    /// The raw offset for a point (hit-tested in the current layout, with the line-edge fixups).
    pub fn hit_test(&self, layout: &dyn Layout, x: f64, y: f64) -> Option<usize> {
        nav::hit_test_adjusted(&self.doc, &self.reveal(), layout, x, y)
    }

    /// Mouse down in the text (`count` = click count). Single click: caret at the hit (Shift
    /// extends); double: the word without markers; triple: the raw line including the newline.
    /// Todo checkboxes and link chips are UI hits: call `toggle_todo` / open the URL instead.
    /// On an image (`Layout::image_at`): the caret after its source (Shift extends there), a
    /// double click selects the source, a triple click the line. The first click reveals the
    /// source and moves the image, so later clicks of the sequence act on the image it hit. A
    /// multi-click pressed away from the sequence's first click (or without one) is taken as
    /// starting there.
    pub fn mouse_down(&mut self, layout: &dyn Layout, x: f64, y: f64, count: u32, shift: bool) {
        self.history.stop();
        self.goal_x = None;
        let first = count <= 1 || self.click_xy.is_none_or(|(px, py)| (px - x).abs() > CLICK_SLOP || (py - y).abs() > CLICK_SLOP);
        if first {
            self.click_xy = Some((x, y));
        }
        let mut image = layout.image_at(x, y);
        if !first && self.click_image.is_some() {
            image = self.click_image;
        }
        if first {
            self.click_image = image;
        }
        if let Some((from, to)) = image {
            let len = self.doc.text.len();
            let (a, b) = (floor_boundary(&self.doc.text, from.min(len)), floor_boundary(&self.doc.text, to.min(len)));
            self.click_pos = Some(b);
            let s = if shift {
                Sel::new(self.sel.anchor, b)
            } else if count == 2 {
                Sel::new(a, b)
            } else if count >= 3 {
                let lines = &self.doc.lines;
                let li = line_at(lines, b);
                Sel::new(lines[li].from, if li + 1 < lines.len() { lines[li + 1].from } else { lines[li].to })
            } else {
                Sel::caret(b)
            };
            self.set_sel(s, false);
            return;
        }
        // where the first click of a (multi-)click landed, hit-tested before any reveal shifts the layout
        if first {
            self.click_pos = self.hit_test(layout, x, y);
        }
        let at = self.click_pos.unwrap_or(self.sel.head);
        if count == 2 && !shift {
            if let Some((a, b)) = word_range(&self.doc, at) {
                self.set_sel(Sel::new(a, b), false);
            }
            return;
        }
        if count >= 3 && !shift {
            let lines = &self.doc.lines;
            let li = line_at(lines, at);
            let end = if li + 1 < lines.len() { lines[li + 1].from } else { lines[li].to };
            self.set_sel(Sel::new(lines[li].from, end), false);
            return;
        }
        if shift {
            if let Some(p) = layout.hit_test(x, y) {
                let s = snap_sel(&self.doc, Sel::new(self.sel.anchor, p), 0);
                self.set_sel(s, false);
            }
            return;
        }
        if let Some(p) = self.click_pos {
            let s = snap_sel(&self.doc, Sel::caret(p), 0);
            self.set_sel(s, false);
        }
    }

    /// Mouse dragged with the button down: extend the selection to the native hit.
    pub fn mouse_drag(&mut self, layout: &dyn Layout, x: f64, y: f64) {
        if let Some(p) = layout.hit_test(x, y) {
            let s = snap_sel(&self.doc, Sel::new(self.sel.anchor, p), 0);
            self.set_sel(s, false);
        }
    }

    // ------------------------------------------------------------------------------------------
    // IME composition (the UI shows the marked text itself)

    pub fn begin_composition(&mut self) {
        self.history.stop();
        self.composing = Some(self.sel);
    }

    /// Forget the composition without changing the text (the UI that showed it went away).
    pub fn cancel_composition(&mut self) {
        self.composing = None;
        self.history.stop();
    }

    pub fn end_composition(&mut self, text: &str) {
        let range = self.composing.take().unwrap_or(self.sel);
        let range = self.clamp(range);
        if !self.read_only && (!text.is_empty() || !range.is_empty()) {
            self.sel = range;
            let e = if text.is_empty() {
                rules::replace_selection(&self.doc, range, "", EditKind::Input)
            } else {
                rules::insert_text(&self.doc, range, text)
            };
            self.apply_edit(Some(e));
        }
        self.history.stop();
    }

    // ------------------------------------------------------------------------------------------
    // Keys

    /// Handle a key press through the key map. Returns the command run, or None if the key isn't
    /// the editor's. `ScrollToStart`/`ScrollToEnd` are returned for the UI to perform.
    ///
    /// When read-only, edits aren't run: Tab and the editing keys return None (left to the
    /// system, as `input.ts` does), the formatting and undo shortcuts are swallowed.
    pub fn key(&mut self, key: Key, mods: Mods, layout: &dyn Layout) -> Option<Command> {
        let cmd = resolve(key, mods)?;
        if self.read_only && cmd.is_edit() {
            return matches!(cmd, Command::ToggleFormat(_) | Command::Undo | Command::Redo).then_some(cmd);
        }
        self.run(cmd, layout);
        Some(cmd)
    }

    /// Run a command.
    pub fn run(&mut self, cmd: Command, layout: &dyn Layout) {
        match cmd {
            Command::Undo => {
                self.undo();
            }
            Command::Redo => {
                self.redo();
            }
            Command::SelectAll => self.select_all(),
            Command::ToggleFormat(f) => self.toggle_format(f),
            Command::Move { dir, unit, extend } => self.move_horizontal(dir, extend, unit),
            Command::MoveVertical { dir, extend } => self.move_vertical(layout, dir, extend),
            Command::MoveParagraph { dir, extend } => self.move_paragraph(dir, extend),
            Command::ScrollToStart | Command::ScrollToEnd => {}
            Command::Tab { shift } => self.tab(shift),
            Command::InsertParagraph => self.insert_paragraph(),
            Command::InsertLineBreak => self.insert_line_break(),
            Command::DeleteBackward => self.delete_backward(),
            Command::DeleteForward => self.delete_forward(),
            Command::DeleteWordBackward => self.delete_word_backward(),
            Command::DeleteWordForward => self.delete_word_forward(),
            Command::DeleteToLineStart => self.delete_to_line_start(),
            Command::DeleteToLineEnd => self.delete_to_line_end(),
        }
    }
}
