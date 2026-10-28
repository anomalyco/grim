//! Syntax highlighting with Pierre's `@pierre/highlights` 0.3.0 (Apache-2.0): its WebAssembly
//! module run in Wasmi, and a port of the package's `LiveTokenizer` (`dist/live.js`) over the
//! module's `live*` exports: an editable document tokenized incrementally (each edit re-lexes
//! from the changed line until the lexer state matches the previous run).
//!
//! Positions handed out here are UTF-8 byte offsets; the module counts UTF-16 units, converted
//! on the way in and out. Lines split at `\n` only: a `\r` is lexed as a space (the editor's
//! lines don't hold one, and the module would split there).

mod tables;
pub mod theme;

use std::borrow::Cow;

pub use tables::{LANGUAGES, TOKEN_NAMES};
pub use theme::{Style, Theme};
use wasmi::{Caller, Engine, Extern, Linker, Memory, Module, Store, TypedFunc};

/// `@pierre/highlights` 0.3.0's `dist/highlights.wasm`.
pub static WASM: &[u8] = include_bytes!("../../app/assets/highlights.wasm");

/// The `diff` lexer's id (`diff`, `patch`, `git-commit`, `git-rebase`).
pub const DIFF: u8 = 25;

/// The language id for a name or alias, case-insensitive (`languages.js`); `plain`/`text` are 0.
pub fn lang_id(name: &str) -> Option<u8> {
    let name = name.to_ascii_lowercase();
    LANGUAGES.binary_search_by(|(n, _)| n.cmp(&name.as_str())).ok().map(|i| LANGUAGES[i].1)
}

/// The lexer for a code fence's info string: its first word. `None` when unknown, empty or plain
/// text (nothing to colour).
pub fn info_lang(info: &str) -> Option<u8> {
    lang_id(info.split_whitespace().next()?).filter(|&id| id != 0)
}

/// A run of one token type, as UTF-8 byte offsets in its line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub start: u32,
    pub end: u32,
    /// Index into `TOKEN_NAMES`.
    pub id: u8,
}

impl Token {
    pub fn name(&self) -> &'static str {
        TOKEN_NAMES.get(self.id as usize).copied().unwrap_or("none")
    }
}

pub type Error = wasmi::Error;

/// The compiled module. Compile once; each `Tokenizer` gets its own instance (and memory), like
/// `LiveTokenizer` in JS.
pub struct Highlighter {
    engine: Engine,
    module: Module,
    linker: Linker<()>,
}

