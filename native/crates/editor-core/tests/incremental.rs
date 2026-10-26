//! Incremental re-parsing: `parser::reparse` and the editor's line changes agree with full parses
//! over random documents and random edits.

use editor_core::parser::{Doc, Line, parse_blocks_with_states, reparse};
use editor_core::render::{LineView, line_view};
use editor_core::{Editor, Key, Mods, MonoLayout, Sel};

/// xorshift64*
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[self.below(xs.len())]
    }
}

const LINES: &[&str] = &[
    "",
    "plain text",
    "text with **bold",
    "and more** here",
    "*it* and `code` and [a](b)",
    "# Heading",
    "## Sub *x*",
    "- bullet",
    "  - spaced bullet",
    "    - deeper",
    "\t- tab bullet",
    "- [ ] todo",
    "1. one",
    "> quote",
    "```",
    "```js",
    "~~~",
    "code line",
    "| a | b |",
    "|---|:-:|",
    "| 1 | 2 |",
    "a | b",
    "--- | ---",
    "---",
    "![img](x.png)",
    "    indented",
    "😀 é text",
];

const SNIPPETS: &[&str] = &["x", "\n", "\n\n", "```", "\n```\n", "|", "| a |", "-", "---", "- ", "  ", "\t", "**", "*", "`", "# ", "> ", "1. ", "[", "](", ")", "😀", "|---|---|\n", "\n- a\n"];

fn random_doc(r: &mut Rng) -> String {
    let n = 1 + r.below(30);
    (0..n).map(|_| r.pick(LINES)).collect::<Vec<_>>().join("\n")
}

fn floor(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// A random edit: (from, to, insert) on char boundaries.
fn random_edit(r: &mut Rng, text: &str) -> (usize, usize, String) {
    let a = floor(text, r.below(text.len() + 1));
    let b = if r.below(2) == 0 { a } else { floor(text, (a + r.below(12)).min(text.len())) };
    let ins = if r.below(4) == 0 { String::new() } else { r.pick(SNIPPETS).to_string() };
    (a, b, ins)
}

#[test]
fn reparse_matches_full_parse() {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    for _ in 0..3000 {
        let mut text = random_doc(&mut r);
        let (mut lines, mut states) = parse_blocks_with_states(&text);
        for _ in 0..8 {
            let (a, b, ins) = random_edit(&mut r, &text);
            if a == b && ins.is_empty() {
                continue;
            }
            let before = text.clone();
            text.replace_range(a..b, &ins);
            let delta = ins.len() as isize - (b - a) as isize;
            let old = lines.clone();
            let rp = reparse(&mut lines, &mut states, &text, a, a + ins.len(), delta);
            let (want, want_states) = parse_blocks_with_states(&text);
            assert!(lines == want && states == want_states, "reparse differs: {before:?} -> {text:?} ({a}..{b} {ins:?})");
            // lines outside the window only moved
            let dl = rp.new_end as isize - rp.old_end as isize;
            for (i, l) in old.iter().enumerate() {
                if i < rp.start {
                    assert_eq!(l, &lines[i]);
                } else if i >= rp.old_end {
                    let n = &lines[(i as isize + dl) as usize];
                    assert_eq!(&before[l.from..l.to], &text[n.from..n.to]);
                    assert_eq!((l.ty, &l.tokens.len(), l.inline.len()), (n.ty, &n.tokens.len(), n.inline.len()));
                }
            }
        }
    }
}

/// A line's view (no reveal), with offsets relative to the line start and no line index.
fn rel(doc: &Doc, l: &Line) -> (LineView, String) {
    let mut v = line_view(doc, l, None);
    let f = v.from;
    v.index = 0;
    v.from -= f;
    v.to -= f;
    v.text_from -= f;
    for s in &mut v.segments {
        s.from -= f;
        s.to -= f;
    }
    for i in &mut v.images {
        i.from -= f;
        i.to -= f;
        i.alt_range = (i.alt_range.0 - f, i.alt_range.1 - f);
    }
    (v, doc.text[l.from..l.to].to_string())
}

#[test]
fn editor_line_changes_cover_every_changed_line() {
    let mut r = Rng(0x2545_f491_4f6c_dd1d);
    for _ in 0..300 {
        let mut e = Editor::new(&random_doc(&mut r));
        let mut views: Vec<_> = e.doc().lines.iter().map(|l| rel(e.doc(), l)).collect();
        e.take_line_changes();
        for _ in 0..30 {
            let len = e.text().len();
            match r.below(10) {
                0..=3 => e.insert_text(r.pick(SNIPPETS)),
                4 => {
                    let l = MonoLayout::new(&e);
                    e.key(Key::Enter, Mods::NONE, &l);
                }
                5 => {
                    let l = MonoLayout::new(&e);
                    e.key(Key::Backspace, Mods::NONE, &l);
                }
                6 => {
                    e.undo();
                }
                7 => {
                    e.redo();
                }
                8 => {
                    let (a, b) = (floor(e.text(), r.below(len + 1)), floor(e.text(), r.below(len + 1)));
                    e.apply_remote(&[(a.min(b)..a.max(b), r.pick(SNIPPETS).to_string())]);
                }
                _ => {
                    let p = floor(e.text(), r.below(len + 1));
                    e.set_selection(Sel::caret(p));
                }
            }
            let now: Vec<_> = e.doc().lines.iter().map(|l| rel(e.doc(), l)).collect();
            match e.take_line_changes() {
                None => assert_eq!(views, now, "lines changed without a report ({:?})", e.text()),
                Some(c) => {
                    assert_eq!(views.len() - c.old_end, now.len() - c.new_end);
                    assert_eq!(views[..c.start], now[..c.start], "{:?}", e.text());
                    assert_eq!(views[c.old_end..], now[c.new_end..], "{:?}", e.text());
                }
            }
            views = now;
        }
    }
}
