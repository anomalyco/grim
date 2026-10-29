//! Workspaces: a local folder of notes, or a workspace hosted on a Grimoire server. The recent list and the
//! servers the app is connected to (with the workspaces joined there, cached) persist in the app's support
//! folder (`~/Library/Application Support/Grimoire/workspaces.json`); app tokens go into the macOS Keychain
//! (`security`), or a 0600 file beside it when the Keychain can't be used.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

use crate::net;

/// How many recent workspaces are kept.
const MAX_RECENT: usize = 12;
const KEYCHAIN_SERVICE: &str = "Grimoire";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WsRef {
    Local { path: PathBuf },
    /// `server` is an origin (`https://grimoire.exe.xyz`).
    Remote { server: String, id: String, title: String },
}

impl WsRef {
    pub fn name(&self) -> String {
        match self {
            WsRef::Local { path } => crate::files::note_name(path),
            WsRef::Remote { title, id, .. } => if title.is_empty() { id.clone() } else { title.clone() },
        }
    }

    /// Where it lives: `~/Documents/Grimoire`, or the server's host.
    pub fn location(&self) -> String {
        match self {
            WsRef::Local { path } => tilde(path),
            WsRef::Remote { server, .. } => net::parse_url(server).map_or_else(|_| server.clone(), |u| u.display_host()),
        }
    }

    /// Same workspace (the title doesn't count).
    pub fn same(&self, o: &WsRef) -> bool {
        match (self, o) {
            (WsRef::Local { path: a }, WsRef::Local { path: b }) => a == b,
            (WsRef::Remote { server: s1, id: i1, .. }, WsRef::Remote { server: s2, id: i2, .. }) => s1 == s2 && i1 == i2,
            _ => false,
        }
    }

    fn to_json(&self, note: Option<&str>) -> Value {
        match self {
            WsRef::Local { path } => json!({ "kind": "local", "path": path.to_string_lossy(), "note": note }),
            // never an empty title: the id until the server's title is known
            WsRef::Remote { server, id, .. } => json!({ "kind": "remote", "server": server, "id": id, "title": self.name(), "note": note }),
        }
    }

    fn from_json(v: &Value) -> Option<(WsRef, Option<String>)> {
        let note = v["note"].as_str().map(str::to_string);
        let r = match v["kind"].as_str()? {
            "local" => WsRef::Local { path: PathBuf::from(v["path"].as_str()?) },
            "remote" => WsRef::Remote {
                server: v["server"].as_str()?.to_string(),
                id: v["id"].as_str()?.to_string(),
                title: v["title"].as_str().unwrap_or_default().to_string(),
            },
            _ => return None,
        };
        Some((r, note))
    }
}

/// `/Users/me/x` → `~/x`.
pub fn tilde(p: &Path) -> String {
    if let Some(home) = std::env::var_os("HOME")
        && let Ok(rest) = p.strip_prefix(&home)
    {
        return if rest.as_os_str().is_empty() { "~".into() } else { format!("~/{}", rest.display()) };
    }
    p.display().to_string()
}

/// What a pasted remote workspace URL names: `https://<server>/app/<workspace>[/<note path>]` (also the old
/// `/r/<workspace>/…` form, and a bare server with a workspace path missing → error).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteUrl {
    pub server: String,
    pub id: String,
    pub note: Option<String>,
}

pub fn parse_remote_url(s: &str) -> Result<RemoteUrl, String> {
    let u = net::parse_url(s)?;
    let path = u.path.split('?').next().unwrap_or("");
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let rest = match segs.first() {
        Some(&"app") | Some(&"r") => &segs[1..],
        _ => return Err("Paste a workspace URL like https://server/app/workspace".into()),
    };
    let Some(id) = rest.first().map(|s| net::dec(s)).filter(|s| !s.is_empty() && s != "." && s != "..") else {
        return Err("That URL names no workspace (https://server/app/workspace)".into());
    };
    let note = (rest.len() > 1).then(|| rest[1..].iter().map(|s| net::dec(s)).collect::<Vec<_>>().join("/"));
    Ok(RemoteUrl { server: u.origin(), id, note })
}

/// A folder joined on a server (`GET /api/workspaces`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Joined {
    pub id: String,
    pub title: String,
    pub read_only: bool,
}

impl Joined {
    pub fn new(id: &str, title: &str) -> Joined {
        Joined { id: id.into(), title: title.into(), read_only: false }
    }

