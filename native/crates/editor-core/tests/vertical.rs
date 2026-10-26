//! Up/Down with `Layout::adjacent_line_y` (MonoLayout answers it) and with the probing fallback
//! (a layout that doesn't): both must land on the same offsets.

use editor_core::{Bounds, Editor, Key, Layout, Mods, MonoLayout, Rect, Sel};

/// MonoLayout without `adjacent_line_y`: Up/Down probe in `probe_step`s.
struct Probe(MonoLayout);

impl Layout for Probe {
    fn caret_rect(&self, pos: usize) -> Rect {
        self.0.caret_rect(pos)
    }
    fn hit_test(&self, x: f64, y: f64) -> Option<usize> {
        self.0.hit_test(x, y)
    }
    fn bounds(&self) -> Bounds {
        self.0.bounds()
    }
    fn table_cell_at(&self, line: usize, x: f64, y: f64) -> Option<usize> {
        self.0.table_cell_at(line, x, y)
    }
    fn line_mid_y(&self, line: usize) -> Option<f64> {
        self.0.line_mid_y(line)
    }
}

/// Every caret stop of `text`, then `keys` Up/Down presses from it, with both layouts.
fn walk(text: &str, keys: &[Key]) {
    let base = Editor::new(text);
    let mut starts = vec![];
    let mut p = 0;
    loop {
        starts.push(p);
        let mut e = base.clone();
        e.set_selection(Sel::caret(p));
        e.move_horizontal(1, false, editor_core::HUnit::Char);
        let q = e.selection().head;
        if q <= p {
            break;
        }
        p = q;
    }
    for &s in &starts {
        let (mut a, mut b) = (base.clone(), base.clone());
        a.set_selection(Sel::caret(s));
        b.set_selection(Sel::caret(s));
        for (i, &key) in keys.iter().enumerate() {
            let la = MonoLayout::new(&a);
            a.key(key, Mods::NONE, &la);
            let lb = Probe(MonoLayout::new(&b));
            b.key(key, Mods::NONE, &lb);
            assert_eq!(a.selection(), b.selection(), "{text:?} from {s}, key {i}");
            assert_eq!(a.goal_x(), b.goal_x());
        }
    }
}

#[test]
fn adjacent_line_y_and_probing_agree() {
    use Key::{Down, Up};
    let docs = [
        "first line of text\nsh\nthird line of text",
        "# Big heading here\n- bullet item text\n```\ncode line here\n```\nplain paragraph",
        "xxxxxxxxxxxxxxxxxxxxxxxx\naaaaaaaaa **bold** tail",
        "x\n- item a\n- item b\n# Head",
        "| a | b |\n| --- | --- |\n| one | two |\n\nafter the table",
        "intro\n![img](a.png)\ntext ![b](b.png) more\nend",
        "",
        "\n\n\n",
    ];
    for d in docs {
        walk(d, &[Down, Down, Down, Up, Up, Up, Up]);
        walk(d, &[Up, Down, Down, Up]);
    }
}

#[test]
fn mono_layout_adjacent_lines() {
    let e = Editor::new("a\nb\nc");
    let l = MonoLayout::new(&e);
    assert_eq!(l.adjacent_line_y(0, -1), None);
    assert_eq!(l.adjacent_line_y(0, 1), Some(30.0));
    assert_eq!(l.adjacent_line_y(2, -1), Some(10.0));
    assert_eq!(l.adjacent_line_y(4, 1), None);
}
