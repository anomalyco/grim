//! The macOS key table (`KeyTable`): Cocoa's StandardKeyBinding.dict selectors on editor-core's
//! commands, the dict and chord parsers, and a user's DefaultKeyBinding.dict on top.

mod common;

use std::sync::Arc;

use common::{show_sel, st};
use editor_core::layout::{Bounds, Layout, Rect};
use editor_core::macos_keys::{self, Value, parse_chord, parse_dict};
use editor_core::{Command, Editor, HUnit, Key, KeyTable, Mods, MonoLayout, Sel};

/// A chord written like the dict, with readable names for the function keys.
fn chord(s: &str) -> (Key, Mods) {
    let s: String = s
        .chars()
        .map(|c| match c {
            '←' => '\u{F702}',
            '→' => '\u{F703}',
            '↑' => '\u{F700}',
            '↓' => '\u{F701}',
            '⌫' => '\u{7f}',
            '⌦' => '\u{F728}',
            '↖' => '\u{F729}',
            '↘' => '\u{F72B}',
            '⇞' => '\u{F72C}',
            '⇟' => '\u{F72D}',
            '↩' => '\r',
            '⇥' => '\t',
            c => c,
        })
        .collect();
    let c = parse_chord(&s).unwrap_or_else(|| panic!("chord {s:?}"));
    (c.key, c.mods)
}

fn table_editor(markup: &str, t: KeyTable) -> Editor {
    let (text, sel) = if markup.contains('|') || markup.contains("[[") { st(markup) } else { (markup.to_string(), Sel::caret(0)) };
    let mut e = Editor::new(&text);
    e.set_key_table(Some(Arc::new(t)));
    e.set_selection(sel);
    e
}

/// An editor with the macOS table, text and selection from "a|b" / "[[a]]b" markup.
fn mac(markup: &str) -> Editor {
    table_editor(markup, KeyTable::standard())
}

fn press(e: &mut Editor, c: &str) -> Option<Command> {
    let (k, m) = chord(c);
    let l = MonoLayout::new(e);
    e.key(k, m, &l)
}

fn keys(e: &mut Editor, cs: &[&str]) {
    for c in cs {
        press(e, c);
    }
}

fn show(e: &Editor) -> String {
    show_sel(e.text(), e.selection())
}

/// `markup` after pressing `cs`.
fn after(markup: &str, cs: &[&str]) -> String {
    let mut e = mac(markup);
    keys(&mut e, cs);
    show(&e)
}

// ---------------------------------------------------------------------------------------------
// The dict and chord formats

#[test]
fn chords_parse_like_cocoa() {
    let c = |s: &str| parse_chord(s).map(|c| (c.key, c.mods, c.any_shift));
    let ctrl = Mods { ctrl: true, ..Mods::NONE };
    let ctrl_shift = Mods { shift: true, ..ctrl };
    assert_eq!(c("^a"), Some((Key::Char('a'), ctrl, false)));
    // an uppercase letter is Shift, and so is "$"
    assert_eq!(c("^A"), Some((Key::Char('a'), ctrl_shift, false)));
    assert_eq!(c("$^e"), Some((Key::Char('e'), ctrl_shift, false)));
    assert_eq!(c("~\u{F702}"), Some((Key::Left, Mods::ALT, false)));
    assert_eq!(c("@$\u{F703}"), Some((Key::Right, Mods::CMD_SHIFT, false)));
    assert_eq!(c("@\u{7f}"), Some((Key::Backspace, Mods::CMD, false)));
    assert_eq!(c("~\u{F728}"), Some((Key::Delete, Mods::ALT, false)));
    assert_eq!(c("\u{19}"), Some((Key::Tab, Mods::SHIFT, false)));
    assert_eq!(c("\r"), Some((Key::Enter, Mods::NONE, false)));
    // "#" (keypad) is ignored; a punctuation key matches with or without Shift
    assert_eq!(c("#\u{F702}"), Some((Key::Left, Mods::NONE, false)));
    assert_eq!(c("^\""), Some((Key::Char('"'), ctrl, true)));
    assert_eq!(c("^ "), Some((Key::Char(' '), ctrl, true)));
    // keys that don't reach the editor as such: other function keys, alternate control characters
    assert_eq!(c("\u{F708}"), None);
    assert_eq!(c("\n"), None);
    assert_eq!(c("\u{8}"), None);
    assert_eq!(c("x^"), None);
    assert_eq!(c(""), None);
}

