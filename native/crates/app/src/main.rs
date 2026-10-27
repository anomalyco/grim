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

mod doc;
mod drop;
mod files;
mod images;
mod input;
mod keys;
mod layout;
mod render;
mod sidebar;
mod theme;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use editor_core::{Editor, Sel};
use rune::{AppSpec, Live, TextEdit, Tx, Waker};

use crate::files::{Entry, Row};

use crate::layout::{FONTS, Fonts, Geo};

pub struct App {
    pub ed: Editor,
    pub path: Option<PathBuf>,
    pub blink: Live<f32>,
    saver: Option<doc::Saver>,
    /// The text the saver last received.
    sent: String,
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
    /// The sidebar's filter field.
    pub filter: TextEdit,
    /// The user's Cmd-\ choice; `None` follows the window width.
    pub sidebar: Option<bool>,
    /// The folder row clicked last: new notes go there (a click on a note goes back to the root).
    pub new_dir: Option<PathBuf>,
    /// Where dragged-in images would land (the drop caret), while they hover the page.
    pub drop_at: Option<usize>,
    /// The heading line whose gutter the pointer is over (its fold chevron shows).
    pub fold_hover: Option<usize>,
    /// Folded headings of the notes opened this session (`Editor::fold_keys`), by path: view state,
    /// kept in memory only, never written next to the notes.
    folds: HashMap<PathBuf, Vec<(String, usize)>>,
}

/// What the cached sidebar rows were built from: `files_gen`, the closed folders, the filter.
type RowsKey = (u64, HashSet<PathBuf>, String, Rc<Vec<Row>>);

/// An outside change to the open note waits this long after the last edit before reloading.
const RELOAD_COOLDOWN: Duration = Duration::from_secs(3);

impl App {
    fn new(text: &str, path: Option<PathBuf>, headless: bool) -> App {
        let saver = path.clone().filter(|_| !headless).map(|p| doc::Saver::spawn(p, text.to_string()));
        let mut filter = TextEdit::new("");
        filter.single_line = true;
        App {
            ed: keys::editor(text),
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
            filter,
            sidebar: None,
            new_dir: None,
            drop_at: None,
            fold_hover: None,
            folds: HashMap::new(),
        }
    }

    /// The notes folder and its scan.
    fn with_root(mut self, root: Option<PathBuf>, entries: Vec<Entry>) -> App {
        self.root = root;
        self.set_files(entries);
        self
    }

    /// New rows for the sidebar; the open note keeps its row even when it isn't on disk (not
    /// written yet, headless, or deleted outside).
    fn set_files(&mut self, entries: Vec<Entry>) {
        self.files = entries;
        if let (Some(root), Some(p)) = (&self.root, &self.path)
            && !files::contains(&self.files, p)
            && p.starts_with(root)
        {
            files::insert(&mut self.files, root, p);
        }
        self.files_gen += 1;
    }

    /// The sidebar's rows, rebuilt only when the notes, the closed folders or the filter changed.
    pub fn tree_rows(&self) -> Rc<Vec<Row>> {
        let Some(root) = &self.root else { return Rc::default() };
        let mut cache = self.rows_cache.borrow_mut();
        if let Some((generation, collapsed, query, rows)) = &*cache
            && *generation == self.files_gen
            && *collapsed == self.collapsed
            && *query == self.filter.text
        {
            return rows.clone();
        }
        let rows = Rc::new(files::rows(&self.files, root, &self.collapsed, &self.filter.text));
        *cache = Some((self.files_gen, self.collapsed.clone(), self.filter.text.clone(), rows.clone()));
        rows
    }

