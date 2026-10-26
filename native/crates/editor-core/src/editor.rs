//! The editor model: raw markdown text, the selection, undo history and the command API the UI
//! calls. Mirrors the TS `EditorView` + input controller, minus the DOM.

use crate::history::{History, Op, Popped};
use crate::keymap::{Command, Key, Mods, resolve};
use crate::layout::Layout;
use crate::navigation::{self as nav, HUnit};
use crate::parser::{BlockType, Doc, line_at, literal_line};
use crate::render::{LineView, render_lines};
use crate::reveal::{RevealMap, compute_reveal};
use crate::rules::{self, Change, Edit, EditKind, FormatType, map_pos};
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

#[derive(Clone, Debug)]
pub struct Editor {
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
    /// Selection when an IME composition started.
    composing: Option<Sel>,
}

/// CRLF and lone CR become LF (as pasted text is normalized).
fn normalize_newlines(s: &str) -> String {
    if s.contains('\r') { s.replace("\r\n", "\n").replace('\r', "\n") } else { s.to_string() }
}

/// Map a selection like the TS relative positions: a caret sticks to the character before it; a
/// selection's start sticks right and its end left.
fn map_sel(sel: Sel, changes: &[Change]) -> Sel {
    let collapsed = sel.is_empty();
    let fwd = sel.anchor <= sel.head;
    let a = if collapsed || !fwd { -1 } else { 1 };
    let h = if collapsed || fwd { -1 } else { 1 };
    Sel { anchor: map_pos(sel.anchor, changes, a), head: map_pos(sel.head, changes, h) }
}

impl Editor {
    pub fn new(text: &str) -> Editor {
        let doc = Doc::parse(normalize_newlines(text));
        // start at the first line's text, after any block prefix
        let sel = Sel::caret(doc.lines[0].text_from);
        Editor {
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
            composing: None,
        }
    }

    // ------------------------------------------------------------------------------------------
    // State

    pub fn text(&self) -> &str {
        &self.doc.text
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
        let text = &normalize_newlines(text);
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
        op.apply(&mut self.doc.text);
        self.map_positions(std::slice::from_ref(&op));
        let sel = map_sel(self.sel, &ch);
        self.composing = self.composing.map(|c| map_sel(c, &ch));
        self.swallow_space_at = self.swallow_space_at.map(|q| map_pos(q, &ch, -1));
        self.last_edit_pos = None;
        self.click_pos = None;
        self.click_image = None;
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

    /// Re-parse the text and apply the local literal-line state.
    fn reparse(&mut self) {
        let text = std::mem::take(&mut self.doc.text);
        self.doc = Doc::parse(text);
        let mut keep = Vec::new();
        for &id in &self.active_lits {
            if let Some(li) = self.literal_line_index(id) {
                self.doc.lines[li] = literal_line(&self.doc.text, &self.doc.lines[li], self.lits[id].from);
                keep.push(id);
            }
        }
        self.active_lits = keep;
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
            op.apply(&mut self.doc.text);
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
    /// source and moves the image, so later clicks of the sequence act on the image it hit.
    pub fn mouse_down(&mut self, layout: &dyn Layout, x: f64, y: f64, count: u32, shift: bool) {
        self.history.stop();
        self.goal_x = None;
        let mut image = layout.image_at(x, y);
        if count >= 2 && self.click_image.is_some() {
            image = self.click_image;
        }
        if count <= 1 {
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
        if count <= 1 {
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
