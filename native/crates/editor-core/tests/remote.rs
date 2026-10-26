//! Remote edits (`Editor::apply_remote`): not undoable, the selection and history mapped through
//! them, undo reverting only local changes (like Y.UndoManager), and the `TextStore` mirror.

use editor_core::{BlockType, Editor, Key, Mods, MonoLayout, Sel, StringStore, TextStore, TokenKind};

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

fn sel(e: &Editor) -> (usize, usize) {
    (e.selection().anchor, e.selection().head)
}

fn remote(e: &mut Editor, from: usize, to: usize, s: &str) {
    e.apply_remote(&[(from..to, s.to_string())]);
    assert_eq!(e.store().text(), e.text());
}

fn undo(e: &mut Editor) -> bool {
    let r = e.undo();
    assert_eq!(e.store().text(), e.text());
    r
}

fn redo(e: &mut Editor) -> bool {
    let r = e.redo();
    assert_eq!(e.store().text(), e.text());
    r
}

#[test]
fn remote_inserts_move_the_caret_before_and_not_after_or_at_it() {
    let mut e = Editor::new("hello world");
    e.set_selection(Sel::caret(6));
    remote(&mut e, 0, 0, "XX");
    assert_eq!((e.text(), sel(&e)), ("XXhello world", (8, 8)));
    remote(&mut e, 10, 10, "YY");
    assert_eq!((e.text(), sel(&e)), ("XXhello woYYrld", (8, 8)));
    // at the caret: the caret stays before the inserted text
    remote(&mut e, 8, 8, "Z");
    assert_eq!((e.text(), sel(&e)), ("XXhello ZwoYYrld", (8, 8)));
    assert!(!e.can_undo());
}

#[test]
fn remote_insert_inside_the_selection_grows_it() {
    let mut e = Editor::new("hello world");
    e.set_selection(Sel::new(2, 8));
    remote(&mut e, 4, 4, "abc");
    assert_eq!(sel(&e), (2, 11));
    // at its edges: outside the selection
    remote(&mut e, 2, 2, "<");
    remote(&mut e, 12, 12, ">");
    assert_eq!(e.text(), "he<llabco wo>rld");
    assert_eq!(sel(&e), (3, 12));
    e.set_selection(Sel::new(12, 3));
    remote(&mut e, 5, 5, "!");
    assert_eq!(sel(&e), (13, 3));
}

#[test]
fn remote_delete_spanning_the_selection_collapses_it() {
    let mut e = Editor::new("hello world");
    e.set_selection(Sel::new(3, 6));
    remote(&mut e, 1, 8, "");
    assert_eq!((e.text(), sel(&e)), ("hrld", (1, 1)));
    // partly overlapping
    e.set_selection(Sel::new(1, 4));
    remote(&mut e, 3, 5, "");
    assert_eq!((e.text(), sel(&e)), ("hrl", (1, 3)));
}

#[test]
fn edits_apply_in_order_and_ranges_are_clamped() {
    let mut e = Editor::new("abc");
    e.set_selection(Sel::caret(3));
    e.apply_remote(&[(0..0, "1".into()), (1..1, "2".into()), (2..3, "".into()), (40..50, "!".into())]);
    assert_eq!(e.text(), "12bc!");
    assert_eq!(sel(&e), (4, 4));
    // inside a multi-byte char: floored to its start
    let mut e = Editor::new("é");
    e.apply_remote(&[(1..1, "x".into())]);
    assert_eq!(e.text(), "xé");
}

#[test]
fn undo_after_a_remote_edit_before_the_local_one() {
    let mut e = Editor::new("hello");
    e.set_selection(Sel::caret(5));
    typ(&mut e, "abc");
    remote(&mut e, 0, 0, "XY");
    assert_eq!(e.text(), "XYhelloabc");
    assert!(undo(&mut e));
    assert_eq!(e.text(), "XYhello");
    assert_eq!(sel(&e), (7, 7));
    assert!(redo(&mut e));
    assert_eq!(e.text(), "XYhelloabc");
    assert_eq!(sel(&e), (10, 10));
    // a remote edit between undo and redo
    assert!(undo(&mut e));
    remote(&mut e, 2, 2, "__");
    assert!(redo(&mut e));
    assert_eq!(e.text(), "XY__helloabc");
}

