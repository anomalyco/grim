//! Where the editor's text lives. The editor keeps a parsed copy of the text (`Doc`) and mirrors
//! every change into its `TextStore`, so a collaborative store (a yrs `Text`) can plug in later.
//! `StringStore` is the plain local one.

use std::ops::Range;

/// The editor's text storage. Ranges are byte ranges on char boundaries.
pub trait TextStore {
    /// The whole text.
    fn text(&self) -> &str;

    fn len(&self) -> usize {
        self.text().len()
    }

    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn slice(&self, range: Range<usize>) -> &str {
        &self.text()[range]
    }

    /// A local change (typing, undo, `set_text`...).
    fn replace(&mut self, range: Range<usize>, s: &str);

    /// A change from `Editor::apply_remote`. A collaborative store whose shared text already
    /// holds it only updates its local copy; the default treats it like a local change.
    fn replace_remote(&mut self, range: Range<usize>, s: &str) {
        self.replace(range, s);
    }
}

/// Text in a `String` (local files).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StringStore(pub String);

impl StringStore {
    pub fn new(text: &str) -> StringStore {
        StringStore(text.to_string())
    }
}

impl TextStore for StringStore {
    fn text(&self) -> &str {
        &self.0
    }

    fn replace(&mut self, range: Range<usize>, s: &str) {
        self.0.replace_range(range, s);
    }
}
