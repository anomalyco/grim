//! Collapsible heading sections: fold state is view state (the text never changes), mapped through
//! local and remote edits; the caret never sits in folded content.

use editor_core::{Editor, Key, Mods, MonoLayout, Sel, TextStore};

const DOC: &str = "# A\na1\n## B\nb1\n# C\nc1";
// lines: 0 "# A" 0..3 · 1 "a1" 4..6 · 2 "## B" 7..11 · 3 "b1" 12..14 · 4 "# C" 15..18 · 5 "c1" 19..21

fn k(e: &mut Editor, key: Key, m: Mods) {
    let l = MonoLayout::new(e);
    e.key(key, m, &l);
}

fn sel(e: &Editor) -> (usize, usize) {
    (e.selection().anchor, e.selection().head)
}

/// (foldable, folded, hidden) per line, as "f" / "F" / "h" / "-".
fn flags(e: &Editor) -> String {
    e.render_lines()
        .iter()
        .map(|v| match (v.hidden_by_fold, v.folded, v.foldable) {
            (true, _, _) => 'h',
            (_, true, _) => 'F',
            (_, _, true) => 'f',
            _ => '-',
        })
        .collect()
}

const CMD_ALT: Mods = Mods { cmd: true, alt: true, shift: false, ctrl: false };
const CMD_ALT_SHIFT: Mods = Mods { cmd: true, alt: true, shift: true, ctrl: false };

#[test]
fn sections_end_at_the_next_heading_of_the_same_or_a_higher_level() {
    let mut e = Editor::new(DOC);
    assert_eq!(flags(&e), "f-f-f-");
    assert!(e.toggle_fold(0));
    assert_eq!(flags(&e), "Fhhhf-");
    assert_eq!(e.text(), DOC);
    assert!(!e.can_undo(), "folding isn't an edit");
    assert!(e.toggle_fold(4));
    assert_eq!(flags(&e), "FhhhFh");
    // nested folds survive their parent's unfold
    let mut e = Editor::new(DOC);
    e.toggle_fold(2);
    e.toggle_fold(0);
    assert_eq!(flags(&e), "Fhhhf-");
    e.toggle_fold(0);
    assert_eq!(flags(&e), "f-Fhf-");
    // not foldable: a paragraph, a heading followed by one of the same level, the last line
    assert!(!e.toggle_fold(1));
    let mut e = Editor::new("# A\n# B\n## C");
    assert_eq!(flags(&e), "-f-");
    assert!(!e.toggle_fold(0) && !e.toggle_fold(2));
    // headings inside code blocks aren't headings
    let e = Editor::new("# A\n```\n# x\n```\n# B\nb");
    assert_eq!(flags(&e), "f---f-");
}

#[test]
fn folding_moves_a_hidden_caret_to_the_heading_end() {
    let mut e = Editor::new(DOC);
    e.set_selection(Sel::caret(13));
    e.toggle_fold(0);
    assert_eq!(sel(&e), (3, 3));
    // a selection end inside goes there too, the other stays
    let mut e = Editor::new(DOC);
    e.toggle_fold(4);
    e.toggle_fold(4);
    e.set_selection(Sel::new(5, 13));
    e.toggle_fold(2);
    assert_eq!(sel(&e), (5, 11));
}