#[test]
fn undo_never_reverts_remote_text_inside_local_text() {
    let mut e = Editor::new("");
    typ(&mut e, "hello");
    remote(&mut e, 2, 2, "X");
    assert_eq!(e.text(), "heXllo");
    undo(&mut e);
    assert_eq!(e.text(), "X");
    redo(&mut e);
    assert_eq!(e.text(), "heXllo");
}

#[test]
fn remote_delete_of_local_text_isnt_restored_or_deleted_twice() {
    let mut e = Editor::new("start ");
    e.set_selection(Sel::caret(6));
    typ(&mut e, "abc");
    remote(&mut e, 7, 8, "");
    assert_eq!(e.text(), "start ac");
    undo(&mut e);
    assert_eq!(e.text(), "start ");
    redo(&mut e);
    assert_eq!(e.text(), "start ac");
}

#[test]
fn undo_reinserts_deleted_text_next_to_remote_edits() {
    // a remote insert where the local deletion was: the restored text goes before it
    let mut e = Editor::new("one two three");
    e.set_selection(Sel::new(4, 8));
    k(&mut e, Key::Backspace, Mods::NONE);
    assert_eq!(e.text(), "one three");
    remote(&mut e, 4, 4, "Z");
    undo(&mut e);
    assert_eq!(e.text(), "one two Zthree");
    assert_eq!(sel(&e), (4, 8));
    // a remote delete right after it
    let mut e = Editor::new("one two three");
    e.set_selection(Sel::new(4, 8));
    k(&mut e, Key::Backspace, Mods::NONE);
    remote(&mut e, 4, 7, "");
    assert_eq!(e.text(), "one ee");
    undo(&mut e);
    assert_eq!(e.text(), "one two ee");
    // a remote replacement of text around the deletion point
    let mut e = Editor::new("one two three");
    e.set_selection(Sel::new(4, 8));
    k(&mut e, Key::Backspace, Mods::NONE);
    remote(&mut e, 2, 6, "NE TH");
    assert_eq!(e.text(), "onNE THree");
    undo(&mut e);
    assert_eq!(e.text(), "onNE THtwo ree");
}

#[test]
fn older_undo_steps_are_rebased_too() {
    let mut e = Editor::new("aaa bbb");
    e.set_selection(Sel::caret(3));
    typ(&mut e, "1");
    e.set_selection(Sel::caret(8));
    typ(&mut e, "2");
    assert_eq!(e.text(), "aaa1 bbb2");
    remote(&mut e, 0, 0, ">>");
    remote(&mut e, 6, 6, "|");
    assert_eq!(e.text(), ">>aaa1| bbb2");
    undo(&mut e);
    assert_eq!(e.text(), ">>aaa1| bbb");
    undo(&mut e);
    assert_eq!(e.text(), ">>aaa| bbb");
    assert_eq!(sel(&e), (5, 5));
    redo(&mut e);
    redo(&mut e);
    assert_eq!(e.text(), ">>aaa1| bbb2");
}

#[test]
fn remote_edits_dont_end_the_typing_group() {
    let mut e = Editor::new("x");
    e.set_selection(Sel::caret(1));
    typ(&mut e, "ab");
    remote(&mut e, 0, 0, "R");
    typ(&mut e, "c");
    assert_eq!(e.text(), "Rxabc");
    undo(&mut e);
    assert_eq!(e.text(), "Rx");
    assert!(!e.can_undo());
}

#[test]
fn read_only_editors_apply_remote_edits() {
    let mut e = Editor::new("hello");
    e.set_selection(Sel::caret(5));
    typ(&mut e, "!");
    e.set_read_only(true);
    remote(&mut e, 0, 0, "Oh, ");
    assert_eq!((e.text(), sel(&e)), ("Oh, hello!", (10, 10)));
    assert!(!undo(&mut e));
    e.set_read_only(false);
    undo(&mut e);
    assert_eq!(e.text(), "Oh, hello");
}

