mod common;

use common::{run, show, st};
use editor_core::parser::{BlockType, Doc, parse_doc};
use editor_core::rules::{self as R, Change, Edit, EditKind, FormatType};
use editor_core::units::Sel;

fn ins(t: &'static str) -> impl Fn(&Doc, Sel) -> Option<Edit> {
    move |d, s| Some(R::insert_text(d, s, t))
}

// --- typing and conversions

#[test]
fn plain_insert() {
    assert_eq!(run("ab|", ins("c")), "abc|");
    assert_eq!(run("a[[bc]]d", ins("x")), "ax|d");
}

#[test]
fn conversions_are_flagged() {
    let kind = |s: &str, t: &str| {
        let (text, sel) = st(s);
        let e = R::insert_text(&parse_doc(&text), sel, t);
        if e.converts.is_some() { "convert".to_string() } else { format!("{:?}", e.then.as_ref().map_or(e.kind, |t| t.kind)).to_lowercase() }
    };
    let from = |s: &str, t: &str| {
        let (text, sel) = st(s);
        R::insert_text(&parse_doc(&text), sel, t).converts
    };
    assert_eq!(kind("-|", " "), "convert");
    assert_eq!(kind("#|", " "), "convert");
    assert_eq!(kind("####|", " "), "convert");
    assert_eq!(kind("1.|", " "), "convert");
    assert_eq!(kind("--|", "-"), "convert");
    assert_eq!(kind("- [ ]|", " "), "convert");
    assert_eq!(kind("#|existing", " "), "convert");
    assert_eq!(kind("ab|", " "), "input");
    assert_eq!(kind("# #|", " "), "input");
    assert_eq!(from("- [ ]|", " "), Some(BlockType::Bullet));
    assert_eq!(from("-|", " "), Some(BlockType::Paragraph));
}

#[test]
fn conversions_never_write_escapes() {
    let (text, sel) = st("x\n-|");
    let e = R::insert_text(&parse_doc(&text), sel, " ");
    assert_eq!(R::apply_changes(&text, &e.changes), "x\n- ");
    assert_eq!(e.converts, Some(BlockType::Paragraph));
    assert!(e.then.is_none());
    assert_eq!(run("1.|", ins(" ")), "1. |");
    assert_eq!(run("- [ ]|", ins(" ")), "- [ ] |");
    assert_eq!(run("--|", ins("-")), "---|");
}

#[test]
fn quote_types_literal_then_space_as_convert_step() {
    let (text, sel) = st("|");
    let e = R::insert_text(&parse_doc(&text), sel, ">");
    assert_eq!(R::apply_changes(&text, &e.changes), ">");
    assert_eq!(parse_doc(">").lines[0].ty, BlockType::Paragraph);
    assert_eq!(e.then.unwrap().kind, EditKind::Convert);
}

#[test]
fn quote_converts_immediately() {
    assert_eq!(run("|", ins(">")), "> |");
    assert_eq!(run("a|", ins(">")), "a>|");
}

#[test]
fn paste_normalizes_newlines() {
    let (text, sel) = st("x|");
    let e = R::paste(&parse_doc(&text), sel, "a\r\nb");
    assert_eq!(e.kind, EditKind::Paste);
    assert_eq!(show(&text, Some(e)), "xa\nb|");
}

// --- Enter

fn enter(s: &str) -> String {
    run(s, R::insert_paragraph)
}

#[test]
fn enter_list_continuation() {
    assert_eq!(enter("- one|"), "- one\n- |");
    assert_eq!(enter("* one|"), "* one\n* |");
    assert_eq!(enter("- [x] one|"), "- [x] one\n- [ ] |");
    assert_eq!(enter("1. one|"), "1. one\n2. |");
    assert_eq!(enter("> q|"), "> q\n> |");
    assert_eq!(enter("\t- one|"), "\t- one\n\t- |");
}

#[test]
fn enter_empty_item_exits() {
    assert_eq!(enter("- a\n- |"), "- a\n|");
    assert_eq!(enter("> |"), "|");
    assert_eq!(enter("\t- |"), "|");
}

#[test]
fn enter_split_bullet_and_heading() {
    assert_eq!(enter("- ab|cd"), "- ab\n- |cd");
    assert_eq!(enter("# ab|cd"), "# ab\n|cd");
    assert_eq!(enter("# abcd|"), "# abcd\n|");
}

