//! Byte <-> UTF-16 offsets for one text snapshot, and the JS mirror of `LineView` (`LineViewJs`).

use editor_core::text::floor_boundary;
use editor_core::{BlockType, CellAlign, InlineType, LineView, SegKind, TokenKind};
use serde::Serialize;

/// A text snapshot with checkpoints for fast offset conversion (identity for ASCII text).
#[derive(Clone, Debug)]
pub struct Snap {
    pub text: String,
    ascii: bool,
    /// (byte, utf16) at line starts and at least every 256 bytes; the first is (0, 0).
    cps: Vec<(usize, usize)>,
}

impl Snap {
    pub fn new(text: String) -> Snap {
        let ascii = text.is_ascii();
        let mut cps = vec![(0, 0)];
        if !ascii {
            let (mut u, mut last, mut prev_nl) = (0, 0, false);
            for (b, c) in text.char_indices() {
                if b > 0 && (prev_nl || b - last >= 256) {
                    cps.push((b, u));
                    last = b;
                }
                u += c.len_utf16();
                prev_nl = c == '\n';
            }
        }
        Snap { text, ascii, cps }
    }

    /// Byte offset -> UTF-16 offset (rounded down to a char boundary, clamped to the end).
    pub fn to_u16(&self, b: usize) -> usize {
        let b = floor_boundary(&self.text, b);
        if self.ascii {
            return b;
        }
        let (cb, cu) = self.cps[self.cps.partition_point(|c| c.0 <= b) - 1];
        cu + self.text[cb..b].chars().map(char::len_utf16).sum::<usize>()
    }

    /// UTF-16 offset -> byte offset (inside a surrogate pair rounds down; clamped to the end).
    pub fn to_byte(&self, u: usize) -> usize {
        if self.ascii {
            return u.min(self.text.len());
        }
        let (cb, cu) = self.cps[self.cps.partition_point(|c| c.1 <= u) - 1];
        let mut n = cu;
        for (o, c) in self.text[cb..].char_indices() {
            if n >= u {
                return cb + o;
            }
            n += c.len_utf16();
            if n > u {
                return cb + o;
            }
        }
        self.text.len()
    }

    /// Replace bytes `a..b` with `ins`: the text and the checkpoints after the edit move; only the
    /// stretch from the last checkpoint before `a` to the end of `ins` is scanned again.
    pub fn edit(&mut self, a: usize, b: usize, ins: &str) {
        let old_u = self.to_u16(b);
        self.text.replace_range(a..b, ins);
        if self.ascii {
            if !ins.is_ascii() {
                *self = Snap::new(std::mem::take(&mut self.text));
            }
            return;
        }
        let k = self.cps.partition_point(|c| c.0 <= a);
        let tail: Vec<(usize, usize)> = self.cps[k..].iter().copied().filter(|c| c.0 > b).collect();
        self.cps.truncate(k);
        let (base, mut u) = self.cps[k - 1];
        let (mut last, end) = (base, a + ins.len());
        let mut prev_nl = false;
        for (o, c) in self.text[base..end].char_indices() {
            let p = base + o;
            if o > 0 && (prev_nl || p - last >= 256) {
                self.cps.push((p, u));
                last = p;
            }
            u += c.len_utf16();
            prev_nl = c == '\n';
        }
        let (db, du) = (end as isize - b as isize, u as isize - old_u as isize);
        self.cps.extend(tail.into_iter().map(|(cb, cu)| ((cb as isize + db) as usize, (cu as isize + du) as usize)));
    }

    fn u(&self, b: usize) -> u32 {
        self.to_u16(b) as u32
    }
}

