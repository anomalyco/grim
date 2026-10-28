//! Images dropped onto a note or pasted into it (a screenshot, or image files copied in Finder), as the web's
//! `drop.ts` `ImageDrops`.
//!
//! - **Local note**: written next to the note at once (`drop::link`: files inside the folder are linked where
//!   they are, others copied into `images/`; a pasted bitmap is `images/image.png`, `image-2.png`… past other
//!   contents, as the server names it) and their Markdown inserted.
//! - **Remote note**: each image is uploaded (`POST /api/repos/:id/images`, `remote::Api::upload_image`). Until
//!   they're all done an "Uploading…" mark sits where they go, following everyone's edits (`map_pos`, the
//!   web's `mapPos`), then the server's Markdown goes in there as one edit, the caret after it. Failures are
//!   toasts in the web's words.

use std::ops::Range;
use std::path::PathBuf;

use editor_core::Sel;
use rune::{ClipboardContent, Tx};

use crate::App;
use crate::remote::Backend;

/// An image to add.
#[derive(Clone, Debug)]
pub enum NewImage {
    File(PathBuf),
    /// A bitmap from the clipboard, as PNG.
    Png { name: String, bytes: Vec<u8> },
}

impl NewImage {
    fn name(&self) -> String {
        match self {
            NewImage::File(p) => p.file_name().map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned()),
            NewImage::Png { name, .. } => name.clone(),
        }
    }

    fn is_image(&self) -> bool {
        match self {
            NewImage::File(p) => crate::drop::is_image(p),
            NewImage::Png { .. } => true,
        }
    }

    fn bytes(&self) -> Result<Vec<u8>, String> {
        match self {
            NewImage::File(p) => std::fs::read(p).map_err(|e| e.to_string()),
            NewImage::Png { bytes, .. } => Ok(bytes.clone()),
        }
    }
}

/// Uploads under way for a remote note: where their Markdown goes.
#[derive(Clone, Debug, PartialEq)]
pub struct Upload {
    pub id: u64,
    pub from: usize,
    pub to: usize,
    /// "Uploading…" / "Uploading 3 images…".
    pub label: String,
    /// The note and its connection (inserted only if it's still the one open).
    note: String,
    generation: u64,
}

/// Where byte position `pos` is after `edits` (each against the text the ones before it left). Text deleted
/// around it moves it to the deletion's start. (The web's `mapPos`.)
pub fn map_pos(pos: usize, edits: &[(Range<usize>, String)]) -> usize {
    let mut pos = pos;
    for (r, insert) in edits {
        if r.end <= pos && (r.start < pos || r.end < pos) {
            pos = pos + insert.len() - (r.end - r.start);
        } else if r.start < pos {
            pos = r.start;
        }
    }
    pos
}