    /// Flush the open note and open `path` (an empty note if it isn't on disk).
    pub fn open_note(&mut self, path: PathBuf, tx: &mut Tx) {
        if self.path.as_deref().is_some_and(|p| same_file(p, &path)) {
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
        if let Some(old) = self.path.clone() {
            let keys = self.ed.fold_keys();
            if keys.is_empty() {
                self.folds.remove(&old);
            } else {
                self.folds.insert(old, keys);
            }
        }
        let kill = self.ed.kill_buffer().to_string();
        self.ed = keys::editor(&text);
        self.ed.set_kill_buffer(&kill);
        if let Some(keys) = self.folds.get(&path) {
            self.ed.set_fold_keys(keys);
        }
        self.fold_hover = None;
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
        tx.scroll_to("scroll", 0.0);
        self.path = Some(path);
    }

    /// `Untitled.md` (or `Untitled 2.md`…) in the folder clicked last or the root, opened with
    /// the caret at the start.
    pub fn new_note(&mut self, tx: &mut Tx) {
        let Some(root) = self.root.clone() else { return };
        // A folder emptied of notes has no row any more, but new notes still go there.
        let dir = self
            .new_dir
            .clone()
            .filter(|d| d.starts_with(&root) && (d.is_dir() || files::contains(&self.files, d)))
            .unwrap_or_else(|| root.clone());
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
        self.filter.clear();
        self.blur_filter();
        self.open_note(path, tx);
    }

    /// A rescan from the refresh thread found a change: new rows, and the open note may reload.
    pub fn refreshed(&mut self, files: Vec<Entry>, tx: &mut Tx) {
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
        layout::build(self.ed.text(), &self.ed.render_lines(), self.path.as_deref().and_then(Path::parent))
    }

    /// After every handled event: show the caret, skip animation, queue an autosave.
    pub fn handled(&mut self, tx: &mut Tx) -> bool {
        self.blink.set(1.0);
        tx.instant();
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

fn setup(app: &mut App, _wake: Waker) {
    if app.headless {
        return;
    }
    // Live values repaint the caret without rebuilding the view.
    let blink = app.blink.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(530));
            blink.set(if blink.get() > 0.5 { 0.0 } else { 1.0 });
        }
    });
}

fn find_text(app: &App, needle: &str) -> usize {
    app.ed.text().find(needle).unwrap_or(0)
}

type Scene = (&'static str, fn(&mut App));

const SCENES: &[Scene] = &[
    ("default", |_| {}),
    ("empty", |app| app.ed = keys::editor("")),
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
];

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
    let arg_path = rune::extra_args().iter().find(|a| !a.starts_with("--")).map(PathBuf::from);
    let use_sample = rune::extra_args().iter().any(|a| a == "--sample");

    let (root, path, text, entries, fingerprint) = if use_sample || (headless && arg_path.is_none()) {
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
    let fonts: &'static [&'static [u8]] = Box::leak(list.into_boxed_slice());
    let mono = if menlo.is_some() { "Menlo" } else { "Inter" };
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
        on_ime: Some(input::on_ime),
        // The page takes drops itself (El::on_file_drop on the surface).
        on_file_drop: None,
    };
    let watch = root.clone().filter(|_| !headless);
    let recheck: Arc<AtomicBool> = Arc::default();
    let app_recheck = recheck.clone();
    let app = rune::App::new(spec)
        .init(move || {
            let mut app = App::new(&text, path, headless).with_root(root, entries);
            app.recheck = app_recheck;
            app
        })
        .on_close(|app, _tx| app.save_now());
    if let Some(root) = watch {
        // Notes created, renamed or edited outside show up within a couple of seconds.
        let handle = app.handle();
        std::thread::spawn(move || {
            let mut last = fingerprint;
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let (entries, fp) = files::scan(&root);
                if fp != last {
                    last = fp;
                    recheck.store(false, Ordering::SeqCst);
                    handle.update(move |app, tx| app.refreshed(entries, tx));
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

        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("Untitled.md")));
        assert!(dir.join("Untitled.md").exists());
        assert!(files::contains(&app.files, &dir.join("Untitled.md")), "in the tree without a rescan");
        app.new_dir = Some(dir.join("sub"));
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("sub/Untitled.md")));
        app.new_dir = None;
        app.new_note(&mut tx);
        assert_eq!(app.path, Some(dir.join("Untitled 2.md")));
        assert_eq!(app.ed.selection(), Sel::caret(0));
        let _ = std::fs::remove_dir_all(&dir);
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
        app.new_dir = Some(dir.join("sub"));
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
    fn the_filter_and_the_editor_never_share_a_composition() {
        let mut app = App::new("one", Some(PathBuf::from("/nonexistent/a.md")), true).with_root(Some(PathBuf::from("/nonexistent")), Vec::new());
        let mut tx = Tx::default();
        app.marked = Some(("´".into(), 2));
        app.focus_filter();
        assert_eq!(app.marked, None);
        app.filter.preedit = Some(("に".into(), None));
        app.filter_escape();
        assert!(!app.filter.focused);
        assert_eq!(app.filter.preedit, None);
        // Focused by a click (Rune sets it): the first IME event for the filter drops the editor's.
        app.marked = Some(("´".into(), 2));
        app.filter.focused = true;
        assert!(!input::on_ime(&mut app, &rune::Ime::Preedit("か".into(), None), &mut tx));
        assert_eq!(app.marked, None);
    }

    #[test]
    fn the_filter_is_one_line() {
        let mut app = App::new("", None, true);
        app.filter.paste("a\nb");
        assert_eq!(app.filter.text, "a b");
    }
}