#[test]
fn composition_range_goal_x_and_literal_lines_are_mapped() {
    let mut e = Editor::new("hello\nworld");
    e.set_selection(Sel::caret(8));
    e.begin_composition();
    remote(&mut e, 0, 0, "AB");
    e.end_composition("x");
    assert_eq!(e.text(), "ABhello\nwoxrld");

    let mut e = Editor::new("first line\nsecond line");
    e.set_selection(Sel::caret(15));
    let l = MonoLayout::new(&e);
    e.move_vertical(&l, -1, false);
    let goal = e.goal_x();
    assert!(goal.is_some());
    remote(&mut e, 11, 11, "zz");
    assert_eq!(e.goal_x(), goal);

    // an undone conversion stays literal through remote edits elsewhere, and ends when its
    // line is edited remotely
    let mut e = Editor::new("");
    typ(&mut e, "ab\n- ");
    undo(&mut e);
    assert_eq!(tokens_bullet(&e), 0);
    remote(&mut e, 0, 0, "top\n");
    assert_eq!(e.doc().lines[2].ty, BlockType::Paragraph);
    assert_eq!(sel(&e), (9, 9));
    // undoing the literal mark is still possible after an unrelated remote edit
    redo(&mut e);
    assert_eq!(tokens_bullet(&e), 1);
    undo(&mut e);
    assert_eq!(tokens_bullet(&e), 0);
    remote(&mut e, 9, 9, "y");
    assert_eq!(e.text(), "top\nab\n- y");
    assert_eq!(tokens_bullet(&e), 1);
}

fn tokens_bullet(e: &Editor) -> usize {
    e.render_lines().iter().flat_map(|l| &l.segments).filter(|s| s.token == Some(TokenKind::Bullet)).count()
}

#[test]
fn custom_stores_see_local_and_remote_changes() {
    #[derive(Clone, Debug, Default)]
    struct Log {
        text: String,
        local: usize,
        remote: usize,
    }
    impl TextStore for Log {
        fn text(&self) -> &str {
            &self.text
        }
        fn replace(&mut self, range: std::ops::Range<usize>, s: &str) {
            self.local += 1;
            self.text.replace_range(range, s);
        }
        fn replace_remote(&mut self, range: std::ops::Range<usize>, s: &str) {
            self.remote += 1;
            self.text.replace_range(range, s);
        }
    }
    let mut e = Editor::with_store(Log { text: "a\r\nb".into(), ..Log::default() });
    assert_eq!(e.store().text(), "a\nb");
    e.set_selection(Sel::caret(3));
    e.insert_text("c");
    e.apply_remote(&[(0..0, "R".into())]);
    e.undo();
    assert_eq!((e.text(), e.store().text()), ("Ra\nb", "Ra\nb"));
    assert_eq!((e.store().local, e.store().remote), (3, 1));
    let s: Editor<StringStore> = Editor::new("x");
    assert_eq!(s.store(), &StringStore::new("x"));
}

/// Random local edits interleaved with remote insertions of 'R': undoing everything leaves
/// exactly the original text plus every 'R' (undo never touches remote text and restores local
/// deletions of it); redoing everything never fails.
#[test]
fn random_local_and_remote_edits_undo_to_the_remote_text() {
    let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
    let mut rnd = |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % n.max(1) as u64) as usize
    };
    for round in 0..300 {
        let original = "the quick brown fox\njumps over\nthe lazy dog";
        let mut e = Editor::new(original);
        let mut remotes = 0;
        for _ in 0..(5 + rnd(30)) {
            let len = e.text().len();
            match rnd(6) {
                0 | 1 => {
                    let p = rnd(len + 1);
                    let q = (p + rnd(4)).min(len);
                    let s: String = (0..rnd(4)).map(|_| (b'a' + rnd(26) as u8) as char).collect();
                    e.replace_range(p, q, &s);
                }
                2 => {
                    let p = rnd(len + 1);
                    let q = (p + rnd(6)).min(len);
                    e.replace_range(p, q, "");
                }
                3 => e.set_selection(Sel::caret(rnd(len + 1))),
                4 => {
                    if rnd(3) == 0 {
                        e.undo();
                    } else {
                        e.redo();
                    }
                }
                _ => {
                    let p = rnd(len + 1);
                    e.apply_remote(&[(p..p, "R".into())]);
                    remotes += 1;
                }
            }
            assert_eq!(e.store().text(), e.text());
        }
        while e.undo() {}
        let t = e.text();
        assert_eq!(t.matches('R').count(), remotes, "round {round}: {t:?}");
        assert_eq!(t.replace('R', ""), original, "round {round}");
        while e.redo() {}
        assert_eq!(e.store().text(), e.text());
    }
}
