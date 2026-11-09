//! Pasting a full URL makes a link (`rules::paste`); bare URLs (GFM autolink literals) and `<…>` autolinks parse
//! as `InlineType::Autolink`.

use editor_core::parser::{InlineType, parse_doc};
use editor_core::url::autolink_href;
use editor_core::{Editor, Sel};

/// An editor on `marked` with the selection at `[[…]]` or the caret at `|`.
fn ed(marked: &str) -> Editor {
    let (text, sel) = if let Some(a) = marked.find("[[") {
        let b = marked.find("]]").unwrap() - 2;
        (marked.replacen("[[", "", 1).replacen("]]", "", 1), Sel::new(a, b))
    } else {
        let a = marked.find('|').unwrap();
        (marked.replacen('|', "", 1), Sel::caret(a))
    };
    let mut e = Editor::new(&text);
    e.set_selection(sel);
    e
}

/// The text with `|` at the caret.
fn shown(e: &Editor) -> String {
    let mut t = e.text().to_string();
    t.insert(e.selection().head, '|');
    t
}

fn paste(marked: &str, s: &str) -> String {
    let mut e = ed(marked);
    e.paste(s);
    shown(&e)
}

/// The autolinks of `text` as (content, href).
fn autolinks(text: &str) -> Vec<(String, String)> {
    let d = parse_doc(text);
    let mut out: Vec<(String, String)> = Vec::new();
    for l in &d.lines {
        for e in l.inline.iter().filter(|e| e.ty == InlineType::Autolink) {
            let raw = text[e.content_from..e.content_to].to_string();
            let href = autolink_href(&raw);
            if !out.iter().any(|(r, _)| *r == raw) {
                out.push((raw, href));
            }
        }
    }
    out
}

fn bare(text: &str) -> Vec<String> {
    autolinks(text).into_iter().map(|(r, _)| r).collect()
}

#[test]
fn a_url_over_a_selection_links_the_selection() {
    assert_eq!(paste("see [[the docs]] now", "https://e.com/a"), "see [the docs](https://e.com/a)| now");
    // spaces selected around the words stay outside the brackets
    assert_eq!(paste("see[[ the docs ]]now", "https://e.com/a"), "see [the docs](https://e.com/a) |now");
    // a destination with an unbalanced parenthesis goes in angle brackets; balanced ones don't need them
    assert_eq!(paste("[[x]]", "https://e.com/a)"), "[x](<https://e.com/a)>)|");
    assert_eq!(paste("[[x]]", "https://en.wikipedia.org/wiki/A_(b)"), "[x](https://en.wikipedia.org/wiki/A_(b))|");
    assert_eq!(paste("[[mail me]]", "mailto:a@b.co"), "[mail me](mailto:a@b.co)|");
    // in a list item and a heading
    assert_eq!(paste("- [[item]]", "http://e.com"), "- [item](http://e.com)|");
    assert_eq!(paste("# [[Title]]", "http://e.com"), "# [Title](http://e.com)|");
    let d = parse_doc("see [the docs](https://e.com/a) now");
    assert!(d.lines[0].inline.iter().any(|e| e.ty == InlineType::Link));
}

#[test]
fn a_url_without_a_selection_goes_in_bare_and_reads_as_a_link() {
    assert_eq!(paste("see | now", "https://e.com/a?b=1#c"), "see https://e.com/a?b=1#c| now");
    assert_eq!(bare("see https://e.com/a?b=1#c now"), ["https://e.com/a?b=1#c"]);
    assert_eq!(paste("|", "http://localhost:3000/x"), "http://localhost:3000/x|");
    // where a bare URL wouldn't read as one, in angle brackets: after a letter or ":" ...
    assert_eq!(paste("see:|", "https://e.com"), "see:<https://e.com>|");
    assert_eq!(paste("ab|cd", "https://e.com"), "ab<https://e.com>|cd");
    // ... ending in punctuation an autolink literal leaves out ...
    assert_eq!(paste("x |", "https://e.com/a."), "x <https://e.com/a.>|");
    // ... or with text right after that would run into it
    assert_eq!(paste("(|)", "https://e.com/a"), "(https://e.com/a|)");
    assert_eq!(bare("(https://e.com/a)"), ["https://e.com/a"]);
    // mailto: as an angle autolink (bare mailto: isn't one)
    assert_eq!(paste("write |", "mailto:a@b.co"), "write <mailto:a@b.co>|");
    assert_eq!(autolinks("write <mailto:a@b.co>"), [("mailto:a@b.co".to_string(), "mailto:a@b.co".to_string())]);
    // a selection over several lines is replaced, as a plain paste would
    assert_eq!(paste("a [[b\nc]] d", "https://e.com"), "a https://e.com| d");
}

