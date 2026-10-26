//! Images (`![alt](src "title")`), ported from the TS editor's test/editor/images.test.ts.

mod common;

use common::sl;
use editor_core::parser::{InlineType as I, parse_doc, parse_inline};
use editor_core::render::{SegKind, is_image_line, line_segments, line_view};
use editor_core::reveal::compute_reveal;
use editor_core::units::Sel;
use editor_core::{Editor, MonoLayout};

fn els(s: &str) -> Vec<editor_core::parser::InlineEl> {
    parse_inline(s, 0, s.len()).0
}

fn types(s: &str) -> Vec<I> {
    els(s).iter().map(|e| e.ty).collect()
}

#[test]
fn alt_source_and_markers_cover_the_whole_source() {
    let s = "a ![cat pic](images/cat.png) b";
    let img = &els(s)[0];
    assert_eq!(img.ty, I::Image);
    assert_eq!(sl(s, (img.from, img.to)), "![cat pic](images/cat.png)");
    assert_eq!(sl(s, (img.content_from, img.content_to)), "cat pic");
    assert_eq!(sl(s, img.src.unwrap()), "images/cat.png");
    assert_eq!(img.markers.iter().map(|&m| sl(s, m)).collect::<Vec<_>>(), ["![", "cat pic", "](images/cat.png)"]);
    assert_eq!(img.url, None);
    assert_eq!(img.title, None);
}

#[test]
fn titles_in_double_quotes_single_quotes_or_parentheses() {
    for (s, title) in [
        (r#"![a](x.png "A title")"#, "A title"),
        ("![a](x.png 'single')", "single"),
        ("![a](x.png (paren))", "paren"),
        (r#"![a](x.png  "esc \" q"  )"#, "esc \" q"),
    ] {
        let img = &els(s)[0];
        assert_eq!(img.ty, I::Image, "{s}");
        assert_eq!(img.to, s.len());
        assert_eq!(img.title.as_deref(), Some(title));
        assert_eq!(sl(s, img.src.unwrap()), "x.png");
    }
}

#[test]
fn empty_alt_and_no_inline_parsing_in_the_alt() {
    let e = els("![](x.png)");
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].markers.len(), 2);
    assert_eq!(types("![**b**](x.png)"), [I::Image]);
}

#[test]
fn not_images() {
    for s in ["![a]()", "![a](x.png", r#"![a](x.png "t""#, "![a](x.png y)"] {
        assert!(!types(s).contains(&I::Image), "{s}");
    }
    let doc = parse_doc("![a\nb](x.png)");
    assert!(!doc.lines.iter().flat_map(|l| &l.inline).any(|e| e.ty == I::Image));
    // "\!" is an escaped "!": what follows is a link
    assert_eq!(types("\\![a](x.png)"), [I::Link]);
}