    pub fn from_json(v: &Value) -> Option<Joined> {
        Some(Joined { id: v["id"].as_str()?.to_string(), title: v["title"].as_str().unwrap_or_default().to_string(), read_only: v["readOnly"].as_bool().unwrap_or(false) })
    }

    fn to_json(&self) -> Value {
        json!({ "id": self.id, "title": self.title, "readOnly": self.read_only })
    }
}

/// A server the app has a token for.
#[derive(Clone, Debug, PartialEq)]
pub struct Server {
    pub url: String,
    pub name: String,
    /// The workspaces joined there, as last fetched.
    pub joined: Vec<Joined>,
    /// The account the app's token belongs to (its name), and the token's id (to revoke it).
    pub account: Option<String>,
    pub token_id: Option<String>,
    /// The account's email (`/api/me`), shown after its name in the switcher.
    pub email: Option<String>,
    /// The server has Google sign-in on (`/api/server`): invites by email can be accepted.
    pub google: bool,
}

/// The persisted state: recent workspaces (most recent first, each with the note open last) and servers.
#[derive(Clone, Debug, Default)]
pub struct Store {
    /// `None`: nothing is read or written (headless runs without `--support-dir`, tests).
    pub dir: Option<PathBuf>,
    /// Read but never written (headless runs with `--support-dir`).
    pub read_only: bool,
    pub recent: Vec<(WsRef, Option<String>)>,
    pub servers: Vec<Server>,
    /// Who the app is on servers it has no token for: a guest (made once and kept, like a browser's).
    pub guest: Option<Guest>,
    /// "Authors" turned off (the line-author margin; on by default).
    pub hide_authors: bool,
    /// Folders the user opened or closed against their workspace's default (a folder's full path; a remote
    /// workspace's under its virtual root), oldest first, at most `MAX_FOLDERS`: the web's `grimoire.tree.v2`.
    pub folders: Vec<(String, bool)>,
    /// Each note's folded headings (`Editor::fold_keys`), by the note's full path, oldest first, at most
    /// `MAX_FOLDERS`: the web's `grimoire.folds:<repo>\0<path>`.
    pub folds: Vec<(String, Vec<(String, usize)>)>,
}

/// How many folders' open/closed state is remembered (the web keeps the newest 500).
const MAX_FOLDERS: usize = 500;

/// A guest: no account, a random id, a made-up name and a colour, as the web's browsers have
/// (`anonIdentity` in `src/client/signin.ts`). The server takes it from the `X-Grimoire-Guest` headers (REST)
/// and the `anon`, `name`, `color` query parameters (rooms), and signs the guest's commits "<name> (guest)".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guest {
    pub id: String,
    pub name: String,
    pub color: String,
}

impl Default for Guest {
    fn default() -> Guest {
        Guest::new()
    }
}

impl Guest {
    pub fn new() -> Guest {
        let id = crate::net::random_hex(12);
        Guest { name: silly_name(), color: guest_color(&id), id }
    }

    /// As the app's `/api/me` stands in for an account: `guest:<id>`, the name and colour, kind "guest".
    pub fn me(&self) -> Value {
        json!({ "id": format!("guest:{}", self.id), "name": self.name, "color": self.color, "kind": "guest" })
    }

    fn from_json(v: &Value) -> Option<Guest> {
        let (id, name, color) = (v["id"].as_str()?, v["name"].as_str()?, v["color"].as_str()?);
        let id_ok = (6..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        let color_ok = color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit());
        (id_ok && color_ok && !name.trim().is_empty()).then(|| Guest { id: id.into(), name: name.into(), color: color.into() })
    }
}

/// The web's silly names (`src/shared/names.ts`): "moist-noodle".
pub fn silly_name() -> String {
    const ADJECTIVES: [&str; 20] = ["soggy", "wobbly", "crunchy", "sneaky", "grumpy", "moist", "chonky", "sleepy", "spicy", "lumpy", "confused", "feral", "squishy", "smelly", "bonkers", "dizzy", "greasy", "sassy", "noodly", "crusty"];
    const THINGS: [&str; 20] = ["potato", "noodle", "goblin", "pickle", "toaster", "walrus", "burrito", "nugget", "pigeon", "meatball", "spoon", "waffle", "gremlin", "turnip", "possum", "sock", "biscuit", "llama", "pretzel", "blob"];
    let r = u32::from_str_radix(&crate::net::random_hex(4), 16).unwrap_or(0) as usize;
    format!("{}-{}", ADJECTIVES[r % 20], THINGS[(r / 20) % 20])
}

