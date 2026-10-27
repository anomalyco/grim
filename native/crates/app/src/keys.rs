//! The macOS key table every editor gets (editor-core's `KeyTable`): Cocoa's standard bindings
//! with Grimoire's changes, then the user's `~/Library/KeyBindings/DefaultKeyBinding.dict` on top
//! (read once at startup). Headless runs don't read the user's dict; `--key-bindings=FILE` loads
//! one instead (scripts and tests).

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use editor_core::{Editor, KeyTable};

static KEYS: OnceLock<Arc<KeyTable>> = OnceLock::new();

/// Build the table (call once, before the first editor).
pub fn init(headless: bool) {
    let arg = rune::extra_args().iter().find_map(|a| a.strip_prefix("--key-bindings=").map(PathBuf::from));
    let user = arg.or_else(|| {
        let home = std::env::var_os("HOME").filter(|_| !headless)?;
        Some(Path::new(&home).join("Library/KeyBindings/DefaultKeyBinding.dict"))
    });
    let mut t = KeyTable::standard();
    if let Some(p) = user.filter(|p| p.exists())
        && let Err(e) = load(&mut t, &p)
    {
        eprintln!("grimoire: {}: {e} (using the standard key bindings)", p.display());
    }
    KEYS.set(Arc::new(t)).ok();
}

/// Add a key-binding dict over `t`: old-style plist text directly, other plists (XML, binary)
/// through `plutil -convert json`, which the same parser reads.
pub fn load(t: &mut KeyTable, p: &Path) -> Result<usize, String> {
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let text_err = match std::str::from_utf8(&bytes).map_err(|e| e.to_string()).and_then(|s| t.add_dict(s)) {
        Ok(n) => return Ok(n),
        Err(e) => e,
    };
    let out = std::process::Command::new("plutil").args(["-convert", "json", "-o", "-"]).arg(p).output();
    match out {
        Ok(o) if o.status.success() => t.add_dict(&String::from_utf8_lossy(&o.stdout)),
        _ => Err(text_err),
    }
}

pub fn table() -> Arc<KeyTable> {
    KEYS.get_or_init(|| Arc::new(KeyTable::standard())).clone()
}

/// An editor over `text` with the key table, link URLs editable as text (a collapsed link shows
/// a pencil instead, see `links`).
pub fn editor(text: &str) -> Editor {
    let mut e = Editor::new(text);
    e.set_key_table(Some(table()));
    e.set_link_urls_editable(true);
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::macos_keys::{self, Value, parse_dict};
    use editor_core::{Command, HUnit, Key, Mods};

    /// The embedded table is the system's (every binding that isn't `noop:`).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_standard_table_is_the_systems() {
        let p = "/System/Library/Frameworks/AppKit.framework/Resources/StandardKeyBinding.dict";
        let out = std::process::Command::new("plutil").args(["-convert", "json", "-o", "-", p]).output().unwrap();
        let mut sys = parse_dict(&String::from_utf8_lossy(&out.stdout)).unwrap();
        sys.retain(|(_, v)| *v != Value::Str("noop:".into()));
        let mut ours = parse_dict(macos_keys::STANDARD).unwrap();
        sys.sort_by(|a, b| a.0.cmp(&b.0));
        ours.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(ours, sys);
    }

    #[test]
    fn a_user_dict_overrides_the_standard_table() {
        let dir = std::env::temp_dir().join(format!("grimoire-keys-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("DefaultKeyBinding.dict");
        std::fs::write(&p, "/* mine */\n{\n  \"^w\" = \"deleteWordBackward:\";\n  \"^a\" = \"moveToBeginningOfDocument:\";\n}\n").unwrap();
        let mut t = KeyTable::standard();
        assert_eq!(load(&mut t, &p), Ok(2));
        let ctrl = Mods { ctrl: true, ..Mods::NONE };
        assert_eq!(t.lookup(Key::Char('w'), ctrl), Some(&[Command::DeleteWordBackward][..]));
        assert_eq!(t.lookup(Key::Char('a'), ctrl), Some(&[Command::Move { dir: -1, unit: HUnit::Doc, extend: false }][..]));
        // an XML plist goes through plutil
        #[cfg(target_os = "macos")]
        {
            let x = dir.join("xml.dict");
            std::fs::write(&x, r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>^u</key><string>deleteToBeginningOfLine:</string></dict></plist>
"#).unwrap();
            assert_eq!(load(&mut t, &x), Ok(1));
            assert_eq!(t.lookup(Key::Char('u'), ctrl), Some(&[Command::DeleteToLineStart][..]));
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