const SAMPLE: &str = r#"/* ~/Library/KeyBindings/DefaultKeyBinding.dict */
{
    // emacs habits
    "^w" = "deleteWordBackward:";
    "^ " = setMark:;
    "^x" = { "^x" = "swapWithMark:"; };      /* a two-key sequence: not supported */
    "^u" = ("deleteToBeginningOfParagraph:", "noop:");
    "$^e" = "selectParagraph:";
    "^\U0040" = "selectToMark:";
    "^\101" = "moveToEndOfDocumentAndModifySelection:";
    "^a" = "noop:";
    "^f" = "someSelectorWeDontHave:";
    "~\UF702" = ("moveToBeginningOfParagraph:", "moveWordLeft:");
}
"#;

#[test]
fn a_default_key_binding_dict_parses() {
    let d = parse_dict(SAMPLE).unwrap();
    assert_eq!(d.len(), 10);
    assert_eq!(d[0], ("^w".into(), Value::Str("deleteWordBackward:".into())));
    assert_eq!(d[1], ("^ ".into(), Value::Str("setMark:".into())));
    assert!(matches!(d[2].1, Value::Dict(_)));
    assert_eq!(d[5].0, "^@");
    assert_eq!(d[6].0, "^A");
    // the same file as plutil's JSON
    let json = r#"{"^w":"deleteWordBackward:","~\uF702":["moveToBeginningOfParagraph:","moveWordLeft:"],"^x":{"^x":"swapWithMark:"}}"#;
    let j = parse_dict(json).unwrap();
    assert_eq!(j[0], d[0]);
    assert_eq!(j[1], d[9]);
    // errors say where
    assert!(parse_dict("{ \"^a\" = \"x:\" ").unwrap_err().contains("line 1"));
    assert!(parse_dict("( )").is_err());
    // the embedded standard table parses completely
    let std = parse_dict(macos_keys::STANDARD).unwrap();
    assert_eq!(std.len(), 105);
}