/// The web's `colorFor` (`src/client/util.ts`): a colour from the palette by the id's hash.
pub fn guest_color(id: &str) -> String {
    const PALETTE: [&str; 12] = ["#296d9a", "#1a4d65", "#2b6a54", "#826465", "#5c6b57", "#7c4d3a", "#4a5568", "#3d5a80", "#6a5a8c", "#8a5a2b", "#2f6f6f", "#5b5b5b"];
    let h = id.encode_utf16().fold(0i32, |h, c| h.wrapping_mul(31).wrapping_add(c as i32));
    PALETTE[(h.unsigned_abs() % 12) as usize].to_string()
}

/// `~/Library/Application Support/Grimoire`.
pub fn default_support_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(Path::new(&home).join("Library/Application Support/Grimoire"))
}

impl Store {
    pub fn load(dir: Option<PathBuf>) -> Store {
        let mut s = Store { dir, ..Store::default() };
        let Some(d) = &s.dir else { return s };
        let Ok(text) = std::fs::read_to_string(d.join("workspaces.json")) else { return s };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { return s };
        if let Some(a) = v["recent"].as_array() {
            // local folders by their real path (a relative or symlinked spelling is the same folder), each once
            for (mut w, note) in a.iter().filter_map(WsRef::from_json) {
                if let WsRef::Local { path } = &mut w
                    && let Ok(p) = std::fs::canonicalize(&*path)
                {
                    *path = p;
                }
                if !s.recent.iter().any(|(r, _)| r.same(&w)) && s.recent.len() < 2 * MAX_RECENT {
                    s.recent.push((w, note));
                }
            }
        }
        s.guest = Guest::from_json(&v["guest"]);
        s.hide_authors = v["showAuthors"] == false;
        if let Some(a) = v["folders"].as_array() {
            s.folders = a.iter().filter_map(|e| Some((e[0].as_str()?.to_string(), e[1].as_bool()?))).collect();
        }
        if let Some(a) = v["folds"].as_array() {
            s.folds = a.iter().filter_map(|e| Some((e[0].as_str()?.to_string(), serde_json::from_value(e[1].clone()).ok()?))).collect();
        }
        if let Some(a) = v["servers"].as_array() {
            s.servers = a
                .iter()
                .filter_map(|v| {
                    Some(Server {
                        url: v["url"].as_str()?.to_string(),
                        name: v["name"].as_str().unwrap_or_default().to_string(),
                        joined: v["joined"].as_array().map(|a| a.iter().filter_map(Joined::from_json).collect()).unwrap_or_default(),
                        account: v["account"].as_str().map(str::to_string),
                        token_id: v["tokenId"].as_str().map(str::to_string),
                        email: v["email"].as_str().map(str::to_string),
                        google: v["google"].as_bool().unwrap_or(false),
                    })
                })
                .collect();
        }
        s
    }

    /// The guest identity, made (and saved) the first time.
    pub fn ensure_guest(&mut self) -> Guest {
        if let Some(g) = &self.guest {
            return g.clone();
        }
        let g = Guest::new();
        self.guest = Some(g.clone());
        self.save();
        g
    }

    pub fn save(&self) {
        let Some(d) = self.dir.as_ref().filter(|_| !self.read_only) else { return };
        let v = json!({
            "recent": self.recent.iter().map(|(w, n)| w.to_json(n.as_deref())).collect::<Vec<_>>(),
            "servers": self.servers.iter().map(|s| json!({
                "url": s.url, "name": s.name, "joined": s.joined.iter().map(Joined::to_json).collect::<Vec<_>>(),
                "account": s.account, "tokenId": s.token_id, "email": s.email, "google": s.google,
            })).collect::<Vec<_>>(),
            "guest": self.guest.as_ref().map(|g| json!({ "id": g.id, "name": g.name, "color": g.color })),
            "showAuthors": !self.hide_authors,
            "folders": self.folders.iter().map(|(p, open)| json!([p, open])).collect::<Vec<_>>(),
            "folds": self.folds.iter().map(|(p, keys)| json!([p, keys])).collect::<Vec<_>>(),
        });
        let text = serde_json::to_string_pretty(&v).unwrap_or_default();
        if let Err(e) = std::fs::create_dir_all(d).and_then(|()| crate::doc::write(&d.join("workspaces.json"), &text)) {
            eprintln!("grimoire: {}: {e}", d.display());
        }
    }

