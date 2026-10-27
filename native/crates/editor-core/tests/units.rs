use editor_core::parser::parse_doc;
use editor_core::reveal::compute_reveal;
use editor_core::units::{Sel, is_stop, next_stop, prev_stop, snap, word_left, word_right};

#[test]
fn block_token_is_one_step() {
    let d = parse_doc("ab\n- item");
    assert!(!is_stop(&d, 4));
    assert_eq!(prev_stop(&d, 5), 3);
    assert_eq!(prev_stop(&d, 3), 2);
    assert_eq!(next_stop(&d, 3), 5);
}

#[test]
fn nested_indent_one_token_per_level() {
    let d = parse_doc("\t- x");
    assert_eq!(prev_stop(&d, 3), 1);
    assert_eq!(prev_stop(&d, 1), 0);
}

#[test]
fn space_indent_level_is_one_step() {
    let d = parse_doc("- a\n  - b\n    - c");
    assert_eq!(prev_stop(&d, 16), 14);
    assert_eq!(prev_stop(&d, 14), 12);
    assert_eq!(prev_stop(&d, 12), 10);
    assert!(!is_stop(&d, 11));
    let d4 = parse_doc("- a\n    - b");
    assert_eq!(prev_stop(&d4, 10), 8);
    assert_eq!(prev_stop(&d4, 8), 4);
    assert!(!is_stop(&d4, 6));
}

#[test]
fn markers_stepped_one_char_at_a_time() {
    let d = parse_doc("a **b**");
    assert_eq!(next_stop(&d, 2), 3);
    assert_eq!(next_stop(&d, 3), 4);
}

#[test]
fn a_collapsed_link_steps_like_its_text() {
    // stops: before the link, inside its text, after it
    let mut d = parse_doc("[ab](http://x) z");
    assert_eq!(next_stop(&d, 0), 2);
    assert_eq!(next_stop(&d, 2), 14);
    assert_eq!(prev_stop(&d, 14), 2);
    assert_eq!(prev_stop(&d, 2), 0);
    assert!(!is_stop(&d, 1) && !is_stop(&d, 3) && !is_stop(&d, 8));
    assert_eq!((snap(&d, 1, 0), snap(&d, 3, 0), snap(&d, 8, 0)), (0, 14, 14));
    // a one-character text: before or after it
    let one = parse_doc("[a](u)");
    assert_eq!(next_stop(&one, 0), 6);
    assert_eq!(prev_stop(&one, 6), 0);
    // a nested style's markers aren't skipped into: the first plain character
    let b = parse_doc("[**ab**](u)");
    assert_eq!(next_stop(&b, 0), 4);
    // expanded: every raw position, the URL too
    d.expanded_link = Some(0);
    assert_eq!(next_stop(&d, 0), 1);
    assert_eq!(next_stop(&d, 5), 6);
    assert_eq!(snap(&d, 6, 0), 6);
}

#[test]
fn escape_pair() {
    let d = parse_doc("\\*x");
    assert!(!is_stop(&d, 1));
    assert_eq!(next_stop(&d, 0), 2);
}

#[test]
fn grapheme_clusters_and_multibyte() {
    // "é" is 2 bytes, "👍🏽" one 8-byte cluster
    let d = parse_doc("é👍🏽x");
    assert_eq!(next_stop(&d, 0), 2);
    assert_eq!(next_stop(&d, 2), 10);
    assert_eq!(prev_stop(&d, 10), 2);
    assert!(!is_stop(&d, 6));
    assert_eq!(snap(&d, 6, 0), 2);
}

#[test]
fn horizontal_rule_single_stop() {
    let d = parse_doc("a\n---\nb");
    assert_eq!(next_stop(&d, 1), 5);
    assert_eq!(prev_stop(&d, 5), 1);
    assert!(!is_stop(&d, 2));
    assert_eq!(snap(&d, 3, 0), 5);
    assert_eq!(next_stop(&d, 5), 6);
}

#[test]
fn option_right_passes_over_markers() {
    let d = parse_doc("Alpha **bold words**");
    assert_eq!(word_right(&d, 0), 5);
    assert_eq!(word_right(&d, 5), 12);
    assert_eq!(word_right(&d, 12), 18);
    assert_eq!(word_left(&d, 18), 13);
    assert_eq!(word_left(&d, 13), 8);
    assert_eq!(word_left(&d, 8), 0);
}

#[test]
fn links_are_words_by_their_text() {
    let mut d = parse_doc("[a b](https://x.y) end");
    assert_eq!(word_left(&d, 18), 3);
    assert_eq!(word_left(&d, 3), 0);
    assert_eq!(word_right(&d, 0), 2);
    assert_eq!(word_right(&d, 2), 18);
    // expanded: the URL's words too
    d.expanded_link = Some(0);
    assert_eq!(word_left(&d, 18), 16);
    assert_eq!(word_right(&d, 4), 11);
}

#[test]
fn tokens_are_not_words() {
    let d = parse_doc("12. one");
    assert_eq!(word_left(&d, 7), 4);
    assert_eq!(word_left(&d, 4), 0);
}

// --- reveal

fn els(text: &str, a: usize, h: usize) -> Vec<usize> {
    let d = parse_doc(text);
    compute_reveal(&d, Some(Sel::new(a, h))).get(&0).map(|r| r.els.clone()).unwrap_or_default()
}

const T: &str = "x **bold** y *it* z";

#[test]
fn reveal_inclusive_edges() {
    assert_eq!(els(T, 2, 2), vec![0]);
    assert_eq!(els(T, 10, 10), vec![0]);
    assert_eq!(els(T, 11, 11), Vec::<usize>::new());
    assert_eq!(els(T, 1, 1), Vec::<usize>::new());
}

#[test]
fn reveal_only_touched_element() {
    assert_eq!(els(T, 14, 14), vec![1]);
}

#[test]
fn reveal_selection_strict_overlap() {
    assert_eq!(els(T, 0, T.len()), vec![0, 1]);
    assert_eq!(els(T, 0, 2), Vec::<usize>::new());
    assert_eq!(els(T, 0, 3), vec![0]);
    assert_eq!(els(T, 10, 12), Vec::<usize>::new());
}

#[test]
fn reveal_descendants() {
    assert_eq!(els("**bold *nested* inside**", 3, 3), vec![0, 1]);
}

#[test]
fn reveal_element_spanning_lines() {
    let d = parse_doc("a **bold \ntext** b");
    let r = compute_reveal(&d, Some(Sel::caret(12)));
    assert_eq!(r[&0].els, vec![0]);
    assert_eq!(r[&1].els, vec![0]);
}

#[test]
fn reveal_table_when_caret_in_it() {
    let d = parse_doc("x\n| a | b |\n|---|---|\n| 1 | 2 |\ny");
    let r = compute_reveal(&d, Some(Sel::caret(5)));
    assert_eq!([1, 2, 3].map(|i| r.get(&i).is_some_and(|r| r.fence)), [true, true, true]);
    assert!(!compute_reveal(&d, Some(Sel::caret(0))).contains_key(&1));
}

#[test]
fn reveal_code_fences_when_caret_in_block() {
    let d = parse_doc("a\n```\ncode\n```\nb");
    let r = compute_reveal(&d, Some(Sel::caret(7)));
    assert!(r[&1].fence);
    assert!(r[&3].fence);
    assert!(!compute_reveal(&d, Some(Sel::caret(0))).contains_key(&1));
}
