#![allow(dead_code)]

use editor_core::parser::{Doc, parse_doc};
use editor_core::rules::{Edit, apply_changes};
use editor_core::units::Sel;

/// Parse "text with | caret" or "[[sel]]" markup.
pub fn st(s: &str) -> (String, Sel) {
    if let Some(i) = s.find('|') {
        return (format!("{}{}", &s[..i], &s[i + 1..]), Sel::caret(i));
    }
    let a = s.find("[[").unwrap();
    let b = s.find("]]").unwrap() - 2;
    (s.replacen("[[", "", 1).replacen("]]", "", 1), Sel::new(a, b))
}

pub fn show_sel(out: &str, sel: Sel) -> String {
    if sel.is_empty() {
        return format!("{}|{}", &out[..sel.head], &out[sel.head..]);
    }
    let (a, b) = (sel.from(), sel.to());
    format!("{}[[{}]]{}", &out[..a], &out[a..b], &out[b..])
}

pub fn show(text: &str, e: Option<Edit>) -> String {
    let Some(mut e) = e else { return "null".into() };
    let mut out = apply_changes(text, &e.changes);
    while let Some(t) = e.then.take() {
        e = *t;
        out = apply_changes(&out, &e.changes);
    }
    show_sel(&out, e.sel)
}

pub fn run(s: &str, f: impl Fn(&Doc, Sel) -> Option<Edit>) -> String {
    let (text, sel) = st(s);
    show(&text, f(&parse_doc(&text), sel))
}

pub fn sl(text: &str, r: (usize, usize)) -> &str {
    &text[r.0..r.1]
}