    /// `w` becomes the most recent (with the note open in it). A remote one without a title keeps the
    /// title it had.
    pub fn touch(&mut self, w: &WsRef, note: Option<String>) {
        let old = self.recent.iter().position(|(r, _)| r.same(w));
        let note = note.or_else(|| old.and_then(|i| self.recent[i].1.clone()));
        let mut w = w.clone();
        if let (WsRef::Remote { title, .. }, Some(i)) = (&mut w, old)
            && title.is_empty()
            && let WsRef::Remote { title: t, .. } = &self.recent[i].0
        {
            *title = t.clone();
        }
        if let Some(i) = old {
            self.recent.remove(i);
        }
        self.recent.insert(0, (w, note));
        // up to MAX_RECENT of each kind: remote workspaces opened never push local folders out
        let (mut locals, mut remotes) = (0, 0);
        self.recent.retain(|(r, _)| {
            let n = if matches!(r, WsRef::Local { .. }) { &mut locals } else { &mut remotes };
            *n += 1;
            *n <= MAX_RECENT
        });
        self.save();
    }

    /// Remember the note open in `w` (only when `w` is already in the list).
    pub fn set_note(&mut self, w: &WsRef, note: Option<String>) {
        if let Some(e) = self.recent.iter_mut().find(|(r, _)| r.same(w))
            && e.1 != note
        {
            e.1 = note;
            self.save();
        }
    }

    /// Whether folder `p` was left open (`Some(true)`) or closed against its workspace's default.
    pub fn folder_open(&self, p: &Path) -> Option<bool> {
        let p = p.to_string_lossy();
        self.folders.iter().find(|(f, _)| *f == p).map(|e| e.1)
    }

    /// Remember folder `p` as open or closed against the default (`None`: as the default). True when it changed.
    pub fn set_folder(&mut self, p: &Path, open: Option<bool>) -> bool {
        let key = p.to_string_lossy().into_owned();
        let old = self.folders.iter().position(|(f, _)| *f == key);
        let was = old.map(|i| self.folders.remove(i).1);
        if let Some(o) = open {
            self.folders.push((key, o));
            if self.folders.len() > MAX_FOLDERS {
                self.folders.remove(0);
            }
        }
        was != open || (open.is_some() && old.is_some_and(|i| i + 1 != self.folders.len()))
    }

    /// Note `p`'s folded headings, if any were left folded.
    pub fn folds_of(&self, p: &Path) -> Option<Vec<(String, usize)>> {
        let p = p.to_string_lossy();
        self.folds.iter().find(|(f, _)| *f == p).map(|e| e.1.clone())
    }

    /// Remember note `p`'s folded headings (none: forget it). True when that changed.
    pub fn set_folds(&mut self, p: &Path, keys: Vec<(String, usize)>) -> bool {
        let key = p.to_string_lossy().into_owned();
        let old = self.folds.iter().position(|(f, _)| *f == key);
        if old.is_some_and(|i| self.folds[i].1 == keys) || (old.is_none() && keys.is_empty()) {
            return false;
        }
        if let Some(i) = old {
            self.folds.remove(i);
        }
        if !keys.is_empty() {
            self.folds.push((key, keys));
            if self.folds.len() > MAX_FOLDERS {
                self.folds.remove(0);
            }
        }
        true
    }

    /// Notes renamed or moved (`moved` gives a path's new one): their folds follow.
    pub fn move_folds(&mut self, moved: impl Fn(&Path) -> Option<PathBuf>) {
        for e in &mut self.folds {
            if let Some(n) = moved(Path::new(&e.0)) {
                e.0 = n.to_string_lossy().into_owned();
            }
        }
    }

    pub fn last_note(&self, w: &WsRef) -> Option<String> {
        self.recent.iter().find(|(r, _)| r.same(w)).and_then(|(_, n)| n.clone())
    }

    pub fn forget(&mut self, w: &WsRef) {
        self.recent.retain(|(r, _)| !r.same(w));
        self.save();
    }

    /// The title of a remote workspace as last seen: in the recent list or a server's joined list (not
    /// the id standing in for an unknown one).
    pub fn known_title(&self, server: &str, id: &str) -> Option<String> {
        let joined = self.server(server).and_then(|s| s.joined.iter().find(|j| j.id == id)).map(|j| j.title.clone());
        let recent = self.recent.iter().find_map(|(r, _)| match r {
            WsRef::Remote { server: s, id: i, title } if s == server && i == id => Some(title.clone()),
            _ => None,
        });
        joined.into_iter().chain(recent).find(|t| !t.is_empty() && t != id)
    }

