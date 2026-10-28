//! An in-process stand-in for a Grimoire server's REST API beyond notes (the account, folders, agent links,
//! app tokens), answering like `src/server/api.ts` does. Headless runs (`--remote-demo=owner` …) and tests
//! drive the app's real request and response handling through it (`remote::Fake`); the notes themselves stay
//! on `remote::Mock`'s relays. Every folder is public: anyone signed in opens and edits it (read-only GitHub
//! copies are read-only); only its maker may remove it.

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
    /// We made it (`canRemove`).
    pub mine: bool,
    pub read_only: bool,
    pub gh: Option<(String, String)>,
    /// Joined (listed in `GET /api/workspaces`).
    pub joined: bool,
    pub files: Vec<String>,
}

impl FakeWs {
    pub fn new(id: &str, title: &str, mine: bool) -> FakeWs {
        FakeWs { id: id.into(), title: title.into(), kind: "notes".into(), mine, joined: true, files: vec!["README.md".into()], ..FakeWs::default() }
    }

    fn item(&self) -> Value {
        json!({ "id": self.id, "title": self.title, "kind": self.kind, "readOnly": self.read_only, "status": "ready", "head": "abc", "canRemove": self.mine })
    }

    fn repo(&self) -> Value {
        json!({
            "id": self.id, "title": self.title, "kind": self.kind,
            "ghOwner": self.gh.as_ref().map(|g| g.0.clone()), "ghName": self.gh.as_ref().map(|g| g.1.clone()),
            "branch": "main", "status": "ready", "error": null, "readOnly": self.read_only, "canRemove": self.mine,
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
    /// Agent links made (`{id, url, repo}`), one per folder.
    pub shares: Vec<Value>,
    /// Every request: `METHOD path body`.
    pub log: Vec<String>,
    next: u32,
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
        FakeRest {
            origin: origin.into(),
            me: json!({ "id": "u_me", "login": name, "name": name, "email": email, "avatar": null, "color": "#0090ff", "token": { "id": "t_mac", "label": "Grimoire for Mac" } }),
            google: true,
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
            ("GET", ["api", "server"]) => ok(json!({ "name": "Grimoire", "publicUrl": self.origin, "google": self.google, "devLogin": true, "version": "2026-10-28.public" })),
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
            ("DELETE", ["api", "tokens", _]) => ok(json!({ "ok": true })),
            ("GET", ["api", "workspaces"]) => ok(json!(self.workspaces.iter().filter(|w| w.joined).map(FakeWs::item).collect::<Vec<_>>())),
            ("POST", ["api", "workspaces"]) => {
                let title = b["title"].as_str().unwrap_or_default().trim().to_string();
                if title.is_empty() {
                    return err(400, "title is required");
                }
                let id = format!("{}-{}", title.to_lowercase().replace(' ', "-"), self.id("w"));
                let w = FakeWs::new(&id, &title, true);
                let v = w.item();
                self.workspaces.push(w);
                (201, v.to_string())
            }
            ("GET", ["api", "workspaces", id]) => match self.ws(id) {
                Some(w) => {
                    let mut v = w.item();
                    v["ownerId"] = json!(if w.mine { "u_me" } else { "u_other" });
                    ok(v)
                }
                None => err(404, "folder not found"),
            },
            ("DELETE", ["api", "workspaces", id, "join"]) => match self.ws(id) {
                Some(w) => {
                    w.joined = false;
                    ok(json!({ "ok": true }))
                }
                None => err(404, "folder not found"),
            },
            ("POST", ["api", "repos"]) => {
                let Some(gh) = b["github"].as_str() else { return err(400, "title is required") };
                let parts: Vec<&str> = gh.trim_start_matches("https://").trim_start_matches("github.com/").split('/').filter(|s| !s.is_empty()).collect();
                if parts.len() < 2 {
                    return err(400, "Enter a GitHub repo as owner/name or a github.com URL");
                }
                let id = format!("gh-{}-{}", parts[0], parts[1]).to_lowercase();
                let mut w = FakeWs::new(&id, &format!("{}/{}", parts[0], parts[1]), true);
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
                let Some(w) = self.ws(id) else { return err(404, "repo not found") };
                match (method, rest) {
                    ("GET", []) => ok(w.repo()),
                    ("DELETE", []) => {
                        if !w.mine {
                            return err(403, "only whoever made this folder can remove it");
                        }
                        let id = w.id.clone();
                        self.workspaces.retain(|x| x.id != id);
                        ok(json!({ "ok": true }))
                    }
                    ("GET", ["tree"]) => ok(json!({ "head": "abc", "files": w.files })),
                    ("POST", ["shares"]) => {
                        if let Some(s) = self.shares.iter().find(|s| s["repo"] == *id) {
                            return ok(json!({ "id": s["id"], "url": s["url"] }));
                        }
                        let url = format!("{origin}/a/{new_share}");
                        self.shares.push(json!({ "id": new_share, "url": url, "repo": id }));
                        (201, json!({ "id": new_share, "url": url }).to_string())
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
