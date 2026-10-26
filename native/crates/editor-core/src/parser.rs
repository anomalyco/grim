//! Markdown parser: a block pass (one entry per source line) and an inline pass per block.
//! All offsets are absolute byte offsets into the raw document. Pure functions.

use crate::text::{char_at, char_before, is_blank, is_letter, is_punct, is_tag_char, is_ws};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BlockType {
    Paragraph,
    Heading,
    Bullet,
    Todo,
    Numbered,
    Quote,
    Hr,
    Fence,
    Code,
    TableHead,
    TableDelim,
    TableRow,
}

impl BlockType {
    /// Bullet, todo, numbered or quote.
    pub fn is_list(self) -> bool {
        matches!(self, BlockType::Bullet | BlockType::Todo | BlockType::Numbered | BlockType::Quote)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellAlign {
    Left,
    Center,
    Right,
}

/// GFM table info of a table line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableLine {
    /// Line indices of the header row and of the last row.
    pub start: usize,
    pub end: usize,
    /// Column alignments (from the delimiter row).
    pub align: Vec<Option<CellAlign>>,
    /// Offsets of the cell-separating pipes.
    pub pipes: Vec<usize>,
    /// Cell content ranges between the pipes (including surrounding spaces).
    pub cells: Vec<(usize, usize)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TokenKind {
    Indent,
    Heading,
    Bullet,
    Todo,
    Numbered,
    Quote,
    Hr,
}

/// An atomic prefix token: one caret unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub from: usize,
    pub to: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum InlineType {
    Bold,
    Italic,
    Strike,
    Underline,
    Highlight,
    Code,
    Link,
    Tag,
    /// `![alt](src)` / `![alt](src "title")`: the whole source collapses (the image is drawn below
    /// the line); the alt text is plain text.
    Image,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineEl {
    pub ty: InlineType,
    pub from: usize,
    pub to: usize,
    pub content_from: usize,
    pub content_to: usize,
    /// Collapsible marker ranges (revealed together with the element).
    pub markers: Vec<(usize, usize)>,
    /// Link URL range: an atomic, always-visible chip.
    pub url: Option<(usize, usize)>,
    /// Images: the source range (inside the parentheses, without the title).
    pub src: Option<(usize, usize)>,
    /// Images: the title's text (escapes removed), if any.
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub index: usize,
    pub from: usize,
    /// End of the line, excluding the newline.
    pub to: usize,
    pub ty: BlockType,
    /// Number of leading indent tokens.
    pub indent: usize,
    /// Raw text of one indent level ("\t", or the document's space unit on space-indented lists).
    pub indent_unit: String,
    /// Heading level (1-6), 0 otherwise.
    pub level: u8,
    pub checked: bool,
    /// Number of a numbered item.
    pub number: u32,
    /// Prefix tokens, in order.
    pub tokens: Vec<Token>,
    /// Where the line's content starts (after all prefix tokens).
    pub text_from: usize,
    /// Code blocks: line index of the opening fence and of the closing fence (or last line if unclosed).
    pub block_start: Option<usize>,
    pub block_end: Option<usize>,
    pub inline: Vec<InlineEl>,
    /// Offsets of escape backslashes (always collapsed).
    pub escapes: Vec<usize>,
    pub table: Option<TableLine>,
}

impl Line {
    fn new(index: usize, from: usize, to: usize) -> Line {
        Line {
            index,
            from,
            to,
            ty: BlockType::Paragraph,
            indent: 0,
            indent_unit: "\t".into(),
            level: 0,
            checked: false,
            number: 0,
            tokens: Vec::new(),
            text_from: from,
            block_start: None,
            block_end: None,
            inline: Vec::new(),
            escapes: Vec::new(),
            table: None,
        }
    }

    /// The line's raw text.
    pub fn text<'a>(&self, doc_text: &'a str) -> &'a str {
        &doc_text[self.from..self.to]
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Doc {
    pub text: String,
    pub lines: Vec<Line>,
}

impl Doc {
    pub fn parse(text: String) -> Doc {
        let lines = parse_blocks(&text);
        Doc { text, lines }
    }

    /// The line containing `pos`.
    pub fn line_of(&self, pos: usize) -> &Line {
        &self.lines[line_at(&self.lines, pos)]
    }
}

pub fn parse_doc(text: &str) -> Doc {
    Doc::parse(text.to_string())
}

// --- block regexes, hand-written ---------------------------------------------------------------

/// `^(#{1,6}) ` -> level.
fn heading(s: &str) -> Option<usize> {
    let n = s.bytes().take_while(|&b| b == b'#').count();
    ((1..=6).contains(&n) && s.as_bytes().get(n) == Some(&b' ')).then_some(n)
}

/// `^(?:-{3,}|\*{3,}|_{3,})\s*$`
fn is_hr(s: &str) -> bool {
    let Some(&c) = s.as_bytes().first() else { return false };
    if !matches!(c, b'-' | b'*' | b'_') {
        return false;
    }
    let n = s.bytes().take_while(|&b| b == c).count();
    n >= 3 && is_blank(&s[n..])
}

/// `^([-*]) \[([ xX])\] ` -> checked.
fn todo(s: &str) -> Option<bool> {
    let b = s.as_bytes();
    if b.len() >= 6 && matches!(b[0], b'-' | b'*') && &b[1..3] == b" [" && matches!(b[3], b' ' | b'x' | b'X') && &b[4..6] == b"] " {
        Some(b[3] != b' ')
    } else {
        None
    }
}

/// `^([-*]) `
fn bullet(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && matches!(b[0], b'-' | b'*') && b[1] == b' '
}

/// `^(\d{1,9})\. ` -> (number, token length).
fn numbered(s: &str) -> Option<(u32, usize)> {
    let n = s.bytes().take_while(u8::is_ascii_digit).count();
    if (1..=9).contains(&n) && s.as_bytes().get(n) == Some(&b'.') && s.as_bytes().get(n + 1) == Some(&b' ') {
        Some((s[..n].parse().unwrap_or(0), n + 2))
    } else {
        None
    }
}

/// `^(?:[-*] |\d{1,9}\. |> )`
fn list_start(s: &str) -> bool {
    bullet(s) || numbered(s).is_some() || s.starts_with("> ")
}

/// `^ {0,3}(`{3,}|~{3,})(.*)$` -> (fence char, run length, info string).
fn fence_open(t: &str) -> Option<(u8, usize, &str)> {
    let sp = t.bytes().take_while(|&b| b == b' ').count();
    if sp > 3 {
        return None;
    }
    let c = *t.as_bytes().get(sp)?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let n = t[sp..].bytes().take_while(|&b| b == c).count();
    if n < 3 {
        return None;
    }
    let info = &t[sp + n..];
    // `.` doesn't match line terminators
    if info.contains(['\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((c, n, info))
}

/// `^ {0,3}(`{3,}|~{3,})\s*$` -> (fence char, run length).
fn fence_close(t: &str) -> Option<(u8, usize)> {
    let sp = t.bytes().take_while(|&b| b == b' ').count();
    if sp > 3 {
        return None;
    }
    let c = *t.as_bytes().get(sp)?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let n = t[sp..].bytes().take_while(|&b| b == c).count();
    (n >= 3 && is_blank(&t[sp + n..])).then_some((c, n))
}

pub fn parse_blocks(text: &str) -> Vec<Line> {
    parse_blocks_with_states(text).0
}

/// State of the block pass at the start of a line (what the lines above it decide for it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockState {
    /// Inside a code block: (fence char, run length, line index of the opening fence).
    fence: Option<(u8, usize, usize)>,
    /// Space-indented lists: 2 spaces per level, or 4 when the list steps by 4.
    space_unit: usize,
    prev_list_spaces: isize,
}

impl Default for BlockState {
    fn default() -> Self {
        BlockState { fence: None, space_unit: 2, prev_list_spaces: -1 }
    }
}

/// `parse_blocks`, with the block state at the start of every line (for `reparse`).
pub fn parse_blocks_with_states(text: &str) -> (Vec<Line>, Vec<BlockState>) {
    let mut lines: Vec<Line> = Vec::new();
    let mut states = Vec::new();
    let mut st = BlockState::default();
    let mut pos = 0;
    for (i, t) in text.split('\n').enumerate() {
        states.push(st);
        block_line(t, i, pos, &mut st, &mut lines, 0);
        pos += t.len() + 1;
    }
    finish_blocks(text, &mut lines, &st, 0);
    (lines, states)
}

/// Lines `start..old_end` of a parse were replaced by lines `start..new_end`; the lines after them
/// are the old ones moved (offsets and line indices shifted), the ones before are unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reparsed {
    pub start: usize,
    pub old_end: usize,
    pub new_end: usize,
}

/// Bring a parse up to date with an edit, re-parsing only the lines around it. `lines` and `states`
/// are `parse_blocks_with_states` of the old text; `text` is the new text, which differs from the old
/// one only in bytes `lo..hi` (new offsets; `lo..hi - delta` in the old text). Afterwards they equal
/// `parse_blocks_with_states(text)`.
pub fn reparse(lines: &mut Vec<Line>, states: &mut Vec<BlockState>, text: &str, lo: usize, hi: usize, delta: isize) -> Reparsed {
    reparse_until(lines, states, text, lo, hi, delta, usize::MAX).expect("no limit")
}

/// `reparse` for one of several edits: the text past byte `limit` (the next edit) isn't the old text
/// moved yet, so if the lines to re-parse would reach it, nothing changes and None is returned (the
/// caller then treats both edits as one).
pub fn reparse_until(
    lines: &mut Vec<Line>,
    states: &mut Vec<BlockState>,
    text: &str,
    lo: usize,
    hi: usize,
    delta: isize,
    limit: usize,
) -> Option<Reparsed> {
    // Start at the edited line, or earlier: never inside a code block, and not inside a run of
    // paragraph lines (tables and multi-line inline elements depend on the whole run).
    let mut s = line_at(lines, lo);
    loop {
        if let Some((_, _, f)) = states[s].fence {
            s = f;
        } else if s > 0 && paragraph_like(text, &lines[s - 1]) {
            s -= 1;
        } else {
            break;
        }
    }
    // Block pass from there until, past the edit, an old line comes back with the same block state
    // and isn't part of a paragraph run (so nothing after it depends on what came before).
    let mut st = states[s];
    let mut pos = lines[s].from;
    let mut win: Vec<Line> = Vec::new();
    let mut win_states = Vec::new();
    let mut old_end = lines.len();
    for (i, t) in (s..).zip(text[pos..].split('\n')) {
        if pos + t.len() >= limit {
            return None;
        }
        if i > s
            && pos > hi
            && st.fence.is_none()
            && let q = (pos as isize - delta) as usize
            && let j = line_at(lines, q)
            && lines[j].from == q
            && states[j] == st
            && (!paragraph_like_ty(lines[j].ty) || is_blank(t))
        {
            old_end = j;
            break;
        }
        win_states.push(st);
        block_line(t, i, pos, &mut st, &mut win, s);
        pos += t.len() + 1;
    }
    let tail = old_end == lines.len();
    if tail {
        finish_blocks(text, &mut win, &st, s);
    } else {
        detect_tables(text, &mut win, s);
        inline_pass(text, &mut win);
    }
    let new_end = s + win.len();
    let dl = new_end as isize - old_end as isize;
    if delta != 0 || dl != 0 {
        for l in &mut lines[old_end..] {
            shift_line(l, delta, dl);
        }
        for st in &mut states[old_end..] {
            if let Some(f) = &mut st.fence {
                f.2 = (f.2 as isize + dl) as usize;
            }
        }
    }
    lines.splice(s..old_end, win);
    states.splice(s..old_end, win_states);
    Some(Reparsed { start: s, old_end, new_end })
}

/// A line of a paragraph run as far as tables and paragraphs go: a non-blank paragraph or table line.
fn paragraph_like(text: &str, l: &Line) -> bool {
    paragraph_like_ty(l.ty) && !is_blank(l.text(text))
}

fn paragraph_like_ty(ty: BlockType) -> bool {
    matches!(ty, BlockType::Paragraph | BlockType::TableHead | BlockType::TableDelim | BlockType::TableRow)
}

/// Move a line by `d` bytes and `dl` lines.
fn shift_line(l: &mut Line, d: isize, dl: isize) {
    let m = |x: &mut usize| *x = (*x as isize + d) as usize;
    let ml = |x: &mut usize| *x = (*x as isize + dl) as usize;
    ml(&mut l.index);
    m(&mut l.from);
    m(&mut l.to);
    m(&mut l.text_from);
    for t in &mut l.tokens {
        m(&mut t.from);
        m(&mut t.to);
    }
    if let Some(x) = &mut l.block_start {
        ml(x);
    }
    if let Some(x) = &mut l.block_end {
        ml(x);
    }
    for e in &mut l.inline {
        m(&mut e.from);
        m(&mut e.to);
        m(&mut e.content_from);
        m(&mut e.content_to);
        for r in &mut e.markers {
            m(&mut r.0);
            m(&mut r.1);
        }
        if let Some(r) = &mut e.url {
            m(&mut r.0);
            m(&mut r.1);
        }
        if let Some(r) = &mut e.src {
            m(&mut r.0);
            m(&mut r.1);
        }
    }
    for e in &mut l.escapes {
        m(e);
    }
    if let Some(tb) = &mut l.table {
        ml(&mut tb.start);
        ml(&mut tb.end);
        for p in &mut tb.pipes {
            m(p);
        }
        for c in &mut tb.cells {
            m(&mut c.0);
            m(&mut c.1);
        }
    }
}

/// The block pass for one line (`t`, line `i` starting at byte `from`) appended to `lines`, which
/// holds lines `base..i` (a code block's lines get their `block_end` when it closes, so `base` is
/// never inside an open code block).
fn block_line(t: &str, i: usize, from: usize, st: &mut BlockState, lines: &mut Vec<Line>, base: usize) {
    let to = from + t.len();
    let mut line = Line::new(i, from, to);

    if let Some((fc, flen, fstart)) = st.fence {
        line.block_start = Some(fstart);
        if let Some((c, n)) = fence_close(t)
            && c == fc
            && n >= flen
        {
            line.ty = BlockType::Fence;
            lines.push(line);
            for l in &mut lines[fstart - base..] {
                l.block_end = Some(i);
            }
            st.fence = None;
        } else {
            line.ty = BlockType::Code;
            lines.push(line);
        }
        return;
    }
    if let Some((c, n, info)) = fence_open(t)
        && !(c == b'`' && info.contains('`'))
    {
        line.ty = BlockType::Fence;
        line.block_start = Some(i);
        st.fence = Some((c, n, i));
        lines.push(line);
        return;
    }

    let mut ind = 0;
    let ws_len = t.bytes().take_while(|&b| b == b' ' || b == b'\t').count();
    let ws = &t[..ws_len];
    let indent_tok = |f: usize, t: usize| Token { kind: TokenKind::Indent, from: f, to: t };
    if ws.contains(' ') && list_start(&t[ws_len..]) {
        // a list line indented with spaces (and maybe tabs): tabs and space units are indent
        // tokens; leftover spaces belong to the block token
        let spaces = ws.bytes().filter(|&b| b == b' ').count() as isize;
        if !ws.contains('\t') {
            if st.prev_list_spaces >= 0 && spaces > st.prev_list_spaces {
                let step = spaces - st.prev_list_spaces;
                if step % 4 == 0 && spaces % 4 == 0 {
                    st.space_unit = 4;
                } else if step == 2 {
                    st.space_unit = 2;
                }
            }
            st.prev_list_spaces = spaces;
        }
        line.indent_unit = " ".repeat(st.space_unit);
        let mut run = 0;
        for (k, b) in ws.bytes().enumerate() {
            if b == b'\t' {
                run = 0;
                line.tokens.push(indent_tok(from + k, from + k + 1));
                ind = k + 1;
            } else {
                run += 1;
                if run == st.space_unit {
                    run = 0;
                    line.tokens.push(indent_tok(from + k + 1 - st.space_unit, from + k + 1));
                    ind = k + 1;
                }
            }
        }
        line.indent = line.tokens.len();
    } else {
        while t.as_bytes().get(ind) == Some(&b'\t') {
            line.tokens.push(indent_tok(from + ind, from + ind + 1));
            ind += 1;
        }
        line.indent = ind;
        if list_start(&t[ind..]) {
            st.prev_list_spaces = 0;
        } else if !is_blank(t) {
            st.prev_list_spaces = -1;
        }
    }
    // block tokens come after the indent tokens; leftover spaces (list lines) are part of the token
    let lead = if ind < ws_len && line.indent_unit != "\t" { ws_len - ind } else { 0 };
    let rest = &t[ind + lead..];
    let mut tok_len = 0;
    let push = |line: &mut Line, kind: TokenKind, len: usize| {
        line.tokens.push(Token { kind, from: from + ind, to: from + ind + len });
    };
    if let Some(level) = heading(rest) {
        line.ty = BlockType::Heading;
        line.level = level as u8;
        tok_len = level + 1 + lead;
        push(&mut line, TokenKind::Heading, tok_len);
    } else if is_hr(rest) {
        line.ty = BlockType::Hr;
        tok_len = rest.len();
        line.tokens.push(Token { kind: TokenKind::Hr, from: from + ind, to });
    } else if let Some(checked) = todo(rest) {
        line.ty = BlockType::Todo;
        line.checked = checked;
        tok_len = 6 + lead;
        push(&mut line, TokenKind::Todo, tok_len);
    } else if bullet(rest) {
        line.ty = BlockType::Bullet;
        tok_len = 2 + lead;
        push(&mut line, TokenKind::Bullet, tok_len);
    } else if let Some((number, len)) = numbered(rest) {
        line.ty = BlockType::Numbered;
        line.number = number;
        tok_len = len + lead;
        push(&mut line, TokenKind::Numbered, tok_len);
    } else if rest.starts_with("> ") {
        line.ty = BlockType::Quote;
        tok_len = 2 + lead;
        push(&mut line, TokenKind::Quote, tok_len);
    }
    line.text_from = from + ind + tok_len;
    lines.push(line);
}

/// After the block pass over `lines` (lines `base..`, up to the end of the text): close an unclosed
/// code block, mark tables, run the inline pass.
fn finish_blocks(text: &str, lines: &mut [Line], st: &BlockState, base: usize) {
    if let Some((_, _, fstart)) = st.fence {
        let last = base + lines.len() - 1;
        for l in &mut lines[fstart - base..] {
            l.block_end = Some(last);
        }
    }
    detect_tables(text, lines, base);
    inline_pass(text, lines);
}

/// Inline pass per block. Consecutive non-blank paragraph lines form one paragraph, so inline
/// elements can span soft line breaks; each line lists the elements that touch it.
fn inline_pass(text: &str, lines: &mut [Line]) {
    let mut i = 0;
    while i < lines.len() {
        if let Some(tb) = &lines[i].table {
            // inline elements stay inside their cell
            if lines[i].ty != BlockType::TableDelim {
                let cells = tb.cells.clone();
                let b = text.as_bytes();
                for (cf, ct) in cells {
                    // images aren't drawn in table cells: `![a](b)` stays a "!" before a link
                    let (els, esc) = parse_inline_with(text, cf, ct, false);
                    let line = &mut lines[i];
                    line.escapes.extend(esc);
                    // "\|" inside a code span in a cell shows as "|" (GFM)
                    for el in &els {
                        if el.ty != InlineType::Code {
                            continue;
                        }
                        let mut p = el.content_from;
                        while p + 1 < el.content_to {
                            if b[p] == b'\\' && b[p + 1] == b'|' {
                                line.escapes.push(p);
                                p += 1;
                            }
                            p += 1;
                        }
                    }
                    line.inline.extend(els);
                }
            }
            i += 1;
            continue;
        }
        if matches!(lines[i].ty, BlockType::Code | BlockType::Fence | BlockType::Hr) {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        if is_paragraph_line(text, &lines[i]) {
            while j < lines.len() && is_paragraph_line(text, &lines[j]) {
                j += 1;
            }
        }
        let (els, esc) = parse_inline(text, lines[i].text_from, lines[j - 1].to);
        if j - i == 1 {
            lines[i].inline = els;
            lines[i].escapes = esc;
        } else {
            for l in &mut lines[i..j] {
                l.inline = els.iter().filter(|e| e.from < l.to && e.to > l.text_from).cloned().collect();
                l.escapes = esc.iter().copied().filter(|&e| e >= l.text_from && e < l.to).collect();
            }
        }
        i = j;
    }
}

/// The same line shown literally: its block prefix (except indentation) is plain text.
/// Used for the local "conversion undone" state.
pub fn literal_line(text: &str, line: &Line, from: BlockType) -> Line {
    if matches!(line.ty, BlockType::Paragraph | BlockType::Code | BlockType::Fence) {
        return line.clone();
    }
    let mut tokens: Vec<Token> = line.tokens.iter().copied().filter(|t| t.kind == TokenKind::Indent).collect();
    let mut ty = BlockType::Paragraph;
    if from == BlockType::Bullet && line.ty == BlockType::Todo {
        // a todo shown as the bullet it was converted from: "- " stays a token, "[ ] " is text
        let tok = line.tokens[line.tokens.len() - 1];
        tokens.push(Token { kind: TokenKind::Bullet, from: tok.from, to: tok.from + 2 });
        ty = BlockType::Bullet;
    }
    let text_from = tokens.last().map_or(line.from, |t| t.to);
    let (inline, escapes) = parse_inline(text, text_from, line.to);
    Line { ty, level: 0, checked: false, number: 0, tokens, text_from, inline, escapes, ..line.clone() }
}

/// Index of the line containing `pos` (a position at a line's end belongs to that line).
pub fn line_at(lines: &[Line], pos: usize) -> usize {
    let mut lo = 0;
    let mut hi = lines.len().saturating_sub(1);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if lines[mid].from <= pos {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

// -----------------------------------------------------------------------------------------------
// GFM tables

fn blank_byte(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r')
}

/// [from, to) without surrounding spaces, tabs and carriage returns.
pub fn trim_range(text: &str, mut from: usize, mut to: usize) -> (usize, usize) {
    let b = text.as_bytes();
    while from < to && blank_byte(b[from]) {
        from += 1;
    }
    while to > from && blank_byte(b[to - 1]) {
        to -= 1;
    }
    (from, to)
}

/// Split a table row into cells. Escaped pipes (\|) and pipes inside a code span don't split (the
/// latter deliberately deviates from GFM). Returns the separating pipes and the cell ranges.
pub fn split_row(text: &str, from: usize, to: usize) -> (Vec<usize>, Vec<(usize, usize)>) {
    let s = text.as_bytes();
    let mut bars = Vec::new();
    let mut i = from;
    while i < to {
        let c = s[i];
        if c == b'\\' {
            i += 1;
        } else if c == b'`' {
            let mut n = 1;
            while i + n < to && s[i + n] == b'`' {
                n += 1;
            }
            // find a closing run of exactly n backticks
            let mut j = i + n;
            let mut close = None;
            while j < to {
                if s[j] == b'`' {
                    let mut m = 1;
                    while j + m < to && s[j + m] == b'`' {
                        m += 1;
                    }
                    if m == n {
                        close = Some(j);
                        break;
                    }
                    j += m;
                } else {
                    j += 1;
                }
            }
            i = match close {
                Some(c) => c + n - 1,
                None => i + n - 1,
            };
        } else if c == b'|' {
            bars.push(i);
        }
        i += 1;
    }
    let (start, end) = trim_range(text, from, to);
    let mut cells = Vec::new();
    let lead = !bars.is_empty() && bars[0] == start;
    let trail = !bars.is_empty() && bars[bars.len() - 1] + 1 == end && !(lead && bars.len() == 1);
    let mut cur = if lead { bars[0] + 1 } else { from };
    let inner = &bars[if lead { 1 } else { 0 }..if trail { bars.len() - 1 } else { bars.len() }];
    for &b in inner {
        cells.push((cur, b));
        cur = b + 1;
    }
    cells.push((cur, if trail { bars[bars.len() - 1] } else { to }));
    (bars, cells)
}

/// `^\s*(:?)-+(:?)\s*$`
fn delim_cell(s: &str) -> Option<Option<CellAlign>> {
    let t = s.trim_matches(is_ws);
    let left = t.starts_with(':');
    let t = if left { &t[1..] } else { t };
    let right = t.ends_with(':');
    let t = if right { &t[..t.len() - 1] } else { t };
    if t.is_empty() || !t.bytes().all(|b| b == b'-') {
        return None;
    }
    Some(match (left, right) {
        (true, true) => Some(CellAlign::Center),
        (false, true) => Some(CellAlign::Right),
        (true, false) => Some(CellAlign::Left),
        _ => None,
    })
}

fn delim_align(text: &str, line: &Line) -> Option<Vec<Option<CellAlign>>> {
    if !line.text(text).contains('-') {
        return None;
    }
    let (pipes, cells) = split_row(text, line.from, line.to);
    if pipes.is_empty() && cells.len() == 1 {
        return None; // "---" alone is a rule, not a table
    }
    cells.iter().map(|&(f, t)| delim_cell(&text[f..t])).collect()
}

/// A non-blank paragraph line indented by at most 3 spaces.
fn table_candidate(text: &str, l: Option<&Line>) -> bool {
    let Some(l) = l else { return false };
    if l.ty != BlockType::Paragraph {
        return false;
    }
    let t = l.text(text).as_bytes();
    let sp = t.iter().take_while(|&&b| b == b' ').count().min(3);
    // `^ {0,3}[^ \t\r]`
    t.get(sp).is_some_and(|&b| !blank_byte(b))
}

/// Mark GFM tables: a header row, a delimiter row with the same column count, then body rows
/// (any following non-blank paragraph line, like GFM's lazy continuation).
/// `lines` are lines `base..` of the document (for the line indices in `TableLine`).
fn detect_tables(text: &str, lines: &mut [Line], base: usize) {
    let mut i = 0;
    while i + 1 < lines.len() {
        if !table_candidate(text, lines.get(i)) || !table_candidate(text, lines.get(i + 1)) {
            i += 1;
            continue;
        }
        let head_row = split_row(text, lines[i].from, lines[i].to);
        if head_row.0.is_empty() {
            i += 1;
            continue;
        }
        let Some(align) = delim_align(text, &lines[i + 1]) else {
            i += 1;
            continue;
        };
        if align.len() != head_row.1.len() {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        while end + 1 < lines.len() && table_candidate(text, lines.get(end + 1)) {
            end += 1;
        }
        for (k, l) in lines.iter_mut().enumerate().take(end + 1).skip(i) {
            let (pipes, cells) = if k == i { head_row.clone() } else { split_row(text, l.from, l.to) };
            l.ty = if k == i {
                BlockType::TableHead
            } else if k == i + 1 {
                BlockType::TableDelim
            } else {
                BlockType::TableRow
            };
            l.tokens.clear();
            l.text_from = l.from;
            l.table = Some(TableLine { start: base + i, end: base + end, align: align.clone(), pipes, cells });
        }
        i = end + 1;
    }
}

fn is_paragraph_line(text: &str, l: &Line) -> bool {
    l.ty == BlockType::Paragraph && !is_blank(l.text(text))
}

// -----------------------------------------------------------------------------------------------
// Inline pass

struct Delim {
    ch: u8,
    pos: usize,
    len: usize,
    orig_len: usize,
    can_open: bool,
    can_close: bool,
}

/// Inline elements (sorted by start, outer first) and escape backslash offsets of [start, end).
pub fn parse_inline(src: &str, start: usize, end: usize) -> (Vec<InlineEl>, Vec<usize>) {
    parse_inline_with(src, start, end, true)
}

/// `parse_inline`, with or without images (table cells have none).
pub fn parse_inline_with(src: &str, start: usize, end: usize, images: bool) -> (Vec<InlineEl>, Vec<usize>) {
    let mut elements = Vec::new();
    let mut escapes = Vec::new();
    scan(src, start, end, &mut elements, &mut escapes, images);
    elements.sort_by(|a, b| a.from.cmp(&b.from).then(b.to.cmp(&a.to)));
    (elements, escapes)
}

fn run_length(s: &[u8], i: usize, end: usize, ch: u8) -> usize {
    let mut j = i;
    while j < end && s[j] == ch {
        j += 1;
    }
    j - i
}

fn scan(src: &str, start: usize, end: usize, out: &mut Vec<InlineEl>, escapes: &mut Vec<usize>, images: bool) {
    let s = src.as_bytes();
    let mut stack: Vec<Delim> = Vec::new();
    let mut i = start;
    while i < end {
        let c = s[i];
        if c == b'\\' && i + 1 < end && s[i + 1].is_ascii_punctuation() {
            escapes.push(i);
            i += 2;
            continue;
        }
        if c == b'`' {
            let n = run_length(s, i, end, b'`');
            let mut j = i + n;
            let mut found = None;
            while j < end {
                if s[j] == b'`' {
                    let m = run_length(s, j, end, b'`');
                    if m == n {
                        found = Some(j);
                        break;
                    }
                    j += m;
                } else {
                    j += 1;
                }
            }
            match found {
                Some(f) if f > i + n => {
                    out.push(InlineEl {
                        ty: InlineType::Code,
                        from: i,
                        to: f + n,
                        content_from: i + n,
                        content_to: f,
                        markers: vec![(i, i + n), (f, f + n)],
                        url: None,
                        src: None,
                        title: None,
                    });
                    i = f + n;
                }
                _ => i += n,
            }
            continue;
        }
        if c == b'!' && images && s.get(i + 1) == Some(&b'[') {
            // an image: `![alt](src)` or `![alt](src "title")`, on one line. The whole source
            // collapses (the image is drawn below the line); the alt text is plain text, not
            // parsed for inline styles.
            if let Some(m) = match_link(src, i + 1, end, true)
                && !src[i..m.end].contains('\n')
            {
                let mut markers = vec![(i, i + 2)];
                if m.text_end > i + 2 {
                    markers.push((i + 2, m.text_end));
                }
                markers.push((m.text_end, m.end));
                out.push(InlineEl {
                    ty: InlineType::Image,
                    from: i,
                    to: m.end,
                    content_from: i + 2,
                    content_to: m.text_end,
                    markers,
                    url: None,
                    src: Some((m.text_end + 2, m.src_end)),
                    title: m.title,
                });
                i = m.end;
                continue;
            }
            i += 1;
            continue;
        }
        if c == b'[' {
            if let Some(LinkMatch { text_end, end: m_end, .. }) = match_link(src, i, end, false) {
                scan(src, i + 1, text_end, out, escapes, images);
                out.push(InlineEl {
                    ty: InlineType::Link,
                    from: i,
                    to: m_end,
                    content_from: i + 1,
                    content_to: text_end,
                    markers: vec![(i, i + 1), (text_end, text_end + 2), (m_end - 1, m_end)],
                    url: Some((text_end + 2, m_end - 1)),
                    src: None,
                    title: None,
                });
                i = m_end;
                continue;
            }
            i += 1;
            continue;
        }
        if c == b'#' && (i == start || char_before(src, i).is_some_and(is_ws)) {
            let mut j = i + 1;
            let mut letter = false;
            while j < end {
                let Some(ch) = char_at(src, j) else { break };
                if !is_tag_char(ch) {
                    break;
                }
                if is_letter(ch) {
                    letter = true;
                }
                j += ch.len_utf8();
            }
            // trailing "/" or "-" is not part of a tag
            while j > i + 1 && (s[j - 1] == b'/' || s[j - 1] == b'-') {
                j -= 1;
            }
            if letter && j > i + 1 {
                out.push(InlineEl {
                    ty: InlineType::Tag,
                    from: i,
                    to: j,
                    content_from: i,
                    content_to: j,
                    markers: vec![],
                    url: None,
                    src: None,
                    title: None,
                });
                i = j;
                continue;
            }
            i += 1;
            continue;
        }
        if matches!(c, b'*' | b'_' | b'~' | b'=') {
            let n = run_length(s, i, end, c);
            handle_delim(src, start, end, c, i, n, &mut stack, out);
            i += n;
            continue;
        }
        i += 1;
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_delim(s: &str, start: usize, end: usize, ch: u8, pos: usize, n: usize, stack: &mut Vec<Delim>, out: &mut Vec<InlineEl>) {
    if ch == b'=' && n != 2 {
        return;
    }
    if ch == b'~' && n > 2 {
        return;
    }
    // CommonMark flanking rules (the block's edges count as whitespace)
    let prev = if pos > start { char_before(s, pos).unwrap_or(' ') } else { ' ' };
    let next = if pos + n < end { char_at(s, pos + n).unwrap_or(' ') } else { ' ' };
    let left = !is_ws(next) && (!is_punct(next) || is_ws(prev) || is_punct(prev));
    let right = !is_ws(prev) && (!is_punct(prev) || is_ws(next) || is_punct(next));
    let mut can_open = left;
    let mut can_close = right;
    if ch == b'_' {
        can_open = left && (!right || is_punct(prev));
        can_close = right && (!left || is_punct(next));
    }
    let mut d = Delim { ch, pos, len: n, orig_len: n, can_open, can_close };
    let emph = ch == b'*' || ch == b'_';
    if can_close {
        while d.len > 0 {
            let mut k = stack.len() as isize - 1;
            while k >= 0 {
                let o = &stack[k as usize];
                if o.ch == ch {
                    if !emph {
                        if o.len == d.len {
                            break;
                        }
                    } else {
                        // "rule of 3": a run that can both open and close doesn't pair when the
                        // lengths sum to a multiple of 3
                        let both = o.can_close || d.can_open;
                        let sum = o.orig_len + d.orig_len;
                        if !(both && sum.is_multiple_of(3) && !(o.orig_len.is_multiple_of(3) && d.orig_len.is_multiple_of(3))) {
                            break;
                        }
                    }
                }
                k -= 1;
            }
            if k < 0 {
                break;
            }
            let k = k as usize;
            let o = &mut stack[k];
            let used = if emph { if o.len >= 2 && d.len >= 2 { 2 } else { 1 } } else { d.len };
            let ty = match ch {
                b'~' if used == 2 => InlineType::Strike,
                b'~' => InlineType::Underline,
                b'=' => InlineType::Highlight,
                _ if used == 2 => InlineType::Bold,
                _ => InlineType::Italic,
            };
            let o_from = o.pos + o.len - used;
            out.push(InlineEl {
                ty,
                from: o_from,
                to: d.pos + used,
                content_from: o.pos + o.len,
                content_to: d.pos,
                markers: vec![(o_from, o.pos + o.len), (d.pos, d.pos + used)],
                url: None,
                src: None,
                title: None,
            });
            o.len -= used;
            d.pos += used;
            d.len -= used;
            let keep = if o.len > 0 { k + 1 } else { k };
            stack.truncate(keep);
        }
    }
    if d.len > 0 && can_open {
        stack.push(d);
    }
}

struct LinkMatch {
    /// The `]` after the link text.
    text_end: usize,
    /// After the closing `)`.
    end: usize,
    /// After the URL / image source.
    src_end: usize,
    title: Option<String>,
}

/// `[text](url)` starting at `i`; with `title`, also `[text](url "title")`, `(url 'title')` and
/// `(url (title))` (images).
fn match_link(src: &str, i: usize, end: usize, title: bool) -> Option<LinkMatch> {
    let s = src.as_bytes();
    let mut depth = 0;
    let mut j = i + 1;
    while j < end {
        let c = s[j];
        if c == b'\\' {
            j += 2;
            continue;
        }
        if c == b'[' {
            depth += 1;
        } else if c == b']' {
            if depth == 0 {
                break;
            }
            depth -= 1;
        }
        j += 1;
    }
    if j >= end || s.get(j + 1) != Some(&b'(') {
        return None;
    }
    let text_end = j;
    let mut k = j + 2;
    if s.get(k) == Some(&b'<') {
        // `(<dest with spaces>)`: no line break or unescaped "<" inside (CommonMark); the
        // brackets stay in the range
        k += 1;
        while k < end && s[k] != b'>' {
            if s[k] == b'\n' || s[k] == b'<' {
                return None;
            }
            k += if s[k] == b'\\' { 2 } else { 1 };
        }
        if k >= end || k == j + 3 {
            return None;
        }
        k += 1;
    } else {
        let mut parens = 0;
        while k < end {
            let ch = char_at(src, k).unwrap_or(' ');
            if is_ws(ch) {
                break;
            }
            if ch == '(' {
                parens += 1;
            } else if ch == ')' {
                if parens == 0 {
                    break;
                }
                parens -= 1;
            }
            k += ch.len_utf8();
        }
    }
    if k == j + 2 {
        return None;
    }
    let src_end = k;
    if title && k < end && (s[k] == b' ' || s[k] == b'\t') {
        while k < end && (s[k] == b' ' || s[k] == b'\t') {
            k += 1;
        }
        let open = *s.get(k)?;
        let close = if open == b'(' { b')' } else { open };
        if !matches!(open, b'"' | b'\'' | b'(') {
            return None;
        }
        let t0 = k + 1;
        k = t0;
        while k < end && s[k] != close && s[k] != b'\n' {
            k += if s[k] == b'\\' { 2 } else { 1 };
        }
        if k >= end || s[k] != close {
            return None;
        }
        let mut t = String::new();
        let mut chars = src[t0..k].chars().peekable();
        while let Some(ch) = chars.next() {
            match chars.peek() {
                Some(&n) if ch == '\\' && n.is_ascii_punctuation() => {
                    t.push(n);
                    chars.next();
                }
                _ => t.push(ch),
            }
        }
        k += 1;
        while k < end && (s[k] == b' ' || s[k] == b'\t') {
            k += 1;
        }
        if k >= end || s[k] != b')' {
            return None;
        }
        return Some(LinkMatch { text_end, end: k + 1, src_end, title: Some(t) });
    }
    if k >= end || s[k] != b')' {
        return None;
    }
    Some(LinkMatch { text_end, end: k + 1, src_end, title: None })
}