    /// The recent entry for `w` takes its title.
    pub fn retitle(&mut self, w: &WsRef) {
        let WsRef::Remote { title, .. } = w else { return };
        if title.is_empty() {
            return;
        }
        if let Some(e) = self.recent.iter_mut().find(|(r, _)| r.same(w))
            && e.0 != *w
        {
            e.0 = w.clone();
            self.save();
        }
    }

    /// Recent workspaces on `server` take their titles from its joined list (renamed there).
    pub fn update_titles(&mut self, server: &str, joined: &[Joined]) {
        let mut changed = false;
        for (r, _) in self.recent.iter_mut() {
            if let WsRef::Remote { server: s, id, title } = r
                && s == server
                && let Some(j) = joined.iter().find(|j| j.id == *id && !j.title.is_empty())
                && *title != j.title
            {
                *title = j.title.clone();
                changed = true;
            }
        }
        if changed {
            self.save();
        }
    }

    /// Who the app is connected as on `server`.
    pub fn set_account(&mut self, server: &str, account: Option<String>, token_id: Option<String>) {
        if let Some(s) = self.servers.iter_mut().find(|s| s.url == server)
            && (s.account != account || s.token_id != token_id)
        {
            s.account = account;
            s.token_id = token_id;
            self.save();
        }
    }

    /// The account's email and the server's Google sign-in, as last fetched.
    pub fn set_details(&mut self, server: &str, email: Option<String>, google: Option<bool>) {
        if let Some(s) = self.servers.iter_mut().find(|s| s.url == server) {
            let google = google.unwrap_or(s.google);
            if s.email != email || s.google != google {
                s.email = email;
                s.google = google;
                self.save();
            }
        }
    }

    /// A workspace left or removed on `server`: off its joined list and the recents.
    pub fn drop_workspace(&mut self, server: &str, id: &str) {
        if let Some(s) = self.servers.iter_mut().find(|s| s.url == server) {
            s.joined.retain(|j| j.id != id);
        }
        self.recent.retain(|(r, _)| !matches!(r, WsRef::Remote { server: s, id: i, .. } if s == server && i == id));
        self.save();
    }

    pub fn server(&self, url: &str) -> Option<&Server> {
        self.servers.iter().find(|s| s.url == url)
    }

    pub fn upsert_server(&mut self, url: &str, name: Option<&str>, joined: Option<Vec<Joined>>) {
        let i = match self.servers.iter().position(|s| s.url == url) {
            Some(i) => i,
            None => {
                self.servers.push(Server {
                    url: url.to_string(),
                    name: String::new(),
                    joined: Vec::new(),
                    account: None,
                    token_id: None,
                    email: None,
                    google: false,
                });
                self.servers.len() - 1
            }
        };
        let s = &mut self.servers[i];
        if let Some(n) = name {
            s.name = n.to_string();
        }
        if let Some(j) = joined {
            s.joined = j;
        }
        self.save();
    }

    /// Signed out of `server` (or another account signed in there): its remote workspaces leave the list and
    /// its joined list goes (`keep`: a workspace that stays, open as a guest). Local folders never change.
    pub fn drop_remotes(&mut self, server: &str, keep: Option<&str>) {
        self.recent.retain(|(r, _)| !matches!(r, WsRef::Remote { server: s, id, .. } if s == server && Some(id.as_str()) != keep));
        self.servers.retain(|s| s.url != server);
        // and their folders' open/closed state and folded headings (paths under their virtual roots)
        let root = crate::remote::virtual_root(server, "").to_string_lossy().into_owned();
        let kept = keep.map(|id| crate::remote::virtual_root(server, id).to_string_lossy().into_owned() + "/");
        let gone = |p: &str| p.starts_with(&root) && !kept.as_ref().is_some_and(|k| p.starts_with(k.as_str()));
        self.folders.retain(|(p, _)| !gone(p));
        self.folds.retain(|(p, _)| !gone(p));
        self.save();
    }

    pub fn remove_server(&mut self, url: &str) {
        self.servers.retain(|s| s.url != url);
        self.save();
    }
}

// ---- tokens ----

/// Where app tokens are kept: the Keychain (generic passwords, service "Grimoire", account = the server's
/// origin), with a 0600 `tokens.json` in the support folder as the fallback; or only that file.
#[derive(Clone, Debug)]
pub enum Tokens {
    Keychain { fallback: Option<PathBuf> },
    File(PathBuf),
    /// Nothing stored (headless runs).
    None,
}

