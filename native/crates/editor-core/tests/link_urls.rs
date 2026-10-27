//! `Editor::set_link_urls_editable`: link URLs as text (the native app's clickable links), and
//! the default (atomic chips) unchanged.

use editor_core::render::SegKind;
use editor_core::units::{next_stop, prev_stop};
use editor_core::{Editor, HUnit, MonoLayout, Sel};

const T: &str = "see [docs](https://e.com/a) now";

fn editor(on: bool) -> Editor {
    let mut e = Editor::new(T);
    e.set_link_urls_editable(on);
    e
}

fn chip(e: &Editor) -> editor_core::SegView {
    e.render_lines()[0].segments.iter().find(|s| s.kind == SegKind::Chip).unwrap().clone()
}

#[test]
fn urls_are_atomic_chips_by_default() {
    let mut e = editor(false);
    let u0 = T.find("https").unwrap();
    let u1 = T.find(") now").unwrap();
    assert_eq!(next_stop(e.doc(), u0), u1);
    let c = chip(&e);
    assert_eq!((c.from, c.to, c.hidden, c.el), (u0, u1, false, None));
    e.set_selection(Sel::caret(u0 + 3));
    assert_eq!(e.selection(), Sel::caret(u0), "snapped out of the chip");
}

#[test]
fn editable_urls_are_text_hidden_while_collapsed() {
    let mut e = editor(true);
    let u0 = T.find("https").unwrap();
    let u1 = T.find(") now").unwrap();
    assert_eq!(next_stop(e.doc(), u0), u0 + 1);
    assert_eq!(prev_stop(e.doc(), u1), u1 - 1);
    // collapsed (caret at the start): hidden, with its link's element
    let c = chip(&e);
    assert!(c.hidden);
    assert_eq!(c.el, Some(0));
    // the caret inside the URL reveals it, and it stays there
    e.set_selection(Sel::caret(u0 + 3));
    assert_eq!(e.selection(), Sel::caret(u0 + 3));
    assert!(!chip(&e).hidden);
    // typing edits the URL
    e.insert_text("X");
    assert_eq!(e.text(), "see [docs](httXps://e.com/a) now");
    // the caret walks through it
    e.set_selection(Sel::caret(T.find("](").unwrap()));
    e.move_horizontal(1, false, HUnit::Char);
    e.move_horizontal(1, false, HUnit::Char);
    e.move_horizontal(1, false, HUnit::Char);
    assert_eq!(e.selection().head, u0 + 1);
}

#[test]
fn editable_urls_in_the_mono_layout() {
    let mut e = editor(true);
    // collapsed: "see docs now" (the URL takes no column)
    let l = MonoLayout::new(&e);
    let now = T.find("now").unwrap();
    assert_eq!(e.hit_test(&l, 9.0 * 10.0 + 1.0, 10.0), Some(now));
    // revealed: every URL character is a column
    let u0 = T.find("https").unwrap();
    e.set_selection(Sel::caret(u0));
    let l = MonoLayout::new(&e);
    assert_eq!(e.hit_test(&l, (u0 as f64 + 2.0) * 10.0, 10.0), Some(u0 + 2));
}

#[test]
fn turning_it_on_snaps_nothing_and_reports_every_line() {
    let mut e = Editor::new("a\n[b](c)");
    let _ = e.take_line_changes();
    e.set_link_urls_editable(true);
    let c = e.take_line_changes().unwrap();
    assert_eq!((c.start, c.old_end, c.new_end), (0, 2, 2));
    e.set_link_urls_editable(true);
    assert!(e.take_line_changes().is_none());
}
