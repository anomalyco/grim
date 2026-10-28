//! An in-process stand-in for a Grimoire server's REST API beyond notes (the account, workspaces, members,
//! links, app tokens), answering like `src/server/api.ts` does. Headless runs (`--remote-demo=owner` …)
//! and tests drive the app's real request and response handling through it (`remote::Fake`); the notes
//! themselves stay on `remote::Mock`'s relays.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::net;
use crate::remote::Fake;

#[derive(Clone, Debug, Default)]
pub struct FakeWs {
    pub id: String,
    pub title: String,
    /// `notes` or `github`.
    pub kind: String,
    /// Our role (`owner`, `editor`, `viewer`), empty for none.
    pub role: String,
    pub link_access: String,
    pub domain_rule: Option<String>,
    pub joined_via: String,
    pub read_only: bool,
    pub gh: Option<(String, String)>,
    pub members: Vec<Value>,
    /// Joined (listed in `GET /api/workspaces`).
    pub joined: bool,
    pub files: Vec<String>,
}

impl FakeWs {
    pub fn new(id: &str, title: &str, role: &str, via: &str) -> FakeWs {
        FakeWs {
            id: id.into(),
            title: title.into(),
            kind: "notes".into(),
            role: role.into(),
            link_access: "none".into(),
            joined_via: via.into(),
            joined: true,
            files: vec!["README.md".into()],
            ..FakeWs::default()
        }
    }

    fn access(&self) -> &'static str {
        if self.role == "viewer" || self.read_only || self.role.is_empty() { "read" } else { "write" }
    }

    fn item(&self) -> Value {
        json!({
            "id": self.id, "title": self.title, "kind": self.kind, "role": if self.role.is_empty() { Value::Null } else { json!(self.role) },
            "linkAccess": self.link_access, "readOnly": self.read_only, "status": "ready", "head": "abc", "joinedVia": self.joined_via,
        })
    }

    fn details(&self) -> Value {
        let mut v = self.item();
        v["domainRule"] = json!(self.domain_rule);
        v["canRemove"] = json!(self.role == "owner");
        if self.role == "owner" {
            v["members"] = json!(self.members);
        }
        v
    }

    fn repo(&self) -> Value {
        let access = self.access();
        json!({
            "id": self.id, "title": self.title, "kind": self.kind,
            "ghOwner": self.gh.as_ref().map(|g| g.0.clone()), "ghName": self.gh.as_ref().map(|g| g.1.clone()),
            "branch": "main", "status": "ready", "error": null, "readOnly": self.read_only, "access": access,
            "canRemove": self.role == "owner",
            "canShare": if self.read_only { true } else { access == "write" },
        })
    }
}

#[derive(Debug, Default)]
pub struct FakeRest {
    pub origin: String,
    /// `/api/me` (with `token: {id, label}` for the app's token).
    pub me: Value,
    pub google: bool,
    pub github_app: Option<String>,
    pub workspaces: Vec<FakeWs>,
    /// App tokens (`{id, label, createdAt, lastUsedAt}`); the first is the app's own.
    pub tokens: Vec<Value>,
    /// Links made (`{id, url, kind, path, role}`).
    pub shares: Vec<Value>,
    /// Every request: `METHOD path body`.
    pub log: Vec<String>,
    next: u32,
    /// The time "now" (ms since the epoch) for tokens' times.
    pub now: i64,
}

fn ok(v: Value) -> (u16, String) {
    (200, v.to_string())
}

fn err(status: u16, msg: &str) -> (u16, String) {
    (status, json!({ "error": msg }).to_string())
}

impl FakeRest {
    /// A server at `origin` where we're `name` (`email`).
    pub fn new(origin: &str, name: &str, email: &str) -> FakeRest {
        let now = 1_793_000_000_000;
        FakeRest {
            origin: origin.into(),
            me: json!({ "id": "u_me", "login": name, "name": name, "email": email, "avatar": null, "color": "#0090ff", "token": { "id": "t_mac", "label": "Grimoire for Mac" } }),
            google: true,
            tokens: vec![
                json!({ "id": "t_mac", "label": "Grimoire for Mac", "createdAt": now - 3 * 86_400_000, "lastUsedAt": now - 60_000 }),
                json!({ "id": "t_old", "label": "Grimoire for Mac (old laptop)", "createdAt": now - 40 * 86_400_000, "lastUsedAt": null }),
            ],
            now,
            ..FakeRest::default()
        }
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("{prefix}{}", self.next)
    }

    fn ws(&mut self, id: &str) -> Option<&mut FakeWs> {
        self.workspaces.iter_mut().find(|w| w.id == id)
    }

