//! Line-list diffing (minimal splice), stable line keys and the minimal text edit.

use editor_core::LineView;

/// Same view and same raw text (offsets equal too).
pub fn line_eq(a: &LineView, at: &str, b: &LineView, bt: &str) -> bool {
    a == b && at[a.from..a.to] == bt[b.from..b.to]
}

/// Same view and text up to a shift of every offset (the line moved but looks the same).
pub fn shape_eq(a: &LineView, at: &str, b: &LineView, bt: &str) -> bool {
    let (fa, fb) = (a.from, b.from);
    let ra = |x: usize| x.wrapping_sub(fa);
    let rb = |x: usize| x.wrapping_sub(fb);
    at[a.from..a.to] == bt[b.from..b.to]
        && ra(a.to) == rb(b.to)
        && ra(a.text_from) == rb(b.text_from)
        && a.kind == b.kind
        && a.level == b.level
        && a.checked == b.checked
        && a.number == b.number
        && a.indent == b.indent
        && a.gutter_levels == b.gutter_levels
        && a.active == b.active
        && a.revealed == b.revealed
        && a.collapsed == b.collapsed
        && a.code == b.code
        && a.table == b.table
        && a.image_only == b.image_only
        && a.segments.len() == b.segments.len()
        && a.segments.iter().zip(&b.segments).all(|(x, y)| {
            x.kind == y.kind
                && ra(x.from) == rb(y.from)
                && ra(x.to) == rb(y.to)
                && x.styles == y.styles
                && x.hidden == y.hidden
                && x.token == y.token
                && x.cell == y.cell
                && x.el == y.el
        })
        && a.images.len() == b.images.len()
        && a.images.iter().zip(&b.images).all(|(x, y)| {
            ra(x.from) == rb(y.from)
                && ra(x.to) == rb(y.to)
                && ra(x.alt_range.0) == rb(y.alt_range.0)
                && ra(x.alt_range.1) == rb(y.alt_range.1)
                && x.alt == y.alt
                && x.src == y.src
                && x.title == y.title
                && x.revealed == y.revealed
        })
}

/// Replace `old[start..start + delete]` with `new[start..start + insert]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Splice {
    pub start: usize,
    pub delete: usize,
    pub insert: usize,
}

impl Splice {
    pub fn is_empty(&self) -> bool {
        self.delete == 0 && self.insert == 0
    }
}

fn prefix_suffix(n_old: usize, n_new: usize, eq: impl Fn(usize, usize) -> bool) -> (usize, usize) {
    let mut p = 0;
    while p < n_old && p < n_new && eq(p, p) {
        p += 1;
    }
    let mut s = 0;
    while s < n_old - p && s < n_new - p && eq(n_old - 1 - s, n_new - 1 - s) {
        s += 1;
    }
    (p, s)
}

/// The minimal splice turning `old` into `new` (common prefix and suffix of exactly equal lines).
pub fn diff_lines(old: &[LineView], ot: &str, new: &[LineView], nt: &str) -> Splice {
    let (p, s) = prefix_suffix(old.len(), new.len(), |i, j| line_eq(&old[i], ot, &new[j], nt));
    Splice { start: p, delete: old.len() - p - s, insert: new.len() - p - s }
}

/// Keys for the inserted lines of `sp`. Inside the replaced range, lines that only moved
/// (`shape_eq` common prefix/suffix) keep the key of the old line; the remaining lines are paired
/// in order with the remaining old lines (an edited line keeps its key); extra new lines get fresh
/// keys from `next`.
pub fn assign_keys(old: &[LineView], ot: &str, old_keys: &[u32], new: &[LineView], nt: &str, sp: Splice, next: &mut u32) -> Vec<u32> {
    let o = &old[sp.start..sp.start + sp.delete];
    let ok = &old_keys[sp.start..sp.start + sp.delete];
    let n = &new[sp.start..sp.start + sp.insert];
    let (p, s) = prefix_suffix(o.len(), n.len(), |i, j| shape_eq(&o[i], ot, &n[j], nt));
    (0..n.len())
        .map(|i| {
            if i < p {
                ok[i]
            } else if i >= n.len() - s {
                ok[o.len() - (n.len() - i)]
            } else if i - p < o.len() - p - s {
                ok[i]
            } else {
                *next += 1;
                *next
            }
        })
        .collect()
}