impl Highlighter {
    /// Compiles the embedded module (`crates/app/assets/highlights.wasm`).
    pub fn new() -> Result<Highlighter, Error> {
        let engine = Engine::default();
        // SAFETY: the module is the npm package's, embedded at build time, and passes Wasmi's
        // validation (tests::the_module_validates); skipping validation here keeps wasmparser's
        // validator out of the binary (1.4 MB).
        let module = unsafe { Module::new_unchecked(&engine, WASM)? };
        let mut linker = Linker::new(&engine);
        linker.func_wrap("env", "is_id_start", |c: Caller<'_, ()>, ptr: i32, len: i32| id_class(&c, ptr, len, false))?;
        linker.func_wrap("env", "is_id_continue", |c: Caller<'_, ()>, ptr: i32, len: i32| id_class(&c, ptr, len, true))?;
        Ok(Highlighter { engine, module, linker })
    }

    /// A document of `text` in language `lang`, tokenized.
    pub fn tokenizer(&self, lang: u8, text: &str) -> Result<Tokenizer, Error> {
        let mut store = Store::new(&self.engine, ());
        let inst = self.linker.instantiate_and_start(&mut store, &self.module)?;
        let memory = inst.get_memory(&store, "memory").ok_or_else(|| Error::new("no memory export"))?;
        macro_rules! f {
            ($name:literal) => {
                inst.get_typed_func(&store, $name)?
            };
        }
        let f = Exports {
            stage: f!("liveStage"),
            init_doc: f!("liveInitDoc"),
            apply_edits: f!("liveApplyEdits"),
            run: f!("liveRun"),
            line_count: f!("liveLineCount"),
            line_flags: f!("liveLineFlags"),
            line_tok_ptr: f!("liveLineTokPtr"),
            line_tok_count: f!("liveLineTokCount"),
            changes_ptr: f!("liveChangesPtr"),
        };
        let text = clean(text).into_owned();
        let mut t = Tokenizer { store, memory, f, lang, text, starts: Vec::new(), lines: Vec::new() };
        let ptr = t.f.stage.call(&mut t.store, t.text.len() as i32)?;
        t.memory.write(&mut t.store, ptr as usize, t.text.as_bytes()).map_err(|e| Error::new(e.to_string()))?;
        t.f.init_doc.call(&mut t.store, (ptr, t.text.len() as i32, lang as i32))?;
        t.f.run.call(&mut t.store, (i32::MAX, 0, 0))?;
        t.starts = line_starts(&t.text);
        t.lines = (0..t.starts.len()).map(|i| t.read_line(i)).collect::<Result<_, _>>()?;
        Ok(t)
    }
}

/// `is_id_start` / `is_id_continue` for the code point at `ptr` (`len` UTF-8 bytes), as the JS
/// glue's `/^\p{ID_Start}$/u` and `/^[\u200C\u200D\p{ID_Continue}]$/u`. Surrogates and values past
/// U+10FFFF are no. (`unicode-ident` has XID_Start/XID_Continue, which differ from ID_* only in a
/// handful of compatibility characters.)
fn id_class(c: &Caller<'_, ()>, ptr: i32, len: i32, cont: bool) -> i32 {
    let Some(mem) = c.get_export("memory").and_then(Extern::into_memory) else { return 0 };
    let data = mem.data(c);
    let (p, n) = (ptr as u32 as usize, len.clamp(1, 4) as usize);
    let Some(b) = data.get(p..p + n) else { return 0 };
    let cp = match n {
        1 => b[0] as u32,
        2 => (b[0] as u32 & 31) << 6 | b[1] as u32 & 63,
        3 => (b[0] as u32 & 15) << 12 | (b[1] as u32 & 63) << 6 | b[2] as u32 & 63,
        _ => (b[0] as u32 & 7) << 18 | (b[1] as u32 & 63) << 12 | (b[2] as u32 & 63) << 6 | b[3] as u32 & 63,
    };
    let Some(ch) = char::from_u32(cp) else { return 0 };
    let yes = if cont { matches!(ch, '\u{200C}' | '\u{200D}') || unicode_ident::is_xid_continue(ch) } else { unicode_ident::is_xid_start(ch) };
    yes as i32
}

struct Exports {
    stage: TypedFunc<i32, i32>,
    init_doc: TypedFunc<(i32, i32, i32), ()>,
    apply_edits: TypedFunc<(i32, i32), ()>,
    run: TypedFunc<(i32, i32, i32), i32>,
    line_count: TypedFunc<(), i32>,
    line_flags: TypedFunc<i32, i32>,
    line_tok_ptr: TypedFunc<i32, i32>,
    line_tok_count: TypedFunc<i32, i32>,
    changes_ptr: TypedFunc<(), i32>,
}

/// An editable, incrementally tokenized document (`LiveTokenizer`, always tokenized to the end
/// synchronously: no render range, no background slices).
pub struct Tokenizer {
    store: Store<()>,
    memory: Memory,
    f: Exports,
    lang: u8,
    text: String,
    /// Byte offset of each line's start in `text`.
    starts: Vec<usize>,
    lines: Vec<Vec<Token>>,
}

/// Lines changed by `Tokenizer::set_text`: `old` lines were replaced by `new` ones (re-lexed
/// lines included); the rest kept their tokens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub old: std::ops::Range<usize>,
    pub new: std::ops::Range<usize>,
}

impl Tokenizer {
    pub fn lang(&self) -> u8 {
        self.lang
    }

    /// The document (with any `\r` as a space).
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// The line's text, without its `\n`.
    pub fn line_text(&self, line: usize) -> &str {
        let end = self.starts.get(line + 1).map_or(self.text.len(), |&s| s - 1);
        &self.text[self.starts[line]..end]
    }

    /// A line's tokens, in order, covering it (possibly empty for an empty line).
    pub fn line_tokens(&self, line: usize) -> &[Token] {
        &self.lines[line]
    }

    /// Every line's tokens (giving up the Wasm instance).
    pub fn into_lines(self) -> Vec<Vec<Token>> {
        self.lines
    }

    /// Replace the document with `text` as one edit: the differing middle (after the common
    /// prefix and suffix) is spliced in and re-lexed from its line on. Returns the changed lines,
    /// or `None` when nothing changed.
    pub fn set_text(&mut self, text: &str) -> Result<Option<Vec<Change>>, Error> {
        let text = clean(text);
        let (old, new) = (self.text.as_bytes(), text.as_bytes());
        let mut pre = old.iter().zip(new).take_while(|(a, b)| a == b).count();
        while !text.is_char_boundary(pre) || !self.text.is_char_boundary(pre) {
            pre -= 1;
        }
        let max_suf = old.len().min(new.len()) - pre;
        let mut suf = old.iter().rev().zip(new.iter().rev()).take(max_suf).take_while(|(a, b)| a == b).count();
        while !text.is_char_boundary(new.len() - suf) || !self.text.is_char_boundary(old.len() - suf) {
            suf -= 1;
        }
        if pre == old.len() && pre == new.len() {
            return Ok(None);
        }
        let (start, end) = (pre, old.len() - suf);
        let insert = text[pre..new.len() - suf].to_string();
        self.replace(start, end, &insert).map(Some)
    }

