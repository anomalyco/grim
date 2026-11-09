//! Back and forward through the notes opened in this window, as a browser's history: the header's ‹ › buttons,
//! Go ▸ Back (⌘[) and Forward (⌘]), and the mouse's back and forward buttons (4 and 5). Opening a note anywhere
//! (the sidebar, a link, Search Files, another workspace) adds it after the current one and drops what was ahead;
//! Back and Forward come back to a note with its caret and scroll where they were. Notes that are gone (deleted
//! since) are skipped; a note renamed here keeps its place under the new name. At most `CAP` places.

use std::cell::Cell;
use std::rc::Rc;

use editor_core::Sel;
use rune::Tx;

use crate::App;
use crate::workspaces::WsRef;

pub const CAP: usize = 100;

/// A note opened: its workspace and path, and the caret and scroll it was left with.
#[derive(Clone, Debug, PartialEq)]
pub struct Place {
    pub ws: WsRef,
    pub rel: String,
    pub scroll: f32,
    pub sel: Option<Sel>,
}

impl Place {
    fn is(&self, ws: &WsRef, rel: &str) -> bool {
        self.ws.same(ws) && self.rel == rel
    }
}

#[derive(Default)]
pub struct Nav {
    pub entries: Vec<Place>,
    pub idx: usize,
    /// Back or Forward under way: the entry it goes to (taken by the next note that opens).
    going: Option<usize>,
    /// A remote note come back to before its live text: its caret and scroll, put back at the sync (its generation).
    restore: Option<(u64, Place)>,
    /// The page's scroll offset as last drawn (`render`'s scroll view).
    pub scroll: Rc<Cell<f32>>,
    /// Back / Forward as the menu bar has them (enabled).
    pub menu: (bool, bool),
}

impl Nav {
    pub fn can_back(&self) -> bool {
        self.idx > 0 && self.idx < self.entries.len()
    }

    pub fn can_forward(&self) -> bool {
        self.idx + 1 < self.entries.len()
    }

    fn current_mut(&mut self, ws: &WsRef, rel: &str) -> Option<&mut Place> {
        self.entries.get_mut(self.idx).filter(|p| p.is(ws, rel))
    }

    /// A note opened: back at the entry Back / Forward went to (returned, to restore), else a new place after
    /// the current one (what was ahead goes).
    pub fn arrive(&mut self, ws: &WsRef, rel: &str) -> Option<Place> {
        if let Some(i) = self.going.take()
            && self.entries.get(i).is_some_and(|p| p.is(ws, rel))
        {
            self.idx = i;
            return Some(self.entries[i].clone());
        }
        if self.current_mut(ws, rel).is_some() {
            return None;
        }
        if !self.entries.is_empty() {
            self.entries.truncate(self.idx + 1);
        }
        self.entries.push(Place { ws: ws.clone(), rel: rel.to_string(), scroll: 0.0, sel: None });
        if self.entries.len() > CAP {
            self.entries.remove(0);
        }
        self.idx = self.entries.len() - 1;
        None
    }

    /// Leaving the open note: its caret and scroll, for coming back.
    pub fn leave(&mut self, ws: &WsRef, rel: &str, scroll: f32, sel: Sel) {
        if let Some(p) = self.current_mut(ws, rel) {
            p.scroll = scroll;
            p.sel = Some(sel);
        }
    }

    /// A note or folder of `ws` renamed: its places follow.
    pub fn renamed(&mut self, ws: &WsRef, from: &str, to: &str) {
        for p in self.entries.iter_mut().filter(|p| p.ws.same(ws)) {
            if p.rel == from {
                p.rel = to.to_string();
            } else if let Some(rest) = p.rel.strip_prefix(from).and_then(|r| r.strip_prefix('/')) {
                p.rel = format!("{to}/{rest}");
            }
        }
    }

    /// The entry `step` (-1 back, 1 forward) goes to, past the ones `exists` says are gone.
    pub fn target(&self, step: isize, exists: impl Fn(&Place) -> bool) -> Option<usize> {
        let mut i = self.idx as isize + step;
        while i >= 0 && (i as usize) < self.entries.len() {
            if exists(&self.entries[i as usize]) {
                return Some(i as usize);
            }
            i += step;
        }
        None
    }
}