#[test]
fn arrows_skip_folded_sections() {
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    e.set_selection(Sel::caret(3));
    k(&mut e, Key::Right, Mods::NONE);
    assert_eq!(sel(&e), (15, 15));
    k(&mut e, Key::Left, Mods::NONE);
    assert_eq!(sel(&e), (3, 3));
    k(&mut e, Key::Down, Mods::NONE);
    assert_eq!(e.doc().line_of(e.selection().head).index, 4);
    k(&mut e, Key::Up, Mods::NONE);
    assert_eq!(e.doc().line_of(e.selection().head).index, 0);
    // Option-Down / word moves land outside too
    e.set_selection(Sel::caret(3));
    k(&mut e, Key::Down, Mods::ALT);
    assert!(!e.is_hidden_line(e.doc().line_of(e.selection().head).index));
    e.set_selection(Sel::caret(3));
    k(&mut e, Key::Right, Mods::ALT);
    assert!(!e.is_hidden_line(e.doc().line_of(e.selection().head).index));
    // Shift-Right selects the hidden content with the newline
    e.set_selection(Sel::caret(3));
    k(&mut e, Key::Right, Mods::SHIFT);
    assert_eq!(sel(&e), (3, 15));
    assert_eq!(flags(&e), "Fhhhf-");
    // the last section folded: Down / Right / Cmd-Down stay on the heading line
    let mut e = Editor::new(DOC);
    e.toggle_fold(4);
    e.set_selection(Sel::caret(18));
    k(&mut e, Key::Right, Mods::NONE);
    assert_eq!(sel(&e), (18, 18));
    k(&mut e, Key::Down, Mods::NONE);
    assert_eq!(sel(&e), (18, 18));
    k(&mut e, Key::Down, Mods::CMD);
    assert_eq!(sel(&e), (18, 18));
    assert_eq!(flags(&e), "f-f-Fh");
    // Shift-Cmd-Down selects to the end, hidden text included
    e.set_selection(Sel::caret(0));
    k(&mut e, Key::Down, Mods::CMD_SHIFT);
    assert_eq!(sel(&e), (0, 21));
    assert_eq!(flags(&e), "f-f-Fh");
}

#[test]
fn typing_at_the_end_of_a_folded_heading_types_into_it() {
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    e.set_selection(Sel::caret(3));
    e.insert_text("x");
    assert_eq!(e.text(), "# Ax\na1\n## B\nb1\n# C\nc1");
    assert_eq!(flags(&e), "Fhhhf-");
    k(&mut e, Key::Backspace, Mods::NONE);
    assert_eq!(e.text(), DOC);
    assert_eq!(flags(&e), "Fhhhf-");
}

#[test]
fn enter_at_the_end_of_a_folded_heading_starts_a_heading_after_its_section() {
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    e.set_selection(Sel::caret(3));
    k(&mut e, Key::Enter, Mods::NONE);
    assert_eq!(e.text(), "# A\na1\n## B\nb1\n# \n# C\nc1");
    assert_eq!(sel(&e), (17, 17));
    assert_eq!(flags(&e), "Fhhh-f-");
    e.insert_text("New");
    assert_eq!(e.text(), "# A\na1\n## B\nb1\n# New\n# C\nc1");
    while e.text() != DOC && e.undo() {}
    assert_eq!(e.text(), DOC);
    assert_eq!(flags(&e), "Fhhhf-");
    // at the end of the document
    let mut e = Editor::new(DOC);
    e.toggle_fold(4);
    e.set_selection(Sel::caret(18));
    k(&mut e, Key::Enter, Mods::NONE);
    assert_eq!(e.text(), format!("{DOC}\n# "));
    assert_eq!(sel(&e), (24, 24));
    assert_eq!(flags(&e), "f-f-Fh-");
    // a nested heading: same level
    let mut e = Editor::new(DOC);
    e.toggle_fold(2);
    e.set_selection(Sel::caret(11));
    k(&mut e, Key::Enter, Mods::NONE);
    assert_eq!(e.text(), "# A\na1\n## B\nb1\n## \n# C\nc1");
    // not folded: a normal Enter
    let mut e = Editor::new(DOC);
    e.set_selection(Sel::caret(3));
    k(&mut e, Key::Enter, Mods::NONE);
    assert_eq!(e.text(), "# A\n\na1\n## B\nb1\n# C\nc1");
}

#[test]
fn deleting_a_selection_across_a_fold_deletes_the_hidden_text() {
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    e.set_selection(Sel::new(0, 15));
    k(&mut e, Key::Backspace, Mods::NONE);
    assert_eq!(e.text(), "# C\nc1");
    assert_eq!(flags(&e), "f-");
    e.undo();
    assert_eq!(e.text(), DOC);
    // cut / copy give the whole markdown
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    e.set_selection(Sel::new(2, 15));
    assert_eq!(e.copy().as_deref(), Some("A\na1\n## B\nb1\n"));
    assert_eq!(e.cut().as_deref(), Some("A\na1\n## B\nb1\n"));
    assert_eq!(e.text(), "# # C\nc1");
    // select all keeps the last section folded
    let mut e = Editor::new(DOC);
    e.toggle_fold(4);
    k(&mut e, Key::Char('a'), Mods::CMD);
    assert_eq!(sel(&e), (0, 21));
    assert_eq!(flags(&e), "f-f-Fh");
    assert_eq!(e.copy().as_deref(), Some(DOC));
}

