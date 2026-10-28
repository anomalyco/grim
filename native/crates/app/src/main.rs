//! Grimoire: a Bear-like live-preview Markdown editor on Rune.
//!
//! `editor-core` owns the text, selection and every editing rule. This crate draws its
//! `render_lines()` with Rune (`render`), measures the same text with Parley for carets, hits
//! and selections (`layout`), turns Rune keys and drags into editor calls (`input`) and keeps the
//! note on disk (`doc`).
//!
//! `grimoire <folder>` opens a notes folder (the sidebar lists its Markdown files),
//! `grimoire <note.md>` opens the note's folder with it selected (creating the note if missing),
//! and `grimoire` alone opens `~/Documents/Grimoire`. Headless tooling (`--snap`, `--script`,
//! `--tree`) never writes to disk: it reads the given folder or file, or uses the built-in sample.

mod actions;
mod authors;
mod dialogs;
mod doc;
mod drop;
mod fake;
mod files;
mod header;
mod filesearch;
mod highlight;
mod history;
mod images;
mod input;
mod keys;
mod layout;
mod links;
mod menu;
mod net;
mod note;
mod remote;
#[cfg(test)]
mod remote_qa;
mod render;
mod rimages;
mod sidebar;
mod switcher;
mod theme;
mod toasts;
mod tree_edit;
mod uploads;
mod workspaces;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use editor_core::Sel;
use rune::{AppSpec, Live, TextEdit, Tx, Waker};

use crate::files::{Entry, Row};

use crate::layout::{FONTS, Fonts, Geo};

pub struct App {
    pub ed: note::Ed,
    pub path: Option<PathBuf>,
    pub blink: Live<f32>,
    pub(crate) saver: Option<doc::Saver>,
    /// The text the saver last received (remote notes: the text after the last change).
    pub(crate) sent: String,
    /// The note's text on disk as last loaded, without a saver (headless); the saver keeps its
    /// own (`App::confirmed`).
    disk: String,
    /// The open note changed on disk but couldn't reload yet (typing, or edits not saved): the
    /// watcher looks again on its next tick.
    pub recheck: Arc<AtomicBool>,
    pub headless: bool,
    /// IME marked text and the IME caret (a byte offset in it), while composing.
    pub marked: Option<(String, usize)>,
    /// When the text last changed (an external change only reloads a note left alone).
    last_edit: Instant,
    /// The notes folder; `None` for the built-in sample (no sidebar).
    pub root: Option<PathBuf>,
    pub files: Vec<Entry>,
    /// Bumped whenever `files` changes (the sidebar's rows are cached on it).
    files_gen: u64,
    rows_cache: RefCell<Option<RowsKey>>,
    /// Folders the user closed (the rest are open).
    pub collapsed: HashSet<PathBuf>,
    /// `collapsed` as last remembered (`App::remember_folders`).
    collapsed_saved: HashSet<PathBuf>,
    /// The sidebar's tree has the keys (else the editor does).
    pub tree_focus: bool,
    /// The tree's current row (a note or a folder): the open note unless the keys moved elsewhere.
    pub tree_cur: Option<PathBuf>,
    /// Type-ahead in the tree: what was typed, and when last.
    pub tree_typed: (String, Option<Instant>),
    /// The "Search files" dialog (⌘P).
    pub search: filesearch::Search,
    /// The user's Cmd-\ choice; `None` follows the window width.
    pub sidebar: Option<bool>,
    /// Where dragged-in images would land (the drop caret), while they hover the page.
    pub drop_at: Option<usize>,
    /// Image uploads under way into the open remote note (their "Uploading…" marks).
    pub uploads: Vec<uploads::Upload>,
    /// The heading line whose gutter the pointer is over (its fold chevron shows).
    pub fold_hover: Option<usize>,
    /// A plain press on a collapsed link, waiting for its release (it opens) or a drag.
    pub link_press: Option<input::LinkPress>,
    /// The link-text element a gesture started on (kept until the release).
    pub link_capture: Option<String>,
    /// The URL start of the link whose pencil the pointer is over.
    pub pencil_hover: Option<usize>,
    /// What following links did ("open https://…", "note a/b.md", "heading #x", "missing x.md",
    /// "ignored javascript:…"): the last few, for tests; headless runs also print them.
    pub link_log: Vec<String>,
    /// This drop brought images too (`drop::on_drop_files`), so its other files were skipped (`on_drop_rejected`).
    pub drop_took_images: bool,
    /// The toasts showing, oldest first (`toasts.rs`).
    pub toasts: Vec<toasts::Toast>,
    toast_next: u64,
    /// The app's clock (remote rooms' timers).
    pub t0: Instant,
    /// The open workspace (`None`: the built-in sample).
    pub current: Option<workspaces::WsRef>,
    /// The open remote workspace and its room.
    pub remote: Option<remote::Remote>,
    pub backend: remote::Backend,
    /// Recent workspaces and connected servers (persisted), and where app tokens go.
    pub store: workspaces::Store,
    pub tokens: workspaces::Tokens,
    pub switcher: switcher::Switcher,
    /// The note to open once a remote workspace's tree arrives.
    pub pending_note: Option<String>,
    /// A tree row being renamed (a note or a folder): its path and the name field.
    /// The menu bar's Show Authors check as installed (`refresh_menu` reinstalls it when it changes).
    pub store_menu_state: bool,
    /// The history drawer.
    pub history: history::HistoryPanel,
    /// Who's in each note of the open remote folder (the event stream's `presence`): (folder id, path) → people.
    pub presence: HashMap<(String, String), Vec<header::Person>>,
    /// When `check_tokens` last asked the servers (at most every 30 s).
    pub tokens_checked: Option<Instant>,
    pub renaming: Option<(String, TextEdit)>,
    /// The folder the refresh thread watches (the open local workspace's).
    pub watch: Arc<Mutex<Option<PathBuf>>>,
    /// Opens the browser at the connect page (`/usr/bin/open`; tests sign in by themselves).
    pub opener: fn(&str) -> Result<(), String>,
    /// The open dialog (New, Open, Change name, confirms…).
    pub dialog: Option<dialogs::Dialog>,
    /// What a Copy button last put on the clipboard (tests read it).
    /// The sidebar's "Share with an agent" card.
    pub agent: sidebar::AgentCard,
    pub copied: Option<String>,
    /// A remote note renamed while open: its new room's editor, until it syncs (the old text stays shown).
    pub staged: Option<Box<note::Collab>>,
    /// "Open folder…"'s picker in tests: a folder's path, `None` when cancelled, an error when it can't
    /// run. `None`: the system's (`Tx::open_folder`).
    pub picker: Option<Picker>,
}

