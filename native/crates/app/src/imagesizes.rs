//! Image sizes remembered per source (a URL, or a file's path), the latest `MAX` (the web's
//! `grimoire.imageSizes.v1`): an image's box has its size before the image has loaded, so nothing moves when it
//! arrives and the first view can count it as laid out. Kept in `~/Library/Caches/Grimoire/image-sizes.json`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

pub const MAX: usize = 500;

struct Sizes {
    /// (source, (width, height)), most recent last.
    list: VecDeque<(String, (u32, u32))>,
    file: Option<PathBuf>,
}

static SIZES: Mutex<Sizes> = Mutex::new(Sizes { list: VecDeque::new(), file: None });

pub fn default_file() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches/Grimoire/image-sizes.json"))
}

/// Remember sizes in `file` (and read what it has).
pub fn set_file(file: PathBuf) {
    let list: VecDeque<(String, (u32, u32))> = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Vec<(String, u32, u32)>>(&b).ok())
        .map(|v| v.into_iter().map(|(k, w, h)| (k, (w, h))).collect())
        .unwrap_or_default();
    let mut s = SIZES.lock().unwrap();
    s.list = list;
    s.file = Some(file);
}

pub fn known(src: &str) -> Option<(u32, u32)> {
    SIZES.lock().unwrap().list.iter().rev().find(|e| e.0 == src).map(|e| e.1)
}

pub fn remember(src: &str, w: u32, h: u32) {
    let mut s = SIZES.lock().unwrap();
    if s.list.back().is_some_and(|e| e.0 == src && e.1 == (w, h)) || (s.list.iter().any(|e| e.0 == src && e.1 == (w, h)) && s.file.is_none()) {
        return;
    }
    s.list.retain(|e| e.0 != src);
    s.list.push_back((src.to_string(), (w, h)));
    while s.list.len() > MAX {
        s.list.pop_front();
    }
    if let Some(f) = s.file.clone() {
        let v: Vec<(&str, u32, u32)> = s.list.iter().map(|e| (e.0.as_str(), e.1.0, e.1.1)).collect();
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = f.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec(&v).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(tmp, f);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_are_remembered_per_source_the_latest_500_and_kept_on_disk() {
        let dir = std::env::temp_dir().join(format!("grimoire-imagesizes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        set_file(dir.join("sizes.json"));
        remember("https://s/raw?a.png", 800, 450);
        assert_eq!(known("https://s/raw?a.png"), Some((800, 450)));
        for i in 0..MAX {
            remember(&format!("https://s/raw?{i}.png"), 10, 10);
        }
        assert_eq!(known("https://s/raw?a.png"), None, "past 500 the oldest goes");
        remember("https://s/raw?0.png", 20, 30);
        // read back as at the next launch
        set_file(dir.join("sizes.json"));
        assert_eq!((known("https://s/raw?0.png"), known(&format!("https://s/raw?{}.png", MAX - 1))), (Some((20, 30)), Some((10, 10))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
