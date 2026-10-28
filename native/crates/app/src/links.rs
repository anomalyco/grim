//! Where a link goes when it's clicked (`resolve`), and following it (`App::follow_link`).
//!
//! - `http:`, `https:`, `mailto:` open with the default macOS handler (`/usr/bin/open <url>`, the
//!   URL one argument, no shell). Every other scheme (`javascript:`, `data:`, `file:`, …) does
//!   nothing.
//! - `#heading`: the heading of this note with that GitHub-style slug.
//! - Anything else is a path: relative to the note's folder, or to the notes folder with a leading
//!   `/`; `%`-escapes decoded, `?query` dropped, `#fragment` kept for the note it opens; `plan` is
//!   tried as `plan.md` too. A Markdown note inside the notes folder opens in the app (like a press
//!   in the sidebar), another existing file with its default app, a missing one says "No note at
//!   …"; paths leaving the notes folder do nothing.

use std::path::{Component, Path, PathBuf};

use editor_core::{BlockType, SegKind, Sel};
use rune::Tx;

use crate::App;
use crate::images::decode;
use crate::theme::*;

/// What a toast's button does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToastAction {
    /// "Create it": the missing note a link points to (relative to the folder).
    Create(String),
}

impl ToastAction {
    pub fn label(&self) -> &'static str {
        match self {
            ToastAction::Create(_) => "Create it",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// Opened in the browser / mail app (normalized).
    External(String),
    /// A heading of the open note, by slug (decoded).
    Heading(String),
    /// A note inside the notes folder, and the heading to go to.
    Note { path: PathBuf, fragment: Option<String> },
    /// Another existing file inside the notes folder: its default app.
    File(PathBuf),
    /// Nothing there: the path relative to the notes folder, for the message.
    Missing(String),
    /// A relative path that climbs out of the notes folder (`../../x.md`), as written: the web's "outside".
    Outside(String),
    /// An unsafe scheme, a path leaving the notes folder, or nothing to resolve against.
    Nothing,
}

/// The link destination as written (`raw`, the URL's source text) from the note at `note`
/// in the notes folder `root`.
#[cfg(test)]
pub fn resolve(raw: &str, note: Option<&Path>, root: Option<&Path>) -> Target {
    resolve_in(raw, note, root, None)
}

/// `resolve` against a list of the folder's files (relative paths) instead of the disk: a remote folder's
/// tree, matched exactly, else ignoring case (the web's `openNoteLink`).
pub fn resolve_in(raw: &str, note: Option<&Path>, root: Option<&Path>, list: Option<&[String]>) -> Target {
    let href = unescape(strip_angle(raw.trim()));
    let href = href.trim();
    if href.is_empty() {
        return Target::Nothing;
    }
    if let Some(frag) = href.strip_prefix('#') {
        return Target::Heading(decode(frag));
    }
    if let Some(scheme) = scheme(href) {
        return match scheme.to_ascii_lowercase().as_str() {
            "http" | "https" | "mailto" => {
                editor_core::url::safe_url(href).map_or(Target::Nothing, |u| Target::External(u.replace(' ', "%20")))
            }
            _ => Target::Nothing,
        };
    }
    if href.starts_with("//") || href.starts_with('\\') {
        return Target::Nothing;
    }
    let (path, fragment) = match href.find('#') {
        Some(i) => (&href[..i], Some(decode(&href[i + 1..])).filter(|f| !f.is_empty())),
        None => (href, None),
    };
    let path = path.find('?').map_or(path, |i| &path[..i]);
    let path = decode(path);
    if path.is_empty() {
        return fragment.map_or(Target::Nothing, Target::Heading);
    }
    if path.chars().any(char::is_control) || path.contains('\\') {
        return Target::Nothing;
    }
    let Some(root) = root else { return Target::Nothing };
    // climbing above the folder's root (the web's `resolveLink`: "outside")
    let mut depth = if path.starts_with('/') { 0 } else { note.and_then(Path::parent).and_then(|d| d.strip_prefix(root).ok()).map_or(0, |r| r.components().count()) };
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." if depth == 0 => return Target::Outside(path.clone()),
            ".." => depth -= 1,
            _ => depth += 1,
        }
    }
    let base = match path.strip_prefix('/') {
        Some(rest) => root.join(rest.trim_start_matches('/')),
        None => match note.and_then(Path::parent) {
            Some(dir) => dir.join(&path),
            None => return Target::Nothing,
        },
    };
    let Some(p) = normalize(&base).filter(|p| p.starts_with(root)) else { return Target::Nothing };
    let with_md = (!is_note(&p)).then(|| {
        let mut s = p.clone().into_os_string();
        s.push(".md");
        PathBuf::from(s)
    });
    let exists = |c: &PathBuf| -> Option<PathBuf> {
        let Some(list) = list else { return c.is_file().then(|| c.clone()) };
        let rel = c.strip_prefix(root).ok()?.to_string_lossy().into_owned();
        let hit = list.iter().find(|f| **f == rel).or_else(|| list.iter().find(|f| f.to_lowercase() == rel.to_lowercase()));
        hit.map(|f| root.join(f))
    };
    let found = [Some(p.clone()), with_md.clone()].into_iter().flatten().find_map(|c| exists(&c));
    let Some(found) = found else {
        let shown = with_md.filter(|_| Path::new(&path).extension().is_none()).unwrap_or(p);
        return Target::Missing(shown.strip_prefix(root).unwrap_or(&shown).display().to_string());
    };
    // through symlinks: still inside the folder
    if list.is_none()
        && let (Ok(cf), Ok(cr)) = (std::fs::canonicalize(&found), std::fs::canonicalize(root))
        && !cf.starts_with(&cr)
    {
        return Target::Nothing;
    }
    if is_note(&found) { Target::Note { path: found, fragment } } else { Target::File(found) }
}