    pub fn handle(&mut self, method: &str, path: &str, body: Option<&Value>) -> (u16, String) {
        self.log.push(format!("{method} {path}{}", body.map(|b| format!(" {b}")).unwrap_or_default()));
        let p = path.split('?').next().unwrap_or(path);
        let segs: Vec<String> = p.split('/').filter(|s| !s.is_empty()).map(net::dec).collect();
        let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
        let b = body.cloned().unwrap_or(Value::Null);
        match (method, segs.as_slice()) {
            ("GET", ["api", "server"]) => ok(json!({ "name": "Grimoire", "publicUrl": self.origin, "signin": "open", "google": self.google, "devLogin": true })),
            ("GET", ["api", "config"]) => ok(json!({ "githubLogin": false, "googleLogin": self.google, "devLogin": true, "githubAppSlug": self.github_app })),
            ("GET", ["api", "me"]) => ok(self.me.clone()),
            ("PATCH", ["api", "me"]) => {
                let name: String = b["name"].as_str().unwrap_or_default().trim().chars().take(60).collect();
                if name.is_empty() {
                    return err(400, "name required");
                }
                self.me["name"] = json!(name);
                ok(json!({ "ok": true, "name": name }))
            }
            ("GET", ["api", "tokens"]) => ok(json!(self.tokens)),
            ("DELETE", ["api", "tokens", id]) => {
                let before = self.tokens.len();
                self.tokens.retain(|t| t["id"] != *id);
                if self.tokens.len() == before { err(404, "token not found") } else { ok(json!({ "ok": true })) }
            }
            ("GET", ["api", "workspaces"]) => ok(json!(self.workspaces.iter().filter(|w| w.joined && !w.role.is_empty()).map(FakeWs::item).collect::<Vec<_>>())),
            ("POST", ["api", "workspaces"]) => {
                let title = b["title"].as_str().unwrap_or_default().trim().to_string();
                if title.is_empty() {
                    return err(400, "title is required");
                }
                let id = format!("{}-{}", title.to_lowercase().replace(' ', "-"), self.id("w"));
                let mut w = FakeWs::new(&id, &title, "owner", "member");
                w.members = vec![json!({ "id": self.id("m_"), "userId": "u_me", "email": self.me["email"], "name": self.me["name"], "role": "owner", "pending": false })];
                let v = w.item();
                self.workspaces.push(w);
                (201, v.to_string())
            }
            ("GET", ["api", "workspaces", id]) => match self.ws(id) {
                Some(w) if !w.role.is_empty() => ok(w.details()),
                _ => err(404, "folder not found"),
            },
            ("PATCH", ["api", "workspaces", id]) => {
                let Some(w) = self.ws(id).filter(|w| !w.role.is_empty()) else { return err(404, "folder not found") };
                if w.role != "owner" {
                    return err(403, "only the folder's owners can do this");
                }
                if let Some(l) = b["linkAccess"].as_str() {
                    if !["none", "view", "edit"].contains(&l) {
                        return err(400, r#"linkAccess must be "none", "view" or "edit""#);
                    }
                    w.link_access = l.into();
                }
                if b.get("domainRule").is_some() {
                    match b["domainRule"].as_str().filter(|s| !s.is_empty()) {
                        None => w.domain_rule = None,
                        Some(r) if r.starts_with("*@") && (r.ends_with("=editor") || r.ends_with("=viewer")) => w.domain_rule = Some(r.into()),
                        Some(_) => return err(400, r#"domainRule must look like "*@company.com=editor" (roles: editor, viewer)"#),
                    }
                }
                let mut v = w.details();
                v["members"] = json!(w.members);
                ok(v)
            }
            ("DELETE", ["api", "workspaces", id, "join"]) => match self.ws(id) {
                Some(w) if !w.role.is_empty() => {
                    w.joined = false;
                    if w.joined_via == "link" {
                        w.role.clear();
                    }
                    ok(json!({ "ok": true }))
                }
                _ => err(404, "folder not found"),
            },
            (_, ["api", "workspaces", id, "members", rest @ ..]) => {
                let new_id = self.id("m_");
                let Some(w) = self.ws(id).filter(|w| !w.role.is_empty()) else { return err(404, "folder not found") };
                if w.role != "owner" {
                    return err(403, "only the folder's owners can do this");
                }
                match (method, rest) {
                    ("GET", []) => ok(json!(w.members)),
                    ("POST", []) => {
                        let email = b["email"].as_str().unwrap_or_default().trim().to_lowercase();
                        let role = b["role"].as_str().unwrap_or("editor").to_string();
                        if !email.contains('@') {
                            return err(400, "enter a valid email address");
                        }
                        let owners = w.members.iter().filter(|m| m["role"] == "owner" && m["pending"] != true).count();
                        if let Some(m) = w.members.iter_mut().find(|m| m["email"] == email.as_str()) {
                            if m["role"] == "owner" && role != "owner" && owners <= 1 {
                                return err(409, "a folder needs an owner; add another owner first");
                            }
                            m["role"] = json!(role);
                            return ok(m.clone());
                        }
                        let m = json!({ "id": new_id, "userId": null, "email": email, "name": null, "role": role, "pending": true });
                        w.members.push(m.clone());
                        ok(m)
                    }
                    ("DELETE", [mid]) => {
                        let owners = w.members.iter().filter(|m| m["role"] == "owner" && m["pending"] != true).count();
                        let Some(i) = w.members.iter().position(|m| m["id"] == *mid) else { return err(404, "member not found") };
                        if w.members[i]["role"] == "owner" && w.members[i]["userId"].is_string() && owners <= 1 {
                            return err(409, "a folder needs an owner; you can't remove the last one");
                        }
                        w.members.remove(i);
                        ok(json!({ "ok": true }))
                    }
                    _ => err(405, "method not allowed"),
                }
            }
            ("POST", ["api", "repos"]) => {
                let Some(gh) = b["github"].as_str() else { return err(400, "title is required") };
                let parts: Vec<&str> = gh.trim_start_matches("https://").trim_start_matches("github.com/").split('/').filter(|s| !s.is_empty()).collect();
                if parts.len() < 2 {
                    return err(400, "Enter a GitHub repo as owner/name or a github.com URL");
                }
                let id = format!("gh-{}-{}", parts[0], parts[1]).to_lowercase();
                let mut w = FakeWs::new(&id, &format!("{}/{}", parts[0], parts[1]), "owner", "member");
                w.kind = "github".into();
                w.read_only = b["readOnly"] != false;
                w.gh = Some((parts[0].into(), parts[1].into()));
                let v = w.repo();
                self.workspaces.push(w);
                (201, v.to_string())
            }
            (_, ["api", "repos", id, rest @ ..]) => {
                let new_share = self.id("s");
                let origin = self.origin.clone();
                let Some(w) = self.ws(id).filter(|w| !w.role.is_empty() || w.link_access != "none") else { return err(404, "repo not found") };
                match (method, rest) {
                    ("GET", []) => ok(w.repo()),
                    ("DELETE", []) => {
                        if w.role != "owner" {
                            return err(403, "only its owners can remove this folder");
                        }
                        let id = w.id.clone();
                        self.workspaces.retain(|x| x.id != id);
                        ok(json!({ "ok": true }))
                    }
                    ("GET", ["tree"]) => ok(json!({ "head": "abc", "files": w.files })),
                    ("POST", ["shares"]) => {
                        let repo = w.repo();
                        if repo["canShare"] != true {
                            return err(403, "you need write access to share this notebook with an agent");
                        }
                        let kind = b["kind"].as_str().unwrap_or("agent").to_string();
                        let role = b["role"].as_str().map(str::to_string);
                        if kind == "note" {
                            let path = b["path"].as_str().unwrap_or_default().to_string();
                            if !w.files.contains(&path) {
                                return err(404, &format!("{path} not found"));
                            }
                            if role.as_deref() == Some("editor") && repo["access"] != "write" {
                                return err(403, "you can only share this note read-only");
                            }
                            let role = role.unwrap_or_else(|| "editor".into());
                            let url = format!("{origin}/app/{}/{}?share={new_share}", net::enc(&w.id), path.split('/').map(net::enc).collect::<Vec<_>>().join("/"));
                            let v = json!({ "id": new_share, "url": url, "kind": "note", "path": path, "role": role });
                            self.shares.push(v.clone());
                            return (201, v.to_string());
                        }
                        if b["reuse"] == true
                            && let Some(s) = self.shares.iter().find(|s| s["kind"] == "agent" && s["repo"] == *id)
                        {
                            return ok(s.clone());
                        }
                        let v = json!({ "id": new_share, "url": format!("{origin}/s/{new_share}"), "kind": "agent", "path": null, "role": "editor", "repo": id });
                        self.shares.push(v.clone());
                        (201, v.to_string())
                    }
                    _ => err(404, "not found"),
                }
            }
            _ => err(404, "not found"),
        }
    }
}

/// The app's way into a fake server.
pub fn transport(rest: &Arc<Mutex<FakeRest>>) -> Fake {
    let r = rest.clone();
    Fake(Arc::new(move |m: &str, p: &str, b: Option<&Value>| r.lock().unwrap().handle(m, p, b)))
}
