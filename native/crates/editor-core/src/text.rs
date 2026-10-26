//! Character classes and offset helpers.
//!
//! Every offset in this crate is a **byte offset** into the UTF-8 document, always on a char
//! boundary. The TS original works in UTF-16 code units, where a character outside the BMP is a
//! surrogate pair that matches none of the Unicode regex classes; the classifiers below reproduce
//! that (astral chars are never whitespace, punctuation, letters or word chars).

/// JavaScript `\s`.
pub fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn astral(c: char) -> bool {
    c as u32 > 0xFFFF
}

// Combining marks (\p{M}) in the BMP, by range. Approximate: some ranges include unassigned code
// points, which is harmless for the classes that use it.
const MARKS: &[(u32, u32)] = &[
    (0x0300, 0x036F), (0x0483, 0x0489), (0x0591, 0x05BD), (0x05BF, 0x05BF), (0x05C1, 0x05C2),
    (0x05C4, 0x05C5), (0x05C7, 0x05C7), (0x0610, 0x061A), (0x064B, 0x065F), (0x0670, 0x0670),
    (0x06D6, 0x06DC), (0x06DF, 0x06E4), (0x06E7, 0x06E8), (0x06EA, 0x06ED), (0x0711, 0x0711),
    (0x0730, 0x074A), (0x07A6, 0x07B0), (0x07EB, 0x07F3), (0x07FD, 0x07FD), (0x0816, 0x082D),
    (0x0859, 0x085B), (0x0898, 0x089F), (0x08CA, 0x08E1), (0x08E3, 0x0903), (0x093A, 0x093C),
    (0x093E, 0x094F), (0x0951, 0x0957), (0x0962, 0x0963), (0x0981, 0x0983), (0x09BC, 0x09BC),
    (0x09BE, 0x09CD), (0x09D7, 0x09D7), (0x09E2, 0x09E3), (0x09FE, 0x09FE), (0x0A01, 0x0A03),
    (0x0A3C, 0x0A51), (0x0A70, 0x0A71), (0x0A75, 0x0A75), (0x0A81, 0x0A83), (0x0ABC, 0x0ABC),
    (0x0ABE, 0x0ACD), (0x0AE2, 0x0AE3), (0x0AFA, 0x0AFF), (0x0B01, 0x0B03), (0x0B3C, 0x0B3C),
    (0x0B3E, 0x0B57), (0x0B62, 0x0B63), (0x0B82, 0x0B82), (0x0BBE, 0x0BCD), (0x0BD7, 0x0BD7),
    (0x0C00, 0x0C04), (0x0C3C, 0x0C3C), (0x0C3E, 0x0C56), (0x0C62, 0x0C63), (0x0C81, 0x0C83),
    (0x0CBC, 0x0CBC), (0x0CBE, 0x0CD6), (0x0CE2, 0x0CE3), (0x0D00, 0x0D03), (0x0D3B, 0x0D3C),
    (0x0D3E, 0x0D4D), (0x0D57, 0x0D57), (0x0D62, 0x0D63), (0x0D81, 0x0D83), (0x0DCA, 0x0DDF),
    (0x0DF2, 0x0DF3), (0x0E31, 0x0E31), (0x0E34, 0x0E3A), (0x0E47, 0x0E4E), (0x0EB1, 0x0EB1),
    (0x0EB4, 0x0EBC), (0x0EC8, 0x0ECE), (0x0F18, 0x0F19), (0x0F35, 0x0F35), (0x0F37, 0x0F37),
    (0x0F39, 0x0F39), (0x0F3E, 0x0F3F), (0x0F71, 0x0F84), (0x0F86, 0x0F87), (0x0F8D, 0x0FBC),
    (0x0FC6, 0x0FC6), (0x102B, 0x103E), (0x1056, 0x1059), (0x105E, 0x1060), (0x1062, 0x1064),
    (0x1067, 0x106D), (0x1071, 0x1074), (0x1082, 0x108D), (0x108F, 0x108F), (0x109A, 0x109D),
    (0x135D, 0x135F), (0x1712, 0x1715), (0x1732, 0x1734), (0x1752, 0x1753), (0x1772, 0x1773),
    (0x17B4, 0x17D3), (0x17DD, 0x17DD), (0x180B, 0x180D), (0x180F, 0x180F), (0x1885, 0x1886),
    (0x18A9, 0x18A9), (0x1920, 0x193B), (0x1A17, 0x1A1B), (0x1A55, 0x1A7F), (0x1AB0, 0x1ACE),
    (0x1B00, 0x1B04), (0x1B34, 0x1B44), (0x1B6B, 0x1B73), (0x1B80, 0x1B82), (0x1BA1, 0x1BAD),
    (0x1BE6, 0x1BF3), (0x1C24, 0x1C37), (0x1CD0, 0x1CD2), (0x1CD4, 0x1CE8), (0x1CED, 0x1CED),
    (0x1CF4, 0x1CF4), (0x1CF7, 0x1CF9), (0x1DC0, 0x1DFF), (0x20D0, 0x20F0), (0x2CEF, 0x2CF1),
    (0x2D7F, 0x2D7F), (0x2DE0, 0x2DFF), (0x302A, 0x302F), (0x3099, 0x309A), (0xA66F, 0xA672),
    (0xA674, 0xA67D), (0xA69E, 0xA69F), (0xA6F0, 0xA6F1), (0xA802, 0xA802), (0xA806, 0xA806),
    (0xA80B, 0xA80B), (0xA823, 0xA827), (0xA82C, 0xA82C), (0xA880, 0xA881), (0xA8B4, 0xA8C5),
    (0xA8E0, 0xA8F1), (0xA8FF, 0xA8FF), (0xA926, 0xA92D), (0xA947, 0xA953), (0xA980, 0xA983),
    (0xA9B3, 0xA9C0), (0xA9E5, 0xA9E5), (0xAA29, 0xAA36), (0xAA43, 0xAA43), (0xAA4C, 0xAA4D),
    (0xAA7B, 0xAA7D), (0xAAB0, 0xAAB0), (0xAAB2, 0xAAB4), (0xAAB7, 0xAAB8), (0xAABE, 0xAABF),
    (0xAAC1, 0xAAC1), (0xAAEB, 0xAAEF), (0xAAF5, 0xAAF6), (0xABE3, 0xABEA), (0xABEC, 0xABED),
    (0xFB1E, 0xFB1E), (0xFE00, 0xFE0F), (0xFE20, 0xFE2F),
];

