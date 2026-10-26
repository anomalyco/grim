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

/// The tree under `root` (folders first, then by name) and a fingerprint of every note's path,
/// size and modification time.
pub fn scan(root: &Path) -> (Vec<Entry>, u64) {
    let mut h = DefaultHasher::new();
    let entries = scan_dir(root, &mut h, 0);
    (entries, h.finish())
}

fn scan_dir(dir: &Path, h: &mut DefaultHasher, depth: usize) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if skipped(&name) {
            continue;
        }
        let path = e.path();
        // Follows symlinks; MAX_DEPTH stops a link cycle.
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if meta.is_dir() {
            if depth >= MAX_DEPTH {
                continue;
            }
            let kids = scan_dir(&path, h, depth + 1);
            if !kids.is_empty() {
                out.push(Entry { name, path, modified, kids: Some(kids) });
            }
        } else if is_note(&path) {
            path.hash(h);
            meta.len().hash(h);
            modified.hash(h);
            out.push(Entry { name: note_name(&path), path, modified, kids: None });
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
                level.push(Entry { name, path: dir.clone(), modified: SystemTime::now(), kids });
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