fn strip_angle(s: &str) -> &str {
    s.strip_prefix('<').and_then(|t| t.strip_suffix('>')).map_or(s, str::trim)
}

/// Markdown backslash escapes: `\` before ASCII punctuation stands for it.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match it.peek() {
            Some(&n) if c == '\\' && n.is_ascii_punctuation() => {
                out.push(n);
                it.next();
            }
            _ => out.push(c),
        }
    }
    out
}

/// `scheme:` per RFC 3986 (a letter, then letters, digits, `+`, `-`, `.`).
fn scheme(s: &str) -> Option<&str> {
    let i = s.find(':')?;
    let sc = &s[..i];
    (sc.starts_with(|c: char| c.is_ascii_alphabetic()) && sc.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
        .then_some(sc)
}

/// `.` and `..` resolved lexically (None: above the filesystem root).
fn normalize(p: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    Some(out)
}

fn is_note(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// GitHub's heading anchor: lowercase, punctuation dropped (but `-` and `_`), spaces → `-`.
pub fn slug(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            c if c.is_alphanumeric() || c == '-' || c == '_' => Some(c),
            _ => None,
        })
        .collect()
}

/// The heading whose anchor is `frag` (GitHub's: `-1`, `-2`… for repeats; written as a slug or as
/// the heading's text): its line.
pub fn find_heading(doc: &editor_core::Doc, frag: &str) -> Option<usize> {
    let want = [frag.to_lowercase(), slug(frag)];
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for line in doc.lines.iter().filter(|l| l.ty == BlockType::Heading) {
        let text: String = editor_core::render::line_segments(line, &doc.text)
            .iter()
            .filter(|s| s.kind == SegKind::Text)
            .map(|s| &doc.text[s.from..s.to])
            .collect();
        let base = slug(&text);
        let n = seen.entry(base.clone()).or_insert(0);
        let anchor = if *n == 0 { base.clone() } else { format!("{base}-{n}") };
        *n += 1;
        if want.contains(&anchor) {
            return Some(line.index);
        }
    }
    None
}

