//! Remote workspaces on disk (Mac only): each workspace's tree and the text of the notes opened or prefetched here,
//! so a launch or a note shows at once — and stays readable offline (read-only) — before the server answers. The
//! live text always wins once it's there.
//!
//! Under `~/Library/Caches/Grimoire/notes` (the system may purge it; it's only a cache): a folder per workspace
//! (server + id, hashed) with `meta.json` (server, id, tree) and `notes/<hash of the path>.json` (path, text, the
//! commit it was saved as when known). Never a token or anything else secret. At most `MAX_BYTES`, the least
//! recently used notes out first (a note read is touched). Writes of notes are queued and written together
//! (`flush`, debounced by the app); the tree is written when it changes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{Value, json};

pub const MAX_BYTES: u64 = 200 * 1024 * 1024;

/// `~/Library/Caches/Grimoire/notes`.
pub fn default_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches/Grimoire/notes"))
}

/// FNV-1a, 64 bits, hex: file names for servers, workspaces and paths (any characters, any length).
fn hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Write `data` to `path` whole (a temporary file renamed over it).
fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

#[derive(Default)]
pub struct DiskCache {
    /// None: nothing is kept (headless runs, tests that don't ask for it).
    root: Option<PathBuf>,
    max: u64,
    /// Notes to write: (server, id, path) → (text, commit).
    pending: HashMap<(String, String, String), (String, Option<String>)>,
}

impl DiskCache {
    pub fn new(root: Option<PathBuf>) -> DiskCache {
        DiskCache { root, max: MAX_BYTES, pending: HashMap::new() }
    }

    pub fn with_max(mut self, max: u64) -> DiskCache {
        self.max = max;
        self
    }

    pub fn enabled(&self) -> bool {
        self.root.is_some()
    }

    fn ws_dir(&self, server: &str, id: &str) -> Option<PathBuf> {
        Some(self.root.as_ref()?.join(hash(&format!("{server}\u{0}{id}"))))
    }

    fn note_file(&self, server: &str, id: &str, path: &str) -> Option<PathBuf> {
        Some(self.ws_dir(server, id)?.join("notes").join(format!("{}.json", hash(path))))
    }

    fn meta(&self, server: &str, id: &str) -> Option<Value> {
        let s = std::fs::read(self.ws_dir(server, id)?.join("meta.json")).ok()?;
        serde_json::from_slice(&s).ok()
    }

    fn write_meta(&self, server: &str, id: &str, tree: Option<&[String]>) {
        let Some(dir) = self.ws_dir(server, id) else { return };
        let old = self.meta(server, id);
        let tree = tree.map(|t| json!(t)).or_else(|| old.as_ref().map(|m| m["tree"].clone())).unwrap_or(Value::Null);
        let ws2 = old.as_ref().is_some_and(|m| m["ws2"] == true);
        let _ = write_atomic(&dir.join("meta.json"), json!({ "server": server, "id": id, "tree": tree, "ws2": ws2 }).to_string().as_bytes());
    }

    /// The workspace's server spoke protocol v2 last time: its socket can start with the load.
    pub fn ws2(&self, server: &str, id: &str) -> bool {
        self.meta(server, id).is_some_and(|m| m["ws2"] == true)
    }

    pub fn set_ws2(&mut self, server: &str, id: &str, on: bool) {
        let Some(dir) = self.ws_dir(server, id) else { return };
        let mut m = self.meta(server, id).unwrap_or_else(|| json!({ "server": server, "id": id, "tree": Value::Null }));
        if (m["ws2"] == true) == on {
            return;
        }
        m["ws2"] = json!(on);
        let _ = write_atomic(&dir.join("meta.json"), m.to_string().as_bytes());
    }

