//! Where an image's source points: `![alt](src)` → a file to load.
//!
//! Relative sources resolve against the note's folder (what dropping images inserts:
//! `images/name.png`), with `%`-escapes decoded and any `?query` / `#fragment` dropped. Absolute
//! paths, `~/…` and `file://` URLs are files as they are. http(s) and every other scheme aren't
//! loaded (the placeholder shows).

use std::path::{Path, PathBuf};

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
