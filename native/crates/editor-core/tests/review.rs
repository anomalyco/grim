//! Regression tests for code-review findings: char-boundary-safe hit tests, grapheme clusters
//! that never cross inline syntax, hit affinity next to hidden markers, `set_text` hygiene,
//! read-only keys, and behaviours pinned to the TS editor where it differs from the obvious fix.

use editor_core::layout::DisplayMap;
use editor_core::parser::{BlockType, TokenKind, literal_line, parse_doc};
use editor_core::render::LineView;
use editor_core::rules::{self as R, FormatType};
use editor_core::units::{Sel, is_stop, next_stop, prev_stop, word_range};
use editor_core::{Bounds, Command, Editor, Key, Layout, Mods, MonoLayout, Rect};

fn k(e: &mut Editor, key: Key, m: Mods) -> Option<Command> {
    let l = MonoLayout::new(e);
    e.key(key, m, &l)
}

fn sel(e: &Editor) -> (usize, usize) {
    (e.selection().anchor, e.selection().head)
}

fn click(e: &mut Editor, col: f64, line: usize, count: u32, shift: bool) {
    let l = MonoLayout::new(e);
    e.mouse_down(&l, col * 10.0, line as f64 * 20.0 + 10.0, count, shift);
}

fn bullets(e: &Editor) -> usize {
    e.render_lines().iter().flat_map(|l| &l.segments).filter(|s| s.token == Some(TokenKind::Bullet)).count()
}

/// MonoLayout without line geometry: a hit on a collapsed delimiter row can't be redirected to the
/// header row, so the engine's fallback target is used.
struct NoMid(MonoLayout);

impl Layout for NoMid {
    fn caret_rect(&self, pos: usize) -> Rect {
        self.0.caret_rect(pos)
    }
    fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
        self.0.hit_test(x, y)
    }
    fn bounds(&self) -> Bounds {
        self.0.bounds()
    }
    fn table_cell_at(&self, line: usize, x: f64, y: f64) -> Option<usize> {
        self.0.table_cell_at(line, x, y)
    }
}

// --- 1. hit tests always land on a char boundary

#[test]
fn collapsed_delimiter_fallback_is_a_char_boundary() {
    let mut e = Editor::new("é | b\n---|---\n\nz");
    e.set_selection(Sel::caret(e.text().len()));
    let l = NoMid(MonoLayout::new(&e));
    let p = e.hit_test(&l, 5.0, 30.0).unwrap();
    assert!(e.text().is_char_boundary(p), "hit {p} is inside a char");
    assert_eq!(p, 2, "one character into the header row, as the TS head.from + 1");
    e.mouse_down(&l, 5.0, 30.0, 1, false);
    let l = NoMid(MonoLayout::new(&e));
    e.mouse_down(&l, 5.0, 30.0, 2, false);
    assert_eq!(sel(&e), (0, 2), "double-click selects the word 'é'");
}

// --- 2. grapheme clusters don't cross escapes or markers

#[test]
fn backspace_after_escape_with_combining_mark_keeps_the_escape_pair() {
    let mut e = Editor::new("\\*\u{301}");
    e.set_selection(Sel::caret(e.text().len()));
    e.delete_backward();
    assert_eq!(e.text(), "\\*");
    let d = parse_doc("\\*\u{301}");
    assert!(is_stop(&d, 2));
    assert_eq!(prev_stop(&d, 4), 2);
    assert_eq!(prev_stop(&d, 2), 0);
    assert_eq!(next_stop(&d, 0), 2);
}

#[test]
fn backspace_after_bold_with_combining_mark_keeps_the_marker() {
    let mut e = Editor::new("**bold**\u{301}");
    e.set_selection(Sel::caret(e.text().len()));
    e.delete_backward();
    assert_eq!(e.text(), "**bold**");
}

#[test]
fn clusters_inside_plain_text_are_still_atomic() {
    let d = parse_doc("ae\u{301}b");
    assert!(!is_stop(&d, 2));
    assert_eq!(next_stop(&d, 1), 4);
    // a prepended char before an ASCII letter forms one cluster
    let d = parse_doc("\u{600}a");
    assert!(!is_stop(&d, 2));
}

// --- 3. words are classified by cluster