#[test]
fn forward_delete_at_a_folded_heading_end_unfolds_it() {
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    e.set_selection(Sel::caret(3));
    k(&mut e, Key::Delete, Mods::NONE);
    assert_eq!(e.text(), "# Aa1\n## B\nb1\n# C\nc1");
    assert_eq!(flags(&e), "ff-f-");
}

#[test]
fn a_fold_goes_away_with_its_heading() {
    // Backspace at the heading's text start makes it a paragraph
    let mut e = Editor::new(DOC);
    e.toggle_fold(2);
    e.set_selection(Sel::caret(10));
    for _ in 0..4 {
        if e.doc().lines[2].ty != editor_core::BlockType::Heading {
            break;
        }
        k(&mut e, Key::Backspace, Mods::NONE);
    }
    assert_ne!(e.doc().lines[2].ty, editor_core::BlockType::Heading);
    assert!(e.folded_lines().is_empty());
    // deleting the heading line
    let mut e = Editor::new(DOC);
    e.toggle_fold(2);
    e.set_selection(Sel::new(7, 12));
    k(&mut e, Key::Backspace, Mods::NONE);
    assert_eq!(e.text(), "# A\na1\nb1\n# C\nc1");
    assert!(e.folded_lines().is_empty());
}

#[test]
fn remote_edits_map_folds() {
    let mut e = Editor::new(DOC);
    e.toggle_fold(2);
    e.set_selection(Sel::caret(5));
    // inside the fold: stays folded
    e.apply_remote(&[(13..13, "zz".into())]);
    assert_eq!(e.text(), "# A\na1\n## B\nbzz1\n# C\nc1");
    assert_eq!(flags(&e), "f-Fhf-");
    // before it: the fold moves with its heading
    e.apply_remote(&[(0..0, "x\n".into())]);
    assert_eq!(flags(&e), "-f-Fhf-");
    assert_eq!(sel(&e), (7, 7));
    // the heading line deleted: the fold is gone
    e.apply_remote(&[(9..14, String::new())]);
    assert_eq!(e.text(), "x\n# A\na1\nbzz1\n# C\nc1");
    assert!(e.folded_lines().is_empty());
    assert_eq!(e.store().text(), e.text());
}

#[test]
fn a_caret_moved_into_folded_text_unfolds_it() {
    // a remote edit that extends the section over the caret
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    e.set_selection(Sel::caret(20));
    e.apply_remote(&[(15..17, String::new())]);
    assert_eq!(e.text(), "# A\na1\n## B\nb1\nC\nc1");
    assert!(e.folded_lines().is_empty());
    // undo restoring the caret inside
    let mut e = Editor::new(DOC);
    e.set_selection(Sel::caret(14));
    e.insert_text("x");
    e.toggle_fold(0);
    assert_eq!(sel(&e), (3, 3));
    e.undo();
    assert_eq!(e.text(), DOC);
    assert_eq!(flags(&e), "f-f-f-");
    assert_eq!(e.doc().line_of(e.selection().head).index, 3);
    // a program's selection (find, a link target): only the folds around it open
    let mut e = Editor::new(DOC);
    e.toggle_fold(2);
    e.toggle_fold(0);
    e.toggle_fold(4);
    e.set_selection(Sel::caret(13));
    assert_eq!(flags(&e), "f-f-Fh");
    // a click can't land there (hidden lines take no space): row 1 is "# C" now
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    let l = MonoLayout::new(&e);
    e.mouse_down(&l, 15.0, 30.0, 1, false);
    assert_eq!(e.doc().line_of(e.selection().head).index, 4);
    assert_eq!(flags(&e), "Fhhhf-");
}

