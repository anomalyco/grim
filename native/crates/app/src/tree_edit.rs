//! New notes and folders, rename and delete from the sidebar, in a local folder (its files) or a remote
//! one (the server's notes; a remote folder is only its notes' common prefix). The File menu's items live
//! here too, and the rows' menu: a native pop-up with the web's items (New note, New folder, Rename, Delete).

use std::path::{Path, PathBuf};

use rune::{PopupAnchor, PopupItem, PopupMenu, Tx};

use crate::App;
use crate::dialogs::{Confirm, ConfirmKind, Dialog, OpenChoice};
use crate::files;

type MenuAction = fn(&mut App, &mut Tx);

/// The menu bar's File menu (`rune::MenuItem`s): id, title, shortcut, what it does. Close (⌘W) is in
/// Rune's standard Window menu.
pub const FILE_MENU: &[(&str, &str, &str, MenuAction)] = &[
    ("new-note", "New Note", "cmd+n", menu_new_note),
    ("new-folder", "New Folder", "shift+cmd+n", menu_new_folder),
    ("new", "New Workspace…", "alt+cmd+n", menu_new),
    ("open", "Open Workspace…", "cmd+o", menu_open),
    ("open-folder", "Open Folder…", "shift+cmd+o", menu_open_folder),
    ("search-files", "Search Files…", "cmd+p", menu_search),
];

/// The File menu has a separator after this item (creating above, opening below).
const SEPARATOR_AFTER: &str = "new";

pub fn file_menu() -> Vec<rune::MenuItem<App>> {
    let mut items = Vec::new();
    for &(id, title, key, f) in FILE_MENU {
        items.push(rune::MenuItem::new(title, f).id(id).menu("File").key_equivalent(key.parse().expect("a File menu shortcut")));
        if id == SEPARATOR_AFTER {
            items.push(rune::MenuItem::separator().menu("File"));
        }
    }
    items
}

/// The menu bar's items: the File menu, and View ▸ Show Authors (checked while the margin is on).
pub fn menu_items(show_authors: bool) -> Vec<rune::MenuItem<App>> {
    let mut items = file_menu();
    items.push(rune::MenuItem::new("Show Authors", menu_authors).id("show-authors").menu("View").checked(show_authors));
    items
}

fn menu_authors(app: &mut App, tx: &mut Tx) {
    app.toggle_authors(tx);
}

impl App {
    /// The menu bar again when what it shows changed (Show Authors' check).
    pub fn refresh_menu(&mut self) {
        let on = self.show_authors();
        if on == self.store_menu_state {
            return;
        }
        self.store_menu_state = on;
        if let crate::remote::Backend::Net(crate::remote::Handle::Rune(h)) = &self.backend
            && let Err(e) = h.set_menu(menu_items(on))
        {
            eprintln!("grimoire: menu: {e}");
        }
    }
}

/// A dialog is modal: the menu's commands wait for it. Otherwise a rename in progress and the switcher's
/// menu give way.
fn menu_ready(app: &mut App) -> bool {
    if app.dialog.is_some() {
        return false;
    }
    app.renaming = None;
    app.close_switcher();
    true
}

fn menu_new_note(app: &mut App, tx: &mut Tx) {
    if menu_ready(app) {
        app.new_note(tx);
        app.handled(tx);
    }
}

fn menu_new_folder(app: &mut App, tx: &mut Tx) {
    if menu_ready(app) {
        app.new_folder(tx);
        app.handled(tx);
    }
}

fn menu_search(app: &mut App, tx: &mut Tx) {
    if menu_ready(app) {
        app.open_search();
        app.handled(tx);
    }
}

fn menu_open(app: &mut App, tx: &mut Tx) {
    if menu_ready(app) {
        app.open_dialog(OpenChoice::Remote, tx);
        app.handled(tx);
    }
}

