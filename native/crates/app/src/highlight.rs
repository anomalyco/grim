//! Code block highlighting: fenced blocks whose info string names a language
//! (`highlight::info_lang`) are tokenized by the `highlight` crate (Pierre's `@pierre/highlights`
//! Wasm module in Wasmi) and coloured with Grim's shared theme (`assets/highlight-theme.json`).
//!
//! Each block keeps an incremental tokenizer between builds. A build matches the document's
//! blocks to the cached ones (same language and text first, then the nearest one of the same
//! language, which takes the change as one edit: typing, undo, a reload), so only the edited
//! block re-lexes, from the edited line until the lexer state settles. Blocks without a language,
//! or with an unknown one, are left alone. The module is compiled on the first block that needs it.

use std::cell::RefCell;
use std::sync::OnceLock;

use editor_core::{BlockType, LineView, SegKind};
use highlight::{Highlighter, Theme, Token, Tokenizer};
use rune::Color;

use crate::theme::c;

static THEME: &str = include_str!("../assets/highlight-theme.json");

/// Blocks keeping a live tokenizer (each its own Wasm instance): the most recently edited. The
/// others keep their tokens and get a fresh tokenizer when next edited.
const LIVE_MAX: usize = 8;

pub fn theme() -> &'static Theme {
    static T: OnceLock<Theme> = OnceLock::new();
    T.get_or_init(|| Theme::parse(THEME).expect("assets/highlight-theme.json"))
}

/// Each token id's span style: colour, italic, bold (parsed once).
pub fn token_style(id: u8) -> (Color, bool, bool) {
    static S: OnceLock<Vec<(Color, bool, bool)>> = OnceLock::new();
    let styles = S.get_or_init(|| {
        (0..highlight::TOKEN_NAMES.len()).map(|i| theme().style(i as u8)).map(|s| (c(&s.color), s.italic, s.bold)).collect()
    });
    styles.get(id as usize).copied().unwrap_or(styles[0])
}

fn highlighter() -> Option<&'static Highlighter> {
    static H: OnceLock<Option<Highlighter>> = OnceLock::new();
    H.get_or_init(|| Highlighter::new().map_err(|e| eprintln!("highlight: {e}")).ok()).as_ref()
}

/// One code line's colouring: raw byte ranges with a token id (tokens drawn like plain text left
/// out), and the line's background (diff/patch).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LineHl {
    pub tokens: Vec<(usize, usize, u8)>,
    pub bg: Option<&'static str>,
}

enum State {
    Live(Box<Tokenizer>),
    /// Evicted from `LIVE_MAX`: tokens only.
    Frozen(Vec<Vec<Token>>),
    /// The tokenizer failed: drawn plain.
    Failed,
}

struct Block {
    lang: u8,
    text: String,
    state: State,
    /// When it was last tokenized (for `LIVE_MAX`).
    tick: u64,
}

impl Block {
    fn new(lang: u8, text: String, tick: u64) -> Block {
        let state = match highlighter().map(|h| h.tokenizer(lang, &text)) {
            Some(Ok(t)) => State::Live(Box::new(t)),
            Some(Err(e)) => {
                eprintln!("highlight: {e}");
                State::Failed
            }
            None => State::Failed,
        };
        Block { lang, text, state, tick }
    }

    /// Take `text` as the block's new text.
    fn update(&mut self, text: String, tick: u64) {
        self.tick = tick;
        match &mut self.state {
            State::Live(t) => {
                if let Err(e) = t.set_text(&text) {
                    eprintln!("highlight: {e}");
                    self.state = State::Failed;
                }
                self.text = text;
            }
            _ => *self = Block::new(self.lang, text, tick),
        }
    }

    fn line(&self, i: usize) -> &[Token] {
        match &self.state {
            State::Live(t) if i < t.line_count() => t.line_tokens(i),
            State::Frozen(l) => l.get(i).map_or(&[], Vec::as_slice),
            _ => &[],
        }
    }
}

#[derive(Default)]
struct Cache {
    blocks: Vec<Block>,
    tick: u64,
}

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache::default());
}

/// A fenced block with a language in `views`: its content lines as (view index, raw range).
struct Found {
    lang: u8,
    lines: Vec<(usize, usize, usize)>,
    text: String,
}

fn find_blocks(src: &str, views: &[LineView]) -> Vec<Found> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < views.len() {
        let v = &views[i];
        i += 1;
        if v.kind != BlockType::Fence || !v.code.as_ref().is_some_and(|c| c.first) {
            continue;
        }
        let fence = src[v.from..v.to].trim_start();
        let info = fence.trim_start_matches(['`', '~']);
        let Some(lang) = highlight::info_lang(info) else { continue };
        let mut lines = Vec::new();
        let mut text = String::new();
        while i < views.len() && views[i].code.as_ref().is_some_and(|c| !c.first) && views[i].kind == BlockType::Code {
            let w = &views[i];
            let (a, b) = w.segments.iter().find(|s| s.kind == SegKind::Text).map_or((w.to, w.to), |s| (s.from, w.to));
            if !lines.is_empty() {
                text.push('\n');
            }
            text.push_str(&src[a..b]);
            lines.push((i, a, b));
            i += 1;
        }
        out.push(Found { lang, lines, text });
    }
    out
}

