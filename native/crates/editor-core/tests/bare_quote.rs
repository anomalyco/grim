//! A `>` alone on a line inside a quote (CommonMark's blank quote line, as agents write it): an
//! empty quote line with its marker hidden, like `> `, however the text arrived.

use editor_core::parser::{BlockType as B, TokenKind, parse_blocks};
use editor_core::{Editor, Key, Mods, MonoLayout, SegKind};

const AGENT: &str = "> First paragraph of the quote.\n>\n> Second paragraph.";

fn typ(e: &mut Editor, s: &str) {
    for c in s.chars() {
        if c == '\n' {
            let l = MonoLayout::new(e);
            e.key(Key::Enter, Mods::NONE, &l);
        } else {
            e.insert_text(&c.to_string());
        }
    }
}

/// Per line: its type and the text it shows (visible text segments, without trailing whitespace).
fn shown(e: &Editor) -> Vec<(B, String)> {
    let text = e.text();
    e.render_lines()
        .iter()
        .map(|l| {
            let s: String =
                l.segments.iter().filter(|s| s.kind == SegKind::Text && !s.hidden).map(|s| &text[s.from..s.to]).collect();
            (l.kind, s.trim_end_matches(['\r', ' ', '\t']).to_string())
        })
        .collect()
}

fn quotes(lines: &[&str]) -> Vec<(B, String)> {
    lines.iter().map(|s| (B::Quote, s.to_string())).collect()
}

fn want() -> Vec<(B, String)> {
    quotes(&["First paragraph of the quote.", "", "Second paragraph."])
}

#[test]
fn bare_gt_between_quote_paragraphs_when_loaded() {
    let e = Editor::new(AGENT);
    assert_eq!(shown(&e), want());
    let l = &e.doc().lines[1];
    assert_eq!(l.tokens.iter().map(|t| (t.kind, t.from, t.to)).collect::<Vec<_>>(), vec![(TokenKind::Quote, 32, 33)]);
    assert_eq!(l.text_from, 33);
    let mut e = Editor::new("x");
    e.set_text(AGENT);
    assert_eq!(shown(&e), want());
}

#[test]
fn bare_gt_between_quote_paragraphs_when_remote() {
    // the whole quote inserted at once (an agent's write arriving over sync)
    let mut e = Editor::new("Intro\n\nOutro");
    e.apply_remote(&[(7..7, format!("{AGENT}\n\n"))]);
    assert_eq!(e.text(), format!("Intro\n\n{AGENT}\n\nOutro"));
    let s = shown(&e);
    assert_eq!(s[2..5].to_vec(), want());
    assert_eq!(s[6], (B::Paragraph, "Outro".into()));
    // line by line, the bare line arriving before and after the line it continues
    let mut e = Editor::new("");
    e.apply_remote(&[(0..0, "> First paragraph of the quote.\n".into())]);
    e.apply_remote(&[(32..32, ">\n".into())]);
    e.apply_remote(&[(34..34, "> Second paragraph.".into())]);
    assert_eq!(e.text(), AGENT);
    assert_eq!(shown(&e), want());
    let mut e = Editor::new(">\n> Second paragraph.");
    e.apply_remote(&[(0..0, "> First paragraph of the quote.\n".into())]);
    assert_eq!(shown(&e), want());
    // the quote line above removed: the bare `>` is text again
    e.apply_remote(&[(0..32, "".into())]);
    assert_eq!(shown(&e)[0], (B::Paragraph, ">".into()));
    // and the incremental parse matches a full one throughout
    assert_eq!(e.doc().lines.iter().map(|l| l.ty).collect::<Vec<_>>(), parse_blocks(e.text()).iter().map(|l| l.ty).collect::<Vec<_>>());
}