/// A stand-in folder picker (tests): a path, `None` when cancelled, an error when it can't run.
pub type Picker = fn() -> Result<Option<String>, String>;

/// What the cached sidebar rows were built from: `files_gen`, the closed folders.
type RowsKey = (u64, HashSet<PathBuf>, Rc<Vec<Row>>);


/// An outside change to the open note waits this long after the last edit before reloading.
const RELOAD_COOLDOWN: Duration = Duration::from_secs(3);

impl App {
    fn new(text: &str, path: Option<PathBuf>, headless: bool) -> App {
        let saver = path.clone().filter(|_| !headless).map(|p| doc::Saver::spawn(p, text.to_string()));
        App {
            ed: note::Ed::local(text),
            path,
            blink: Live::new(1.0),
            saver,
            sent: text.to_string(),
            disk: text.to_string(),
            recheck: Arc::default(),
            headless,
            marked: None,
            last_edit: Instant::now(),
            root: None,
            files: Vec::new(),
            files_gen: 0,
            rows_cache: RefCell::new(None),
            collapsed: HashSet::new(),
            collapsed_saved: HashSet::new(),
            tree_focus: false,
            tree_cur: None,
            tree_typed: (String::new(), None),
            search: filesearch::Search::default(),
            sidebar: None,
            drop_at: None,
            uploads: Vec::new(),
            fold_hover: None,
            link_press: None,
            link_capture: None,
            pencil_hover: None,
            link_log: Vec::new(),
            toasts: Vec::new(),
            drop_took_images: false,
            toast_next: 0,
            t0: Instant::now(),
            current: None,
            remote: None,
            backend: remote::Backend::None,
            store: workspaces::Store { guest: Some(workspaces::Guest::new()), ..workspaces::Store::default() },
            tokens: workspaces::Tokens::None,
            switcher: switcher::Switcher::new(),
            pending_note: None,
            renaming: None,
            tokens_checked: None,
            presence: HashMap::new(),
            history: history::HistoryPanel::default(),
            store_menu_state: true,
            watch: Arc::default(),
            opener: remote::open_browser,
            dialog: None,
            copied: None,
            staged: None,
            agent: sidebar::AgentCard::default(),
            picker: None,
        }
    }

    /// The notes folder and its scan.
    #[cfg(test)]
    pub fn with_root_pub(self, root: Option<PathBuf>) -> App {
        self.with_root(root, Vec::new())
    }

    fn with_root(mut self, root: Option<PathBuf>, entries: Vec<Entry>) -> App {
        self.current = root.clone().map(|path| workspaces::WsRef::Local { path });
        *self.watch.lock().unwrap() = root.clone();
        self.root = root;
        self.set_files(entries);
        self
    }

    /// Open a local folder as the workspace (its note open last, else its newest), leaving the open one.
    pub fn open_local(&mut self, dir: PathBuf, tx: &mut Tx) {
        self.leave_workspace();
        let root = std::fs::canonicalize(&dir).unwrap_or(dir);
        let (entries, _) = files::scan(&root);
        let ws = workspaces::WsRef::Local { path: root.clone() };
        let note = self.store.last_note(&ws).map(|n| root.join(n)).filter(|p| p.is_file()).or_else(|| files::newest(&entries));
        self.path = None;
        self.ed = note::Ed::local("");
        self.collapsed.clear();
        self.collapsed_saved.clear();
        self.root = Some(root.clone());
        self.current = Some(ws.clone());
        *self.watch.lock().unwrap() = Some(root.clone());
        self.set_files(entries);
        self.store.touch(&ws, None);
        tx.set_title(ws.name());
        if let Some(p) = note {
            self.open_note(p, tx);
        }
    }

    /// The open note's path relative to the workspace (what the recent list remembers).
    fn rel_note(&self) -> Option<String> {
        let (root, p) = (self.root.as_ref()?, self.path.as_ref()?);
        p.strip_prefix(root).ok().map(|r| r.to_string_lossy().into_owned())
    }

    /// New rows for the sidebar; the open note keeps its row even when it isn't on disk (not
    /// written yet, headless, or deleted outside).
    pub(crate) fn set_files(&mut self, entries: Vec<Entry>) {
        let old = files::dirs(&self.files);
        self.files = entries;
        // folders new to the tree start as remembered, else as their workspace's default (a linked repo's closed)
        let default_open = self.folders_open_by_default();
        for d in files::dirs(&self.files).difference(&old) {
            if !self.store.folder_open(d).unwrap_or(default_open) {
                self.collapsed.insert(d.clone());
                self.collapsed_saved.insert(d.clone());
            }
        }
        if let (Some(root), Some(p)) = (&self.root, &self.path)
            && !files::contains(&self.files, p)
            && p.starts_with(root)
        {
            files::insert(&mut self.files, root, p);
        }
        self.files_gen += 1;
    }

