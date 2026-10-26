//! Editor-level behaviour, ported from the TS browser suite (test/editor/browser/run.mjs) where it
//! doesn't depend on the DOM, plus Bear spec cases. Geometry comes from `MonoLayout` (10px
//! columns, 20px rows).

use editor_core::render::SegKind;
use editor_core::{BlockType, Editor, FormatType, Key, Mods, MonoLayout, Sel, TokenKind};

fn k(e: &mut Editor, key: Key, m: Mods) {
    let l = MonoLayout::new(e);
    e.key(key, m, &l);
}

fn typ(e: &mut Editor, s: &str) {
    for c in s.chars() {
        if c == '\n' {
            k(e, Key::Enter, Mods::NONE);
        } else {
            e.insert_text(&c.to_string());
        }
    }
}

fn caret(e: &mut Editor, p: usize) {
    e.set_selection(Sel::caret(p));
}

fn sel(e: &Editor) -> (usize, usize) {
    (e.selection().anchor, e.selection().head)
}

fn tokens(e: &Editor, kind: TokenKind) -> usize {
    e.render_lines().iter().flat_map(|l| &l.segments).filter(|s| s.token == Some(kind)).count()
}

fn revealed_markers(e: &Editor) -> usize {
    e.render_lines().iter().flat_map(|l| &l.segments).filter(|s| s.kind == SegKind::Marker && !s.hidden).count()
}

/// Mouse down at (column, line) in the MonoLayout grid.
fn click(e: &mut Editor, col: f64, line: usize, count: u32) {
    let l = MonoLayout::new(e);
    e.mouse_down(&l, col * 10.0, line as f64 * 20.0 + 10.0, count, false);
}

const UNDO: (Key, Mods) = (Key::Char('z'), Mods::CMD);
const REDO: (Key, Mods) = (Key::Char('z'), Mods::CMD_SHIFT);

fn undo(e: &mut Editor) {
    k(e, UNDO.0, UNDO.1);
}
fn redo(e: &mut Editor) {
    k(e, REDO.0, REDO.1);
}

fn line_at_head(e: &Editor) -> String {
    let t = e.text();
    let h = e.selection().head;
    let a = t[..h].rfind('\n').map_or(0, |i| i + 1);
    let b = t[h..].find('\n').map_or(t.len(), |i| h + i);
    t[a..b].to_string()
}

// --- typing & conversions

#[test]
fn typing_bold_reveal_list_continue_exit_and_undo() {
    let mut e = Editor::new("");
    typ(&mut e, "hello **world**");
    assert_eq!(e.text(), "hello **world**");
    assert_eq!(sel(&e), (15, 15));
    assert_eq!(revealed_markers(&e), 2);
    typ(&mut e, " x");
    assert_eq!(revealed_markers(&e), 0);
    typ(&mut e, "\n- a\nb\n\n");
    assert_eq!(e.text(), "hello **world** x\n- a\n- b\n");
    assert_eq!(tokens(&e, TokenKind::Bullet), 2);
    undo(&mut e);
    assert_eq!(e.text(), "hello **world** x\n- ");
}

#[test]
fn conversion_is_its_own_undo_step() {
    let mut e = Editor::new("");
    typ(&mut e, "ab\n- ");
    assert_eq!(tokens(&e, TokenKind::Bullet), 1);
    undo(&mut e);
    assert_eq!(e.text(), "ab\n- ");
    assert_eq!(sel(&e), (5, 5));
    assert_eq!(tokens(&e, TokenKind::Bullet), 0);
    assert_eq!(e.doc().lines[1].ty, BlockType::Paragraph);
    undo(&mut e);
    assert_eq!(e.text(), "");
    redo(&mut e);
    assert_eq!(e.text(), "ab\n- ");
    redo(&mut e);
    assert_eq!(tokens(&e, TokenKind::Bullet), 1);
}

#[test]
fn literal_state_ends_when_line_is_edited() {
    let mut e = Editor::new("x\n");
    caret(&mut e, 2);
    typ(&mut e, "- ");
    undo(&mut e);
    assert_eq!(tokens(&e, TokenKind::Bullet), 0);
    typ(&mut e, "y");
    assert_eq!(tokens(&e, TokenKind::Bullet), 1);
    assert_eq!(e.text(), "x\n- y");
}

