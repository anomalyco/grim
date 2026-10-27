//! Our tokens against @pierre/highlights 0.3.0's own (`tests/fixtures/expected.json`, written by
//! `tests/fixtures/gen.ts` with bun from the npm package's `LiveTokenizer.getLineRecords`).

use highlight::{Highlighter, Theme, Tokenizer, info_lang, lang_id};
use serde_json::Value;

const THEME: &str = include_str!("../../app/assets/highlight-theme.json");

fn hl() -> Highlighter {
    Highlighter::new().unwrap()
}

fn expected() -> Value {
    serde_json::from_str(include_str!("fixtures/expected.json")).unwrap()
}

/// Each line as [token name, text] runs, like the fixture.
fn runs(t: &Tokenizer) -> Value {
    let lines: Vec<Value> = (0..t.line_count())
        .map(|l| {
            let text = t.line_text(l);
            t.line_tokens(l).iter().map(|k| serde_json::json!([k.name(), &text[k.start as usize..k.end as usize]])).collect()
        })
        .collect();
    Value::Array(lines)
}

fn byte_of(text: &str, line: u64, ch: u64) -> usize {
    let start: usize = text.split('\n').take(line as usize).map(|l| l.len() + 1).sum();
    let mut units = 0;
    for (i, c) in text[start..].char_indices() {
        if units >= ch as usize {
            return start + i;
        }
        units += c.len_utf16();
    }
    text.len()
}

#[test]
fn snippets_match_the_js_library() {
    let hl = hl();
    for s in expected()["snippets"].as_array().unwrap() {
        let lang = s["lang"].as_str().unwrap();
        let t = hl.tokenizer(lang_id(lang).unwrap(), s["code"].as_str().unwrap()).unwrap();
        assert_eq!(runs(&t), s["lines"], "{lang}");
    }
}

#[test]
fn edits_match_the_js_library() {
    let hl = hl();
    for case in expected()["edits"].as_array().unwrap() {
        let lang = lang_id(case["lang"].as_str().unwrap()).unwrap();
        let mut t = hl.tokenizer(lang, case["code"].as_str().unwrap()).unwrap();
        let mut whole = hl.tokenizer(lang, case["code"].as_str().unwrap()).unwrap();
        for step in case["steps"].as_array().unwrap() {
            let e = &step["edit"];
            let r = &e["range"];
            let text = t.text().to_string();
            let a = byte_of(&text, r["start"]["line"].as_u64().unwrap(), r["start"]["character"].as_u64().unwrap());
            let b = byte_of(&text, r["end"]["line"].as_u64().unwrap(), r["end"]["character"].as_u64().unwrap());
            t.replace(a, b, e["newText"].as_str().unwrap()).unwrap();
            assert_eq!(t.text(), step["text"].as_str().unwrap());
            assert_eq!(runs(&t), step["lines"], "{e}");
            // the same through set_text (prefix/suffix diff)
            whole.set_text(step["text"].as_str().unwrap()).unwrap();
            assert_eq!(runs(&whole), step["lines"], "set_text {e}");
        }
    }
}

/// Incremental results equal a fresh tokenization after every edit of a long edit sequence:
/// typing a TS file character by character, opening and closing a block comment and a string,
/// deleting lines, pasting a block, undoing back.
#[test]
fn incremental_equals_fresh() {
    let hl = hl();
    let ts = lang_id("ts").unwrap();
    let target = "/** Doc */\nexport function f(a: number): string {\n  const s = `x ${a} é🙂`;\n  return s + \"y\"; // done\n}\n";
    let mut t = hl.tokenizer(ts, "").unwrap();
    let mut history = vec![String::new()];
    for (i, _) in target.char_indices().skip(1).chain([(target.len(), ' ')]) {
        t.set_text(&target[..i]).unwrap();
        history.push(target[..i].to_string());
        assert_eq!(runs(&t), runs(&hl.tokenizer(ts, &target[..i]).unwrap()), "typed {:?}", &target[..i]);
    }
    let edits = [
        target.replacen("export", "/* export", 1),
        target.replacen("export", "/* export", 1).replacen("string {", "string */ {", 1),
        target.replacen("\"y\"", "\"y", 1),
        target.replacen("  const s = `x ${a} é🙂`;\n", "", 1),
        target.repeat(3),
        String::new(),
    ];
    for e in edits.iter().chain(history.iter().rev().step_by(7)) {
        t.set_text(e).unwrap();
        assert_eq!(runs(&t), runs(&hl.tokenizer(ts, e).unwrap()), "{e:?}");
    }
}