/// The system folder picker at once (no dialog first; a local folder needs no sign-in).
fn menu_open_folder(app: &mut App, tx: &mut Tx) {
    if menu_ready(app) {
        app.open_folder_dialog(tx);
        app.handled(tx);
    }
}

/// The switcher's New…: the New dialog (a new folder on this Mac or on a server).
fn menu_new(app: &mut App, tx: &mut Tx) {
    if menu_ready(app) {
        app.open_dialog(OpenChoice::NewFolder, tx);
        app.handled(tx);
    }
}

/// A tree row's menu: exactly the web's, in its order, with no separators.
pub fn row_popup() -> PopupMenu {
    PopupMenu::new()
        .item(PopupItem::new("new-note", "New note"))
        .item(PopupItem::new("new-folder", "New folder"))
        .item(PopupItem::new("rename", "Rename"))
        .item(PopupItem::new("delete", "Delete"))
}

impl App {
    /// The open folder takes renames, deletes and new notes: a local one, or a loaded writable remote one.
    pub fn tree_editable(&self) -> bool {
        self.root.is_some() && (self.remote.is_none() || self.remote_writable())
    }

    /// Where New Note and New Folder go: the tree's current row's folder (a note's folder, or the folder
    /// itself), else the open note's, else the root. A folder emptied of notes (no row any more) still
    /// takes them.
    pub fn selected_dir(&self) -> Option<PathBuf> {
        let root = self.root.clone()?;
        let Some(cur) = self.tree_cur.clone().or_else(|| self.path.clone()).filter(|p| p.starts_with(&root) && *p != root) else {
            return Some(root);
        };
        let is_dir = match files::find(&self.files, &cur) {
            Some(e) => e.kids.is_some(),
            None => !files::is_note(&cur),
        };
        let dir = if is_dir { cur } else { cur.parent().map_or_else(|| root.clone(), Path::to_path_buf) };
        let there = self.remote.is_some() || dir == root || dir.is_dir() || files::contains(&self.files, &dir);
        Some(if there { dir } else { root })
    }

    /// Whether `rel` is a folder in the tree.
    pub(crate) fn is_dir_rel(&self, rel: &str) -> bool {
        self.root.as_ref().and_then(|r| files::find(&self.files, &r.join(rel))).is_some_and(|e| e.kids.is_some())
    }

    /// The remote notes in folder `rel`.
    fn remote_under(&self, rel: &str) -> Vec<String> {
        let prefix = format!("{rel}/");
        self.remote.as_ref().map(|r| r.tree_list.iter().filter(|p| p.starts_with(&prefix)).cloned().collect()).unwrap_or_default()
    }