// The TS type of all of this is in lib.rs (TS_TYPES) and README.md: keep them in sync.

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineViewJs {
    pub key: String,
    /// Length of the line (UTF-16, without the newline). Every other offset is relative to the line start.
    pub len: u32,
    pub text_from: u32,
    pub text: String,
    pub kind: &'static str,
    pub level: u8,
    pub checked: bool,
    pub number: u32,
    pub indent: u32,
    pub gutter_levels: u32,
    pub active: bool,
    pub revealed: bool,
    pub collapsed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<CodeViewJs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<TableViewJs>,
    pub segments: Vec<SegViewJs>,
    pub images: Vec<ImageViewJs>,
    pub image_only: bool,
    pub text_hidden: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CodeViewJs {
    pub first: bool,
    pub last: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TableViewJs {
    pub align: Vec<Option<&'static str>>,
    pub cells: u32,
    pub columns: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SegViewJs {
    pub kind: &'static str,
    pub from: u32,
    pub to: u32,
    pub styles: Vec<&'static str>,
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub el: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageViewJs {
    pub from: u32,
    pub to: u32,
    pub alt_range: (u32, u32),
    pub alt: String,
    pub src: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub revealed: bool,
}

pub fn block_name(t: BlockType) -> &'static str {
    match t {
        BlockType::Paragraph => "paragraph",
        BlockType::Heading => "heading",
        BlockType::Bullet => "bullet",
        BlockType::Todo => "todo",
        BlockType::Numbered => "numbered",
        BlockType::Quote => "quote",
        BlockType::Hr => "hr",
        BlockType::Fence => "fence",
        BlockType::Code => "code",
        BlockType::TableHead => "table-head",
        BlockType::TableDelim => "table-delim",
        BlockType::TableRow => "table-row",
    }
}

/// Segment kinds use the TS renderer's names (`render.ts` SegKind).
pub fn seg_name(k: SegKind) -> &'static str {
    match k {
        SegKind::Token => "token",
        SegKind::Text => "text",
        SegKind::Marker => "mk",
        SegKind::Escape => "esc",
        SegKind::Chip => "chip",
        SegKind::Fence => "fence",
        SegKind::Pipe => "pipe",
        SegKind::Pad => "pad",
        SegKind::Delim => "delim",
    }
}

pub fn inline_name(t: InlineType) -> &'static str {
    match t {
        InlineType::Bold => "bold",
        InlineType::Italic => "italic",
        InlineType::Strike => "strike",
        InlineType::Underline => "underline",
        InlineType::Highlight => "highlight",
        InlineType::Code => "code",
        InlineType::Link => "link",
        InlineType::Tag => "tag",
        InlineType::Image => "image",
    }
}

pub fn token_name(t: TokenKind) -> &'static str {
    match t {
        TokenKind::Indent => "indent",
        TokenKind::Heading => "heading",
        TokenKind::Bullet => "bullet",
        TokenKind::Todo => "todo",
        TokenKind::Numbered => "numbered",
        TokenKind::Quote => "quote",
        TokenKind::Hr => "hr",
    }
}

fn align_name(a: CellAlign) -> &'static str {
    match a {
        CellAlign::Left => "left",
        CellAlign::Center => "center",
        CellAlign::Right => "right",
    }
}

/// Convert a line view (byte offsets into `snap.text`) to its JS mirror: UTF-16 offsets relative to the line
/// start, so a line that only moved converts to the same value.
pub fn line_js(v: &LineView, key: u32, snap: &Snap) -> LineViewJs {
    LineViewJs { key: key.to_string(), ..line_view_js(v, snap) }
}