    /// The open workspace's folders start open, except a linked repo's (the web's `openByDefault`).
    fn folders_open_by_default(&self) -> bool {
        !self.remote.as_ref().is_some_and(|r| r.folders_closed)
    }

    /// Remember the folders opened or closed since last time (against the workspace's default), as the web does.
    fn remember_folders(&mut self) {
        if self.collapsed == self.collapsed_saved {
            return;
        }
        let default_open = self.folders_open_by_default();
        let mut changed = false;
        for p in self.collapsed.difference(&self.collapsed_saved) {
            changed |= self.store.set_folder(p, default_open.then_some(false));
        }
        for p in self.collapsed_saved.difference(&self.collapsed) {
            changed |= self.store.set_folder(p, (!default_open).then_some(true));
        }
        self.collapsed_saved = self.collapsed.clone();
        if changed {
            self.store.save();
        }
    }

    /// The sidebar's rows, rebuilt only when the notes or the closed folders changed.
    pub fn tree_rows(&self) -> Rc<Vec<Row>> {
        let Some(root) = &self.root else { return Rc::default() };
        let mut cache = self.rows_cache.borrow_mut();
        if let Some((generation, collapsed, rows)) = &*cache
            && *generation == self.files_gen
            && *collapsed == self.collapsed
        {
            return rows.clone();
        }
        let rows = Rc::new(files::rows(&self.files, root, &self.collapsed));
        *cache = Some((self.files_gen, self.collapsed.clone(), rows.clone()));
        rows
    }