#[test]
fn quote_undo_leaves_literal_gt() {
    let mut e = Editor::new("x\n");
    caret(&mut e, 2);
    typ(&mut e, ">");
    assert_eq!(tokens(&e, TokenKind::Quote), 1);
    undo(&mut e);
    assert_eq!(e.text(), "x\n>");
    assert_eq!(sel(&e), (3, 3));
}

#[test]
fn quote_swallows_the_next_space() {
    let mut e = Editor::new("x\n");
    caret(&mut e, 2);
    typ(&mut e, "> q");
    assert_eq!(e.text(), "x\n> q");
}

#[test]
fn literal_enter_keeps_it_and_todo_undo_keeps_bullet() {
    let mut e = Editor::new("x\n");
    caret(&mut e, 2);
    typ(&mut e, "- ");
    undo(&mut e);
    k(&mut e, Key::Enter, Mods::NONE);
    assert_eq!(tokens(&e, TokenKind::Bullet), 0);
    assert_eq!(e.text(), "x\n- \n");

    let mut e = Editor::new("x\n- ");
    caret(&mut e, 4);
    typ(&mut e, "[ ] ");
    assert_eq!(tokens(&e, TokenKind::Todo), 1);
    undo(&mut e);
    assert_eq!((tokens(&e, TokenKind::Todo), tokens(&e, TokenKind::Bullet)), (0, 1));
    assert_eq!(sel(&e), (8, 8));
    redo(&mut e);
    assert_eq!(tokens(&e, TokenKind::Todo), 1);
}

#[test]
fn multiline_paragraph_element_restyles_other_line() {
    let mut e = Editor::new("**hello\nworld");
    caret(&mut e, 13);
    typ(&mut e, "**");
    let bold0 = |e: &Editor| e.render_lines()[0].segments.iter().any(|s| s.kind == SegKind::Text && s.styles.contains(&editor_core::InlineType::Bold));
    assert!(bold0(&e));
    k(&mut e, Key::Backspace, Mods::NONE);
    k(&mut e, Key::Backspace, Mods::NONE);
    assert!(!bold0(&e));
    assert!(!e.render_lines()[0].segments.iter().any(|s| s.kind == SegKind::Marker));
    assert_eq!(&e.text()[..7], "**hello");
}

// --- mouse

#[test]
fn double_and_triple_click() {
    let mut e = Editor::new("plain **bold** text\n- item two\nlast");
    // line 0 collapsed: "plain " cols 0-5, "bold" 6-9
    click(&mut e, 7.5, 0, 1);
    click(&mut e, 7.5, 0, 2);
    assert_eq!(sel(&e), (8, 12));
    click(&mut e, 3.0, 1, 1);
    click(&mut e, 3.0, 1, 2);
    click(&mut e, 3.0, 1, 3);
    assert_eq!(sel(&e), (20, 31));
}

#[test]
fn click_past_line_end_goes_after_hidden_closing_markers() {
    let mut e = Editor::new("a **bold**\nnext");
    click(&mut e, 20.0, 0, 1);
    assert_eq!(sel(&e), (10, 10));
    caret(&mut e, 8);
    click(&mut e, 20.0, 0, 1);
    assert_eq!(sel(&e), (10, 10));
}

#[test]
fn click_right_half_of_last_bold_letter_lands_before_closing_markers() {
    let mut e = Editor::new("plain **bold** text\nsecond line here");
    caret(&mut e, 22);
    click(&mut e, 9.7, 0, 1);
    assert_eq!(sel(&e), (12, 12));
    // left half of the following space: after the markers
    caret(&mut e, 22);
    click(&mut e, 10.2, 0, 1);
    assert_eq!(sel(&e), (14, 14));
}

#[test]
fn todo_click_toggles() {
    let mut e = Editor::new("- [ ] task\nother");
    e.toggle_todo(0);
    assert_eq!(e.text(), "- [x] task\nother");
    assert_eq!(sel(&e), (6, 6));
    e.toggle_todo(0);
    assert_eq!(e.text(), "- [ ] task\nother");
}

// --- arrows

