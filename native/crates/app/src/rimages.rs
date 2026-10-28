//! Images that come over the network: a remote note's own files (`GET /api/repos/:id/raw?path=`, sources
//! resolved like the web's `repoImagePath`: relative to the note's folder, or to the folder's root with a
//! leading `/`) and http(s) URLs (the web's `directImageUrl`), in remote and local notes alike.
//!
//! `source` says where an image's source points; `fetch` gives what a URL's download is now. Downloads run on
//! threads (at most `MAX_RUNNING` at once) and land in a cache folder (`~/Library/Caches/Grimoire/images`,
//! one file per URL), so the rest is `images.rs`'s: the file is decoded, shown and swapped when it changes.
//! A copy from an earlier launch shows at once and is checked again; a shown image is checked again after
//! `FRESH` (the server's `max-age`), a failed one retried after `RETRY`, and only while some view asks for it.
//! A failed check keeps the copy shown, unless the server says it's gone (404). Repository images send the
//! account's token (folders are public, so none is needed); other hosts get none.
//!
//! The network is off until `set_net` (the app; headless runs and tests stay offline): then http(s) sources
//! show the "Remote image" placeholder as before. Tests install a `Fake` that answers in place.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::images::{self, Unresolved};
use crate::net;

/// What image sources resolve against.
#[derive(Clone, Copy, Debug)]
pub enum Base<'a> {
    /// A local note's folder (none: the built-in sample).
    Local(Option<&'a Path>),
    /// A remote note: its server, folder id, path in the folder, and the account's token.
    Remote { server: &'a str, id: &'a str, note: &'a str, token: Option<&'a str> },
}

/// Where an image's source points.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    File(PathBuf),
    /// Downloaded (with the token for the folder's own files).
    Url { url: String, token: Option<String> },
    /// An http(s) image while the network is off.
    Offline,
    /// Empty, another scheme, a path leaving the folder.
    Invalid,
}

/// What a download is now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fetched {
    Loading,
    /// The downloaded file.
    Ready(PathBuf),
    /// Why it can't show; `missing`: the server says there's no such file.
    Failed { missing: bool, why: String },
}

/// Answers a GET for a URL in place: the status and body, or a network error (tests, headless demos).
pub type Fake = Rc<dyn Fn(&str) -> Result<(u16, Vec<u8>), String>>;

const MAX_RUNNING: usize = 6;
const FRESH: Duration = Duration::from_secs(60);
const RETRY: Duration = Duration::from_secs(15);
/// Cached copies untouched this long go at launch.
const KEEP_FILES: Duration = Duration::from_secs(30 * 24 * 3600);

static NET: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicUsize = AtomicUsize::new(0);
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Finished downloads (url, answer), for the UI thread to pick up.
static DONE: Mutex<Vec<(String, Answer)>> = Mutex::new(Vec::new());

/// A GET's status and body, or why it couldn't be made.
type Answer = Result<(u16, Vec<u8>), String>;

struct Entry {
    state: Fetched,
    /// When the last answer came (`None`: never asked yet this launch).
    at: Option<Instant>,
    busy: bool,
}

thread_local! {
    static ENTRIES: RefCell<HashMap<String, Entry>> = RefCell::new(HashMap::new());
    static FAKE: RefCell<Option<Fake>> = const { RefCell::new(None) };
}

/// Downloads go over the network from now on (the app, not headless runs); old cached copies are cleaned up.
pub fn set_net() {
    NET.store(true, Ordering::SeqCst);
    let dir = cache_dir();
    std::thread::spawn(move || {
        let Ok(rd) = std::fs::read_dir(&dir) else { return };
        let now = SystemTime::now();
        for e in rd.flatten() {
            let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| now.duration_since(t).ok()).is_some_and(|d| d > KEEP_FILES);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    });
}

/// Answer downloads in place on this thread (`None`: back to the network, when it's on).
pub fn set_fake(f: Option<Fake>) {
    FAKE.set(f);
    ENTRIES.with_borrow_mut(HashMap::clear);
}

fn enabled() -> bool {
    NET.load(Ordering::SeqCst) || FAKE.with_borrow(Option::is_some)
}

fn cache_dir() -> PathBuf {
    CACHE_DIR
        .get_or_init(|| match std::env::var_os("HOME") {
            Some(home) if NET.load(Ordering::SeqCst) => PathBuf::from(home).join("Library/Caches/Grimoire/images"),
            _ => std::env::temp_dir().join(format!("grimoire-images-{}", std::process::id())),
        })
        .clone()
}

/// The cached copy of `url` (FNV-1a of the URL).
pub fn cache_file(url: &str) -> PathBuf {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in url.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    cache_dir().join(format!("{h:016x}"))
}