    /// The workspace's tree as last seen (None: never cached).
    pub fn tree(&self, server: &str, id: &str) -> Option<Vec<String>> {
        let m = self.meta(server, id)?;
        m["tree"].as_array().map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_string)).collect())
    }

    pub fn put_tree(&mut self, server: &str, id: &str, tree: &[String]) {
        self.write_meta(server, id, Some(tree));
    }

    /// A note's cached text and commit (touched: recently used).
    pub fn note(&self, server: &str, id: &str, path: &str) -> Option<(String, Option<String>)> {
        if let Some(p) = self.pending.get(&(server.to_string(), id.to_string(), path.to_string())) {
            return Some(p.clone());
        }
        let file = self.note_file(server, id, path)?;
        let v: Value = serde_json::from_slice(&std::fs::read(&file).ok()?).ok()?;
        if v["path"].as_str() != Some(path) {
            return None;
        }
        if let Ok(f) = std::fs::File::options().append(true).open(&file) {
            let _ = f.set_modified(SystemTime::now());
        }
        Some((v["text"].as_str()?.to_string(), v["commit"].as_str().map(str::to_string)))
    }

    /// Queue a note's text for the next `flush`.
    pub fn put_note(&mut self, server: &str, id: &str, path: &str, text: &str, commit: Option<String>) {
        if self.root.is_none() {
            return;
        }
        let k = (server.to_string(), id.to_string(), path.to_string());
        let commit = commit.or_else(|| self.pending.get(&k).and_then(|p| p.1.clone()));
        self.pending.insert(k, (text.to_string(), commit));
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Write the queued notes, then keep under the cap.
    pub fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        for ((server, id, path), (text, commit)) in std::mem::take(&mut self.pending) {
            if self.meta(&server, &id).is_none() {
                self.write_meta(&server, &id, None);
            }
            let Some(file) = self.note_file(&server, &id, &path) else { continue };
            let _ = write_atomic(&file, json!({ "path": path, "text": text, "commit": commit }).to_string().as_bytes());
        }
        self.trim();
    }

    pub fn forget_note(&mut self, server: &str, id: &str, path: &str) {
        self.pending.remove(&(server.to_string(), id.to_string(), path.to_string()));
        if let Some(f) = self.note_file(server, id, path) {
            let _ = std::fs::remove_file(f);
        }
    }

    /// A note renamed: its cached text goes with it.
    pub fn rename_note(&mut self, server: &str, id: &str, from: &str, to: &str) {
        if let Some((text, commit)) = self.note(server, id, from) {
            self.forget_note(server, id, from);
            self.put_note(server, id, to, &text, commit);
            self.flush();
        }
    }

    /// Everything kept for a workspace (removed from the list).
    pub fn forget_workspace(&mut self, server: &str, id: &str) {
        self.pending.retain(|k, _| !(k.0 == server && k.1 == id));
        if let Some(d) = self.ws_dir(server, id) {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// Everything kept for a server's workspaces (signed out: its notes may be private to that account).
    pub fn forget_server(&mut self, server: &str) {
        self.pending.retain(|k, _| k.0 != server);
        let Some(root) = &self.root else { return };
        let Ok(dirs) = std::fs::read_dir(root) else { return };
        for d in dirs.flatten() {
            let meta: Option<Value> = std::fs::read(d.path().join("meta.json")).ok().and_then(|s| serde_json::from_slice(&s).ok());
            if meta.is_some_and(|m| m["server"].as_str() == Some(server)) {
                let _ = std::fs::remove_dir_all(d.path());
            }
        }
    }

    /// Bytes on disk.
    pub fn size(&self) -> u64 {
        self.files().iter().map(|f| f.1).sum()
    }

    /// Every note file: (path, size, last used).
    fn files(&self) -> Vec<(PathBuf, u64, SystemTime)> {
        let mut out = Vec::new();
        let Some(root) = &self.root else { return out };
        let Ok(dirs) = std::fs::read_dir(root) else { return out };
        for d in dirs.flatten() {
            let Ok(notes) = std::fs::read_dir(d.path().join("notes")) else { continue };
            for n in notes.flatten() {
                if let Ok(m) = n.metadata() {
                    out.push((n.path(), m.len(), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
                }
            }
        }
        out
    }

    /// Past the cap: the least recently used notes go.
    pub fn trim(&mut self) {
        let mut files = self.files();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= self.max {
            return;
        }
        files.sort_by_key(|f| f.2);
        for (p, size, _) in files {
            if total <= self.max {
                break;
            }
            if std::fs::remove_file(&p).is_ok() {
                total -= size;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("grimoire-disk-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn trees_and_notes_survive_a_restart_and_forget_removes_them() {
        let d = dir("basic");
        let mut c = DiskCache::new(Some(d.clone()));
        c.put_tree("https://s", "w", &["a.md".into(), "dir/b.md".into()]);
        c.put_note("https://s", "w", "dir/b.md", "bee", Some("abc".into()));
        assert_eq!(c.note("https://s", "w", "dir/b.md"), Some(("bee".into(), Some("abc".into()))), "pending is readable");
        c.flush();
        let mut c = DiskCache::new(Some(d.clone()));
        assert_eq!(c.tree("https://s", "w").unwrap(), ["a.md", "dir/b.md"]);
        assert_eq!(c.note("https://s", "w", "dir/b.md").unwrap().0, "bee");
        assert_eq!(c.note("https://s", "other", "dir/b.md"), None);
        c.rename_note("https://s", "w", "dir/b.md", "c.md");
        assert_eq!((c.note("https://s", "w", "dir/b.md"), c.note("https://s", "w", "c.md").map(|n| n.0)), (None, Some("bee".into())));
        c.put_tree("https://t", "x", &["t.md".into()]);
        c.forget_server("https://s");
        assert_eq!((c.tree("https://s", "w"), c.tree("https://t", "x").map(|t| t.len())), (None, Some(1)));
        c.forget_workspace("https://t", "x");
        assert_eq!(c.tree("https://t", "x"), None);
        // nothing secret: the files hold the tree and the texts only
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn past_the_cap_the_least_recently_used_notes_go() {
        let d = dir("lru");
        let mut c = DiskCache::new(Some(d.clone())).with_max(3_000);
        let text = "x".repeat(900);
        for i in 0..3 {
            c.put_note("s", "w", &format!("n{i}.md"), &text, None);
            c.flush();
            // distinct times for the order
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // n0 read: recently used, so n1 is the oldest
        assert!(c.note("s", "w", "n0.md").is_some());
        std::thread::sleep(std::time::Duration::from_millis(20));
        c.put_note("s", "w", "n3.md", &text, None);
        c.flush();
        assert!(c.size() <= 3_000, "{}", c.size());
        assert!(c.note("s", "w", "n1.md").is_none(), "the least recently used went");
        assert!(c.note("s", "w", "n0.md").is_some() && c.note("s", "w", "n3.md").is_some());
        let _ = std::fs::remove_dir_all(&d);
    }
}