#[test]
fn surrounding_whitespace_is_trimmed() {
    assert_eq!(paste("see |", "  https://e.com/a\n"), "see https://e.com/a|");
    assert_eq!(paste("[[docs]]", "\thttps://e.com/a \r\n"), "[docs](https://e.com/a)|");
    // already trimmed and bare: nothing more to do (one step)
    let mut e = ed("see |");
    e.paste("https://e.com");
    e.undo();
    assert_eq!(shown(&e), "see |");
}

#[test]
fn in_code_and_links_it_pastes_as_plain_text() {
    assert_eq!(paste("`a|b`", "https://e.com"), "`ahttps://e.com|b`");
    assert_eq!(paste("`[[ab]]`", "https://e.com"), "`https://e.com|`");
    assert_eq!(paste("```\nx [[y]]\n```", "https://e.com"), "```\nx https://e.com|\n```");
    // inside a link's URL (an empty one too) or text, an autolink
    // (the link it completes is collapsed: the caret snaps past it)
    assert_eq!(paste("[a](|)", "https://e.com"), "[a](https://e.com)|");
    assert_eq!(paste("[a](|", "https://e.com"), "[a](https://e.com|");
    // an expanded link's URL (its pencil)
    let mut e = Editor::new("[a](https://old)");
    e.expand_link(0);
    e.set_selection(Sel::caret(15));
    e.paste("https://e.com");
    assert_eq!(shown(&e), "[a](https://oldhttps://e.com|)");
    assert_eq!(paste("[a [[b]] c](https://x.com)", "https://e.com"), "[a https://e.com| c](https://x.com)");
    assert_eq!(paste("<https://a|.com>", "https://e.com"), "<https://ahttps://e.com|.com>");
}

#[test]
fn anything_else_pastes_as_plain_text() {
    for s in ["e.com", "www.e.com", "see https://e.com", "https://e.com and more", "https://", "ftp://e.com", "mailto:nobody", "https://e.com\nhttps://f.com"] {
        assert_eq!(paste("x |", s), format!("x {s}|"), "{s:?}");
        assert_eq!(paste("x [[sel]]", s), format!("x {s}|"), "{s:?}");
    }
    // a selection with brackets in it: replaced as usual
    assert_eq!(paste("[[a [b] c]]", "https://e.com"), "https://e.com|");
}

#[test]
fn one_undo_gives_the_plain_paste_back() {
    let mut e = ed("see [[the docs]] now");
    e.paste("https://e.com/a");
    assert_eq!(shown(&e), "see [the docs](https://e.com/a)| now");
    e.undo();
    assert_eq!(shown(&e), "see https://e.com/a| now");
    e.undo();
    assert_eq!(e.text(), "see the docs now");
    assert_eq!(e.selection(), Sel::new(4, 12));
    e.redo();
    e.redo();
    assert_eq!(shown(&e), "see [the docs](https://e.com/a)| now");

    let mut e = ed("x |");
    e.paste(" https://e.com/a. ");
    assert_eq!(shown(&e), "x <https://e.com/a.>|");
    e.undo();
    assert_eq!(shown(&e), "x  https://e.com/a. |");
    e.undo();
    assert_eq!(shown(&e), "x |");

    // Ctrl-Y (the kill buffer) stays plain
    let mut e = ed("[[sel]]");
    e.set_kill_buffer("https://e.com");
    e.yank();
    assert_eq!(e.text(), "https://e.com");
}

