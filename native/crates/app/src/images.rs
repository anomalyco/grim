//! Where an image's source points: `![alt](src)` → a file to load.
//!
//! Relative sources resolve against the note's folder (what dropping images inserts:
//! `images/name.png`), with `%`-escapes decoded and any `?query` / `#fragment` dropped. Absolute
//! paths, `~/…` and `file://` URLs are files as they are. http(s) and every other scheme aren't
//! loaded (the placeholder shows).
//!
//! Loading: Rune's `ImageCache` decodes on its worker and wakes the app (`init` gives it the
//! waker). It dedups by content, not path, so this keeps a handle per path: a file is `stat`ed at
//! most every 500 ms (every time headless) and read again when its mtime or length changes; until
//! the new contents decode, the previous image stays (no flash, no change of height). Headless runs
//! wait for each decode (`set_sync`), so the first frame already has every image. Paths no view has
//! asked for in a few views are dropped, releasing their pixels.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use rune::{Image, ImageCache, Waker};

/// What a file's image is now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImageState {
    Loading,
    Ready { width: u32, height: u32 },
    Failed(String),
}

static WAKER: OnceLock<Waker> = OnceLock::new();

/// Repaint when a decode finishes (from `AppSpec::setup`).
pub fn init(waker: Waker) {
    let _ = WAKER.set(waker);
}

/// Decode inline from now on, on this thread (headless runs and tests).
pub fn set_sync(on: bool) {
    SYNC.set(on);
}

const RECHECK: Duration = Duration::from_millis(500);
/// Views a path may go unasked before its image is dropped.
const KEEP_VIEWS: u64 = 3;

/// mtime and length.
type Stamp = (Option<SystemTime>, u64);

struct Entry {
    stamp: Option<Stamp>,
    checked: Option<Instant>,
    used: u64,
    /// The image shown (`None`: the first load is still decoding, or the file is missing).
    shown: Option<Image>,
    /// A newer version of the file, decoding.
    next: Option<Image>,
    missing: bool,
}

thread_local! {
    static SYNC: Cell<bool> = const { Cell::new(false) };
    static VIEW: Cell<u64> = const { Cell::new(0) };
    static CACHE: RefCell<Option<(ImageCache, HashMap<PathBuf, Entry>)>> = const { RefCell::new(None) };
}

/// Called once per view: paths not asked for in the last few go.
pub fn next_view() {
    let v = VIEW.get() + 1;
    VIEW.set(v);
    CACHE.with_borrow_mut(|c| {
        if let Some((_, entries)) = c {
            entries.retain(|_, e| v.saturating_sub(e.used) <= KEEP_VIEWS);
        }
    });
}

fn stamp(path: &Path) -> Option<Stamp> {
    let m = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    Some((m.modified().ok(), m.len()))
}

/// The state of `path`'s image, starting (or restarting, when the file changed) its load.
pub fn state(path: &Path) -> ImageState {
    with_entry(path, |e| match (&e.shown, e.missing) {
        (_, true) => ImageState::Failed("not found".into()),
        (Some(img), _) => match img.size() {
            Some([width, height]) => ImageState::Ready { width, height },
            None => ImageState::Failed(img.error().map_or_else(|| "failed".into(), |e| e.to_string())),
        },
        (None, _) => ImageState::Loading,
    })
}

/// The decoded image for `path` (what `state` reported `Ready` for).
pub fn ready(path: &Path) -> Option<Image> {
    with_entry(path, |e| e.shown.clone().filter(|i| i.size().is_some() && !e.missing))
}

fn with_entry<T>(path: &Path, f: impl FnOnce(&Entry) -> T) -> T {
    let sync = SYNC.get();
    let view = VIEW.get();
    CACHE.with_borrow_mut(|c| {
        let (cache, entries) = c.get_or_insert_with(|| {
            let wake: Waker = Arc::new(|| {
                if let Some(w) = WAKER.get() {
                    w();
                }
            });
            (ImageCache::new(wake), HashMap::new())
        });
        let now = Instant::now();
        let e = entries.entry(path.to_path_buf()).or_insert_with(|| Entry {
            stamp: None,
            checked: None,
            used: view,
            shown: None,
            next: None,
            missing: false,
        });
        e.used = view;
        if sync || e.checked.is_none_or(|t| now.duration_since(t) >= RECHECK) {
            e.checked = Some(now);
            let st = stamp(path);
            e.missing = st.is_none();
            if st.is_some() && st != e.stamp {
                e.stamp = st;
                match std::fs::read(path) {
                    Ok(bytes) => {
                        let img = cache.load(bytes);
                        if sync {
                            let _ = img.wait();
                        }
                        e.next = Some(img);
                    }
                    Err(_) => e.missing = true,
                }
            }
        }
        if e.next.as_ref().is_some_and(Image::is_ready) {
            e.shown = e.next.take();
        }
        f(e)
    })
}