/// The one edit that turns `old` into `new` (common start and end kept), or none.
pub fn diff(old: &str, new: &str) -> Option<(Range<usize>, String)> {
    if old == new {
        return None;
    }
    let mut a = old.bytes().zip(new.bytes()).take_while(|(x, y)| x == y).count();
    while !old.is_char_boundary(a) || !new.is_char_boundary(a) {
        a -= 1;
    }
    let max = old.len().min(new.len()) - a;
    let mut b = old.bytes().rev().zip(new.bytes().rev()).take(max).take_while(|(x, y)| x == y).count();
    while !old.is_char_boundary(old.len() - b) || !new.is_char_boundary(new.len() - b) {
        b -= 1;
    }
    Some((a..old.len() - b, new[a..new.len() - b].to_string()))
}

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl App {
    /// Text edits happened (the room's, or ours): uploads' insert points and the drop caret follow them.
    pub fn map_uploads(&mut self, edits: &[(Range<usize>, String)]) {
        if edits.is_empty() {
            return;
        }
        for u in &mut self.uploads {
            u.from = map_pos(u.from, edits);
            u.to = map_pos(u.to, edits).max(u.from);
        }
        if let Some(p) = self.drop_at {
            self.drop_at = Some(map_pos(p, edits));
        }
    }

    /// Add `items` over `from..to`: images written or uploaded (above), anything else refused with a toast.
    pub fn add_images(&mut self, items: Vec<NewImage>, from: usize, to: usize, tx: &mut Tx) {
        if self.remote.is_some() && (!self.remote_writable() || self.ed.is_read_only()) {
            self.show_toast("This note is read-only.".into());
            self.handled(tx);
            return;
        }
        let (images, others): (Vec<NewImage>, Vec<NewImage>) = items.into_iter().partition(NewImage::is_image);
        if !others.is_empty() {
            let names = others.iter().map(NewImage::name).collect::<Vec<_>>().join(", ");
            self.show_toast(if images.is_empty() {
                format!("Only images can be added to a note ({names} isn't one).")
            } else {
                format!("Skipped {names}: only images can be added to a note.")
            });
        }
        if images.is_empty() {
            self.handled(tx);
            return;
        }
        if self.remote.is_none() {
            let mut links = Vec::new();
            for img in &images {
                let r = match img {
                    NewImage::File(p) => crate::drop::link(p, self.root.as_deref(), self.path.as_deref(), !self.headless),
                    NewImage::Png { name, bytes } => crate::drop::link_bytes(name, bytes, self.path.as_deref(), !self.headless),
                };
                match r {
                    Ok(l) => links.push(l),
                    Err(e) => self.show_toast(format!("Couldn't add {}: {e}", img.name())),
                }
            }
            if !links.is_empty() {
                self.insert_images(from, to, &links.join("\n"), tx);
            }
            self.handled(tx);
            return;
        }
        let Some(rem) = self.remote.as_ref() else { return };
        let Some(note) = rem.note.clone() else { return };
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let label = if images.len() == 1 { "Uploading…".to_string() } else { format!("Uploading {} images…", images.len()) };
        self.uploads.push(Upload { id, from, to, label, note: note.clone(), generation: rem.generation });
        let (api, ws_id) = (rem.api.clone(), rem.id().to_string());
        match &self.backend {
            Backend::Net(h) => {
                let h = h.clone();
                std::thread::spawn(move || {
                    let results = images
                        .iter()
                        .map(|img| {
                            let bytes = img.bytes().map_err(|e| format!("Couldn't upload {}: {e}", img.name()))?;
                            api.upload_image(&ws_id, &note, &img.name(), &bytes).map_err(|e| format!("Couldn't upload {}: {e}", img.name()))
                        })
                        .collect::<Vec<_>>();
                    h.update(move |app, tx| app.uploads_done(id, results, tx));
                });
            }
            Backend::Mock(m) => {
                let results = images
                    .iter()
                    .map(|img| {
                        let bytes = img.bytes().map_err(|e| format!("Couldn't upload {}: {e}", img.name()))?;
                        m.borrow_mut().upload(&note, &img.name(), &bytes).map_err(|e| format!("Couldn't upload {}: {e}", img.name()))
                    })
                    .collect::<Vec<_>>();
                let hold = m.borrow().hold_uploads;
                if hold {
                    m.borrow_mut().held.push((id, results));
                } else {
                    self.uploads_done(id, results, tx);
                    return;
                }
            }
            Backend::None => {}
        }
        self.handled(tx);
    }

    /// An upload batch finished: its Markdown goes where its mark is now, failures say so.
    pub fn uploads_done(&mut self, id: u64, results: Vec<Result<String, String>>, tx: &mut Tx) {
        let Some(i) = self.uploads.iter().position(|u| u.id == id) else { return };
        let u = self.uploads.remove(i);
        let mut md = Vec::new();
        for r in results {
            match r {
                Ok(m) => md.push(m),
                Err(e) => self.show_toast(e),
            }
        }
        if !md.is_empty() {
            let same = self.remote.as_ref().is_some_and(|r| r.note.as_deref() == Some(u.note.as_str()) && r.generation == u.generation);
            if !same || self.ed.is_read_only() {
                self.show_toast("The image was uploaded but the note changed before it could be inserted.".into());
            } else {
                self.insert_images(u.from, u.to, &md.join("\n"), tx);
            }
        }
        self.handled(tx);
    }

    /// `md` over `from..to` as one edit, the caret after it.
    fn insert_images(&mut self, from: usize, to: usize, md: &str, tx: &mut Tx) {
        let text = self.ed.text();
        let clamp = |mut p: usize| {
            p = p.min(text.len());
            while !text.is_char_boundary(p) {
                p -= 1;
            }
            p
        };
        let (from, to) = (clamp(from), clamp(to.max(from)));
        self.close_search();
        self.marked = None;
        self.ed.set_selection(Sel::new(from, to));
        self.ed.paste(md);
        tx.scroll_into_view("caret");
    }

    /// Headless tests: the mock's held uploads finish now.
    #[cfg(test)]
    pub fn finish_mock_uploads(&mut self, tx: &mut Tx) {
        let held = match &self.backend {
            Backend::Mock(m) => std::mem::take(&mut m.borrow_mut().held),
            _ => Vec::new(),
        };
        for (id, results) in held {
            self.uploads_done(id, results, tx);
        }
    }
}

