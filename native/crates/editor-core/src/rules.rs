//! Editing rules: pure functions from (document, selection, intent) to an edit.
//! Edits are lists of non-overlapping changes in original-document coordinates plus the selection
//! afterwards.

use crate::parser::{BlockType, Doc, InlineEl, InlineType, Line, TokenKind, line_at, parse_blocks, parse_doc, trim_range};
use crate::units::{Sel, is_collapsed_link, link_plain_char, next_stop, prev_stop, word_char_at, word_char_before, word_left, word_range, word_right};

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
    /// Move Item: its own undo step; undoing it puts the selection back where it was (rather than selecting
    /// the text it re-inserts).
    Move,
}

impl EditKind {
    pub fn is_separate(self) -> bool {
        matches!(self, EditKind::Convert | EditKind::Paste | EditKind::Toggle | EditKind::Structure | EditKind::Move)
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
    doc2.expanded_link = doc.expanded_link.and_then(|p| if p < a { Some(p) } else { (p >= b).then(|| p - (b - a)) });
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
    let mut e = replace_selection(doc, sel, &normalized, EditKind::Paste);
    e.then = paste_url(doc, sel, &normalized).map(Box::new);
    e
}

/// Pasting one full URL (`http(s)://…` or `mailto:…`, surrounding whitespace aside) makes a link, as a follow-up
/// to the plain paste (`Edit::then`, so one undo gives the plain paste back): over a selection on one line,
/// `[selection](url)`; else the URL alone, bare when it reads as an autolink literal right there
/// (`parser::autolink_literal`), else `<url>`. Inside code, a link or an autolink: None (plain).
fn paste_url(doc: &Doc, sel: Sel, s: &str) -> Option<Edit> {
    let url = pasted_url(s)?;
    let (a, b) = (sel.from(), sel.to());
    // in a link's destination being written: `[a](|`
    if [a, b].iter().any(|&p| in_code_or_link(doc, p)) || doc.text[..a].ends_with("](") {
        return None;
    }
    let pasted = a + s.len();
    let selected = &doc.text[a..b];
    let mailto = url.len() >= 7 && url[..7].eq_ignore_ascii_case("mailto:");
    if !selected.trim().is_empty() && !selected.contains(['\n', '[', ']']) {
        let text = selected.trim();
        let lead = &selected[..selected.len() - selected.trim_start().len()];
        let trail = &selected[selected.trim_end().len()..];
        // a destination with unbalanced parentheses goes in angle brackets
        let balanced = url.matches('(').count() == url.matches(')').count();
        let dest = if balanced { url.to_string() } else { format!("<{url}>") };
        let link = format!("{lead}[{text}]({dest}){trail}");
        return Some(edit(vec![Change::new(a, pasted, link.clone())], Sel::caret(a + link.len()), EditKind::Convert));
    }
    let bare = !mailto && {
        let text = format!("{}{url}{}", &doc.text[..a], &doc.text[b..]);
        let d = parse_doc(&text);
        d.line_of(a).inline.iter().any(|e| e.ty == InlineType::Autolink && e.markers.is_empty() && e.from == a && e.to == a + url.len())
    };
    let ins = if bare { url.to_string() } else { format!("<{url}>") };
    (ins != s).then(|| edit(vec![Change::new(a, pasted, ins.clone())], Sel::caret(a + ins.len()), EditKind::Convert))
}

/// The pasted text is one full URL: `http(s)://` and more, or `mailto:` and an address; no spaces or `<>` inside.
fn pasted_url(s: &str) -> Option<&str> {
    let url = s.trim();
    let has = |p: &str| url.len() > p.len() && url.as_bytes()[..p.len()].eq_ignore_ascii_case(p.as_bytes());
    let ok = (has("https://") || has("http://") || (has("mailto:") && url.contains('@'))) && !url.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>'));
    ok.then_some(url)
}

/// `pos` is in a code block or inline code, or inside a link, image or autolink.
fn in_code_or_link(doc: &Doc, pos: usize) -> bool {
    let line = line_of(doc, pos);
    if line.block_start.is_some() || matches!(line.ty, BlockType::Code | BlockType::Fence) {
        return true;
    }
    line.inline.iter().any(|e| match e.ty {
        InlineType::Code => e.content_from <= pos && pos <= e.content_to,
        InlineType::Link | InlineType::Image | InlineType::Autolink => e.from < pos && pos < e.to,
        _ => false,
    })
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

/// Delete [p, q) at the caret (`dir` < 0: backwards, the caret at q). A collapsed link's hidden
/// brackets and URL only go with the whole link: a range reaching into its text deletes just the
/// text it covers (for a character step the nearest plain character, not a nested style's marker),
/// and a range covering all its text deletes the link.
fn caret_delete(doc: &Doc, p: usize, q: usize, dir: i32, char_step: bool) -> Option<Edit> {
    if p == q {
        return None;
    }
    let mut pieces = vec![(p, q)];
    let mut seen = Vec::new();
    for line in &doc.lines[line_at(&doc.lines, p)..=line_at(&doc.lines, q)] {
        for el in line.inline.iter().filter(|e| is_collapsed_link(doc, e)) {
            if !(el.from < q && p < el.to) || (p <= el.from && el.to <= q) || seen.contains(&el.from) {
                continue;
            }
            seen.push(el.from);
            let (from, to, c0, c1) = (el.from, el.to, el.content_from, el.content_to);
            let rest_plain = link_plain_char(doc, line, el, c0, p, 1).or_else(|| link_plain_char(doc, line, el, q, c1, 1));
            if rest_plain.is_none() {
                // nothing drawn would be left: the whole link
                for r in &mut pieces {
                    if r.0 < to && from < r.1 {
                        *r = (r.0.min(from), r.1.max(to));
                    }
                }
                continue;
            }
            let mut out = Vec::new();
            for (a, b) in pieces {
                let outside = [(a, b.min(from)), (a.max(to), b)];
                let mut inside = (a.max(c0), b.min(c1));
                if char_step && inside.0 < inside.1 && !all_plain(line, inside) {
                    // a nested style's markers in it: just the plain character (the nearest one)
                    let (s, e) = if dir < 0 { (c0, inside.1) } else { (inside.0, c1) };
                    let near = link_plain_char(doc, line, el, inside.0, inside.1, dir).or_else(|| link_plain_char(doc, line, el, s, e, dir));
                    inside = near.unwrap_or((inside.0, inside.0));
                }
                out.extend(outside.into_iter().chain([inside]).filter(|r| r.0 < r.1));
            }
            out.sort();
            pieces = out;
        }
    }
    pieces.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (a, b) in pieces {
        match merged.last_mut() {
            Some(m) if a <= m.1 => m.1 = m.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    let changes: Vec<Change> = merged.iter().map(|&(a, b)| Change::new(a, b, "")).collect();
    if changes.is_empty() {
        return None;
    }
    let caret = map_pos(if dir < 0 { q } else { p }, &changes, -1);
    Some(input(changes, Sel::caret(caret)))
}

/// No element's markers in [a, b) (escape pairs are fine: they go whole).
fn all_plain(line: &Line, (a, b): (usize, usize)) -> bool {
    !line.inline.iter().any(|e| e.markers.iter().any(|&(m0, m1)| m0 < b && a < m1))
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
    caret_delete(doc, prev_stop(doc, sel.head), sel.head, -1, true)
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
    caret_delete(doc, pos, next_stop(doc, pos), 1, true)
}

/// Option-Backspace: same boundaries as Option-Left (non-word characters, then a word).
pub fn delete_word_backward(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    caret_delete(doc, word_left(doc, sel.head), sel.head, -1, false)
}

pub fn delete_word_forward(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    caret_delete(doc, sel.head, word_right(doc, sel.head), 1, false)
}

/// Cmd-Backspace: delete to the start of the text, then the token, then join lines.
pub fn delete_to_line_start(doc: &Doc, sel: Sel) -> Option<Edit> {
    if !sel.is_empty() {
        return delete_range(sel.from(), sel.to());
    }
    let pos = sel.head;
    let line = line_of(doc, pos);
    if pos > line.text_from {
        return caret_delete(doc, line.text_from, pos, -1, false);
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
        return caret_delete(doc, pos.max(line.from), line.to, 1, false);
    }
    delete_range(pos, next_stop(doc, pos))
}

// -----------------------------------------------------------------------------------------------
// Delete Item (Cmd-D)

/// Cmd-D: delete the item at the caret, or every item the selection touches, as one undo step
/// (`item_lines` says what an item is). When the item had a blank line on both sides (or the
/// document's edge), one of them goes too. Numbered siblings after it that continued its numbering
/// are renumbered. The caret goes to the start of the next item, or of the previous one when there's
/// none after it (a list item: the next sibling at its level, else the previous one, else the next
/// list line).
pub fn delete_item(doc: &Doc, sel: Sel) -> Option<Edit> {
    let lines = &doc.lines;
    let n = lines.len();
    let (first, last) = selected_lines(doc, sel);
    let (mut a, mut b) = items_lines(doc, first, last);
    let (item_a, item_b) = (a, b);
    let blank = |li: usize| is_blank_line(doc, &lines[li]);
    if !(a == b && blank(a)) && (a == 0 || blank(a - 1)) && (b + 1 == n || blank(b + 1)) && !(a == 0 && b + 1 == n) {
        if b + 1 < n {
            b += 1;
        } else {
            a -= 1;
        }
    }
    let (from, to, has_next) = if b + 1 < n {
        (lines[a].from, lines[b + 1].from, true)
    } else if a > 0 {
        (lines[a - 1].to, lines[b].to, false)
    } else {
        (0, doc.text.len(), false)
    };
    let mut changes = vec![Change::new(from, to, "")];
    let top = &lines[item_a];
    let level = top.indent;
    let list = is_item(top.ty);
    if top.ty == BlockType::Numbered {
        let gone: Vec<&Line> = lines[item_a..=item_b].iter().filter(|l| l.ty == BlockType::Numbered && l.indent == level).collect();
        let mut expect = gone.last().map_or(top.number, |l| l.number) + 1;
        let mut number = top.number;
        for l in &lines[item_b + 1..] {
            if l.ty == BlockType::Numbered && l.indent == level {
                if l.number != expect {
                    break;
                }
                let Some((d0, d1)) = number_digits(doc, l) else { break };
                if number != l.number {
                    changes.push(Change::new(d0, d1, number.to_string()));
                }
                number += 1;
                expect += 1;
            } else if !((is_nested(l.ty) && l.indent > level) || is_continuation(doc, l)) {
                break;
            }
        }
    }
    let new = parse_doc(&apply_changes(&doc.text, &changes));
    let nl = &new.lines;
    let next = has_next.then(|| line_at(nl, from));
    let prev = match next {
        Some(i) => i.checked_sub(1),
        None if from == 0 => None,
        None => Some(nl.len() - 1),
    };
    let start = |li: usize| nl[item_lines(&new, li).0].text_from;
    let mut caret = None;
    if list {
        let same = |l: &Line| is_item(l.ty) && l.indent == level;
        if let Some(i) = next.filter(|&i| same(&nl[i])) {
            caret = Some(nl[i].text_from);
        } else if let Some(mut p) = prev {
            while p > 0 && ((is_nested(nl[p].ty) && nl[p].indent > level) || is_continuation(&new, &nl[p])) {
                p -= 1;
            }
            if same(&nl[p]) {
                caret = Some(nl[p].text_from);
            }
        }
        if caret.is_none() {
            caret = next.filter(|&i| is_item(nl[i].ty)).map(|i| nl[i].text_from);
        }
    }
    let caret = caret
        .or_else(|| next.and_then(|i| (i..nl.len()).find(|&j| !is_blank_line(&new, &nl[j]))).map(start))
        .or_else(|| prev.and_then(|i| (0..=i).rev().find(|&j| !is_blank_line(&new, &nl[j]))).map(start))
        .unwrap_or(from.min(new.text.len()));
    Some(edit(changes, Sel::caret(caret), EditKind::Structure))
}

/// The lines (first, last) of the item line `li` is in: a list item (bullet, todo, numbered) with
/// the paragraph lines continuing it and what's nested under it (items, quotes); a quote's
/// run of `>` lines (with their continuations); a
/// fenced code block with its fences; a table row (the header or delimiter row: the whole table); a
/// heading or a rule alone; a paragraph's run of lines (a run right under a list item or a quote is
/// that item's); a blank line alone.
fn item_lines(doc: &Doc, li: usize) -> (usize, usize) {
    let lines = &doc.lines;
    let l = &lines[li];
    match l.ty {
        BlockType::Code | BlockType::Fence => (l.block_start.unwrap_or(li), l.block_end.unwrap_or(li)),
        BlockType::TableHead | BlockType::TableDelim => l.table.as_ref().map_or((li, li), |t| (t.start, t.end)),
        BlockType::TableRow | BlockType::Heading | BlockType::Hr => (li, li),
        BlockType::Bullet | BlockType::Todo | BlockType::Numbered => {
            let mut end = li;
            while end + 1 < lines.len() && {
                let m = &lines[end + 1];
                is_nested(m.ty) && m.indent > l.indent || is_continuation(doc, m)
            } {
                end += 1;
            }
            (li, end)
        }
        BlockType::Quote => {
            let mut start = li;
            loop {
                let mut k = start;
                while k > 0 && is_continuation(doc, &lines[k - 1]) {
                    k -= 1;
                }
                if k > 0 && lines[k - 1].ty == BlockType::Quote {
                    start = k - 1;
                } else {
                    break;
                }
            }
            let mut end = li;
            while end + 1 < lines.len() && (lines[end + 1].ty == BlockType::Quote || is_continuation(doc, &lines[end + 1])) {
                end += 1;
            }
            (start, end)
        }
        BlockType::Paragraph if is_blank_line(doc, l) => (li, li),
        BlockType::Paragraph => {
            let mut start = li;
            while start > 0 && is_continuation(doc, &lines[start - 1]) {
                start -= 1;
            }
            if start > 0 && (is_item(lines[start - 1].ty) || lines[start - 1].ty == BlockType::Quote) {
                return item_lines(doc, start - 1);
            }
            let mut end = li;
            while end + 1 < lines.len() && is_continuation(doc, &lines[end + 1]) {
                end += 1;
            }
            (start, end)
        }
    }
}

/// The lines a selection touches (first, last); one ending at a line's start leaves that line out.
fn selected_lines(doc: &Doc, sel: Sel) -> (usize, usize) {
    let lines = &doc.lines;
    let first = line_at(lines, sel.from());
    let mut last = line_at(lines, sel.to());
    if !sel.is_empty() && last > first && sel.to() == lines[last].from {
        last -= 1;
    }
    (first, last)
}

/// The run of lines of every item lines `first..=last` are in (`item_lines`).
fn items_lines(doc: &Doc, first: usize, last: usize) -> (usize, usize) {
    (first..=last).map(|li| item_lines(doc, li)).fold((usize::MAX, 0), |(a, b), (x, y)| (a.min(x), b.max(y)))
}

/// A numbered item's digits (from, to).
fn number_digits(doc: &Doc, l: &Line) -> Option<(usize, usize)> {
    let tok = l.tokens.iter().find(|t| t.kind == TokenKind::Numbered)?;
    let lead = doc.text[tok.from..tok.to].bytes().take_while(|&c| c == b' ').count();
    let digits = doc.text[tok.from + lead..tok.to].bytes().take_while(u8::is_ascii_digit).count();
    Some((tok.from + lead, tok.from + lead + digits))
}

// -----------------------------------------------------------------------------------------------
// Move Item (Cmd-Option-Up / Down)

#[derive(Clone, Copy, PartialEq, Eq)]
enum MoveMode {
    /// List items (with their sub-items), or a quote nested in one: among siblings at their level.
    List,
    /// Table body rows: among the body rows.
    Row,
    /// Top-level blocks (`block_lines`).
    Block,
}

/// Cmd-Option-Up / Down (`dir` -1 / 1): swap the item at the caret, or the run of items the selection
/// touches (`item_lines`), with the previous / next sibling, as one undo step. A list item (with its
/// continuation lines and sub-items) swaps with its sibling at the same level in the same list, never
/// leaving it (blank lines of a loose list are crossed); numbered siblings that were numbered in sequence
/// keep it. A table body row swaps with the body row next to it (the header or delimiter row: the table
/// moves as a block). Anything else (paragraph, heading, quote, code block, table) swaps
/// with the top-level block next to it (a whole list is one); the blank lines between stay where they
/// are. The selection stays on the moved text. None: nothing to swap with (a blank line, the first or
/// last sibling), or a swap that would merge blocks.
pub fn move_item(doc: &Doc, sel: Sel, dir: i32) -> Option<Edit> {
    let lines = &doc.lines;
    let n = lines.len();
    let blank = |li: usize| is_blank_line(doc, &lines[li]);
    let (mut first, mut last) = selected_lines(doc, sel);
    while first < last && blank(first) {
        first += 1;
    }
    while last > first && blank(last) {
        last -= 1;
    }
    if blank(first) {
        return None;
    }
    let row = |li: usize| lines[li].ty == BlockType::TableRow;
    let table = |li: usize| lines[li].table.as_ref().map(|t| t.start);
    let (mode, a, b) = if (first..=last).all(|k| row(k) && table(k) == table(first)) {
        (MoveMode::Row, first, last)
    } else {
        let (a, b) = items_lines(doc, first, last);
        let level = lines[a].indent;
        let list = is_list_line(&lines[a])
            && (a..=b).all(|k| {
                let l = &lines[k];
                is_blank_line(doc, l) || is_continuation(doc, l) || (is_list_line(l) && l.indent >= level)
            });
        if list {
            (MoveMode::List, a, b)
        } else {
            let (a, b) = (first..=last).map(|li| block_lines(doc, li)).fold((usize::MAX, 0), |(a, b), (x, y)| (a.min(x), b.max(y)));
            (MoveMode::Block, a, b)
        }
    };
    let level = lines[a].indent;
    let same_list = |l: &Line| {
        is_list_line(l) && l.indent == level && (!is_item(l.ty) || !is_item(lines[a].ty) || (l.ty == BlockType::Numbered) == (lines[a].ty == BlockType::Numbered))
    };
    // the sibling (o0, o1) to swap with
    let (o0, o1) = if dir < 0 {
        if a == 0 {
            return None;
        }
        let mut q = a - 1;
        if mode != MoveMode::Row {
            while q > 0 && blank(q) {
                q -= 1;
            }
            if blank(q) {
                return None;
            }
        }
        match mode {
            MoveMode::Row => (row(q) && table(q) == table(a)).then_some((q, q))?,
            MoveMode::List => {
                let mut p = q;
                while p > 0 && !(is_list_line(&lines[p]) && lines[p].indent <= level) && (is_continuation(doc, &lines[p]) || is_list_line(&lines[p])) {
                    p -= 1;
                }
                (same_list(&lines[p]) && item_lines(doc, p).1 == q).then_some((p, q))?
            }
            MoveMode::Block => {
                let p = block_lines(doc, q);
                (p.1 == q).then_some(p)?
            }
        }
    } else {
        let mut q = b + 1;
        if mode != MoveMode::Row {
            while q < n && blank(q) {
                q += 1;
            }
        }
        if q >= n {
            return None;
        }
        match mode {
            MoveMode::Row => (row(q) && table(q) == table(a)).then_some((q, q))?,
            MoveMode::List => same_list(&lines[q]).then(|| item_lines(doc, q))?,
            MoveMode::Block => {
                let p = block_lines(doc, q);
                (p.0 == q).then_some(p)?
            }
        }
    };
    // numbered siblings in sequence stay in sequence
    let mut renum: Vec<(usize, u32)> = Vec::new();
    if mode == MoveMode::List {
        let ours: Vec<usize> = (a..=b).filter(|&k| is_item(lines[k].ty) && lines[k].indent == level).collect();
        let order: Vec<usize> = if dir < 0 { std::iter::once(o0).chain(ours.iter().copied()).collect() } else { ours.iter().copied().chain(std::iter::once(o0)).collect() };
        let start = lines[order[0]].number;
        if order.iter().enumerate().all(|(i, &k)| lines[k].ty == BlockType::Numbered && lines[k].number == start + i as u32) {
            let moved: Vec<usize> = if dir < 0 { ours.iter().copied().chain(std::iter::once(o0)).collect() } else { std::iter::once(o0).chain(ours.iter().copied()).collect() };
            for (i, &k) in moved.iter().enumerate() {
                if lines[k].number != start + i as u32 {
                    renum.push((k, start + i as u32));
                }
            }
        }
    }
    // the moved text, renumbered; `local` maps offsets in it
    let (u0, u1) = (lines[a].from, lines[b].to);
    let mut ours = String::new();
    let mut local: Vec<(usize, usize, usize)> = Vec::new();
    let mut at = u0;
    for &(k, num) in renum.iter().filter(|(k, _)| (a..=b).contains(k)) {
        let Some((d0, d1)) = number_digits(doc, &lines[k]) else { continue };
        ours.push_str(&doc.text[at..d0]);
        let s = num.to_string();
        local.push((d0 - u0, d1 - d0, s.len()));
        ours.push_str(&s);
        at = d1;
    }
    ours.push_str(&doc.text[at..u1]);
    // the sibling's own renumbering
    let theirs = renum.iter().find(|(k, _)| *k == o0).and_then(|&(k, num)| number_digits(doc, &lines[k]).map(|(d0, d1)| Change::new(d0, d1, num.to_string())));
    let their_len = lines[o1].to - lines[o0].from + theirs.as_ref().map_or(0, |c| c.insert.len()) - theirs.as_ref().map_or(0, |c| c.to - c.from);
    let sep_raw = if dir < 0 { &doc.text[lines[o1].to..u0] } else { &doc.text[u1..lines[o0].from] };
    let try_sep = |sep: &str| -> Option<Edit> {
        let mut changes = Vec::new();
        let new_from;
        let their_from;
        if dir < 0 {
            changes.push(Change::new(lines[o1].to, u1, ""));
            let ins = format!("{ours}{sep}");
            match theirs.clone() {
                // the sibling's number starts where the moved text goes: one change
                Some(c) if c.from == lines[o0].from => changes.push(Change::new(c.from, c.to, format!("{ins}{}", c.insert))),
                c => {
                    changes.extend(c);
                    changes.push(Change::new(lines[o0].from, lines[o0].from, ins));
                }
            }
            new_from = lines[o0].from;
            their_from = new_from + ours.len() + sep.len();
        } else {
            changes.push(Change::new(u0, lines[o0].from, ""));
            changes.extend(theirs.clone());
            changes.push(Change::new(lines[o1].to, lines[o1].to, format!("{sep}{ours}")));
            their_from = u0;
            new_from = u0 + their_len + sep.len();
        }
        let map = |p: usize| {
            let off = p.clamp(u0, u1 + 1) - u0;
            let shift: isize = local.iter().filter(|&&(at, old, _)| at + old <= off).map(|&(_, old, new)| new as isize - old as isize).sum();
            new_from + (off as isize + shift) as usize
        };
        let text = apply_changes(&doc.text, &changes);
        let len = text.len();
        let new_sel = Sel::new(map(sel.anchor).min(len), map(sel.head).min(len));
        if mode != MoveMode::Row {
            let new = parse_doc(&text);
            let ext = |li: usize| if mode == MoveMode::List { item_lines(&new, li) } else { block_lines(&new, li) };
            let whole = |from: usize, len: usize| {
                let (x, y) = (line_at(&new.lines, from), line_at(&new.lines, from + len));
                ext(x).0 == x && ext(y).1 == y
            };
            if !whole(new_from, ours.len()) || !whole(their_from, their_len) {
                return None;
            }
        }
        Some(edit(changes, new_sel, EditKind::Move))
    };
    try_sep(sep_raw).or_else(|| (mode == MoveMode::Block && sep_raw == "\n").then(|| try_sep("\n\n")).flatten())
}

/// The top-level block line `li` is in, as Move Item swaps them: a whole list (its items with their
/// continuations and what's nested in them), a whole table, else the item (`item_lines`).
fn block_lines(doc: &Doc, li: usize) -> (usize, usize) {
    let lines = &doc.lines;
    if let Some(t) = &lines[li].table {
        return (t.start, t.end);
    }
    let (mut a, mut b) = item_lines(doc, li);
    if !is_list_line(&lines[a]) {
        return (a, b);
    }
    loop {
        let mut k = a;
        while k > 0 && is_continuation(doc, &lines[k - 1]) {
            k -= 1;
        }
        if k > 0 && is_list_line(&lines[k - 1]) {
            a = k - 1;
        } else {
            break;
        }
    }
    while b + 1 < lines.len() && is_list_line(&lines[b + 1]) {
        b = item_lines(doc, b + 1).1;
    }
    (a, b)
}

/// A line of a list: an item, or a quote nested in one.
fn is_list_line(l: &Line) -> bool {
    is_item(l.ty) || (is_nested(l.ty) && l.indent > 0)
}

/// A bullet, todo or numbered item.
fn is_item(ty: BlockType) -> bool {
    matches!(ty, BlockType::Bullet | BlockType::Todo | BlockType::Numbered)
}

/// A line that, indented deeper than a list item, is part of it: a nested item or quote.
fn is_nested(ty: BlockType) -> bool {
    is_item(ty) || ty == BlockType::Quote
}

/// A non-blank paragraph line (one that continues the block above it).
fn is_continuation(doc: &Doc, l: &Line) -> bool {
    l.ty == BlockType::Paragraph && !is_blank_line(doc, l)
}

fn is_blank_line(doc: &Doc, l: &Line) -> bool {
    l.ty == BlockType::Paragraph && crate::text::is_blank(l.text(&doc.text))
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
    // inside an empty pair (`**|**`, `*|*`, `***|***`): toggle this style off; Cmd-I in `**|**`
    // nests (`***|***`) instead of taking one `*` off each side
    let mc = mk.as_bytes()[0];
    let before = t[..pos].bytes().rev().take_while(|&b| b == mc).count();
    let after = t[pos..].bytes().take_while(|&b| b == mc).count();
    if before == after && (before == l || (mc == b'*' && before == 3)) {
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
