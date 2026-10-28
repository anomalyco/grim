//! The macOS text system's key bindings as an editor key table: Cocoa's own
//! `StandardKeyBinding.dict` (`STANDARD`, copied from AppKit), a few Grimoire changes
//! (`GRIMOIRE`) and, on top, the user's `~/Library/KeyBindings/DefaultKeyBinding.dict`.
//!
//! - `parse_dict`: the dict format: old-style plist text (`{ "^a" = "moveToBeginningOfParagraph:"; }`,
//!   comments, `\UF702` escapes, arrays in parentheses) or the JSON `plutil -convert json` writes.
//! - `parse_chord`: Cocoa key strings: modifier prefixes `^` Ctrl, `~` Option, `$` Shift, `@` Cmd
//!   (`#`, the keypad flag, is ignored), then one key: a character (an uppercase letter means
//!   Shift) or a function-key code (`\UF700`–`\UF703` arrows, `\UF728` forward delete, `\UF729`
//!   Home, `\UF72B` End, `\UF72C`/`\UF72D` PageUp/PageDown, `\U007F` Backspace, `\U000D` Return,
//!   `\U0009` Tab, `\U0019` Shift-Tab, `\U001B` Escape).
//! - `selector`: an `NSStandardKeyBindingResponding` selector as an editor `Command` (None: not
//!   implemented; an entry naming one is ignored, so the binding below it stays).
//! - `KeyTable::resolve`: Grimoire's Cmd shortcuts first (Cmd-B, Cmd-Z, folds… like menu key
//!   equivalents), then the table (later dicts win), then the rest of `keymap::bindings()` for
//!   chords the table doesn't name (Shift-Backspace, Cmd-Delete, Shift-Enter…).

use crate::keymap::{self, Command, Key, Mods};
use crate::navigation::HUnit;