#[test]
fn arrow_up_from_below_code_block_enters_closing_fence() {
    let mut e = Editor::new("```\ncode\n```\nafter");
    caret(&mut e, 16);
    k(&mut e, Key::Up, Mods::NONE);
    let h = e.selection().head;
    assert!((9..=12).contains(&h), "{h}");
}

#[test]
fn space_indented_lists() {
    let mut e = Editor::new("- a\n  - b\n    - c\n  plain");
    let v = e.render_lines();
    let kinds: Vec<_> = v.iter().map(|l| (l.kind, l.segments.iter().filter(|s| s.token == Some(TokenKind::Indent)).count())).collect();
    assert_eq!(kinds, vec![(BlockType::Bullet, 0), (BlockType::Bullet, 1), (BlockType::Bullet, 2), (BlockType::Paragraph, 0)]);
    caret(&mut e, 10);
    k(&mut e, Key::Right, Mods::CMD);
    k(&mut e, Key::Left, Mods::CMD);
    k(&mut e, Key::Left, Mods::CMD);
    assert_eq!(sel(&e), (10, 10));
    k(&mut e, Key::Right, Mods::NONE);
    assert_eq!(sel(&e), (12, 12));
    caret(&mut e, 16);
    k(&mut e, Key::Tab, Mods::SHIFT);
    assert_eq!(e.text(), "- a\n  - b\n  - c\n  plain");
}

#[test]
fn hr_single_caret_stop() {
    let mut e = Editor::new("a\n---\nb");
    caret(&mut e, 1);
    k(&mut e, Key::Right, Mods::NONE);
    assert_eq!(sel(&e), (5, 5));
    k(&mut e, Key::Right, Mods::NONE);
    assert_eq!(sel(&e), (6, 6));
    k(&mut e, Key::Left, Mods::NONE);
    k(&mut e, Key::Left, Mods::NONE);
    assert_eq!(sel(&e), (1, 1));
    caret(&mut e, 5);
    k(&mut e, Key::Backspace, Mods::NONE);
    assert_eq!(e.text(), "a\n\nb");
    let mut e = Editor::new("---\nb");
    caret(&mut e, 3);
    k(&mut e, Key::Backspace, Mods::NONE);
    assert_eq!(e.text(), "\nb");
}

#[test]
fn arrows_over_tokens_and_two_stage_cmd_left() {
    let mut e = Editor::new("ab\n- item\n\t- nested");
    caret(&mut e, 5);
    k(&mut e, Key::Left, Mods::NONE);
    assert_eq!(sel(&e), (3, 3));
    k(&mut e, Key::Left, Mods::NONE);
    assert_eq!(sel(&e), (2, 2));
    k(&mut e, Key::Right, Mods::NONE);
    k(&mut e, Key::Right, Mods::NONE);
    assert_eq!(sel(&e), (5, 5));
    k(&mut e, Key::Backspace, Mods::NONE);
    assert_eq!(e.text(), "ab\nitem\n\t- nested");
    caret(&mut e, 13);
    k(&mut e, Key::Left, Mods::CMD);
    assert_eq!(sel(&e), (11, 11));
    k(&mut e, Key::Left, Mods::CMD);
    assert_eq!(sel(&e), (8, 8));
}

#[test]
fn up_down_keeps_goal_x() {
    let mut e = Editor::new("first line of text\nsh\nthird line of text");
    caret(&mut e, 10);
    k(&mut e, Key::Down, Mods::NONE);
    assert_eq!(sel(&e), (21, 21));
    k(&mut e, Key::Down, Mods::NONE);
    assert_eq!(sel(&e), (32, 32));
    k(&mut e, Key::Up, Mods::NONE);
    k(&mut e, Key::Up, Mods::NONE);
    assert_eq!(sel(&e), (10, 10));
}

#[test]
fn up_from_heading_lines() {
    let mut e = Editor::new("## Head text\n\nafter\n");
    caret(&mut e, 3);
    k(&mut e, Key::Enter, Mods::NONE);
    k(&mut e, Key::Up, Mods::NONE);
    assert_eq!(sel(&e), (0, 0));
    let mut e = Editor::new("x\n- item a\n- item b\n# Head");
    caret(&mut e, 25);
    k(&mut e, Key::Up, Mods::NONE);
    let h = e.selection().head;
    assert!(h > 13 && h <= 19, "{h}");
    k(&mut e, Key::Up, Mods::NONE);
    let h = e.selection().head;
    assert!(h > 4 && h <= 10, "{h}");
}

