//! The open note's editor: one `Editor` type for both kinds of workspace. A local note's text is a plain
//! string (`NoteStore::Local`); a remote note's is the shared document of its room (`NoteStore::Shared`,
//! collab's `CollabStore`), driven by a `CollabEditor` (`Ed::Remote`). `Ed` dereferences to the editor
//! either way, so the rest of the app calls `app.ed.insert_text(..)` and friends without caring which.

use std::ops::{Deref, DerefMut, Range};

use collab::{CollabEditor, CollabStore};
use editor_core::{StringStore, TextStore};

pub enum NoteStore {
    Local(StringStore),
    Shared(CollabStore),
}

impl From<CollabStore> for NoteStore {
    fn from(s: CollabStore) -> Self {
        NoteStore::Shared(s)
    }
}

impl TextStore for NoteStore {
    fn text(&self) -> &str {
        match self {
            NoteStore::Local(s) => s.text(),
            NoteStore::Shared(s) => s.text(),
        }
    }

    fn replace(&mut self, range: Range<usize>, s: &str) {
        match self {
            NoteStore::Local(st) => st.replace(range, s),
            NoteStore::Shared(st) => st.replace(range, s),
        }
    }

    fn replace_remote(&mut self, range: Range<usize>, s: &str) {
        match self {
            NoteStore::Local(st) => st.replace_remote(range, s),
            NoteStore::Shared(st) => st.replace_remote(range, s),
        }
    }
}

pub type Editor = editor_core::Editor<NoteStore>;
pub type Collab = CollabEditor<NoteStore>;

/// The local editor is the common case; a remote one is boxed with its session.
#[allow(clippy::large_enum_variant)]
pub enum Ed {
    Local(Editor),
    Remote(Box<Collab>),
}

impl Ed {
    /// A local note's editor over `text`, with the key table.
    pub fn local(text: &str) -> Ed {
        Ed::Local(crate::keys::editor(text))
    }

    pub fn collab(&self) -> Option<&Collab> {
        match self {
            Ed::Remote(c) => Some(c),
            Ed::Local(_) => None,
        }
    }

    pub fn collab_mut(&mut self) -> Option<&mut Collab> {
        match self {
            Ed::Remote(c) => Some(c),
            Ed::Local(_) => None,
        }
    }
}

impl Deref for Ed {
    type Target = Editor;

    fn deref(&self) -> &Editor {
        match self {
            Ed::Local(e) => e,
            Ed::Remote(c) => c.editor(),
        }
    }
}

impl DerefMut for Ed {
    fn deref_mut(&mut self) -> &mut Editor {
        match self {
            Ed::Local(e) => e,
            Ed::Remote(c) => c.editor_mut(),
        }
    }
}