/// The colouring of each line of `views` (indexed like it; empty when no block is highlighted).
pub fn highlight(src: &str, views: &[LineView]) -> Vec<Option<LineHl>> {
    let found = find_blocks(src, views);
    CACHE.with(|cell| {
        let mut cache = cell.borrow_mut();
        if found.is_empty() {
            cache.blocks.clear();
            return Vec::new();
        }
        cache.tick += 1;
        let tick = cache.tick;
        let mut old: Vec<Option<Block>> = std::mem::take(&mut cache.blocks).into_iter().map(Some).collect();
        let mut blocks: Vec<Option<Block>> = found.iter().map(|_| None).collect();
        // unchanged blocks keep theirs
        for (k, f) in found.iter().enumerate() {
            if let Some(o) = old.iter_mut().find(|o| o.as_ref().is_some_and(|b| b.lang == f.lang && b.text == f.text)) {
                blocks[k] = o.take();
            }
        }
        // a changed block takes the nearest left over of its language, as one edit
        for (k, f) in found.iter().enumerate() {
            if blocks[k].is_some() {
                continue;
            }
            let near = (0..old.len())
                .filter(|&j| old[j].as_ref().is_some_and(|b| b.lang == f.lang))
                .min_by_key(|&j| j.abs_diff(k));
            blocks[k] = Some(match near.and_then(|j| old[j].take()) {
                Some(mut b) => {
                    b.update(f.text.clone(), tick);
                    b
                }
                None => Block::new(f.lang, f.text.clone(), tick),
            });
        }
        let mut blocks: Vec<Block> = blocks.into_iter().flatten().collect();
        // keep the most recently edited tokenizers
        let mut live: Vec<(u64, usize)> =
            blocks.iter().enumerate().filter(|(_, b)| matches!(b.state, State::Live(_))).map(|(i, b)| (b.tick, i)).collect();
        if live.len() > LIVE_MAX {
            live.sort_unstable_by(|a, b| b.cmp(a));
            for &(_, i) in &live[LIVE_MAX..] {
                if let State::Live(t) = std::mem::replace(&mut blocks[i].state, State::Failed) {
                    blocks[i].state = State::Frozen(t.into_lines());
                }
            }
        }

        let th = theme();
        let mut out: Vec<Option<LineHl>> = vec![None; views.len()];
        for (f, b) in found.iter().zip(&blocks) {
            for (k, &(vi, a, b_end)) in f.lines.iter().enumerate() {
                let toks = b.line(k);
                let tokens = toks
                    .iter()
                    .filter(|t| !th.is_plain(t.id))
                    .map(|t| (a + t.start as usize, (a + t.end as usize).min(b_end), t.id))
                    .collect();
                let bg = th.line_bg(f.lang, toks, &src[a..b_end]);
                out[vi] = Some(LineHl { tokens, bg });
            }
        }
        cache.blocks = blocks;
        out
    })
}


#[cfg(test)]
mod tests {
    use editor_core::{Editor, Sel};

    use super::*;

    fn live_count() -> usize {
        CACHE.with(|c| c.borrow().blocks.iter().filter(|b| matches!(b.state, State::Live(_))).count())
    }

    #[test]
    fn many_blocks_past_the_live_limit() {
        let src: String = (0..12).map(|i| format!("```ts\nconst a{i} = {i};\n```\n")).collect();
        let mut ed = Editor::new(&src);
        let first = highlight(ed.text(), &ed.render_lines());
        assert_eq!(first.iter().flatten().count(), 12);
        assert!(first.iter().flatten().all(|l| !l.tokens.is_empty()));
        assert_eq!(live_count(), LIVE_MAX);
        // the first block was frozen: an edit there tokenizes it again
        ed.set_selection(Sel::caret(src.find("const a0").unwrap()));
        ed.insert_text("/* x */ ");
        let edited = highlight(ed.text(), &ed.render_lines());
        assert_eq!(live_count(), LIVE_MAX);
        CACHE.with(|c| c.borrow_mut().blocks.clear());
        assert_eq!(edited, highlight(ed.text(), &ed.render_lines()));
        // another note: the cache follows it
        let ed = Editor::new("no code here");
        assert!(highlight(ed.text(), &ed.render_lines()).is_empty());
        assert!(CACHE.with(|c| c.borrow().blocks.is_empty()));
    }
}