impl App {
    /// A click on a link (its source text `raw`): open it, go to the note or heading, or say
    /// there's nothing there.
    pub fn follow_link(&mut self, raw: &str, tx: &mut Tx) {
        // a remote folder's notes are its tree, not files on disk
        let list = self.remote.as_ref().map(|r| r.tree_list.clone());
        match resolve_in(raw, self.path.as_deref(), self.root.as_deref(), list.as_deref()) {
            Target::External(url) => {
                if !self.open_app_link(&url, tx) {
                    self.launch(&url);
                }
            }
            Target::Heading(frag) => self.goto_heading(&frag, tx),
            Target::Note { path, fragment } => {
                // as a press on its sidebar row
                self.close_search();
                self.open_note(path.clone(), tx);
                self.record(format!("note {}", self.rel(&path)));
                if let Some(f) = fragment {
                    self.goto_heading_when_open(f, tx);
                }
            }
            Target::File(path) => match self.remote.as_ref() {
                // another file of a remote folder: the server's copy, in the browser (the web opens it raw)
                Some(r) => {
                    let url = crate::rimages::raw_url(&r.api.server, r.id(), &self.rel(&path));
                    self.launch(&url);
                }
                None => self.launch(&path.to_string_lossy()),
            },
            Target::Missing(rel) => {
                self.record(format!("missing {rel}"));
                let writable = if self.remote.is_some() { self.remote_writable() } else { self.root.is_some() };
                let msg = format!("No note at “{rel}”");
                if writable {
                    self.toast_with(msg, Some(ToastAction::Create(rel)));
                } else {
                    self.show_toast(msg);
                }
            }
            Target::Outside(p) => {
                self.record(format!("outside {p}"));
                self.show_error(format!("“{p}” is outside this notebook."));
            }
            Target::Nothing => self.record(format!("ignored {raw}")),
        }
        self.handled(tx);
    }

    /// A Grimoire app link (`https://<server>/app/<folder>[/<note>][#heading]`, old `/r/…` too) on the open
    /// folder's server (signed in or a guest) or one this app is signed in to opens here, as the web opens same-origin `/app/` links: a note of the open
    /// folder like a relative link (a missing one offers "Create it"), another folder added and opened at
    /// that note (no sign-in: signed in there already, or a guest). False for anything else (the browser opens it).
    pub fn open_app_link(&mut self, url: &str, tx: &mut Tx) -> bool {
        let Ok(u) = crate::workspaces::parse_remote_url(url) else { return false };
        let open_here = self.remote.as_ref().is_some_and(|r| r.api.server == u.server && r.loaded);
        if !open_here && !crate::menu::signed_in(self, &u.server) {
            return false;
        }
        let fragment = url.split_once('#').map(|(_, f)| decode(f)).filter(|f| !f.is_empty());
        self.record(format!("app {url}"));
        let same = self.remote.as_ref().is_some_and(|r| r.api.server == u.server && r.id() == u.id && r.loaded);
        if same {
            match u.note {
                Some(note) => {
                    // as a link from the folder's root
                    let mut link = format!("/{}", note.split('/').map(crate::drop::encode).collect::<Vec<_>>().join("/"));
                    if let Some(f) = fragment {
                        link.push('#');
                        link.push_str(&crate::drop::encode(&f));
                    }
                    self.follow_link(&link, tx);
                }
                None => {
                    if let Some(f) = fragment {
                        self.goto_heading(&f, tx);
                    }
                }
            }
            return true;
        }
        self.close_search();
        self.open_remote(u.server, u.id, String::new(), u.note, tx);
        if let (Some(f), Some(r)) = (fragment, self.remote.as_mut()) {
            r.goto = Some(f);
            if r.synced {
                self.run_goto(tx);
            }
        }
        true
    }

    /// Go to heading `frag` of the note just opened: now, or once its room has synced.
    fn goto_heading_when_open(&mut self, frag: String, tx: &mut Tx) {
        match self.remote.as_mut() {
            Some(r) if !r.synced => r.goto = Some(frag),
            _ => self.goto_heading(&frag, tx),
        }
    }

    /// The heading a link asked for, once the remote note has synced.
    pub fn run_goto(&mut self, tx: &mut Tx) {
        if let Some(f) = self.remote.as_mut().and_then(|r| r.goto.take()) {
            self.goto_heading(&f, tx);
        }
    }

    /// A toast's button.
    pub fn run_action(&mut self, action: ToastAction, tx: &mut Tx) {
        match action {
            ToastAction::Create(rel) => self.create_linked(rel, tx),
        }
    }

