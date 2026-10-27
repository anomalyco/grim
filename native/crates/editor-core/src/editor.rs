//! The editor model: raw markdown text, the selection, undo history and the command API the UI
//! calls. Mirrors the TS `EditorView` + input controller, minus the DOM.

use std::ops::Range;
use std::sync::Arc;

use crate::fold::{self, FOLDABLE, FOLDED, HIDDEN};
use crate::history::{History, Op, Popped, map_sel};
use crate::keymap::{Command, Key, Mods, resolve};
use crate::macos_keys::KeyTable;
use crate::layout::Layout;
use crate::navigation::{self as nav, HUnit};
use crate::parser::{BlockState, BlockType, Doc, Line, Reparsed, line_at, literal_line, parse_blocks_with_states, reparse_until};
use crate::render::{LineView, line_view};
use crate::reveal::{RevealMap, compute_reveal};
use crate::rules::{self, Change, Edit, EditKind, FormatType, map_pos};
use crate::store::{StringStore, TextStore};
use crate::text::floor_boundary;
use crate::units::{Sel, next_stop, prev_stop, snap, snap_sel, word_range};

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
    /// Starts of the folded heading lines (sorted; mapped through every edit; view state only).
    folds: Vec<usize>,
    /// `fold::flags` per line of `doc` (as of the last selection change).
    fold_flags: Vec<u8>,
    /// The key table `key` uses (None: `keymap::resolve`).
    keys: Option<Arc<KeyTable>>,
    /// What the last run of kills deleted (Ctrl-K, word and line deletes), for Ctrl-Y. Separate
    /// from the clipboard, as on macOS.
    kill: String,
    /// The selection and text length right after the last kill: a kill from there (with no other
    /// command in between) adds to the kill buffer instead of replacing it.
    kill_chain: Option<(Sel, usize)>,
    /// The emacs-style mark (`setMark:`), mapped through edits.
    mark: Option<usize>,
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
        let fold_flags = fold::flags(&lines, &[]);
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
            folds: Vec::new(),
            fold_flags,
            keys: None,
            kill: String::new(),
            kill_chain: None,
            mark: None,
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
        let reveal = self.reveal();
        (0..self.doc.lines.len()).map(|li| self.line_view(li, &reveal)).collect()
    }

    /// The view of line `li` for the reveal state `reveal` (from `reveal()`), with its fold state.
    pub fn line_view(&self, li: usize, reveal: &RevealMap) -> LineView {
        let mut v = line_view(&self.doc, &self.doc.lines[li], reveal.get(&li));
        let f = self.fold_flags.get(li).copied().unwrap_or(0);
        v.foldable = f & FOLDABLE != 0;
        v.folded = f & FOLDED != 0;
        v.hidden_by_fold = f & HIDDEN != 0;
        v
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
        self.sync_folds();
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
                    let n = self.fold_flags.len();
                    self.fold_flags.splice(r.start.min(n)..r.old_end.min(n), std::iter::repeat_n(u8::MAX, r.new_end - r.start));
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
            self.mark = self.mark.map(|p| map_pos(p, &ch, -1));
            // a fold whose heading start is deleted goes away
            let gone = op.from..op.from + op.removed.len();
            self.folds.retain(|p| !gone.contains(p));
            for p in &mut self.folds {
                *p = map_pos(*p, &ch, 1);
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
        if let Some(e) = self.enter_after_fold() {
            return self.apply_edit(Some(e));
        }
        let e = rules::insert_paragraph(&self.doc, self.sel);
        self.apply_edit(e);
    }

    /// Shift-Enter: a raw newline.
    pub fn insert_line_break(&mut self) {
        if let Some(e) = self.enter_after_fold() {
            return self.apply_edit(Some(e));
        }
        let e = rules::insert_line_break(&self.doc, self.sel);
        self.apply_edit(Some(e));
    }

    pub fn delete_backward(&mut self) {
        let e = rules::delete_backward(&self.doc, self.sel);
        self.apply_edit(e);
    }

    pub fn delete_forward(&mut self) {
        self.unfold_at_line_end();
        let e = rules::delete_forward(&self.doc, self.sel);
        self.apply_edit(e);
    }

    /// Option-Backspace (a kill: see `kill_buffer`).
    pub fn delete_word_backward(&mut self) {
        let e = rules::delete_word_backward(&self.doc, self.sel);
        self.kill_edit(e, false);
    }

    /// Option-Delete (a kill).
    pub fn delete_word_forward(&mut self) {
        self.unfold_at_line_end();
        let e = rules::delete_word_forward(&self.doc, self.sel);
        self.kill_edit(e, true);
    }

    /// Cmd-Backspace (a kill).
    pub fn delete_to_line_start(&mut self) {
        let e = rules::delete_to_line_start(&self.doc, self.sel);
        self.kill_edit(e, false);
    }

    /// Cmd-Delete, Ctrl-K: to the line end, at the end the newline (a kill).
    pub fn delete_to_line_end(&mut self) {
        self.unfold_at_line_end();
        let e = rules::delete_to_line_end(&self.doc, self.sel);
        self.kill_edit(e, true);
    }

    /// Apply a deletion and put what it deleted into the kill buffer: added after (`forward`) or
    /// before what the previous kill took when nothing happened since, else in its place.
    fn kill_edit(&mut self, e: Option<Edit>, forward: bool) {
        let Some(e) = e else { return };
        if self.read_only || e.changes.is_empty() {
            return self.apply_edit(Some(e));
        }
        let mut cs: Vec<&Change> = e.changes.iter().collect();
        cs.sort_by_key(|c| c.from);
        let removed: String = cs.iter().map(|c| &self.doc.text[c.from..c.to]).collect();
        let chained = self.kill_chain == Some((self.sel, self.doc.text.len()));
        self.apply_edit(Some(e));
        if !chained {
            self.kill.clear();
        }
        if forward {
            self.kill.push_str(&removed);
        } else {
            self.kill.insert_str(0, &removed);
        }
        self.kill_chain = Some((self.sel, self.doc.text.len()));
    }

    /// The kill buffer (what the last run of kills deleted; Ctrl-Y inserts it).
    pub fn kill_buffer(&self) -> &str {
        &self.kill
    }

    /// Carry a kill buffer over (the app's is shared by every note it opens).
    pub fn set_kill_buffer(&mut self, s: &str) {
        self.kill = s.to_string();
        self.kill_chain = None;
    }

    /// Ctrl-Y: insert the kill buffer at the caret (replacing a selection), as its own undo step.
    pub fn yank(&mut self) {
        if self.kill.is_empty() {
            return;
        }
        let e = rules::paste(&self.doc, self.sel, &self.kill);
        self.apply_edit(Some(e));
    }

    /// Ctrl-Backspace: delete the previous character's last part (é -> e; a Hangul syllable loses
    /// its last jamo), else the previous unit as Backspace does.
    pub fn delete_backward_decomposing(&mut self) {
        let p = self.sel.head;
        if self.sel.is_empty() && p > 0 {
            let a = prev_stop(&self.doc, p);
            if let Some(rest) = crate::text::without_last_part(&self.doc.text[a..p]) {
                let e = Edit { changes: vec![Change::new(a, p, rest.clone())], sel: Sel::caret(a + rest.len()), kind: EditKind::Input, then: None, converts: None };
                return self.apply_edit(Some(e));
            }
        }
        self.delete_backward();
    }

    /// Ctrl-T: swap the units on either side of the caret and move past both; at the end of a
    /// line swap the two before it (the caret stays). Like Cocoa, at a line start the newline and
    /// the first character swap (plain paragraphs only). Nothing happens with a selection, at the
    /// document start, or when a unit is syntax (a block token, a marker, an escape, a link URL,
    /// a table pipe) or the two are in different table cells.
    pub fn transpose(&mut self) {
        let p = self.sel.head;
        if !self.sel.is_empty() || p == 0 || self.read_only {
            return;
        }
        let doc = &self.doc;
        let line = doc.line_of(p);
        let (a, m, b, caret) = if p == line.to {
            let m = prev_stop(doc, p);
            let a = prev_stop(doc, m);
            (a, m, p, p)
        } else {
            let b = next_stop(doc, p);
            (prev_stop(doc, p), p, b, b)
        };
        if !(a < m && m < b && self.plain_unit(a, m) && self.plain_unit(m, b) && self.same_cell(a, b)) {
            return;
        }
        let t = &self.doc.text;
        let swapped = format!("{}{}", &t[m..b], &t[a..m]);
        let e = Edit { changes: vec![Change::new(a, b, swapped)], sel: Sel::caret(caret), kind: EditKind::Input, then: None, converts: None };
        self.apply_edit(Some(e));
    }

    /// `from..to` (one caret unit) is text a transpose may move: a newline between two plain
    /// paragraphs, or content that isn't syntax.
    fn plain_unit(&self, from: usize, to: usize) -> bool {
        let doc = &self.doc;
        let lines = &doc.lines;
        if &doc.text[from..to] == "\n" {
            let li = line_at(lines, from);
            let plain = |l: &Line| l.ty == BlockType::Paragraph && l.tokens.is_empty() && l.table.is_none();
            return li + 1 < lines.len() && plain(&lines[li]) && plain(&lines[li + 1]);
        }
        let line = doc.line_of(from);
        if from < line.text_from || to > line.to || matches!(line.ty, BlockType::Fence | BlockType::Hr | BlockType::TableDelim) {
            return false;
        }
        if line.table.is_some() && doc.text[from..to].contains('|') {
            return false;
        }
        let overlaps = |(x, y): (usize, usize)| x < to && from < y;
        !line.escapes.iter().any(|&e| overlaps((e, e + 2)))
            && !line.inline.iter().any(|el| el.url.is_some_and(overlaps) || el.markers.iter().any(|&m| overlaps(m)))
    }

    /// `a..b` lies in one table cell (or the line isn't a table row).
    fn same_cell(&self, a: usize, b: usize) -> bool {
        let line = self.doc.line_of(a);
        match &line.table {
            Some(tb) => tb.cells.iter().any(|&(cf, ct)| cf <= a && b <= ct),
            None => true,
        }
    }

    /// Ctrl-O: insert a raw newline after the caret (replacing a selection); the caret stays.
    pub fn open_line(&mut self) {
        let a = self.sel.from();
        let e = Edit { changes: vec![Change::new(a, self.sel.to(), "\n")], sel: Sel::caret(a), kind: EditKind::Input, then: None, converts: None };
        self.apply_edit(Some(e));
    }

    /// Insert `c` without the typing rules (`insertDoubleQuoteIgnoringSubstitution:`).
    pub fn insert_char(&mut self, c: char) {
        let e = rules::replace_selection(&self.doc, self.sel, c.encode_utf8(&mut [0; 4]), EditKind::Input);
        self.apply_edit(Some(e));
    }

    /// The mark (`setMark:`), if set.
    pub fn mark(&self) -> Option<usize> {
        self.mark
    }

    pub fn set_mark(&mut self) {
        self.mark = Some(self.sel.head);
    }

    /// `swapWithMark:`: the caret goes to the mark, the mark to where the caret was.
    pub fn swap_with_mark(&mut self) {
        let Some(m) = self.mark else { return };
        self.mark = Some(self.sel.head);
        self.history.stop();
        let s = snap_sel(&self.doc, self.clamp(Sel::caret(m)), 0);
        self.set_sel(s, false);
    }

    /// `selectToMark:`: select from the mark to the caret.
    pub fn select_to_mark(&mut self) {
        let Some(m) = self.mark else { return };
        self.history.stop();
        let s = snap_sel(&self.doc, self.clamp(Sel::new(m, self.sel.head)), 0);
        self.set_sel(s, false);
    }

    /// `deleteToMark:`: delete from the mark to the caret (a kill).
    pub fn delete_to_mark(&mut self) {
        let Some(m) = self.mark else { return };
        let s = snap_sel(&self.doc, self.clamp(Sel::new(m, self.sel.head)), 0);
        if s.is_empty() {
            return;
        }
        let e = rules::delete_forward(&self.doc, s);
        self.kill_edit(e, s.head >= s.anchor);
    }

    /// `selectWord:`: the word at the caret.
    pub fn select_word(&mut self) {
        if let Some((a, b)) = word_range(&self.doc, self.sel.head) {
            self.history.stop();
            self.set_sel(Sel::new(a, b), false);
        }
    }

    /// `selectParagraph:`: the caret's logical line with its newline (a folded heading: its section).
    pub fn select_paragraph(&mut self) {
        let li = line_at(&self.doc.lines, self.sel.head);
        self.history.stop();
        let s = Sel::new(self.doc.lines[li].from, self.line_end_with_fold(li));
        self.set_sel(s, false);
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
        let s = self.skip_folded(s, dir, extend);
        self.set_sel(s, false);
    }

    /// Option-Up/Down.
    pub fn move_paragraph(&mut self, dir: i32, extend: bool) {
        let s = nav::move_paragraph(&self.doc, self.sel, dir, extend);
        let s = self.skip_folded(s, dir, extend);
        self.set_sel(s, false);
    }

    /// Cmd-Left/Right (macOS table): the visual line's start / end (see `navigation::move_line_edge`).
    pub fn move_line_edge(&mut self, layout: &dyn Layout, dir: i32, extend: bool) {
        let s = nav::move_line_edge(&self.doc, &self.reveal(), layout, self.sel, dir, extend);
        let s = self.skip_folded(s, dir, extend);
        self.set_sel(s, false);
    }

    /// Up/Down by visual line, keeping the goal x. `layout` must reflect the current render.
    pub fn move_vertical(&mut self, layout: &dyn Layout, dir: i32, extend: bool) {
        let reveal = self.reveal();
        let mut goal = self.goal_x;
        let s = nav::move_vertical(&self.doc, &reveal, layout, &mut goal, self.sel, dir, extend);
        self.goal_x = goal;
        let s = self.skip_folded(s, dir, extend);
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
                Sel::new(lines[li].from, self.line_end_with_fold(li))
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
            let li = line_at(&self.doc.lines, at);
            let s = Sel::new(self.doc.lines[li].from, self.line_end_with_fold(li));
            self.set_sel(s, false);
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
    // Folding (view state: the text never changes)

    /// The folded heading lines (line indices).
    pub fn folded_lines(&self) -> Vec<usize> {
        (0..self.fold_flags.len()).filter(|&li| self.fold_flags[li] & FOLDED != 0).collect()
    }

    /// Line `li` is hidden inside a folded section.
    pub fn is_hidden_line(&self, li: usize) -> bool {
        self.fold_flags.get(li).is_some_and(|f| f & HIDDEN != 0)
    }

    /// Fold or unfold heading line `line`. Returns false when it isn't a foldable heading. A
    /// selection end that would be hidden moves to the end of the heading line.
    pub fn toggle_fold(&mut self, line: usize) -> bool {
        if line >= self.doc.lines.len() || self.fold_flags[line] & FOLDABLE == 0 {
            return false;
        }
        let from = self.doc.lines[line].from;
        if self.fold_flags[line] & FOLDED != 0 {
            self.folds.retain(|&p| p != from);
            self.sync_folds();
        } else {
            self.fold(vec![from]);
        }
        true
    }

    /// Cmd-': fold / unfold the heading on the caret's line; elsewhere fold the section the caret is in.
    pub fn toggle_fold_at_caret(&mut self) -> bool {
        let li = line_at(&self.doc.lines, self.sel.head);
        if self.fold_flags[li] & FOLDABLE != 0 { self.toggle_fold(li) } else { self.fold_at_caret() }
    }

    /// Cmd-Option-[: fold the heading on the caret's line, or else (or when it's folded already)
    /// the innermost section around it. Pressed again, it folds the next section out.
    pub fn fold_at_caret(&mut self) -> bool {
        let lines = &self.doc.lines;
        let li = line_at(lines, self.sel.head);
        let f = self.fold_flags[li];
        if f & FOLDABLE != 0 && f & FOLDED == 0 {
            return self.toggle_fold(li);
        }
        let level = if lines[li].ty == BlockType::Heading { lines[li].level } else { u8::MAX };
        match (0..li).rev().find(|&h| lines[h].ty == BlockType::Heading && lines[h].level < level) {
            Some(h) => self.toggle_fold(h),
            None => false,
        }
    }

    /// Cmd-Option-]: unfold the heading on the caret's line.
    pub fn unfold_at_caret(&mut self) -> bool {
        let li = line_at(&self.doc.lines, self.sel.head);
        self.fold_flags[li] & FOLDED != 0 && self.toggle_fold(li)
    }

    /// Fold every foldable heading.
    pub fn fold_all(&mut self) {
        let lines = &self.doc.lines;
        let all = (0..lines.len()).filter(|&li| self.fold_flags[li] & FOLDABLE != 0).map(|li| lines[li].from).collect();
        self.fold(all);
    }

    pub fn unfold_all(&mut self) {
        self.folds.clear();
        self.sync_folds();
    }

    /// Folded headings as (heading line text, occurrence) pairs (`fold::heading_key`), to persist.
    pub fn fold_keys(&self) -> Vec<(String, usize)> {
        self.folded_lines().into_iter().map(|h| fold::heading_key(&self.doc.lines, &self.doc.text, h)).collect()
    }

    /// Fold the headings named by `keys` (from `fold_keys`; unknown ones are ignored), unfolding the rest.
    pub fn set_fold_keys(&mut self, keys: &[(String, usize)]) {
        let lines = &self.doc.lines;
        let want = (0..lines.len())
            .filter(|&li| self.fold_flags[li] & FOLDABLE != 0 && keys.contains(&fold::heading_key(lines, &self.doc.text, li)))
            .map(|li| lines[li].from)
            .collect();
        self.folds.clear();
        self.fold(want);
    }

    /// Fold headings starting at `starts`; selection ends they hide move to the end of the
    /// outermost folded heading line.
    fn fold(&mut self, starts: Vec<usize>) {
        self.folds.extend(starts);
        self.folds.sort_unstable();
        self.folds.dedup();
        let lines = &self.doc.lines;
        let flags = fold::flags(lines, &self.folds);
        let out = |p: usize| fold::hidden_at(lines, &flags, p).map_or(p, |(h, _)| lines[h].to);
        let (a, h) = (out(self.sel.anchor), out(self.sel.head));
        if (a, h) != (self.sel.anchor, self.sel.head) {
            self.history.stop();
            self.sel = Sel::new(a, h);
            self.goal_x = None;
        }
        self.sync_folds();
    }

    /// Drop folds whose heading is gone (or has nothing left to fold), unfold sections a selection
    /// end is hidden in (an undo, a remote edit, a program's selection), and note lines whose fold
    /// state changed.
    fn sync_folds(&mut self) {
        let lines = &self.doc.lines;
        let len = self.doc.text.len();
        if !self.folds.is_empty() {
            self.folds.retain(|&p| {
                let li = line_at(lines, p);
                p <= len && lines[li].from == p && fold::foldable(lines, li)
            });
            self.folds.sort_unstable();
            self.folds.dedup();
        }
        let mut flags = fold::flags(lines, &self.folds);
        let sel = self.sel;
        // a selection may end at the very end of the document (select all) inside a fold
        while let Some((h, _)) = [sel.head, sel.anchor]
            .into_iter()
            .filter(|&p| sel.is_empty() || p != len)
            .find_map(|p| fold::hidden_at(lines, &flags, p))
        {
            let from = lines[h].from;
            self.folds.retain(|&p| p != from);
            flags = fold::flags(lines, &self.folds);
        }
        let old = std::mem::replace(&mut self.fold_flags, flags);
        let new = &self.fold_flags;
        debug_assert_eq!(old.len(), new.len(), "fold flags follow the re-parse");
        let differs = |i: usize| old.get(i) != Some(&new[i]);
        if let Some(a) = (0..new.len()).find(|&i| differs(i)) {
            let b = (a..new.len()).rev().find(|&i| differs(i)).unwrap_or(a);
            self.line_changed(LineChanges { start: a, old_end: b + 1, new_end: b + 1 });
        }
    }

    /// A selection moved by a key: a head that landed in a folded section goes past it (moving
    /// forward, to the start of the next visible line) or to the end of its heading line.
    fn skip_folded(&self, s: Sel, dir: i32, extend: bool) -> Sel {
        let lines = &self.doc.lines;
        if extend && s.head == self.doc.text.len() && s.anchor != s.head {
            return s;
        }
        let Some((h, end)) = fold::hidden_at(lines, &self.fold_flags, s.head) else { return s };
        let p = if dir > 0 && end < lines.len() { snap(&self.doc, lines[end].from, 1) } else { lines[h].to };
        if extend { Sel::new(s.anchor, p) } else { Sel::caret(p) }
    }

    /// The end of line `li` including its newline (a triple click); a folded heading: its whole section.
    fn line_end_with_fold(&self, li: usize) -> usize {
        let lines = &self.doc.lines;
        let end = if self.fold_flags.get(li).is_some_and(|f| f & FOLDED != 0) { fold::section_end(lines, li) } else { li + 1 };
        if end < lines.len() { lines[end].from } else { self.doc.text.len() }
    }

    /// Enter / Shift-Enter at the end of a folded heading line: a new heading of the same level
    /// after its section (the only place after it outside the section), the section stays folded.
    fn enter_after_fold(&self) -> Option<Edit> {
        let s = self.sel;
        let lines = &self.doc.lines;
        let li = line_at(lines, s.head);
        if !s.is_empty() || self.read_only || self.fold_flags[li] & FOLDED == 0 || s.head != lines[li].to {
            return None;
        }
        let end = fold::section_end(lines, li);
        let prefix = format!("{} ", "#".repeat(lines[li].level as usize));
        let (at, ins, caret) = if end < lines.len() {
            let at = lines[end].from;
            (at, format!("{prefix}\n"), at + prefix.len())
        } else {
            let at = self.doc.text.len();
            (at, format!("\n{prefix}"), at + 1 + prefix.len())
        };
        Some(Edit { changes: vec![Change::new(at, at, ins)], sel: Sel::caret(caret), kind: EditKind::Input, then: None, converts: None })
    }

    /// Forward deletes at the end of a folded heading line unfold it first (they'd pull hidden text in).
    fn unfold_at_line_end(&mut self) {
        let li = line_at(&self.doc.lines, self.sel.head);
        if self.sel.is_empty() && self.sel.head == self.doc.lines[li].to && self.fold_flags[li] & FOLDED != 0 && !self.read_only {
            self.toggle_fold(li);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Keys

    /// Use a key table for `key` (the native macOS app: `KeyTable::standard()` plus the user's
    /// DefaultKeyBinding.dict); None: `keymap::resolve` (the default).
    pub fn set_key_table(&mut self, keys: Option<Arc<KeyTable>>) {
        self.keys = keys;
    }

    pub fn key_table(&self) -> Option<&Arc<KeyTable>> {
        self.keys.as_ref()
    }

    /// Handle a key press through the key table (`set_key_table`) or the key map. Returns the
    /// command run (of a binding to several, the last), or None if the key isn't the editor's.
    /// `ScrollToStart`/`ScrollToEnd`, `Page` and `CenterSelection` are returned for the UI to
    /// perform.
    ///
    /// When read-only, edits aren't run: Tab and the editing keys return None (left to the
    /// system, as `input.ts` does), the formatting and undo shortcuts are swallowed. Movement runs.
    pub fn key(&mut self, key: Key, mods: Mods, layout: &dyn Layout) -> Option<Command> {
        let cmds = match &self.keys {
            Some(t) => t.resolve(key, mods)?,
            None => vec![resolve(key, mods)?],
        };
        let mut last = None;
        for cmd in cmds {
            if self.read_only && cmd.is_edit() {
                if matches!(cmd, Command::ToggleFormat(_) | Command::Undo | Command::Redo) {
                    last = Some(cmd);
                }
                continue;
            }
            self.run(cmd, layout);
            last = Some(cmd);
        }
        last
    }

    /// Run a command.
    pub fn run(&mut self, cmd: Command, layout: &dyn Layout) {
        if !cmd.is_kill() {
            self.kill_chain = None;
        }
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
            Command::MoveLineEdge { dir, extend } => self.move_line_edge(layout, dir, extend),
            Command::ScrollToStart | Command::ScrollToEnd | Command::Page { .. } | Command::CenterSelection | Command::Noop => {}
            Command::DeleteBackwardDecomposing => self.delete_backward_decomposing(),
            Command::Yank => self.yank(),
            Command::Transpose => self.transpose(),
            Command::OpenLine => self.open_line(),
            Command::InsertChar(c) => self.insert_char(c),
            Command::SetMark => self.set_mark(),
            Command::SwapWithMark => self.swap_with_mark(),
            Command::SelectToMark => self.select_to_mark(),
            Command::DeleteToMark => self.delete_to_mark(),
            Command::SelectWord => self.select_word(),
            Command::SelectParagraph => self.select_paragraph(),
            Command::Tab { shift } => self.tab(shift),
            Command::InsertParagraph => self.insert_paragraph(),
            Command::InsertLineBreak => self.insert_line_break(),
            Command::DeleteBackward => self.delete_backward(),
            Command::DeleteForward => self.delete_forward(),
            Command::DeleteWordBackward => self.delete_word_backward(),
            Command::DeleteWordForward => self.delete_word_forward(),
            Command::DeleteToLineStart => self.delete_to_line_start(),
            Command::DeleteToLineEnd => self.delete_to_line_end(),
            Command::ToggleFold => {
                self.toggle_fold_at_caret();
            }
            Command::FoldAtCaret => {
                self.fold_at_caret();
            }
            Command::UnfoldAtCaret => {
                self.unfold_at_caret();
            }
            Command::FoldAll => self.fold_all(),
            Command::UnfoldAll => self.unfold_all(),
        }
    }
}