    /// New Folder (⇧⌘N): "New folder" ("New folder 2"…) in the selected folder with an `Untitled.md` in it,
    /// open, and the folder's row being renamed. A remote folder is created by creating its note.
    pub fn new_folder(&mut self, tx: &mut Tx) {
        if !self.tree_editable() {
            return;
        }
        let (Some(root), Some(parent)) = (self.root.clone(), self.selected_dir()) else { return };
        let disk = self.remote.is_none() && !self.headless;
        let dir = (1..)
            .map(|n| parent.join(if n == 1 { "New folder".to_string() } else { format!("New folder {n}") }))
            .find(|d| !(files::contains(&self.files, d) || disk && d.exists()))
            .unwrap();
        let note = dir.join("Untitled.md");
        let rel_dir = files::rel(&root, &dir);
        if self.remote.is_some() {
            self.remote_create(files::rel(&root, &note), Some(rel_dir), tx);
            return;
        }
        if disk && let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| crate::doc::write(&note, "")) {
            self.show_error(format!("Couldn't create {rel_dir}: {e}"));
            return;
        }
        files::insert(&mut self.files, &root, &note);
        self.files_gen += 1;
        self.close_search();
        self.open_note(note, tx);
        self.type_here();
        self.start_rename(&rel_dir);
    }

    /// The row menu (right-click, Ctrl-click, its ⋯, Shift+F10 or the Menu key on the tree's current row): a
    /// native menu at `anchor` with New note, New folder, Rename and Delete. Nothing in a folder that takes no
    /// edits; dismissed, nothing happens.
    pub fn row_menu(&mut self, rel: String, anchor: impl Into<PopupAnchor>, tx: &mut Tx) {
        if !self.tree_editable() {
            return;
        }
        self.renaming = None;
        tx.popup_menu(row_popup(), anchor, move |app: &mut App, picked, tx| app.row_pick(&rel, picked, tx));
    }

    pub fn row_pick(&mut self, rel: &str, picked: Option<&str>, tx: &mut Tx) {
        match picked {
            // New note / New folder: the File menu's, in the row's folder (a folder row's own, a note's folder);
            // the row becomes the tree's current row, which is where they go (`selected_dir`)
            Some(id @ ("new-note" | "new-folder")) => {
                let Some(root) = self.root.clone() else { return };
                self.tree_cur = Some(root.join(rel));
                if id == "new-note" {
                    self.new_note(tx);
                } else {
                    self.new_folder(tx);
                }
            }
            Some("rename") => self.start_rename(rel),
            Some("delete") => self.ask_delete(rel),
            _ => return,
        }
        self.handled(tx);
    }

    /// Delete's confirm (a note, or a folder and everything in it): remote ones stay in the Git history,
    /// local ones go to the Trash.
    pub fn ask_delete(&mut self, rel: &str) {
        let dir = self.is_dir_rel(rel);
        let (title, message) = match (dir, self.remote.is_some()) {
            (false, true) => ("Delete note", format!("Delete “{rel}”? It stays in the Git history.")),
            (false, false) => ("Delete note", format!("Move “{rel}” to the Trash?")),
            (true, true) => match self.remote_under(rel).len() {
                1 => ("Delete folder", format!("Delete “{rel}” and the note in it? It stays in the Git history.")),
                n => ("Delete folder", format!("Delete “{rel}” and the {n} notes in it? They stay in the Git history.")),
            },
            (true, false) => ("Delete folder", format!("Move “{rel}” and everything in it to the Trash?")),
        };
        self.dialog = Some(Dialog::Confirm(Confirm {
            kind: ConfirmKind::Delete { rel: rel.to_string(), dir },
            title: title.into(),
            message,
            confirm: "Delete".into(),
            cancel: "Cancel".into(),
            danger: true,
        }));
    }

    /// Delete confirmed: a remote note or folder on the server (a folder in one commit), a local note or
    /// folder into the Trash. When the open note goes, the first note left opens.
    pub fn delete_path(&mut self, rel: &str, dir: bool, tx: &mut Tx) {
        if self.remote.is_some() {
            self.remote_delete_path(rel.to_string(), dir, tx);
            return;
        }
        let Some(root) = self.root.clone() else { return };
        let path = root.join(rel);
        let open = self.path.as_ref().is_some_and(|p| p.starts_with(&path));
        if open {
            self.save_now();
        }
        if !self.headless
            && let Err(e) = trash(&path)
        {
            self.show_error(format!("Couldn't delete {rel}: {e}"));
            return;
        }
        if open {
            self.saver = None;
            self.path = None;
            self.ed = crate::note::Ed::local("");
            self.ed.set_read_only(true);
        }
        let entries = if self.headless {
            let mut e = self.files.clone();
            files::remove_under(&mut e, &path);
            e
        } else {
            files::scan(&root).0
        };
        self.set_files(entries);
        if open {
            match crate::remote::first_note_outside(&self.files, &path) {
                Some(p) => self.open_note(p, tx),
                None => tx.set_title(crate::title(None)),
            }
        }
        self.handled(tx);
    }

    /// The row's rename field submitted `to` (relative to the folder; a note gets `.md` when it has no
    /// extension). A folder moves with everything in it: locally the directory, remotely in one commit.
    pub fn rename_path(&mut self, from: &str, to: &str, tx: &mut Tx) {
        let Some(root) = self.root.clone() else { return };
        let dir = self.is_dir_rel(from);
        let mut to = to.trim().trim_matches('/').to_string();
        if !dir && !to.is_empty() && !files::is_note(Path::new(&to)) {
            to.push_str(".md");
        }
        if to.is_empty() || to == from {
            return;
        }
        if dir && Path::new(&to).starts_with(from) {
            self.show_error(format!("Couldn't rename {from}: a folder can't go inside itself"));
            return;
        }
        if self.remote.is_some() {
            // a folder in one commit, everything in it (images too) moving with it
            self.remote_move(from.to_string(), to, dir, tx);
            return;
        }
        self.rename_local(&root.join(from), &root.join(&to), tx);
    }

    /// A local note or folder under a new name: the edits so far saved, the file or directory moved, and
    /// everything that knows the paths (the saver, the tree, closed folders, folds, the window title, the
    /// folder's last note) follows; the editor keeps its text and caret.
    pub(crate) fn rename_local(&mut self, from: &Path, to: &Path, tx: &mut Tx) {
        let Some(root) = self.root.clone() else { return };
        let name = files::note_name(from);
        // a.md → A.md is a rename even where the file system doesn't tell them apart
        let case_only = from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
        if !case_only && ((!self.headless && to.exists()) || files::contains(&self.files, to)) {
            self.show_error(format!("“{}” already exists.", files::note_name(to)));
            return;
        }
        let open = self.path.clone().filter(|p| p.starts_with(from));
        if open.is_some() {
            self.save_now();
        }
        if !self.headless {
            let r = to.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::rename(from, to));
            if let Err(e) = r {
                self.show_error(format!("Couldn't rename {name}: {e}"));
                return;
            }
        }
        let moved = |p: &Path| -> Option<PathBuf> { p.strip_prefix(from).ok().map(|rest| if rest.as_os_str().is_empty() { to.to_path_buf() } else { to.join(rest) }) };
        self.collapsed = self.collapsed.iter().map(|p| moved(p).unwrap_or_else(|| p.clone())).collect();
        self.store.move_folds(moved);
        if let Some(c) = self.tree_cur.as_deref().and_then(moved) {
            self.tree_cur = Some(c);
        }
        if let Some(p) = open.as_deref().and_then(moved) {
            let text = self.ed.text().to_string();
            self.sent = text.clone();
            self.disk = text.clone();
            self.saver = (!self.headless).then(|| crate::doc::Saver::spawn(p.clone(), text));
            tx.set_title(crate::title(Some(&p)));
            self.path = Some(p);
            if let Some(ws) = self.current.clone() {
                let rel = self.rel_note();
                self.store.set_note(&ws, rel);
            }
        }
        let entries = if self.headless {
            let mut e = self.files.clone();
            let notes = files::notes_under(&e, from);
            files::remove_under(&mut e, from);
            for n in notes {
                if let Some(t) = moved(&n) {
                    files::insert(&mut e, &root, &t);
                }
            }
            e
        } else {
            files::scan(&root).0
        };
        self.set_files(entries);
    }
}