#[test]
fn enter_at_text_start_inserts_above() {
    assert_eq!(enter("- |abc"), "- \n- |abc");
    assert_eq!(enter("# |abc"), "\n# |abc");
    assert_eq!(enter("|- abc"), "\n|- abc");
}

#[test]
fn enter_code_block_literal_newline() {
    assert_eq!(enter("```\n  ind|\n```"), "```\n  ind\n|\n```");
    assert_eq!(enter("```\n  x\n```|\nafter"), "```\n  x\n```\n|\nafter");
}

#[test]
fn enter_opening_fence_auto_closes() {
    assert_eq!(enter("```|"), "```\n|\n```");
    assert_eq!(enter("x\n```js|"), "x\n```js\n|\n```");
    assert_eq!(enter("```|\ncode\n```"), "```\n|\ncode\n```");
    assert_eq!(enter("```\ncode\n```|\n```"), "```\ncode\n```\n|\n```\n```");
}

#[test]
fn enter_with_selection() {
    assert_eq!(enter("- a[[bc]]d"), "- a\n- |d");
}

#[test]
fn enter_selection_covering_item_text_splits() {
    assert_eq!(enter("- [[abc]]\nx"), "- \n- |\nx");
    assert_eq!(enter("- |\nx"), "|\nx");
}

#[test]
fn enter_between_indent_tokens() {
    assert_eq!(enter("\t|\t- a"), "\n\t|\t- a");
}

#[test]
fn enter_empty_heading_strips_token() {
    assert_eq!(enter("## |"), "|");
}

#[test]
fn enter_all_heading_text_selected_splits() {
    assert_eq!(enter("## [[abc]]\nx"), "## \n|\nx");
}

// --- Backspace / Delete

fn bs(s: &str) -> String {
    run(s, R::delete_backward)
}
fn del(s: &str) -> String {
    run(s, R::delete_forward)
}

#[test]
fn backspace_token_removal() {
    assert_eq!(bs("# |Head"), "|Head");
    assert_eq!(bs("- |item"), "|item");
    assert_eq!(bs("2. |two"), "|two");
    assert_eq!(bs("> |q"), "|q");
    assert_eq!(bs("- [ ] |t"), "|t");
    assert_eq!(bs("\t- |n"), "\t|n");
}

#[test]
fn backspace_raw_joins() {
    assert_eq!(bs("- one\n|two"), "- one|two");
    assert_eq!(bs("1. first\n|second"), "1. first|second");
    assert_eq!(bs("**b*|*"), "**b|*");
}

#[test]
fn forward_delete() {
    assert_eq!(del("- alpha beta|\n- second"), "- alpha beta|- second");
    assert_eq!(del("|- x"), "|x");
}

#[test]
fn surrogate_pairs_and_escapes_are_one_unit() {
    assert_eq!(bs("a😀|"), "a|");
    assert_eq!(bs("\\*|"), "|");
    // grapheme clusters (beyond the TS, which only joins surrogate pairs)
    assert_eq!(bs("ae\u{301}|"), "a|");
    assert_eq!(bs("x👍🏽|"), "x|");
    assert_eq!(del("|e\u{301}x"), "|x");
}

#[test]
fn option_backspace_uses_option_left_boundaries() {
    assert_eq!(run("word **|tail", R::delete_word_backward), "|tail");
    assert_eq!(run("hello world|", R::delete_word_backward), "hello |");
    assert_eq!(run("(safe to delete)\n|tail", R::delete_word_backward), "(safe to |tail");
    assert_eq!(run("a|, b c", R::delete_word_forward), "a| c");
    // a collapsed link is deleted by its text: its brackets and URL only go with all of it
    assert_eq!(run("see [a](https://x.y/z) |", R::delete_word_backward), "see |");
    assert_eq!(run("see [two words](u) |", R::delete_word_backward), "see [two ](u)|");
    assert_eq!(run("|[two words](u) x", R::delete_word_forward), "|[ words](u) x");
    assert_eq!(run("a [b c](u) d|", R::delete_to_line_start), "|");
    assert_eq!(run("a [b |c](u) d", R::delete_to_line_start), "[|c](u) d");
}

