mod common;

use common::sl;
use editor_core::parser::{BlockType as B, CellAlign, InlineType as I, TokenKind, line_at, literal_line, parse_blocks, parse_doc, parse_inline, trim_range};
use editor_core::render::{SegKind, line_segments, line_view};
use editor_core::url::safe_url;

fn inl(s: &str) -> Vec<(I, String)> {
    parse_inline(s, 0, s.len()).0.iter().map(|e| (e.ty, s[e.from..e.to].to_string())).collect()
}

fn ty(s: &str) -> Vec<B> {
    parse_blocks(s).iter().map(|l| l.ty).collect()
}

fn e(t: I, s: &str) -> (I, String) {
    (t, s.to_string())
}

// --- block pass

#[test]
fn block_types_and_tokens() {
    let text = [
        "# Title", "### Third", "- bullet", "* star", "- [ ] todo", "- [x] done", "12. twelve", "> quote", "---", "plain",
        "\t- nested", "#tag not heading", "-not bullet", ">noquote",
    ]
    .join("\n");
    let lines = parse_blocks(&text);
    use B::*;
    assert_eq!(
        lines.iter().map(|l| l.ty).collect::<Vec<_>>(),
        vec![Heading, Heading, Bullet, Bullet, Todo, Todo, Numbered, Quote, Hr, Paragraph, Bullet, Paragraph, Paragraph, Paragraph]
    );
    assert_eq!(lines[0].level, 1);
    assert_eq!(lines[1].level, 3);
    assert!(!lines[4].checked);
    assert!(lines[5].checked);
    assert_eq!(lines[6].number, 12);
    assert_eq!(&text[lines[6].from..lines[6].text_from], "12. ");
    assert_eq!(lines[10].indent, 1);
    assert_eq!(lines[10].tokens.iter().map(|t| t.kind).collect::<Vec<_>>(), vec![TokenKind::Indent, TokenKind::Bullet]);
    assert_eq!(&text[lines[4].text_from..lines[4].to], "todo");
}

#[test]
fn space_indented_lists_2_spaces_per_level() {
    let text = "- a\n  - b\n    - c\n  1. n\n  > q\n  - [x] t\n  plain\n   - odd";
    let lines = parse_blocks(text);
    use B::*;
    assert_eq!(
        lines.iter().map(|l| (l.ty, l.indent)).collect::<Vec<_>>(),
        vec![(Bullet, 0), (Bullet, 1), (Bullet, 2), (Numbered, 1), (Quote, 1), (Todo, 1), (Paragraph, 0), (Bullet, 1)]
    );
    assert_eq!(lines[2].tokens.iter().map(|t| &text[t.from..t.to]).collect::<Vec<_>>(), vec!["  ", "  ", "- "]);
    assert_eq!(lines[1].indent_unit, "  ");
    // leftover space joins the bullet token
    assert_eq!(lines[7].tokens.iter().map(|t| &text[t.from..t.to]).collect::<Vec<_>>(), vec!["  ", " - "]);
    assert_eq!(&text[lines[5].text_from..lines[5].to], "t");
    // paragraphs keep leading spaces as text
    assert!(lines[6].tokens.is_empty());
}

#[test]
fn space_indented_lists_4_space_steps() {
    let text = "- a\n    - b\n        - c\n    - d";
    let lines = parse_blocks(text);
    assert_eq!(lines.iter().map(|l| l.indent).collect::<Vec<_>>(), vec![0, 1, 2, 1]);
    assert_eq!(lines[1].indent_unit, "    ");
    // without a previous list line: floor(spaces / 2)
    assert_eq!(parse_blocks("text\n    - deeper")[1].indent, 2);
    // code blocks keep spaces literal
    assert_eq!(parse_blocks("```\n  - x\n```")[1].ty, B::Code);
}

#[test]
fn gfm_tables() {
    let text = "| a | b |\n|:--|--:|\n| 1 | `x|y` |\n| \\| | **b** |\n\nafter";
    let lines = parse_blocks(text);
    use B::*;
    assert_eq!(lines.iter().map(|l| l.ty).collect::<Vec<_>>(), vec![TableHead, TableDelim, TableRow, TableRow, Paragraph, Paragraph]);
    let tb = lines[2].table.as_ref().unwrap();
    assert_eq!((tb.start, tb.end), (0, 3));
    assert_eq!(tb.align, vec![Some(CellAlign::Left), Some(CellAlign::Right)]);
    // a pipe in a code span doesn't split
    assert_eq!(tb.cells.iter().map(|&c| sl(text, c)).collect::<Vec<_>>(), vec![" 1 ", " `x|y` "]);
    assert_eq!(lines[2].inline.iter().map(|e| e.ty).collect::<Vec<_>>(), vec![I::Code]);
    // escaped pipe doesn't split either; inline parsing per cell
    let tb3 = lines[3].table.as_ref().unwrap();
    assert_eq!(tb3.cells.iter().map(|&c| sl(text, c)).collect::<Vec<_>>(), vec![" \\| ", " **b** "]);
    assert_eq!(lines[3].inline.iter().map(|e| e.ty).collect::<Vec<_>>(), vec![I::Bold]);
    assert_eq!(lines[3].escapes.len(), 1);
}

