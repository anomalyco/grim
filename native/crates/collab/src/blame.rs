//! Line authors (the room's `{t:"blame"}` control message; docs/05-v1-architecture.md "Line authors" in the web
//! repo): who wrote each line of the server's text, and `attribute`, which moves the per-line values through a
//! text change between messages (the web's `src/shared/lineauthors.ts`, with `linePairs` from
//! `src/shared/textdiff.ts`).

use serde_json::Value;

/// One author of a blame message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlameAuthor {
    pub id: String,
    pub name: String,
    /// "human", "guest" or "agent".
    pub kind: String,
    pub color: String,
}

/// `authors`, and per line of the server's text (`split("\n")`) an index into them or -1 (unknown).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Blame {
    pub authors: Vec<BlameAuthor>,
    pub lines: Vec<i32>,
}

impl Blame {
    /// A blame message, checked as the web's `parseBlame`: every author needs a string id and name (else the
    /// whole message is ignored); a line value that isn't an author's index is -1; unknown fields are ignored.
    pub fn parse(msg: &Value) -> Option<Blame> {
        let (a, l) = (msg["authors"].as_array()?, msg["lines"].as_array()?);
        let mut authors = Vec::with_capacity(a.len());
        for x in a {
            let (id, name) = (x["id"].as_str()?, x["name"].as_str()?);
            let color = x["color"].as_str().filter(|c| c.len() >= 4 && c.len() <= 9 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit()));
            authors.push(BlameAuthor {
                id: id.into(),
                name: name.into(),
                kind: x["kind"].as_str().unwrap_or("human").into(),
                color: color.unwrap_or("#888").into(),
            });
        }
        let n = authors.len() as i64;
        let lines = l.iter().map(|v| v.as_i64().filter(|&i| i >= 0 && i < n).map_or(-1, |i| i as i32)).collect();
        Some(Blame { authors, lines })
    }
}

/// The values after the text changed from `prev` to `next` (`values`: one per line of `prev`, split at "\n"):
/// lines the change left as they were keep theirs, changed and new lines get `who` (`None`: each keeps the
/// value of the old line at its place in the change). Only the lines between the change's first and last
/// differing byte are diffed (by line).
pub fn attribute(prev: &str, next: &str, values: &[i32], who: Option<i32>) -> Vec<i32> {
    if prev == next {
        return values.to_vec();
    }
    let (pb, nb) = (prev.as_bytes(), next.as_bytes());
    let max = pb.len().min(nb.len());
    let mut p = 0;
    while p < max && pb[p] == nb[p] {
        p += 1;
    }
    let mut s = 0;
    while s < max - p && pb[pb.len() - 1 - s] == nb[nb.len() - 1 - s] {
        s += 1;
    }
    // the lines holding the changed range, whole
    let from = pb[..p].iter().rposition(|&c| c == b'\n').map_or(0, |i| i + 1);
    let first = pb[..from].iter().filter(|&&c| c == b'\n').count();
    let old_lines: Vec<&[u8]> = pb[from..line_end(pb, pb.len() - s)].split(|&c| c == b'\n').collect();
    let new_lines: Vec<&[u8]> = nb[from..line_end(nb, nb.len() - s)].split(|&c| c == b'\n').collect();
    let old = |i: usize| values.get(first + i).copied().unwrap_or(-1);
    let mut mid: Vec<i32> = (0..new_lines.len()).map(|i| who.unwrap_or_else(|| old(i.min(old_lines.len() - 1)))).collect();
    for (a, b) in line_pairs(&old_lines, &new_lines, 2000) {
        mid[b] = old(a);
    }
    let mut out = values[..first.min(values.len())].to_vec();
    out.extend(mid);
    out.extend(values.iter().skip(first + old_lines.len()));
    out
}

/// The end of the line holding byte `i` (its newline's index, or the text's end).
fn line_end(text: &[u8], i: usize) -> usize {
    text[i..].iter().position(|&c| c == b'\n').map_or(text.len(), |k| i + k)
}

/// Matching lines of `a` and `b` (index pairs, in order): common leading and trailing lines, then a Myers diff of
/// the middle when it has at most `max_middle` lines on both sides together (bigger middles stay unmatched).
pub fn line_pairs<T: PartialEq>(a: &[T], b: &[T], max_middle: usize) -> Vec<(usize, usize)> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let mut pairs: Vec<(usize, usize)> = (0..pre).map(|i| (i, i)).collect();
    let (ma, mb) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    if !ma.is_empty() && !mb.is_empty() && ma.len() + mb.len() <= max_middle {
        pairs.extend(lcs_pairs(ma, mb).into_iter().map(|(x, y)| (x + pre, y + pre)));
    }
    pairs.extend((1..=suf).rev().map(|i| (a.len() - i, b.len() - i)));
    pairs
}