#[test]
fn bare_gt_typed() {
    let mut e = Editor::new("");
    typ(&mut e, "> First paragraph of the quote.\n");
    // Enter goes on with "> "; typing ">" on it adds text, so remove the auto space to type a bare `>`
    assert_eq!(e.text(), "> First paragraph of the quote.\n> ");
    let l = MonoLayout::new(&e);
    e.key(Key::Backspace, Mods::NONE, &l);
    let t = e.text().to_string();
    if !t.ends_with("\n>") {
        // Backspace removed the whole marker: type the bare `>` back without the typing rules
        e.apply_remote(&[(t.len()..t.len(), if t.ends_with('\n') { ">" } else { "\n>" }.into())]);
    }
    assert!(e.text().ends_with(".\n>"), "{:?}", e.text());
    let n = e.text().len();
    e.set_selection(editor_core::Sel::caret(n));
    typ(&mut e, "\n> Second paragraph.");
    let s = shown(&e);
    assert_eq!(s.first(), Some(&(B::Quote, "First paragraph of the quote.".into())));
    assert_eq!(s.last(), Some(&(B::Quote, "Second paragraph.".into())));
    assert!(s.iter().all(|(t, x)| *t == B::Quote && !x.contains('>')), "{s:?}");
}

#[test]
fn bare_gt_with_crlf() {
    let text = AGENT.replace('\n', "\r\n");
    assert_eq!(shown(&Editor::new(&text)), want());
    let mut e = Editor::new("");
    e.apply_remote(&[(0..0, text.clone())]);
    assert_eq!(shown(&e), want());
    // trailing spaces or tabs after the bare marker too
    assert_eq!(shown(&Editor::new("> a\n>  \t\n> b")), quotes(&["a", "", "b"]));
}

#[test]
fn bare_gt_in_nested_quotes() {
    // nested quotes show their inner `>` as text (no nesting); the bare outer `>` is an empty line
    let e = Editor::new("> outer\n> > inner\n> >\n>\n> outer again");
    assert_eq!(shown(&e), quotes(&["outer", "> inner", ">", "", "outer again"]));
}

#[test]
fn bare_gt_in_a_list() {
    for text in ["- item\n\t> quoted\n\t>\n\t> more", "- item\n  > quoted\n  >\n  > more"] {
        let lines = parse_blocks(text);
        assert_eq!(lines.iter().map(|l| (l.ty, l.indent)).collect::<Vec<_>>(), vec![(B::Bullet, 0), (B::Quote, 1), (B::Quote, 1), (B::Quote, 1)], "{text:?}");
        assert_eq!(shown(&Editor::new(text))[1..].to_vec(), quotes(&["quoted", "", "more"]), "{text:?}");
    }
    // a bare `>` at another indentation doesn't continue the quote
    assert_eq!(parse_blocks("\t> quoted\n>").iter().map(|l| l.ty).collect::<Vec<_>>(), vec![B::Quote, B::Paragraph]);
}

#[test]
fn bare_gt_alone_stays_text() {
    // not after a quote line: still a literal `>` (what undoing a typed quote's auto space leaves)
    for text in [">", "x\n>", ">\n> a", "> a\n\n>"] {
        let lines = parse_blocks(text);
        let bare = lines.iter().find(|l| &text[l.from..l.to] == ">").unwrap();
        assert_eq!(bare.ty, B::Paragraph, "{text:?}");
    }
    let mut e = Editor::new("x\n");
    e.set_selection(editor_core::Sel::caret(2));
    typ(&mut e, ">");
    e.undo();
    assert_eq!(e.text(), "x\n>");
    assert_eq!(shown(&e)[1], (B::Paragraph, ">".into()));
}


#[test]
fn bare_gt_line_edits_like_an_empty_quote_line() {
    // Enter and Backspace on a bare `>` line do what they do on an empty `> ` line
    for key in [Key::Enter, Key::Backspace] {
        let run = |text: &str| {
            let mut e = Editor::new(text);
            e.set_selection(editor_core::Sel::caret(text.len()));
            let l = MonoLayout::new(&e);
            e.key(key, Mods::NONE, &l);
            (e.text().to_string(), e.doc().lines.iter().map(|l| l.ty).collect::<Vec<_>>())
        };
        let (bare, spaced) = (run("> a\n>"), run("> a\n> "));
        assert_eq!(bare.1, spaced.1, "{key:?}: {bare:?} vs {spaced:?}");
        assert_eq!(bare.0.trim_end(), spaced.0.trim_end(), "{key:?}");
    }
}
