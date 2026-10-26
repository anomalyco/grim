//! The note on disk: picking the file, loading it, and autosaving ~1 s after the last edit.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

pub const SAMPLE: &str = include_str!("../sample.md");

const DEBOUNCE: Duration = Duration::from_millis(1000);

/// `~/Documents/Grimoire/Untitled.md`.
pub fn default_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join("Documents").join("Grimoire").join("Untitled.md")
}

/// Read the note, creating it (and its folder) when missing: the default note starts as the
/// sample, a named one starts empty.
pub fn open(path: &Path, is_default: bool) -> std::io::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s.replace("\r\n", "\n")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let initial = if is_default { SAMPLE } else { "" };
            write(path, initial)?;
            Ok(initial.to_string())
        }
        Err(e) => Err(e),
    }
}

/// Write through a temporary file and rename, so a crash never leaves half a note.
pub fn write(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let name = path.file_name().map_or_else(|| "note".into(), |n| n.to_string_lossy().into_owned());
    let tmp = path.with_file_name(format!(".{name}.grimoire-tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

enum Msg {
    Text(String),
    Flush(Sender<()>),
}

/// A background writer: `update` with every new text; it writes once edits pause.
pub struct Saver {
    tx: Sender<Msg>,
}

impl Saver {
    pub fn spawn(path: PathBuf) -> Saver {
        let (tx, rx) = mpsc::channel::<Msg>();
        std::thread::spawn(move || {
            let mut pending: Option<String> = None;
            let save = |pending: &mut Option<String>| {
                if let Some(t) = pending.take()
                    && let Err(e) = write(&path, &t)
                {
                    eprintln!("grimoire: saving {}: {e}", path.display());
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
                        save(&mut pending);
                        break;
                    }
                }
            }
        });
        Saver { tx }
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
        assert_eq!(open(&path, false).unwrap(), "");
        let saver = Saver::spawn(path.clone());
        saver.update("one".into());
        saver.update("two".into());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "", "nothing written before the pause");
        std::thread::sleep(DEBOUNCE + Duration::from_millis(300));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        saver.update("three".into());
        saver.flush();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "three");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
