//! The notes folder: scanning it for Markdown files, the sidebar's rows, the filter and new
//! note names. Scanning only reads directory entries and their metadata, so it's cheap enough to
//! repeat every couple of seconds (`App::refreshed`).

use std::collections::HashSet;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// A note, or a folder holding notes somewhere below it.
#[derive(Clone, Debug)]
pub struct Entry {
    /// File name without the extension, or the folder name.
    pub name: String,
    pub path: PathBuf,
    pub modified: SystemTime,
    /// Size in bytes (notes).
    pub len: u64,
    /// `Some` for folders.
    pub kids: Option<Vec<Entry>>,
}

/// One drawn row of the tree.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub depth: usize,
    pub name: String,
    pub path: PathBuf,
    /// Relative to the root, with `/` separators: the row's key.
    pub rel: String,
    pub dir: bool,
    pub open: bool,
}

const MAX_DEPTH: usize = 16;

pub fn is_note(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

fn skipped(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

/// The tree under `root` (folders first, then by name) and its `fingerprint`.
pub fn scan(root: &Path) -> (Vec<Entry>, u64) {
    let entries = scan_dir(root, 0);
    let fp = fingerprint(&entries);
    (entries, fp)
}

/// A hash of every note's path, size and modification time, in tree order.
pub fn fingerprint(entries: &[Entry]) -> u64 {
    fn walk(entries: &[Entry], h: &mut DefaultHasher) {
        for e in entries {
            match &e.kids {
                Some(k) => walk(k, h),
                None => (&e.path, e.len, e.modified).hash(h),
            }
        }
    }
    let mut h = DefaultHasher::new();
    walk(entries, &mut h);
    h.finish()
}

fn scan_dir(dir: &Path, depth: usize) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if skipped(&name) {
            continue;
        }
        let path = e.path();
        let Ok(kind) = e.file_type() else { continue };
        // Symlinked notes are followed, symlinked folders aren't (no cycles, no notes twice).
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if meta.is_dir() {
            if kind.is_symlink() || depth >= MAX_DEPTH {
                continue;
            }
            let kids = scan_dir(&path, depth + 1);
            if !kids.is_empty() {
                out.push(Entry { name, path, modified, len: 0, kids: Some(kids) });
            }
        } else if is_note(&path) {
            out.push(Entry { name: note_name(&path), path, modified, len: meta.len(), kids: None });
        }
    }
    sort(&mut out);
    out
}

fn sort(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        b.kids.is_some().cmp(&a.kids.is_some()).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name))
    });
}

/// The file name without its extension.
pub fn note_name(path: &Path) -> String {
    let p = if is_note(path) { path.file_stem() } else { path.file_name() };
    p.map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}

/// Adds a note that isn't on disk (headless runs never write), creating its folders.
pub fn insert(entries: &mut Vec<Entry>, root: &Path, path: &Path) {
    let Ok(rel) = path.strip_prefix(root) else { return };
    let parts: Vec<_> = rel.components().collect();
    let mut level = entries;
    let mut dir = root.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        dir.push(part);
        let last = i + 1 == parts.len();
        let pos = level.iter().position(|e| e.path == dir);
        let idx = match pos {
            Some(p) => p,
            None => {
                let kids = (!last).then(Vec::new);
                let name = if last { note_name(&dir) } else { part.as_os_str().to_string_lossy().into_owned() };
                level.push(Entry { name, path: dir.clone(), modified: SystemTime::now(), len: 0, kids });
                sort(level);
                level.iter().position(|e| e.path == dir).unwrap()
            }
        };
        if last {
            return;
        }
        let Some(kids) = level[idx].kids.as_mut() else { return };
        level = kids;
    }
}

/// The tree without the note at `path` (renamed or gone).
pub fn remove(entries: &mut Vec<Entry>, path: &Path) {
    entries.retain(|e| e.kids.is_some() || e.path != path);
    for e in entries.iter_mut() {
        if let Some(k) = e.kids.as_mut() {
            remove(k, path);
        }
    }
}