#[test]
fn backspace_and_delete_at_a_collapsed_links_edges() {
    // the link's text, never its hidden syntax
    assert_eq!(run("[ab](u)|", R::delete_backward), "[a](u)|");
    assert_eq!(run("|[ab](u)", R::delete_forward), "|[b](u)");
    assert_eq!(run("[ab|](u)", R::delete_backward), "[a|](u)");
    // its last character: the whole link
    assert_eq!(run("x[a](u)|", R::delete_backward), "x|");
    assert_eq!(run("|[a](u)x", R::delete_forward), "|x");
    // a nested style's markers stay
    assert_eq!(run("[**ab**](u)|", R::delete_backward), "[**a**](u)|");
    assert_eq!(run("|[**ab**](u)", R::delete_forward), "|[**b**](u)");
    // outside it, as usual
    assert_eq!(run("|x[ab](u)", R::delete_forward), "|[ab](u)");
    // a selection takes the syntax it covers with it
    assert_eq!(run("[[a[b]]c](u)", R::delete_backward), "|c](u)");
}

#[test]
fn horizontal_rule_deletion() {
    assert_eq!(bs("---|\nb"), "|\nb");
    assert_eq!(bs("a\n---|\nb"), "a\n|\nb");
    assert_eq!(del("a|\n---"), "a|---");
    assert_eq!(bs("---\n|b"), "---|b");
}

#[test]
fn forward_delete_at_line_end_joins_raw() {
    assert_eq!(del("a|\n# b"), "a|# b");
}

#[test]
fn forward_delete_before_heading_token_removes_one_hash() {
    assert_eq!(del("para\n|## Head"), "para\n|# Head");
    assert_eq!(del("para\n|# Head"), "para\n|Head");
}

#[test]
fn cmd_backspace() {
    assert_eq!(run("- abc|", R::delete_to_line_start), "- |");
    assert_eq!(run("- |", R::delete_to_line_start), "|");
}

// --- Tab

fn tab(s: &str, shift: bool) -> String {
    run(s, |d, sel| R::tab(d, sel, shift))
}

#[test]
fn tab_nests_at_most_one_deeper() {
    assert_eq!(tab("- a\n- |b", false), "- a\n\t- |b");
    assert_eq!(tab("- a\n\t- |b", false), "- a\n\t- |b");
    assert_eq!(tab("- |a", false), "- |a");
}

#[test]
fn tab_at_column_0_of_list_item() {
    assert_eq!(tab("- a\n|- b", false), "- a\n\t|- b");
    assert_eq!(tab("- a\n\t|- b", false), "- a\n\t|- b");
}

#[test]
fn tab_space_indented_lists_use_line_unit() {
    assert_eq!(tab("- a\n  - b\n  - |c", false), "- a\n  - b\n    - |c");
    assert_eq!(tab("- a\n  - |b", true), "- a\n- |b");
    assert_eq!(tab("- a\n    - b\n    - |c", false), "- a\n    - b\n        - |c");
    assert_eq!(tab("- a\n    - |b", true), "- a\n- |b");
    assert_eq!(tab("- a\n  - b\n- |c", false), "- a\n  - b\n  - |c");
    assert_eq!(tab("- a\n\t- |b", true), "- a\n- |b");
}

#[test]
fn enter_space_indented_keeps_raw_indentation() {
    assert_eq!(enter("- a\n  - b|"), "- a\n  - b\n  - |");
    assert_eq!(enter("  1. a|"), "  1. a\n  2. |");
    assert_eq!(enter("   - [x] a|"), "   - [x] a\n   - [ ] |");
    assert_eq!(enter("  - |a"), "  - \n  - |a");
}

#[test]
fn tab_literal_mid_list_and_code() {
    assert_eq!(tab("- a|b", false), "- a\t|b");
    assert_eq!(tab("```\nx|\n```", false), "```\nx\t|\n```");
}

#[test]
fn tab_paragraph_literal() {
    assert_eq!(tab("ab|c", false), "ab\t|c");
}

#[test]
fn shift_tab_outdents() {
    assert_eq!(tab("- a\n\t- b|", true), "- a\n- b|");
    assert_eq!(tab("\tab|", true), "\tab|");
    assert_eq!(tab("ab|", true), "ab|");
}