#[test]
fn a_user_dict_goes_over_the_standard_table() {
    let mut t = KeyTable::standard();
    // ^x (a sequence) and ^f (unknown selector) are skipped
    assert_eq!(t.add_dict(SAMPLE), Ok(8));
    let ctrl = Mods { ctrl: true, ..Mods::NONE };
    assert_eq!(t.lookup(Key::Char('w'), ctrl), Some(&[Command::DeleteWordBackward][..]));
    assert_eq!(t.lookup(Key::Char('u'), ctrl), Some(&[Command::DeleteToLineStart][..]));
    assert_eq!(t.lookup(Key::Char('a'), ctrl), Some(&[Command::Noop][..]));
    // the standard Ctrl-F stays
    assert_eq!(t.lookup(Key::Char('f'), ctrl), Some(&[Command::Move { dir: 1, unit: HUnit::Char, extend: false }][..]));
    assert_eq!(
        t.lookup(Key::Left, Mods::ALT),
        Some(&[Command::Move { dir: -1, unit: HUnit::Line, extend: false }, Command::Move { dir: -1, unit: HUnit::Word, extend: false }][..])
    );
    // the user's noop takes the key; Grimoire's Cmd shortcuts stay in front of the table
    let mut user = KeyTable::standard();
    user.add_dict(r#"{ "^a" = "noop:"; "@b" = "moveLeft:"; }"#).unwrap();
    let mut e = table_editor("ab|c", user);
    assert_eq!(press(&mut e, "^a"), Some(Command::Noop));
    assert_eq!(show(&e), "ab|c");
    assert_eq!(press(&mut e, "@b"), Some(Command::ToggleFormat(editor_core::FormatType::Bold)));
}

#[test]
fn sequences_run_in_order_and_a_user_table_drives_the_mark() {
    let mut t = KeyTable::standard();
    t.add_dict(SAMPLE).unwrap();
    t.add_dict(r#"{ "^x" = "swapWithMark:"; "^W" = "deleteToMark:"; }"#).unwrap();
    // Option-Left: paragraph start, then a word left (onto the previous line)
    let mut e = table_editor("one two\nthree fo|ur", t.clone());
    press(&mut e, "~←");
    assert_eq!(show(&e), "one |two\nthree four");
    // Cocoa: setMark at 1, end, selectToMark selects 1..7; swapWithMark goes back to the mark
    let mut e = table_editor("a|bc\ndef", t.clone());
    press(&mut e, "^ ");
    assert_eq!(e.mark(), Some(1));
    press(&mut e, "@↓");
    press(&mut e, "^@");
    assert_eq!(show(&e), "a[[bc\ndef]]");
    assert_eq!((e.selection().anchor, e.selection().head), (1, 7));
    press(&mut e, "^x");
    assert_eq!(show(&e), "a|bc\ndef");
    assert_eq!(e.mark(), Some(7));
    // deleteToMark is a kill: yanked twice, it's there twice (as in TextEdit)
    let mut e = table_editor("a|bc\ndef", t.clone());
    keys(&mut e, &["^ ", "@↓", "^W"]);
    assert_eq!(show(&e), "a|");
    assert_eq!(e.kill_buffer(), "bc\ndef");
    keys(&mut e, &["^y", "^y"]);
    assert_eq!(e.text(), "abc\ndefbc\ndef");
    // the mark follows edits
    let mut e = table_editor("abc|", t.clone());
    press(&mut e, "^ ");
    e.set_selection(editor_core::Sel::caret(0));
    e.insert_text("xy");
    assert_eq!(e.mark(), Some(5));
    // selectParagraph ($^e here): the line with its newline
    let mut e = table_editor("ab\nc|d\nef", t);
    press(&mut e, "^E");
    assert_eq!(show(&e), "ab\n[[cd\n]]ef");
}

// ---------------------------------------------------------------------------------------------
// Movement

#[test]
fn ctrl_a_and_e_go_to_the_paragraph_ends_and_shift_extends() {
    // the end is after hidden closing markers, as Cmd-Right; the start is the text start, then
    // column 0 (before the list token), as Cmd-Left
    assert_eq!(after("- one **tw|o**\nnext", &["^e"]), "- one **two**|\nnext");
    assert_eq!(after("- one **tw|o**\nnext", &["^a"]), "- |one **two**\nnext");
    assert_eq!(after("- one **tw|o**\nnext", &["^a", "^a"]), "|- one **two**\nnext");
    assert_eq!(after("one\ntw|o", &["^e", "^e"]), "one\ntwo|");
    assert_eq!(after("one\ntw|o", &["^A"]), "one\n[[tw]]o");
    assert_eq!(after("one\ntw|o", &["^A", "^E"]), "one\ntw[[o]]");
    assert_eq!(after("o|ne\ntwo", &["^E"]), "o[[ne]]\ntwo");
    // paragraph = logical line: the same as Cmd-Left/Right on an unwrapped line
    for m in ["^a", "^e", "^A", "^E"] {
        let cmd = m.replace('^', "@").replace('a', "←").replace('e', "→").replace('A', "$←").replace('E', "$→");
        assert_eq!(after("- one **tw|o**\nnext", &[m]), after("- one **tw|o**\nnext", &[&cmd]), "{m}");
    }
}

#[test]
fn ctrl_f_and_b_step_like_the_arrows_over_hidden_markers() {
    let md = "a **b** [l](http://x.y) \\* é\n- c";
    let n = md.len();
    for p in 0..=n {
        if !md.is_char_boundary(p) {
            continue;
        }
        let at = format!("{}|{}", &md[..p], &md[p..]);
        assert_eq!(after(&at, &["^f"]), after(&at, &["→"]), "Ctrl-F at {p}");
        assert_eq!(after(&at, &["^b"]), after(&at, &["←"]), "Ctrl-B at {p}");
        assert_eq!(after(&at, &["^F", "^F"]), after(&at, &["$→", "$→"]), "Ctrl-Shift-F at {p}");
        assert_eq!(after(&at, &["^B"]), after(&at, &["$←"]), "Ctrl-Shift-B at {p}");
        assert_eq!(after(&at, &["~^f"]), after(&at, &["~→"]), "Ctrl-Option-F at {p}");
        assert_eq!(after(&at, &["~^b"]), after(&at, &["~←"]), "Ctrl-Option-B at {p}");
        assert_eq!(after(&at, &["~^F"]), after(&at, &["~$→"]), "Ctrl-Option-Shift-F at {p}");
        assert_eq!(after(&at, &["~^B"]), after(&at, &["~$←"]), "Ctrl-Option-Shift-B at {p}");
    }
    // a selection collapses (Cocoa: to its start / end)
    assert_eq!(after("a[[bc]]d", &["^f"]), "abc|d");
    assert_eq!(after("a[[bc]]d", &["^b"]), "a|bcd");
}

#[test]
fn ctrl_n_and_p_move_by_line_keeping_the_goal_x() {
    let md = "abcdef\nab\nabcdef";
    assert_eq!(after("abcde|f\nab\nabcdef", &["^n"]), "abcdef\nab|\nabcdef");
    assert_eq!(after("abcde|f\nab\nabcdef", &["^n", "^n"]), "abcdef\nab\nabcde|f");
    assert_eq!(after("abcdef\nab\nabcde|f", &["^p", "^p"]), "abcde|f\nab\nabcdef");
    // mixed with the arrows, the goal x carries over
    assert_eq!(after("abcde|f\nab\nabcdef", &["^n", "↓"]), "abcdef\nab\nabcde|f");
    assert_eq!(after("abcde|f\nab\nabcdef", &["^N", "^N"]), "abcde[[f\nab\nabcde]]f");
    assert_eq!(after("abcdef\nab\nabcde|f", &["^P"]), "abcdef\nab[[\nabcde]]f");
    // the edges: document start / end
    assert_eq!(after("ab|c", &["^p"]), "|abc");
    assert_eq!(after("ab|c", &["^n"]), "abc|");
    let mut e = mac("abcde|f\nab\nabcdef");
    press(&mut e, "^n");
    assert_eq!(e.goal_x(), Some(50.0));
    assert_eq!(e.text(), md);
}

#[test]
fn ctrl_n_and_p_and_ctrl_f_skip_folded_sections_like_the_arrows() {
    let md = "# A\na1\n# C\nc1";
    for (p, cs) in [(1, ["^n", "↓"]), (12, ["^p", "↑"]), (3, ["^f", "→"]), (10, ["^b", "←"]), (1, ["^e", "@→"])] {
        let run = |c: &str| {
            let mut e = mac(md);
            e.toggle_fold(0);
            e.set_selection(editor_core::Sel::caret(p));
            press(&mut e, c);
            (show(&e), e.folded_lines())
        };
        assert_eq!(run(cs[0]), run(cs[1]), "{cs:?} at {p}");
    }
    let mut e = mac(md);
    e.toggle_fold(0);
    e.set_selection(editor_core::Sel::caret(1));
    press(&mut e, "^n");
    assert_eq!(e.doc().line_of(e.selection().head).index, 2);
    assert_eq!(e.folded_lines(), vec![0]);
}

/// The keys the macOS table maps to what Grimoire already did, in a document with markers,
/// tokens, a table, a code block and a folded heading.
#[test]
fn keys_that_already_worked_behave_as_before() {
    let md = "# Head **b**\n- item _it_ [l](http://u)\n  - nested\n| a | b |\n|---|---|\n| c | d |\n```\ncode\n```\nplain \\* text\n# Two\nend";
    let same = [
        "←", "→", "↑", "↓", "$←", "$→", "$↑", "$↓", "~←", "~→", "~$←", "~$→", "~↑", "~↓", "~$↑", "~$↓", "@←", "@→", "@$←",
        "@$→", "@↑", "@↓", "@$↑", "@$↓", "⌫", "~⌫", "@⌫", "~^⌫", "⌦", "~⌦", "@⌦", "↩", "$↩", "~↩", "⇥", "$⇥", "^h", "^d", "^k",
        "@b", "@i", "@z", "@$z", "@a", "↖", "↘",
    ];
    let mut legacy = Editor::new(md);
    legacy.toggle_fold(legacy.doc().lines.iter().position(|l| l.from == md.find("# Two").unwrap()).unwrap());
    let n = md.len();
    for c in same {
        let (k, m) = chord(c);
        for p in (0..=n).filter(|&p| md.is_char_boundary(p)) {
            let run = |table: bool| {
                let mut e = legacy.clone();
                if table {
                    e.set_key_table(Some(Arc::new(KeyTable::standard())));
                }
                e.set_selection(editor_core::Sel::caret(p));
                let p0 = e.selection();
                let l = MonoLayout::new(&e);
                let r = e.key(k, m, &l).is_some();
                // and a second press from there (two-stage keys, undo groups)
                let l = MonoLayout::new(&e);
                e.key(k, m, &l);
                (r, p0, show(&e), e.folded_lines(), e.can_undo())
            };
            assert_eq!(run(true), run(false), "{c} at {p}");
        }
    }
}

#[test]
fn keys_cocoa_binds_differently_now_follow_cocoa() {
    // Shift-Home/End select to the document's start / end (plain Home/End still only scroll)
    assert_eq!(after("ab|c\nd", &["$↖"]), "[[ab]]c\nd");
    assert_eq!(after("ab|c\nd", &["$↘"]), "ab[[c\nd]]");
    let mut e = mac("ab|c");
    assert_eq!(press(&mut e, "↖"), Some(Command::ScrollToStart));
    assert_eq!(press(&mut e, "↘"), Some(Command::ScrollToEnd));
    assert_eq!(show(&e), "ab|c");
    // Ctrl-Left/Right: line ends (Shift extends)
    assert_eq!(after("- one tw|o", &["^←"]), "- |one two");
    assert_eq!(after("- one tw|o", &["^←", "^←"]), "|- one two");
    assert_eq!(after("- o|ne two", &["^→"]), "- one two|");
    assert_eq!(after("- o|ne two", &["^$→"]), "- o[[ne two]]");
    assert_eq!(after("- one tw|o", &["^$←"]), "- [[one tw]]o");
    // Ctrl-Return: a raw newline, as Shift-Return (no list continuation)
    assert_eq!(after("- one|", &["^↩"]), "- one\n|");
    assert_eq!(after("- one|", &["↩"]), "- one\n- |");
    // Ctrl-Up/Down (scrollPage…) aren't implemented: not the editor's
    let mut e = mac("ab|c");
    assert_eq!(press(&mut e, "^↑"), None);
    assert_eq!(press(&mut e, "^↓"), None);
    // Option-Tab inserts what Tab does
    assert_eq!(after("ab|", &["~⇥"]), after("ab|", &["⇥"]));
}

#[test]
fn paging_and_centering_are_left_to_the_ui() {
    let mut e = mac("ab|c");
    let page = |dir, extend| Some(Command::Page { dir, extend });
    assert_eq!(press(&mut e, "⇟"), page(1, false));
    assert_eq!(press(&mut e, "⇞"), page(-1, false));
    assert_eq!(press(&mut e, "$⇟"), page(1, true));
    assert_eq!(press(&mut e, "$⇞"), page(-1, true));
    assert_eq!(press(&mut e, "~⇟"), page(1, false));
    assert_eq!(press(&mut e, "~⇞"), page(-1, false));
    assert_eq!(press(&mut e, "^v"), page(1, false));
    assert_eq!(press(&mut e, "^V"), page(1, true));
    assert_eq!(press(&mut e, "^l"), Some(Command::CenterSelection));
    assert_eq!(show(&e), "ab|c");
    // a user can have Cocoa's scrolling PageDown back... once it's implemented: unknown
    // selectors leave the binding as it was
    let mut t = KeyTable::standard();
    assert_eq!(t.add_dict(r#"{ "\UF72D" = "scrollPageDown:"; }"#), Ok(0));
    assert_eq!(t.lookup(Key::PageDown, Mods::NONE), Some(&[Command::Page { dir: 1, extend: false }][..]));
}

/// A monospace layout that wraps every line at `cols` characters (plain text only): rows of
/// 20 px, 10 px columns; an offset at a wrap point draws at the start of the next row.
struct Wrap<'a> {
    text: &'a str,
    cols: usize,
}

impl Wrap<'_> {
    /// (line start, line len, first row) per line.
    fn lines(&self) -> Vec<(usize, usize, usize)> {
        let mut out = Vec::new();
        let (mut from, mut row) = (0, 0);
        for l in self.text.split('\n') {
            out.push((from, l.len(), row));
            row += l.len().max(1).div_ceil(self.cols);
            from += l.len() + 1;
        }
        out
    }
}

impl Layout for Wrap<'_> {
    fn caret_rect(&self, pos: usize) -> Rect {
        let ls = self.lines();
        let &(from, _, row) = ls.iter().rev().find(|l| l.0 <= pos).unwrap();
        let col = pos - from;
        let (r, c) = (col / self.cols, col % self.cols);
        let (r, c) = if c == 0 && r > 0 && pos == from + ls.iter().find(|l| l.0 == from).unwrap().1 { (r - 1, self.cols) } else { (r, c) };
        let top = ((row + r) * 20) as f64;
        Rect { left: (c * 10) as f64, top, bottom: top + 20.0 }
    }
    fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
        let row = (y / 20.0).floor().max(0.0) as usize;
        let &(from, len, first) = self.lines().iter().rev().find(|l| l.2 <= row)?;
        let r = row - first;
        let c = ((x / 10.0).round().max(0.0) as usize).min(self.cols);
        Some(from + (r * self.cols + c).min(len))
    }
    fn bounds(&self) -> Bounds {
        let rows = self.lines().last().map_or(1, |l| l.2 + l.1.max(1).div_ceil(self.cols));
        Bounds { left: 0.0, top: 0.0, right: (self.cols * 10) as f64, bottom: (rows * 20) as f64 }
    }
}