pub fn contains(entries: &[Entry], path: &Path) -> bool {
    entries.iter().any(|e| e.path == path || (e.kids.as_ref().is_some_and(|k| path.starts_with(&e.path) && contains(k, path))))
}

/// The most recently modified note.
pub fn newest(entries: &[Entry]) -> Option<PathBuf> {
    fn walk<'a>(entries: &'a [Entry], best: &mut Option<&'a Entry>) {
        for e in entries {
            match &e.kids {
                Some(k) => walk(k, best),
                None if best.is_none_or(|b| e.modified > b.modified) => *best = Some(e),
                None => {}
            }
        }
    }
    let mut best = None;
    walk(entries, &mut best);
    best.map(|e| e.path.clone())
}

/// Every space-separated term is in the path (lowercase, extension dropped), or, loosely, in
/// order in the file name (as the web app's filter).
pub fn matches(rel: &str, q: &str) -> bool {
    let p = rel.to_lowercase();
    let p = p.strip_suffix(".markdown").or_else(|| p.strip_suffix(".md")).unwrap_or(&p);
    let name = p.rsplit('/').next().unwrap_or(p);
    q.split_whitespace().all(|t| p.contains(t) || (t.chars().count() > 1 && subsequence(t, name)))
}

fn subsequence(needle: &str, hay: &str) -> bool {
    let mut n = needle.chars().peekable();
    for c in hay.chars() {
        if n.peek() == Some(&c) {
            n.next();
        }
    }
    n.peek().is_none()
}