    /// Flush the open note and open `path` (an empty note if it isn't on disk).
    pub fn open_note(&mut self, path: PathBuf, tx: &mut Tx) {
        self.tree_cur = Some(path.clone());
        if self.path.as_deref().is_some_and(|p| same_file(p, &path)) {
            return;
        }
        if self.remote.is_some() {
            let Some(rel) = self.root.as_ref().and_then(|r| path.strip_prefix(r).ok()).map(|r| r.to_string_lossy().into_owned()) else { return };
            self.save_folds();
            self.fold_hover = None;
            self.pencil_hover = None;
            self.link_press = None;
            self.marked = None;
            self.drop_at = None;
            let mut dir = path.parent();
            while let Some(d) = dir {
                self.collapsed.remove(d);
                dir = d.parent();
            }
            self.open_remote_note(rel, tx);
            if let Some(keys) = self.store.folds_of(&path) {
                self.ed.set_fold_keys(&keys);
            }
            self.sent = self.ed.text().to_string();
            self.path = Some(path);
            self.history_retarget(tx);
            return;
        }
        // Before reading: `path` may be the open note under another name.
        self.save_now();
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => doc::normalize_newlines(&t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                eprintln!("grimoire: {}: {e}", path.display());
                return;
            }
        };
        self.save_folds();
        let kill = self.ed.kill_buffer().to_string();
        self.ed = note::Ed::local(&text);
        self.ed.set_kill_buffer(&kill);
        if let Some(keys) = self.store.folds_of(&path) {
            self.ed.set_fold_keys(&keys);
        }
        self.fold_hover = None;
        self.pencil_hover = None;
        self.link_press = None;
        self.sent = text.clone();
        self.disk = text.clone();
        self.marked = None;
        self.drop_at = None;
        self.saver = (!self.headless).then(|| doc::Saver::spawn(path.clone(), text));
        let mut dir = path.parent();
        while let Some(d) = dir {
            self.collapsed.remove(d);
            dir = d.parent();
        }
        tx.set_title(title(Some(&path)));
        tx.scroll_to_y("scroll", 0.0);
        self.path = Some(path);
        self.history_retarget(tx);
        if let Some(ws) = self.current.clone() {
            let rel = self.rel_note();
            self.store.set_note(&ws, rel);
        }
    }

    /// Remember the open note's folds (across launches, as the web's localStorage). A remote note's only once
    /// its text is there (they're put back then, `pump_collab`).
    pub(crate) fn save_folds(&mut self) {
        if self.remote.as_ref().is_some_and(|r| !r.synced) {
            return;
        }
        if let Some(old) = self.path.clone()
            && self.store.set_folds(&old, self.ed.fold_keys())
        {
            self.store.save();
        }
    }

    /// New Note (⌘N, the "+ New note" row): `Untitled.md` (or `Untitled 2.md`…) in the selected folder
    /// (`App::selected_dir`), opened with the caret at the start.
    pub fn new_note(&mut self, tx: &mut Tx) {
        if self.remote.is_some() {
            self.remote_new_note(tx);
            return;
        }
        let (Some(root), Some(dir)) = (self.root.clone(), self.selected_dir()) else { return };
        let path = files::untitled(&dir, |p| p.exists() || files::contains(&self.files, p));
        if !self.headless
            && let Err(e) = doc::write(&path, "")
        {
            eprintln!("grimoire: {}: {e}", path.display());
            return;
        }
        // The watcher's next scan picks up the file itself.
        files::insert(&mut self.files, &root, &path);
        self.files_gen += 1;
        self.close_search();
        self.open_note(path, tx);
        self.type_here();
    }

    /// A new note: the editor has the keys, the caret at its start (never the tree, a field or a menu).
    pub fn type_here(&mut self) {
        self.tree_focus = false;
        self.renaming = None;
        self.marked = None;
        self.close_search();
        self.close_switcher();
        self.ed.set_selection(editor_core::Sel::caret(0));
    }

    /// Enter at or after an untitled note's first line (`Untitled.md`, `Untitled 2.md`…) when that line is an
    /// H1: the note takes the heading's text as its name, once (`files::heading_title`, `files::free_name`:
    /// `Title.md`, else `Title 2.md`…, in the same folder). Afterwards it isn't untitled, so later edits to the
    /// heading never rename it. Remote notes go through the server's rename.
    pub fn auto_name(&mut self, tx: &mut Tx) {
        let Some(path) = self.path.clone() else { return };
        if !path.file_name().and_then(|n| n.to_str()).is_some_and(files::is_untitled) {
            return;
        }
        let Some(title) = files::heading_title(self.ed.text()) else { return };
        if files::is_untitled(&format!("{title}.md")) {
            return;
        }
        let (Some(dir), Some(root)) = (path.parent().map(Path::to_path_buf), self.root.clone()) else { return };
        if let Some(rem) = self.remote.as_ref().filter(|r| r.loaded && !r.read_only) {
            let lower: Vec<String> = rem.tree_list.iter().map(|p| p.to_lowercase()).collect();
            let to = files::free_name(&dir, &title, |p| lower.contains(&files::rel(&root, p).to_lowercase()));
            self.remote_rename(files::rel(&root, &path), files::rel(&root, &to), tx);
            return;
        }
        if self.remote.is_some() {
            return;
        }
        let to = files::free_name(&dir, &title, |p| p.exists() || files::contains(&self.files, p));
        self.rename_local(&path, &to, tx);
    }

    /// A rescan from the refresh thread found a change: new rows, and the open note may reload.
    pub fn refreshed(&mut self, files: Vec<Entry>, tx: &mut Tx) {
        if self.remote.is_some() {
            return;
        }
        self.set_files(files);
        self.check_disk(tx);
    }

    /// The text known to be on disk: what the saver last wrote (or the note was loaded with).
    fn confirmed(&self) -> String {
        self.saver.as_ref().map_or_else(|| self.disk.clone(), doc::Saver::confirmed)
    }

    /// The open note reloads when it changed on disk while the editor holds exactly what was last
    /// written there and hasn't been touched for a few seconds. Unsaved edits (still queued, or
    /// failing to save) are never replaced; until it can decide, the watcher asks again.
    pub fn check_disk(&mut self, tx: &mut Tx) {
        if self.remote.is_some() {
            return;
        }
        let Some(p) = &self.path else { return };
        let Ok(disk) = std::fs::read_to_string(p) else { return };
        let disk = doc::normalize_newlines(&disk);
        let confirmed = self.confirmed();
        if disk == confirmed {
            return;
        }
        if self.ed.text() != confirmed || self.last_edit.elapsed() < RELOAD_COOLDOWN {
            self.recheck.store(true, Ordering::SeqCst);
            return;
        }
        self.ed.set_text(&disk);
        self.marked = None;
        if let Some(s) = &self.saver {
            s.set_confirmed(disk.clone());
        }
        self.sent = disk.clone();
        self.disk = disk;
        tx.instant();
    }

    /// Geometry of the current render (what is on screen after the last view).
    pub fn geometry(&self) -> Geo {
        // a remote note's images come from its server
        let base = match &self.remote {
            Some(r) => match &r.note {
                Some(note) => rimages::Base::Remote { server: &r.api.server, id: r.id(), note, token: r.api.token.as_deref() },
                None => rimages::Base::Local(None),
            },
            None => rimages::Base::Local(self.path.as_deref().and_then(Path::parent)),
        };
        layout::build_in(self.ed.text(), &self.ed.render_lines(), base)
    }

    /// After every handled event: show the caret, skip animation, queue an autosave.
    pub fn handled(&mut self, tx: &mut Tx) -> bool {
        self.remember_folders();
        self.save_folds();
        self.blink.set(1.0);
        tx.instant();
        if self.remote.is_some() {
            self.authors_follow(true);
            self.pump_collab();
            if let Some(e) = uploads::diff(&self.sent, self.ed.text()) {
                self.map_uploads(&[e]);
            }
            self.sent = self.ed.text().to_string();
            return true;
        }
        if self.ed.text() != self.sent {
            self.sent = self.ed.text().to_string();
            self.last_edit = Instant::now();
            if let Some(s) = &self.saver {
                s.update(self.sent.clone());
            }
        }
        true
    }

    pub fn save_now(&mut self) {
        if let Some(s) = &self.saver {
            if self.ed.text() != self.sent {
                self.sent = self.ed.text().to_string();
                s.update(self.sent.clone());
            }
            s.flush();
            if s.failing()
                && let Some(p) = &self.path
            {
                eprintln!("grimoire: {} is not saved yet (still retrying)", p.display());
            }
        }
    }
}

/// The same file, also when reached through a symlink or another spelling of the path.
fn same_file(a: &Path, b: &Path) -> bool {
    a == b || std::fs::canonicalize(a).is_ok_and(|ca| std::fs::canonicalize(b).is_ok_and(|cb| ca == cb))
}

/// The window title: the note's name.
pub fn title(path: Option<&Path>) -> String {
    path.map_or_else(|| "Grimoire".to_string(), files::note_name)
}

fn sample() -> App {
    App::new(doc::SAMPLE, None, true)
}

