//! Notes on disk: picking the folder and note, loading, and autosaving ~1 s after the last edit.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::files::{self, Entry};

pub const SAMPLE: &str = include_str!("../sample.md");

const DEBOUNCE: Duration = Duration::from_millis(1000);

/// `~/Documents/Grimoire`.
pub fn default_root() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join("Documents").join("Grimoire")
}

/// What the command line opens: the notes folder, its scan (reused by the sidebar and the
/// watcher), and the note to open.
pub struct Located {
    pub root: PathBuf,
    pub path: Option<PathBuf>,
    pub entries: Vec<Entry>,
    pub fingerprint: u64,
}

/// The notes folder and the note to open from the command line argument: a folder opens its
/// most recently modified note, a file opens its folder with it selected, and no argument opens
/// `~/Documents/Grimoire`, created and seeded with the sample note when it has no notes (unless
/// `headless`, which never writes).
pub fn locate(arg: Option<PathBuf>, headless: bool) -> std::io::Result<Located> {
    let arg_given = arg.is_some();
    let arg = arg.unwrap_or_else(default_root);
    if arg.is_dir() || !arg_given {
        if !headless {
            std::fs::create_dir_all(&arg)?;
        }
        let root = std::fs::canonicalize(&arg).unwrap_or(arg);
        let (mut entries, mut fingerprint) = files::scan(&root);
        let path = if entries.is_empty() && !arg_given && !headless {
            let welcome = root.join("Welcome.md");
            write(&welcome, SAMPLE)?;
            (entries, fingerprint) = files::scan(&root);
            Some(welcome)
        } else {
            files::newest(&entries)
        };
        return Ok(Located { root, path, entries, fingerprint });
    }
    let parent = arg.parent().filter(|d| !d.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    if !headless {
        std::fs::create_dir_all(&parent)?;
    }
    let root = std::fs::canonicalize(&parent).unwrap_or(parent);
    let name = arg.file_name().ok_or_else(|| std::io::Error::other(format!("{}: not a file", arg.display())))?;
    let (entries, fingerprint) = files::scan(&root);
    Ok(Located { path: Some(root.join(name)), root, entries, fingerprint })
}

/// Local files open with CRLF and lone CR as LF (the editor keeps any `\r` it is given).
pub fn normalize_newlines(s: &str) -> String {
    if s.contains('\r') { s.replace("\r\n", "\n").replace('\r', "\n") } else { s.to_string() }
}

/// Read the note, creating it (empty) when missing.
pub fn open(path: &Path) -> std::io::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(normalize_newlines(&s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            write(path, "")?;
            Ok(String::new())
        }
        Err(e) => Err(e),
    }
}

/// Write through a temporary file and rename, so a crash never leaves half a note. The temporary
/// name is unique to this write, so writers racing on one note never share it.
pub fn write(path: &Path, text: &str) -> std::io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let name = path.file_name().map_or_else(|| "note".into(), |n| n.to_string_lossy().into_owned());
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{name}.{}-{n}.grimoire-tmp", std::process::id()));
    let done = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, path));
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

enum Msg {
    Text(String),
    Flush(Sender<()>),
}

/// A background writer: `update` with every new text; it writes once edits pause. It keeps the
/// text it last wrote successfully (`confirmed`, starting with the text the note was loaded
/// with); a failed write stays pending and is retried every second.
pub struct Saver {
    tx: Sender<Msg>,
    confirmed: Arc<Mutex<String>>,
    failing: Arc<AtomicBool>,
}

impl Saver {
    pub fn spawn(path: PathBuf, on_disk: String) -> Saver {
        let (tx, rx) = mpsc::channel::<Msg>();
        let confirmed = Arc::new(Mutex::new(on_disk));
        let failing = Arc::new(AtomicBool::new(false));
        let (conf, fail) = (confirmed.clone(), failing.clone());
        std::thread::spawn(move || {
            let mut pending: Option<String> = None;
            let save = |pending: &mut Option<String>| {
                let Some(t) = pending.take() else { return };
                // Already on disk (typed and undone, or reloaded): writing could only clobber an
                // outside change.
                if *conf.lock().unwrap() == t {
                    return;
                }
                match write(&path, &t) {
                    Ok(()) => {
                        *conf.lock().unwrap() = t;
                        fail.store(false, Ordering::SeqCst);
                    }
                    Err(e) => {
                        if !fail.swap(true, Ordering::SeqCst) {
                            eprintln!("grimoire: saving {}: {e} (retrying)", path.display());
                        }
                        *pending = Some(t);
                    }
                }
            };
            loop {
                let msg = if pending.is_some() { rx.recv_timeout(DEBOUNCE) } else { rx.recv().map_err(|_| RecvTimeoutError::Disconnected) };
                match msg {
                    Ok(Msg::Text(t)) => pending = Some(t),
                    Ok(Msg::Flush(done)) => {
                        save(&mut pending);
                        let _ = done.send(());
                    }
                    Err(RecvTimeoutError::Timeout) => save(&mut pending),
                    Err(RecvTimeoutError::Disconnected) => {
                        // The note was closed: keep retrying a failed write for a while.
                        for _ in 0..30 {
                            save(&mut pending);
                            if pending.is_none() {
                                break;
                            }
                            std::thread::sleep(DEBOUNCE);
                        }
                        break;
                    }
                }
            }
        });
        Saver { tx, confirmed, failing }
    }

    /// The text last written (or known to be on disk).
    pub fn confirmed(&self) -> String {
        self.confirmed.lock().unwrap().clone()
    }

    /// The note was reloaded from disk with `text`.
    pub fn set_confirmed(&self, text: String) {
        *self.confirmed.lock().unwrap() = text;
    }

    /// The last write failed (it's being retried).
    pub fn failing(&self) -> bool {
        self.failing.load(Ordering::SeqCst)
    }

    pub fn update(&self, text: String) {
        let _ = self.tx.send(Msg::Text(text));
    }

    /// Write anything pending now and wait for it.
    pub fn flush(&self) {
        let (done, wait) = mpsc::channel();
        if self.tx.send(Msg::Flush(done)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(3));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saver_debounces_and_flushes() {
        let dir = std::env::temp_dir().join(format!("grimoire-test-{}", std::process::id()));
        let path = dir.join("sub").join("note.md");
        assert_eq!(open(&path).unwrap(), "");
        let saver = Saver::spawn(path.clone(), String::new());
        saver.update("one".into());
        saver.update("two".into());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "", "nothing written before the pause");
        std::thread::sleep(DEBOUNCE + Duration::from_millis(300));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        saver.update("three".into());
        saver.flush();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "three");
        assert_eq!(saver.confirmed(), "three");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_save_is_retried_and_never_confirmed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("grimoire-test-retry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("note.md");
        write(&path, "one").unwrap();
        let saver = Saver::spawn(path.clone(), "one".into());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        saver.update("two".into());
        saver.flush();
        assert!(saver.failing());
        assert_eq!(saver.confirmed(), "one");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::thread::sleep(DEBOUNCE + Duration::from_millis(300));
        assert!(!saver.failing(), "retried");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        assert_eq!(saver.confirmed(), "two");
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers, ["note.md"], "no temporary files left");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writers_racing_on_one_note_never_fail() {
        let dir = std::env::temp_dir().join(format!("grimoire-test-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("note.md");
        let threads: Vec<_> = (0..4)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || (0..100).map(|n| write(&path, &format!("{i} {n}"))).filter(Result::is_err).count())
            })
            .collect();
        let failures: usize = threads.into_iter().map(|t| t.join().unwrap()).sum();
        assert_eq!(failures, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