// --- tables ("^" marks the caret: pipes are table syntax)

fn tr(src: &str, f: impl Fn(&Doc, Sel) -> Option<Edit>) -> String {
    let i = src.find('^').unwrap();
    let text = format!("{}{}", &src[..i], &src[i + 1..]);
    let Some(e) = f(&parse_doc(&text), Sel::caret(i)) else { return "null".into() };
    let out = R::apply_changes(&text, &e.changes);
    format!("{}^{}", &out[..e.sel.head], &out[e.sel.head..])
}
fn ttab(s: &str, shift: bool) -> String {
    tr(s, |d, sel| R::tab(d, sel, shift))
}
fn tenter(s: &str) -> String {
    tr(s, R::insert_paragraph)
}
const D: &str = "\n|---|---|\n";
fn c(parts: &[&str]) -> String {
    parts.concat()
}

#[test]
fn table_tab_moves_between_cells() {
    assert_eq!(ttab(&c(&["| a^ | b |", D, "| 1 | 2 |"]), false), c(&["| a | ^b |", D, "| 1 | 2 |"]));
    assert_eq!(ttab(&c(&["| a | b^ |", D, "| 1 | 2 |"]), false), c(&["| a | b |", D, "| ^1 | 2 |"]));
    assert_eq!(ttab(&c(&["| a | b |", D, "| ^1 | 2 |"]), true), c(&["| a | ^b |", D, "| 1 | 2 |"]));
    assert_eq!(ttab(&c(&["| ^a | b |", D, "| 1 | 2 |"]), true), c(&["| ^a | b |", D, "| 1 | 2 |"]));
    assert_eq!(ttab(&c(&["| a^ |  |", D]), false), c(&["| a | ^ |", D]));
    assert_eq!(ttab(&c(&["| a | b |", D, "| 1 | 2^ |"]), false), c(&["| a | b |", D, "| 1 | 2 |\n| ^| |"]));
}

#[test]
fn table_enter_adds_row() {
    assert_eq!(tenter(&c(&["| a | b |", D, "| 1 | 2 |^"])), c(&["| a | b |", D, "| 1 | 2 |\n| ^| |"]));
    assert_eq!(tenter(&c(&["| a^ | b |", D, "| 1 | 2 |"])), c(&["| a | b |", D, "| ^| |\n| 1 | 2 |"]));
    assert_eq!(tenter(&c(&["| a | b |", D, "| 1^ | 2 |\n| 3 | 4 |"])), c(&["| a | b |", D, "| 1 | 2 |\n| ^| |\n| 3 | 4 |"]));
}

#[test]
fn table_enter_at_header_start_plain_line_above() {
    assert_eq!(tenter(&c(&["^| a | b |", D, "| 1 | 2 |"])), c(&["\n^| a | b |", D, "| 1 | 2 |"]));
}

#[test]
fn table_row_insertion_is_structure() {
    let text = c(&["| a | b |", D, "| 1 | 2 |"]);
    let n = text.len();
    assert_eq!(R::insert_paragraph(&parse_doc(&text), Sel::caret(n)).unwrap().kind, EditKind::Structure);
    assert_eq!(R::tab(&parse_doc(&text), Sel::caret(n - 2), false).unwrap().kind, EditKind::Structure);
}

#[test]
fn table_enter_with_selection_in_last_row_inserts() {
    let text = c(&["| a | b |", D, "| x | |"]);
    let i = text.rfind('x').unwrap();
    let e = R::insert_paragraph(&parse_doc(&text), Sel::new(i, i + 1)).unwrap();
    assert_eq!(R::apply_changes(&text, &e.changes), c(&["| a | b |", D, "|  | |\n| | |"]));
}

#[test]
fn table_multiline_selection_never_indents() {
    let text = c(&["| a | b |", D, "| 1 | 2 |"]);
    let e = R::tab(&parse_doc(&text), Sel::new(text.len() - 2, 2), false).unwrap();
    assert!(e.changes.is_empty());
    assert_eq!(e.sel, Sel::caret(6));
    let mixed = format!("para\n{text}");
    let n = mixed.len();
    assert!(R::tab(&parse_doc(&mixed), Sel::new(1, n - 2), false).unwrap().changes.is_empty());
    assert!(R::tab(&parse_doc(&mixed), Sel::new(1, n - 2), true).unwrap().changes.is_empty());
}