impl App {
    /// The open note's place (workspace, path in it).
    fn nav_here(&self) -> Option<(WsRef, String)> {
        let ws = self.current.clone()?;
        let rel = match &self.remote {
            Some(r) => r.note.clone()?,
            None => self.rel_note()?,
        };
        Some((ws, rel))
    }

    /// Before another note opens: the open one's caret and scroll.
    pub fn nav_leave(&mut self) {
        if let Some((ws, rel)) = self.nav_here() {
            // the note open at launch (not opened through `open_note`) is the first place
            if self.nav.entries.is_empty() {
                self.nav.arrive(&ws, &rel);
            }
            let (scroll, sel) = (self.nav.scroll.get(), self.ed.selection());
            self.nav.leave(&ws, &rel, scroll, sel);
        }
    }

    /// A note opened (`open_note`): into the history, or, come back to by Back / Forward, its caret and scroll put
    /// back (a remote note's again once its live text is there).
    pub fn nav_arrived(&mut self, tx: &mut Tx) {
        let Some((ws, rel)) = self.nav_here() else { return };
        if let Some(p) = self.nav.arrive(&ws, &rel) {
            let live = self.remote.as_ref().is_none_or(|r| r.synced);
            if !live && let Some(r) = self.remote.as_ref() {
                self.nav.restore = Some((r.generation, p.clone()));
            }
            self.nav_put_back(&p, tx);
        }
        self.refresh_menu();
    }

    /// The open remote note synced: a caret and scroll waiting for it.
    pub fn nav_synced(&mut self, tx: &mut Tx) {
        let Some((generation, p)) = self.nav.restore.take() else { return };
        if self.remote.as_ref().is_some_and(|r| r.generation == generation) {
            self.nav_put_back(&p, tx);
        }
    }

    fn nav_put_back(&mut self, p: &Place, tx: &mut Tx) {
        if let Some(sel) = p.sel {
            self.ed.set_selection(sel);
        }
        tx.scroll_to_y("scroll", p.scroll);
    }

    /// A note of the open workspace was renamed (or a folder of it moved): `from` → `to`, relative paths.
    pub fn nav_renamed(&mut self, from: &str, to: &str) {
        if let Some(ws) = self.current.clone() {
            self.nav.renamed(&ws, from, to);
        }
    }

    pub fn go_back(&mut self, tx: &mut Tx) {
        self.nav_go(-1, tx);
    }

    pub fn go_forward(&mut self, tx: &mut Tx) {
        self.nav_go(1, tx);
    }

    /// Back (-1) or Forward (1): the entry there (past notes since deleted), opened.
    fn nav_go(&mut self, step: isize, tx: &mut Tx) {
        if self.dialog.is_some() {
            return;
        }
        let here = self.current.clone();
        let root = self.root.clone();
        let files = &self.files;
        let exists = |p: &Place| match (&p.ws, &here, &root) {
            // the open workspace: its tree says
            (ws, Some(h), Some(root)) if ws.same(h) => crate::files::contains(files, &root.join(&p.rel)),
            (WsRef::Local { path }, ..) => path.join(&p.rel).is_file(),
            // another remote workspace: opening it says (No note at …)
            _ => true,
        };
        let Some(i) = self.nav.target(step, exists) else { return };
        self.nav_leave();
        self.nav.going = Some(i);
        let p = self.nav.entries[i].clone();
        self.renaming = None;
        self.close_switcher();
        match (&p.ws, &here, &root) {
            (ws, Some(h), Some(root)) if ws.same(h) => self.open_note(root.join(&p.rel), tx),
            (WsRef::Local { path }, ..) => {
                // its note opens as the folder's last
                self.store.set_note(&p.ws, Some(p.rel.clone()));
                self.open_local(path.clone(), tx);
                if self.nav.going.is_some() {
                    self.open_note(path.join(&p.rel), tx);
                }
            }
            (WsRef::Remote { server, id, title }, ..) => self.open_remote(server.clone(), id.clone(), title.clone(), Some(p.rel.clone()), tx),
        }
        if self.nav.going.is_some() && self.nav.entries.get(i).is_some_and(|e| self.nav_here().is_some_and(|(ws, rel)| e.is(&ws, &rel))) {
            // already open (the same note): nothing to open, just the place
            self.nav.going = None;
            self.nav.idx = i;
            self.nav_put_back(&p, tx);
        }
        self.refresh_menu();
        self.handled(tx);
    }
}