/// `\p{M}` (BMP only, see module docs).
pub fn is_mark(c: char) -> bool {
    let u = c as u32;
    if u < 0x0300 || astral(c) {
        return false;
    }
    MARKS
        .binary_search_by(|&(a, b)| {
            if u < a {
                std::cmp::Ordering::Greater
            } else if u > b {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn is_format(u: u32) -> bool {
    matches!(u, 0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x180E | 0x200B..=0x200F
        | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB)
}

/// `[\p{P}\p{S}]`: punctuation or symbol. Non-ASCII chars are classified by elimination (not a
/// letter, number, mark, space, control, format or private-use char).
pub fn is_punct(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_punctuation();
    }
    if astral(c) {
        return false;
    }
    let u = c as u32;
    !(c.is_alphanumeric()
        || is_ws(c)
        || c.is_control()
        || is_mark(c)
        || is_format(u)
        || (0xE000..=0xF8FF).contains(&u))
}

/// `\p{L}`.
pub fn is_letter(c: char) -> bool {
    !astral(c) && c.is_alphabetic() && !is_mark(c)
}

/// `[\p{L}\p{N}\p{M}_]`: a word character for word motion and Cmd-B on a word.
pub fn is_word_char(c: char) -> bool {
    !astral(c) && (c.is_alphanumeric() || is_mark(c) || c == '_')
}

/// `[\p{L}\p{N}\p{M}_\-/]`: a tag character.
pub fn is_tag_char(c: char) -> bool {
    !astral(c) && (c.is_alphanumeric() || is_mark(c) || c == '_' || c == '-' || c == '/')
}

/// JS `s.trim() === ""`.
pub fn is_blank(s: &str) -> bool {
    s.chars().all(is_ws)
}

/// The char starting at byte `i` (None at or past the end).
pub fn char_at(s: &str, i: usize) -> Option<char> {
    s.get(i..).and_then(|r| r.chars().next())
}

/// The char ending at byte `i`.
pub fn char_before(s: &str, i: usize) -> Option<char> {
    s.get(..i).and_then(|r| r.chars().next_back())
}

/// The next char boundary after `i` (clamped to the end).
pub fn next_boundary(s: &str, i: usize) -> usize {
    match char_at(s, i) {
        Some(c) => i + c.len_utf8(),
        None => s.len(),
    }
}

/// The previous char boundary before `i` (clamped to 0).
pub fn prev_boundary(s: &str, i: usize) -> usize {
    match char_before(s, i) {
        Some(c) => i - c.len_utf8(),
        None => 0,
    }
}

/// Round `i` down to a char boundary (and clamp to the length).
pub fn floor_boundary(s: &str, i: usize) -> usize {
    let mut i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Convert a UTF-16 offset (as used by NSString / NSTextInputClient / the TS editor) to a byte
/// offset. Offsets inside a surrogate pair round down.
pub fn utf16_to_byte(s: &str, u16_off: usize) -> usize {
    let mut n = 0;
    for (b, c) in s.char_indices() {
        if n >= u16_off {
            return b;
        }
        n += c.len_utf16();
        if n > u16_off {
            return b;
        }
    }
    s.len()
}

/// Convert a byte offset (on a char boundary) to a UTF-16 offset.
pub fn byte_to_utf16(s: &str, byte: usize) -> usize {
    // one unit per char (count its lead byte, not continuation bytes), two for 4-byte chars; byte-wise so it
    // vectorizes (this runs over the whole prefix on every local edit of a shared document)
    s.as_bytes()[..floor_boundary(s, byte)].iter().map(|&c| usize::from(c & 0xC0 != 0x80) + usize::from(c >= 0xF0)).sum()
}