/// AppKit's `StandardKeyBinding.dict` (macOS 15.3), without its `noop:` entries (unused function
/// keys).
pub const STANDARD: &str = r#"{
    "\U0003" = "insertNewline:";
    "\U0008" = "deleteBackward:";
    "\U0009" = "insertTab:";
    "\U000A" = "insertNewline:";
    "\U000D" = "insertNewline:";
    "\U0019" = "insertBacktab:";
    "\U001B" = "cancelOperation:";
    "$\UF700" = "moveUpAndModifySelection:";
    "$\UF701" = "moveDownAndModifySelection:";
    "$\UF702" = "moveLeftAndModifySelection:";
    "$\UF703" = "moveRightAndModifySelection:";
    "$\UF729" = "moveToBeginningOfDocumentAndModifySelection:";
    "$\UF72B" = "moveToEndOfDocumentAndModifySelection:";
    "$\UF72C" = "pageUpAndModifySelection:";
    "$\UF72D" = "pageDownAndModifySelection:";
    "@ " = "cycleToNextInputScript:";
    "@$\UF700" = "moveToBeginningOfDocumentAndModifySelection:";
    "@$\UF701" = "moveToEndOfDocumentAndModifySelection:";
    "@$\UF702" = "moveToLeftEndOfLineAndModifySelection:";
    "@$\UF703" = "moveToRightEndOfLineAndModifySelection:";
    "@." = "cancelOperation:";
    "@^ " = "togglePlatformInputSystem:";
    "@^\UF701" = "makeBaseWritingDirectionNatural:";
    "@^\UF702" = "makeBaseWritingDirectionRightToLeft:";
    "@^\UF703" = "makeBaseWritingDirectionLeftToRight:";
    "@~ " = "cycleToNextInputKeyboardLayout:";
    "@~^\UF701" = "makeTextWritingDirectionNatural:";
    "@~^\UF702" = "makeTextWritingDirectionRightToLeft:";
    "@~^\UF703" = "makeTextWritingDirectionLeftToRight:";
    "@\U007F" = "deleteToBeginningOfLine:";
    "@\UF700" = "moveToBeginningOfDocument:";
    "@\UF701" = "moveToEndOfDocument:";
    "@\UF702" = "moveToLeftEndOfLine:";
    "@\UF703" = "moveToRightEndOfLine:";
    "^\U0003" = "insertLineBreak:";
    "^\U0009" = "selectNextKeyView:";
    "^\U000A" = "insertLineBreak:";
    "^\U000D" = "insertLineBreak:";
    "^\U0019" = "selectPreviousKeyView:";
    "^\"" = "insertDoubleQuoteIgnoringSubstitution:";
    "^$\UF702" = "moveToLeftEndOfLineAndModifySelection:";
    "^$\UF703" = "moveToRightEndOfLineAndModifySelection:";
    "^'" = "insertSingleQuoteIgnoringSubstitution:";
    "^/" = "insertRightToLeftSlash:";
    "^A" = "moveToBeginningOfParagraphAndModifySelection:";
    "^B" = "moveBackwardAndModifySelection:";
    "^E" = "moveToEndOfParagraphAndModifySelection:";
    "^F" = "moveForwardAndModifySelection:";
    "^N" = "moveDownAndModifySelection:";
    "^P" = "moveUpAndModifySelection:";
    "^V" = "pageDownAndModifySelection:";
    "^a" = "moveToBeginningOfParagraph:";
    "^b" = "moveBackward:";
    "^d" = "deleteForward:";
    "^e" = "moveToEndOfParagraph:";
    "^f" = "moveForward:";
    "^h" = "deleteBackward:";
    "^k" = "deleteToEndOfParagraph:";
    "^l" = "centerSelectionInVisibleArea:";
    "^n" = "moveDown:";
    "^o" = ("insertNewlineIgnoringFieldEditor:", "moveBackward:");
    "^p" = "moveUp:";
    "^t" = "transpose:";
    "^v" = "pageDown:";
    "^y" = "yank:";
    "^\U007F" = "deleteBackwardByDecomposingPreviousCharacter:";
    "^\UF700" = "scrollPageUp:";
    "^\UF701" = "scrollPageDown:";
    "^\UF702" = "moveToLeftEndOfLine:";
    "^\UF703" = "moveToRightEndOfLine:";
    "~\U0003" = "insertNewlineIgnoringFieldEditor:";
    "~\U0008" = "deleteWordBackward:";
    "~\U0009" = "insertTabIgnoringFieldEditor:";
    "~\U000A" = "insertNewlineIgnoringFieldEditor:";
    "~\U000D" = "insertNewlineIgnoringFieldEditor:";
    "~\U001B" = "complete:";
    "~$\UF700" = "moveParagraphBackwardAndModifySelection:";
    "~$\UF701" = "moveParagraphForwardAndModifySelection:";
    "~$\UF702" = "moveWordLeftAndModifySelection:";
    "~$\UF703" = "moveWordRightAndModifySelection:";
    "~^B" = "moveWordBackwardAndModifySelection:";
    "~^F" = "moveWordForwardAndModifySelection:";
    "~^b" = "moveWordBackward:";
    "~^f" = "moveWordForward:";
    "~^\U007F" = "deleteWordBackward:";
    "~\U007F" = "deleteWordBackward:";
    "~\UF700" = ("moveBackward:", "moveToBeginningOfParagraph:");
    "~\UF701" = ("moveForward:", "moveToEndOfParagraph:");
    "~\UF702" = "moveWordLeft:";
    "~\UF703" = "moveWordRight:";
    "~\UF728" = "deleteWordForward:";
    "~\UF72C" = "pageUp:";
    "~\UF72D" = "pageDown:";
    "\U007F" = "deleteBackward:";
    "\UF700" = "moveUp:";
    "\UF701" = "moveDown:";
    "\UF702" = "moveLeft:";
    "\UF703" = "moveRight:";
    "\UF708" = "complete:";
    "\UF728" = "deleteForward:";
    "\UF729" = "scrollToBeginningOfDocument:";
    "\UF72B" = "scrollToEndOfDocument:";
    "\UF72C" = "scrollPageUp:";
    "\UF72D" = "scrollPageDown:";
    "\UF739" = "delete:";
}"#;

/// Grimoire's changes to the standard table (a user dict can undo them).
pub const GRIMOIRE: &str = r#"{
    /* PageUp/PageDown move the caret a page, keeping its x (Cocoa only scrolls). */
    "\UF72C" = "pageUp:";
    "\UF72D" = "pageDown:";
}"#;

/// A dict value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Str(String),
    List(Vec<Value>),
    /// A nested dict (a multi-key sequence in a key-binding dict: not supported, ignored).
    Dict(Vec<(String, Value)>),
}

/// Parse a dict file (old-style plist text or JSON) into its top-level entries, in order.
pub fn parse_dict(src: &str) -> Result<Vec<(String, Value)>, String> {
    let mut p = Parser { s: src.trim_start_matches('\u{feff}').chars().collect(), i: 0 };
    p.ws()?;
    let Value::Dict(d) = p.value()? else { return Err("not a dict".into()) };
    p.ws()?;
    if p.i < p.s.len() {
        return Err(format!("unexpected {:?} after the dict", p.s[p.i]));
    }
    Ok(d)
}