#[test]
fn gfm_tables_without_outer_pipes() {
    let text = "a | b\n:-: | ---\nc | d\nno pipes row\n\nx";
    let lines = parse_blocks(text);
    use B::*;
    assert_eq!(lines.iter().map(|l| l.ty).collect::<Vec<_>>(), vec![TableHead, TableDelim, TableRow, TableRow, Paragraph, Paragraph]);
    let tb = lines[0].table.as_ref().unwrap();
    assert_eq!(tb.align, vec![Some(CellAlign::Center), None]);
    assert_eq!(tb.cells.iter().map(|&c| sl(text, c)).collect::<Vec<_>>(), vec!["a ", " b"]);
    // rows end at another block
    assert_eq!(ty("| a |\n|---|\n| b |\n# h"), vec![TableHead, TableDelim, TableRow, Heading]);
}

#[test]
fn crlf_rows_leading_spaces_escaped_pipes_in_code() {
    let crlf = "| a | b |\r\n|---|:-:|\r\n| 1 | 2 |\r";
    let lines = parse_blocks(crlf);
    use B::*;
    assert_eq!(lines.iter().map(|l| l.ty).collect::<Vec<_>>(), vec![TableHead, TableDelim, TableRow]);
    let tb = lines[0].table.as_ref().unwrap();
    assert_eq!(tb.cells.iter().map(|&c| sl(crlf, c)).collect::<Vec<_>>(), vec![" a ", " b "]);
    assert_eq!(tb.align, vec![None, Some(CellAlign::Center)]);
    assert_eq!(trim_range("  a \r", 0, 5), (2, 3));
    // up to 3 leading spaces
    assert_eq!(ty("   | a |\n   |---|"), vec![TableHead, TableDelim]);
    assert_eq!(ty("    | a |\n|---|"), vec![Paragraph, Paragraph]);
    // "\|" inside a code span in a cell: the backslash is a (hidden) escape
    let t = "| `a\\|b` |\n|---|";
    let l0 = &parse_blocks(t)[0];
    assert_eq!(l0.table.as_ref().unwrap().cells.len(), 1);
    assert_eq!(l0.escapes, vec![t.find('\\').unwrap()]);
}

#[test]
fn not_tables() {
    use B::*;
    // column count mismatch between header and delimiter
    assert_eq!(ty("| a | b |\n|---|\n| c |"), vec![Paragraph, Paragraph, Paragraph]);
    // "---" alone is a rule
    assert_eq!(ty("a\n---"), vec![Paragraph, Hr]);
    // header without pipes
    assert_eq!(ty("a\n|---|"), vec![Paragraph, Paragraph]);
    // bad delimiter cell
    assert_eq!(ty("| a |\n| x |"), vec![Paragraph, Paragraph]);
    // inside a code fence
    assert_eq!(ty("```\n| a |\n|---|\n```"), vec![Fence, Code, Code, Fence]);
    // one-column table needs pipes in the delimiter row
    assert_eq!(ty("| a |\n|---|"), vec![TableHead, TableDelim]);
}

#[test]
fn fenced_code() {
    let lines = parse_blocks("a\n```js\nlet x = **1**\n- no\n```\nb");
    use B::*;
    assert_eq!(lines.iter().map(|l| l.ty).collect::<Vec<_>>(), vec![Paragraph, Fence, Code, Code, Fence, Paragraph]);
    assert!(lines[2].inline.is_empty());
    assert_eq!(lines[2].block_start, Some(1));
    assert_eq!(lines[2].block_end, Some(4));
    assert_eq!(lines[5].block_start, None);
}

#[test]
fn unclosed_fence_runs_to_the_end() {
    let lines = parse_blocks("```\ncode\nmore");
    assert_eq!(lines.iter().map(|l| l.ty).collect::<Vec<_>>(), vec![B::Fence, B::Code, B::Code]);
    assert_eq!(lines[0].block_end, Some(2));
}

#[test]
fn line_at_positions() {
    let d = parse_doc("ab\ncd\n");
    assert_eq!(line_at(&d.lines, 0), 0);
    assert_eq!(line_at(&d.lines, 2), 0);
    assert_eq!(line_at(&d.lines, 3), 1);
    assert_eq!(line_at(&d.lines, 6), 2);
}

// --- inline pass