/// Moves `path` into the user's Trash (`~/.Trash`).
fn trash(path: &Path) -> std::io::Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| std::io::Error::other("no home folder"))?;
    trash_into(path, &Path::new(&home).join(".Trash"))
}

/// Moves `path` into `bin` under its own name, or "name 2.md", "name 3.md"… when taken, as the Finder does.
fn trash_into(path: &Path, bin: &Path) -> std::io::Result<PathBuf> {
    let name = path.file_name().ok_or_else(|| std::io::Error::other("no name"))?.to_string_lossy().into_owned();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !path.is_dir() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let to = (1..).map(|n| bin.join(if n == 1 { name.clone() } else { format!("{stem} {n}{ext}") })).find(|p| p.symlink_metadata().is_err()).unwrap();
    std::fs::create_dir_all(bin)?;
    std::fs::rename(path, &to)?;
    Ok(to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("grimoire-tree-edit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// a.md, sub/b.md, sub/deep/c.md on disk; a.md open.
    fn local(name: &str) -> (App, PathBuf) {
        let dir = temp(name);
        for (p, t) in [("a.md", "# A"), ("sub/b.md", "# B"), ("sub/deep/c.md", "# C")] {
            let f = dir.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, t).unwrap();
        }
        let app = App::new("# A", Some(dir.join("a.md")), false).with_root(Some(dir.clone()), files::scan(&dir).0);
        (app, dir)
    }

    fn view(_: &App, _: &mut rune::Cx<App>) -> rune::El {
        rune::el()
    }

    #[test]
    fn the_file_menu_has_new_note_new_folder_and_open_with_their_shortcuts() {
        let menu: Vec<(&str, &str, String)> = FILE_MENU.iter().map(|&(id, t, k, _)| (id, t, k.parse::<rune::Shortcut>().unwrap().to_string())).collect();
        let want = |k: &str| k.parse::<rune::Shortcut>().unwrap().to_string();
        assert_eq!(
            menu,
            [
                ("new-note", "New Note", want("cmd+n")),
                ("new-folder", "New Folder", want("cmd+shift+n")),
                ("new", "New Workspace…", want("cmd+alt+n")),
                ("open", "Open Workspace…", want("cmd+o")),
                ("open-folder", "Open Folder…", want("cmd+shift+o")),
                ("search-files", "Search Files…", want("cmd+p")),
            ]
        );
        // and one separator, between New Workspace… and Open Workspace…
        assert_eq!(file_menu().len(), 7);
        assert_eq!(FILE_MENU.iter().position(|m| m.0 == SEPARATOR_AFTER), Some(2));
        // each item's action does what it says
        let (mut app, dir) = local("menu");
        let mut tx = Tx::default();
        let run = |app: &mut App, id: &str, tx: &mut Tx| (FILE_MENU.iter().find(|m| m.0 == id).unwrap().3)(app, tx);
        run(&mut app, "new-note", &mut tx);
        assert_eq!(app.path, Some(dir.join("Untitled.md")));
        run(&mut app, "open", &mut tx);
        assert!(matches!(&app.dialog, Some(Dialog::Open(d)) if !d.new && d.choice == OpenChoice::Remote && !d.choices().contains(&OpenChoice::Folder)));
        app.dialog = None;
        run(&mut app, "new", &mut tx);
        assert!(matches!(&app.dialog, Some(Dialog::Open(d)) if d.new && d.choice == OpenChoice::NewFolder));
        app.dialog = None;
        // Open Folder…: the picker at once (headless: its path stand-in), no dialog in between
        run(&mut app, "open-folder", &mut tx);
        assert!(matches!(&app.dialog, Some(Dialog::Prompt(p)) if p.kind == crate::dialogs::PromptKind::OpenPath));
        // a dialog is open: the menu waits
        run(&mut app, "new-note", &mut tx);
        assert_eq!(app.path, Some(dir.join("Untitled.md")));
        app.dialog = None;
        run(&mut app, "new-folder", &mut tx);
        assert_eq!(app.path, Some(dir.join("New folder/Untitled.md")));
        run(&mut app, "search-files", &mut tx);
        assert!(app.search.open && app.search.input.focused && app.renaming.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⌘N (and the row menu's New note, and "+ New note") always give the new note's editor the keys: from the
    /// tree, from the editor, after the search dialog; typing a heading and Return names it.
    #[test]
    fn new_notes_take_the_keys() {
        let (mut app, dir) = local("newkeys");
        let _ = crate::layout::FONTS.set(crate::layout::Fonts { list: &[], sans: "Inter", mono: "Inter" });
        let mut tx = Tx::default();
        let key = |app: &mut App, k: rune::Key, tx: &mut Tx| crate::input::on_key(app, &rune::KeyEvent { key: k, mods: rune::Mods::default() }, tx);
        let menu = |app: &mut App, tx: &mut Tx| (FILE_MENU.iter().find(|m| m.0 == "new-note").unwrap().3)(app, tx);
        // the tree has the keys
        app.focus_tree();
        assert!(app.tree_focus);
        menu(&mut app, &mut tx);
        assert!(!app.tree_focus);
        assert_eq!(app.path, Some(dir.join("Untitled.md")));
        key(&mut app, rune::Key::Text("# Hello".into()), &mut tx);
        key(&mut app, rune::Key::Enter, &mut tx);
        assert!(app.ed.text().starts_with("# Hello\n"), "{:?}", app.ed.text());
        assert_eq!(app.path, Some(dir.join("Hello.md")), "named after its heading");
        // from the editor
        menu(&mut app, &mut tx);
        key(&mut app, rune::Key::Text("x".into()), &mut tx);
        assert_eq!((app.path.clone(), app.ed.text()), (Some(dir.join("Untitled.md")), "x"));
        // the search dialog opened and closed, then the tree again, then the row menu's New note on `sub`
        app.open_search();
        key(&mut app, rune::Key::Escape, &mut tx);
        app.focus_tree();
        app.row_pick("sub", Some("new-note"), &mut tx);
        key(&mut app, rune::Key::Text("y".into()), &mut tx);
        assert_eq!((app.path.clone(), app.ed.text(), app.tree_focus), (Some(dir.join("sub/Untitled.md")), "y", false));
        // the search dialog open: ⌘N closes it and the new note has the keys
        app.open_search();
        menu(&mut app, &mut tx);
        assert!(!app.search.open);
        key(&mut app, rune::Key::Text("z".into()), &mut tx);
        assert_eq!(app.ed.text(), "z");
        // New Folder: the folder's name takes the keys instead
        app.focus_tree();
        app.new_folder(&mut tx);
        assert!(app.renaming.as_ref().is_some_and(|r| r.1.focused) && !app.tree_focus);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⌘N goes into the selected folder: a note's folder, a folder row itself, the root with nothing selected.
    #[test]
    fn new_notes_go_into_the_selected_folder() {
        let (mut app, dir) = local("selected");
        let mut tx = Tx::default();
        assert_eq!(app.selected_dir(), Some(dir.clone()), "a.md is at the root");
        app.tree_cur = Some(dir.join("sub/deep/c.md"));
        assert_eq!(app.selected_dir(), Some(dir.join("sub/deep")));
        app.tree_cur = Some(dir.join("sub"));
        assert_eq!(app.selected_dir(), Some(dir.join("sub")));
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("sub/Untitled.md")));
        // the new note is now the current row: the next one goes beside it
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("sub/Untitled 2.md")));
        app.tree_cur = None;
        app.path = None;
        assert_eq!(app.selected_dir(), Some(dir.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_folder_makes_a_folder_with_a_note_and_renames_it() {
        let (mut app, dir) = local("newfolder");
        let mut tx = Tx::default();
        app.tree_cur = Some(dir.join("sub/b.md"));
        app.new_folder(&mut tx);
        assert!(dir.join("sub/New folder/Untitled.md").is_file());
        assert_eq!(app.path, Some(dir.join("sub/New folder/Untitled.md")));
        assert!(app.tree_rows().iter().any(|r| r.rel == "sub/New folder" && r.dir && r.open));
        let (rel, field) = app.renaming.clone().unwrap();
        assert_eq!((rel.as_str(), field.text.as_str()), ("sub/New folder", "New folder"), "the name only, as the web");
        assert_eq!((field.anchor, field.focus), (0, 10), "all of it selected");
        // a second one is "New folder 2"; Escape keeps the name
        app.renaming = None;
        app.tree_cur = Some(dir.join("sub"));
        app.new_folder(&mut tx);
        assert!(dir.join("sub/New folder 2/Untitled.md").is_file());
        // Enter renames: the folder moves, with the open note in it
        app.ed.insert_text("x");
        app.handled(&mut tx);
        app.renaming.as_mut().unwrap().1.text = "Ideas".into();
        app.submit_rename(&mut tx);
        assert!(dir.join("sub/Ideas/Untitled.md").is_file() && !dir.join("sub/New folder 2").exists());
        assert_eq!(app.path, Some(dir.join("sub/Ideas/Untitled.md")));
        app.save_now();
        assert_eq!(std::fs::read_to_string(dir.join("sub/Ideas/Untitled.md")).unwrap(), "x", "the saver follows");
        assert!(app.tree_rows().iter().any(|r| r.rel == "sub/Ideas/Untitled.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_notes_and_folders_are_renamed_and_trashed() {
        let (mut app, dir) = local("local");
        let mut tx = Tx::default();
        // a note that isn't open
        app.start_rename("sub/b.md");
        assert_eq!(app.renaming.as_ref().unwrap().1.text, "b");
        app.renaming.as_mut().unwrap().1.text = "Bee".into();
        app.submit_rename(&mut tx);
        assert!(dir.join("sub/Bee.md").is_file() && !dir.join("sub/b.md").exists());
        // no slashes (rename doesn't move notes between folders), as the web
        app.start_rename("sub/Bee.md");
        app.renaming.as_mut().unwrap().1.text = "../Bee".into();
        app.submit_rename(&mut tx);
        assert_eq!(app.toast(), Some("A name can't contain / or \\."));
        assert!(dir.join("sub/Bee.md").is_file());
        // a taken name: nothing moves
        app.rename_path("sub/Bee.md", "a", &mut tx);
        assert!(dir.join("sub/Bee.md").is_file());
        assert_eq!(app.toast(), Some("“a” already exists."));
        // a folder with the open note in it
        app.open_note(dir.join("sub/deep/c.md"), &mut tx);
        app.rename_path("sub", "Notes", &mut tx);
        assert!(dir.join("Notes/deep/c.md").is_file() && !dir.join("sub").exists());
        assert_eq!(app.path, Some(dir.join("Notes/deep/c.md")));
        assert_eq!(app.ed.text(), "# C");
        // into the Trash (a bin of our own here)
        let bin = dir.join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("a.md"), "older").unwrap();
        assert_eq!(trash_into(&dir.join("a.md"), &bin).unwrap(), bin.join("a 2.md"));
        assert_eq!(trash_into(&dir.join("Notes"), &bin).unwrap(), bin.join("Notes"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_asks_first_and_the_open_note_gives_way() {
        let dir = temp("delete");
        for p in ["a.md", "sub/b.md", "sub/c.md"] {
            std::fs::create_dir_all(dir.join(p).parent().unwrap()).unwrap();
            std::fs::write(dir.join(p), "x").unwrap();
        }
        // headless: the files stay, the tree changes
        let mut app = App::new("x", Some(dir.join("sub/b.md")), true).with_root(Some(dir.clone()), files::scan(&dir).0);
        let mut tx = Tx::default();
        app.ask_delete("sub");
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.message.as_str(), c.confirm.as_str(), c.danger), ("Delete folder", "Move “sub” and everything in it to the Trash?", "Delete", true));
        crate::actions::confirm(&mut app, &mut tx);
        assert_eq!(app.tree_rows().iter().map(|r| r.rel.as_str()).collect::<Vec<_>>(), ["a.md"]);
        assert_eq!(app.path, Some(dir.join("a.md")), "the first note left opens");
        app.ask_delete("a.md");
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.message.as_str()), ("Delete note", "Move “a.md” to the Trash?"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The row menu is Rune's native pop-up with the web's items in its order; a pick makes a note or a folder
    /// in the row's folder, renames or asks to delete, a dismissal does nothing.
    #[test]
    fn the_row_menu_is_a_native_popup_with_the_webs_items() {
        let (app, dir) = local("popup");
        let mut rt = rune::Runtime::new(app, view, (800.0, 600.0), rune::Env::new(true, 1.0));
        rt.update(|app, tx| app.row_menu("sub".into(), "row:sub", tx));
        assert_eq!(rt.popup_menu(), Some(&row_popup()));
        let want = PopupMenu::new()
            .item(PopupItem::new("new-note", "New note"))
            .item(PopupItem::new("new-folder", "New folder"))
            .item(PopupItem::new("rename", "Rename"))
            .item(PopupItem::new("delete", "Delete"));
        assert_eq!(row_popup(), want, "exactly these, in this order, no separators");
        rt.resolve_popup(Some("rename")).unwrap();
        assert_eq!(rt.state.renaming.as_ref().map(|r| r.0.as_str()), Some("sub"));
        // Delete: the confirm
        rt.update(|app, tx| app.row_menu("a.md".into(), (10.0, 10.0), tx));
        assert!(rt.state.renaming.is_none());
        rt.resolve_popup(Some("delete")).unwrap();
        assert!(matches!(&rt.state.dialog, Some(Dialog::Confirm(c)) if c.title == "Delete note"));
        rt.state.dialog = None;
        // dismissed: nothing
        rt.update(|app, tx| app.row_menu("a.md".into(), "more:a.md", tx));
        rt.resolve_popup(None).unwrap();
        assert!(rt.state.dialog.is_none() && rt.state.renaming.is_none());
        assert!(dir.join("a.md").is_file());
        // New note on a folder row: inside it; on a note row: in the note's folder
        rt.update(|app, tx| app.row_menu("sub/deep".into(), "row:sub/deep", tx));
        rt.resolve_popup(Some("new-note")).unwrap();
        assert_eq!(rt.state.path, Some(dir.join("sub/deep/Untitled.md")));
        assert!(dir.join("sub/deep/Untitled.md").is_file());
        rt.update(|app, tx| app.row_menu("sub/b.md".into(), "row:sub/b.md", tx));
        rt.resolve_popup(Some("new-note")).unwrap();
        assert_eq!(rt.state.path, Some(dir.join("sub/Untitled.md")));
        // New folder: "New folder" with an Untitled in it, its row in rename
        rt.update(|app, tx| app.row_menu("sub/deep".into(), "row:sub/deep", tx));
        rt.resolve_popup(Some("new-folder")).unwrap();
        assert_eq!(rt.state.path, Some(dir.join("sub/deep/New folder/Untitled.md")));
        assert_eq!(rt.state.renaming.as_ref().map(|r| r.0.as_str()), Some("sub/deep/New folder"));
        rt.state.renaming = None;
        rt.update(|app, tx| app.row_menu("a.md".into(), "row:a.md", tx));
        rt.resolve_popup(Some("new-folder")).unwrap();
        assert_eq!(rt.state.path, Some(dir.join("New folder/Untitled.md")), "a top-level note: at the top level");
        rt.state.renaming = None;
        rt.update(|app, tx| app.open_note(dir.join("a.md"), tx));
        // Shift+F10 and the Menu key on the tree's current row open it too
        rt.update(|app, tx| {
            app.focus_tree();
            let ev = rune::KeyEvent { key: rune::Key::ContextMenu, mods: rune::Mods::default() };
            assert!(crate::input::on_key(app, &ev, tx));
        });
        assert_eq!(rt.popup_menu(), Some(&row_popup()));
        rt.resolve_popup(None).unwrap();
        rt.update(|app, tx| {
            let ev = rune::KeyEvent { key: rune::Key::Function(10), mods: rune::Mods { shift: true, ..rune::Mods::default() } };
            crate::input::on_key(app, &ev, tx);
        });
        rt.resolve_popup(Some("rename")).unwrap();
        assert_eq!(rt.state.renaming.as_ref().map(|r| r.0.as_str()), Some("a.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