    /// Replace bytes `start..end` of the document with `insert`, re-lexing what it affects.
    pub fn replace(&mut self, start: usize, end: usize, insert: &str) -> Result<Vec<Change>, Error> {
        let insert = clean(insert);
        let (sl, sc) = self.utf16_pos(start);
        let (el, ec) = self.utf16_pos(end);
        // the edit block: count, then (sl, sc, el, ec, text offset, text length), then the text
        let mut block = Vec::with_capacity(28 + insert.len());
        for v in [1, sl, sc, el, ec, 28, insert.len() as u32] {
            block.extend_from_slice(&v.to_le_bytes());
        }
        block.extend_from_slice(insert.as_bytes());
        let ptr = self.f.stage.call(&mut self.store, block.len() as i32)?;
        self.memory.write(&mut self.store, ptr as usize, &block).map_err(|e| Error::new(e.to_string()))?;
        self.f.apply_edits.call(&mut self.store, (ptr, 0))?;
        self.f.run.call(&mut self.store, (i32::MAX, 0, 0))?;
        self.text.replace_range(start..end, &insert);
        self.starts = line_starts(&self.text);

        let base = self.f.changes_ptr.call(&mut self.store, ())? as usize;
        let n = self.u32_at(base) as usize;
        let changes: Vec<Change> = (0..n)
            .map(|i| {
                let at = base + 4 + i * 16;
                let r = |k| self.u32_at(at + k) as usize;
                Change { old: r(0)..r(4), new: r(8)..r(12) }
            })
            .collect();
        let count = self.f.line_count.call(&mut self.store, ())? as usize;
        debug_assert_eq!(count, self.starts.len(), "line tables agree");
        // lines between changes keep their tokens; changed ones are read again
        let mut old: Vec<Option<Vec<Token>>> = std::mem::take(&mut self.lines).into_iter().map(Some).collect();
        let mut lines = Vec::with_capacity(count);
        let (mut old_at, mut new_at) = (0, 0);
        let ends = changes.iter().map(|c| (c.old.start, c.new.start..c.new.end, c.old.end)).chain([(usize::MAX, count..count, 0)]);
        for (old_start, new, old_end) in ends {
            debug_assert!(old_start == usize::MAX || old_start - old_at == new.start - new_at);
            for li in new_at..new.start {
                match old.get_mut(old_at + li - new_at).and_then(Option::take) {
                    Some(t) => lines.push(t),
                    None => lines.push(self.read_line(li)?),
                }
            }
            for li in new.clone() {
                lines.push(self.read_line(li)?);
            }
            (old_at, new_at) = (old_end, new.end);
        }
        self.lines = lines;
        Ok(changes)
    }

    fn u32_at(&self, at: usize) -> u32 {
        let d = self.memory.data(&self.store);
        u32::from_le_bytes(d[at..at + 4].try_into().unwrap())
    }

    /// (line, UTF-16 column) of byte `pos`.
    fn utf16_pos(&self, pos: usize) -> (u32, u32) {
        let line = self.starts.partition_point(|&s| s <= pos) - 1;
        let col = self.text[self.starts[line]..pos].encode_utf16().count();
        (line as u32, col as u32)
    }

    /// A line's records (`getLineRecords`: packed24 `(id << 24) | end`, or wide32 `end, id`
    /// pairs; ends in UTF-16 units) as byte-offset tokens, empty runs dropped, the rest of the line
    /// (if no record covers it) as `none`.
    fn read_line(&mut self, line: usize) -> Result<Vec<Token>, Error> {
        let n = self.f.line_tok_count.call(&mut self.store, line as i32)? as usize;
        let wide = self.f.line_flags.call(&mut self.store, line as i32)? & 4 != 0;
        let ptr = if n == 0 { 0 } else { self.f.line_tok_ptr.call(&mut self.store, line as i32)? as usize };
        let text = self.line_text(line);
        let data = self.memory.data(&self.store);
        let word = |i: usize| u32::from_le_bytes(data[ptr + i * 4..ptr + i * 4 + 4].try_into().unwrap());
        let mut out = Vec::with_capacity(n);
        let mut chars = text.char_indices();
        let (mut u16_at, mut byte_at) = (0u32, 0usize);
        let mut start = 0usize;
        for r in 0..n {
            let (end, id) = if wide { (word(r * 2), word(r * 2 + 1)) } else { (word(r) & 0xff_ffff, word(r) >> 24) };
            // walk to the UTF-16 offset `end` (never inside a pair: the lexer works on code points)
            while u16_at < end {
                match chars.next() {
                    Some((_, ch)) => {
                        u16_at += ch.len_utf16() as u32;
                        byte_at += ch.len_utf8();
                    }
                    None => break,
                }
            }
            if byte_at > start {
                out.push(Token { start: start as u32, end: byte_at as u32, id: id as u8 });
                start = byte_at;
            }
        }
        if start < text.len() {
            out.push(Token { start: start as u32, end: text.len() as u32, id: 0 });
        }
        Ok(out)
    }
}

fn clean(s: &str) -> Cow<'_, str> {
    if s.contains('\r') { Cow::Owned(s.replace('\r', " ")) } else { Cow::Borrowed(s) }
}

fn line_starts(text: &str) -> Vec<usize> {
    std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_module_validates() {
        wasmi::Module::validate(&wasmi::Engine::default(), super::WASM).unwrap();
    }
}