#[test]
fn basic_emphasis() {
    assert_eq!(inl("**b**"), vec![e(I::Bold, "**b**")]);
    assert_eq!(inl("*i*"), vec![e(I::Italic, "*i*")]);
    assert_eq!(inl("_i_"), vec![e(I::Italic, "_i_")]);
    assert_eq!(inl("~~s~~"), vec![e(I::Strike, "~~s~~")]);
    assert_eq!(inl("~u~"), vec![e(I::Underline, "~u~")]);
    assert_eq!(inl("==h=="), vec![e(I::Highlight, "==h==")]);
    assert_eq!(inl("`c`"), vec![e(I::Code, "`c`")]);
}

#[test]
fn bear_partial_parse() {
    let s = "**abc*";
    let els = parse_inline(s, 0, s.len()).0;
    assert_eq!(els.len(), 1);
    assert_eq!(els[0].ty, I::Italic);
    assert_eq!(els[0].from, 1);
    assert_eq!(inl("**abc**"), vec![e(I::Bold, "**abc**")]);
    assert_eq!(inl("**abc"), vec![]);
}

#[test]
fn flanking_and_rule_of_3() {
    assert_eq!(inl("a*bold** b"), vec![]);
    assert_eq!(inl("a *bold** b"), vec![e(I::Italic, "*bold*")]);
    assert_eq!(inl("a **bold*W*Q b"), vec![e(I::Italic, "*W*")]);
    assert_eq!(inl("_ab_ c"), vec![e(I::Italic, "_ab_")]);
    assert_eq!(inl("__a_"), vec![e(I::Italic, "_a_")]);
    assert_eq!(inl("__a__"), vec![e(I::Bold, "__a__")]);
    assert_eq!(inl("__a__x"), vec![]);
    assert_eq!(inl("**bold**,"), vec![e(I::Bold, "**bold**")]);
}

#[test]
fn emphasis_spans_soft_line_breaks() {
    let d = parse_doc("a **bold \ntext** b\n\n**x\ny**");
    assert_eq!(d.lines[0].inline.iter().map(|e| e.ty).collect::<Vec<_>>(), vec![I::Bold]);
    assert_eq!(d.lines[1].inline, d.lines[0].inline);
    assert!(d.lines[2].inline.is_empty());
    assert_eq!(d.lines[3].inline.len(), 1);
    // list items don't join
    assert!(parse_doc("- **a\n- b**").lines[0].inline.is_empty());
}

#[test]
fn bold_italic_and_nesting() {
    let mut kinds: Vec<_> = inl("***x***").into_iter().map(|e| format!("{:?}", e.0)).collect();
    kinds.sort();
    assert_eq!(kinds, vec!["Bold", "Italic"]);
    let s = "**bold *nested* inside**";
    assert_eq!(inl(s), vec![e(I::Bold, s), e(I::Italic, "*nested*")]);
}

#[test]
fn no_emphasis_across_whitespace() {
    assert_eq!(inl("a * b * c"), vec![]);
    assert_eq!(inl("snake_case_name"), vec![]);
}

#[test]
fn code_span_hides_markers_inside() {
    assert_eq!(inl("`**x**` y"), vec![e(I::Code, "`**x**`")]);
}

#[test]
fn links() {
    let s = "see [the *site*](http://x.y) now";
    let els = parse_inline(s, 0, s.len()).0;
    let link = els.iter().find(|e| e.ty == I::Link).unwrap();
    assert_eq!(&s[link.from..link.to], "[the *site*](http://x.y)");
    assert_eq!(sl(s, link.url.unwrap()), "http://x.y");
    assert_eq!(link.markers.iter().map(|&m| sl(s, m)).collect::<Vec<_>>(), vec!["[", "](", ")"]);
    assert!(els.iter().any(|e| e.ty == I::Italic));
    assert_eq!(inl("[a](http://x.y"), vec![]);
}

#[test]
fn balanced_parens_in_urls() {
    let s = "[w](https://en.wikipedia.org/wiki/A_(b)) x";
    let els = parse_inline(s, 0, s.len()).0;
    let link = els.iter().find(|e| e.ty == I::Link).unwrap();
    assert_eq!(sl(s, link.url.unwrap()), "https://en.wikipedia.org/wiki/A_(b)");
}

#[test]
fn tags() {
    assert_eq!(inl("#tag and #two/sub x#no #1"), vec![e(I::Tag, "#tag"), e(I::Tag, "#two/sub")]);
}

#[test]
fn escapes() {
    let s = "\\*x\\*";
    let (els, esc) = parse_inline(s, 0, s.len());
    assert!(els.is_empty());
    assert_eq!(esc, vec![0, 3]);
}

