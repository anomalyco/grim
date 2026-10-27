//! Key -> command mapping (macOS), mirroring the TS keydown handler plus the browser's native
//! editing intents (beforeinput) for Backspace/Delete/Enter. Plain text input does not go through
//! the keymap: the UI sends it to `Editor::insert_text`.

use crate::navigation::HUnit;
use crate::rules::FormatType;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    /// A character key (matched case-insensitively for shortcuts).
    Char(char),
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    /// PageUp/PageDown aren't in `bindings()`: paging needs the viewport height, so the UI does
    /// it (`resolve` returns None; the macOS table returns `Command::Page`).
    PageUp,
    PageDown,
    Backspace,
    /// Forward delete (fn-Backspace).
    Delete,
    Enter,
    Tab,
    Escape,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Mods {
    pub shift: bool,
    pub ctrl: bool,
    /// Option.
    pub alt: bool,
    pub cmd: bool,
}

impl Mods {
    pub const NONE: Mods = Mods { shift: false, ctrl: false, alt: false, cmd: false };
    pub const SHIFT: Mods = Mods { shift: true, ..Mods::NONE };
    pub const CMD: Mods = Mods { cmd: true, ..Mods::NONE };
    pub const ALT: Mods = Mods { alt: true, ..Mods::NONE };
    pub const CTRL: Mods = Mods { ctrl: true, ..Mods::NONE };
    pub const CMD_SHIFT: Mods = Mods { cmd: true, shift: true, ..Mods::NONE };
    pub const ALT_SHIFT: Mods = Mods { alt: true, shift: true, ..Mods::NONE };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Command {
    Undo,
    Redo,
    SelectAll,
    ToggleFormat(FormatType),
    /// Left/Right: dir -1 / +1.
    Move { dir: i32, unit: HUnit, extend: bool },
    /// Up/Down by visual line (needs the layout).
    MoveVertical { dir: i32, extend: bool },
    /// Option-Up/Down.
    MoveParagraph { dir: i32, extend: bool },
    /// Cmd-Left/Right (macOS table): the visual line's start / end when the caret's logical line
    /// wraps there (`Layout::caret_rect` / `hit_test`), else `Move { unit: Line }`.
    MoveLineEdge { dir: i32, extend: bool },
    /// PageUp/PageDown (macOS table: also Option-PageUp/PageDown, Ctrl-V): the caret moves a page.
    /// Paging needs the viewport, so the UI does it (the editor does nothing).
    Page { dir: i32, extend: bool },
    /// Ctrl-L: scroll the caret's line to the middle of the view (the UI does it).
    CenterSelection,
    /// Home/End on macOS scroll the view without moving the caret: the UI handles these.
    ScrollToStart,
    ScrollToEnd,
    Tab { shift: bool },
    InsertParagraph,
    InsertLineBreak,
    DeleteBackward,
    DeleteForward,
    DeleteWordBackward,
    DeleteWordForward,
    DeleteToLineStart,
    DeleteToLineEnd,
    /// Ctrl-Backspace: the previous character's last part (é -> e, a Hangul syllable's last jamo).
    DeleteBackwardDecomposing,
    /// Ctrl-Y: insert the kill buffer (what the last run of kills deleted), its own undo step.
    Yank,
    /// Ctrl-T: swap the characters around the caret (at a line end: the two before it).
    Transpose,
    /// Ctrl-O: a newline after the caret, the caret stays.
    OpenLine,
    /// Insert a character without typing rules (Ctrl-Shift-' / Ctrl-').
    InsertChar(char),
    /// The emacs-style mark (only reachable from a user's DefaultKeyBinding.dict).
    SetMark,
    SwapWithMark,
    SelectToMark,
    DeleteToMark,
    SelectWord,
    /// The caret's logical line with its newline (as a triple click).
    SelectParagraph,
    /// A key bound to `noop:` in the user's DefaultKeyBinding.dict: taken, nothing happens.
    Noop,
    /// Cmd-': fold / unfold the heading at the caret (elsewhere: fold the section around it).
    ToggleFold,
    /// Cmd-Option-[ / Cmd-Option-]: fold the section at the caret (again: the one around it) / unfold.
    FoldAtCaret,
    UnfoldAtCaret,
    /// Cmd-Option-Shift-[ / ]: fold / unfold every heading.
    FoldAll,
    UnfoldAll,
}

impl Command {
    /// Deletions that go into the kill buffer (as in Cocoa).
    pub fn is_kill(self) -> bool {
        matches!(
            self,
            Command::DeleteWordBackward
                | Command::DeleteWordForward
                | Command::DeleteToLineStart
                | Command::DeleteToLineEnd
                | Command::DeleteToMark
        )
    }

