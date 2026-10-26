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
mod input;
mod layout;
mod render;
mod sidebar;
mod theme;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use editor_core::{Editor, Sel};
use rune::{AppSpec, Live, TextEdit, Tx, Waker};

use crate::files::Entry;

use crate::layout::{FONTS, Fonts, Geo};

pub struct App {
    pub ed: Editor,
    pub path: Option<PathBuf>,
    pub blink: Live<f32>,
    saver: Option<doc::Saver>,
    /// The text the saver last received.
    sent: String,
    pub headless: bool,
    /// IME marked text and the IME caret (a byte offset in it), while composing.
    pub marked: Option<(String, usize)>,
    /// When the text last changed (an external change only reloads a note left alone).
    last_edit: Instant,
    /// The notes folder; `None` for the built-in sample (no sidebar).
    pub root: Option<PathBuf>,
    pub files: Vec<Entry>,
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
}

impl App {
    fn new(text: &str, path: Option<PathBuf>, headless: bool) -> App {
        let saver = path.clone().filter(|_| !headless).map(doc::Saver::spawn);
        App {
            ed: Editor::new(text),
            path,
            blink: Live::new(1.0),
            saver,
            sent: text.to_string(),
            headless,
            marked: None,
            last_edit: Instant::now(),
            root: None,
            files: Vec::new(),
            collapsed: HashSet::new(),
            filter: TextEdit::new(""),
            sidebar: None,
            new_dir: None,
            drop_at: None,
        }
    }

    fn with_root(mut self, root: Option<PathBuf>) -> App {
        if let Some(r) = &root {
            self.files = files::scan(r).0;
            if let Some(p) = &self.path
                && !files::contains(&self.files, p)
                && p.starts_with(r)
            {
                files::insert(&mut self.files, r, p);
            }
        }
        self.root = root;
        self
    }

    /// Flush the open note and open `path` (an empty note if it isn't on disk).
    pub fn open_note(&mut self, path: PathBuf, tx: &mut Tx) {
        if self.path.as_ref() == Some(&path) {
            return;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t.replace("\r\n", "\n"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                eprintln!("grimoire: {}: {e}", path.display());
                return;
            }
        };
        self.save_now();
        self.ed = Editor::new(&text);
        self.sent = text;
        self.marked = None;
        self.drop_at = None;
        self.saver = (!self.headless).then(|| doc::Saver::spawn(path.clone()));
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
        let dir = self.new_dir.clone().filter(|d| d.starts_with(&root) && files::contains(&self.files, d)).unwrap_or_else(|| root.clone());
        let path = files::untitled(&dir, |p| p.exists() || files::contains(&self.files, p));
        if self.headless {
            files::insert(&mut self.files, &root, &path);
        } else {
            if let Err(e) = doc::write(&path, "") {
                eprintln!("grimoire: {}: {e}", path.display());
                return;
            }
            self.files = files::scan(&root).0;
        }
        self.filter.clear();
        self.filter.focused = false;
        self.open_note(path, tx);
    }

    /// A rescan from the refresh thread found a change: new rows, and the open note reloads if it
    /// changed on disk while the editor had nothing unsaved.
    pub fn refreshed(&mut self, files: Vec<Entry>, tx: &mut Tx) {
        self.files = files;
        if let (Some(root), Some(p)) = (&self.root, &self.path)
            && !files::contains(&self.files, p)
            && p.starts_with(root)
        {
            // Not written yet (or deleted outside): keep its row while it's open.
            files::insert(&mut self.files, root, p);
        }
        let Some(p) = &self.path else { return };
        if self.ed.text() != self.sent || self.last_edit.elapsed() < Duration::from_secs(3) {
            return;
        }
        if let Ok(disk) = std::fs::read_to_string(p) {
            let disk = disk.replace("\r\n", "\n");
            if disk != self.sent {
                self.ed.set_text(&disk);
                self.sent = disk;
                tx.instant();
            }
        }
    }

    /// Geometry of the current render (what is on screen after the last view).
    pub fn geometry(&self) -> Geo {
        layout::build(self.ed.text(), &self.ed.render_lines())
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
        }
    }
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
    ("empty", |app| app.ed = Editor::new("")),
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
    #[cfg(target_os = "macos")]
    if !headless {
        disable_press_and_hold();
    }
    let arg_path = rune::extra_args().iter().find(|a| !a.starts_with("--")).map(PathBuf::from);
    let use_sample = rune::extra_args().iter().any(|a| a == "--sample");

    let (root, path, text) = if use_sample || (headless && arg_path.is_none()) {
        (None, None, doc::SAMPLE.to_string())
    } else {
        match doc::locate(arg_path, headless) {
            Ok((root, path)) => {
                let text = match &path {
                    Some(p) if headless => std::fs::read_to_string(p).unwrap_or_default().replace("\r\n", "\n"),
                    Some(p) => doc::open(p).unwrap_or_else(|e| {
                        eprintln!("grimoire: {}: {e}", p.display());
                        std::process::exit(1);
                    }),
                    None => String::new(),
                };
                (Some(root), path, text)
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
    let app = rune::App::new(spec)
        .init(move || App::new(&text, path, headless).with_root(root))
        .on_close(|app, _tx| app.save_now());
    if let Some(root) = watch {
        // Notes created, renamed or edited outside show up within a couple of seconds.
        let handle = app.handle();
        std::thread::spawn(move || {
            let mut last = files::scan(&root).1;
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let (entries, fp) = files::scan(&root);
                if fp != last {
                    last = fp;
                    handle.update(move |app, tx| app.refreshed(entries, tx));
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

    #[test]
    fn switching_notes_saves_the_old_one_and_new_notes_get_free_names() {
        let dir = temp_dir("switch");
        let (a, b) = (dir.join("a.md"), dir.join("sub/b.md"));
        doc::write(&a, "one").unwrap();
        doc::write(&b, "two").unwrap();
        let mut app = App::new("one", Some(a.clone()), false).with_root(Some(dir.clone()));
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
    fn an_outside_change_reloads_only_a_note_left_alone() {
        let dir = temp_dir("reload");
        let a = dir.join("a.md");
        doc::write(&a, "one").unwrap();
        let mut app = App::new("one", Some(a.clone()), false).with_root(Some(dir.clone()));
        let mut tx = Tx::default();
        app.ed.insert_text("x");
        app.handled(&mut tx);
        doc::write(&a, "from outside").unwrap();
        app.refreshed(files::scan(&dir).0, &mut tx);
        assert_eq!(app.ed.text(), "xone", "just edited: kept");
        app.last_edit = Instant::now() - Duration::from_secs(10);
        app.saver = None;
        app.refreshed(files::scan(&dir).0, &mut tx);
        assert_eq!(app.ed.text(), "from outside");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