#[test]
fn cmd_left_and_right_go_to_the_visual_line_ends_ctrl_a_and_e_to_the_paragraph() {
    // "aaaa " / "bbbb " / "cccc" at 5 columns
    let md = "aaaa bbbb cccc\nnext";
    let run = |p: usize, cs: &[&str]| {
        let mut e = mac(md);
        e.set_selection(editor_core::Sel::caret(p));
        for c in cs {
            let (k, m) = chord(c);
            let l = Wrap { text: md, cols: 5 };
            e.key(k, m, &l);
        }
        show(&e)
    };
    // the middle row: its start, its end (before the space the next row starts after)
    assert_eq!(run(7, &["@←"]), "aaaa |bbbb cccc\nnext");
    assert_eq!(run(7, &["@←", "@←"]), "aaaa |bbbb cccc\nnext");
    assert_eq!(run(7, &["@→"]), "aaaa bbbb| cccc\nnext");
    assert_eq!(run(7, &["@→", "@→"]), "aaaa bbbb| cccc\nnext");
    assert_eq!(run(7, &["^→"]), "aaaa bbbb| cccc\nnext");
    assert_eq!(run(7, &["@$→"]), "aaaa bb[[bb]] cccc\nnext");
    assert_eq!(run(7, &["@$←"]), "aaaa [[bb]]bb cccc\nnext");
    // the first and last rows: the paragraph's ends
    assert_eq!(run(2, &["@←"]), "|aaaa bbbb cccc\nnext");
    assert_eq!(run(12, &["@→"]), "aaaa bbbb cccc|\nnext");
    assert_eq!(run(12, &["@←"]), "aaaa bbbb |cccc\nnext");
    // Ctrl-A/E: the whole paragraph
    assert_eq!(run(7, &["^a"]), "|aaaa bbbb cccc\nnext");
    assert_eq!(run(7, &["^e"]), "aaaa bbbb cccc|\nnext");
}