    /// The command changes the text (or the undo history).
    pub fn is_edit(self) -> bool {
        !matches!(
            self,
            Command::SelectAll
                | Command::Move { .. }
                | Command::MoveVertical { .. }
                | Command::MoveParagraph { .. }
                | Command::MoveLineEdge { .. }
                | Command::Page { .. }
                | Command::CenterSelection
                | Command::SetMark
                | Command::SwapWithMark
                | Command::SelectToMark
                | Command::SelectWord
                | Command::SelectParagraph
                | Command::Noop
                | Command::ScrollToStart
                | Command::ScrollToEnd
                | Command::ToggleFold
                | Command::FoldAtCaret
                | Command::UnfoldAtCaret
                | Command::FoldAll
                | Command::UnfoldAll
        )
    }
}

/// Modifier requirement in a binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Req {
    Yes,
    No,
    Any,
}

impl Req {
    fn ok(self, v: bool) -> bool {
        match self {
            Req::Yes => v,
            Req::No => !v,
            Req::Any => true,
        }
    }
}

/// What a binding does. `Unhandled` stops the lookup and leaves the key to the system (e.g.
/// Ctrl-arrows on macOS).
#[derive(Clone, Copy, Debug)]
pub enum Action {
    Run(Command),
    /// The command depends on Shift (Shift extends / redoes / outdents).
    Shifted(fn(bool) -> Command),
    Unhandled,
}

#[derive(Clone, Copy, Debug)]
pub struct Binding {
    pub key: Key,
    pub cmd: Req,
    pub alt: Req,
    pub ctrl: Req,
    pub shift: Req,
    pub action: Action,
    pub doc: &'static str,
}

const fn b(key: Key, cmd: Req, alt: Req, ctrl: Req, shift: Req, action: Action, doc: &'static str) -> Binding {
    Binding { key, cmd, alt, ctrl, shift, action, doc }
}

use Req::{Any, No, Yes};

fn mv(dir: i32, unit: HUnit) -> fn(bool) -> Command {
    // fn pointers can't capture: one per (dir, unit)
    match (dir, unit) {
        (-1, HUnit::Char) => |e| Command::Move { dir: -1, unit: HUnit::Char, extend: e },
        (1, HUnit::Char) => |e| Command::Move { dir: 1, unit: HUnit::Char, extend: e },
        (-1, HUnit::Word) => |e| Command::Move { dir: -1, unit: HUnit::Word, extend: e },
        (1, HUnit::Word) => |e| Command::Move { dir: 1, unit: HUnit::Word, extend: e },
        (-1, HUnit::Line) => |e| Command::Move { dir: -1, unit: HUnit::Line, extend: e },
        (1, HUnit::Line) => |e| Command::Move { dir: 1, unit: HUnit::Line, extend: e },
        (-1, _) => |e| Command::Move { dir: -1, unit: HUnit::Doc, extend: e },
        _ => |e| Command::Move { dir: 1, unit: HUnit::Doc, extend: e },
    }
}