#[test]
fn up_down_symmetric_through_mixed_content() {
    let mut e = Editor::new("# Big heading here\n- bullet item text\n```\ncode line here\n```\nplain paragraph");
    caret(&mut e, 8);
    for _ in 0..4 {
        k(&mut e, Key::Down, Mods::NONE);
    }
    for _ in 0..4 {
        k(&mut e, Key::Up, Mods::NONE);
    }
    assert_eq!(sel(&e), (8, 8));
}

#[test]
fn up_then_down_near_formatting_is_asymmetric() {
    // Bear 1.6: caret at c12 inside **bold** (revealed), Up then Down lands at c14, because the
    // target line is hit-tested collapsed
    let mut e = Editor::new("xxxxxxxxxxxxxxxxxxxxxxxx\naaaaaaaaa **bold** tail");
    caret(&mut e, 25 + 12);
    k(&mut e, Key::Up, Mods::NONE);
    assert_eq!(sel(&e), (12, 12));
    k(&mut e, Key::Down, Mods::NONE);
    assert_eq!(sel(&e), (25 + 14, 25 + 14));
    // away from formatting it is symmetric
    caret(&mut e, 25 + 5);
    k(&mut e, Key::Up, Mods::NONE);
    k(&mut e, Key::Down, Mods::NONE);
    assert_eq!(sel(&e), (30, 30));
}

#[test]
fn shift_arrow_selection_and_typing_over() {
    let mut e = Editor::new("abc def");
    caret(&mut e, 4);
    k(&mut e, Key::Right, Mods::SHIFT);
    k(&mut e, Key::Right, Mods::SHIFT);
    assert_eq!(sel(&e), (4, 6));
    typ(&mut e, "Z");
    assert_eq!(e.text(), "abc Zf");
}

#[test]
fn option_right_word_jumps() {
    let mut e = Editor::new("Alpha **bold words**");
    caret(&mut e, 0);
    k(&mut e, Key::Right, Mods::ALT);
    k(&mut e, Key::Right, Mods::ALT);
    assert_eq!(sel(&e), (12, 12));
}

#[test]
fn left_with_selection_collapses_to_start() {
    let mut e = Editor::new("abc def");
    e.set_selection(Sel::new(2, 5));
    k(&mut e, Key::Left, Mods::NONE);
    assert_eq!(sel(&e), (2, 2));
}

// --- editing commands

#[test]
fn cmd_b_wraps_word() {
    let mut e = Editor::new("hello world");
    caret(&mut e, 2);
    k(&mut e, Key::Char('b'), Mods::CMD);
    assert_eq!(e.text(), "**hello** world");
    assert_eq!(sel(&e), (4, 4));
    e.toggle_format(FormatType::Strike);
    assert_eq!(e.text(), "**~~hello~~** world");
}

#[test]
fn tab_nests_and_shift_tab() {
    let mut e = Editor::new("- a\n- b");
    caret(&mut e, 6);
    k(&mut e, Key::Tab, Mods::NONE);
    assert_eq!(e.text(), "- a\n\t- b");
    k(&mut e, Key::Tab, Mods::SHIFT);
    assert_eq!(e.text(), "- a\n- b");
}

#[test]
fn paste_markdown_blocks() {
    let mut e = Editor::new("x");
    caret(&mut e, 1);
    e.paste("\n# Head\n- item");
    assert_eq!(e.text(), "x\n# Head\n- item");
    assert_eq!(e.render_lines().iter().map(|l| l.kind).collect::<Vec<_>>(), vec![BlockType::Paragraph, BlockType::Heading, BlockType::Bullet]);
}

#[test]
fn code_block_enter_auto_closes_and_reveals() {
    let mut e = Editor::new("");
    typ(&mut e, "```\n  code\nx");
    assert_eq!(e.text(), "```\n  code\nx\n```");
    assert!(e.render_lines()[0].revealed);
}

