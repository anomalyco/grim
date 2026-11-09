//! Cmd-D: Delete Item (`rules::delete_item`).

use editor_core::keymap::{Command, resolve};
use editor_core::{Editor, Key, Mods, MonoLayout, Sel};

/// Cmd-D with the caret at the first `^` (removed from the text), or the selection between two (`^` marks: tables have pipes).
fn cmd_d(marked: &str) -> (Editor, String) {
    let bars: Vec<usize> = marked.match_indices('^').map(|(i, _)| i).collect();
    let text = marked.replace('^', "");
    let mut e = Editor::new(&text);
    let sel = match bars[..] {
        [p] => Sel::caret(p),
        [a, b] => Sel::new(a, b - 1),
        _ => panic!("one or two ^"),
    };
    e.set_selection(sel);
    let l = MonoLayout::new(&e);
    assert_eq!(e.key(Key::Char('d'), Mods::CMD, &l), Some(Command::DeleteItem));
    (e, text)
}

/// The text after Cmd-D, with `^` at the caret.
fn after(marked: &str) -> String {
    let (e, _) = cmd_d(marked);
    let s = e.selection();
    assert!(s.is_empty(), "a caret afterwards");
    let mut t = e.text().to_string();
    t.insert(s.head, '^');
    t
}

#[test]
fn bound_to_cmd_d_only() {
    assert_eq!(resolve(Key::Char('d'), Mods::CMD), Some(Command::DeleteItem));
    assert_eq!(resolve(Key::Char('d'), Mods::CTRL), Some(Command::DeleteForward));
    assert_ne!(resolve(Key::Char('d'), Mods::CMD_SHIFT), Some(Command::DeleteItem));
}

#[test]
fn paragraphs_middle_first_last() {
    assert_eq!(after("A one\nA two\n\nB one\nB t^wo\n\nC"), "A one\nA two\n\n^C");
    assert_eq!(after("A^ one\nA two\n\nB\n\nC"), "^B\n\nC");
    assert_eq!(after("A\n\nB one\nB two\n\nC^"), "A\n\n^B one\nB two");
    assert_eq!(after("on^ly"), "^");
    // no blank on one side: nothing else goes
    assert_eq!(after("# H\nPa^ra\n\nNext"), "# H\n\n^Next");
}

#[test]
fn list_item_with_its_sub_items_and_continuation() {
    assert_eq!(after("- a\n- ^b\ncontinued\n\t- b1\n\t\t- b1a\n\t- b2\n- c"), "- a\n- ^c");
    // on the continuation line: the same item
    assert_eq!(after("- a\n- b\ncon^tinued\n\t- b1\n- c"), "- a\n- ^c");
}

#[test]
fn nested_sub_item_only() {
    assert_eq!(after("- a\n- b\n\t- b^1\n\t\t- deeper\n\t- b2\n- c"), "- a\n- b\n\t- ^b2\n- c");
    // the last child: the previous sibling at its level
    assert_eq!(after("- a\n- b\n\t- b1\n\t- b^2\n- c"), "- a\n- b\n\t- ^b1\n- c");
    // an only child: the next item
    assert_eq!(after("- a\n- b\n\t- on^ly\n- c"), "- a\n- b\n- ^c");
    // space-indented
    assert_eq!(after("- a\n  - x^1\n  - x2\n- b"), "- a\n  - ^x2\n- b");
}

#[test]
fn last_item_of_a_list() {
    assert_eq!(after("Intro\n\n- a\n- b^\n\nAfter"), "Intro\n\n- ^a\n\nAfter");
    assert_eq!(after("- a\n- b\n- c^"), "- a\n- ^b");
    // the only item: one of the blank lines around it goes
    assert_eq!(after("Intro\n\n- on^ly\n\nAfter"), "Intro\n\n^After");
}