#[test]
fn non_ascii_text() {
    // byte offsets: "é" is 2 bytes
    assert_eq!(inl("é **gras** ü"), vec![e(I::Bold, "**gras**")]);
    assert_eq!(inl("#café x"), vec![e(I::Tag, "#café")]);
    // punctuation flanking with a non-ASCII punctuation char
    assert_eq!(inl("«*x*»"), vec![e(I::Italic, "*x*")]);
    let d = parse_doc("- [ ] tâche\n## Überschrift");
    assert_eq!(&d.text[d.lines[0].text_from..d.lines[0].to], "tâche");
    assert_eq!(d.lines[1].level, 2);
}

// --- segments

#[test]
fn segments_markers_text_tokens() {
    let d = parse_doc("- a **b** [l](u)");
    let segs = line_segments(&d.lines[0], &d.text);
    use SegKind::*;
    assert_eq!(
        segs.iter().map(|s| (s.kind, &d.text[s.from..s.to])).collect::<Vec<_>>(),
        vec![(Token, "- "), (Text, "a "), (Marker, "**"), (Text, "b"), (Marker, "**"), (Text, " "), (Marker, "["), (Text, "l"), (Marker, "]("), (Chip, "u"), (Marker, ")")]
    );
    assert_eq!(segs[3].styles, vec![I::Bold]);
}

#[test]
fn literal_line_todo_converted_from_bullet() {
    let d = parse_doc("\t- [ ] task");
    let l = literal_line(&d.text, &d.lines[0], B::Bullet);
    assert_eq!(l.ty, B::Bullet);
    assert_eq!(
        l.tokens.iter().map(|t| (t.kind, &d.text[t.from..t.to])).collect::<Vec<_>>(),
        vec![(TokenKind::Indent, "\t"), (TokenKind::Bullet, "- ")]
    );
    assert_eq!(&d.text[l.text_from..l.to], "[ ] task");
}

#[test]
fn line_view_changes_when_paragraph_spanning_element_appears() {
    // TS: lineKey test (render cache key); here: the line view differs
    let a = parse_doc("**hello\nworld");
    let b = parse_doc("**hello\nworld**");
    assert_ne!(line_view(&a, &a.lines[0], None), line_view(&b, &b.lines[0], None));
    let a = parse_doc("| a | b |\n|---|");
    let b = parse_doc("| a | b |\n|---|---|");
    assert_ne!(line_view(&a, &a.lines[0], None), line_view(&b, &b.lines[0], None));
}

#[test]
fn table_rendering_plan() {
    let d = parse_doc("| a | **b** |\n|:-|-:|");
    use SegKind::*;
    let segs: Vec<_> = line_segments(&d.lines[0], &d.text).iter().map(|s| (s.kind, d.text[s.from..s.to].to_string(), s.cell)).collect();
    let want: Vec<(SegKind, &str, usize)> = vec![
        (Pipe, "|", 0), (Pad, " ", 0), (Text, "a", 0), (Pad, " ", 0), (Pipe, "|", 1), (Pad, " ", 1), (Marker, "**", 1),
        (Text, "b", 1), (Marker, "**", 1), (Pad, " ", 1), (Pipe, "|", 1),
    ];
    assert_eq!(segs, want.iter().map(|&(k, s, c)| (k, s.to_string(), Some(c))).collect::<Vec<_>>());
    let segs: Vec<_> = line_segments(&d.lines[1], &d.text).iter().map(|s| (s.kind, d.text[s.from..s.to].to_string(), s.cell)).collect();
    let want: Vec<(SegKind, &str, usize)> = vec![(Pipe, "|", 0), (Delim, ":-", 0), (Pipe, "|", 1), (Delim, "-:", 1), (Pipe, "|", 1)];
    assert_eq!(segs, want.iter().map(|&(k, s, c)| (k, s.to_string(), Some(c))).collect::<Vec<_>>());
}

#[test]
fn literal_line_converted_line() {
    let d = parse_doc("\t- **a**");
    let l = literal_line(&d.text, &d.lines[0], B::Paragraph);
    assert_eq!(l.ty, B::Paragraph);
    assert_eq!(l.tokens.iter().map(|t| t.kind).collect::<Vec<_>>(), vec![TokenKind::Indent]);
    assert_eq!(l.text_from, 1);
    assert_eq!(l.inline.iter().map(|e| e.ty).collect::<Vec<_>>(), vec![I::Bold]);
}

#[test]
fn safe_url_only_http_and_mailto() {
    assert_eq!(safe_url("https://x.y/a").as_deref(), Some("https://x.y/a"));
    assert_eq!(safe_url("example.com").as_deref(), Some("https://example.com/"));
    assert_eq!(safe_url("mailto:a@b.c").as_deref(), Some("mailto:a@b.c"));
    assert_eq!(safe_url("javascript:alert(1)"), None);
    assert_eq!(safe_url("data:text/html,x"), None);
}