/// Cmd-V with what the clipboard holds: image files (copied in Finder; their name may come as text too) or a
/// bitmap (a screenshot) without text of its own go in as images at the selection; anything else pastes as
/// text. A spreadsheet's cells come with a picture of themselves and their text: the text wins, as on the web.
pub fn paste(app: &mut App, content: &ClipboardContent, tx: &mut Tx) {
    let text = content.text();
    let files = content.files();
    let sel = app.ed.selection();
    let named = |t: &str| files.iter().any(|f| f.file_name().is_some_and(|n| n.to_string_lossy() == t.trim()));
    if !files.is_empty() && (text.trim().is_empty() || text.lines().all(named)) {
        app.add_images(files.iter().cloned().map(NewImage::File).collect(), sel.from(), sel.to(), tx);
        return;
    }
    if let Some(img) = content.image().filter(|_| text.trim().is_empty() && files.is_empty()) {
        app.add_images(vec![NewImage::Png { name: "image.png".into(), bytes: img.png().to_vec() }], sel.from(), sel.to(), tx);
        return;
    }
    if !text.is_empty() {
        app.ed.paste(&text.replace("\r\n", "\n"));
    }
    tx.scroll_into_view("caret");
    app.handled(tx);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_follow_edits_like_the_web() {
        let e = |a: usize, b: usize, s: &str| (a..b, s.to_string());
        assert_eq!(map_pos(5, &[e(0, 0, "ab")]), 7, "insert before");
        assert_eq!(map_pos(5, &[e(5, 5, "ab")]), 5, "insert at: stays before it");
        assert_eq!(map_pos(5, &[e(6, 8, "")]), 5, "after: untouched");
        assert_eq!(map_pos(5, &[e(1, 3, "")]), 3, "deleted before");
        assert_eq!(map_pos(5, &[e(3, 8, "x")]), 3, "deleted around: to the deletion's start");
        assert_eq!(map_pos(5, &[e(0, 0, "a"), e(0, 1, "")]), 5, "in order");
    }

    #[test]
    fn one_edit_between_two_texts() {
        assert_eq!(diff("abc", "abc"), None);
        assert_eq!(diff("hello", "help me"), Some((3..5, "p me".into())));
        assert_eq!(diff("aaa", "aaaa"), Some((3..3, "a".into())));
        assert_eq!(diff("é!", "è!"), Some((0..2, "è".into())), "char boundaries");
        assert_eq!(diff("xy", ""), Some((0..2, String::new())));
    }
}