#[test]
fn ordered_lists_renumber() {
    assert_eq!(after("1. a\n2. ^b\n3. c\n4. d"), "1. a\n2. ^c\n3. d");
    assert_eq!(after("1. ^a\n2. b\n3. c"), "1. ^b\n2. c");
    // with sub-items (their own numbering left alone) and wide numbers
    assert_eq!(after("8. a\n9. ^b\n\t1. x\n\t2. y\n10. c\n\t1. z\n11. d"), "8. a\n9. ^c\n\t1. z\n10. d");
    // a nested numbered item: its siblings renumber, the parent list doesn't
    assert_eq!(after("1. a\n\t1. x\n\t2. ^y\n\t3. z\n2. b"), "1. a\n\t1. x\n\t2. ^z\n2. b");
    // numbering that didn't continue ("1." everywhere) is left as it is
    assert_eq!(after("1. a\n1. ^b\n1. c"), "1. a\n1. ^c");
    // a list after a blank line isn't the same list
    assert_eq!(after("1. a\n2. ^b\n\n3. c"), "1. ^a\n\n3. c");
}

#[test]
fn todos_like_list_items() {
    assert_eq!(after("- [ ] t1\n- [x] t^2\n\t- [ ] sub\n- [ ] t3"), "- [ ] t1\n- [ ] ^t3");
}

#[test]
fn heading_line_only() {
    assert_eq!(after("# Title\n\nText\n\n## S^ub\nUnder it\n\nMore"), "# Title\n\nText\n\n^Under it\n\nMore");
    assert_eq!(after("# Ti^tle\n\nText"), "^Text");
}

#[test]
fn quote_whole_block() {
    assert_eq!(after("Intro\n\n> q1\n> q^2\nlazy\n\nAfter"), "Intro\n\n^After");
    assert_eq!(after("Intro\n\n> q1\n> q2\nla^zy\n\nAfter"), "Intro\n\n^After");
}

#[test]
fn fenced_code_block_with_its_fences() {
    let doc = "Text\n\n```rust\nfn x() {}\n^\n```\n\nEnd";
    assert_eq!(after(doc), "Text\n\n^End");
    assert_eq!(after("Text\n\n``^`\ncode\n```\n\nEnd"), "Text\n\n^End");
    // unclosed: to the end
    assert_eq!(after("Text\n\n```\nco^de"), "^Text");
}

#[test]
fn table_row() {
    let t = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    assert_eq!(after(&t.replace("| 1 |", "| 1^ |")), "| a | b |\n| --- | --- |\n^| 3 | 4 |");
    // the header row: the whole table
    assert_eq!(after(&format!("Before\n\n{}\n\nAfter", t.replacen("| a", "| ^a", 1))), "Before\n\n^After");
}

#[test]
fn inline_tag_line_and_blank_lines() {
    assert_eq!(after("Ask <b>it</b> ^about it\n\nNext"), "^Next");
    assert_eq!(after("- see <b>it</b>^\n- b"), "- ^b");
    assert_eq!(after("A\n\n^\n\nB"), "A\n\n\n^B");
}

#[test]
fn a_selection_takes_every_item_it_touches() {
    assert_eq!(after("A\n\n- ^x\n- y\n\nB^ b\n\nC"), "A\n\n^C");
    assert_eq!(after("# ^H\n- a\n- b^\n\nP"), "^P");
    // a selection ending at a line's start doesn't take that line
    assert_eq!(after("- ^a\n^- b"), "- ^b");
}

#[test]
fn one_undo_step_and_redo() {
    let (mut e, before) = cmd_d("A\n\n- a\n- ^b\n\t- b1\n- c\n\nC");
    let gone = e.text().to_string();
    assert_eq!(gone, "A\n\n- a\n- c\n\nC");
    assert!(e.undo());
    assert_eq!(e.text(), before);
    // as after any deletion, undo selects what came back
    assert_eq!(e.selection(), Sel::new(7, 17));
    assert_eq!(&before[7..17], "- b\n\t- b1\n");
    assert!(e.redo());
    assert_eq!(e.text(), gone);
    // typing right before Cmd-D is a separate step
    let mut e = Editor::new("one\n\ntwo");
    e.set_selection(Sel::caret(9));
    e.insert_text("s");
    let l = MonoLayout::new(&e);
    e.key(Key::Char('d'), Mods::CMD, &l);
    assert_eq!(e.text(), "one");
    e.undo();
    assert_eq!(e.text(), "one\n\ntwos");
}

#[test]
fn read_only_does_nothing() {
    let mut e = Editor::new("A\n\nB");
    e.set_read_only(true);
    e.set_selection(Sel::caret(0));
    let l = MonoLayout::new(&e);
    e.key(Key::Char('d'), Mods::CMD, &l);
    assert_eq!(e.text(), "A\n\nB");
}