#[test]
fn autolink_literals_follow_gfm() {
    // trailing punctuation is left out
    assert_eq!(bare("https://a.com/x."), ["https://a.com/x"]);
    assert_eq!(bare("go to https://a.com/x, then?"), ["https://a.com/x"]);
    assert_eq!(bare("is it https://a.com/x?!"), ["https://a.com/x"]);
    assert_eq!(bare("*https://a.com*"), ["https://a.com"]);
    assert_eq!(bare("_https://a.com/b_c_"), ["https://a.com/b_c"]);
    assert_eq!(bare("\"https://a.com/x\""), Vec::<String>::new(), "after a quote: GFM doesn't start one");
    assert_eq!(bare("see https://a.com/x\"."), ["https://a.com/x"]);
    // parentheses: an unmatched ")" at the end is left out, matched ones stay
    assert_eq!(bare("(see https://a.com/x)"), ["https://a.com/x"]);
    assert_eq!(bare("https://en.wikipedia.org/wiki/A_(b)"), ["https://en.wikipedia.org/wiki/A_(b)"]);
    assert_eq!(bare("(https://en.wikipedia.org/wiki/A_(b))."), ["https://en.wikipedia.org/wiki/A_(b)"]);
    // an entity-like ending
    assert_eq!(bare("https://a.com/q?x=1&amp;"), ["https://a.com/q?x=1"]);
    assert_eq!(bare("https://a.com/q;"), ["https://a.com/q;"]);
    // www. as https, any case, ends at "<" and whitespace
    assert_eq!(autolinks("visit www.a.com/b now"), [("www.a.com/b".to_string(), "https://www.a.com/b".to_string())]);
    assert_eq!(bare("HTTPS://A.com<b"), ["HTTPS://A.com"]);
    assert_eq!(bare("http://localhost:3000/a b"), ["http://localhost:3000/a"]);
    // not one: mid-word, no domain, underscores in the last parts, www without a dot after
    for t in ["xhttps://a.com", "https://", "https://.a", "https://a_b.c_d", "www.", "www.com_x", "wwwa.com", "see:https://a.com", "ftp://a.com"] {
        assert_eq!(bare(t), Vec::<String>::new(), "{t:?}");
    }
    // across a soft line break: ends at the break
    assert_eq!(bare("a https://a.com/x\nmore"), ["https://a.com/x"]);
}

#[test]
fn autolinks_not_in_code_or_links() {
    assert_eq!(bare("`https://a.com`"), Vec::<String>::new());
    assert_eq!(bare("```\nhttps://a.com\n```"), Vec::<String>::new());
    assert_eq!(bare("[https://a.com](https://b.com)"), Vec::<String>::new());
    assert_eq!(bare("[docs](https://b.com/x)"), Vec::<String>::new());
    assert_eq!(bare("![alt https://a.com](https://b.com/i.png)"), Vec::<String>::new());
    assert_eq!(bare("<session id=\"ses_abc\" />https://a.com"), Vec::<String>::new());
    assert_eq!(bare("<session id=\"ses_abc\" /> https://a.com"), ["https://a.com"]);
    assert_eq!(bare("\\<https://a.com>"), Vec::<String>::new(), "an escaped < isn't an angle autolink (nor after one)");
    // in a table cell and a list item, beside styles and tags
    assert_eq!(bare("| a | https://a.com/x |\n| - | - |\n| b | c |"), ["https://a.com/x"]);
    assert_eq!(bare("- **b** https://a.com #tag"), ["https://a.com"]);
    // the URL's own "#" and "_" are no tag and no emphasis
    let d = parse_doc("x https://a.com/#frag_a_ y");
    assert!(d.lines[0].inline.iter().all(|e| e.ty == InlineType::Autolink), "{:?}", d.lines[0].inline);
}

#[test]
fn angle_autolinks() {
    let d = parse_doc("a <https://a.com/x y> <https://a.com/x> <a@b.co> <foo> <session id=\"s\">");
    let els: Vec<_> = d.lines[0].inline.iter().filter(|e| e.ty == InlineType::Autolink).collect();
    assert_eq!(els.len(), 2, "{els:?}");
    let t = &d.text;
    assert_eq!(&t[els[0].content_from..els[0].content_to], "https://a.com/x");
    assert_eq!(els[0].markers.iter().map(|&(a, b)| &t[a..b]).collect::<Vec<_>>(), ["<", ">"]);
    assert_eq!(autolink_href(&t[els[1].content_from..els[1].content_to]), "mailto:a@b.co");
}

#[test]
fn bare_urls_render_as_link_text_with_nothing_hidden() {
    use editor_core::render::SegKind;
    let e = Editor::new("see https://e.com/a. and [docs](https://f.com)");
    let segs = &e.render_lines()[0].segments;
    let url = segs.iter().find(|s| s.styles.contains(&InlineType::Autolink)).unwrap();
    assert_eq!((url.kind, &e.text()[url.from..url.to], url.hidden), (SegKind::Text, "https://e.com/a", false));
    assert!(segs.iter().filter(|s| s.hidden).all(|s| s.from >= 25), "only the [docs] link's syntax hides");
}