#[test]
fn read_only_blocks_edits() {
    let mut e = Editor::new("abc");
    e.set_read_only(true);
    typ(&mut e, "zz\n");
    assert_eq!(e.text(), "abc");
}

#[test]
fn composition() {
    let mut e = Editor::new("ab");
    caret(&mut e, 2);
    e.begin_composition();
    e.end_composition("你");
    assert_eq!(e.text(), "ab你");
    typ(&mut e, "c");
    assert_eq!(e.text(), "ab你c");
}

#[test]
fn caret_at_tricky_spots() {
    let mut e = Editor::new("ab\n- item\n- ");
    caret(&mut e, 12);
    typ(&mut e, "z");
    assert_eq!(e.text(), "ab\n- item\n- z");
    caret(&mut e, 5);
    k(&mut e, Key::Enter, Mods::NONE);
    assert_eq!(e.text(), "ab\n- \n- item\n- z");
    assert_eq!(sel(&e), (8, 8));
}

#[test]
fn copy_gives_raw_markdown_and_select_all_delete() {
    let mut e = Editor::new("- a **b**");
    e.set_selection(Sel::new(0, 9));
    assert_eq!(e.copy().as_deref(), Some("- a **b**"));
    let mut e = Editor::new("# a\n- b\nc **d**");
    k(&mut e, Key::Char('a'), Mods::CMD);
    assert_eq!(sel(&e), (0, 15));
    k(&mut e, Key::Backspace, Mods::NONE);
    assert_eq!(e.text(), "");
    typ(&mut e, "ok");
    assert_eq!(e.text(), "ok");
}

#[test]
fn cut_is_its_own_undo_step() {
    let mut e = Editor::new("hello world");
    caret(&mut e, 11);
    typ(&mut e, "!");
    e.set_selection(Sel::new(0, 6));
    assert_eq!(e.cut().as_deref(), Some("hello "));
    assert_eq!(e.text(), "world!");
    undo(&mut e);
    assert_eq!(e.text(), "hello world!");
    undo(&mut e);
    assert_eq!(e.text(), "hello world");
}

// --- undo grouping

#[test]
fn undo_of_deletion_selects_restored_text() {
    let mut e = Editor::new("first line here\n");
    caret(&mut e, 15);
    typ(&mut e, "ab");
    for _ in 0..3 {
        k(&mut e, Key::Backspace, Mods::NONE);
    }
    undo(&mut e);
    assert_eq!(e.text(), "first line here\n");
    assert_eq!(sel(&e), (14, 15));
    redo(&mut e);
    assert_eq!(e.text(), "first line her\n");
}

#[test]
fn undo_restores_selection() {
    let mut e = Editor::new("hello world");
    caret(&mut e, 5);
    typ(&mut e, "XX");
    caret(&mut e, 0);
    undo(&mut e);
    assert_eq!(e.text(), "hello world");
    assert_eq!(sel(&e), (5, 5));
    redo(&mut e);
    assert_eq!(sel(&e), (7, 7));
}

#[test]
fn undo_coalesces_typing_enter_backspace() {
    // Bear 1.7: "xy", Enter, "zw" is one step; so is "ab" + 3 Backspaces
    let mut e = Editor::new("");
    typ(&mut e, "xy\nzw");
    undo(&mut e);
    assert_eq!(e.text(), "");
    let mut e = Editor::new("q");
    caret(&mut e, 1);
    typ(&mut e, "ab");
    for _ in 0..3 {
        k(&mut e, Key::Backspace, Mods::NONE);
    }
    assert_eq!(e.text(), "");
    undo(&mut e);
    assert_eq!(e.text(), "q");
}

#[test]
fn arrows_returning_to_same_spot_dont_split_but_jumps_do() {
    let mut e = Editor::new("");
    typ(&mut e, "ab");
    k(&mut e, Key::Left, Mods::NONE);
    k(&mut e, Key::Right, Mods::NONE);
    typ(&mut e, "c");
    undo(&mut e);
    assert_eq!(e.text(), "");
    let mut e = Editor::new("");
    typ(&mut e, "ab");
    k(&mut e, Key::Left, Mods::NONE);
    typ(&mut e, "c");
    undo(&mut e);
    assert_eq!(e.text(), "ab");
}

