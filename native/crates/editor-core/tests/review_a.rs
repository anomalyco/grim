//! Regression tests for the web Phase A review (docs/rust-engine/review-A.md in the web repo):
//! text with `\r` is never rewritten, undo past items emptied by remote edits, Up/Down at the
//! document's edge, multi-clicks without a first click at that spot.

use std::cell::Cell;

use editor_core::{Adjacent, Bounds, Editor, Key, Layout, Mods, MonoLayout, Rect, Sel, StringStore, TextStore, TokenKind};

fn sel(e: &Editor) -> (usize, usize) {
    (e.selection().anchor, e.selection().head)
}

fn bullets(e: &Editor) -> usize {
    e.render_lines().iter().flat_map(|l| &l.segments).filter(|s| s.token == Some(TokenKind::Bullet)).count()
}

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

// --- 1. `\r` is kept, like the TS parser (only "\n" ends a line)

#[test]
fn text_with_cr_is_not_rewritten() {
    for text in ["a\r\nb", "- one\r\n- two\r\n", "x\ry", "\r", "# h\r\n\r\npara\r"] {
        let e = Editor::new(text);
        assert_eq!(e.text(), text);
        assert_eq!(e.store().text(), text);
        assert_eq!(e.doc().lines.len(), text.matches('\n').count() + 1, "{text:?}");
        let e = Editor::with_store(StringStore::new(text));
        assert_eq!(e.store().text(), text);
    }
    let mut e = Editor::new("a\r\nb");
    e.set_text("a\r\nb\r\nc");
    assert_eq!(e.text(), "a\r\nb\r\nc");
    // a remote edit after the "\r" lands where the collaborator meant it
    e.apply_remote(&[(5..5, "X".into())]);
    assert_eq!(e.text(), "a\r\nb\rX\nc");
    // list rules on CRLF lines: "\r" is part of the line's text, as in the TS
    let mut e = Editor::new("- one\r\n- two");
    assert_eq!(bullets(&e), 2);
    e.set_selection(Sel::caret(e.text().len()));
    typ(&mut e, "\nthree");
    assert_eq!(e.text(), "- one\r\n- two\n- three");
    assert!(e.undo());
    assert_eq!(e.text(), "- one\r\n- two");
}

// --- 2. undo/redo past items a remote edit made empty

#[test]
fn undo_past_an_emptied_item_uses_the_item_it_reverts() {
    let mut e = Editor::new("hello world");
    e.set_selection(Sel::caret(5));
    typ(&mut e, "A");
    e.set_selection(Sel::caret(12));
    typ(&mut e, "B");
    assert_eq!(e.text(), "helloA worldB");
    // a collaborator deletes the "B": the top undo item now changes nothing
    e.apply_remote(&[(12..13, String::new())]);
    assert!(e.undo());
    assert_eq!(e.text(), "hello world");
    assert_eq!(sel(&e), (5, 5));
    assert!(e.redo());
    assert_eq!(e.text(), "helloA world");
    // the redo restores the selection after the "A", not the one after the dropped "B"
    assert_eq!(sel(&e), (6, 6));
    assert!(e.undo());
    assert_eq!(sel(&e), (5, 5));
}

#[test]
fn a_mark_below_an_emptied_item_is_not_skipped() {
    let mut e = Editor::new("");
    typ(&mut e, "ab\n- ");
    assert_eq!(bullets(&e), 1);
    e.set_selection(Sel::caret(0));
    typ(&mut e, "Z");
    assert_eq!(e.text(), "Zab\n- ");
    e.apply_remote(&[(0..1, String::new())]);
    // the "Z" item is gone: the conversion mark is next (text unchanged, shown literally)
    assert!(e.undo());
    assert_eq!(e.text(), "ab\n- ");
    assert_eq!(bullets(&e), 0);
    assert!(e.undo());
    assert_eq!(e.text(), "");
    assert!(e.redo());
    assert_eq!(e.text(), "ab\n- ");
    assert_eq!(bullets(&e), 1);
}

#[test]
fn nothing_to_redo_does_not_end_the_typing_group() {
    let mut e = Editor::new("");
    typ(&mut e, "ab");
    assert!(!e.redo());
    typ(&mut e, "c");
    assert!(e.undo());
    assert_eq!(e.text(), "");
}