#[test]
fn triple_click_on_a_folded_heading_selects_its_section() {
    let mut e = Editor::new(DOC);
    e.toggle_fold(0);
    let l = MonoLayout::new(&e);
    e.mouse_down(&l, 15.0, 10.0, 1, false);
    e.mouse_down(&l, 15.0, 10.0, 2, false);
    e.mouse_down(&l, 15.0, 10.0, 3, false);
    assert_eq!(sel(&e), (0, 15));
    assert_eq!(flags(&e), "Fhhhf-");
}

#[test]
fn keyboard_shortcuts() {
    let mut e = Editor::new(DOC);
    // Cmd-' toggles the heading at the caret
    e.set_selection(Sel::caret(9));
    k(&mut e, Key::Char('\''), Mods::CMD);
    assert_eq!(flags(&e), "f-Fhf-");
    k(&mut e, Key::Char('\''), Mods::CMD);
    assert_eq!(flags(&e), "f-f-f-");
    // elsewhere it folds the section around the caret
    e.set_selection(Sel::caret(13));
    k(&mut e, Key::Char('\''), Mods::CMD);
    assert_eq!(flags(&e), "f-Fhf-");
    assert_eq!(sel(&e), (11, 11));
    // Cmd-Option-[ folds outwards, Cmd-Option-] unfolds
    k(&mut e, Key::Char('['), CMD_ALT);
    assert_eq!(flags(&e), "Fhhhf-");
    assert_eq!(sel(&e), (3, 3));
    k(&mut e, Key::Char(']'), CMD_ALT);
    assert_eq!(flags(&e), "f-Fhf-");
    // fold all / unfold all (Shift reports "[" or "{")
    k(&mut e, Key::Char('{'), CMD_ALT_SHIFT);
    assert_eq!(flags(&e), "FhhhFh");
    k(&mut e, Key::Char(']'), CMD_ALT_SHIFT);
    assert_eq!(flags(&e), "f-f-f-");
    k(&mut e, Key::Char('['), CMD_ALT_SHIFT);
    assert_eq!(flags(&e), "FhhhFh");
    k(&mut e, Key::Char('}'), CMD_ALT_SHIFT);
    assert_eq!(flags(&e), "f-f-f-");
    // read-only notes fold too
    e.set_read_only(true);
    e.set_selection(Sel::caret(1));
    k(&mut e, Key::Char('\''), Mods::CMD);
    assert_eq!(flags(&e), "Fhhhf-");
    assert_eq!(e.text(), DOC);
}

#[test]
fn fold_keys_survive_edits_elsewhere() {
    let mut e = Editor::new("# A\na\n# A\nb\n## B\nc");
    e.toggle_fold(2);
    e.toggle_fold(4);
    // the nested fold is kept too
    assert_eq!(e.folded_lines(), vec![2, 4]);
    let keys = e.fold_keys();
    assert_eq!(keys, vec![("# A".to_string(), 1), ("## B".to_string(), 0)]);
    let mut f = Editor::new("intro\n\n# A\na\nmore\n# A\nb\n## B\nc");
    f.set_fold_keys(&keys);
    assert_eq!(f.folded_lines(), vec![5, 7]);
    f.set_fold_keys(&[("## B".to_string(), 0), ("# nope".to_string(), 0)]);
    assert_eq!(f.folded_lines(), vec![7]);
}

#[test]
fn fold_changes_are_reported_as_line_changes() {
    let mut e = Editor::new(DOC);
    e.take_line_changes();
    e.toggle_fold(0);
    let c = e.take_line_changes().unwrap();
    assert_eq!((c.start, c.old_end, c.new_end), (0, 4, 4));
    e.set_selection(Sel::caret(1));
    assert!(e.take_line_changes().is_none());
    // a heading level change that grows the section
    e.apply_remote(&[(15..15, "#".into())]);
    let c = e.take_line_changes().unwrap();
    assert!(c.start <= 4 && c.new_end >= 6);
    assert_eq!(flags(&e), "Fhhhhh");
}