pub fn rel(root: &Path, path: &Path) -> String {
    let r = path.strip_prefix(root).unwrap_or(path);
    r.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// The rows to draw: folders open unless collapsed. While filtering, only matching notes and
/// the folders above them show, all open.
pub fn rows(entries: &[Entry], root: &Path, collapsed: &HashSet<PathBuf>, query: &str) -> Vec<Row> {
    let q = query.trim().to_lowercase();
    let mut out = Vec::new();
    walk_rows(entries, root, collapsed, &q, 1, &mut out);
    out
}

fn walk_rows(entries: &[Entry], root: &Path, collapsed: &HashSet<PathBuf>, q: &str, depth: usize, out: &mut Vec<Row>) {
    for e in entries {
        let rel = rel(root, &e.path);
        match &e.kids {
            Some(kids) => {
                let open = !q.is_empty() || !collapsed.contains(&e.path);
                let at = out.len();
                out.push(Row { depth, name: e.name.clone(), path: e.path.clone(), rel, dir: true, open });
                if open {
                    walk_rows(kids, root, collapsed, q, depth + 1, out);
                }
                if !q.is_empty() && out.len() == at + 1 {
                    out.pop();
                }
            }
            None => {
                if q.is_empty() || matches(&rel, q) {
                    out.push(Row { depth, name: e.name.clone(), path: e.path.clone(), rel, dir: false, open: false });
                }
            }
        }
    }
}

/// `Untitled.md`, or `Untitled 2.md`, `Untitled 3.md`… when taken.
pub fn untitled(dir: &Path, taken: impl Fn(&Path) -> bool) -> PathBuf {
    (1..)
        .map(|n| dir.join(if n == 1 { "Untitled.md".to_string() } else { format!("Untitled {n}.md") }))
        .find(|p| !taken(p))
        .unwrap()
}

/// `Untitled.md` or `Untitled <n>.md` (a new note nobody named yet).
pub fn is_untitled(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else { return false };
    match stem.strip_prefix("Untitled") {
        Some("") => true,
        Some(rest) => rest.strip_prefix(' ').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

/// The longest name an untitled note gets from its heading (characters, before `.md`).
pub const TITLE_MAX: usize = 80;

/// A note's file name from its first line when that's an H1 (`# Some title`): the heading's plain text
/// (Markdown markers, links and inline formatting stripped), `/ \ : * ? " < > |` and control characters
/// replaced by spaces, spaces collapsed, no leading dots, trimmed, at most `TITLE_MAX` characters. None for
/// an empty heading, or when the first line isn't an H1.
pub fn heading_title(text: &str) -> Option<String> {
    let first = text.split('\n').next().unwrap_or("");
    let rest = first.strip_prefix('#')?;
    if !(rest.starts_with(' ') || rest.starts_with('\t')) {
        return None;
    }
    // an optional closing sequence of #s
    let body = rest.trim();
    let body = match body.trim_end_matches('#') {
        b if b.len() < body.len() && (b.is_empty() || b.ends_with([' ', '\t'])) => b.trim_end(),
        _ => body,
    };
    let plain = plain_inline(body);
    let mut out = String::new();
    for ch in plain.chars() {
        let bad = matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control();
        let ch = if bad || ch.is_whitespace() { ' ' } else { ch };
        if ch == ' ' && (out.is_empty() || out.ends_with(' ')) {
            continue;
        }
        out.push(ch);
    }
    let out = out.trim_start_matches(['.', ' ']).trim_end();
    let out: String = out.chars().take(TITLE_MAX).collect();
    let out = out.trim_end().to_string();
    (!out.is_empty()).then_some(out)
}

/// A heading's text without Markdown: `![alt](src)` → alt, `[text](url)` → text, backslash escapes, and the
/// emphasis, code, strikethrough and highlight markers (`*`, `_` at a word's edge, `` ` ``, `~~`, `==`).
fn plain_inline(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '\\' && i + 1 < c.len() && c[i + 1].is_ascii_punctuation() {
            out.push(c[i + 1]);
            i += 2;
            continue;
        }
        // [text](url) and ![alt](url)
        let open = if ch == '!' && c.get(i + 1) == Some(&'[') { Some(i + 1) } else if ch == '[' { Some(i) } else { None };
        if let Some(o) = open
            && let Some(close) = (o + 1..c.len()).find(|&j| c[j] == ']')
            && c.get(close + 1) == Some(&'(')
            && let Some(end) = (close + 2..c.len()).find(|&j| c[j] == ')')
        {
            out.push_str(&plain_inline(&c[o + 1..close].iter().collect::<String>()));
            i = end + 1;
            continue;
        }
        let pair = |a: char| c.get(i + 1) == Some(&a);
        if (ch == '~' && pair('~')) || (ch == '=' && pair('=')) {
            i += 2;
            continue;
        }
        if ch == '*' || ch == '`' {
            i += 1;
            continue;
        }
        if ch == '_' {
            let before = i.checked_sub(1).map(|j| c[j]).filter(|p| *p != '_');
            let after = c[i + 1..].iter().find(|x| **x != '_').copied();
            let inside = before.is_some_and(char::is_alphanumeric) && after.is_some_and(char::is_alphanumeric);
            if !inside {
                i += 1;
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// `<dir>/<title>.md`, or `<title> 2.md`, `<title> 3.md`… when that's taken.
pub fn free_name(dir: &Path, title: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    (1..)
        .map(|n| dir.join(if n == 1 { format!("{title}.md") } else { format!("{title} {n}.md") }))
        .find(|p| !taken(p))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/notes")
    }

    #[test]
    fn scans_notes_folders_first_skipping_hidden() {
        let root = fixture();
        let (entries, fp) = scan(&root);
        let names: Vec<_> = rows(&entries, &root, &HashSet::new(), "").iter().map(|r| format!("{}{}", "  ".repeat(r.depth - 1), r.name)).collect();
        assert_eq!(
            names,
            [
                "archive",
                "  2025",
                "    retro",
                "people",
                "  1-1 Grace",
                "  hiring",
                "projects",
                "  launch",
                "    plan",
                "    press kit",
                "  roadmap",
                "A rather long note title that keeps on going",
                "Ideas",
                "Loose ends",
                "Welcome",
            ]
        );
        assert_eq!(scan(&root).1, fp, "same folder, same fingerprint");
        assert_eq!(fingerprint(&entries), fp, "a function of the sorted tree");
    }

    #[test]
    fn symlinked_notes_count_symlinked_folders_dont() {
        let dir = std::env::temp_dir().join(format!("grimoire-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("a/b/deep.md"), "x").unwrap();
        std::fs::write(dir.join("elsewhere.txt"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("a/b/deep.md"), dir.join("alias.md")).unwrap();
        // Cycles: each link points back up, so following them would nest 2^16 levels deep.
        std::os::unix::fs::symlink(&dir, dir.join("a/up")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("a/b/up")).unwrap();
        let start = std::time::Instant::now();
        let (entries, _) = scan(&dir);
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        let names: Vec<_> = rows(&entries, &dir, &HashSet::new(), "").into_iter().map(|r| r.rel).collect();
        assert_eq!(names, ["a", "a/b", "a/b/deep.md", "alias.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collapse_and_filter() {
        let root = fixture();
        let (entries, _) = scan(&root);
        let collapsed: HashSet<_> = [root.join("projects")].into();
        let r = rows(&entries, &root, &collapsed, "");
        assert!(r.iter().any(|r| r.name == "projects" && !r.open));
        assert!(!r.iter().any(|r| r.name == "launch"));
        let names: Vec<_> = rows(&entries, &root, &collapsed, "launch").into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["projects", "launch", "plan", "press kit"]);
        let names: Vec<_> = rows(&entries, &root, &collapsed, "lse").into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["Loose ends"], "loose subsequence in the name");
        assert!(rows(&entries, &root, &collapsed, "zzz").is_empty());
    }

    #[test]
    fn untitled_notes_get_their_heading_as_name() {
        for (n, yes) in [("Untitled.md", true), ("Untitled 2.md", true), ("Untitled 12.md", true), ("Untitled.MD", false), ("Untitled2.md", false), ("Untitled x.md", false), ("Notes.md", false), ("untitled.md", false)] {
            assert_eq!(is_untitled(n), yes, "{n}");
        }
        let t = |s: &str| heading_title(s);
        assert_eq!(t("# Road trip\n\nbody").as_deref(), Some("Road trip"));
        assert_eq!(t("#   Road   trip  ").as_deref(), Some("Road trip"));
        assert_eq!(t("# **Bold** and _it_ and `code` ~~gone~~ ==hi==").as_deref(), Some("Bold and it and code gone hi"));
        assert_eq!(t("# snake_case stays").as_deref(), Some("snake_case stays"));
        assert_eq!(t("# See [the plan](plan.md) ![pic](a.png)").as_deref(), Some("See the plan pic"));
        assert_eq!(t("# a/b\\c: d*e?f\"g<h>i|j").as_deref(), Some("a b c de f g h i j"), "* is an emphasis marker: dropped");
        assert_eq!(t("# 1\\# not a heading").as_deref(), Some("1# not a heading"));
        assert_eq!(t("# Closing ##").as_deref(), Some("Closing"));
        assert_eq!(t("# ...hidden").as_deref(), Some("hidden"));
        assert_eq!(t("# tab\there").as_deref(), Some("tab here"));
        let long = format!("# {}", "x".repeat(120));
        assert_eq!(t(&long).map(|s| s.chars().count()), Some(TITLE_MAX));
        for none in ["#", "# ", "#  ##", "## Two", "#NoSpace", "Text\n# Later", "", "# **  **"] {
            assert_eq!(t(none), None, "{none:?}");
        }
        let dir = Path::new("/n");
        let taken = ["/n/Trip.md", "/n/Trip 2.md"];
        assert_eq!(free_name(dir, "Trip", |p| taken.contains(&p.to_str().unwrap())), Path::new("/n/Trip 3.md"));
        assert_eq!(free_name(dir, "Plan", |_| false), Path::new("/n/Plan.md"));
    }

    #[test]
    fn untitled_names_and_insert() {
        let root = fixture();
        let (mut entries, _) = scan(&root);
        let p = untitled(&root, |p| contains(&entries, p));
        assert_eq!(p, root.join("Untitled.md"));
        insert(&mut entries, &root, &p);
        assert_eq!(untitled(&root, |p| contains(&entries, p)), root.join("Untitled 2.md"));
        let deep = root.join("new/dir/Untitled.md");
        insert(&mut entries, &root, &deep);
        assert!(contains(&entries, &deep));
        let names: Vec<_> = rows(&entries, &root, &HashSet::new(), "untitled").into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["new", "dir", "Untitled", "Untitled"]);
    }
}