#[test]
fn links_keep_their_url_rules_and_can_wrap_an_image() {
    assert!(els(r#"[a](x "t")"#).is_empty());
    let s = "[![badge](https://img/b.svg)](https://example.com)";
    let got: Vec<_> = els(s).iter().map(|e| (e.ty, sl(s, (e.from, e.to)).to_string())).collect();
    assert_eq!(got, [(I::Link, s.to_string()), (I::Image, "![badge](https://img/b.svg)".to_string())]);
}

#[test]
fn table_cells_dont_draw_images() {
    let doc = parse_doc("| a | b |\n|---|---|\n| ![x](y.png) | z |");
    assert_eq!(doc.lines[2].inline.iter().map(|e| e.ty).collect::<Vec<_>>(), [I::Link]);
}

#[test]
fn the_whole_source_is_collapsible_markers() {
    let doc = parse_doc("x ![alt](a.png)");
    let segs: Vec<_> = line_segments(&doc.lines[0], &doc.text).iter().map(|s| (s.kind, sl(&doc.text, (s.from, s.to)).to_string())).collect();
    let want = [(SegKind::Text, "x "), (SegKind::Marker, "!["), (SegKind::Marker, "alt"), (SegKind::Marker, "](a.png)")];
    assert_eq!(segs, want.map(|(k, s)| (k, s.to_string())));
}

#[test]
fn image_only_lines() {
    let only = |s: &str| is_image_line(&parse_doc(s).lines[0]);
    assert!(only("![a](x.png)"));
    assert!(only("![a](x.png)![b](y.png)"));
    assert!(only("[![a](x.png)](https://e.com)"));
    assert!(!only("![a](x.png) "));
    assert!(!only("![a](x.png) ![b](y.png)"));
    assert!(!only("text ![a](x.png)"));
    assert!(!only("- ![a](x.png)"));
    assert!(!only("[link](https://e.com)"));
    assert!(only("![a](<my cat.png>)"));
    // inside formatting that spans the paragraph's lines, an image line is still part of the text
    assert!(!is_image_line(&parse_doc("**a\n![x](y.png)\nb**").lines[1]));
    assert!(is_image_line(&parse_doc("a\n![x](y.png)\nb").lines[1]));
}

#[test]
fn angle_bracket_sources_may_hold_spaces() {
    // CommonMark: no line break or unescaped "<" inside; the brackets stay in the range
    let s = r#"![my cat](<my cat.png> "T")"#;
    let img = &els(s)[0];
    assert_eq!((img.ty, img.to), (I::Image, s.len()));
    assert_eq!(sl(s, img.src.unwrap()), "<my cat.png>");
    assert_eq!(img.title.as_deref(), Some("T"));
    assert_eq!(els("![a](<b\\>c.png>)")[0].to, 16);
    for s in ["![a](<b<c.png>)", "![a](<b.png)", "![a](<>)"] {
        assert!(!types(s).contains(&I::Image), "{s}");
    }
    let doc = parse_doc("![a](<b\nc.png>)");
    assert!(!doc.lines.iter().flat_map(|l| &l.inline).any(|e| e.ty == I::Image));
    // links too; the chip opens the URL without the brackets
    let l = "[a](<https://e.com/a b>) x";
    let link = &els(l)[0];
    assert_eq!((link.ty, sl(l, (link.from, link.to)), sl(l, link.url.unwrap())), (I::Link, "[a](<https://e.com/a b>)", "<https://e.com/a b>"));
    assert_eq!(editor_core::url::safe_url(sl(l, link.url.unwrap())).as_deref(), Some("https://e.com/a b"));
}

#[test]
fn an_image_among_text_is_not_an_edge_marker() {
    // Drawn below the line: a click past the text stays before the source, and one before the
    // text after the source, instead of jumping over (and revealing) it.
    let mut e = Editor::new("text ![a](x.png)\nnext");
    e.set_selection(Sel::caret(20));
    let l = MonoLayout::new(&e);
    e.mouse_down(&l, 150.0, 10.0, 1, false);
    assert_eq!(e.selection(), Sel::caret(5));
    let mut e = Editor::new("![a](x.png) text\nnext");
    e.set_selection(Sel::caret(20));
    let l = MonoLayout::new(&e);
    assert_eq!(e.hit_test(&l, 0.0, 10.0), Some(11));
    // On an image-only line the source is the line's edge as before.
    let mut e = Editor::new("![a](x.png)![b](y.png)\nnext");
    e.set_selection(Sel::caret(25));
    let l = MonoLayout::new(&e);
    assert_eq!(e.hit_test(&l, 150.0, 10.0), Some(22));
}

#[test]
fn the_caret_anywhere_on_an_image_only_line_reveals_it() {
    let doc = parse_doc("![a](x.png)\nnext");
    for p in 0..=11 {
        assert_eq!(compute_reveal(&doc, Some(Sel::caret(p))).get(&0).map(|r| r.els.clone()), Some(vec![0]), "{p}");
    }
    assert!(!compute_reveal(&doc, Some(Sel::caret(13))).contains_key(&0));
}

#[test]
fn line_views_list_images_with_their_reveal_state() {
    let doc = parse_doc("![a cat](images/my%20cat.png \"T\")\ntext ![b](/abs/b.png)");
    let collapsed = line_view(&doc, &doc.lines[0], None);
    assert!(collapsed.image_only && collapsed.text_hidden());
    let img = &collapsed.images[0];
    assert_eq!((img.alt.as_str(), img.src.as_str(), img.title.as_deref(), img.revealed), ("a cat", "images/my%20cat.png", Some("T"), false));
    assert_eq!(sl(&doc.text, img.alt_range), "a cat");
    assert_eq!((img.from, img.to), (0, doc.lines[0].to));
    assert!(collapsed.segments.iter().all(|s| s.hidden));

    let rv = compute_reveal(&doc, Some(Sel::caret(3)));
    let open = line_view(&doc, &doc.lines[0], rv.get(&0));
    assert!(open.images[0].revealed && !open.text_hidden());
    assert!(open.segments.iter().all(|s| !s.hidden));

    let mixed = line_view(&doc, &doc.lines[1], None);
    assert!(!mixed.image_only && !mixed.text_hidden());
    assert_eq!(mixed.images.len(), 1);
    assert_eq!(mixed.images[0].src, "/abs/b.png");
}

#[test]
fn the_editor_renders_image_lines() {
    let mut e = Editor::new("intro\n![x](x.png)\n");
    e.set_selection(Sel::caret(0));
    let lines = e.render_lines();
    assert!(lines[1].text_hidden());
    e.set_selection(Sel::caret(8));
    assert!(!e.render_lines()[1].text_hidden());
}

#[test]
fn a_collapsed_linked_image_shows_only_the_image() {
    // The link's chip and markers hide with the image source (TS `.ln-img:not(.img-rv)`).
    let doc = parse_doc("[![a](x.png)](https://e.com)\nnext");
    let v = line_view(&doc, &doc.lines[0], None);
    assert!(v.text_hidden());
    assert!(v.segments.iter().any(|s| s.kind == SegKind::Chip));
    assert!(v.segments.iter().all(|s| s.hidden), "{:?}", v.segments);
    let rv = compute_reveal(&doc, Some(Sel::caret(3)));
    let open = line_view(&doc, &doc.lines[0], rv.get(&0));
    assert!(open.segments.iter().any(|s| s.kind == SegKind::Chip && !s.hidden));
}