fn setup(app: &mut App, wake: Waker) {
    // Finished image decodes repaint; headless runs decode before their first frame.
    images::init(wake);
    if app.headless {
        images::set_sync(true);
        return;
    }
    rimages::set_net();
    // Live values repaint the caret without rebuilding the view.
    let blink = app.blink.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(530));
            blink.set(if blink.get() > 0.5 { 0.0 } else { 1.0 });
        }
    });
}

/// The app's fonts (Inter with its italic and bold faces, and the system's Menlo when there is one) and
/// the mono family's name.
pub fn app_fonts() -> (&'static [&'static [u8]], &'static str) {
    let menlo: Option<&'static [u8]> =
        std::fs::read("/System/Library/Fonts/Menlo.ttc").ok().map(|v| &*Box::leak(v.into_boxed_slice()));
    // Same family: `Span::italic` picks the italic faces.
    let mut list: Vec<&'static [u8]> = vec![
        include_bytes!("../assets/fonts/Inter-Regular.ttf"),
        include_bytes!("../assets/fonts/Inter-Italic.ttf"),
        include_bytes!("../assets/fonts/Inter-Medium.ttf"),
        include_bytes!("../assets/fonts/Inter-SemiBold.ttf"),
        include_bytes!("../assets/fonts/Inter-Bold.ttf"),
        include_bytes!("../assets/fonts/Inter-BoldItalic.ttf"),
    ];
    list.extend(menlo);
    (Box::leak(list.into_boxed_slice()), if menlo.is_some() { "Menlo" } else { "Inter" })
}

fn find_text(app: &App, needle: &str) -> usize {
    app.ed.text().find(needle).unwrap_or(0)
}