impl Tokens {
    pub fn get(&self, server: &str) -> Option<String> {
        match self {
            // a token an older build kept in the file: moved into the Keychain
            Tokens::Keychain { fallback } => keychain_get(server).or_else(|| {
                let f = fallback.as_ref()?;
                let t = file_get(f, server)?;
                let _ = file_remove(f, server);
                keychain_set(server, &t).ok().map(|_| t)
            }),
            Tokens::File(f) => file_get(f, server),
            Tokens::None => None,
        }
    }

    /// Store `token` for `server`; says where it went.
    pub fn set(&self, server: &str, token: &str) -> Result<&'static str, String> {
        match self {
            Tokens::Keychain { fallback } => {
                if let Some(f) = fallback {
                    let _ = file_remove(f, server);
                }
                // the Keychain only: never a file
                keychain_set(server, token)
            }
            Tokens::File(f) => file_set(f, server, token).map(|()| "file"),
            Tokens::None => Ok("memory"),
        }
    }

    pub fn remove(&self, server: &str) {
        match self {
            Tokens::Keychain { fallback } => {
                keychain_remove(server);
                if let Some(f) = fallback {
                    let _ = file_remove(f, server);
                }
            }
            Tokens::File(f) => {
                let _ = file_remove(f, server);
            }
            Tokens::None => {}
        }
    }
}

fn keychain_get(server: &str) -> Option<String> {
    if let Some(t) = cache().get(server) {
        return t.clone();
    }
    let t = keychain::get(server).or_else(|| {
        // a token an older build kept through /usr/bin/security: moved into the app's own item
        let t = cli_get(server)?;
        keychain_set(server, &t).ok().map(|_| t)
    });
    cache().insert(server.to_string(), t.clone());
    t
}

fn keychain_set(server: &str, token: &str) -> Result<&'static str, String> {
    if !valid_token(token) {
        return Err("not a token".into());
    }
    keychain::remove(server);
    cli_remove(server);
    let r = keychain::set(server, token);
    cache().insert(server.to_string(), r.is_ok().then(|| token.to_string()));
    r
}

fn keychain_remove(server: &str) {
    keychain::remove(server);
    cli_remove(server);
    cache().insert(server.to_string(), None);
}

/// What this run read from or wrote to the Keychain, by server (each lookup is a Keychain query otherwise).
fn cache() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, Option<String>>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Option<String>>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// The app's own Keychain items (Security.framework): generic passwords, service "Grimoire", account = the
/// server's origin, accessible after first unlock on this device only
/// (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synced or migrated to another Mac). In the data
/// protection keychain when macOS allows this build to use it, else the login keychain.
pub mod keychain {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use security_framework::passwords::{self, PasswordOptions};

    unsafe extern "C" {
        static kSecAttrAccessible: CFStringRef;
        static kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: CFStringRef;
    }

    /// The app's own items carry this comment: an item without it was made by an older build through
    /// `/usr/bin/security` and is read (without asking) and moved over through that tool.
    const MARK: &str = "grimoire-app-token-v2";

    fn opts(server: &str, protected: bool) -> PasswordOptions {
        let mut o = PasswordOptions::new_generic_password(super::KEYCHAIN_SERVICE, server);
        o.set_comment(MARK);
        if protected {
            o.use_protected_keychain();
        }
        o
    }

    pub fn get(server: &str) -> Option<String> {
        [true, false].into_iter().find_map(|protected| passwords::generic_password(opts(server, protected)).ok()).and_then(|b| String::from_utf8(b).ok()).filter(|t| super::valid_token(t))
    }

    /// Where it went, or why not: the data protection keychain (a build with a keychain entitlement), else the
    /// login keychain, each with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
    pub fn set(server: &str, token: &str) -> Result<&'static str, String> {
        remove(server);
        let mut why = Vec::new();
        for (protected, place) in [(true, "data protection Keychain (this device only, after first unlock)"), (false, "login Keychain (this device only, after first unlock)")] {
            let mut o = opts(server, protected);
            o.set_label(&format!("Grimoire app token ({server})"));
            // SAFETY: Security.framework's constant CFStrings, valid for the process's life.
            #[allow(deprecated)]
            o.query.push(unsafe { (CFString::wrap_under_get_rule(kSecAttrAccessible), CFString::wrap_under_get_rule(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly).into_CFType()) });
            match passwords::set_generic_password_options(token.as_bytes(), o) {
                Ok(()) => return Ok(place),
                Err(e) => why.push(format!("{} {}", if protected { "data protection" } else { "login" }, e.code())),
            }
        }
        Err(why.join(", "))
    }

    pub fn remove(server: &str) {
        for protected in [true, false] {
            let _ = passwords::delete_generic_password_options(opts(server, protected));
        }
    }

    /// Whether the item for `server` is in the data protection keychain, and its `kSecAttrAccessible`
    /// (`--keychain-selftest`).
    pub fn describe(server: &str) -> String {
        for protected in [true, false] {
            if passwords::generic_password(opts(server, protected)).is_ok() {
                return format!("found in the {} keychain", if protected { "data protection" } else { "login" });
            }
        }
        "not found".into()
    }
}

