//! Links: collapsed whatever the selection (the caret steps through their text like plain text),
//! expanded only by `Editor::expand_link` (the pencil), then their URL is ordinary editable text.

use editor_core::render::SegKind;
use editor_core::units::next_stop;
use editor_core::{Editor, HUnit, MonoLayout, Sel};

const T: &str = "see [docs](https://e.com/a) now";
const FROM: usize = 4;
const TO: usize = 27;

fn chip(e: &Editor) -> editor_core::SegView {
    e.render_lines()[0]
        .segments
        .iter()
        .find(|s| s.kind == SegKind::Chip)
        .unwrap()
        .clone()
}

/// The link (element 0) is revealed.
fn revealed(e: &Editor) -> bool {
    e.reveal().get(&0).is_some_and(|r| r.els.contains(&0))
}

#[test]
fn arrows_through_a_collapsed_link_never_reveal_it() {
    let mut e = Editor::new(T);
    e.set_selection(Sel::caret(0));
    let mut heads = Vec::new();
    for _ in 0..9 {
        e.move_horizontal(1, false, HUnit::Char);
        heads.push(e.selection().head);
        assert!(
            !revealed(&e) && chip(&e).hidden,
            "at {}",
            e.selection().head
        );
    }
    // before the link, inside its text, after it: never in its brackets or URL
    assert_eq!(heads, [1, 2, 3, FROM, 6, 7, 8, TO, 28]);
    let mut back = Vec::new();
    for _ in 0..5 {
        e.move_horizontal(-1, false, HUnit::Char);
        back.push(e.selection().head);
        assert!(!revealed(&e));
    }
    assert_eq!(back, [TO, 8, 7, 6, FROM]);
    // words too
    e.set_selection(Sel::caret(TO + 4));
    e.move_horizontal(-1, false, HUnit::Word);
    e.move_horizontal(-1, false, HUnit::Word);
    assert_eq!(e.selection().head, FROM);
    assert!(!revealed(&e));
    // a selection over it doesn't reveal it either
    e.set_selection(Sel::new(0, T.len()));
    assert!(!revealed(&e));
}

#[test]
fn a_caret_set_in_the_hidden_syntax_snaps_out() {
    let mut e = Editor::new(T);
    e.set_selection(Sel::caret(T.find("https").unwrap() + 3));
    assert_eq!(e.selection(), Sel::caret(TO));
    e.set_selection(Sel::caret(FROM + 1));
    assert_eq!(e.selection(), Sel::caret(FROM));
    assert!(!revealed(&e));
}

#[test]
fn typing_in_a_collapsed_links_text_edits_its_text() {
    let mut e = Editor::new(T);
    e.set_selection(Sel::caret(7));
    e.insert_text("X");
    assert_eq!(e.text(), "see [doXcs](https://e.com/a) now");
    assert!(!revealed(&e));
    // at its edges: outside it
    let mut e = Editor::new(T);
    e.set_selection(Sel::caret(TO));
    e.insert_text("!");
    assert_eq!(e.text(), "see [docs](https://e.com/a)! now");
    e.set_selection(Sel::caret(FROM));
    e.insert_text("(");
    assert_eq!(e.text(), "see ([docs](https://e.com/a)! now");
    // Backspace after it deletes its last character
    let mut e = Editor::new(T);
    e.set_selection(Sel::caret(TO));
    e.delete_backward();
    assert_eq!(e.text(), "see [doc](https://e.com/a) now");
    assert_eq!(e.selection(), Sel::caret(TO - 1));
}