#[test]
fn set_text_reports_changes() {
    let hl = hl();
    let mut t = hl.tokenizer(lang_id("rust").unwrap(), "fn a() {}\nfn b() {}\nfn c() {}\n").unwrap();
    assert_eq!(t.set_text("fn a() {}\nfn b() {}\nfn c() {}\n").unwrap(), None);
    let ch = t.set_text("fn a() {}\nfn bb() {}\nfn c() {}\n").unwrap().unwrap();
    assert!(ch.iter().any(|c| c.new.contains(&1)) && ch.iter().all(|c| !c.new.contains(&0)), "{ch:?}");
    // a carriage return lexes as a space (the editor never has one in a line)
    t.set_text("let x = 1;\r").unwrap();
    assert_eq!(t.line_count(), 1);
}

#[test]
fn languages_and_info_strings() {
    assert_eq!(lang_id("TypeScript"), lang_id("ts"));
    assert_eq!(lang_id("rs"), Some(96));
    assert_eq!(lang_id("patch"), Some(highlight::DIFF));
    assert_eq!(lang_id("C++"), Some(19));
    assert_eq!(lang_id("nope"), None);
    assert_eq!(info_lang("  Python title=\"x.py\""), Some(90));
    assert_eq!(info_lang("text"), None);
    assert_eq!(info_lang(""), None);
    assert_eq!(info_lang("klingon"), None);
    assert_eq!(highlight::LANGUAGES.len(), 299);
    assert!(highlight::LANGUAGES.windows(2).all(|w| w[0].0 < w[1].0));
}

#[test]
fn theme_resolves_the_longest_prefix() {
    let th = Theme::parse(THEME).unwrap();
    let id = |n: &str| highlight::TOKEN_NAMES.iter().position(|&t| t == n).unwrap() as u8;
    assert_eq!(th.style(id("keyword.control")).color, "#296d9a");
    assert_eq!(th.style(id("keyword.operator")).color, "#62626a");
    let c = th.style(id("comment.doc"));
    assert!(c.italic && !c.bold && c.color == "#7a7b82");
    assert!(th.style(id("title")).bold);
    // no entry: the foreground
    assert_eq!(th.style(id("variable")).color, th.foreground);
    assert!(th.is_plain(id("variable")) && th.is_plain(0) && !th.is_plain(id("emphasis")));
    // emphasis is italic only, in the foreground
    assert!(th.style(id("emphasis")).italic && th.style(id("emphasis")).color == th.foreground);
    assert_eq!(th.style(id("string.special.symbol")).color, "#2f7a6e");
}

#[test]
fn diff_line_backgrounds() {
    let hl = hl();
    let th = Theme::parse(THEME).unwrap();
    let t = hl.tokenizer(highlight::DIFF, "@@ -1 +1 @@\n context\n-old\n+new\n-\n+\n--- a/x\n+++ b/x").unwrap();
    let bgs: Vec<_> = (0..t.line_count()).map(|l| th.line_bg(highlight::DIFF, t.line_tokens(l), t.line_text(l))).collect();
    let (p, m) = (Some("#e9f3ec"), Some("#f7efe5"));
    assert_eq!(bgs, [None, None, m, p, m, p, m, p]);
    // a lone "+" outside a diff is just text
    let ts = hl.tokenizer(lang_id("ts").unwrap(), "+").unwrap();
    assert_eq!(th.line_bg(lang_id("ts").unwrap(), ts.line_tokens(0), "+"), None);
}