/// Myers diff over slices: the matched index pairs, in order.
fn lcs_pairs<T: PartialEq>(a: &[T], b: &[T]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len() as i64, b.len() as i64);
    let max = n + m;
    let at = |k: i64| (k + max) as usize;
    let mut v = vec![0i64; (2 * max + 2) as usize];
    let mut trace: Vec<Vec<i64>> = Vec::new();
    for d in 0..=max {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) { v[at(k + 1)] } else { v[at(k - 1)] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[at(k)] = x;
            if x >= n && y >= m {
                let mut pairs = Vec::new();
                let (mut cx, mut cy) = (n, m);
                let mut dd = d;
                while dd > 0 {
                    let pv = &trace[dd as usize];
                    let kk = cx - cy;
                    let prev_k = if kk == -dd || (kk != dd && pv[at(kk - 1)] < pv[at(kk + 1)]) { kk + 1 } else { kk - 1 };
                    let px = pv[at(prev_k)];
                    let py = px - prev_k;
                    while cx > px && cy > py {
                        cx -= 1;
                        cy -= 1;
                        pairs.push((cx as usize, cy as usize));
                    }
                    cx = px;
                    cy = py;
                    dd -= 1;
                }
                while cx > 0 && cy > 0 {
                    cx -= 1;
                    cy -= 1;
                    pairs.push((cx as usize, cy as usize));
                }
                pairs.reverse();
                return pairs;
            }
            k += 2;
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_message_and_ignores_what_it_doesnt_know() {
        let b = Blame::parse(&json!({
            "t": "blame", "extra": 1,
            "authors": [{ "id": "u1", "name": "Ann", "kind": "human", "color": "#123456", "more": true }, { "id": "guest:x", "name": "moist-noodle", "kind": "guest" }],
            "lines": [0, 1, -1, 7, "x", 1],
        }))
        .unwrap();
        assert_eq!(b.authors[0], BlameAuthor { id: "u1".into(), name: "Ann".into(), kind: "human".into(), color: "#123456".into() });
        assert_eq!((b.authors[1].kind.as_str(), b.authors[1].color.as_str()), ("guest", "#888"));
        assert_eq!(b.lines, [0, 1, -1, -1, -1, 1]);
        assert!(Blame::parse(&json!({ "t": "blame", "authors": [{ "id": 3, "name": "x" }], "lines": [] })).is_none());
        assert!(Blame::parse(&json!({ "t": "blame", "lines": [] })).is_none());
    }

    /// The same results as the web's `attribute` (checked with bun on these inputs).
    #[test]
    fn attribute_moves_values_like_the_web() {
        let v = [0, 1, 2];
        // typing in a line: it becomes the typist's
        assert_eq!(attribute("a\nb\nc", "a\nbx\nc", &v, Some(9)), [0, 9, 2]);
        // a new line in between: only it is new
        assert_eq!(attribute("a\nb\nc", "a\nb\nnew\nc", &v, Some(9)), [0, 1, 9, 2]);
        // splitting a line: both halves are the editor's
        assert_eq!(attribute("a\nbc\nd", "a\nb\nc\nd", &v, Some(9)), [0, 9, 9, 2]);
        // deleting a line keeps the others
        assert_eq!(attribute("a\nb\nc", "a\nc", &v, Some(9)), [0, 2]);
        // a remote edit (KEEP): changed lines keep the line's previous author
        assert_eq!(attribute("a\nb\nc", "a\nbx\nc", &v, None), [0, 1, 2]);
        // a line moved elsewhere is new where it lands
        assert_eq!(attribute("x\na\nb", "a\nb\nx", &[5, 6, 7], Some(9)), [6, 7, 9]);
        assert_eq!(attribute("same", "same", &v, Some(9)), v);
        // unicode: the change's bytes never split a line wrongly
        assert_eq!(attribute("é\nü", "é\nüx", &[1, 2], Some(9)), [1, 9]);
    }

    #[test]
    fn line_pairs_match_common_lines() {
        assert_eq!(line_pairs(&["a", "b", "c"], &["a", "x", "c"], 4000), [(0, 0), (2, 2)]);
        assert_eq!(line_pairs(&["a", "b", "c", "d"], &["b", "c", "a", "d"], 4000), [(1, 0), (2, 1), (3, 3)]);
        assert!(line_pairs(&["a"; 3000], &["b"; 3000], 4000).is_empty(), "too big a middle stays unmatched");
    }
}