type Scene = (&'static str, fn(&mut App));

const SCENES: &[Scene] = &[
    ("default", |_| {}),
    ("empty", |app| app.ed = note::Ed::local("")),
    ("caret-in-bold", |app| {
        let p = find_text(app, "plain text") + 3;
        app.ed.set_selection(Sel::caret(p));
    }),
    ("selection", |app| {
        let a = find_text(app, "Markdown stays");
        let b = find_text(app, "Bullets continue") + 8;
        app.ed.set_selection(Sel::new(a, b));
    }),
    ("in-table", |app| {
        let p = find_text(app, "Cmd-B") + 2;
        app.ed.set_selection(Sel::caret(p));
    }),
    ("in-code", |app| {
        let p = find_text(app, "println");
        app.ed.set_selection(Sel::caret(p));
    }),
    // Rune's scripts have no IME events: these compose through `input::on_ime` as a window would,
    // after " caf" typed at the end of "Draw it with Rune": a dead key's ´ marked, then é committed.
    ("ime-preedit", |app| ime_scene(app, false)),
    ("ime-commit", |app| ime_scene(app, true)),
];

fn ime_scene(app: &mut App, commit: bool) {
    let p = find_text(app, "Draw it with Rune") + "Draw it with Rune".len();
    app.ed.set_selection(Sel::caret(p));
    app.ed.insert_text(" caf");
    let mut tx = Tx::default();
    input::on_ime(app, &rune::Ime::Preedit("\u{b4}".into(), Some((2, 2))), &mut tx);
    if commit {
        input::on_ime(app, &rune::Ime::Preedit(String::new(), None), &mut tx);
        input::on_ime(app, &rune::Ime::Commit("\u{e9}".into()), &mut tx);
    }
}

/// Held keys repeat instead of opening the accent picker, which winit can't deliver to us
/// correctly (see docs/rune-capabilities.md, IME). Registered, not written: a user's own
/// `defaults write` setting still wins.
#[cfg(target_os = "macos")]
fn disable_press_and_hold() {
    use std::ffi::{CStr, c_char, c_void};
    type Id = *mut c_void;
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Id;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }
    #[link(name = "Foundation", kind = "framework")]
    unsafe extern "C" {}
    unsafe {
        let send0: extern "C" fn(Id, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_bool: extern "C" fn(Id, Id, i8) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_ptr: extern "C" fn(Id, Id, *const c_char) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send2: extern "C" fn(Id, Id, Id, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send1: extern "C" fn(Id, Id, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let cls = |n: &CStr| objc_getClass(n.as_ptr());
        let sel = |n: &CStr| sel_registerName(n.as_ptr());
        let pool = objc_autoreleasePoolPush();
        let key = send_ptr(cls(c"NSString"), sel(c"stringWithUTF8String:"), c"ApplePressAndHoldEnabled".as_ptr());
        let no = send_bool(cls(c"NSNumber"), sel(c"numberWithBool:"), 0);
        let dict = send2(cls(c"NSDictionary"), sel(c"dictionaryWithObject:forKey:"), no, key);
        let defaults = send0(cls(c"NSUserDefaults"), sel(c"standardUserDefaults"));
        send1(defaults, sel(c"registerDefaults:"), dict);
        objc_autoreleasePoolPop(pool);
    }
}

fn main() {
    let args = rune::tooling::Args::parse();
    let headless = args.headless() || args.script.is_some();
    keys::init(headless);
    #[cfg(target_os = "macos")]
    if !headless {
        disable_press_and_hold();
    }
    let mut arg_path = rune::extra_args().iter().find(|a| !a.starts_with("--")).map(PathBuf::from);
    let use_sample = rune::extra_args().iter().any(|a| a == "--sample");
    // The recent list and tokens: the support folder (headless runs only with --support-dir=DIR).
    let support = rune::extra_args().iter().find_map(|a| a.strip_prefix("--support-dir=").map(PathBuf::from));
    let support = support.or_else(|| if headless { None } else { workspaces::default_support_dir() });
    let mut store = workspaces::Store::load(support.clone());
    store.read_only = headless;
    let tokens = match (&support, headless) {
        (Some(d), false) => workspaces::Tokens::Keychain { fallback: Some(d.join("tokens.json")) },
        (Some(d), true) => workspaces::Tokens::File(d.join("tokens.json")),
        (None, _) => workspaces::Tokens::None,
    };
    // Headless: a remote workspace on the in-process mock server (a peer typing in the open note).
    let demo = rune::extra_args().iter().find_map(|a| if a == "--remote-demo" { Some(String::new()) } else { a.strip_prefix("--remote-demo=").map(str::to_string) });
    // No argument: the workspace open last.
    let mut startup_remote = None;
    if arg_path.is_none() && !headless && !use_sample {
        match store.recent.first() {
            Some((workspaces::WsRef::Local { path }, _)) if path.is_dir() => arg_path = Some(path.clone()),
            Some((workspaces::WsRef::Remote { server, id, title }, note)) => startup_remote = Some((server.clone(), id.clone(), title.clone(), note.clone())),
            _ => {}
        }
    }

    let (root, path, text, entries, fingerprint) = if use_sample || demo.is_some() || startup_remote.is_some() || (headless && arg_path.is_none()) {
        (None, None, doc::SAMPLE.to_string(), Vec::new(), 0)
    } else {
        match doc::locate(arg_path, headless) {
            Ok(doc::Located { root, path, entries, fingerprint }) => {
                let text = match &path {
                    Some(p) if headless => doc::normalize_newlines(&std::fs::read_to_string(p).unwrap_or_default()),
                    Some(p) => doc::open(p).unwrap_or_else(|e| {
                        eprintln!("grimoire: {}: {e}", p.display());
                        std::process::exit(1);
                    }),
                    None => String::new(),
                };
                (Some(root), path, text, entries, fingerprint)
            }
            Err(e) => {
                eprintln!("grimoire: {e}");
                std::process::exit(1);
            }
        }
    };

    let title = title(path.as_deref());

    let (fonts, mono) = app_fonts();
    FONTS.set(Fonts { list: fonts, sans: "Inter", mono }).ok();

    let spec = AppSpec {
        title: Box::leak(title.into_boxed_str()),
        size: (820.0, 720.0),
        min_size: Some((420.0, 320.0)),
        init: sample,
        view: render::view,
        scenes: SCENES,
        fonts,
        families: ("Inter", mono),
        setup: Some(setup),
        poll: None,
        on_key: Some(input::on_key),
    };
    let watch: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(root.clone()));
    let app_watch = watch.clone();
    let recheck: Arc<AtomicBool> = Arc::default();
    let app_recheck = recheck.clone();
    // The page draws its own editor: the input method composes for it (the caret has `ime_cursor`).
    let mut app = rune::App::new(spec).on_ime(input::on_ime);
    for item in tree_edit::menu_items(true) {
        app = app.menu_item(item);
    }
    let handle = app.handle();
    let app_handle = handle.clone();
    app = app
        .init(move || {
            // the store first: the tree opens its folders as remembered
            let mut app = App::new(&text, path, headless);
            app.store = store;
            let mut app = app.with_root(root, entries);
            app.recheck = app_recheck;
            app.watch = app_watch;
            app.store.ensure_guest();
            app.store_menu_state = !app.store.hide_authors;
            app.tokens = tokens;
            if !headless {
                app.backend = remote::Backend::Net(remote::Handle::Rune(app_handle));
            }
            if let Some(ws) = app.current.clone() {
                let rel = app.rel_note();
                app.store.touch(&ws, rel);
            }
            if let Some(state) = &demo {
                remote::demo(&mut app, state);
            }
            app
        })
        // a token revoked on the web shows when the app comes back to the front
        .on_focus(|app, focused, _tx| {
            if focused {
                app.check_tokens();
            }
        })
        .on_close(|app, _tx| {
            app.save_now();
            app.close_room();
        });
    handle.update(|app, _| app.check_tokens());
    if let Some((server, id, title, note)) = startup_remote {
        handle.update(move |app, tx| app.open_remote(server, id, title, note, tx));
    }
    if !headless {
        // Notes created, renamed or edited outside show up within a couple of seconds.
        std::thread::spawn(move || {
            let mut last = fingerprint;
            let mut last_root = watch.lock().unwrap().clone();
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let cur = watch.lock().unwrap().clone();
                let Some(root) = cur.clone() else {
                    last_root = None;
                    continue;
                };
                let (entries, fp) = files::scan(&root);
                if cur != last_root {
                    // another workspace: it was scanned when it opened
                    last_root = cur;
                    last = fp;
                    continue;
                }
                if fp != last {
                    last = fp;
                    recheck.store(false, Ordering::SeqCst);
                    handle.update(move |app, tx| {
                        if app.root.as_deref() == Some(root.as_path()) {
                            app.refreshed(entries, tx);
                        }
                    });
                } else if recheck.swap(false, Ordering::SeqCst) {
                    handle.update(|app, tx| app.check_disk(tx));
                }
            }
        });
    }
    app.run();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("grimoire-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    fn open(dir: &Path, note: &Path, headless: bool) -> App {
        let text = std::fs::read_to_string(note).unwrap();
        App::new(&text, Some(note.to_path_buf()), headless).with_root(Some(dir.to_path_buf()), files::scan(dir).0)
    }

    /// As if the last edit was long enough ago for an outside change to reload.
    fn idle(app: &mut App) {
        app.last_edit = Instant::now() - Duration::from_secs(10);
    }

    #[test]
    fn switching_notes_saves_the_old_one_and_new_notes_get_free_names() {
        let dir = temp_dir("switch");
        let (a, b) = (dir.join("a.md"), dir.join("sub/b.md"));
        doc::write(&a, "one").unwrap();
        doc::write(&b, "two").unwrap();
        let mut app = open(&dir, &a, false);
        let mut tx = Tx::default();
        app.ed.insert_text("edited ");
        app.handled(&mut tx);
        app.open_note(b.clone(), &mut tx);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "edited one", "flushed on switch");
        assert_eq!(app.ed.text(), "two");
        assert_eq!(app.path.as_deref(), Some(b.as_path()));

        // into the open note's folder
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("sub/Untitled.md")));
        app.tree_cur = Some(a.clone());
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("Untitled.md")));
        assert!(dir.join("Untitled.md").exists());
        assert!(files::contains(&app.files, &dir.join("Untitled.md")), "in the tree without a rescan");
        app.tree_cur = Some(dir.join("sub"));
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("sub/Untitled 2.md")));
        app.tree_cur = Some(a.clone());
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("Untitled 2.md")));
        assert_eq!(app.ed.selection(), Sel::caret(0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An untitled note takes its H1 as its name once (on Enter at or after the heading): the file moves,
    /// the editor keeps its text and caret, and later heading edits don't rename it again.
    #[test]
    fn untitled_notes_are_named_after_their_heading_once() {
        let dir = temp_dir("autoname");
        let a = dir.join("a.md");
        doc::write(&a, "one").unwrap();
        doc::write(&dir.join("Road trip.md"), "taken").unwrap();
        let mut app = open(&dir, &a, false);
        app.current = Some(workspaces::WsRef::Local { path: dir.clone() });
        app.store.touch(app.current.as_ref().unwrap(), None);
        let mut tx = Tx::default();
        app.new_note(&mut tx);
        let untitled = dir.join("Untitled.md");
        assert_eq!(app.path.as_deref(), Some(untitled.as_path()));
        // no H1 yet: nothing happens
        app.ed.insert_text("Road trip\n");
        app.auto_name(&mut tx);
        assert_eq!(app.path.as_deref(), Some(untitled.as_path()));
        app.ed.set_text("");
        // an empty heading: nothing
        app.ed.insert_text("# \n");
        app.auto_name(&mut tx);
        assert_eq!(app.path.as_deref(), Some(untitled.as_path()));
        app.ed.set_text("");
        app.ed.insert_text("# **Road** trip\nnext");
        let caret = app.ed.selection();
        app.handled(&mut tx);
        app.auto_name(&mut tx);
        let named = dir.join("Road trip 2.md");
        assert_eq!(app.path.as_deref(), Some(named.as_path()), "Road trip.md is taken");
        assert!(named.is_file() && !untitled.exists());
        assert_eq!(std::fs::read_to_string(&named).unwrap(), "# **Road** trip\nnext", "saved before the move");
        assert_eq!((app.ed.text(), app.ed.selection()), ("# **Road** trip\nnext", caret), "same text and caret");
        assert!(files::contains(&app.files, &named) && !files::contains(&app.files, &untitled));
        assert_eq!(app.store.last_note(app.current.as_ref().unwrap()).as_deref(), Some("Road trip 2.md"));
        // later edits save to the new file and never rename again
        app.ed.set_selection(Sel::caret(2));
        app.ed.insert_text("Big ");
        app.handled(&mut tx);
        app.auto_name(&mut tx);
        app.save_now();
        assert_eq!(app.path.as_deref(), Some(named.as_path()));
        assert_eq!(std::fs::read_to_string(&named).unwrap(), "# Big **Road** trip\nnext");
        // a note that isn't untitled keeps its name
        app.open_note(a.clone(), &mut tx);
        app.ed.set_text("# Something else\n");
        app.auto_name(&mut tx);
        assert_eq!(app.path.as_deref(), Some(a.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Folds stay across launches (the store's `folds`, as the web's localStorage), and follow a renamed note.
    #[test]
    fn folds_are_remembered_across_launches() {
        let dir = temp_dir("folds-launch");
        let support = temp_dir("folds-launch-support");
        let a = dir.join("a.md");
        doc::write(&a, "# A\none\n# B\ntwo").unwrap();
        let launch = || {
            let mut app = App::new(&std::fs::read_to_string(&a).unwrap(), None, true);
            app.store = workspaces::Store::load(Some(support.clone()));
            let mut app = app.with_root(Some(dir.clone()), files::scan(&dir).0);
            app.open_note(a.clone(), &mut Tx::default());
            app
        };
        let mut app = launch();
        let mut tx = Tx::default();
        app.ed.toggle_fold(2);
        app.handled(&mut tx);
        assert_eq!(launch().ed.folded_lines(), vec![2], "folded after a relaunch");
        let mut app = launch();
        app.ed.toggle_fold(2);
        app.handled(&mut tx);
        assert!(launch().ed.folded_lines().is_empty(), "unfolded: forgotten");
        assert!(app.store.folds.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&support);
    }

    #[test]
    fn folds_are_remembered_per_note_in_memory() {
        let dir = temp_dir("folds");
        let (a, b) = (dir.join("a.md"), dir.join("b.md"));
        doc::write(&a, "# A\none\n# B\ntwo").unwrap();
        doc::write(&b, "# Other\nx").unwrap();
        let mut app = open(&dir, &a, true);
        let mut tx = Tx::default();
        app.ed.toggle_fold(2);
        app.open_note(b.clone(), &mut tx);
        assert!(app.ed.folded_lines().is_empty());
        app.open_note(a.clone(), &mut tx);
        assert_eq!(app.ed.folded_lines(), vec![2]);
        assert_eq!(app.ed.text(), "# A\none\n# B\ntwo");
        // nothing written beside the notes
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_notes_go_into_a_folder_emptied_of_notes() {
        let dir = temp_dir("emptied");
        let (a, b) = (dir.join("a.md"), dir.join("sub/b.md"));
        doc::write(&a, "one").unwrap();
        doc::write(&b, "two").unwrap();
        let mut app = open(&dir, &a, false);
        let mut tx = Tx::default();
        app.tree_cur = Some(dir.join("sub"));
        std::fs::remove_file(&b).unwrap();
        app.refreshed(files::scan(&dir).0, &mut tx);
        assert!(!files::contains(&app.files, &dir.join("sub")), "no row for the empty folder");
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("sub/Untitled.md")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_the_open_note_by_another_name_keeps_the_edits() {
        let dir = temp_dir("alias");
        let a = dir.join("a.md");
        doc::write(&a, "one").unwrap();
        std::os::unix::fs::symlink(&a, dir.join("alias.md")).unwrap();
        let mut app = open(&dir, &a, false);
        let mut tx = Tx::default();
        app.ed.insert_text("edited ");
        app.handled(&mut tx);
        app.open_note(dir.join("alias.md"), &mut tx);
        assert_eq!(app.ed.text(), "edited one");
        app.save_now();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "edited one");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_outside_change_reloads_only_a_note_left_alone() {
        let dir = temp_dir("reload");
        let a = dir.join("a.md");
        doc::write(&a, "one").unwrap();
        let mut app = open(&dir, &a, true);
        let mut tx = Tx::default();
        app.ed.insert_text("x");
        app.handled(&mut tx);
        doc::write(&a, "from outside").unwrap();
        app.refreshed(files::scan(&dir).0, &mut tx);
        assert_eq!(app.ed.text(), "xone", "unsaved: kept");
        app.ed.set_text("one");
        app.handled(&mut tx);
        app.refreshed(files::scan(&dir).0, &mut tx);
        assert_eq!(app.ed.text(), "one", "just edited: kept for now");
        assert!(app.recheck.swap(false, Ordering::SeqCst), "the watcher looks again");
        idle(&mut app);
        app.marked = Some(("´".into(), 2));
        app.check_disk(&mut tx);
        assert_eq!(app.ed.text(), "from outside");
        assert_eq!(app.marked, None, "the composition goes with the old text");
        assert!(!app.recheck.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_still_queued_is_never_reloaded_over() {
        let dir = temp_dir("queued");
        let a = dir.join("a.md");
        doc::write(&a, "one").unwrap();
        let mut app = open(&dir, &a, false);
        let mut tx = Tx::default();
        app.ed.insert_text("x");
        app.handled(&mut tx);
        doc::write(&a, "from outside").unwrap();
        idle(&mut app);
        // The saver is still waiting out its debounce.
        app.refreshed(files::scan(&dir).0, &mut tx);
        assert_eq!(app.ed.text(), "xone");
        app.save_now();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "xone", "the edits win");
        app.check_disk(&mut tx);
        assert_eq!(app.ed.text(), "xone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_save_is_never_reloaded_over() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("failing");
        let a = dir.join("a.md");
        doc::write(&a, "one").unwrap();
        let mut app = open(&dir, &a, false);
        let mut tx = Tx::default();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        app.ed.insert_text("x");
        app.handled(&mut tx);
        app.save_now();
        // The file itself is still writable from outside.
        std::fs::write(&a, "from outside").unwrap();
        idle(&mut app);
        app.refreshed(files::scan(&dir).0, &mut tx);
        assert_eq!(app.ed.text(), "xone");
        assert!(app.recheck.load(Ordering::SeqCst));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        app.save_now();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "xone", "retried");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_outside_change_while_typing_reloads_after_the_pause() {
        let dir = temp_dir("pause");
        let a = dir.join("a.md");
        doc::write(&a, "one").unwrap();
        let mut app = open(&dir, &a, false);
        let mut tx = Tx::default();
        app.ed.insert_text("x");
        app.handled(&mut tx);
        app.save_now();
        doc::write(&a, "from outside").unwrap();
        app.refreshed(files::scan(&dir).0, &mut tx);
        assert_eq!(app.ed.text(), "xone", "typing: not yet");
        // The watcher's next tick: the folder is unchanged, but it was asked to look again.
        assert!(app.recheck.swap(false, Ordering::SeqCst));
        idle(&mut app);
        app.check_disk(&mut tx);
        assert_eq!(app.ed.text(), "from outside");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_search_field_and_the_editor_never_share_a_composition() {
        let mut app = App::new("one", Some(PathBuf::from("/nonexistent/a.md")), true).with_root(Some(PathBuf::from("/nonexistent")), Vec::new());
        let mut tx = Tx::default();
        app.marked = Some(("´".into(), 2));
        app.open_search();
        assert_eq!(app.marked, None);
        app.search.input.preedit = Some(("に".into(), None));
        app.close_search();
        assert!(!app.search.input.focused);
        assert_eq!(app.search.input.preedit, None);
        // Focused by a click (Rune sets it): the first IME event for the field drops the editor's.
        app.marked = Some(("´".into(), 2));
        app.search.open = true;
        app.search.input.focused = true;
        assert!(!input::on_ime(&mut app, &rune::Ime::Preedit("か".into(), None), &mut tx));
        assert_eq!(app.marked, None);
    }
}