// --- 6. Up/Down at the document's edge

/// MonoLayout counting hit tests, optionally without `adjacent_line`.
struct Counting {
    lay: MonoLayout,
    hits: Cell<usize>,
    adjacent: bool,
}

impl Layout for Counting {
    fn caret_rect(&self, pos: usize) -> Rect {
        self.lay.caret_rect(pos)
    }
    fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
        self.hits.set(self.hits.get() + 1);
        self.lay.hit_test(x, y)
    }
    fn bounds(&self) -> Bounds {
        self.lay.bounds()
    }
    fn line_mid_y(&self, line: usize) -> Option<f64> {
        self.lay.line_mid_y(line)
    }
    fn adjacent_line(&self, pos: usize, dir: i32) -> Adjacent {
        if self.adjacent { self.lay.adjacent_line(pos, dir) } else { Adjacent::Unknown }
    }
}

#[test]
fn up_down_at_the_edge_go_to_the_document_ends_without_probing() {
    let mut e = Editor::new("first line\nsecond line\nthird");
    e.set_selection(Sel::caret(3));
    let l = Counting { lay: MonoLayout::new(&e), hits: Cell::new(0), adjacent: true };
    assert_eq!(l.adjacent_line(3, -1), Adjacent::Edge);
    assert_eq!(l.adjacent_line(3, 1), Adjacent::Y(30.0));
    e.move_vertical(&l, -1, false);
    assert_eq!(sel(&e), (0, 0));
    assert_eq!(l.hits.get(), 0, "no probing at the edge");
    e.set_selection(Sel::caret(25));
    e.move_vertical(&l, 1, true);
    assert_eq!(sel(&e), (25, 28));
    assert_eq!(l.hits.get(), 0);
    // a layout that can't tell probes (from the second line: the first line is hit), same offsets
    let mut e = Editor::new("first line\nsecond line\nthird");
    e.set_selection(Sel::caret(14));
    let l = Counting { lay: MonoLayout::new(&e), hits: Cell::new(0), adjacent: false };
    e.move_vertical(&l, -1, false);
    assert_eq!(sel(&e), (3, 3));
    assert!(l.hits.get() > 0);
}

/// A layout that only implements the old `adjacent_line_y`: None means "unknown".
struct OldStyle(MonoLayout);

impl Layout for OldStyle {
    fn caret_rect(&self, pos: usize) -> Rect {
        self.0.caret_rect(pos)
    }
    fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
        self.0.hit_test(x, y)
    }
    fn bounds(&self) -> Bounds {
        self.0.bounds()
    }
    fn adjacent_line_y(&self, pos: usize, dir: i32) -> Option<f64> {
        self.0.adjacent_line_y(pos, dir)
    }
}

#[test]
fn adjacent_line_defaults_to_adjacent_line_y() {
    let e = Editor::new("a\nb");
    let l = OldStyle(MonoLayout::new(&e));
    assert_eq!(l.adjacent_line(0, 1), Adjacent::Y(30.0));
    assert_eq!(l.adjacent_line(0, -1), Adjacent::Unknown);
}

// --- 7. a multi-click without a first click at that spot

fn click(e: &mut Editor, col: f64, line: usize, count: u32) {
    let l = MonoLayout::new(e);
    e.mouse_down(&l, col * 10.0, line as f64 * 20.0 + 10.0, count, false);
}

#[test]
fn double_click_without_a_first_click_there_hits_its_own_point() {
    let mut e = Editor::new("alpha beta gamma\nsecond line");
    click(&mut e, 13.0, 0, 2);
    assert_eq!(sel(&e), (11, 16));
    // first click on "alpha", the double click's second press elsewhere: the word there
    click(&mut e, 2.0, 0, 1);
    click(&mut e, 7.0, 0, 2);
    assert_eq!(sel(&e), (6, 10));
    click(&mut e, 3.0, 1, 3);
    assert_eq!(sel(&e), (17, 28));
    // the usual sequence still uses the first click's spot
    click(&mut e, 7.0, 0, 1);
    click(&mut e, 7.0, 0, 2);
    assert_eq!(sel(&e), (6, 10));
    click(&mut e, 7.0, 0, 3);
    assert_eq!(sel(&e), (0, 17));
}
