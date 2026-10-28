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
        _ => return Err("Paste a folder URL like https://server/app/folder".into()),
    };
    let Some(id) = rest.first().map(|s| net::dec(s)).filter(|s| !s.is_empty() && s != "." && s != "..") else {
        return Err("That URL names no folder (https://server/app/folder)".into());
    };
    let note = (rest.len() > 1).then(|| rest[1..].iter().map(|s| net::dec(s)).collect::<Vec<_>>().join("/"));
    Ok(RemoteUrl { server: u.origin(), id, note })
}

/// A workspace joined on a server (`GET /api/workspaces`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Joined {
    pub id: String,
    pub title: String,
    /// `owner`, `editor`, `viewer`, or empty (servers answer `null` for none).
    pub role: String,
    pub read_only: bool,
    /// How it was joined: `member`, `domain` or `link` (empty when the server doesn't say).
    pub joined_via: String,
    /// `canLeave`: false for the last owner (`None` when the server doesn't say).
    pub can_leave: Option<bool>,
}

impl Joined {
    pub fn from_json(v: &Value) -> Option<Joined> {
        Some(Joined {
            id: v["id"].as_str()?.to_string(),
            title: v["title"].as_str().unwrap_or_default().to_string(),
            role: v["role"].as_str().unwrap_or_default().to_string(),
            read_only: v["readOnly"].as_bool().unwrap_or(false),
            joined_via: v["joinedVia"].as_str().unwrap_or_default().to_string(),
            can_leave: v["canLeave"].as_bool(),
        })
    }

    fn to_json(&self) -> Value {
        json!({ "id": self.id, "title": self.title, "role": self.role, "readOnly": self.read_only, "joinedVia": self.joined_via, "canLeave": self.can_leave })
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

    pub fn save(&self) {
        let Some(d) = self.dir.as_ref().filter(|_| !self.read_only) else { return };
        let v = json!({
            "recent": self.recent.iter().map(|(w, n)| w.to_json(n.as_deref())).collect::<Vec<_>>(),
            "servers": self.servers.iter().map(|s| json!({
                "url": s.url, "name": s.name, "joined": s.joined.iter().map(Joined::to_json).collect::<Vec<_>>(),
                "account": s.account, "tokenId": s.token_id, "email": s.email, "google": s.google,
            })).collect::<Vec<_>>(),
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
            Tokens::Keychain { fallback } => keychain_get(server).or_else(|| fallback.as_ref().and_then(|f| file_get(f, server))),
            Tokens::File(f) => file_get(f, server),
            Tokens::None => None,
        }
    }

    /// Store `token` for `server`; says where it went.
    pub fn set(&self, server: &str, token: &str) -> Result<&'static str, String> {
        match self {
            Tokens::Keychain { fallback } => {
                if keychain_set(server, token) && keychain_get(server).as_deref() == Some(token) {
                    if let Some(f) = fallback {
                        let _ = file_remove(f, server);
                    }
                    return Ok("keychain");
                }
                let f = fallback.as_ref().ok_or("the Keychain refused the token")?;
                file_set(f, server, token).map(|()| "file")
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
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", server, "-w"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let t = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !t.is_empty()).then_some(t)
}

/// Through `security -i` (commands on stdin), so the token never shows in a process list.
fn keychain_set(server: &str, token: &str) -> bool {
    if !valid_token(token) || server.contains(['"', '\n', '\\']) {
        return false;
    }
    let cmd = format!("add-generic-password -U -s {KEYCHAIN_SERVICE} -a \"{server}\" -l \"Grimoire app token ({server})\" -w {token}\n");
    let Ok(mut child) =
        Command::new("/usr/bin/security").arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(cmd.as_bytes());
    }
    child.wait().is_ok()
}

fn keychain_remove(server: &str) {
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
        let v = serde_json::json!({ "id": "a", "title": "A", "role": "editor", "readOnly": false, "joinedVia": "domain", "canLeave": true });
        let parsed = Joined::from_json(&v).unwrap();
        assert_eq!((parsed.role.as_str(), parsed.joined_via.as_str(), parsed.can_leave), ("editor", "domain", Some(true)));
        assert_eq!(Joined::from_json(&serde_json::json!({ "id": "b" })).unwrap().can_leave, None);
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
        s.upsert_server("https://s", Some("Srv"), Some(vec![Joined { id: "w".into(), title: "W".into(), role: "editor".into(), read_only: false, ..Joined::default() }]));
        let t = Store::load(Some(d.clone()));
        assert_eq!(t.recent.len(), 2);
        assert_eq!(t.recent[0], (a.clone(), Some("x.md".into())), "the note survives a touch without one");
        assert_eq!(t.last_note(&b).as_deref(), Some("dir/n.md"));
        assert_eq!(t.server("https://s").unwrap().joined[0].role, "editor");
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
        s.update_titles("https://s", &[Joined { id: "dffddf-jrpu".into(), title: "Design".into(), role: "owner".into(), read_only: false, ..Joined::default() }]);
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
        assert_eq!(t.set(&server, "kc-token-1").unwrap(), "keychain");
        assert_eq!(t.get(&server).as_deref(), Some("kc-token-1"));
        t.remove(&server);
        assert_eq!(t.get(&server), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