/// `line_js` without a key (`key` is empty).
pub fn line_view_js(v: &LineView, snap: &Snap) -> LineViewJs {
    let base = snap.u(v.from);
    let u = |b: usize| snap.u(b) - base;
    LineViewJs {
        key: String::new(),
        len: snap.u(v.to) - base,
        text_from: u(v.text_from),
        text: snap.text[v.from..v.to].to_string(),
        kind: block_name(v.kind),
        level: v.level,
        checked: v.checked,
        number: v.number,
        indent: v.indent as u32,
        gutter_levels: v.gutter_levels as u32,
        active: v.active,
        revealed: v.revealed,
        collapsed: v.collapsed,
        code: v.code.as_ref().map(|c| CodeViewJs { first: c.first, last: c.last }),
        table: v.table.as_ref().map(|t| TableViewJs {
            align: t.align.iter().map(|a| a.map(align_name)).collect(),
            cells: t.cells as u32,
            columns: t.columns as u32,
        }),
        segments: v
            .segments
            .iter()
            .map(|s| SegViewJs {
                kind: seg_name(s.kind),
                from: u(s.from),
                to: u(s.to),
                styles: s.styles.iter().map(|&t| inline_name(t)).collect(),
                hidden: s.hidden,
                token: s.token.map(token_name),
                cell: s.cell.map(|c| c as u32),
                el: s.el.map(|e| e as u32),
            })
            .collect(),
        images: v
            .images
            .iter()
            .map(|i| ImageViewJs {
                from: u(i.from),
                to: u(i.to),
                alt_range: (u(i.alt_range.0), u(i.alt_range.1)),
                alt: i.alt.clone(),
                src: i.src.clone(),
                title: i.title.clone(),
                revealed: i.revealed,
            })
            .collect(),
        image_only: v.image_only,
        text_hidden: v.text_hidden(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::Editor;
    use editor_core::text::{byte_to_utf16, utf16_to_byte};

    #[test]
    fn offsets_match_editor_core_helpers() {
        let long = "é".repeat(300);
        for t in ["", "abc\ndef", "a😀b\n💥\nx", "# Hi 😀\n- a\n", long.as_str(), "\n\n😀\n"] {
            let s = Snap::new(t.to_string());
            let total = t.encode_utf16().count();
            for b in 0..=t.len() + 2 {
                assert_eq!(s.to_u16(b), byte_to_utf16(t, b.min(t.len())), "{t:?} b={b}");
            }
            for u in 0..=total + 2 {
                assert_eq!(s.to_byte(u), utf16_to_byte(t, u), "{t:?} u={u}");
            }
        }
    }

    #[test]
    fn edits_keep_offsets_right() {
        let mut seed = 7u64;
        let mut rnd = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize % n.max(1)
        };
        let pieces = ["a", "é", "😀", "\n", "abc\n", "", &"x".repeat(300), &"ü".repeat(200)];
        for start in ["", "abc", "a😀b\nc", &"é".repeat(600)] {
            let mut s = Snap::new(start.to_string());
            for _ in 0..200 {
                let t = &s.text;
                let fl = |mut i: usize| {
                    while !t.is_char_boundary(i) {
                        i -= 1;
                    }
                    i
                };
                let a = fl(rnd(t.len() + 1));
                let b = fl((a + rnd(20)).min(t.len()));
                let ins = pieces[rnd(pieces.len())];
                s.edit(a, b, ins);
                let fresh = Snap::new(s.text.clone());
                let total = s.text.encode_utf16().count();
                for b in (0..=s.text.len()).step_by(7) {
                    assert_eq!(s.to_u16(b), fresh.to_u16(b));
                }
                for u in (0..=total).step_by(5) {
                    assert_eq!(s.to_byte(u), fresh.to_byte(u));
                }
            }
        }
    }

    #[test]
    fn line_view_in_utf16() {
        let ed = Editor::new("# Hi 😀 **b**\n- a");
        let snap = Snap::new(ed.text().to_string());
        let lines = ed.render_lines();
        let l0 = line_js(&lines[0], 7, &snap);
        assert_eq!(l0.key, "7");
        assert_eq!(l0.kind, "heading");
        assert_eq!(l0.text, "# Hi 😀 **b**");
        assert_eq!((l0.len, l0.text_from), (13, 2));
        assert_eq!(l0.segments[0].kind, "token");
        assert_eq!(l0.segments[0].token, Some("heading"));
        let bold: Vec<_> = l0.segments.iter().filter(|s| s.styles.contains(&"bold")).collect();
        assert_eq!(bold.iter().map(|s| (s.kind, s.from, s.to)).collect::<Vec<_>>(), [("mk", 8, 10), ("text", 10, 11), ("mk", 11, 13)]);
        // line-relative offsets: the second line starts at UTF-16 offset 14
        let l1 = line_js(&lines[1], 8, &snap);
        assert_eq!((l1.kind, l1.len, l1.text_from, l1.gutter_levels), ("bullet", 3, 2, 1));
        assert_eq!(l1.segments.iter().map(|s| (s.kind, s.from, s.to)).collect::<Vec<_>>(), [("token", 0, 2), ("text", 2, 3)]);
        // a line that only moved converts to the same value
        let ed2 = Editor::new("😀😀\n# Hi 😀 **b**\n- a");
        let snap2 = Snap::new(ed2.text().to_string());
        assert_eq!(line_js(&ed2.render_lines()[2], 8, &snap2), l1);
    }
}