struct Parser {
    s: Vec<char>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }

    fn err<T>(&self, what: &str) -> Result<T, String> {
        let line = self.s[..self.i.min(self.s.len())].iter().filter(|&&c| c == '\n').count() + 1;
        Err(format!("line {line}: {what}"))
    }

    /// Whitespace and comments.
    fn ws(&mut self) -> Result<(), String> {
        loop {
            match (self.peek(), self.s.get(self.i + 1)) {
                (Some(c), _) if c.is_whitespace() => self.i += 1,
                (Some('/'), Some('/')) => {
                    while self.peek().is_some_and(|c| c != '\n') {
                        self.i += 1;
                    }
                }
                (Some('/'), Some('*')) => {
                    self.i += 2;
                    loop {
                        match self.peek() {
                            None => return self.err("unclosed comment"),
                            Some('*') if self.s.get(self.i + 1) == Some(&'/') => {
                                self.i += 2;
                                break;
                            }
                            _ => self.i += 1,
                        }
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        match self.peek() {
            Some('{') => {
                self.i += 1;
                let mut out = Vec::new();
                loop {
                    self.ws()?;
                    if self.peek() == Some('}') {
                        self.i += 1;
                        return Ok(Value::Dict(out));
                    }
                    let k = self.string()?;
                    self.ws()?;
                    match self.peek() {
                        Some('=' | ':') => self.i += 1,
                        _ => return self.err("expected = after a key"),
                    }
                    self.ws()?;
                    let v = self.value()?;
                    out.push((k, v));
                    self.ws()?;
                    match self.peek() {
                        Some(';' | ',') => self.i += 1,
                        Some('}') => {}
                        _ => return self.err("expected ; after a value"),
                    }
                }
            }
            Some(open @ ('(' | '[')) => {
                let close = if open == '(' { ')' } else { ']' };
                self.i += 1;
                let mut out = Vec::new();
                loop {
                    self.ws()?;
                    if self.peek() == Some(close) {
                        self.i += 1;
                        return Ok(Value::List(out));
                    }
                    out.push(self.value()?);
                    self.ws()?;
                    match self.peek() {
                        Some(',') => self.i += 1,
                        Some(c) if c == close => {}
                        _ => return self.err("expected , in a list"),
                    }
                }
            }
            _ => Ok(Value::Str(self.string()?)),
        }
    }

    fn string(&mut self) -> Result<String, String> {
        let mut out = String::new();
        if self.peek() != Some('"') {
            while let Some(c) = self.peek().filter(|&c| !c.is_whitespace() && !"{}()[]=;,\"".contains(c)) {
                out.push(c);
                self.i += 1;
            }
            return if out.is_empty() { self.err("expected a string") } else { Ok(out) };
        }
        self.i += 1;
        loop {
            let Some(c) = self.peek() else { return self.err("unclosed string") };
            self.i += 1;
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let Some(e) = self.peek() else { return self.err("unclosed string") };
                    self.i += 1;
                    match e {
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        'r' => out.push('\r'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'a' => out.push('\u{7}'),
                        'v' => out.push('\u{b}'),
                        'U' | 'u' => {
                            let mut n = 0u32;
                            let mut k = 0;
                            while k < 4 && let Some(d) = self.peek().and_then(|c| c.to_digit(16)) {
                                n = n * 16 + d;
                                self.i += 1;
                                k += 1;
                            }
                            if k == 0 {
                                return self.err("bad \\U escape");
                            }
                            out.push(char::from_u32(n).unwrap_or('\u{fffd}'));
                        }
                        '0'..='7' => {
                            let mut n = e.to_digit(8).unwrap_or(0);
                            let mut k = 1;
                            while k < 3 && let Some(d) = self.peek().and_then(|c| c.to_digit(8)) {
                                n = n * 8 + d;
                                self.i += 1;
                                k += 1;
                            }
                            out.push(char::from_u32(n).unwrap_or('\u{fffd}'));
                        }
                        other => out.push(other),
                    }
                }
                c => out.push(c),
            }
        }
    }
}

/// A key chord of a binding dict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chord {
    pub key: Key,
    pub mods: Mods,
    /// Shift doesn't matter: a printable key that isn't a letter (the character says it: `^"`).
    pub any_shift: bool,
}

impl Chord {
    pub fn matches(&self, key: Key, mods: Mods) -> bool {
        keymap::key_eq(self.key, key)
            && self.mods.ctrl == mods.ctrl
            && self.mods.alt == mods.alt
            && self.mods.cmd == mods.cmd
            && (self.any_shift || self.mods.shift == mods.shift)
    }
}

/// A Cocoa key string as a chord. None for keys that don't reach the editor as such (other
/// function keys, the control characters of keys that arrive as their own key).
pub fn parse_chord(s: &str) -> Option<Chord> {
    let chars: Vec<char> = s.chars().collect();
    let (&last, prefix) = chars.split_last()?;
    let mut mods = Mods::NONE;
    for &c in prefix {
        match c {
            '^' => mods.ctrl = true,
            '~' => mods.alt = true,
            '$' => mods.shift = true,
            '@' => mods.cmd = true,
            '#' => {}
            _ => return None,
        }
    }
    let named = match last as u32 {
        0xF700 => Some(Key::Up),
        0xF701 => Some(Key::Down),
        0xF702 => Some(Key::Left),
        0xF703 => Some(Key::Right),
        0xF728 => Some(Key::Delete),
        0xF729 => Some(Key::Home),
        0xF72B => Some(Key::End),
        0xF72C => Some(Key::PageUp),
        0xF72D => Some(Key::PageDown),
        0x7F => Some(Key::Backspace),
        0x0D => Some(Key::Enter),
        0x09 => Some(Key::Tab),
        0x19 => {
            mods.shift = true;
            Some(Key::Tab)
        }
        0x1B => Some(Key::Escape),
        c if c < 0x20 || (0xF700..=0xF8FF).contains(&c) => return None,
        _ => None,
    };
    if let Some(key) = named {
        return Some(Chord { key, mods, any_shift: false });
    }
    let mut lower = last.to_lowercase();
    let low = lower.next().filter(|_| lower.next().is_none()).unwrap_or(last);
    if low != last {
        mods.shift = true;
    }
    Some(Chord { key: Key::Char(low), mods, any_shift: !last.is_alphabetic() && !mods.shift })
}

/// A key-binding selector (`moveLeft:`, with or without the colon) as an editor command; None
/// when Grimoire doesn't implement it.
pub fn selector(name: &str) -> Option<Command> {
    use Command as C;
    let name = name.strip_suffix(':').unwrap_or(name);
    let (base, extend) = match name.strip_suffix("AndModifySelection") {
        Some(b) => (b, true),
        None => (name, false),
    };
    let mv = |dir, unit| C::Move { dir, unit, extend };
    Some(match base {
        "moveLeft" | "moveBackward" => mv(-1, HUnit::Char),
        "moveRight" | "moveForward" => mv(1, HUnit::Char),
        "moveUp" => C::MoveVertical { dir: -1, extend },
        "moveDown" => C::MoveVertical { dir: 1, extend },
        "moveWordLeft" | "moveWordBackward" => mv(-1, HUnit::Word),
        "moveWordRight" | "moveWordForward" => mv(1, HUnit::Word),
        "moveToBeginningOfParagraph" => mv(-1, HUnit::Line),
        "moveToEndOfParagraph" => mv(1, HUnit::Line),
        "moveParagraphBackward" => C::MoveParagraph { dir: -1, extend },
        "moveParagraphForward" => C::MoveParagraph { dir: 1, extend },
        "moveToBeginningOfLine" | "moveToLeftEndOfLine" => C::MoveLineEdge { dir: -1, extend },
        "moveToEndOfLine" | "moveToRightEndOfLine" => C::MoveLineEdge { dir: 1, extend },
        "moveToBeginningOfDocument" => mv(-1, HUnit::Doc),
        "moveToEndOfDocument" => mv(1, HUnit::Doc),
        "pageUp" => C::Page { dir: -1, extend },
        "pageDown" => C::Page { dir: 1, extend },
        _ if extend => return None,
        "scrollToBeginningOfDocument" => C::ScrollToStart,
        "scrollToEndOfDocument" => C::ScrollToEnd,
        "centerSelectionInVisibleArea" => C::CenterSelection,
        "deleteBackward" => C::DeleteBackward,
        "deleteForward" => C::DeleteForward,
        "deleteWordBackward" => C::DeleteWordBackward,
        "deleteWordForward" => C::DeleteWordForward,
        "deleteToBeginningOfLine" | "deleteToBeginningOfParagraph" => C::DeleteToLineStart,
        "deleteToEndOfLine" | "deleteToEndOfParagraph" => C::DeleteToLineEnd,
        "deleteBackwardByDecomposingPreviousCharacter" => C::DeleteBackwardDecomposing,
        "deleteToMark" => C::DeleteToMark,
        "setMark" => C::SetMark,
        "swapWithMark" => C::SwapWithMark,
        "selectToMark" => C::SelectToMark,
        "yank" => C::Yank,
        "transpose" => C::Transpose,
        "insertNewline" | "insertNewlineIgnoringFieldEditor" | "insertParagraphSeparator" => C::InsertParagraph,
        "insertLineBreak" => C::InsertLineBreak,
        "insertTab" | "insertTabIgnoringFieldEditor" => C::Tab { shift: false },
        "insertBacktab" => C::Tab { shift: true },
        "insertDoubleQuoteIgnoringSubstitution" => C::InsertChar('"'),
        "insertSingleQuoteIgnoringSubstitution" => C::InsertChar('\''),
        "selectAll" => C::SelectAll,
        "selectWord" => C::SelectWord,
        "selectParagraph" => C::SelectParagraph,
        "undo" => C::Undo,
        "redo" => C::Redo,
        "noop" => C::Noop,
        _ => return None,
    })
}

/// A binding's value (one selector or a list run in order) as commands; None when it names a
/// selector Grimoire doesn't implement (or isn't a selector list). Known pairs become the
/// editor's own command: Option-Up/Down (`moveBackward:` + `moveToBeginningOfParagraph:`) is
/// `MoveParagraph`, Ctrl-O (`insertNewline…:` + `moveBackward:`) is `OpenLine`.
pub fn commands(v: &Value) -> Option<Vec<Command>> {
    use Command as C;
    let mut out = match v {
        Value::Str(s) => vec![selector(s)?],
        Value::List(l) => l.iter().map(|x| if let Value::Str(s) = x { selector(s) } else { None }).collect::<Option<Vec<_>>>()?,
        Value::Dict(_) => return None,
    };
    if out.len() > 1 {
        out.retain(|&c| c != C::Noop);
    }
    Some(match out.as_slice() {
        [C::Move { dir: -1, unit: HUnit::Char, extend: e }, C::Move { dir: -1, unit: HUnit::Line, extend: f }] if e == f => {
            vec![C::MoveParagraph { dir: -1, extend: *e }]
        }
        [C::Move { dir: 1, unit: HUnit::Char, extend: e }, C::Move { dir: 1, unit: HUnit::Line, extend: f }] if e == f => {
            vec![C::MoveParagraph { dir: 1, extend: *e }]
        }
        [C::InsertParagraph | C::InsertLineBreak, C::Move { dir: -1, unit: HUnit::Char, extend: false }] => vec![C::OpenLine],
        [] => return None,
        _ => out,
    })
}

/// The macOS key table (see the module docs).
#[derive(Clone, Debug, Default)]
pub struct KeyTable {
    /// In the order added: later entries win.
    entries: Vec<(Chord, Vec<Command>)>,
}

impl KeyTable {
    /// Cocoa's standard bindings with Grimoire's changes.
    pub fn standard() -> KeyTable {
        let mut t = KeyTable::default();
        t.add_dict(STANDARD).expect("STANDARD parses");
        t.add_dict(GRIMOIRE).expect("GRIMOIRE parses");
        t
    }

    /// Add a dict's bindings over the current ones (the user's DefaultKeyBinding.dict). Entries
    /// whose chord or selectors aren't supported are skipped (the binding below stays). Returns
    /// the number of entries used.
    pub fn add_dict(&mut self, src: &str) -> Result<usize, String> {
        let entries = parse_dict(src)?;
        Ok(entries.iter().filter(|(k, v)| self.add(k, v)).count())
    }

    /// Bind a chord (`"^a"`) to a value. False (nothing changes) if either isn't supported.
    pub fn add(&mut self, chord: &str, v: &Value) -> bool {
        let (Some(c), Some(cmds)) = (parse_chord(chord), commands(v)) else { return false };
        self.entries.push((c, cmds));
        true
    }

    /// The table's commands for a key (ignoring the app shortcuts and the fallback).
    pub fn lookup(&self, key: Key, mods: Mods) -> Option<&[Command]> {
        self.entries.iter().rev().find(|(c, _)| c.matches(key, mods)).map(|(_, v)| v.as_slice())
    }

    /// The commands for a key press: Grimoire's Cmd-character shortcuts, then the table, then
    /// `keymap::resolve`. None: not the editor's.
    pub fn resolve(&self, key: Key, mods: Mods) -> Option<Vec<Command>> {
        if matches!(key, Key::Char(_)) && mods.cmd
            && let Some(c) = keymap::resolve(key, mods)
        {
            return Some(vec![c]);
        }
        if let Some(v) = self.lookup(key, mods) {
            return Some(v.to_vec());
        }
        keymap::resolve(key, mods).map(|c| vec![c])
    }
}