// ---------------------------------------------------------------------------------------------
// Editing

#[test]
fn ctrl_d_and_h_delete_like_delete_and_backspace_with_the_same_undo_groups() {
    for (ctrl, key) in [("^d", "⌦"), ("^h", "⌫")] {
        for md in ["ab|c", "- |x", "a\n|b", "**b|**", "[[ab]]c", "| a |\n|---|\n| b| |"] {
            let run = |c: &str| {
                let mut e = mac(md);
                e.insert_text("xy");
                keys(&mut e, &[c, c]);
                let s = show(&e);
                e.undo();
                (s, show(&e))
            };
            assert_eq!(run(ctrl), run(key), "{ctrl} in {md}");
        }
    }
}

#[test]
fn ctrl_k_kills_to_the_paragraph_end_and_ctrl_y_yanks() {
    // as TextEdit: three kills in a row are one kill buffer; Ctrl-Y puts it back
    let mut e = mac("a|bc\ndef\nghi");
    keys(&mut e, &["^k", "^k", "^k"]);
    assert_eq!(show(&e), "a|\nghi");
    assert_eq!(e.kill_buffer(), "bc\ndef");
    press(&mut e, "^y");
    assert_eq!(show(&e), "abc\ndef|\nghi");
    // a move in between starts a new kill
    let mut e = mac("a|bc\ndef\nghi");
    keys(&mut e, &["^k", "→", "^k", "@↓", "^y"]);
    assert_eq!(show(&e), "a\n\nghidef|");
    // on an empty line it deletes the newline; at a line end it joins the next line
    assert_eq!(after("a\n|\nb", &["^k"]), "a\n|b");
    assert_eq!(after("a|\nb", &["^k"]), "a|b");
    // a selection is killed whole
    let mut e = mac("a[[bc]]d");
    press(&mut e, "^k");
    assert_eq!((show(&e).as_str(), e.kill_buffer()), ("a|d", "bc"));
    // word and line deletes are kills too (backwards ones go in front); the clipboard isn't touched
    let mut e = mac("one two three|");
    keys(&mut e, &["~⌫", "~⌫"]);
    assert_eq!(e.kill_buffer(), "two three");
    assert_eq!(e.copy(), None);
    keys(&mut e, &["@↑", "^y"]);
    assert_eq!(show(&e), "two three|one ");
    let mut e = mac("abc def|");
    keys(&mut e, &["@⌫", "^y", "^y"]);
    assert_eq!(e.text(), "abc defabc def");
    // undo: Ctrl-K groups like Cmd-Delete; a yank is its own step
    let run = |c: &str| {
        let mut e = mac("ab|cd\nef");
        e.insert_text("x");
        keys(&mut e, &[c, c]);
        e.undo();
        show(&e)
    };
    assert_eq!(run("^k"), run("@⌦"));
    let mut e = mac("ab|cd");
    keys(&mut e, &["^k", "^a"]);
    e.insert_text("x");
    press(&mut e, "^y");
    assert_eq!(show(&e), "xcd|ab");
    e.undo();
    assert_eq!(show(&e), "x|ab");
    // nothing killed: Ctrl-Y does nothing; the buffer survives a new editor (the app's notes)
    let mut e = mac("ab|");
    assert_eq!(press(&mut e, "^y"), Some(Command::Yank));
    assert_eq!(e.text(), "ab");
    e.set_kill_buffer("zz");
    press(&mut e, "^y");
    assert_eq!(show(&e), "abzz|");
}