#[test]
fn paste_is_its_own_undo_step() {
    let mut e = Editor::new("");
    typ(&mut e, "ab");
    e.paste("XY");
    typ(&mut e, "c");
    undo(&mut e);
    assert_eq!(e.text(), "abXY");
    undo(&mut e);
    assert_eq!(e.text(), "ab");
    undo(&mut e);
    assert_eq!(e.text(), "");
}

// --- tables

#[test]
fn tables_collapsed_reveal_typing_tab_enter_exit_and_arrows() {
    let doc = "before\n\n| Name | Qty |\n|:-----|----:|\n| **apple** | 3 |\n| pear | 12 |\n\nafter";
    let mut e = Editor::new(doc);
    caret(&mut e, 0);
    let v = e.render_lines();
    assert!(v[2..6].iter().all(|l| !l.revealed));
    assert!(v[3].collapsed);
    assert!(v[2].segments.iter().filter(|s| s.kind == SegKind::Pipe).all(|s| s.hidden));
    assert_eq!(v[4].table.as_ref().unwrap().align, vec![Some(editor_core::CellAlign::Left), Some(editor_core::CellAlign::Right)]);
    // click in a collapsed cell's padding lands in that cell's text ("pear" 0-3, gap, "12" 5-6)
    click(&mut e, 5.1, 5, 1);
    let i12 = doc.find("12").unwrap();
    let h = e.selection().head;
    assert!(h >= i12 && h <= i12 + 2, "{h}");
    // caret in the table reveals all its lines
    let in_cell = doc.find("pear").unwrap() + 2;
    caret(&mut e, in_cell);
    assert_eq!(e.render_lines()[2..6].iter().filter(|l| l.revealed).count(), 4);
    typ(&mut e, "s");
    let doc2 = doc.replace("pear", "pesar");
    assert_eq!(e.text(), doc2);
    k(&mut e, Key::Tab, Mods::NONE);
    assert_eq!(sel(&e), (i12 + 1, i12 + 1));
    k(&mut e, Key::Tab, Mods::SHIFT);
    k(&mut e, Key::Tab, Mods::SHIFT);
    let h = e.selection().head;
    assert_eq!(&e.text()[h..h + 1], "3");
    caret(&mut e, doc.find("| 12 |").unwrap() + 7);
    k(&mut e, Key::Enter, Mods::NONE);
    assert_eq!(e.text(), doc2.replace("| 12 |", "| 12 |\n| | |"));
    typ(&mut e, "kiwi");
    k(&mut e, Key::Tab, Mods::NONE);
    typ(&mut e, "7");
    assert_eq!(e.text(), doc2.replace("| 12 |", "| 12 |\n| kiwi| 7|"));
    assert_eq!(e.doc().lines.iter().filter(|l| l.ty == BlockType::TableRow).count(), 3);
    k(&mut e, Key::Enter, Mods::NONE);
    k(&mut e, Key::Enter, Mods::NONE);
    assert_eq!(e.doc().lines.iter().filter(|l| l.table.is_some()).count(), 5);
    assert!(e.text().contains("| kiwi| 7|\n\n\nafter"));
    // Up/Down: from above into the table and through it
    caret(&mut e, 0);
    k(&mut e, Key::Down, Mods::NONE);
    k(&mut e, Key::Down, Mods::NONE);
    assert!(line_at_head(&e).starts_with("| Name"), "{}", line_at_head(&e));
    k(&mut e, Key::Down, Mods::NONE);
    k(&mut e, Key::Down, Mods::NONE);
    assert!(line_at_head(&e).starts_with("| **apple**"), "{}", line_at_head(&e));
}

#[test]
fn table_row_insertion_is_its_own_undo_step() {
    let doc = "| a | b |\n|---|---|\n| 1 | 2 |";
    let mut e = Editor::new(doc);
    caret(&mut e, doc.len() - 2);
    typ(&mut e, "x");
    k(&mut e, Key::Enter, Mods::NONE);
    typ(&mut e, "y");
    undo(&mut e);
    assert_eq!(e.text(), format!("{}\n| | |", doc.replace("2 |", "2x |")));
    undo(&mut e);
    assert_eq!(e.text(), doc.replace("2 |", "2x |"));
    undo(&mut e);
    assert_eq!(e.text(), doc);
}

