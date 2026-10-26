//! Splice trimming, stable line keys and the minimal text edit.

/// Lengths of the common prefix and suffix of `old` and `new` (not overlapping).
pub fn trim<T: PartialEq>(old: &[T], new: &[T]) -> (usize, usize) {
    let mut p = 0;
    while p < old.len() && p < new.len() && old[p] == new[p] {
        p += 1;
    }
    let mut s = 0;
    while s < old.len() - p && s < new.len() - p && old[old.len() - 1 - s] == new[new.len() - 1 - s] {
        s += 1;
    }
    (p, s)
}

/// Keys for `n` lines replacing lines with keys `old`: in order, the replaced lines' keys (an edited
/// line keeps its key), then fresh keys from `next`.
pub fn splice_keys(old: &[u32], n: usize, next: &mut u32) -> Vec<u32> {
    (0..n)
        .map(|i| {
            old.get(i).copied().unwrap_or_else(|| {
                *next += 1;
                *next
            })
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

    #[test]
    fn trims_common_ends() {
        assert_eq!(trim(&[1, 2, 3], &[1, 9, 3]), (1, 1));
        assert_eq!(trim(&[1, 2, 3], &[1, 2, 3]), (3, 0));
        assert_eq!(trim(&[1, 1], &[1, 1, 1]), (2, 0));
        assert_eq!(trim::<u8>(&[], &[]), (0, 0));
    }

    #[test]
    fn keys_pair_in_order() {
        let mut next = 10;
        assert_eq!(splice_keys(&[3, 4], 3, &mut next), vec![3, 4, 11]);
        assert_eq!(splice_keys(&[3, 4], 1, &mut next), vec![3]);
        assert_eq!(next, 11);
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