/// `GET /api/repos/:id/raw?path=` on `server`: a file of the folder.
pub fn raw_url(server: &str, id: &str, path: &str) -> String {
    format!("{}/api/repos/{}/raw?path={}", server.trim_end_matches('/'), net::enc(id), net::enc(path))
}

/// Where `src` (as written in the Markdown) points from `base`.
pub fn source(src: &str, base: Base) -> Source {
    match base {
        Base::Local(dir) => match images::resolve(src, dir) {
            Ok(p) => Source::File(p),
            Err(Unresolved::Remote) => match direct_url(src) {
                Some(Some(url)) if enabled() => Source::Url { url, token: None },
                Some(Some(_)) => Source::Offline,
                _ => Source::Invalid,
            },
            Err(Unresolved::Invalid) => Source::Invalid,
        },
        Base::Remote { server, id, note, token } => match direct_url(src) {
            Some(Some(_)) | None if !enabled() => Source::Offline,
            Some(Some(url)) => Source::Url { url, token: None },
            Some(None) => Source::Invalid,
            None => match repo_image_path(src, note) {
                Some(p) => Source::Url { url: raw_url(server, id, &p), token: token.map(str::to_string) },
                None => Source::Invalid,
            },
        },
    }
}

/// The source as written, without surrounding spaces or `<angle brackets>`.
fn clean(src: &str) -> &str {
    let s = src.trim();
    s.strip_prefix('<').and_then(|t| t.strip_suffix('>')).map_or(s, str::trim)
}

/// A URL that loads as is: http(s), or protocol-relative as https (`Some(Some(url))`); another scheme or a bad
/// URL (`Some(None)`); a relative path (`None`). As the web's `directImageUrl`, without `data:` images.
pub fn direct_url(src: &str) -> Option<Option<String>> {
    let s = clean(src);
    if s.is_empty() || s.chars().any(char::is_control) {
        return Some(None);
    }
    let abs = if let Some(rest) = s.strip_prefix("//") {
        format!("https://{rest}")
    } else if has_scheme(s) {
        s.to_string()
    } else {
        return None;
    };
    let lower = abs.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || net::parse_url(&abs).is_err() {
        return Some(None);
    }
    Some(Some(abs.split('#').next().unwrap_or_default().replace(' ', "%20")))
}

