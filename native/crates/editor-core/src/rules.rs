//! Editing rules: pure functions from (document, selection, intent) to an edit.
//! Edits are lists of non-overlapping changes in original-document coordinates plus the selection
//! afterwards.

use crate::parser::{BlockType, Doc, InlineEl, InlineType, Line, TokenKind, line_at, parse_blocks, parse_doc, trim_range};
use crate::units::{Sel, next_stop, prev_stop, word_char_at, word_char_before, word_left, word_range, word_right};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

impl Change {
    pub fn new(from: usize, to: usize, insert: impl Into<String>) -> Change {
        Change { from, to, insert: insert.into() }
    }
}

/// "Convert", "Paste", "Toggle" and "Structure" (table rows) edits are undo steps of their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EditKind {
    Input,
    Convert,
    Paste,
    Format,
    Toggle,
    Structure,
}

impl EditKind {
    pub fn is_separate(self) -> bool {
        matches!(self, EditKind::Convert | EditKind::Paste | EditKind::Toggle | EditKind::Structure)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub changes: Vec<Change>,
    pub sel: Sel,
    pub kind: EditKind,
    /// A follow-up edit applied as its own undo step (the auto-space of a quote).
    pub then: Option<Box<Edit>>,
    /// The edit auto-converted the caret's line (e.g. "- " became a bullet): the editor records an
    /// undo step that shows the line literally again, without changing the text.
    pub converts: Option<BlockType>,
}

fn edit(changes: Vec<Change>, sel: Sel, kind: EditKind) -> Edit {
    Edit { changes, sel, kind, then: None, converts: None }
}

fn input(changes: Vec<Change>, sel: Sel) -> Edit {
    edit(changes, sel, EditKind::Input)
}

pub fn apply_changes(text: &str, changes: &[Change]) -> String {
    let mut sorted = changes.to_vec();
    sorted.sort_by_key(|c| std::cmp::Reverse(c.from));
    let mut out = text.to_string();
    for c in sorted {
        out.replace_range(c.from..c.to, &c.insert);
    }
    out
}

/// Map a position through changes (original coordinates -> new). `assoc < 0` keeps it before
/// insertions at `pos`.
pub fn map_pos(pos: usize, changes: &[Change], assoc: i32) -> usize {
    let mut delta: isize = 0;
    for c in changes {
        let ins = c.insert.len() as isize;
        if c.to < pos || (c.to == pos && c.from < pos) {
            delta += ins - (c.to - c.from) as isize;
        } else if c.from <= pos && pos <= c.to {
            if c.from == pos && c.to == pos {
                if assoc > 0 {
                    delta += ins;
                }
            } else {
                delta += c.from as isize - pos as isize + if assoc > 0 { ins } else { 0 };
            }
        }
    }
    (pos as isize + delta) as usize
}

fn line_of(doc: &Doc, pos: usize) -> &Line {
    doc.line_of(pos)
}

/// Replace the selection with `s`.
pub fn replace_selection(_doc: &Doc, sel: Sel, s: &str, kind: EditKind) -> Edit {
    let (a, b) = (sel.from(), sel.to());
    edit(vec![Change::new(a, b, s)], Sel::caret(a + s.len()), kind)
}

/// Run `rule` on the document with the selection deleted, then express the combined result in the
/// original document's coordinates.
fn with_selection_deleted(doc: &Doc, sel: Sel, rule: impl Fn(&Doc, usize, bool) -> Option<Edit>) -> Option<Edit> {
    let (a, b) = (sel.from(), sel.to());
    if a == b {
        return rule(doc, a, false);
    }
    let mut doc2 = parse_doc(&format!("{}{}", &doc.text[..a], &doc.text[b..]));
    doc2.url_text = doc.url_text;
    let Some(e2) = rule(&doc2, a, true) else {
        return Some(input(vec![Change::new(a, b, "")], Sel::caret(a)));
    };
    let d = b - a;
    let mut changes = Vec::new();
    let mut covered = false;
    for c in e2.changes {
        if c.from <= a && a <= c.to {
            covered = true;
            let to = if c.to < a { c.to } else { c.to + d };
            changes.push(Change { from: c.from, to, insert: c.insert });
        } else if c.to < a {
            changes.push(c);
        } else {
            changes.push(Change { from: c.from + d, to: c.to + d, insert: c.insert });
        }
    }
    if !covered {
        changes.push(Change::new(a, b, ""));
    }
    Some(edit(changes, e2.sel, e2.kind))
}

// -----------------------------------------------------------------------------------------------
// Typing

/// Typed text, including auto-conversions (flagged with `converts`).
pub fn insert_text(doc: &Doc, sel: Sel, s: &str) -> Edit {
    let a = sel.from();
    let line = line_of(doc, a);
    if s == ">" && a == sel.to() && line.ty == BlockType::Paragraph && a == line.text_from {
        // ">" converts immediately: the auto-inserted space is its own undo step (undo leaves a literal ">")
        let mut e = input(vec![Change::new(a, a, ">")], Sel::caret(a + 1));
        e.then = Some(Box::new(edit(vec![Change::new(a + 1, a + 1, " ")], Sel::caret(a + 2), EditKind::Convert)));
        return e;
    }
    let mut e = replace_selection(doc, sel, s, EditKind::Input);
    if s.contains('\n') || matches!(line.ty, BlockType::Code | BlockType::Fence) {
        return e;
    }
    // only the edited line can change type: re-parse just that line
    let b = sel.to();
    if b > line.to {
        return e;
    }
    let line_text = format!("{}{}{}", &doc.text[line.from..a], s, &doc.text[b..line.to]);
    let after = &parse_blocks(&line_text)[0];
    if is_conversion(line, after) {
        e.converts = Some(line.ty);
    }
    e
}

fn is_conversion(before: &Line, after: &Line) -> bool {
    if before.ty == after.ty {
        return false;
    }
    match before.ty {
        BlockType::Paragraph => after.ty == BlockType::Heading || after.ty.is_list() || after.ty == BlockType::Hr,
        BlockType::Bullet => after.ty == BlockType::Todo,
        _ => false,
    }
}

pub fn paste(doc: &Doc, sel: Sel, s: &str) -> Edit {
    let normalized = s.replace("\r\n", "\n").replace('\r', "\n");
    replace_selection(doc, sel, &normalized, EditKind::Paste)
}

// -----------------------------------------------------------------------------------------------
// Enter

/// Prefix for a new item of the same kind as `line` (same raw indentation); `next` increments numbers.
fn item_prefix(doc: &Doc, line: &Line, next: bool) -> String {
    let tok = line.tokens[line.tokens.len() - 1];
    let indent = &doc.text[line.from..tok.from];
    let raw = &doc.text[tok.from..tok.to];
    let lead_len = raw.bytes().take_while(|&b| b == b' ').count();
    let lead = &raw[..lead_len];
    let mark = &raw[lead_len..];
    match line.ty {
        BlockType::Todo => format!("{indent}{lead}{} [ ] ", &mark[..1]),
        BlockType::Numbered => format!("{indent}{lead}{}. ", if next { line.number + 1 } else { line.number }),
        _ => format!("{indent}{raw}"),
    }
}

pub fn insert_paragraph(doc: &Doc, sel: Sel) -> Option<Edit> {
    with_selection_deleted(doc, sel, |d, pos, had_selection| {
        let line = line_of(d, pos);
        let plain = input(vec![Change::new(pos, pos, "\n")], Sel::caret(pos + 1));
        if line.ty == BlockType::Fence && pos == line.to && has_unclosed_block(d) {
            return Some(input(vec![Change::new(pos, pos, "\n\n```")], Sel::caret(pos + 1)));
        }
        if matches!(line.ty, BlockType::Code | BlockType::Fence | BlockType::Hr) {
            return Some(plain);
        }
        if line.table.is_some() {
            // before a header row's first pipe: a plain line above the table
            if line.ty == BlockType::TableHead && pos == line.from {
                return Some(plain);
            }
            return Some(table_enter(d, line, !had_selection));
        }
        if !line.tokens.is_empty() && pos == line.from {
            return Some(plain);
        }
        // between indent tokens: an empty line above
        if pos > line.from && pos < line.text_from {
            return Some(input(vec![Change::new(line.from, line.from, "\n")], Sel::caret(pos + 1)));
        }
        if line.ty == BlockType::Heading && line.text_from == line.to && !had_selection {
            return Some(input(vec![Change::new(line.from, line.to, "")], Sel::caret(line.from)));
        }
        if line.ty.is_list() {
            if line.text_from == line.to && !had_selection {
                // empty item: drop the token, the line becomes an empty paragraph
                return Some(input(vec![Change::new(line.from, line.to, "")], Sel::caret(line.from)));
            }
            if pos == line.text_from && line.text_from < line.to {
                let empty = item_prefix(d, line, false);
                let n = empty.len();
                return Some(input(vec![Change::new(line.from, line.from, empty + "\n")], Sel::caret(pos + n + 1)));
            }
            let cont = item_prefix(d, line, true);
            let n = cont.len();
            return Some(input(vec![Change::new(pos, pos, format!("\n{cont}"))], Sel::caret(pos + 1 + n)));
        }
        if line.ty == BlockType::Heading && pos == line.text_from && line.text_from < line.to {
            return Some(input(vec![Change::new(line.from, line.from, "\n")], Sel::caret(pos + 1)));
        }
        Some(plain)
    })
}

fn has_unclosed_block(doc: &Doc) -> bool {
    let last = &doc.lines[doc.lines.len() - 1];
    let Some(bs) = last.block_start else { return false };
    !(last.ty == BlockType::Fence && last.index != bs)
}

/// Shift-Enter: a raw newline.
pub fn insert_line_break(doc: &Doc, sel: Sel) -> Edit {
    replace_selection(doc, sel, "\n", EditKind::Input)
}

// -----------------------------------------------------------------------------------------------
// Deletion

fn delete_range(from: usize, to: usize) -> Option<Edit> {
    if from == to {
        return None;
    }
    Some(input(vec![Change::new(from, to, "")], Sel::caret(from)))
}

pub fn delete_backward(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    let line = line_of(doc, sel.head);
    // after a horizontal rule: remove the rule token, leaving an empty line
    if line.ty == BlockType::Hr
        && sel.head == line.to
        && let Some(hr) = line.tokens.iter().find(|t| t.kind == TokenKind::Hr)
    {
        return delete_range(hr.from, hr.to);
    }
    delete_range(prev_stop(doc, sel.head), sel.head)
}

pub fn delete_forward(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    let pos = sel.head;
    let line = line_of(doc, pos);
    let tok = line.tokens.iter().find(|t| t.from == pos);
    if tok.is_some_and(|t| t.kind == TokenKind::Heading) && line.level > 1 {
        return delete_range(pos, pos + 1);
    }
    // at the end of a line: join the next line raw (just the newline)
    if pos == line.to && pos < doc.text.len() {
        return delete_range(pos, pos + 1);
    }
    delete_range(pos, next_stop(doc, pos))
}

/// Option-Backspace: same boundaries as Option-Left (non-word characters, then a word).
pub fn delete_word_backward(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    delete_range(word_left(doc, sel.head), sel.head)
}

pub fn delete_word_forward(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    delete_range(sel.head, word_right(doc, sel.head))
}

/// Cmd-Backspace: delete to the start of the text, then the token, then join lines.
pub fn delete_to_line_start(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    let pos = sel.head;
    let line = line_of(doc, pos);
    if pos > line.text_from {
        return delete_range(line.text_from, pos);
    }
    delete_range(prev_stop(doc, pos), pos)
}

pub fn delete_to_line_end(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    let pos = sel.head;
    let line = line_of(doc, pos);
    if pos < line.to {
        return delete_range(pos.max(line.from), line.to);
    }
    delete_range(pos, next_stop(doc, pos))
}

// -----------------------------------------------------------------------------------------------
// Tab / Shift-Tab

pub fn tab(doc: &Doc, sel: Sel, shift: bool) -> Option<Edit> {
    let (a, b) = (sel.from(), sel.to());
    let l0 = line_at(&doc.lines, a);
    let l1 = line_at(&doc.lines, b);
    let map_sel = |changes: &[Change]| Sel { anchor: map_pos(sel.anchor, changes, 1), head: map_pos(sel.head, changes, 1) };
    if l0 != l1 && doc.lines[l0..=l1].iter().any(|l| l.table.is_some()) {
        // a selection touching a table never indents rows: navigate within one table, else do nothing
        if let (Some(s0), Some(s1)) = (&doc.lines[l0].table, &doc.lines[l1].table)
            && s0.start == s1.start
        {
            return Some(table_tab(doc, &doc.lines[line_at(&doc.lines, sel.head)], sel.head, shift));
        }
        return Some(input(vec![], sel));
    }
    if l0 != l1 {
        let mut changes = Vec::new();
        for line in &doc.lines[l0..=l1] {
            if shift {
                if let Some(c) = outdent_change(line) {
                    changes.push(c);
                }
            } else if !matches!(line.ty, BlockType::Code | BlockType::Fence) && line.from < line.to {
                changes.push(Change::new(line.from, line.from, line.indent_unit.clone()));
            }
        }
        if changes.is_empty() {
            return None;
        }
        let s = map_sel(&changes);
        return Some(input(changes, s));
    }
    let line = &doc.lines[l0];
    if line.table.is_some() {
        return Some(table_tab(doc, line, a, shift));
    }
    if shift {
        if line.ty == BlockType::Paragraph {
            return Some(input(vec![], sel));
        }
        if matches!(line.ty, BlockType::Code | BlockType::Fence) {
            if doc.text.as_bytes().get(line.from) != Some(&b'\t') {
                return None;
            }
            let changes = vec![Change::new(line.from, line.from + 1, "")];
            let s = map_sel(&changes);
            return Some(input(changes, s));
        }
        let first = outdent_change(line)?;
        let s = map_sel(std::slice::from_ref(&first));
        return Some(input(vec![first], s));
    }
    if matches!(line.ty, BlockType::Code | BlockType::Fence | BlockType::Heading | BlockType::Hr) {
        return Some(replace_selection(doc, sel, "\t", EditKind::Input));
    }
    if line.ty.is_list() {
        if a == b && a > line.text_from {
            return Some(replace_selection(doc, sel, "\t", EditKind::Input));
        }
        let prev = if l0 > 0 { Some(&doc.lines[l0 - 1]) } else { None };
        let max = match prev {
            Some(p) if p.ty.is_list() => p.indent + 1,
            _ => 0,
        };
        if line.indent >= max {
            return Some(input(vec![], sel));
        }
        // same unit as the line's own indentation, else as the item above, else a tab
        let unit = if line.indent > 0 {
            line.indent_unit.clone()
        } else if let Some(p) = prev.filter(|p| p.indent > 0) {
            p.indent_unit.clone()
        } else {
            "\t".to_string()
        };
        let changes = vec![Change::new(line.from, line.from, unit)];
        let s = map_sel(&changes);
        return Some(input(changes, s));
    }
    Some(replace_selection(doc, sel, "\t", EditKind::Input))
}

// -----------------------------------------------------------------------------------------------
// Tables

/// Where the caret goes in a cell: its text start (after the padding; one space in for an empty cell).
fn cell_target(text: &str, (cf, ct): (usize, usize)) -> usize {
    let (a, b) = trim_range(text, cf, ct);
    if a < b { a } else { (cf + 1).min(ct) }
}

/// Enter in a table: a new empty row below (below the delimiter row when on the header) with the
/// caret in its first cell; on an empty last row, the row is removed, which ends the table.
fn table_enter(doc: &Doc, line: &Line, can_exit: bool) -> Edit {
    let tb = line.table.as_ref().unwrap();
    let empty_row = line.text(&doc.text).chars().all(|c| c == '|' || crate::text::is_ws(c));
    if can_exit && line.ty == BlockType::TableRow && line.index == tb.end && empty_row {
        return edit(vec![Change::new(line.from, line.to, "")], Sel::caret(line.from), EditKind::Structure);
    }
    let after = if line.ty == BlockType::TableHead { &doc.lines[line.index + 1] } else { line };
    let n = doc.lines[tb.start].table.as_ref().unwrap().cells.len();
    let row = format!("|{}", " |".repeat(n));
    edit(vec![Change::new(after.to, after.to, format!("\n{row}"))], Sel::caret(after.to + 3), EditKind::Structure)
}

/// Tab / Shift-Tab in a table: next / previous cell (across rows; Tab after the last cell adds a row).
fn table_tab(doc: &Doc, line: &Line, pos: usize, shift: bool) -> Edit {
    let tb = line.table.as_ref().unwrap();
    struct Target {
        line: usize,
        from: usize,
        to: usize,
        pos: usize,
    }
    let mut targets = Vec::new();
    for k in tb.start..=tb.end {
        let l = &doc.lines[k];
        if l.ty == BlockType::TableDelim {
            continue;
        }
        for &cell in &l.table.as_ref().unwrap().cells {
            targets.push(Target { line: k, from: cell.0, to: cell.1, pos: cell_target(&doc.text, cell) });
        }
    }
    let mut g: isize = targets
        .iter()
        .position(|t| t.line == line.index && t.from <= pos && pos <= t.to)
        .map_or(-1, |p| p as isize);
    if g < 0 && line.ty != BlockType::TableDelim {
        // before a row's leading pipe: in its first cell; after its trailing pipe: in its last cell
        let own: Vec<usize> = targets.iter().enumerate().filter(|(_, t)| t.line == line.index).map(|(k, _)| k).collect();
        if let (Some(&first), Some(&last)) = (own.first(), own.last()) {
            g = if pos < targets[first].from { first } else { last } as isize;
        }
    }
    let (next, prev) = if g >= 0 {
        (g + 1, g - 1)
    } else {
        // before the first cell, or on the delimiter row
        let after = targets.iter().position(|t| t.line > line.index || (t.line == line.index && t.from >= pos));
        let next = after.unwrap_or(targets.len()) as isize;
        (next, next - 1)
    };
    let g = if shift { prev } else { next };
    if g < 0 {
        return input(vec![], Sel::caret(pos));
    }
    if g as usize >= targets.len() {
        return table_enter(doc, &doc.lines[tb.end], false);
    }
    input(vec![], Sel::caret(targets[g as usize].pos))
}

/// Remove one indent level: the line's first indent token (a tab or a unit of spaces).
fn outdent_change(line: &Line) -> Option<Change> {
    let t = line.tokens.first()?;
    (t.kind == TokenKind::Indent).then(|| Change::new(t.from, t.to, ""))
}

// -----------------------------------------------------------------------------------------------
// Cmd-B / Cmd-I / Cmd-U

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FormatType {
    Bold,
    Italic,
    Underline,
    Strike,
    Highlight,
}

impl FormatType {
    pub fn marker(self) -> &'static str {
        match self {
            FormatType::Bold => "**",
            FormatType::Italic => "*",
            FormatType::Underline => "~",
            FormatType::Strike => "~~",
            FormatType::Highlight => "==",
        }
    }
    fn inline_type(self) -> InlineType {
        match self {
            FormatType::Bold => InlineType::Bold,
            FormatType::Italic => InlineType::Italic,
            FormatType::Underline => InlineType::Underline,
            FormatType::Strike => InlineType::Strike,
            FormatType::Highlight => InlineType::Highlight,
        }
    }
}