#[test]
fn table_clicks_past_cell_text_and_right_of_table() {
    let d2 = "x\n\n| **bold** | b |\n|---|---|\n| 1 | 2 |";
    let mut e = Editor::new(d2);
    caret(&mut e, 0);
    // in the padding after "bold" (cols 0-3, gap at 4)
    click(&mut e, 4.5, 2, 1);
    let want = d2.find("** |").unwrap() + 2;
    assert_eq!(sel(&e), (want, want));
    caret(&mut e, 0);
    click(&mut e, 60.0, 4, 1);
    assert_eq!(sel(&e), (d2.len() - 2, d2.len() - 2));
}

#[test]
fn up_into_header_only_table_lands_on_header() {
    let d = "| h1 | h2 |\n|---|---|\n\nbelow";
    let mut e = Editor::new(d);
    caret(&mut e, d.len());
    k(&mut e, Key::Up, Mods::NONE);
    k(&mut e, Key::Up, Mods::NONE);
    assert_eq!(line_at_head(&e), "| h1 | h2 |");
}

#[test]
fn typing_a_table_line_by_line() {
    let mut e = Editor::new("");
    typ(&mut e, "| a | b |\n|---|");
    assert_eq!(e.doc().lines.iter().filter(|l| l.table.is_some()).count(), 0);
    typ(&mut e, "---|");
    assert_eq!(e.doc().lines.iter().filter(|l| l.table.is_some()).count(), 2);
    typ(&mut e, "\nx");
    assert_eq!(e.text(), "| a | b |\n|---|---|\n| x| |");
}

// --- misc API

#[test]
fn keymap_resolution() {
    use editor_core::keymap::resolve;
    use editor_core::{Command, HUnit};
    assert_eq!(resolve(Key::Char('Z'), Mods::CMD_SHIFT), Some(Command::Redo));
    assert_eq!(resolve(Key::Left, Mods::ALT_SHIFT), Some(Command::Move { dir: -1, unit: HUnit::Word, extend: true }));
    assert_eq!(resolve(Key::Left, Mods::CTRL), None);
    assert_eq!(resolve(Key::Home, Mods::NONE), Some(Command::ScrollToStart));
    assert_eq!(resolve(Key::Backspace, Mods::CMD), Some(Command::DeleteToLineStart));
    assert_eq!(resolve(Key::Enter, Mods::SHIFT), Some(Command::InsertLineBreak));
    assert_eq!(resolve(Key::Tab, Mods::CMD), None);
    assert_eq!(resolve(Key::Char('x'), Mods::NONE), None);
}

#[test]
fn utf16_conversion() {
    use editor_core::text::{byte_to_utf16, utf16_to_byte};
    let s = "aé😀b";
    assert_eq!(byte_to_utf16(s, 3), 2);
    assert_eq!(byte_to_utf16(s, 7), 4);
    assert_eq!(utf16_to_byte(s, 4), 7);
    assert_eq!(utf16_to_byte(s, 5), 8);
}

#[test]
fn set_text_keeps_caret() {
    let mut e = Editor::new("hello world");
    caret(&mut e, 6);
    e.set_text("XYZ hello world");
    assert_eq!(sel(&e), (10, 10));
    typ(&mut e, "!");
    assert_eq!(e.text(), "XYZ hello !world");
}

#[test]
fn typing_in_a_big_doc() {
    let big: Vec<String> = (0..3000).map(|i| if i % 5 == 0 { format!("- item **{i}** text") } else { format!("line {i} with *some* text") }).collect();
    let big = big.join("\n");
    let mut e = Editor::new(&big);
    caret(&mut e, 10);
    let t0 = std::time::Instant::now();
    for c in "abcdefghij".chars() {
        e.insert_text(&c.to_string());
        let _ = e.render_lines();
    }
    eprintln!("10 keystrokes (+render_lines) in a 3000-line doc: {:?}", t0.elapsed());
    assert_eq!(&e.text()[..25], format!("{}abcdefghij{}", &big[..10], &big[10..15]));
}