    /// "Create it": the missing note a link points to, made with the server's first line (`# <name>`, as the web's
    /// `api.createFile`) and opened; locally the file is written with that line.
    pub fn create_linked(&mut self, rel: String, tx: &mut Tx) {
        let Some(root) = self.root.clone() else { return };
        if let Some(rem) = self.remote.as_ref() {
            if !self.remote_writable() {
                return;
            }
            let session = rem.session;
            match &self.backend {
                crate::remote::Backend::Net(h) => {
                    let (h, api, id) = (h.clone(), rem.api.clone(), rem.id().to_string());
                    std::thread::spawn(move || {
                        let r = api.create_titled(&id, &rel);
                        h.update(move |app, tx| match r {
                            Ok(path) => app.remote_created(session, path, None, Ok(()), tx),
                            Err(crate::remote::ApiError::Other(e)) if e.contains("already exists") => {
                                app.show_error(format!("“{rel}” already exists."));
                                app.handled(tx);
                            }
                            Err(e) => app.remote_created(session, rel, None, Err(e), tx),
                        });
                    });
                }
                crate::remote::Backend::Mock(m) => {
                    {
                        let mut m = m.borrow_mut();
                        m.relays.push((rel.clone(), collab::relay::Relay::new(&format!("# {}\n", crate::files::note_name(Path::new(&rel))))));
                        m.tree.push(rel.clone());
                    }
                    self.remote_created(session, rel, None, Ok(()), tx);
                }
                crate::remote::Backend::None => {}
            }
            return;
        }
        let path = root.join(&rel);
        if !path.exists() && !self.headless {
            let made = path.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| crate::doc::write(&path, &format!("# {}\n", crate::files::note_name(&path))));
            if let Err(e) = made {
                self.show_error(format!("Couldn't create {rel}: {e}"));
                return;
            }
        }
        crate::files::insert(&mut self.files, &root, &path);
        self.files_gen += 1;
        self.close_search();
        self.open_note(path, tx);
    }

    pub(crate) fn goto_heading(&mut self, frag: &str, tx: &mut Tx) {
        let Some(li) = find_heading(self.ed.doc(), frag) else {
            self.record(format!("missing #{frag}"));
            self.show_toast(format!("No heading #{frag}"));
            return;
        };
        self.record(format!("heading #{frag}"));
        let p = self.ed.doc().lines[li].text_from;
        self.ed.set_selection(Sel::caret(p));
        // the heading at the top of the view
        let geo = self.geometry();
        let top = geo.lines.get(li).map_or(0.0, |l| l.top);
        tx.scroll_to_y("scroll", (PAD_T + top - CARET_MARGIN).max(0.0));
    }

    /// `open` an http(s)/mailto URL or a file with its default app; headless runs only record it.
    pub(crate) fn launch(&mut self, what: &str) {
        self.record(format!("open {what}"));
        if self.headless {
            return;
        }
        match std::process::Command::new("/usr/bin/open").arg(what).spawn() {
            // reaped off the main thread
            Ok(mut child) => drop(std::thread::spawn(move || child.wait())),
            Err(e) => eprintln!("grimoire: open {what}: {e}"),
        }
    }

    /// What following a link did (kept for tests and scripts; printed in headless runs).
    fn record(&mut self, action: String) {
        if self.headless {
            eprintln!("grimoire: link: {action}");
        }
        if self.link_log.len() >= 32 {
            self.link_log.remove(0);
        }
        self.link_log.push(action);
    }

    fn rel(&self, p: &Path) -> String {
        self.root.as_deref().and_then(|r| p.strip_prefix(r).ok()).unwrap_or(p).display().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files;
    use editor_core::InlineType;
    use crate::input;
    use crate::layout::{self, FONTS, Fonts, LinkGeo, SCALE};
    use rune::{Mods, Phase};

    fn fixture() -> PathBuf {
        // No fonts: Rune's built-in Inter faces.
        let _ = FONTS.set(Fonts { list: &[], sans: "Inter", mono: "Inter" });
        SCALE.set(2.0);
        layout::set_viewport(PAD_L + MAX_TEXT_W + PAD_R, 800.0);
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/links")
    }

    /// The fixture's Home.md, headless (nothing launched or written).
    fn home() -> App {
        let dir = fixture();
        let note = dir.join("Home.md");
        let text = std::fs::read_to_string(&note).unwrap();
        App::new(&text, Some(note), true).with_root(Some(dir.clone()), files::scan(&dir).0)
    }

    fn link(app: &App, text: &str) -> LinkGeo {
        let at = app.ed.text().find(&format!("[{text}]")).unwrap();
        let reveal = app.ed.reveal();
        app.geometry().links(app.ed.doc(), &reveal).into_iter().find(|g| g.from == at).unwrap()
    }

    /// The middle of a link's text, in surface points.
    fn on_text(app: &App, text: &str) -> (f32, f32) {
        let r = link(app, text).rects[0];
        (PAD_L + r[0] + r[2] / 2.0, PAD_T + r[1] + r[3] / 2.0)
    }

    fn drag(app: &mut App, phase: Phase, (x, y): (f32, f32), start: (f32, f32), clicks: u32, mods: Mods) {
        let g = input::Gesture { phase, x, y, start_x: start.0, start_y: start.1, clicks, mods, primary: true };
        input::surface_gesture(app, &g, &mut Tx::default());
    }

    fn click(app: &mut App, at: (f32, f32), clicks: u32, mods: Mods) {
        drag(app, Phase::Down, at, at, clicks, mods);
        drag(app, Phase::Move, at, at, clicks, mods);
        drag(app, Phase::Up, at, at, clicks, mods);
    }

    fn click_link(app: &mut App, text: &str) {
        let at = on_text(app, text);
        click(app, at, 1, Mods::default());
    }

    fn revealed(app: &App) -> bool {
        app.ed.reveal().values().any(|r| !r.els.is_empty())
    }

    #[test]
    fn a_click_on_link_text_opens_it_and_leaves_the_selection() {
        let mut app = home();
        let at = on_text(&app, "web");
        let before = app.ed.selection();
        drag(&mut app, Phase::Down, at, at, 1, Mods::default());
        assert!(app.link_log.is_empty(), "opens on release");
        drag(&mut app, Phase::Move, (at.0 + 3.0, at.1), at, 1, Mods::default());
        drag(&mut app, Phase::Up, (at.0 + 3.0, at.1), at, 1, Mods::default());
        assert_eq!(app.link_log, vec!["open https://example.com/"]);
        assert_eq!(app.ed.selection(), before);
        assert!(!revealed(&app));
        // mailto inside bold text
        click_link(&mut app, "mail");
        assert_eq!(app.link_log.last().unwrap(), "open mailto:me@example.com");
        assert_eq!(app.ed.selection(), before);
    }

    #[test]
    fn dragging_from_link_text_selects() {
        let mut app = home();
        let at = on_text(&app, "web");
        drag(&mut app, Phase::Down, at, at, 1, Mods::default());
        drag(&mut app, Phase::Move, (at.0 + 40.0, at.1), at, 1, Mods::default());
        drag(&mut app, Phase::Up, (at.0 + 40.0, at.1), at, 1, Mods::default());
        assert!(app.link_log.is_empty());
        let s = app.ed.selection();
        assert!(!s.is_empty());
        let web = app.ed.text().find("[web]").unwrap();
        assert!(s.anchor > web && s.anchor < web + 4, "from the press, in the link text");
    }

    #[test]
    fn shift_click_and_double_click_on_link_text_select_as_usual() {
        let mut app = home();
        app.ed.set_selection(Sel::caret(0));
        let at = on_text(&app, "web");
        click(&mut app, at, 1, Mods { shift: true, ..Mods::default() });
        assert!(app.link_log.is_empty());
        let web = app.ed.text().find("[web]").unwrap();
        let s = app.ed.selection();
        assert_eq!(s.anchor, 0);
        assert!(s.head > web && s.head < web + 5);
        // a double click: the first click opens, the second selects the word
        let mut app = home();
        let at = on_text(&app, "web");
        click(&mut app, at, 1, Mods::default());
        click(&mut app, at, 2, Mods::default());
        assert_eq!(app.link_log.len(), 1);
        assert_eq!(app.ed.selected_text(), Some("web"));
    }

    #[test]
    fn the_pencil_reveals_the_link_and_clicks_in_it_edit() {
        let mut app = home();
        let g = link(&app, "web");
        assert!(g.pencil.is_some());
        input::pencil_press(&mut app, &mut Tx::default(), g.text_end);
        assert_eq!(app.ed.selection(), Sel::caret(app.ed.text().find("web]").unwrap() + 3), "at the end of the link text");
        assert!(revealed(&app));
        let reveal = app.ed.reveal();
        let geo = app.geometry();
        assert!(geo.links(app.ed.doc(), &reveal).iter().all(|l| l.from != g.from), "no pencil, no link hit");
        // the URL is text now: a click on it puts the caret there
        let u = app.ed.text().find("example.com").unwrap() + 3;
        let (x, top, bottom) = geo.caret(u);
        click(&mut app, (PAD_L + x, PAD_T + (top + bottom) / 2.0), 1, Mods::default());
        assert!(app.link_log.is_empty());
        assert_eq!(app.ed.selection(), Sel::caret(u));
        app.ed.insert_text("x");
        assert!(app.ed.text().contains("(https://exaxmple.com)"));
        // the caret leaves: collapsed again, with its pencil; a click follows the new URL
        app.ed.set_selection(Sel::caret(0));
        assert!(link(&app, "web").pencil.is_some());
        click_link(&mut app, "web");
        assert_eq!(app.link_log, vec!["open https://exaxmple.com/"]);
    }

    #[test]
    fn the_caret_walks_through_a_link_without_revealing_it() {
        let mut app = home();
        let web = app.ed.text().find("[web]").unwrap();
        app.ed.set_selection(Sel::caret(web));
        let mut heads = Vec::new();
        for _ in 0..4 {
            app.ed.move_horizontal(1, false, editor_core::HUnit::Char);
            heads.push(app.ed.selection().head);
            assert!(!revealed(&app));
            assert!(link(&app, "web").pencil.is_some());
        }
        let end = app.ed.text()[web..].find(')').unwrap() + web + 1;
        assert_eq!(heads, [web + 2, web + 3, end, end + 1]);
        // with the caret in its text, a click on it still follows it
        app.ed.set_selection(Sel::caret(web + 2));
        click_link(&mut app, "web");
        assert_eq!(app.link_log, vec!["open https://example.com/"]);
        assert_eq!(app.ed.selection(), Sel::caret(web + 2));
    }

    #[test]
    fn relative_links_open_the_note_and_its_heading() {
        let dir = fixture();
        let mut app = home();
        click_link(&mut app, "the plan");
        assert_eq!(app.path.as_deref(), Some(dir.join("plan.md").as_path()));
        assert_eq!(crate::title(app.path.as_deref()), "plan");
        assert!(app.ed.text().starts_with("# The plan"));
        assert_eq!(app.link_log, vec!["note plan.md"]);
        // back, then into sub/deep.md#next-steps
        click_link(&mut app, "home");
        assert_eq!(app.path.as_deref(), Some(dir.join("Home.md").as_path()));
        click_link(&mut app, "deep note");
        assert_eq!(app.path.as_deref(), Some(dir.join("sub/deep.md").as_path()));
        let h = app.ed.text().find("Next steps").unwrap();
        assert_eq!(app.ed.selection(), Sel::caret(h));
        // `./plan` (no extension) from inside bold
        let mut app = home();
        click_link(&mut app, "bold link");
        assert_eq!(app.path.as_deref(), Some(dir.join("plan.md").as_path()));
    }

    #[test]
    fn missing_notes_and_headings_in_this_note() {
        let mut app = home();
        click_link(&mut app, "missing one");
        assert_eq!(app.toast(), Some("No note at “nope.md”"));
        assert_eq!(app.toast_action().cloned(), Some(ToastAction::Create("nope.md".into())), "the web's Create it");
        assert!(app.path.as_deref().unwrap().ends_with("Home.md"), "stays");
        assert!(!dir_has(&fixture(), "nope.md"), "nothing created");
        // a link that climbs out of the folder: the web's error toast, nothing opens
        let mut other = home();
        let mut tx = Tx::default();
        other.follow_link("../../outside.md", &mut tx);
        assert_eq!(other.toast(), Some("“../../outside.md” is outside this notebook."));
        assert!(other.toasts.last().unwrap().error);
        assert!(other.path.as_deref().unwrap().ends_with("Home.md"));
        click_link(&mut app, "below");
        let h = app.ed.text().find("Later on").unwrap();
        assert_eq!(app.ed.selection(), Sel::caret(h));
        assert_eq!(app.link_log.last().unwrap(), "heading #later-on");
        // Create it: the note opens (headless: in memory only), listed in the sidebar
        let mut tx = Tx::default();
        app.run_toast_action(&mut tx);
        assert_eq!(app.path.as_deref(), Some(fixture().join("nope.md").as_path()));
        assert!(files::contains(&app.files, &fixture().join("nope.md")));
        assert!(!dir_has(&fixture(), "nope.md"), "headless runs don't write");
        assert_eq!((app.toast(), app.toast_action()), (None, None));
    }

    #[test]
    fn local_create_it_writes_the_note_with_its_heading() {
        let dir = std::env::temp_dir().join(format!("grimoire-create-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let note = dir.join("Home.md");
        std::fs::write(&note, "[plan](ideas/plan)\n").unwrap();
        let mut app = App::new("[plan](ideas/plan)\n", Some(note), true).with_root(Some(dir.clone()), files::scan(&dir).0);
        app.headless = false;
        app.saver = None;
        let mut tx = Tx::default();
        app.follow_link("ideas/plan", &mut tx);
        assert_eq!(app.toast(), Some("No note at “ideas/plan.md”"));
        app.run_toast_action(&mut tx);
        assert_eq!(std::fs::read_to_string(dir.join("ideas/plan.md")).unwrap(), "# plan\n");
        assert_eq!(app.path.as_deref(), Some(dir.join("ideas/plan.md").as_path()));
        app.headless = true;
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn dir_has(d: &Path, name: &str) -> bool {
        d.join(name).exists()
    }

    #[test]
    fn cmd_enter_opens_the_link_at_the_caret() {
        let mut app = home();
        let p = app.ed.text().find("web]").unwrap() + 1;
        app.ed.set_selection(Sel::caret(p));
        let ev = rune::KeyEvent { key: rune::Key::Enter, mods: Mods { cmd: true, ..Mods::default() } };
        assert!(input::on_key(&mut app, &ev, &mut Tx::default()));
        assert_eq!(app.link_log, vec!["open https://example.com/"]);
        assert_eq!(app.ed.text(), std::fs::read_to_string(fixture().join("Home.md")).unwrap(), "no line break typed");
    }

    #[test]
    fn linked_images_open_their_link() {
        let _ = fixture();
        crate::images::set_sync(true);
        let photos = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/photos");
        let text = "A [![badge](images/my%20badge.png)](https://example.com/b) here.";
        let mut app = App::new(text, Some(photos.join("x.md")), true).with_root(Some(photos.clone()), Vec::new());
        let reveal = app.ed.reveal();
        let g = app.geometry().links(app.ed.doc(), &reveal).into_iter().next().unwrap();
        assert!(g.image && g.pencil.is_none(), "{g:?}");
        let r = g.rects[0];
        click(&mut app, (PAD_L + r[0] + r[2] / 2.0, PAD_T + r[1] + r[3] / 2.0), 1, Mods::default());
        assert_eq!(app.link_log, vec!["open https://example.com/b"]);
        assert_eq!(app.ed.selection(), Sel::caret(0));
        // the caret on the image shows its source, the link stays collapsed and gets its pencil
        app.ed.set_selection(Sel::caret(text.find(".png)").unwrap() + 5));
        let line = &app.ed.doc().lines[0];
        let shown: Vec<_> = app.ed.reveal().get(&0).map_or(Vec::new(), |r| r.els.iter().map(|&k| line.inline[k].ty).collect());
        assert_eq!(shown, [InlineType::Image]);
        let reveal = app.ed.reveal();
        let g = app.geometry().links(app.ed.doc(), &reveal).into_iter().next().unwrap();
        assert!(g.pencil.is_some(), "{g:?}");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("grimoire-links-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("notes/sub")).unwrap();
        let d = std::fs::canonicalize(&d).unwrap();
        for f in ["notes/plan.md", "notes/sub/deep.md", "ideas.md", "my plan.md", "notes/shot.png", "notes/README.markdown"] {
            std::fs::write(d.join(f), "x").unwrap();
        }
        d
    }

    #[test]
    fn schemes() {
        let ext = |s: &str| resolve(s, None, None);
        assert_eq!(ext("https://example.com"), Target::External("https://example.com/".into()));
        assert_eq!(ext("HTTP://Example.com/a?b#c"), Target::External("http://example.com/a?b#c".into()));
        assert_eq!(ext("<https://e.com/a b>"), Target::External("https://e.com/a%20b".into()));
        assert_eq!(ext("mailto:me@example.com"), Target::External("mailto:me@example.com".into()));
        assert_eq!(ext("https://grimoire.exe.xyz/app/notes/x"), Target::External("https://grimoire.exe.xyz/app/notes/x".into()));
        for bad in ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "vbscript:x", "ftp://e.com", "", "  ", "//evil.com/x"] {
            assert_eq!(ext(bad), Target::Nothing, "{bad}");
        }
    }

    #[test]
    fn headings() {
        assert_eq!(resolve("#Plan", None, None), Target::Heading("Plan".into()));
        assert_eq!(resolve("#next%20steps", None, None), Target::Heading("next steps".into()));
        let doc = editor_core::Doc::parse("# Intro\ntext\n## Next **steps**!\n# Intro\n### `code` & more".into());
        assert_eq!(find_heading(&doc, "intro"), Some(0));
        assert_eq!(find_heading(&doc, "next-steps"), Some(2));
        assert_eq!(find_heading(&doc, "Next steps"), Some(2));
        assert_eq!(find_heading(&doc, "intro-1"), Some(3));
        assert_eq!(find_heading(&doc, "code--more"), Some(4));
        assert_eq!(find_heading(&doc, "nope"), None);
        assert_eq!(slug("Hello, World — ok_1"), "hello-world--ok_1");
    }

    #[test]
    fn paths() {
        let d = temp_dir("paths");
        let note = d.join("notes/plan.md");
        let r = |s: &str| resolve(s, Some(&note), Some(&d));
        let n = |p: &str, f: Option<&str>| Target::Note { path: d.join(p), fragment: f.map(String::from) };
        assert_eq!(r("plan.md"), n("notes/plan.md", None));
        assert_eq!(r("./sub/deep.md"), n("notes/sub/deep.md", None));
        assert_eq!(r("sub/deep"), n("notes/sub/deep.md", None));
        assert_eq!(r("../ideas.md"), n("ideas.md", None));
        assert_eq!(r("../ideas"), n("ideas.md", None));
        assert_eq!(r("../my%20plan.md"), n("my plan.md", None));
        assert_eq!(r("<../my plan.md>"), n("my plan.md", None));
        assert_eq!(r("../my\\ plan.md"), Target::Nothing, "a backslash isn't an escape for a space");
        assert_eq!(r("sub/deep.md#Next%20steps"), n("notes/sub/deep.md", Some("Next steps")));
        assert_eq!(r("sub/deep.md?x=1#a"), n("notes/sub/deep.md", Some("a")));
        assert_eq!(r("/ideas.md"), n("ideas.md", None));
        assert_eq!(r("/notes/sub/deep.md"), n("notes/sub/deep.md", None));
        assert_eq!(r("README.markdown"), n("notes/README.markdown", None));
        assert_eq!(r("shot.png"), Target::File(d.join("notes/shot.png")));
        assert_eq!(r("missing.md"), Target::Missing("notes/missing.md".into()));
        assert_eq!(r("missing"), Target::Missing("notes/missing.md".into()));
        assert_eq!(r("gone.png"), Target::Missing("notes/gone.png".into()));
        // leaving the notes folder
        assert_eq!(r("../../x.md"), Target::Outside("../../x.md".into()));
        assert_eq!(r("/../x.md"), Target::Outside("/../x.md".into()));
        assert_eq!(r("..%2F..%2Fx.md"), Target::Outside("../../x.md".into()));
        assert_eq!(r("sub/../../../etc/passwd"), Target::Outside("sub/../../../etc/passwd".into()));
        assert_eq!(r("../ideas.md"), n("ideas.md", None), "up but still inside");
        assert_eq!(r("%00.md"), Target::Nothing);
        // a symlink out of the folder
        let out = temp_dir("outside");
        std::os::unix::fs::symlink(out.join("ideas.md"), d.join("notes/link.md")).unwrap();
        assert_eq!(r("link.md"), Target::Nothing);
        // the sample: no folder to resolve against
        assert_eq!(resolve("plan.md", None, None), Target::Nothing);
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&out);
    }
}
