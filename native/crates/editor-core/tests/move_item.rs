//! Cmd-Option-Up / Down: Move Item (`rules::move_item`).

use editor_core::keymap::{Command, resolve};
use editor_core::{Editor, Key, Mods, MonoLayout, Sel};

const CMD_ALT: Mods = Mods { cmd: true, alt: true, shift: false, ctrl: false };

/// An editor with the caret at the first `^` (removed from the text), or the selection between two.
fn editor(marked: &str) -> Editor {
    let bars: Vec<usize> = marked.match_indices('^').map(|(i, _)| i).collect();
    let mut e = Editor::new(&marked.replace('^', ""));
    e.set_selection(match bars[..] {
        [p] => Sel::caret(p),
        [a, b] => Sel::new(a, b - 1),
        _ => panic!("one or two ^"),
    });
    e
}

/// Press Cmd-Option-Up (`dir` -1) or Down.
fn press(e: &mut Editor, dir: i32) {
    let l = MonoLayout::new(e);
    let key = if dir < 0 { Key::Up } else { Key::Down };
    assert_eq!(e.key(key, CMD_ALT, &l), Some(Command::MoveItem { dir }));
}

/// The text with `^` at the caret, or around the selection.
fn marked(e: &Editor) -> String {
    let s = e.selection();
    let mut t = e.text().to_string();
    t.insert(s.to(), '^');
    if !s.is_empty() {
        t.insert(s.from(), '^');
    }
    t
}

fn up(m: &str) -> String {
    let mut e = editor(m);
    press(&mut e, -1);
    marked(&e)
}

fn down(m: &str) -> String {
    let mut e = editor(m);
    press(&mut e, 1);
    marked(&e)
}

#[test]
fn bound_to_cmd_option_arrows() {
    assert_eq!(resolve(Key::Up, CMD_ALT), Some(Command::MoveItem { dir: -1 }));
    assert_eq!(resolve(Key::Down, CMD_ALT), Some(Command::MoveItem { dir: 1 }));
    // Cmd-Up / Down and the Shift variants keep their document moves
    assert_ne!(resolve(Key::Up, Mods::CMD), Some(Command::MoveItem { dir: -1 }));
    assert!(matches!(resolve(Key::Up, Mods { shift: true, ..CMD_ALT }), Some(Command::Move { extend: true, .. })));
    assert!(matches!(resolve(Key::Down, Mods::CMD), Some(Command::Move { dir: 1, .. })));
}

#[test]
fn list_item_with_children_up_and_down() {
    let doc = "- a\n- b\n\t- b1\n\t\t- b1a\n- c^\n\t- c1\n- d";
    assert_eq!(up(doc), "- a\n- c^\n\t- c1\n- b\n\t- b1\n\t\t- b1a\n- d");
    assert_eq!(down("- a\n- b^\ncontinued\n\t- b1\n- c\n\t- c1\n- d"), "- a\n- c\n\t- c1\n- b^\ncontinued\n\t- b1\n- d");
    // on a continuation line or a sub-item's text: the sub-item is the item, the continuation is its item's
    assert_eq!(up("- a\n- b\ncon^tinued"), "- b\ncon^tinued\n- a");
}

#[test]
fn nested_child_moves_within_its_parent_only() {
    let doc = "- a\n\t- a1\n- b\n\t- b^1\n\t\t- deep\n\t- b2\n- c";
    assert_eq!(down(doc), "- a\n\t- a1\n- b\n\t- b2\n\t- b^1\n\t\t- deep\n- c");
    // the first child stays: it doesn't go into the previous parent
    assert_eq!(up(doc), doc);
    assert_eq!(up("- a\n\t- a1\n\t- a^2\n- b"), "- a\n\t- a^2\n\t- a1\n- b");
    // the last child stays
    assert_eq!(down("- a\n\t- a1\n\t- a^2\n- b"), "- a\n\t- a1\n\t- a^2\n- b");
}

#[test]
fn top_and_bottom_of_a_list_do_nothing() {
    assert_eq!(up("Intro\n\n- ^a\n- b"), "Intro\n\n- ^a\n- b");
    assert_eq!(up("Intro\n- ^a\n- b"), "Intro\n- ^a\n- b");
    assert_eq!(down("- a\n- ^b\n\nAfter"), "- a\n- ^b\n\nAfter");
    assert_eq!(down("- a\n- ^b\n\t- b1"), "- a\n- ^b\n\t- b1");
    assert_eq!(up("^- a"), "^- a");
    // a numbered list after a bullet list is another list
    assert_eq!(up("- a\n\n1. ^x"), "- a\n\n1. ^x");
    // a blank line on its own: nothing
    assert_eq!(up("A\n^\nB"), "A\n^\nB");
}

#[test]
fn loose_list_items_keep_the_blank_lines() {
    assert_eq!(up("- a\n\n- b^\n\n- c"), "- b^\n\n- a\n\n- c");
    assert_eq!(down("- a^\n\n- b"), "- b\n\n- a^");
}

#[test]
fn ordered_lists_are_renumbered() {
    assert_eq!(up("1. a\n2. b^\n3. c"), "1. b^\n2. a\n3. c");
    assert_eq!(down("1. a^\n\t- a1\n2. b\n3. c"), "1. b\n2. a^\n\t- a1\n3. c");
    // wider numbers: the caret stays on the text
    assert_eq!(up("9. a\n10. b^"), "9. b^\n10. a");
    assert_eq!(down("9. a^\n10. b"), "9. b\n10. a^");
    // nested numbering only
    assert_eq!(down("1. a\n\t1. x^\n\t2. y\n2. b"), "1. a\n\t1. y\n\t2. x^\n2. b");
    // not in sequence: left alone
    assert_eq!(up("1. a\n1. b^\n1. c"), "1. b^\n1. a\n1. c");
    assert_eq!(up("3. a\n7. b^"), "7. b^\n3. a");
}