/// The header's ‹ and › (`header::view`): 26 pt squares, the chevron ink, grey and inert when there's nowhere to go.
pub fn buttons(app: &App) -> rune::El {
    use rune::{Drag, Phase, row};

    use crate::theme::*;
    let button = |key: &'static str, help: &'static str, label: &'static str, back: bool, on: bool| {
        let (a, b) = if back { (7.5, 4.0) } else { (4.5, 8.0) };
        let icon = rune::Shape::new().stroke_with(vec![[a, 2.5], [b, 6.0], [a, 9.5]], false, 1.6, rune::LineCap::Round, c(if on { INK } else { GREY }).alpha(if on { 1.0 } else { 0.55 }));
        let mut e = row().key(key).label(label).help(help).size(26.0, 26.0).radius(6.0).center().child(rune::el().key(format!("{key}-icon")).size(12.0, 12.0).shape(icon));
        if on {
            e = e.hover(c(TINT_HOVER)).cursor(rune::Cursor::Pointer).on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
                if d.phase == Phase::Down {
                    if back { app.go_back(tx) } else { app.go_forward(tx) }
                }
            });
        } else {
            // nowhere to go: grey, and the pointer passes through
            e = e.inert();
        }
        e
    };
    row()
        .key("nav-btns")
        .gap(2.0)
        .center_y()
        .child(button("nav-back", "Back (⌘[)", "Back", true, app.nav.can_back()))
        .child(button("nav-forward", "Forward (⌘])", "Forward", false, app.nav.can_forward()))
}

/// The menu bar's Go menu: Back ⌘[ and Forward ⌘] (enabled as the header's buttons).
pub fn go_menu(back: bool, forward: bool) -> Vec<rune::MenuItem<App>> {
    vec![
        rune::MenuItem::new("Back", |app: &mut App, tx: &mut Tx| app.go_back(tx)).id("go-back").menu("Go").key_equivalent("cmd+[".parse().expect("Back's shortcut")).enabled(back),
        rune::MenuItem::new("Forward", |app: &mut App, tx: &mut Tx| app.go_forward(tx)).id("go-forward").menu("Go").key_equivalent("cmd+]".parse().expect("Forward's shortcut")).enabled(forward),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(n: &str) -> WsRef {
        WsRef::Local { path: std::path::PathBuf::from(format!("/tmp/{n}")) }
    }

    #[test]
    fn back_forward_and_a_new_place_drops_what_was_ahead() {
        let mut n = Nav::default();
        let w = ws("w");
        for r in ["a.md", "b.md", "c.md"] {
            assert!(n.arrive(&w, r).is_none());
        }
        assert!(n.can_back() && !n.can_forward());
        let i = n.target(-1, |_| true).unwrap();
        n.going = Some(i);
        assert_eq!(n.arrive(&w, "b.md").unwrap().rel, "b.md");
        n.going = n.target(-1, |_| true);
        n.arrive(&w, "a.md");
        assert!(!n.can_back() && n.can_forward());
        n.going = n.target(1, |_| true);
        n.arrive(&w, "b.md");
        assert_eq!(n.idx, 1);
        n.arrive(&w, "d.md");
        assert_eq!(n.entries.iter().map(|p| p.rel.as_str()).collect::<Vec<_>>(), ["a.md", "b.md", "d.md"]);
        assert!(!n.can_forward());
    }

    #[test]
    fn gone_notes_are_skipped_renames_followed_and_capped() {
        let mut n = Nav::default();
        let w = ws("w");
        for r in ["a.md", "gone.md", "c.md"] {
            n.arrive(&w, r);
        }
        assert_eq!(n.target(-1, |p| p.rel != "gone.md"), Some(0));
        n.renamed(&w, "a.md", "A.md");
        assert_eq!(n.entries[0].rel, "A.md");
        n.renamed(&w, "dir", "x");
        let mut m = Nav::default();
        for i in 0..150 {
            m.arrive(&w, &format!("{i}.md"));
        }
        assert_eq!((m.entries.len(), m.entries[0].rel.as_str()), (CAP, "50.md"));
    }
}
