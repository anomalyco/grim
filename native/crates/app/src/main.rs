//! Grimoire: a Bear-like live-preview Markdown editor on Rune.
//!
//! `editor-core` owns the text, selection and every editing rule. This crate draws its
//! `render_lines()` with Rune (`render`), measures the same text with Parley for carets, hits
//! and selections (`layout`), turns Rune keys and drags into editor calls (`input`) and keeps the
//! note on disk (`doc`).
//!
//! `grimoire [path.md]` opens (or creates) a note; without one it opens
//! `~/Documents/Grimoire/Untitled.md`. Headless tooling (`--snap`, `--script`, `--tree`) never
//! touches the disk: it uses the given file read-only, or the built-in sample.

mod doc;
mod input;
mod layout;
mod render;
mod theme;

use std::path::PathBuf;
use std::time::Duration;

use editor_core::{Editor, Sel};
use rune::{AppSpec, Live, Tx, Waker};

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

    let (path, text) = if use_sample {
        (None, doc::SAMPLE.to_string())
    } else if headless {
        match &arg_path {
            Some(p) => (Some(p.clone()), std::fs::read_to_string(p).unwrap_or_default()),
            None => (None, doc::SAMPLE.to_string()),
        }
    } else {
        let is_default = arg_path.is_none();
        let p = arg_path.unwrap_or_else(doc::default_path);
        match doc::open(&p, is_default) {
            Ok(t) => (Some(p), t),
            Err(e) => {
                eprintln!("grimoire: {}: {e}", p.display());
                std::process::exit(1);
            }
        }
    };

    let title = match &path {
        Some(p) => format!("{} — Grimoire", p.file_name().map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into_owned())),
        None => "Grimoire".to_string(),
    };

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
    };
    rune::App::new(spec)
        .init(move || App::new(&text, path, headless))
        .on_close(|app, _tx| app.save_now())
        .run();
}
