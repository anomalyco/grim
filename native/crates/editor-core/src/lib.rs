//! Grimoire editor core: model, parser, rules, navigation (no UI).
//!
//! A port of the TS live-preview editor (src/client/editor). Offsets are byte offsets into the
//! UTF-8 text, always on char boundaries (see `text` for UTF-16 conversion helpers).

pub mod editor;
pub mod fold;
pub mod history;
pub mod keymap;
pub mod layout;
pub mod macos_keys;
pub mod navigation;
pub mod parser;
pub mod render;
pub mod reveal;
pub mod rules;
pub mod store;
pub mod text;
pub mod units;
pub mod url;

pub use editor::{Editor, LineChanges};
pub use keymap::{Command, Key, Mods};
pub use macos_keys::KeyTable;
pub use layout::{Adjacent, Bounds, Layout, MonoLayout, Rect};
pub use navigation::HUnit;
pub use parser::{BlockType, CellAlign, Doc, InlineType, TokenKind};
pub use render::{ImageView, LineView, SegKind, SegView};
pub use rules::FormatType;
pub use store::{StringStore, TextStore};
pub use units::Sel;