#[test]
fn table_tab_before_leading_pipe_and_after_trailing() {
    assert_eq!(ttab(&c(&["| a | b |", D, "^| 1 | 2 |"]), false), c(&["| a | b |", D, "| 1 | ^2 |"]));
    assert_eq!(ttab(&c(&["| a | b |", D, "| 1 | 2 |^"]), true), c(&["| a | b |", D, "| ^1 | 2 |"]));
}

#[test]
fn table_crlf_cell_targets_skip_cr() {
    assert_eq!(ttab("| a^ |\r\n|---|\r\n| \r|", false), "| a |\r\n|---|\r\n| ^\r|");
}

#[test]
fn table_format_noop_on_delim_and_across_pipe() {
    let text = c(&["| a | b |", D, "| 1 | 2 |"]);
    let d = parse_doc(&text);
    let delim = text.find("---").unwrap() + 1;
    assert!(R::toggle_format(&d, Sel::caret(delim), FormatType::Bold).is_none());
    assert!(R::toggle_format(&d, Sel::new(2, 7), FormatType::Bold).is_none());
    let e = R::toggle_format(&d, Sel::new(2, 3), FormatType::Bold).unwrap();
    assert_eq!(R::apply_changes(&text, &e.changes), c(&["| **a** | b |", D, "| 1 | 2 |"]));
}

#[test]
fn table_enter_on_empty_last_row_exits() {
    assert_eq!(tenter(&c(&["| a | b |", D, "| | |^"])), c(&["| a | b |", D, "^"]));
    assert_eq!(parse_doc(&c(&["| a | b |", D])).lines[2].ty, BlockType::Paragraph);
}

// --- Cmd-B / Cmd-I

fn bold(s: &str) -> String {
    run(s, |d, sel| R::toggle_format(d, sel, FormatType::Bold))
}
fn ital(s: &str) -> String {
    run(s, |d, sel| R::toggle_format(d, sel, FormatType::Italic))
}

#[test]
fn format_wrap_selection_and_toggle() {
    assert_eq!(bold("a [[bc]] d"), "a **[[bc]]** d");
    assert_eq!(bold("a **[[bc]]** d"), "a [[bc]] d");
    assert_eq!(bold("a [[**bc**]] d"), "a [[bc]] d");
}

#[test]
fn format_word_under_caret() {
    assert_eq!(bold("hel|lo world"), "**hel|lo** world");
    assert_eq!(ital("Plain word here|"), "Plain word here*|*");
    assert_eq!(ital("|here"), "*|*here");
    assert_eq!(bold("**hel|lo** world"), "hel|lo world");
}

#[test]
fn format_unwrap_with_caret_on_marker() {
    assert_eq!(bold("a **bold*|* c"), "a bold| c");
    assert_eq!(bold("a |**bold** c"), "a |bold c");
}

#[test]
fn format_never_before_block_token() {
    assert_eq!(bold("|- item"), "- **|**item");
    assert_eq!(bold("|# Head"), "# **|**Head");
}

#[test]
fn format_empty_pair() {
    assert_eq!(bold("a | b"), "a **|** b");
    assert_eq!(bold("a **|** b"), "a | b");
}

#[test]
fn format_italic_inside_bold() {
    assert_eq!(ital("**bo|ld**"), "***bo|ld***");
    assert_eq!(ital("***bo|ld***"), "**bo|ld**");
}

// --- todo toggle

#[test]
fn todo_toggle() {
    let d = parse_doc("x\n- [ ] task");
    assert_eq!(show(&d.text, R::toggle_todo(&d, 1)), "x\n- [x] |task");
    let d2 = parse_doc("\t- [x] task");
    assert_eq!(show(&d2.text, R::toggle_todo(&d2, 0)), "\t- [ ] |task");
}

// --- mapPos

#[test]
fn map_pos_through_changes() {
    let ch = [Change::new(2, 2, "xx")];
    assert_eq!(R::map_pos(1, &ch, 1), 1);
    assert_eq!(R::map_pos(2, &ch, 1), 4);
    assert_eq!(R::map_pos(2, &ch, -1), 2);
    assert_eq!(R::map_pos(5, &[Change::new(1, 3, "")], 1), 3);
}