#[test]
fn ctrl_k_at_a_folded_heading_end_unfolds_first_like_cmd_delete() {
    let run = |c: &str| {
        let mut e = mac("# A\na1\n# C\nc1");
        e.toggle_fold(0);
        e.set_selection(editor_core::Sel::caret(3));
        press(&mut e, c);
        (show(&e), e.folded_lines())
    };
    assert_eq!(run("^k"), run("@⌦"));
    assert_eq!(run("^k").0, "# A|a1\n# C\nc1");
}

#[test]
fn ctrl_t_transposes_as_textedit_does() {
    // the cases checked against NSTextView
    assert_eq!(after("ab|c\ndef", &["^t"]), "acb|\ndef");
    assert_eq!(after("abc|\ndef", &["^t"]), "acb|\ndef");
    assert_eq!(after("abc\n|def", &["^t"]), "abcd\n|ef");
    assert_eq!(after("|abc\ndef", &["^t"]), "|abc\ndef");
    assert_eq!(after("abc\ndef|", &["^t"]), "abc\ndfe|");
    assert_eq!(after("a|\nb", &["^t"]), "a|\nb");
    assert_eq!(after("a[[b]]c", &["^t"]), "a[[b]]c");
    // repeated, a character travels right
    assert_eq!(after("|abcd", &["^f", "^t", "^t", "^t"]), "bcda|");
    // grapheme clusters move whole
    assert_eq!(after("ae\u{301}|x", &["^t"]), "axe\u{301}|");
    // syntax doesn't move: markers, tokens, escapes, URLs, pipes; nor newlines next to lists
    assert_eq!(after("**ab**|c", &["^t"]), "**ab**|c");
    assert_eq!(after("- |ab", &["^t"]), "- |ab");
    assert_eq!(after("- a|bc", &["^t"]), "- ba|c");
    assert_eq!(after("- ab\n|cd", &["^t"]), "- ab\n|cd");
    assert_eq!(after("a\\*|b", &["^t"]), "a\\*|b");
    assert_eq!(after("[l](|http://x)", &["^t"]), "[l](|http://x)");
    let t = "| ab | c |\n|---|---|\n| x | y |";
    let at = |p: usize| {
        let mut e = mac("");
        e.set_text(t);
        e.set_selection(editor_core::Sel::caret(p));
        press(&mut e, "^t");
        e.text().to_string()
    };
    assert_eq!(at(3), "| ba | c |\n|---|---|\n| x | y |");
    for p in [5, 6] {
        assert_eq!(at(p), t, "next to a pipe at {p}");
    }
    // one undo step, and read-only blocks it
    let mut e = mac("ab|c");
    press(&mut e, "^t");
    e.undo();
    assert_eq!(e.text(), "abc");
    let mut e = mac("ab|c");
    e.set_read_only(true);
    assert_eq!(press(&mut e, "^t"), None);
    assert_eq!(show(&e), "ab|c");
}