#[test]
fn word_range_and_bold_never_split_a_cluster() {
    let t = "-\u{301}hello";
    let d = parse_doc(t);
    assert_eq!(word_range(&d, 5), Some((3, 8)));
    let mut e = Editor::new(t);
    e.set_selection(Sel::caret(5));
    e.toggle_format(FormatType::Bold);
    assert_eq!(e.text(), "-\u{301}**hello**");
    // a word char followed by a zero-width joiner: the joiner belongs to the word's last cluster
    let d = parse_doc("ab\u{200d} c");
    assert_eq!(word_range(&d, 1), Some((0, 5)));
}

// --- 4. undo past a conversion (pinned to the TS)

#[test]
fn undo_past_conversion_then_redo_matches_ts() {
    // The TS drops a literal mark whose line changed (here: deleted by the second undo), so the
    // first redo brings back the converted bullet and there is nothing left to redo.
    let mut e = Editor::new("");
    e.insert_text("-");
    e.insert_text(" ");
    assert_eq!(bullets(&e), 1);
    assert!(e.undo());
    assert_eq!(bullets(&e), 0);
    assert!(e.undo());
    assert_eq!(e.text(), "");
    assert!(e.redo());
    assert_eq!(e.text(), "- ");
    assert_eq!(bullets(&e), 1);
    assert!(!e.redo());
}

// --- 5. hit affinity next to hidden markers

fn line0(e: &Editor) -> LineView {
    e.render_lines().remove(0)
}

#[test]
fn display_map_affinity_next_to_hidden_markers() {
    let mut e = Editor::new("plain **bold** text\n");
    e.set_selection(Sel::caret(e.text().len()));
    let m = DisplayMap::from_line(&line0(&e), e.text());
    assert_eq!(m.display_len(), "plain bold text".len());
    // after "plain bold": the right half of 'd' stays before the closing markers (TS offsets.ts)
    assert_eq!(m.raw_at(10, true), 12);
    assert_eq!(m.raw_at(10, false), 14);
    // after "plain ": the right half of the space stays before the opening markers
    assert_eq!(m.raw_at(6, true), 6);
    assert_eq!(m.raw_at(6, false), 8);
    assert_eq!(m.raw_at(0, false), 0);
    assert_eq!(m.raw_at(15, true), 19);
    assert_eq!(m.raw_at(99, false), 19);
}

#[test]
fn display_map_hidden_edges_and_wide_units() {
    let mut e = Editor::new("**b**\n");
    e.set_selection(Sel::caret(e.text().len()));
    let m = DisplayMap::from_line(&line0(&e), e.text());
    assert_eq!(m.raw_at(0, false), 2);
    assert_eq!(m.raw_at(0, true), 0);
    assert_eq!(m.raw_at(1, true), 3);
    assert_eq!(m.raw_at(1, false), 5);
    // a tab drawn as four spaces: inside it, the tab's start
    let mut m = DisplayMap::new(0);
    m.push(0, 1, 4);
    m.push(1, 2, 1);
    m.set_end(2);
    assert_eq!(m.raw_at(2, false), 0);
    assert_eq!(m.raw_at(4, true), 1);
    assert_eq!(m.raw_at(4, false), 1);
}

#[test]
fn click_on_right_half_of_last_bold_char_types_bold() {
    let mut e = Editor::new("plain **bold** text\n");
    e.set_selection(Sel::caret(e.text().len()));
    // MonoLayout: 'd' is column 9; its right half
    click(&mut e, 9.7, 0, 1, false);
    assert_eq!(sel(&e), (12, 12));
    // the left half of the following space lands after the closing markers
    e.set_selection(Sel::caret(e.text().len()));
    click(&mut e, 10.2, 0, 1, false);
    assert_eq!(sel(&e), (14, 14));
}

// --- 6. shift-click / drag use the native hit (pinned to the TS)

#[test]
fn shift_click_extends_to_native_hit_like_ts() {
    // The TS lets the browser extend the selection (no edge fixups), so a shift-click past hidden
    // closing markers stops before them; a plain click goes to the line end.
    let mut e = Editor::new("a **b**\nz");
    e.set_selection(Sel::caret(0));
    click(&mut e, 30.0, 0, 1, true);
    assert_eq!(sel(&e), (0, 5));
    e.set_selection(Sel::caret(e.text().len()));
    click(&mut e, 30.0, 0, 1, false);
    assert_eq!(sel(&e), (7, 7));
}