#[test]
fn paragraphs_swap_keeping_blank_lines() {
    assert_eq!(up("A one\nA two\n\nB o^ne\nB two\n\nC"), "B o^ne\nB two\n\nA one\nA two\n\nC");
    assert_eq!(down("A^\n\n\nB\n\nC"), "B\n\n\nA^\n\nC");
    assert_eq!(up("^A\n\nB"), "^A\n\nB");
    assert_eq!(down("A\n\nB^"), "A\n\nB^");
    // a list is one block to a paragraph
    assert_eq!(down("Pa^ra\n\n- a\n\t- a1\n- b\n\nEnd"), "- a\n\t- a1\n- b\n\nPa^ra\n\nEnd");
    // right under a list it would join the last item: a blank line keeps it a paragraph
    assert_eq!(down("Intro^\n- a\n- b\n\nEnd"), "- a\n- b\n\nIntro^\n\nEnd");
}

#[test]
fn headings_swap_as_lines() {
    assert_eq!(up("Para\n\n## Hea^d\n\nText"), "## Hea^d\n\nPara\n\nText");
    assert_eq!(down("# T^itle\nText under\n\nNext"), "Text under\n# T^itle\n\nNext");
}

#[test]
fn code_blocks_swap_whole() {
    assert_eq!(up("Para\n\n```\nco^de\nmore\n```\n\nEnd"), "```\nco^de\nmore\n```\n\nPara\n\nEnd");
    assert_eq!(down("Pa^ra\n\n```rust\nlet x;\n```"), "```rust\nlet x;\n```\n\nPa^ra");
}

#[test]
fn quotes_swap_whole() {
    assert_eq!(up("Para\n\n> one\n> tw^o\nlazy\n\nEnd"), "> one\n> tw^o\nlazy\n\nPara\n\nEnd");
    assert_eq!(down("> q^\n\nPara"), "Para\n\n> q^");
}

#[test]
fn table_rows_and_tables() {
    let t = "| A | B |\n| - | - |\n| 1 | x |\n| 2 | y^ |\n| 3 | z |";
    assert_eq!(up(t), "| A | B |\n| - | - |\n| 2 | y^ |\n| 1 | x |\n| 3 | z |");
    assert_eq!(down(t), "| A | B |\n| - | - |\n| 1 | x |\n| 3 | z |\n| 2 | y^ |");
    // never above the header and delimiter rows, nor out of the table
    assert_eq!(up("| A |\n| - |\n| 1^ |\n| 2 |"), "| A |\n| - |\n| 1^ |\n| 2 |");
    assert_eq!(down("| A |\n| - |\n| 1 |\n| 2^ |\n\nPara"), "| A |\n| - |\n| 1 |\n| 2^ |\n\nPara");
    // the header: the whole table is the block
    assert_eq!(up("Para\n\n| A^ |\n| - |\n| 1 |"), "| A^ |\n| - |\n| 1 |\n\nPara");
}

#[test]
fn multi_item_selection_moves_as_a_unit() {
    // list items, with a sub-item, and renumbering
    assert_eq!(up("1. a\n2. ^b\n\t- b1\n3. c^\n4. d"), "1. ^b\n\t- b1\n2. c^\n3. a\n4. d");
    assert_eq!(down("- a\n- ^b\n- c^\n- d\n- e"), "- a\n- d\n- ^b\n- c^\n- e");
    // paragraphs with the blank lines between them
    assert_eq!(up("A\n\nB ^one\n\nC^ two\n\nD"), "B ^one\n\nC^ two\n\nA\n\nD");
    assert_eq!(down("A\n\n^B\n\nC\n^\nD"), "A\n\nD\n\n^B\n\nC^");
    // first one in the list: nothing
    assert_eq!(up("- ^a\n- b^\n- c"), "- ^a\n- b^\n- c");
}

#[test]
fn caret_and_selection_stay_on_the_moved_text() {
    assert_eq!(up("- one\n- tw^o thr^ee"), "- tw^o thr^ee\n- one");
    // a backwards selection stays backwards
    let mut e = Editor::new("A\n\nBBBB");
    e.set_selection(Sel::new(7, 4));
    press(&mut e, -1);
    assert_eq!(e.text(), "BBBB\n\nA");
    assert_eq!(e.selection(), Sel::new(4, 1));
    // whole lines selected (ending at the next line's start)
    let mut e = Editor::new("- a\n- b\n- c");
    e.set_selection(Sel::new(4, 8));
    press(&mut e, -1);
    assert_eq!(e.text(), "- b\n- a\n- c");
    assert_eq!(e.selection(), Sel::new(0, 4));
}

#[test]
fn each_move_is_one_undo_step() {
    let mut e = editor("- a\n- b\n- c^");
    press(&mut e, -1);
    press(&mut e, -1);
    assert_eq!(marked(&e), "- c^\n- a\n- b");
    e.undo();
    assert_eq!(marked(&e), "- a\n- c^\n- b");
    e.undo();
    assert_eq!(marked(&e), "- a\n- b\n- c^");
    e.redo();
    assert_eq!(e.text(), "- a\n- c\n- b");
    // a no-op adds no step
    let mut e = editor("- ^a\n- b");
    press(&mut e, -1);
    assert!(!e.can_undo());
}

#[test]
fn read_only_does_nothing() {
    let mut e = editor("A\n\nB^");
    e.set_read_only(true);
    let l = MonoLayout::new(&e);
    e.key(Key::Up, CMD_ALT, &l);
    e.move_item(-1);
    assert_eq!(marked(&e), "A\n\nB^");
}