#[test]
fn ctrl_o_opens_a_line_after_the_caret() {
    assert_eq!(after("ab|c def", &["^o"]), "ab|\nc def");
    assert_eq!(after("- ab|c", &["^o"]), "- ab|\nc");
    assert_eq!(after("a[[b]]c", &["^o"]), "a|\nc");
    let mut e = mac("ab|c");
    keys(&mut e, &["^o", "^o"]);
    assert_eq!(show(&e), "ab|\n\nc");
    e.undo();
    assert_eq!(e.text(), "abc");
}

#[test]
fn ctrl_backspace_deletes_the_last_part_of_a_character() {
    assert_eq!(after("cafe\u{301}|", &["^⌫"]), "cafe|");
    assert_eq!(after("abc|", &["^⌫"]), "ab|");
    assert_eq!(after("a[[bc]]", &["^⌫"]), "a|");
    #[cfg(feature = "decompose")]
    {
        assert_eq!(after("caf\u{e9}|", &["^⌫"]), "cafe|");
        // 한 (ㅎ ㅏ ㄴ) -> 하
        assert_eq!(after("\u{d55c}|", &["^⌫"]), "\u{d558}|");
    }
}

#[test]
fn ctrl_quotes_insert_without_typing_rules() {
    assert_eq!(after("a|", &["^\""]), "a\"|");
    assert_eq!(after("a|", &["^'"]), "a'|");
    // with Shift held (how '"' is typed), the same
    let mut e = mac("a|");
    let (k, mut m) = chord("^\"");
    m.shift = true;
    e.key(k, m, &MonoLayout::new(&Editor::new("a")));
    assert_eq!(show(&e), "a\"|");
}