/// An item an older build made through `/usr/bin/security` (its ACL trusts that tool, so reading it there asks
/// nothing).
fn cli_get(server: &str) -> Option<String> {
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", server, "-w"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let t = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && valid_token(&t)).then_some(t)
}

fn cli_remove(server: &str) {
    let _ = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", server])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Tokens are opaque, but only printable ASCII without spaces or quotes is accepted.
pub fn valid_token(t: &str) -> bool {
    !t.is_empty() && t.len() <= 512 && t.bytes().all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\' && b != b'\'')
}

fn file_read(f: &Path) -> serde_json::Map<String, Value> {
    std::fs::read_to_string(f).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn file_get(f: &Path, server: &str) -> Option<String> {
    file_read(f).get(server).and_then(|v| v.as_str()).map(str::to_string)
}

fn file_write(f: &Path, m: serde_json::Map<String, Value>) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = f.with_extension(format!("tmp-{}", std::process::id()));
    let text = Value::Object(m).to_string();
    let r = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut h| {
            h.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            h.write_all(text.as_bytes())
        })
        .and_then(|()| std::fs::rename(&tmp, f));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r.map_err(|e| e.to_string())
}

fn file_set(f: &Path, server: &str, token: &str) -> Result<(), String> {
    let mut m = file_read(f);
    m.insert(server.to_string(), Value::String(token.to_string()));
    file_write(f, m)
}

