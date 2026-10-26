//! Phase C review (web repo docs/rust-engine/review-C.md): edits far apart re-parse only around each one, the
//! edit log, cancelled compositions.

use editor_core::{Editor, Sel};

/// A small xorshift for reproducible random edits.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn floor(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[test]
fn remote_edits_far_apart_reparse_each_place_and_match_a_full_parse() {
    let text: String = (0..300)
        .map(|i| match i % 7 {
            0 => format!("# head {i}\n"),
            1 => "```\n".into(),
            2 => format!("code {i}\n"),
            3 => "```\n".into(),
            4 => format!("| a | b {i} |\n"),
            5 => "|---|---|\n".into(),
            _ => format!("- item **{i}** 😀\n"),
        })
        .collect();
    let pieces = ["x", "\n", "```", "# ", "|", "- ", "😀", "\n\n", "**"];
    let mut rng = Rng(0x1234_5678_9abc_def1);
    let mut e = Editor::new(&text);
    e.set_edit_log(true);
    for _ in 0..300 {
        // a few edits in order (each against the text left by the ones before), anywhere
        let mut t = e.text().to_string();
        let mut edits = Vec::new();
        for _ in 0..1 + rng.below(4) {
            let a = floor(&t, rng.below(t.len() + 1));
            let b = floor(&t, (a + rng.below(6)).min(t.len())).max(a);
            let ins = if rng.below(3) == 0 { String::new() } else { pieces[rng.below(pieces.len())].to_string() };
            t.replace_range(a..b, &ins);
            edits.push((a..b, ins));
        }
        let before = e.text().to_string();
        // debug builds assert that the incremental parse equals a full parse
        e.apply_remote(&edits);
        assert_eq!(e.text(), t);
        // the log replays the same edits
        let mut r = before;
        for (range, ins) in e.take_edits() {
            r.replace_range(range, &ins);
        }
        assert_eq!(r, t);
    }
}

#[test]
fn the_edit_log_has_local_and_undo_edits_and_is_off_by_default() {
    let mut e = Editor::new("hello world");
    e.set_selection(Sel::caret(5));
    e.insert_text("!");
    assert!(e.take_edits().is_empty(), "off by default");
    e.set_edit_log(true);
    e.insert_text("?");
    assert_eq!(e.take_edits(), vec![(6..6, "?".to_string())]);
    e.undo();
    let log = e.take_edits();
    assert!(!log.is_empty());
    let mut t = "hello!? world".to_string();
    for (r, ins) in log {
        t.replace_range(r, &ins);
    }
    assert_eq!(t, e.text());
}

#[test]
fn cancel_composition_keeps_the_text() {
    let mut e = Editor::new("hello");
    e.set_selection(Sel::new(0, 5));
    e.begin_composition();
    e.cancel_composition();
    // end_composition("") after a cancel has no composition: nothing of the old selection is special
    assert_eq!(e.text(), "hello");
    e.insert_text("x");
    assert_eq!(e.text(), "x");
}