#[test]
fn read_only_blocks_edits_but_moves() {
    let mut e = mac("a|bc\ndef");
    e.set_read_only(true);
    for c in ["^k", "^y", "^t", "^o", "^d", "^h", "^⌫"] {
        assert_eq!(press(&mut e, c), None, "{c}");
    }
    assert_eq!(show(&e), "a|bc\ndef");
    keys(&mut e, &["^e", "^n"]);
    assert_eq!(show(&e), "abc\ndef|");
    keys(&mut e, &["^a", "^p", "^f"]);
    assert_eq!(show(&e), "a|bc\ndef");
}

#[test]
fn every_standard_binding_is_implemented_or_known_to_be_skipped() {
    // selectors of StandardKeyBinding.dict left out on purpose (see the README)
    let skipped = [
        "cancelOperation:",
        "complete:",
        "cycleToNextInputScript:",
        "cycleToNextInputKeyboardLayout:",
        "togglePlatformInputSystem:",
        "makeBaseWritingDirectionNatural:",
        "makeBaseWritingDirectionRightToLeft:",
        "makeBaseWritingDirectionLeftToRight:",
        "makeTextWritingDirectionNatural:",
        "makeTextWritingDirectionRightToLeft:",
        "makeTextWritingDirectionLeftToRight:",
        "selectNextKeyView:",
        "selectPreviousKeyView:",
        "insertRightToLeftSlash:",
        "scrollPageUp:",
        "scrollPageDown:",
        "delete:",
    ];
    for (k, v) in parse_dict(macos_keys::STANDARD).unwrap() {
        let names: Vec<String> = match &v {
            Value::Str(s) => vec![s.clone()],
            Value::List(l) => l.iter().map(|x| if let Value::Str(s) = x { s.clone() } else { String::new() }).collect(),
            Value::Dict(_) => unreachable!(),
        };
        for n in names {
            assert!(macos_keys::selector(&n).is_some() || skipped.contains(&n.as_str()), "{k:?} = {n}");
        }
    }
}