fn has_scheme(s: &str) -> bool {
    let Some(i) = s.find(':') else { return false };
    let sc = &s[..i];
    sc.starts_with(|c: char| c.is_ascii_alphabetic()) && sc.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// A relative source as a path in the folder (the web's `repoImagePath`): relative to the note's folder, or
/// to the root with a leading `/`; `?query` and `#fragment` dropped, `%`-escapes decoded. `None` if it leaves
/// the folder.
pub fn repo_image_path(src: &str, note: &str) -> Option<String> {
    let s = clean(src);
    let s = s.find(['?', '#']).map_or(s, |i| &s[..i]);
    let s = images::decode(s);
    if s.is_empty() || s.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    let mut parts: Vec<&str> = if s.starts_with('/') { Vec::new() } else { note.split('/').collect::<Vec<_>>() };
    if !s.starts_with('/') {
        parts.pop();
    }
    for seg in s.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            seg => parts.push(seg),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// What `url`'s download is now, starting it (or checking it again) when it's due.
pub fn fetch(url: &str, token: Option<&str>) -> Fetched {
    drain();
    let fake = FAKE.with_borrow(Clone::clone);
    let start = ENTRIES.with_borrow_mut(|map| {
        let e = map.entry(url.to_string()).or_insert_with(|| {
            // a copy from an earlier launch shows at once (and is checked again)
            let file = cache_file(url);
            let state = if fake.is_none() && file.is_file() { Fetched::Ready(file) } else { Fetched::Loading };
            Entry { state, at: None, busy: false }
        });
        let due = !e.busy
            && match (&e.state, e.at) {
                (_, None) => true,
                (Fetched::Ready(_), Some(t)) => t.elapsed() >= FRESH,
                (Fetched::Failed { .. }, Some(t)) => t.elapsed() >= RETRY,
                (Fetched::Loading, Some(_)) => true,
            };
        if due && (fake.is_some() || RUNNING.load(Ordering::SeqCst) < MAX_RUNNING) {
            e.busy = true;
            true
        } else {
            false
        }
    });
    if start {
        match fake {
            Some(f) => {
                let r = f(url);
                settle(url, r);
            }
            None => {
                RUNNING.fetch_add(1, Ordering::SeqCst);
                let (url, token) = (url.to_string(), token.map(str::to_string));
                std::thread::spawn(move || {
                    let r = get(&url, token.as_deref());
                    DONE.lock().unwrap_or_else(|e| e.into_inner()).push((url, r));
                    RUNNING.fetch_sub(1, Ordering::SeqCst);
                    images::wake();
                });
            }
        }
    }
    ENTRIES.with_borrow(|map| map.get(url).map_or(Fetched::Loading, |e| e.state.clone()))
}

/// Picks up finished downloads.
fn drain() {
    let done = std::mem::take(&mut *DONE.lock().unwrap_or_else(|e| e.into_inner()));
    for (url, r) in done {
        settle(&url, r);
    }
}

/// A GET following up to 5 redirects; the token only goes to the URL's own origin.
fn get(url: &str, token: Option<&str>) -> Result<(u16, Vec<u8>), String> {
    let origin = net::parse_url(url)?.origin();
    let mut url = url.to_string();
    for _ in 0..5 {
        let auth = token.filter(|_| net::parse_url(&url).is_ok_and(|u| u.origin() == origin)).map(|t| format!("Bearer {t}"));
        let mut headers = vec![("Accept", "image/*")];
        if let Some(a) = &auth {
            headers.push(("Authorization", a.as_str()));
        }
        let (status, h, body) = net::raw("GET", &url, &headers, None)?;
        let location = h.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone());
        match (status, location) {
            (301 | 302 | 303 | 307 | 308, Some(to)) => {
                url = if to.starts_with("http://") || to.starts_with("https://") {
                    to
                } else if to.starts_with('/') {
                    format!("{}{to}", net::parse_url(&url)?.origin())
                } else {
                    return Err(format!("bad redirect to {to}"));
                };
            }
            (status, _) => return Ok((status, body)),
        }
    }
    Err("too many redirects".into())
}

/// A download's answer: the file written (only when it changed), or why it failed.
fn settle(url: &str, r: Result<(u16, Vec<u8>), String>) {
    let file = cache_file(url);
    let state = match r {
        Ok((200..=299, body)) if !body.is_empty() => match write(&file, &body) {
            Ok(()) => Fetched::Ready(file),
            Err(e) => Fetched::Failed { missing: false, why: e.to_string() },
        },
        Ok((404 | 410, _)) => {
            let _ = std::fs::remove_file(&file);
            Fetched::Failed { missing: true, why: "not found".into() }
        }
        Ok((status, _)) => Fetched::Failed { missing: false, why: format!("HTTP {status}") },
        Err(e) => Fetched::Failed { missing: false, why: e },
    };
    ENTRIES.with_borrow_mut(|map| {
        let Some(e) = map.get_mut(url) else { return };
        e.busy = false;
        e.at = Some(Instant::now());
        // a check that couldn't get through keeps the copy shown
        let keep = matches!(e.state, Fetched::Ready(_)) && matches!(state, Fetched::Failed { missing: false, .. });
        if !keep {
            e.state = state;
        }
    });
}

/// Writes `bytes` to `file` unless it holds them already (then only its time is touched, so it isn't
/// cleaned up), through a temporary file so a decode never reads half of it.
fn write(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if std::fs::read(file).is_ok_and(|old| old == bytes) {
        if let Ok(f) = std::fs::File::options().append(true).open(file) {
            let _ = f.set_modified(SystemTime::now());
        }
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_paths_resolve_like_the_web() {
        let p = |s: &str| repo_image_path(s, "trips/2026/plan.md");
        assert_eq!(p("images/cat.png").as_deref(), Some("trips/2026/images/cat.png"));
        assert_eq!(p("./a%20b.png?raw=1#x").as_deref(), Some("trips/2026/a b.png"));
        assert_eq!(p("../shared/logo.svg").as_deref(), Some("trips/shared/logo.svg"));
        assert_eq!(p("/assets/x.png").as_deref(), Some("assets/x.png"));
        assert_eq!(p(" <images/my cat.png> ").as_deref(), Some("trips/2026/images/my cat.png"));
        assert_eq!(p("../../../x.png"), None, "leaves the folder");
        assert_eq!(p("a\\b.png"), None);
        assert_eq!(p(""), None);
        assert_eq!(repo_image_path("cat.png", "Top.md").as_deref(), Some("cat.png"));
        assert_eq!(repo_image_path("..", "Top.md"), None);
    }

    #[test]
    fn direct_urls() {
        assert_eq!(direct_url("https://e.com/a b.png#x"), Some(Some("https://e.com/a%20b.png".into())));
        assert_eq!(direct_url("//e.com/a.png"), Some(Some("https://e.com/a.png".into())));
        assert_eq!(direct_url("HTTP://e.com/a.png"), Some(Some("HTTP://e.com/a.png".into())));
        for s in ["javascript:alert(1)", "data:image/png;base64,AA", "file:///a.png", "", "a\u{1}.png"] {
            assert_eq!(direct_url(s), Some(None), "{s:?}");
        }
        assert_eq!(direct_url("images/a.png"), None);
        assert_eq!(direct_url("/a.png"), None);
    }

    #[test]
    fn sources_from_remote_and_local_notes() {
        set_fake(None);
        let remote = Base::Remote { server: "https://g.example", id: "team", note: "dir/n.md", token: Some("tok") };
        assert_eq!(source("images/a.png", remote), Source::Offline, "no network, no fake");
        set_fake(Some(Rc::new(|_: &str| Err("offline".to_string()))));
        assert_eq!(
            source("images/a b.png", remote),
            Source::Url { url: "https://g.example/api/repos/team/raw?path=dir%2Fimages%2Fa%20b.png".into(), token: Some("tok".into()) }
        );
        assert_eq!(source("https://e.com/x.png", remote), Source::Url { url: "https://e.com/x.png".into(), token: None });
        assert_eq!(source("../../x.png", remote), Source::Invalid);
        assert_eq!(source("https://e.com/x.png", Base::Local(Some(Path::new("/n")))), Source::Url { url: "https://e.com/x.png".into(), token: None });
        assert_eq!(source("x.png", Base::Local(Some(Path::new("/n")))), Source::File(PathBuf::from("/n/x.png")));
        set_fake(None);
        assert_eq!(source("https://e.com/x.png", Base::Local(None)), Source::Offline);
    }

    #[test]
    fn downloads_send_the_token_only_to_the_folders_server() {
        let (base, rx) = crate::net::tests::mock_server(vec![(200, "PNG".into()), (200, "GIF".into())]);
        assert_eq!(get(&format!("{base}/api/repos/team/raw?path=a.png"), Some("tok")), Ok((200, b"PNG".to_vec())));
        let req = rx.recv().unwrap();
        assert!(req.starts_with("GET /api/repos/team/raw?path=a.png HTTP/1.1") && req.contains("Accept: image/*") && req.contains("Authorization: Bearer tok"), "{req}");
        assert_eq!(get(&format!("{base}/b.gif"), None), Ok((200, b"GIF".to_vec())));
        assert!(!rx.recv().unwrap().contains("Authorization"));
    }

    #[test]
    fn downloads_are_cached_checked_again_and_kept_through_failures() {
        let answers: Rc<RefCell<Vec<Answer>>> = Rc::default();
        let asked = Rc::new(RefCell::new(0));
        let (a, n) = (answers.clone(), asked.clone());
        set_fake(Some(Rc::new(move |_: &str| {
            *n.borrow_mut() += 1;
            a.borrow_mut().remove(0)
        })));
        let url = "https://cache.test/api/repos/r/raw?path=a.png";
        answers.borrow_mut().push(Ok((200, b"one".to_vec())));
        let Fetched::Ready(file) = fetch(url, None) else { panic!("ready") };
        assert_eq!(std::fs::read(&file).unwrap(), b"one");
        assert_eq!(fetch(url, None), Fetched::Ready(file.clone()), "fresh: not asked again");
        assert_eq!(*asked.borrow(), 1);
        // due again: a failed check keeps the copy, a new version replaces it, a 404 removes it
        let age = |by: Duration| ENTRIES.with_borrow_mut(|m| m.get_mut(url).unwrap().at = Some(Instant::now() - by));
        age(FRESH);
        answers.borrow_mut().push(Err("offline".into()));
        assert_eq!(fetch(url, None), Fetched::Ready(file.clone()));
        age(FRESH);
        answers.borrow_mut().push(Ok((200, b"two".to_vec())));
        assert_eq!(fetch(url, None), Fetched::Ready(file.clone()));
        assert_eq!(std::fs::read(&file).unwrap(), b"two");
        age(FRESH);
        answers.borrow_mut().push(Ok((404, Vec::new())));
        assert_eq!(fetch(url, None), Fetched::Failed { missing: true, why: "not found".into() });
        assert!(!file.exists());
        // failures are retried after a while, not on every view
        assert!(matches!(fetch(url, None), Fetched::Failed { .. }));
        assert_eq!(*asked.borrow(), 4);
        age(RETRY);
        answers.borrow_mut().push(Ok((500, Vec::new())));
        assert_eq!(fetch(url, None), Fetched::Failed { missing: false, why: "HTTP 500".into() });
        set_fake(None);
    }
}