/// Why a source has no file to load.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unresolved {
    /// http(s): not downloaded.
    Remote,
    /// Empty, another scheme, or relative with no note folder to resolve against.
    Invalid,
}

pub fn resolve(src: &str, note_dir: Option<&Path>) -> Result<PathBuf, Unresolved> {
    let s = src.trim();
    let s = s.strip_prefix('<').and_then(|t| t.strip_suffix('>')).map_or(s, str::trim);
    if s.is_empty() || s.chars().any(|c| c.is_control()) {
        return Err(Unresolved::Invalid);
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || s.starts_with("//") {
        return Err(Unresolved::Remote);
    }
    if lower.starts_with("file://") {
        // file:///abs/path or file://localhost/abs/path
        let rest = &s[7..];
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        if !rest.starts_with('/') {
            return Err(Unresolved::Invalid);
        }
        return file(decode(strip_query(rest)));
    }
    if has_scheme(s) {
        return Err(Unresolved::Invalid);
    }
    let path = decode(strip_query(s));
    if path.is_empty() || path.chars().any(|c| c.is_control()) {
        return Err(Unresolved::Invalid);
    }
    if path.starts_with('/') {
        return Ok(PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return Ok(PathBuf::from(home).join(rest));
    }
    note_dir.map(|d| d.join(&path)).ok_or(Unresolved::Invalid)
}

/// A decoded absolute path; control characters (`%00`, `%0A`, …) aren't file names.
fn file(path: String) -> Result<PathBuf, Unresolved> {
    if path.chars().any(|c| c.is_control()) {
        return Err(Unresolved::Invalid);
    }
    Ok(PathBuf::from(path))
}

/// `scheme:` per RFC 3986 (a letter, then letters, digits, `+`, `-`, `.`).
fn has_scheme(s: &str) -> bool {
    let Some(i) = s.find(':') else { return false };
    let scheme = &s[..i];
    scheme.len() > 1
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

fn strip_query(s: &str) -> &str {
    s.find(['?', '#']).map_or(s, |i| &s[..i])
}

/// Decodes `%XX` escapes; a string that doesn't decode to UTF-8 stays as written.
pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn hex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_sources_resolve_against_the_note_folder_decoded() {
        let dir = Path::new("/notes/day");
        assert_eq!(resolve("images/cat.png", Some(dir)), Ok(PathBuf::from("/notes/day/images/cat.png")));
        assert_eq!(resolve("images/my%20cat%20%281%29.png", Some(dir)), Ok(PathBuf::from("/notes/day/images/my cat (1).png")));
        assert_eq!(resolve(" <../a b.png> ", Some(dir)), Ok(PathBuf::from("/notes/day/../a b.png")));
        assert_eq!(resolve("x.png?raw=1#top", Some(dir)), Ok(PathBuf::from("/notes/day/x.png")));
        assert_eq!(resolve("images/cat.png", None), Err(Unresolved::Invalid));
        // A broken escape stays as written.
        assert_eq!(resolve("100%.png", Some(dir)), Ok(PathBuf::from("/notes/day/100%.png")));
        assert_eq!(resolve("%e9.png", Some(dir)), Ok(PathBuf::from("/notes/day/%e9.png")));
        assert_eq!(resolve("caf%C3%A9.png", Some(dir)), Ok(PathBuf::from("/notes/day/café.png")));
        // `?` and `#` in a file name are escaped (what dropping writes); unescaped they start a
        // query / fragment.
        assert_eq!(resolve("images/what%3F%20%231.png", Some(dir)), Ok(PathBuf::from("/notes/day/images/what? #1.png")));
        assert_eq!(resolve(&crate::drop::encode("a?b#c.png"), Some(dir)), Ok(PathBuf::from("/notes/day/a?b#c.png")));
    }

    #[test]
    fn absolute_paths_and_file_urls() {
        assert_eq!(resolve("/Users/a/b%20c.png", None), Ok(PathBuf::from("/Users/a/b c.png")));
        assert_eq!(resolve("file:///Users/a/b%20c.png", None), Ok(PathBuf::from("/Users/a/b c.png")));
        assert_eq!(resolve("FILE://localhost/tmp/x.png", None), Ok(PathBuf::from("/tmp/x.png")));
        assert_eq!(resolve("file://server/x.png", None), Err(Unresolved::Invalid));
    }

    #[test]
    fn remote_and_other_schemes_dont_load() {
        assert_eq!(resolve("https://e.com/a.png", None), Err(Unresolved::Remote));
        assert_eq!(resolve("//e.com/a.png", None), Err(Unresolved::Remote));
        for s in ["javascript:alert(1)", "data:image/png;base64,AA", "", "  ", "a\u{0}.png", "a%00.png", "file:///a%0Ab.png", "/x/%1F.png"] {
            assert_eq!(resolve(s, Some(Path::new("/n"))), Err(Unresolved::Invalid), "{s:?}");
        }
    }
}
