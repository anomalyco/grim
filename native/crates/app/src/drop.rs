//! Image files dragged in from Finder: a drop caret while they hover the page, and Markdown image
//! links inserted where they're dropped.
//!
//! An image already inside the notes folder is linked by its path relative to the note's folder.
//! Any other image is copied into `images/` beside the note (an identical file already there is
//! reused; a different one with the same name gets `name-2.png`, `name-3.png`…). Headless runs
//! work out the same link but don't copy.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use editor_core::Sel;
use rune::{FileDrop, Tx};

use crate::App;
use crate::input::to_text;
use crate::theme::*;

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "tiff", "tif", "bmp"];

pub fn is_image(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| IMAGE_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// The surface's handler (points are surface-local, scroll included, like `Drag`).
pub fn on_file_drop(app: &mut App, ev: &FileDrop, tx: &mut Tx) {
    let images: Vec<&PathBuf> = ev.paths().iter().filter(|p| is_image(p)).collect();
    let at = ev.pos().filter(|_| !images.is_empty()).and_then(|(x, y)| {
        let geo = app.geometry();
        let (x, y) = to_text(x - PAD_L, y - PAD_T, geo.height);
        app.ed.hit_test(&geo, x, y)
    });
    match ev {
        FileDrop::Hover { .. } => {
            if app.drop_at == at {
                return;
            }
            app.drop_at = at;
        }
        FileDrop::Cancel => app.drop_at = None,
        FileDrop::Drop { .. } => {
            app.drop_at = None;
            let Some(p) = at else { return };
            let links = images
                .iter()
                .filter_map(|src| match link(src, app.root.as_deref(), app.path.as_deref(), !app.headless) {
                    Ok(l) => Some(l),
                    Err(e) => {
                        eprintln!("grimoire: {}: {e}", src.display());
                        None
                    }
                })
                .collect::<Vec<_>>();
            if links.is_empty() {
                return;
            }
            app.blur_filter();
            app.marked = None;
            app.ed.set_selection(Sel::caret(p));
            app.ed.paste(&links.join("\n"));
            tx.scroll_into_view("caret", CARET_MARGIN);
            app.handled(tx);
            return;
        }
    }
    tx.instant();
}

/// The Markdown for one dropped image: `![stem](url)`, copying it next to the note first when it
/// lives outside the notes folder (unless `write` is off).
pub fn link(src: &Path, root: Option<&Path>, note: Option<&Path>, write: bool) -> std::io::Result<String> {
    let src = std::fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    let alt = src.file_stem().map_or(String::new(), |s| s.to_string_lossy().into_owned());
    let note_dir = note.and_then(Path::parent);
    let url = match (root, note_dir) {
        (Some(root), Some(dir)) if src.starts_with(root) => rel_url(dir, &src),
        (_, Some(dir)) => {
            let target = copy_target(&src, &dir.join("images"))?;
            if write && !target.exists() {
                std::fs::create_dir_all(dir.join("images"))?;
                std::fs::copy(&src, &target)?;
            }
            rel_url(dir, &target)
        }
        // The built-in sample has no folder: link where the file is.
        (_, None) => encode(&src.to_string_lossy()),
    };
    Ok(format!("![{}]({url})", escape_alt(&alt)))
}

/// Where `src` goes in `dir`: its own name, or `name-2.ext`, `name-3.ext`… past files with the same
/// name and different contents. An identical file already there is the answer itself.
pub fn copy_target(src: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    let name = src.file_name().ok_or_else(|| std::io::Error::other("not a file"))?;
    let stem = src.file_stem().map_or(String::new(), |s| s.to_string_lossy().into_owned());
    let ext = src.extension().map(|e| e.to_string_lossy().into_owned());
    for n in 1.. {
        let cand = if n == 1 {
            dir.join(name)
        } else {
            dir.join(match &ext {
                Some(e) => format!("{stem}-{n}.{e}"),
                None => format!("{stem}-{n}"),
            })
        };
        if !cand.exists() || same_file_contents(src, &cand)? {
            return Ok(cand);
        }
    }
    unreachable!()
}

fn same_file_contents(a: &Path, b: &Path) -> std::io::Result<bool> {
    if std::fs::metadata(a)?.len() != std::fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut fa, mut fb) = (std::fs::File::open(a)?, std::fs::File::open(b)?);
    let (mut ba, mut bb) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = read_full(&mut fa, &mut ba)?;
        if n != read_full(&mut fb, &mut bb)? || ba[..n] != bb[..n] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

fn read_full(f: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// `to` relative to the folder `from` (both absolute), `/`-separated and URL-encoded.
pub fn rel_url(from: &Path, to: &Path) -> String {
    let a: Vec<Component> = from.components().collect();
    let b: Vec<Component> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let parts = std::iter::repeat_n("..".to_string(), a.len() - common)
        .chain(b[common..].iter().map(|c| encode(&c.as_os_str().to_string_lossy())));
    parts.collect::<Vec<_>>().join("/")
}

/// Percent-encodes what would end or confuse the editor's link URL (which stops at whitespace and
/// needs balanced parentheses; no `<…>` form) or be read as a query / fragment when the source
/// is resolved: whitespace and control characters, parentheses, `%`, `<`, `>`, `?`, `#`.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_whitespace() || ch.is_control() || matches!(ch, '(' | ')' | '%' | '<' | '>' | '?' | '#') {
            let mut buf = [0u8; 4];
            for b in ch.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Brackets and backslashes in the alt text are escaped so the link still parses.
fn escape_alt(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(if ch == '\n' { ' ' } else { ch });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("grimoire-drop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    fn put(p: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    #[test]
    fn only_images_count() {
        for p in ["a.png", "b.JPG", "c.jpeg", "d.Gif", "e.webp", "f.HEIC", "g.svg", "h.tiff", "i.bmp"] {
            assert!(is_image(Path::new(p)), "{p}");
        }
        for p in ["a.pdf", "notes.md", "png", "archive.png.zip", "noext"] {
            assert!(!is_image(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn inside_the_folder_links_relative_to_the_note() {
        let root = temp_dir("inside");
        let note = root.join("projects/launch/plan.md");
        put(&root.join("projects/launch/shot.png"), b"1");
        put(&root.join("assets/logo.png"), b"2");
        put(&root.join("projects/launch/images/a b(1).png"), b"3");
        let l = |p: &str| link(&root.join(p), Some(&root), Some(&note), true).unwrap();
        assert_eq!(l("projects/launch/shot.png"), "![shot](shot.png)");
        assert_eq!(l("assets/logo.png"), "![logo](../../assets/logo.png)");
        assert_eq!(l("projects/launch/images/a b(1).png"), "![a b(1)](images/a%20b%281%29.png)");
        assert!(!root.join("projects/launch/images/shot.png").exists(), "nothing copied");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn outside_the_folder_copies_into_images_with_de_dupe() {
        let base = temp_dir("outside");
        let root = base.join("notes");
        let note = root.join("sub/note.md");
        let out = base.join("Desktop");
        put(&out.join("cat photo.png"), b"cat");
        put(&out.join("other/cat photo.png"), b"different cat");
        put(&out.join("again/cat photo.png"), b"cat");
        let l = |p: &str, write| link(&out.join(p), Some(&root), Some(&note), write).unwrap();

        // Headless: the link, but no file.
        assert_eq!(l("cat photo.png", false), "![cat photo](images/cat%20photo.png)");
        assert!(!root.join("sub/images").exists());

        assert_eq!(l("cat photo.png", true), "![cat photo](images/cat%20photo.png)");
        assert_eq!(std::fs::read(root.join("sub/images/cat photo.png")).unwrap(), b"cat");
        // Same contents (another copy elsewhere): reused, not copied again.
        assert_eq!(l("again/cat photo.png", true), "![cat photo](images/cat%20photo.png)");
        assert!(!root.join("sub/images/cat photo-2.png").exists());
        // Same name, different contents: a new name.
        assert_eq!(l("other/cat photo.png", true), "![cat photo](images/cat%20photo-2.png)");
        assert_eq!(std::fs::read(root.join("sub/images/cat photo-2.png")).unwrap(), b"different cat");
        assert_eq!(l("other/cat photo.png", true), "![cat photo](images/cat%20photo-2.png)", "dropped again: found");
        // Same size, different bytes.
        put(&out.join("x/cat photo.png"), b"dog");
        assert_eq!(l("x/cat photo.png", true), "![cat photo](images/cat%20photo-3.png)");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn encoding_and_alt_text() {
        assert_eq!(encode("a b(c)%d.png"), "a%20b%28c%29%25d.png");
        assert_eq!(encode("é ok.png"), "é%20ok.png");
        assert_eq!(encode("why?#2.png"), "why%3F%232.png");
        assert_eq!(escape_alt("x [1]"), "x \\[1\\]");
        assert_eq!(rel_url(Path::new("/r/a/b"), Path::new("/r/c/d e.png")), "../../c/d%20e.png");
        assert_eq!(rel_url(Path::new("/r"), Path::new("/r/images/x.png")), "images/x.png");
    }

    #[test]
    fn the_link_parses_as_one_image_and_resolves_back() {
        let md = "![cat photo (2)](images/cat%20photo%20%282%29.png)";
        let (els, _) = editor_core::parser::parse_inline(md, 0, md.len());
        let img = els.iter().find(|e| e.ty == editor_core::parser::InlineType::Image).expect("an image");
        assert_eq!((img.from, img.to), (0, md.len()));
        let (a, b) = img.src.unwrap();
        assert_eq!(&md[a..b], "images/cat%20photo%20%282%29.png");
        assert_eq!(crate::images::resolve(&md[a..b], Some(Path::new("/n"))), Ok(Path::new("/n/images/cat photo (2).png").to_path_buf()));
    }
}