/// The key map, in precedence order (first match wins). The default for `Editor::key` (the web
/// app's; the browser does the rest of the text system's keys). The native app uses
/// `macos_keys::KeyTable`, which keeps the Cmd-character shortcuts of this table in front and this
/// table as its fallback.
pub fn bindings() -> Vec<Binding> {
    use Action::{Run, Shifted, Unhandled};
    use Command as C;
    use Key as K;
    vec![
        b(K::Char('z'), Yes, No, Any, No, Run(C::Undo), "Cmd-Z: undo"),
        b(K::Char('z'), Yes, No, Any, Yes, Run(C::Redo), "Cmd-Shift-Z: redo"),
        b(K::Char('a'), Yes, No, Any, No, Run(C::SelectAll), "Cmd-A: select all"),
        b(K::Char('b'), Yes, No, Any, No, Run(C::ToggleFormat(FormatType::Bold)), "Cmd-B: bold"),
        b(K::Char('i'), Yes, No, Any, No, Run(C::ToggleFormat(FormatType::Italic)), "Cmd-I: italic"),
        b(K::Char('u'), Yes, No, Any, No, Run(C::ToggleFormat(FormatType::Underline)), "Cmd-U: underline (~x~)"),
        b(K::Char('\''), Yes, No, Any, No, Run(C::ToggleFold), "Cmd-': toggle folding (Bear)"),
        b(K::Char('['), Yes, Yes, Any, No, Run(C::FoldAtCaret), "Cmd-Option-[: fold the section at the caret"),
        b(K::Char(']'), Yes, Yes, Any, No, Run(C::UnfoldAtCaret), "Cmd-Option-]: unfold the heading at the caret"),
        b(K::Char('['), Yes, Yes, Any, Yes, Run(C::FoldAll), "Cmd-Option-Shift-[: fold all headings"),
        b(K::Char('{'), Yes, Yes, Any, Any, Run(C::FoldAll), "Cmd-Option-{: fold all headings"),
        b(K::Char(']'), Yes, Yes, Any, Yes, Run(C::UnfoldAll), "Cmd-Option-Shift-]: unfold all headings"),
        b(K::Char('}'), Yes, Yes, Any, Any, Run(C::UnfoldAll), "Cmd-Option-}: unfold all headings"),
        b(K::Left, Yes, Any, Any, Any, Shifted(mv(-1, HUnit::Line)), "Cmd-Left: text start, then column 0"),
        b(K::Right, Yes, Any, Any, Any, Shifted(mv(1, HUnit::Line)), "Cmd-Right: line end"),
        b(K::Left, No, Yes, Any, Any, Shifted(mv(-1, HUnit::Word)), "Option-Left: word left"),
        b(K::Right, No, Yes, Any, Any, Shifted(mv(1, HUnit::Word)), "Option-Right: word right"),
        b(K::Left, No, No, Yes, Any, Unhandled, "Ctrl-Left: system"),
        b(K::Right, No, No, Yes, Any, Unhandled, "Ctrl-Right: system"),
        b(K::Left, No, No, No, Any, Shifted(mv(-1, HUnit::Char)), "Left: one unit (Shift extends)"),
        b(K::Right, No, No, No, Any, Shifted(mv(1, HUnit::Char)), "Right: one unit (Shift extends)"),
        b(K::Up, Yes, Any, Any, Any, Shifted(mv(-1, HUnit::Doc)), "Cmd-Up: document start"),
        b(K::Down, Yes, Any, Any, Any, Shifted(mv(1, HUnit::Doc)), "Cmd-Down: document end"),
        b(K::Up, No, Yes, Any, Any, Shifted(|e| C::MoveParagraph { dir: -1, extend: e }), "Option-Up: line start / previous line"),
        b(K::Down, No, Yes, Any, Any, Shifted(|e| C::MoveParagraph { dir: 1, extend: e }), "Option-Down: line end / next line"),
        b(K::Up, No, No, No, Any, Shifted(|e| C::MoveVertical { dir: -1, extend: e }), "Up: previous visual line (goal x)"),
        b(K::Down, No, No, No, Any, Shifted(|e| C::MoveVertical { dir: 1, extend: e }), "Down: next visual line (goal x)"),
        b(K::Home, Any, Any, Any, Any, Run(C::ScrollToStart), "Home: scroll to top (caret stays)"),
        b(K::End, Any, Any, Any, Any, Run(C::ScrollToEnd), "End: scroll to bottom (caret stays)"),
        b(K::Tab, No, No, No, Any, Shifted(|s| C::Tab { shift: s }), "Tab / Shift-Tab: indent, nest, next cell / outdent"),
        b(K::Backspace, Yes, Any, Any, Any, Run(C::DeleteToLineStart), "Cmd-Backspace: delete to text start"),
        b(K::Backspace, No, Yes, Any, Any, Run(C::DeleteWordBackward), "Option-Backspace: delete word"),
        b(K::Backspace, No, No, Any, Any, Run(C::DeleteBackward), "Backspace"),
        b(K::Delete, Yes, Any, Any, Any, Run(C::DeleteToLineEnd), "Cmd-Delete: delete to line end"),
        b(K::Delete, No, Yes, Any, Any, Run(C::DeleteWordForward), "Option-Delete: delete word forward"),
        b(K::Delete, No, No, Any, Any, Run(C::DeleteForward), "Delete (forward)"),
        b(K::Char('h'), No, No, Yes, No, Run(C::DeleteBackward), "Ctrl-H: backspace"),
        b(K::Char('d'), No, No, Yes, No, Run(C::DeleteForward), "Ctrl-D: delete forward"),
        b(K::Char('k'), No, No, Yes, No, Run(C::DeleteToLineEnd), "Ctrl-K: delete to line end"),
        b(K::Enter, No, No, No, Yes, Run(C::InsertLineBreak), "Shift-Enter: raw newline"),
        b(K::Enter, No, Any, Any, No, Run(C::InsertParagraph), "Enter: new paragraph / list item"),
    ]
}

/// Same key (characters case-insensitively).
pub fn key_eq(a: Key, b: Key) -> bool {
    match (a, b) {
        (Key::Char(x), Key::Char(y)) => x.to_lowercase().eq(y.to_lowercase()),
        _ => a == b,
    }
}

/// The command for a key press, or None when the key isn't the editor's (let the system have it;
/// typed characters go to `Editor::insert_text`).
pub fn resolve(key: Key, mods: Mods) -> Option<Command> {
    let bind = bindings().into_iter().find(|bd| {
        key_eq(bd.key, key) && bd.cmd.ok(mods.cmd) && bd.alt.ok(mods.alt) && bd.ctrl.ok(mods.ctrl) && bd.shift.ok(mods.shift)
    })?;
    match bind.action {
        Action::Run(c) => Some(c),
        Action::Shifted(f) => Some(f(mods.shift)),
        Action::Unhandled => None,
    }
}