/// The minimal single replacement turning `old` into `new`: (byte from, byte to in `old`, insert).
pub fn text_edit<'a>(old: &str, new: &'a str) -> (usize, usize, &'a str) {
    let mut p = old.bytes().zip(new.bytes()).take_while(|(a, b)| a == b).count();
    while !old.is_char_boundary(p) || !new.is_char_boundary(p) {
        p -= 1;
    }
    let max_s = (old.len() - p).min(new.len() - p);
    let mut s = old.bytes().rev().zip(new.bytes().rev()).take(max_s).take_while(|(a, b)| a == b).count();
    while !old.is_char_boundary(old.len() - s) || !new.is_char_boundary(new.len() - s) {
        s -= 1;
    }
    (p, old.len() - s, &new[p..new.len() - s])
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::Editor;

    fn views(t: &str) -> (Vec<LineView>, String) {
        let ed = Editor::new(t);
        (ed.render_lines(), ed.text().to_string())
    }

    #[test]
    fn splice_is_minimal() {
        let (a, at) = views("one\ntwo\nthree");
        let (b, bt) = views("one\ntwX\nthree");
        assert_eq!(diff_lines(&a, &at, &b, &bt), Splice { start: 1, delete: 1, insert: 1 });
        // same length change: offsets equal, text differs
        let (c, ct) = views("one\ntwY\nthree");
        assert_eq!(diff_lines(&b, &bt, &c, &ct), Splice { start: 1, delete: 1, insert: 1 });
        assert!(diff_lines(&a, &at, &a, &at).is_empty());
        // a line inserted before the last: the last line moved (offsets/index), so it is resent
        let (d, dt) = views("one\ntwo\nnew\nthree");
        assert_eq!(diff_lines(&a, &at, &d, &dt), Splice { start: 2, delete: 1, insert: 2 });
    }

    #[test]
    fn keys_follow_moved_lines() {
        let (a, at) = views("one\ntwo\nthree\nfour");
        let keys = vec![1, 2, 3, 4];
        let mut next = 4;
        // insert a line after "one": "two".."four" moved; "one" unchanged
        let (b, bt) = views("one\nnew\ntwo\nthree\nfour");
        let sp = diff_lines(&a, &at, &b, &bt);
        assert_eq!(sp, Splice { start: 1, delete: 3, insert: 4 });
        let k = assign_keys(&a, &at, &keys, &b, &bt, sp, &mut next);
        assert_eq!(k, vec![5, 2, 3, 4]);
        // edit "two" (moves nothing after it, only the edited line is resent with its key)
        let (c, ct) = views("one\ntwo!\nthree\nfour");
        let sp = diff_lines(&a, &at, &c, &ct);
        let k = assign_keys(&a, &at, &keys, &c, &ct, sp, &mut next);
        assert_eq!((sp.start, k[0]), (1, 2));
        // join two lines: "three" removed, "two" edited, "four" moved
        let (d, dt) = views("one\ntwothree\nfour");
        let sp = diff_lines(&a, &at, &d, &dt);
        let k = assign_keys(&a, &at, &keys, &d, &dt, sp, &mut next);
        assert_eq!((sp, k), (Splice { start: 1, delete: 3, insert: 2 }, vec![2, 4]));
    }

    #[test]
    fn minimal_text_edit() {
        assert_eq!(text_edit("abc", "abXc"), (2, 2, "X"));
        assert_eq!(text_edit("abc", "ac"), (1, 2, ""));
        assert_eq!(text_edit("a😀b", "a😁b"), (1, 5, "😁"));
        assert_eq!(text_edit("aa", "aaa"), (2, 2, "a"));
        assert_eq!(text_edit("", "x"), (0, 0, "x"));
    }
}