// --- 7. literal todo token (pinned to the TS)

#[test]
fn literal_todo_keeps_two_char_bullet_token_like_ts() {
    let t = " - [ ] x";
    let d = parse_doc(t);
    let l = literal_line(t, &d.lines[0], BlockType::Bullet);
    assert_eq!(l.ty, BlockType::Bullet);
    let toks: Vec<(TokenKind, usize, usize)> = l.tokens.iter().map(|t| (t.kind, t.from, t.to)).collect();
    assert_eq!(toks, vec![(TokenKind::Bullet, 0, 2)]);
    assert!(l.table.is_none());
}

// --- 8. "- " below a table (pinned to the TS)

#[test]
fn dash_space_below_table_is_not_a_conversion_like_ts() {
    let t = "a | b\n--|--\nx | y\n-";
    let d = parse_doc(t);
    assert_eq!(d.lines[3].ty, BlockType::TableRow);
    let e = R::insert_text(&d, Sel::caret(t.len()), " ");
    assert_eq!(e.converts, None);
}

// --- 9. CRLF

// (Superseded by the web Phase A review: the engine keeps "\r" like the TS parser, so a shared
// note is never rewritten; the native app normalizes local files when it opens them.)
#[test]
fn crlf_is_kept() {
    let mut e = Editor::new("a\r\nb\r\n");
    assert_eq!(e.text(), "a\r\nb\r\n");
    assert_eq!(e.doc().lines.len(), 3);
    e.set_text("x\r\ny\rz");
    assert_eq!(e.text(), "x\r\ny\rz");
    assert_eq!(e.doc().lines.len(), 2);
}

// --- 10. set_text hygiene

#[test]
fn set_text_maps_composition_and_clears_goal() {
    let mut e = Editor::new("hello\nworld");
    e.set_selection(Sel::caret(2));
    let l = MonoLayout::new(&e);
    e.move_vertical(&l, 1, false);
    assert!(e.goal_x().is_some());
    e.set_text("XXhello\nworld");
    assert_eq!(e.goal_x(), None);

    let mut e = Editor::new("hello world");
    e.set_selection(Sel::caret(5));
    e.begin_composition();
    e.set_text("XXhello world");
    e.end_composition("é");
    assert_eq!(e.text(), "XXhelloé world");
}

#[test]
fn set_text_keeps_a_literal_line_like_a_remote_edit() {
    let mut e = Editor::new("x\n");
    e.set_selection(Sel::caret(2));
    e.insert_text("-");
    e.insert_text(" ");
    e.undo();
    assert_eq!(bullets(&e), 0);
    e.set_text("y\n- ");
    assert_eq!(bullets(&e), 0, "the unchanged line stays literal");
    assert!(!e.can_undo());
    e.set_text("y\n- q");
    assert_eq!(bullets(&e), 1);
}

// --- 11. read-only keys

#[test]
fn read_only_keys_do_not_run_edits() {
    let mut e = Editor::new("- a");
    e.set_read_only(true);
    e.set_selection(Sel::caret(3));
    assert_eq!(k(&mut e, Key::Tab, Mods::NONE), None, "Tab is left to the system, as in input.ts");
    assert_eq!(k(&mut e, Key::Backspace, Mods::NONE), None);
    assert_eq!(k(&mut e, Key::Enter, Mods::NONE), None);
    assert_eq!(e.text(), "- a");
    assert_eq!(k(&mut e, Key::Left, Mods::NONE), Some(Command::Move { dir: -1, unit: editor_core::HUnit::Char, extend: false }));
    assert_eq!(sel(&e), (2, 2));
    assert_eq!(k(&mut e, Key::PageDown, Mods::NONE), None, "PageUp/PageDown are the UI's");
}

// --- 12. triple-click + Tab (pinned to the TS)

#[test]
fn triple_click_then_tab_indents_the_next_line_too_like_ts() {
    let mut e = Editor::new("- a\n- b\n");
    click(&mut e, 3.0, 0, 1, false);
    click(&mut e, 3.0, 0, 2, false);
    click(&mut e, 3.0, 0, 3, false);
    assert_eq!(sel(&e), (0, 4));
    k(&mut e, Key::Tab, Mods::NONE);
    assert_eq!(e.text(), "\t- a\n\t- b\n");
}