fn file_remove(f: &Path, server: &str) -> Result<(), String> {
    let mut m = file_read(f);
    if m.remove(server).is_some() {
        file_write(f, m)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("grimoire-ws-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn remote_workspace_urls() {
        let r = parse_remote_url("https://grimoire.exe.xyz/app/notes").unwrap();
        assert_eq!(r, RemoteUrl { server: "https://grimoire.exe.xyz".into(), id: "notes".into(), note: None });
        let r = parse_remote_url("https://grimoire.exe.xyz/app/my%20ws/dir/a%20b.md?x=1#h").unwrap();
        assert_eq!((r.id.as_str(), r.note.as_deref()), ("my ws", Some("dir/a b.md")));
        let r = parse_remote_url("http://100.73.96.98:3000/app/team/").unwrap();
        assert_eq!((r.server.as_str(), r.id.as_str(), r.note), ("http://100.73.96.98:3000", "team", None));
        assert_eq!(parse_remote_url("grimoire.exe.xyz/r/old/x.md").unwrap().note.as_deref(), Some("x.md"));
        assert!(parse_remote_url("https://grimoire.exe.xyz/").is_err());
        assert!(parse_remote_url("https://grimoire.exe.xyz/app").is_err());
        assert!(parse_remote_url("https://grimoire.exe.xyz/app/..").is_err());
        assert!(parse_remote_url("https://grimoire.exe.xyz/settings").is_err());
        assert!(parse_remote_url("mailto:x").is_err());
    }

    #[test]
    fn joined_round_trips_through_json() {
        let v = serde_json::json!({ "id": "a", "title": "A", "kind": "notes", "readOnly": true, "status": "ready", "head": "x", "canRemove": false });
        let parsed = Joined::from_json(&v).unwrap();
        assert_eq!(parsed, Joined { id: "a".into(), title: "A".into(), read_only: true });
        assert_eq!(Joined::from_json(&parsed.to_json()).unwrap(), parsed);
    }

    #[test]
    fn names_and_locations() {
        let home = std::env::var("HOME").unwrap();
        let l = WsRef::Local { path: PathBuf::from(format!("{home}/Documents/Grimoire")) };
        assert_eq!((l.name(), l.location()), ("Grimoire".to_string(), "~/Documents/Grimoire".to_string()));
        let r = WsRef::Remote { server: "http://h:3000".into(), id: "team".into(), title: String::new() };
        assert_eq!((r.name(), r.location()), ("team".to_string(), "h:3000".to_string()));
        assert!(r.same(&WsRef::Remote { server: "http://h:3000".into(), id: "team".into(), title: "Team".into() }));
    }

    #[test]
    fn recents_and_servers_persist() {
        let d = temp("store");
        let mut s = Store::load(Some(d.clone()));
        let a = WsRef::Local { path: d.join("a") };
        let b = WsRef::Remote { server: "https://s".into(), id: "w".into(), title: "W".into() };
        s.touch(&a, Some("x.md".into()));
        s.touch(&b, None);
        s.touch(&a, None);
        s.set_note(&b, Some("dir/n.md".into()));
        s.upsert_server("https://s", Some("Srv"), Some(vec![Joined::new("w", "W")]));
        let t = Store::load(Some(d.clone()));
        assert_eq!(t.recent.len(), 2);
        assert_eq!(t.recent[0], (a.clone(), Some("x.md".into())), "the note survives a touch without one");
        assert_eq!(t.last_note(&b).as_deref(), Some("dir/n.md"));
        assert_eq!(t.server("https://s").unwrap().joined[0].title, "W");
        let mut t = t;
        t.forget(&a);
        t.remove_server("https://s");
        let u = Store::load(Some(d.clone()));
        assert_eq!(u.recent.len(), 1);
        assert!(u.servers.is_empty());
        for i in 0..20 {
            t.touch(&WsRef::Local { path: d.join(format!("f{i}")) }, None);
        }
        let kept = Store::load(Some(d.clone())).recent;
        assert_eq!(kept.iter().filter(|(w, _)| matches!(w, WsRef::Local { .. })).count(), MAX_RECENT);
        assert_eq!(kept.len(), MAX_RECENT + 1, "the remote one stays");
        // no dir: nothing written
        let mut m = Store::load(None);
        m.touch(&a, None);
        assert_eq!(m.recent.len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn remote_titles_are_never_lost_or_empty() {
        let d = temp("titles");
        let mut s = Store::load(Some(d.clone()));
        let untitled = WsRef::Remote { server: "https://s".into(), id: "dffddf-jrpu".into(), title: String::new() };
        s.touch(&untitled, None);
        // saved with the id standing in for the unknown title
        let text = std::fs::read_to_string(d.join("workspaces.json")).unwrap();
        assert!(text.contains(r#""title": "dffddf-jrpu""#), "{text}");
        assert_eq!(s.known_title("https://s", "dffddf-jrpu"), None, "the id isn't a title");
        // the server's title arrives (loaded, or the joined list)
        s.retitle(&WsRef::Remote { server: "https://s".into(), id: "dffddf-jrpu".into(), title: "dffddf".into() });
        assert_eq!(s.known_title("https://s", "dffddf-jrpu").as_deref(), Some("dffddf"));
        // opening it again from a URL (no title) keeps it
        s.touch(&untitled, None);
        assert_eq!(s.recent[0].0.name(), "dffddf");
        // renamed on the server
        s.upsert_server("https://s", Some("S"), None);
        s.update_titles("https://s", &[Joined::new("dffddf-jrpu", "Design")]);
        let t = Store::load(Some(d.clone()));
        assert_eq!(t.recent[0].0.name(), "Design");
        // the account and token id persist
        s.set_account("https://s", Some("confused-noodle".into()), Some("t_1".into()));
        let t = Store::load(Some(d.clone()));
        let srv = t.server("https://s").unwrap();
        assert_eq!((srv.account.as_deref(), srv.token_id.as_deref()), (Some("confused-noodle"), Some("t_1")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn token_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp("tokens");
        let f = d.join("tokens.json");
        let t = Tokens::File(f.clone());
        assert_eq!(t.get("https://s"), None);
        assert_eq!(t.set("https://s", "tok-1").unwrap(), "file");
        t.set("http://h:3000", "tok-2").unwrap();
        assert_eq!(t.get("https://s").as_deref(), Some("tok-1"));
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        t.remove("https://s");
        assert_eq!(t.get("https://s"), None);
        assert_eq!(t.get("http://h:3000").as_deref(), Some("tok-2"));
        assert!(!valid_token("a b") && !valid_token("") && !valid_token("x\"y") && valid_token("gr_abc-123.XYZ"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The Keychain path needs an unlocked login keychain (a GUI session): `cargo test -- --ignored keychain`.
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let d = temp("kc");
        let t = Tokens::Keychain { fallback: Some(d.join("tokens.json")) };
        let server = format!("http://grimoire-test-{}:1", std::process::id());
        assert!(t.set(&server, "kc-token-1").unwrap().contains("Keychain"));
        assert_eq!(t.get(&server).as_deref(), Some("kc-token-1"));
        t.remove(&server);
        assert_eq!(t.get(&server), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
