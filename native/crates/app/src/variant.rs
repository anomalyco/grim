//! Grim or Grim Beta, chosen at build time: `cargo build -p grimoire --features beta` (`scripts/bundle.sh --beta`)
//! builds Grim Beta, which talks to staging (https://staging.grimnotes.app) and keeps its own name, Keychain items and
//! folders, so it runs beside Grim without sharing a sign-in, workspaces or caches (docs/app.md "Grim Beta").

pub const BETA: bool = cfg!(feature = "beta");

/// The app's name: the window title with no note, the sidebar's switcher with no workspace.
pub const NAME: &str = if BETA { "Grim Beta" } else { "Grim" };

/// The hosted server: the New dialog's default, sign-in from the account menu.
pub const DEFAULT_SERVER: &str = if BETA { "https://staging.grimnotes.app/" } else { "https://grimnotes.app/" };

/// The Keychain service of the app's items (app tokens, the OpenCode pairing, voice keys).
pub const KEYCHAIN_SERVICE: &str = if BETA { "Grimoire Beta" } else { "Grimoire" };

/// The folder name under `~/Library/Application Support` and `~/Library/Caches`.
pub const DATA_DIR: &str = if BETA { "Grimoire Beta" } else { "Grimoire" };

/// `~/Library/Caches/<DATA_DIR>/<sub>`.
pub fn cache_path(home: &std::ffi::OsStr, sub: &str) -> std::path::PathBuf {
    std::path::Path::new(home).join("Library/Caches").join(DATA_DIR).join(sub)
}