fn marker_only(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'*' | b'_' | b'~' | b'='))
}

fn unwrap(el: &InlineEl, sel: Sel) -> Edit {
    let (o, c) = (el.markers[0], el.markers[1]);
    let changes = vec![Change::new(o.0, o.1, ""), Change::new(c.0, c.1, "")];
    let ol = o.1 - o.0;
    let m = |p: usize| {
        if p <= o.0 {
            p
        } else if p <= o.1 {
            o.0
        } else if p <= c.0 {
            p - ol
        } else {
            c.0 - ol
        }
    };
    edit(changes, Sel { anchor: m(sel.anchor), head: m(sel.head) }, EditKind::Format)
}

pub fn toggle_format(doc: &Doc, sel: Sel, ty: FormatType) -> Option<Edit> {
    let mk = ty.marker();
    let l = mk.len();
    let (a, b) = (sel.from(), sel.to());
    let line = line_of(doc, a);
    if matches!(line.ty, BlockType::Code | BlockType::Fence | BlockType::Hr | BlockType::TableDelim) {
        return None;
    }
    // in a table, the selection must stay inside one cell (never wrap across a pipe)
    if let Some(tb) = &line.table
        && !tb.cells.iter().any(|&(cf, ct)| cf <= a && b <= ct)
    {
        return None;
    }
    let els: Vec<&InlineEl> = line.inline.iter().filter(|e| e.ty == ty.inline_type()).collect();
    let t = &doc.text;
    if a != b && b <= line.text_from {
        return None;
    }
    if a < line.text_from {
        // never put markers before a block token
        let tf = line.text_from;
        let sel2 = if a == b {
            Sel::caret(tf)
        } else if sel.anchor <= sel.head {
            Sel::new(tf, b)
        } else {
            Sel::new(b, tf)
        };
        return toggle_format(doc, sel2, ty);
    }
    if a != b {
        if line_at(&doc.lines, b) != line.index {
            return None;
        }
        for el in &els {
            let inside = el.content_from <= a
                && b <= el.content_to
                && marker_only(&t[el.content_from..a])
                && marker_only(&t[b..el.content_to]);
            if inside || (el.from == a && el.to == b) {
                return Some(unwrap(el, sel));
            }
        }
        let changes = vec![Change::new(a, a, mk), Change::new(b, b, mk)];
        let fwd = sel.anchor <= sel.head;
        let s = if fwd { Sel::new(a + l, b + l) } else { Sel::new(b + l, a + l) };
        return Some(edit(changes, s, EditKind::Format));
    }
    let pos = a;
    for el in &els {
        if el.from <= pos && pos <= el.to {
            return Some(unwrap(el, sel));
        }
    }
    let in_word = pos > line.text_from && word_char_before(doc, pos) && word_char_at(doc, pos);
    if in_word && let Some((w0, w1)) = word_range(doc, pos) {
        let changes = vec![Change::new(w0, w0, mk), Change::new(w1, w1, mk)];
        return Some(edit(changes, Sel::caret(pos + l), EditKind::Format));
    }
    if pos >= l && t.get(pos - l..pos) == Some(mk) && t.get(pos..pos + l) == Some(mk) {
        return Some(edit(vec![Change::new(pos - l, pos + l, "")], Sel::caret(pos - l), EditKind::Format));
    }
    Some(edit(vec![Change::new(pos, pos, format!("{mk}{mk}"))], Sel::caret(pos + l), EditKind::Format))
}

// -----------------------------------------------------------------------------------------------
// Todo checkbox

pub fn toggle_todo(doc: &Doc, line_index: usize) -> Option<Edit> {
    let line = doc.lines.get(line_index)?;
    if line.ty != BlockType::Todo {
        return None;
    }
    let tok = line.tokens[line.tokens.len() - 1];
    let i = tok.from + doc.text[tok.from..].find('[')? + 1;
    Some(edit(
        vec![Change::new(i, i + 1, if line.checked { " " } else { "x" })],
        Sel::caret(line.text_from),
        EditKind::Toggle,
    ))
}