#[test]
fn expand_link_shows_its_url_as_editable_text() {
    let mut e = Editor::new(T);
    assert!(!e.expand_link(1));
    assert!(e.expand_link(6));
    assert_eq!(e.expanded_link(), Some(FROM));
    // the caret at the end of its text
    assert_eq!(e.selection(), Sel::caret(9));
    assert!(revealed(&e));
    let c = chip(&e);
    assert!(!c.hidden);
    assert_eq!(c.el, Some(0));
    // the URL: every position a stop, typing edits it
    let u0 = T.find("https").unwrap();
    assert_eq!(next_stop(e.doc(), u0), u0 + 1);
    e.move_horizontal(1, false, HUnit::Char);
    e.move_horizontal(1, false, HUnit::Char);
    assert_eq!(e.selection().head, u0);
    e.move_horizontal(1, false, HUnit::Char);
    e.insert_text("X");
    assert_eq!(e.text(), "see [docs](hXttps://e.com/a) now");
    assert_eq!(e.expanded_link(), Some(FROM));
    // a click inside it places the caret
    let l = MonoLayout::new(&e);
    e.mouse_down(&l, (u0 as f64 + 4.0) * 10.0, 5.0, 1, false);
    assert_eq!(e.selection(), Sel::caret(u0 + 4));
    assert!(revealed(&e));
    // at its edges it stays expanded; leaving it collapses it
    e.set_selection(Sel::caret(TO + 1));
    assert!(revealed(&e));
    e.set_selection(Sel::caret(TO + 2));
    assert_eq!(e.expanded_link(), None);
    assert!(!revealed(&e) && chip(&e).hidden);
    // a selection reaching out of it collapses it too
    e.expand_link(FROM);
    e.set_selection(Sel::new(u0 + 2, 1));
    assert_eq!(e.expanded_link(), None);
    assert_eq!(
        e.selection(),
        Sel::new(TO + 1, 1),
        "the end in the hidden URL snapped out"
    );
}

#[test]
fn a_deleted_link_collapses_and_undo_doesnt_expand_it_again() {
    // a remote edit removing it
    let mut e = Editor::new(T);
    e.expand_link(FROM);
    e.apply_remote(&[(0..1, "S".into())]);
    assert_eq!(e.expanded_link(), Some(FROM));
    e.apply_remote(&[(FROM..TO, "docs".into())]);
    assert_eq!(e.expanded_link(), None);
    // a remote insert before it moves it
    let mut e = Editor::new(T);
    e.expand_link(FROM);
    e.apply_remote(&[(0..0, "ab".into())]);
    assert_eq!(e.expanded_link(), Some(FROM + 2));
    assert!(e.reveal().get(&0).is_some_and(|r| r.els.contains(&0)));
    // undo removing it
    let mut e = Editor::new("x ");
    e.set_selection(Sel::caret(2));
    e.insert_text("[a](u)");
    assert!(e.expand_link(3));
    assert_eq!(e.expanded_link(), Some(2));
    e.undo();
    assert_eq!(e.text(), "x ");
    assert_eq!(e.expanded_link(), None);
    e.redo();
    assert_eq!(e.text(), "x [a](u)");
    assert_eq!(e.expanded_link(), None);
}

#[test]
fn a_collapsed_link_in_the_mono_layout_is_its_text() {
    let mut e = Editor::new(&format!("{T}\nabcdefghijklmnop"));
    // collapsed: "see docs now"; a click after "docs" goes after the link, before it before it
    let l = MonoLayout::new(&e);
    let now = T.find("now").unwrap();
    assert_eq!(e.hit_test(&l, 9.0 * 10.0 + 1.0, 5.0), Some(now));
    e.mouse_down(&l, 8.0 * 10.0, 5.0, 1, false);
    assert_eq!(e.selection(), Sel::caret(TO));
    e.mouse_down(&l, 4.0 * 10.0, 5.0, 1, false);
    assert_eq!(e.selection(), Sel::caret(FROM));
    e.mouse_down(&l, 6.0 * 10.0, 5.0, 1, false);
    assert_eq!(e.selection(), Sel::caret(7));
    assert!(!revealed(&e));
    // Up from the next line lands in its text, collapsed
    let second = T.len() + 1;
    e.set_selection(Sel::caret(second + 6));
    let l = MonoLayout::new(&e);
    e.move_vertical(&l, -1, false);
    assert_eq!(e.selection(), Sel::caret(7));
    assert!(!revealed(&e));
    e.set_selection(Sel::caret(second + 8));
    e.move_vertical(&l, -1, false);
    assert_eq!(e.selection(), Sel::caret(TO));
    // expanded: every URL character is a column
    let u0 = T.find("https").unwrap();
    e.expand_link(FROM);
    let l = MonoLayout::new(&e);
    assert_eq!(e.hit_test(&l, (u0 as f64 + 2.0) * 10.0, 5.0), Some(u0 + 2));
}
