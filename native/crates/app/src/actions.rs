//! What the switcher's items and the dialogs do, through the same server endpoints as the web app
//! (`src/client/api.ts`): New workspace, Add GitHub repo, Share workspace (members, invites, link access,
//! a domain rule), Share with agent, the note's Share link, Refresh, Leave, Remove, Change name, Settings
//! (connected apps), Sign out. Requests run on a thread (`Backend::Net`) or in place against the mock
//! server's REST stand-in; their answers come back to the UI thread.

use std::path::PathBuf;

use rune::Tx;
use serde_json::{Value, json};

use crate::App;
use crate::dialogs::{self, AddGitHub, Agent, Confirm, ConfirmKind, Dialog, Prompt, PromptKind, Settings, ShareNote, ShareWs};
use crate::menu::Act;
use crate::net;
use crate::remote::{Api, ApiError, Backend};
use crate::workspaces::{self, WsRef};

/// `<server>/app/<workspace>` (the web app's `workspaceUrl`).
pub fn workspace_url(server: &str, id: &str) -> String {
    format!("{server}/app/{}", net::enc(id))
}

fn host(server: &str) -> String {
    WsRef::Remote { server: server.to_string(), id: String::new(), title: String::new() }.location()
}

/// An error the way the web app's `errorMessage` shows it.
fn message(e: &ApiError) -> String {
    match e {
        ApiError::Unauthorized => "Not signed in".into(),
        e => e.to_string(),
    }
}

impl App {
    /// Run `f` against the server and hand its answer to `done` on the UI thread: on a thread for real
    /// servers, in place for the mock server.
    pub fn api_task<T: Send + 'static>(
        &mut self,
        api: Api,
        f: impl FnOnce(&Api) -> Result<T, ApiError> + Send + 'static,
        done: impl FnOnce(&mut App, Result<T, ApiError>, &mut Tx) + Send + 'static,
        tx: &mut Tx,
    ) {
        if api.fake.is_some() {
            let r = f(&api);
            done(self, r, tx);
            return;
        }
        if let Backend::Net(h) = &self.backend {
            let h = h.clone();
            std::thread::spawn(move || {
                let r = f(&api);
                h.update(move |app, tx| {
                    done(app, r, tx);
                    app.handled(tx);
                });
            });
        }
    }

    /// The open remote workspace: its API, id and title.
    fn open_ws(&self) -> Option<(Api, String, String)> {
        let r = self.remote.as_ref()?;
        Some((r.api.clone(), r.id().to_string(), r.ws.name()))
    }

    /// The time now (ms since the epoch); the mock server's clock in headless runs, so snapshots stay put.
    pub fn now_epoch(&self) -> i64 {
        if let Backend::Mock(m) = &self.backend
            && let Some(r) = &m.borrow().rest
        {
            return r.lock().unwrap().now;
        }
        dialogs::now_ms()
    }

    fn prompt(&mut self, p: Prompt) {
        self.dialog = Some(Dialog::Prompt(p));
    }

    fn confirm_dialog(&mut self, kind: ConfirmKind, title: &str, message: String, confirm: &str) {
        self.dialog = Some(Dialog::Confirm(Confirm { kind, title: title.into(), message, confirm: confirm.into(), danger: true }));
    }

    /// A menu item was chosen.
    pub fn run_act(&mut self, act: Act, tx: &mut Tx) {
        self.close_switcher();
        self.blur_filter();
        self.marked = None;
        let server = self.remote.as_ref().map(|r| r.api.server.clone());
        match act {
            Act::OpenFolder => self.open_folder_dialog(),
            Act::AddRemote => self.prompt(
                Prompt::new(PromptKind::AddRemote, "Add remote workspace", "Workspace URL", "", "Add workspace")
                    .hint("Paste the link to a workspace on any Grimoire server (a link to one of its notes works too).")
                    .placeholder("https://grimoire.example.com/app/notes"),
            ),
            Act::NewWorkspace => self.prompt(Prompt::new(PromptKind::NewWorkspace, "New workspace", "Name", "", "Create").hint("A folder of Markdown notes you can share.")),
            Act::AddGitHub => self.add_github_dialog(tx),
            Act::ShareWorkspace => self.share_workspace_dialog(tx),
            Act::ShareAgent => self.agent_dialog(tx),
            Act::OpenGitHub => {
                if let Some(r) = &self.remote
                    && let (Some(o), Some(n)) = (r.repo["ghOwner"].as_str(), r.repo["ghName"].as_str())
                {
                    let url = format!("https://github.com/{o}/{n}");
                    self.launch(&url);
                }
            }
            Act::Refresh => self.refresh_workspace(tx),
            Act::Leave => {
                if let Some((api, id, title)) = self.open_ws() {
                    let via = self.store.server(&api.server).and_then(|s| s.joined.iter().find(|j| j.id == id)).map(|j| j.joined_via.clone()).unwrap_or_default();
                    let how = if via == "link" { "You can open it again with its link." } else { "You'll need to be invited again to get back in." };
                    self.confirm_dialog(ConfirmKind::Leave { server: api.server, id, title: title.clone() }, "Leave workspace", format!("Leave “{title}”? {how}"), "Leave");
                }
            }
            Act::Remove => {
                if let Some((api, id, title)) = self.open_ws() {
                    self.confirm_dialog(
                        ConfirmKind::Remove { server: api.server, id, title: title.clone() },
                        "Remove workspace",
                        format!("Remove “{title}” from Grimoire for everyone who has it?"),
                        "Remove",
                    );
                }
            }
            Act::ChangeName => {
                if let Some(s) = server {
                    let name = self.store.server(&s).and_then(|x| x.account.clone()).or_else(|| self.remote.as_ref().and_then(|r| r.account.clone())).unwrap_or_default();
                    self.prompt(Prompt::new(PromptKind::ChangeName, "Change name", "Name", &name, "Save").hint("Shown on your cursor and on your commits."));
                }
            }
            Act::Settings => self.settings_dialog(tx),
            Act::SwitchAccount => {
                if let Some(s) = server {
                    self.start_connect(&s);
                }
            }
            Act::SignOut => {
                if let Some(s) = server {
                    let h = host(&s);
                    self.confirm_dialog(
                        ConfirmKind::SignOut { server: s },
                        "Sign out",
                        format!("Sign out of {h}? Grimoire for Mac's access to your account there is revoked. You can connect again later."),
                        "Sign out",
                    );
                }
            }
            Act::Reconnect(s) => self.start_connect(&s),
            Act::Forget(s) => self.disconnect(&s, tx),
        }
    }

    /// "Open folder…" (from the menu, local or remote): the system folder picker on a thread, or the path
    /// dialog when headless or the picker can't run.
    pub fn open_folder_dialog(&mut self) {
        let Backend::Net(h) = &self.backend else {
            self.open_path_dialog();
            return;
        };
        let (h, pick) = (h.clone(), self.picker);
        std::thread::spawn(move || match pick() {
            Ok(Some(p)) => h.update(move |app, tx| {
                app.open_local(PathBuf::from(p), tx);
                app.handled(tx);
            }),
            Ok(None) => {}
            Err(_) => h.update(|app, tx| {
                app.open_path_dialog();
                app.handled(tx);
            }),
        });
    }

    fn open_path_dialog(&mut self) {
        self.prompt(Prompt::new(PromptKind::OpenPath, "Open folder", "Folder", "", "Open").hint("Type a folder path (~ for your home folder).").placeholder("~/path/to/folder"));
    }

    fn refresh_workspace(&mut self, tx: &mut Tx) {
        let Some((api, id, _)) = self.open_ws() else { return };
        let session = self.remote.as_ref().map_or(0, |r| r.session);
        self.api_task(
            api,
            move |api| {
                let refreshed = api.refresh(&id).map(|_| ());
                Ok::<_, ApiError>((refreshed, api.tree(&id)))
            },
            move |app, r, _tx| {
                let Ok((refreshed, tree)) = r else { return };
                if let Err(e) = refreshed {
                    app.show_toast(message(&e));
                }
                if let Ok(list) = tree {
                    app.remote_tree(session, list);
                }
            },
            tx,
        );
    }

    fn add_github_dialog(&mut self, tx: &mut Tx) {
        let Some((api, _, _)) = self.open_ws() else { return };
        let mut input = dialogs::field_edit("");
        input.focused = true;
        self.dialog = Some(Dialog::AddGitHub(AddGitHub { server: api.server.clone(), input, edit: false, app_slug: None, status: None, error: None, busy: false }));
        self.api_task(
            api,
            |api| api.config(),
            |app, r, _| {
                if let (Ok(c), Some(Dialog::AddGitHub(g))) = (r, &mut app.dialog) {
                    g.app_slug = c["githubAppSlug"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
                }
            },
            tx,
        );
    }

    fn share_workspace_dialog(&mut self, tx: &mut Tx) {
        let Some((api, id, title)) = self.open_ws() else { return };
        let google = self.store.server(&api.server).is_some_and(|s| s.google);
        self.dialog = Some(Dialog::ShareWs(Box::new(ShareWs {
            server: api.server.clone(),
            id,
            title,
            google,
            details: None,
            members: Vec::new(),
            load_error: None,
            error: None,
            email: dialogs::field_edit(""),
            invite_role: "editor".into(),
            domain: dialogs::field_edit(""),
            domain_role: "editor".into(),
            copied: false,
        })));
        // the server's Google sign-in, fresh
        let a2 = api.clone();
        self.api_task(
            a2,
            |api| api.server_info(),
            |app, r, _| {
                if let (Ok(info), Some(Dialog::ShareWs(s))) = (r, &mut app.dialog) {
                    s.google = info["google"].as_bool().unwrap_or(false);
                    let (server, g) = (s.server.clone(), s.google);
                    let email = app.store.server(&server).and_then(|x| x.email.clone());
                    app.store.set_details(&server, email, Some(g));
                }
            },
            tx,
        );
        self.load_share(true, tx);
    }

    /// (Re)load the share dialog's workspace details and members (`fresh`: the domain field takes the rule).
    fn load_share(&mut self, fresh: bool, tx: &mut Tx) {
        let Some(Dialog::ShareWs(s)) = &self.dialog else { return };
        let (server, id) = (s.server.clone(), s.id.clone());
        let api = self.api_for_open(&server);
        self.api_task(
            api,
            move |api| {
                let d = api.workspace(&id)?;
                let m = api.members(&id)?;
                Ok((d, m))
            },
            move |app, r, _| {
                let Some(Dialog::ShareWs(s)) = &mut app.dialog else { return };
                match r {
                    Ok((d, mut m)) => {
                        if m.is_empty()
                            && let Some(a) = d["members"].as_array()
                        {
                            m = a.clone();
                        }
                        s.members = m;
                        if fresh || s.details.is_none() {
                            let rule = d["domainRule"].as_str().unwrap_or_default();
                            let (dom, role) = rule.split_once('=').unwrap_or((rule, ""));
                            s.domain = dialogs::field_edit(dom);
                            s.domain_role = if role == "viewer" { "viewer".into() } else { "editor".into() };
                        }
                        s.details = Some(d);
                        s.error = None;
                    }
                    Err(e) if s.details.is_none() => s.load_error = Some(message(&e)),
                    Err(e) => s.error = Some(message(&e)),
                }
            },
            tx,
        );
    }

    /// The API for `server`: the open workspace's (its token, or the mock's stand-in) when it's there.
    fn api_for_open(&self, server: &str) -> Api {
        match &self.remote {
            Some(r) if r.api.server == server => r.api.clone(),
            _ => self.api_for(server),
        }
    }

    fn agent_dialog(&mut self, tx: &mut Tx) {
        let Some((api, id, title)) = self.open_ws() else { return };
        let read_only = self.remote.as_ref().is_some_and(|r| r.repo["readOnly"] == true);
        self.dialog = Some(Dialog::Agent(Agent { title, read_only, prompt: None, error: None, copied: false }));
        self.api_task(
            api,
            move |api| api.agent_link(&id),
            |app, r, _| {
                if let Some(Dialog::Agent(a)) = &mut app.dialog {
                    match r {
                        Ok(url) => a.prompt = Some(dialogs::agent_prompt(&url)),
                        Err(e) => a.error = Some(message(&e)),
                    }
                }
            },
            tx,
        );
    }

    /// The note header's "Share": a link to the open remote note.
    pub fn share_note_dialog(&mut self) {
        self.close_switcher();
        let Some(r) = &self.remote else { return };
        let Some(path) = r.note.clone() else { return };
        let writable = r.repo["access"] == "write" && r.repo["readOnly"] != true;
        self.dialog = Some(Dialog::ShareNote(ShareNote {
            server: r.api.server.clone(),
            id: r.id().to_string(),
            title: r.ws.name(),
            path,
            writable,
            role: "viewer".into(),
            url: None,
            error: None,
            busy: false,
            copied: false,
        }));
    }

    /// Whether the note header shows "Share" (a remote note is open; the web app's `shareNoteBtn`).
    pub fn can_share_note(&self) -> bool {
        self.remote.as_ref().is_some_and(|r| r.loaded && r.problem.is_none() && r.note.is_some() && (r.api.token.is_some() || r.api.fake.is_some()))
    }

    fn settings_dialog(&mut self, tx: &mut Tx) {
        let Some((api, _, _)) = self.open_ws() else { return };
        self.dialog = Some(Dialog::Settings(Settings { server: api.server.clone(), tokens: None, error: None }));
        self.load_tokens(tx);
    }

    fn load_tokens(&mut self, tx: &mut Tx) {
        let Some(Dialog::Settings(s)) = &self.dialog else { return };
        let api = self.api_for_open(&s.server.clone());
        self.api_task(
            api,
            |api| api.tokens(),
            |app, r, _| {
                if let Some(Dialog::Settings(s)) = &mut app.dialog {
                    match r {
                        Ok(t) => {
                            s.tokens = Some(t);
                            s.error = None;
                        }
                        Err(ApiError::NotFound(_)) => s.error = Some("This server doesn't support connected apps yet.".into()),
                        Err(e) => s.error = Some(message(&e)),
                    }
                }
            },
            tx,
        );
    }

    /// Leave the open workspace for the next one after it went away here (left, removed): another joined on
    /// the same server, else a local folder, else the sample note.
    fn after_leaving(&mut self, server: &str, id: &str, tx: &mut Tx) {
        self.store.drop_workspace(server, id);
        let open = self.current.as_ref().is_some_and(|c| matches!(c, WsRef::Remote { server: s, id: i, .. } if s == server && i == id));
        if open {
            let next = self.store.server(server).and_then(|s| s.joined.iter().find(|j| j.id != id).cloned());
            match next {
                Some(j) => self.open_remote(server.to_string(), j.id, j.title, None, tx),
                None => {
                    let w = WsRef::Remote { server: server.to_string(), id: id.to_string(), title: String::new() };
                    self.remove_recent(&w, tx);
                }
            }
        }
        self.refresh_joined(server);
    }
}

/// Return or the dialog's main button.
pub fn submit_prompt(app: &mut App, tx: &mut Tx) {
    let Some(Dialog::Prompt(p)) = &mut app.dialog else { return };
    let v = p.input.text.trim().to_string();
    if v.is_empty() {
        return;
    }
    match p.kind {
        PromptKind::AddRemote => match workspaces::parse_remote_url(&v) {
            Ok(u) => {
                app.dialog = None;
                app.open_remote(u.server, u.id, String::new(), u.note, tx);
            }
            Err(_) => p.error = Some("That isn't a workspace link. It looks like https://server/app/workspace.".into()),
        },
        PromptKind::OpenPath => {
            let path = expand_tilde(&v);
            if path.is_dir() {
                app.dialog = None;
                app.open_local(path, tx);
            } else {
                p.error = Some(format!("No folder at {v}"));
            }
        }
        PromptKind::NewWorkspace => {
            app.dialog = None;
            let Some((api, _, _)) = app.open_ws() else { return };
            let server = api.server.clone();
            app.api_task(
                api,
                move |api| api.create_workspace(&v),
                move |app, r, tx| match r {
                    Ok((id, title)) => {
                        app.refresh_joined(&server);
                        app.open_remote(server.clone(), id, title.clone(), None, tx);
                        app.show_toast(format!("Created “{title}”"));
                    }
                    Err(e) => app.show_toast(message(&e)),
                },
                tx,
            );
        }
        PromptKind::ChangeName => {
            app.dialog = None;
            let Some((api, id, title)) = app.open_ws() else { return };
            let old = app.store.server(&api.server).and_then(|s| s.account.clone());
            if old.as_deref() == Some(v.as_str()) {
                return;
            }
            let server = api.server.clone();
            app.api_task(
                api,
                move |api| api.set_name(&v),
                move |app, r, tx| match r {
                    Ok(name) => {
                        let token_id = app.store.server(&server).and_then(|s| s.token_id.clone());
                        app.store.set_account(&server, Some(name.clone()), token_id);
                        if let Some(r) = app.remote.as_mut() {
                            r.account = Some(name.clone());
                            r.me["name"] = json!(name);
                        }
                        // like the web app's reload: the room again, with the new name on our cursor
                        let note = app.remote.as_ref().and_then(|r| r.note.clone());
                        app.open_remote(server, id, title, note, tx);
                    }
                    Err(e) => app.show_toast(message(&e)),
                },
                tx,
            );
        }
    }
}

fn expand_tilde(s: &str) -> PathBuf {
    match s.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => PathBuf::from(format!("{}{rest}", std::env::var("HOME").unwrap_or_default())),
        _ => PathBuf::from(s),
    }
}

/// The confirm dialog's button.
pub fn confirm(app: &mut App, tx: &mut Tx) {
    let Some(Dialog::Confirm(c)) = app.dialog.take() else { return };
    match c.kind {
        ConfirmKind::SignOut { server } => app.disconnect(&server, tx),
        ConfirmKind::Leave { server, id, title } => {
            let api = app.api_for_open(&server);
            let i2 = id.clone();
            app.api_task(
                api,
                move |api| api.leave(&i2),
                move |app, r, tx| match r {
                    Ok(()) => {
                        app.after_leaving(&server, &id, tx);
                        app.show_toast(format!("You left “{title}”."));
                    }
                    Err(e) => app.show_toast(message(&e)),
                },
                tx,
            );
        }
        ConfirmKind::Remove { server, id, .. } => {
            let api = app.api_for_open(&server);
            let i2 = id.clone();
            app.api_task(
                api,
                move |api| api.remove_workspace(&i2),
                move |app, r, tx| match r {
                    Ok(()) => app.after_leaving(&server, &id, tx),
                    Err(e) => app.show_toast(message(&e)),
                },
                tx,
            );
        }
    }
}

// ---- Add GitHub repo ----

/// A GitHub repo reference ("owner/name", github.com URLs, SSH remotes): owner, name, `tree`/`blob`, and
/// the segments after it (the web app's `parseGitHubRepo`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubRef {
    pub owner: String,
    pub name: String,
    pub kind: Option<String>,
    pub rest: Vec<String>,
}

pub fn parse_github(input: &str) -> Option<GitHubRef> {
    let s = input.trim();
    if s.is_empty() || s.len() > 2000 || s.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let path: String = if let Some(rest) = s.strip_prefix("git@github.com:").or_else(|| s.strip_prefix("git@GitHub.com:")) {
        rest.to_string()
    } else if let Some((scheme, after)) = s.split_once("://") {
        if !["https", "http", "ssh", "git"].contains(&scheme.to_lowercase().as_str()) {
            return None;
        }
        let (hostpart, path) = after.split_once('/').unwrap_or((after, ""));
        let hostname = hostpart.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("").to_lowercase();
        if hostname != "github.com" && hostname != "www.github.com" {
            return None;
        }
        path.split(['?', '#']).next().unwrap_or("").to_string()
    } else {
        let lower = s.to_lowercase();
        let t = if lower.starts_with("www.github.com/") { &s[15..] } else if lower.starts_with("github.com/") { &s[11..] } else { s };
        t.split(['?', '#']).next().unwrap_or("").to_string()
    };
    let parts: Vec<String> = path.split('/').filter(|p| !p.is_empty()).map(net::dec).collect();
    if parts.len() < 2 {
        return None;
    }
    let owner = parts[0].clone();
    let name = parts[1].strip_suffix(".git").or_else(|| parts[1].strip_suffix(".GIT")).unwrap_or(&parts[1]).to_string();
    let owner_ok = !owner.is_empty()
        && owner.len() <= 39
        && owner.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let name_ok = !name.is_empty() && name.len() <= 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) && name != "." && name != "..";
    if !owner_ok || !name_ok {
        return None;
    }
    let kind = parts.get(2).filter(|k| *k == "tree" || *k == "blob").cloned();
    let rest = if kind.is_some() { parts[3..].to_vec() } else { Vec::new() };
    Some(GitHubRef { owner, name, kind, rest })
}

/// The note to open in a repo's files (the web app's `pickNote`): the file asked for, else the folder's
/// README or its shallowest note, else Welcome.md, the root README, the shallowest note.
pub fn pick_note(files: &[String], file: Option<&str>, folder: Option<&str>) -> Option<String> {
    if let Some(f) = file.filter(|f| files.iter().any(|x| x == f)) {
        return Some(f.to_string());
    }
    let folder = folder.map(str::to_string).or_else(|| file.map(|f| f.rsplit_once('/').map_or(String::new(), |(d, _)| d.to_string()))).unwrap_or_default();
    let readme = |dir: &str| {
        files
            .iter()
            .find(|f| {
                let rest = if dir.is_empty() { Some(f.as_str()) } else { f.strip_prefix(&format!("{dir}/")) };
                rest.is_some_and(|r| {
                    let l = r.to_lowercase();
                    ["readme.md", "readme.markdown", "readme.mdx"].contains(&l.as_str())
                })
            })
            .cloned()
    };
    let shallowest = |list: Vec<&String>| {
        let mut l = list;
        l.sort_by(|a, b| a.split('/').count().cmp(&b.split('/').count()).then(a.cmp(b)));
        l.first().map(|s| s.to_string())
    };
    if !folder.is_empty() {
        let inside: Vec<&String> = files.iter().filter(|f| f.starts_with(&format!("{folder}/"))).collect();
        if let Some(n) = readme(&folder).or_else(|| shallowest(inside)) {
            return Some(n);
        }
    }
    files.iter().find(|f| *f == "Welcome.md").cloned().or_else(|| readme("")).or_else(|| shallowest(files.iter().collect()))
}

pub fn submit_github(app: &mut App, tx: &mut Tx) {
    let Some(Dialog::AddGitHub(g)) = &mut app.dialog else { return };
    if g.busy {
        return;
    }
    let raw = g.input.text.trim().to_string();
    let Some(r) = parse_github(&raw) else {
        g.status = None;
        g.error = Some("Enter a GitHub URL (https://github.com/owner/name) or owner/name.".into());
        return;
    };
    g.busy = true;
    g.error = None;
    g.status = Some(format!("Looking up {}/{}…", r.owner, r.name));
    let read_only = !g.edit;
    let server = g.server.clone();
    let api = app.api_for_open(&server);
    app.api_task(api, move |api| api.add_github(&raw, read_only), move |app, res, tx| github_step(app, r, res, tx), tx);
}

/// The repo as it is now: still importing (look again in a second), failed, or ready (open its note).
fn github_step(app: &mut App, r: GitHubRef, res: Result<Value, ApiError>, tx: &mut Tx) {
    let Some(Dialog::AddGitHub(g)) = &mut app.dialog else { return };
    let fail = |g: &mut AddGitHub, m: String| {
        g.busy = false;
        g.status = None;
        g.error = Some(m);
    };
    let repo = match res {
        Ok(v) => v,
        Err(e) => return fail(g, message(&e)),
    };
    let id = repo["id"].as_str().unwrap_or_default().to_string();
    let title = repo["title"].as_str().unwrap_or(&id).to_string();
    let server = g.server.clone();
    let api = app.api_for_open(&server);
    match repo["status"].as_str() {
        Some("importing") => {
            if let Some(Dialog::AddGitHub(g)) = &mut app.dialog {
                g.status = Some(format!("Copying {title} from GitHub…"));
            }
            app.api_task(
                api,
                move |api| {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    api.repo(&id)
                },
                move |app, res, tx| github_step(app, r, res, tx),
                tx,
            );
        }
        Some("error") => {
            let err = repo["error"].as_str().unwrap_or("Import failed.").to_string();
            if repo["canRemove"] == true {
                let i2 = id.clone();
                app.api_task(api.clone(), move |api| api.remove_workspace(&i2), |_, _, _| {}, tx);
            }
            if let Some(Dialog::AddGitHub(g)) = &mut app.dialog {
                fail(g, err);
            }
        }
        _ => {
            let branch = repo["branch"].as_str().unwrap_or("main").to_string();
            app.api_task(
                api,
                {
                    let id = id.clone();
                    move |api| api.tree(&id)
                },
                move |app, files, tx| {
                    let files = match files {
                        Ok(f) => f,
                        Err(e) => {
                            if let Some(Dialog::AddGitHub(g)) = &mut app.dialog {
                                fail(g, message(&e));
                            }
                            return;
                        }
                    };
                    if files.is_empty() {
                        if let Some(Dialog::AddGitHub(g)) = &mut app.dialog {
                            fail(g, format!("No Markdown files in {title}."));
                        }
                        return;
                    }
                    let rest = r.rest.join("/");
                    let sub = if r.kind.is_some() { rest.strip_prefix(&format!("{branch}/")).unwrap_or("").to_string() } else { String::new() };
                    let note = if r.kind.as_deref() == Some("blob") { pick_note(&files, Some(&sub), None) } else { pick_note(&files, None, Some(&sub)) };
                    app.dialog = None;
                    app.refresh_joined(&server);
                    app.open_remote(server, id, title, note, tx);
                },
                tx,
            );
        }
    }
}

// ---- Share workspace ----

fn share(app: &mut App) -> Option<&mut ShareWs> {
    match &mut app.dialog {
        Some(Dialog::ShareWs(s)) => Some(s),
        _ => None,
    }
}

/// A change to the workspace's sharing went through: the dialog shows it, the joined lists follow.
fn share_changed(app: &mut App, server: &str) {
    app.refresh_joined(server);
}

pub fn invite(app: &mut App, tx: &mut Tx) {
    let Some(s) = share(app) else { return };
    let v = s.email.text.trim().to_lowercase();
    let ok = v.split_once('@').is_some_and(|(a, d)| !a.is_empty() && !a.contains(char::is_whitespace) && d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !d.contains(['@', ' ']));
    if !ok {
        s.error = Some("Enter an email address.".into());
        return;
    }
    let (server, id, role) = (s.server.clone(), s.id.clone(), s.invite_role.clone());
    let api = app.api_for_open(&server);
    app.api_task(
        api,
        move |api| api.set_member(&id, &v, &role),
        move |app, r, tx| match r {
            Ok(_) => {
                if let Some(s) = share(app) {
                    s.email = dialogs::field_edit("");
                    s.email.focused = true;
                }
                app.load_share(false, tx);
                share_changed(app, &server);
            }
            Err(e) => {
                if let Some(s) = share(app) {
                    s.error = Some(message(&e));
                }
            }
        },
        tx,
    );
}

pub fn set_role(app: &mut App, email: &str, role: &str, tx: &mut Tx) {
    let Some(s) = share(app) else { return };
    let (server, id) = (s.server.clone(), s.id.clone());
    let (email, role) = (email.to_string(), role.to_string());
    let api = app.api_for_open(&server);
    app.api_task(
        api,
        move |api| api.set_member(&id, &email, &role),
        move |app, r, tx| {
            if let (Err(e), Some(s)) = (&r, share(app)) {
                s.error = Some(message(e));
            }
            app.load_share(false, tx);
        },
        tx,
    );
}

pub fn remove_member(app: &mut App, member: &str, tx: &mut Tx) {
    let Some(s) = share(app) else { return };
    let (server, id) = (s.server.clone(), s.id.clone());
    let member = member.to_string();
    let api = app.api_for_open(&server);
    app.api_task(
        api,
        move |api| api.remove_member(&id, &member),
        move |app, r, tx| match r {
            Ok(()) => {
                app.load_share(false, tx);
                share_changed(app, &server);
            }
            Err(e) => {
                if let Some(s) = share(app) {
                    s.error = Some(message(&e));
                }
            }
        },
        tx,
    );
}

pub fn set_link_access(app: &mut App, v: &str, tx: &mut Tx) {
    let Some(s) = share(app) else { return };
    let (server, id) = (s.server.clone(), s.id.clone());
    let patch = json!({ "linkAccess": v });
    let api = app.api_for_open(&server);
    app.api_task(
        api,
        move |api| api.update_workspace(&id, &patch),
        move |app, r, _| {
            let Some(s) = share(app) else { return };
            match r {
                Ok(d) => {
                    s.details = Some(d);
                    share_changed(app, &server);
                }
                Err(e) => s.error = Some(message(&e)),
            }
        },
        tx,
    );
}

pub fn save_domain(app: &mut App, tx: &mut Tx) {
    let Some(s) = share(app) else { return };
    let mut v = s.domain.text.trim().to_lowercase();
    if !v.is_empty() && !v.contains('@') {
        v = format!("*@{v}");
    }
    if !v.is_empty() && !valid_domain_rule(&v) {
        s.error = Some("Enter a domain like *@company.com.".into());
        return;
    }
    let (server, id, role) = (s.server.clone(), s.id.clone(), s.domain_role.clone());
    let patch = json!({ "domainRule": if v.is_empty() { Value::Null } else { json!(format!("{v}={role}")) } });
    let api = app.api_for_open(&server);
    app.api_task(
        api,
        move |api| api.update_workspace(&id, &patch),
        move |app, r, _| {
            let Some(s) = share(app) else { return };
            match r {
                Ok(d) => {
                    s.details = Some(d);
                    s.error = None;
                    app.show_toast(if v.is_empty() { "Domain rule removed.".into() } else { format!("Anyone with a {} email can open it.", &v[2..]) });
                }
                Err(e) => s.error = Some(message(&e)),
            }
        },
        tx,
    );
}

/// `*@company.com` (the web app's check: `^\*@[a-z0-9.-]+\.[a-z]{2,}$`).
pub fn valid_domain_rule(v: &str) -> bool {
    let Some(d) = v.strip_prefix("*@") else { return false };
    let Some((head, tld)) = d.rsplit_once('.') else { return false };
    !head.is_empty() && head.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-') && tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_lowercase())
}

/// A Copy button: the system clipboard, "Copied" on the button for a moment.
pub fn copy(app: &mut App, text: &str, key: &str, tx: &mut Tx) {
    tx.copy(text.to_string());
    app.copied = Some(text.to_string());
    match &mut app.dialog {
        Some(Dialog::ShareWs(s)) if key == "share-copy" => s.copied = true,
        Some(Dialog::Agent(a)) if key == "agent-copy" => a.copied = true,
        Some(Dialog::ShareNote(n)) if key == "note-copy" => n.copied = true,
        _ => {}
    }
    if let Backend::Net(h) = &app.backend {
        let h = h.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            h.update(|app, tx| {
                match &mut app.dialog {
                    Some(Dialog::ShareWs(s)) => s.copied = false,
                    Some(Dialog::Agent(a)) => a.copied = false,
                    Some(Dialog::ShareNote(n)) => n.copied = false,
                    _ => {}
                }
                app.handled(tx);
            });
        });
    }
}

// ---- the note's Share ----

pub fn create_note_link(app: &mut App, tx: &mut Tx) {
    let Some(Dialog::ShareNote(n)) = &mut app.dialog else { return };
    if n.busy {
        return;
    }
    n.busy = true;
    let (server, id, path, role) = (n.server.clone(), n.id.clone(), n.path.clone(), n.role.clone());
    let api = app.api_for_open(&server);
    app.api_task(
        api,
        move |api| api.note_link(&id, &path, &role),
        |app, r, tx| {
            let Some(Dialog::ShareNote(n)) = &mut app.dialog else { return };
            n.busy = false;
            match r {
                Ok(url) => {
                    n.url = Some(url.clone());
                    n.error = None;
                    tx.copy(url.clone());
                    app.copied = Some(url);
                    app.show_toast("Link copied.".into());
                }
                Err(e) => {
                    n.url = None;
                    n.error = Some(message(&e));
                }
            }
        },
        tx,
    );
}

// ---- Settings ----

pub fn revoke_token(app: &mut App, id: &str, label: &str, tx: &mut Tx) {
    let Some(Dialog::Settings(s)) = &app.dialog else { return };
    let server = s.server.clone();
    let own = app.store.server(&server).and_then(|x| x.token_id.clone()).is_some_and(|t| t == id)
        || app.remote.as_ref().is_some_and(|r| r.api.server == server && r.me["token"]["id"] == id);
    let (id, label) = (id.to_string(), label.to_string());
    let api = app.api_for_open(&server);
    app.api_task(
        api,
        move |api| api.revoke_token(&id),
        move |app, r, tx| match r {
            Ok(()) => {
                app.show_toast(format!("Disconnected {}.", if label.is_empty() { "the app".to_string() } else { label }));
                if own {
                    // this app's own token: signed out of the server here too
                    app.dialog = None;
                    app.disconnect(&server, tx);
                } else {
                    app.load_tokens(tx);
                }
            }
            Err(e) => app.show_toast(message(&e)),
        },
        tx,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{FakeRest, FakeWs};
    use crate::remote::Mock;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};

    const S: &str = "https://grimoire.example";

    fn app_on(role: &str, google: bool) -> (App, Arc<Mutex<FakeRest>>) {
        let mut rest = FakeRest::new(S, "Ann", "ann@example.com");
        rest.google = google;
        let mut w = FakeWs::new("team", "Team", role, "member");
        w.members = vec![json!({ "id": "m_1", "userId": "u_me", "email": "ann@example.com", "name": "Ann", "role": "owner", "pending": false })];
        w.files = vec!["README.md".into(), "plan.md".into()];
        rest.workspaces.push(w);
        rest.workspaces.push(FakeWs::new("other", "Other", "editor", "member"));
        let rest = Arc::new(Mutex::new(rest));
        let mut m = Mock::new(&[("README.md", "# Team\n"), ("plan.md", "plan\n")]);
        m.rest = Some(rest.clone());
        m.account = "Ann".into();
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(Rc::new(RefCell::new(m)));
        let j = |id: &str, t: &str, r: &str| workspaces::Joined { id: id.into(), title: t.into(), role: r.into(), read_only: false, joined_via: "member".into() };
        app.store.upsert_server(S, Some("Grimoire"), Some(vec![j("team", "Team", role), j("other", "Other", "editor")]));
        app.store.set_account(S, Some("Ann".into()), Some("t_mac".into()));
        app.store.set_details(S, Some("ann@example.com".into()), Some(google));
        let mut tx = Tx::default();
        app.open_remote(S.into(), "team".into(), "Team".into(), Some("README.md".into()), &mut tx);
        assert!(app.remote.as_ref().unwrap().loaded);
        (app, rest)
    }

    fn log(rest: &Arc<Mutex<FakeRest>>) -> Vec<String> {
        std::mem::take(&mut rest.lock().unwrap().log)
    }

    fn type_in(app: &mut App, n: usize, s: &str) {
        let f = app.dialog.as_mut().unwrap().field(n).unwrap();
        *f = dialogs::field_edit(s);
    }

    #[test]
    fn new_workspace_creates_and_opens_it() {
        let (mut app, rest) = app_on("owner", true);
        let mut tx = Tx::default();
        log(&rest);
        app.run_act(Act::NewWorkspace, &mut tx);
        let Some(Dialog::Prompt(p)) = &app.dialog else { panic!() };
        assert_eq!((p.title.as_str(), p.label.as_str(), p.submit.as_str()), ("New workspace", "Name", "Create"));
        assert_eq!(p.hint.as_deref(), Some("A folder of Markdown notes you can share."));
        type_in(&mut app, 0, "Road trip");
        submit_prompt(&mut app, &mut tx);
        assert!(app.dialog.is_none());
        let l = log(&rest);
        assert_eq!(l[0], r#"POST /api/workspaces {"title":"Road trip"}"#);
        assert_eq!(app.current.as_ref().unwrap().name(), "Road trip");
        assert_eq!(app.toast.as_deref(), Some("Created “Road trip”"));
        assert_eq!(app.remote.as_ref().unwrap().role, "owner");
    }

    #[test]
    fn share_workspace_invites_changes_roles_removes_and_sets_access() {
        let (mut app, rest) = app_on("owner", false);
        let mut tx = Tx::default();
        app.run_act(Act::ShareWorkspace, &mut tx);
        let Some(Dialog::ShareWs(s)) = &app.dialog else { panic!() };
        assert_eq!(app.dialog.as_ref().unwrap().title(), "Share “Team”");
        assert!(!s.google, "the server says Google sign-in is off: the invite note shows");
        assert_eq!(s.members.len(), 1);
        log(&rest);
        // a bad address
        type_in(&mut app, 0, "nobody");
        invite(&mut app, &mut tx);
        assert_eq!(share(&mut app).unwrap().error.as_deref(), Some("Enter an email address."));
        assert!(log(&rest).is_empty());
        type_in(&mut app, 0, "Bob@Example.com");
        share(&mut app).unwrap().invite_role = "viewer".into();
        invite(&mut app, &mut tx);
        let l = log(&rest);
        assert_eq!(l[0], r#"POST /api/workspaces/team/members {"email":"bob@example.com","role":"viewer"}"#);
        assert!(l[1].starts_with("GET /api/workspaces/team") && l[2] == "GET /api/workspaces/team/members", "{l:?}");
        let s = share(&mut app).unwrap();
        assert_eq!(s.members.len(), 2);
        assert_eq!(s.members[1]["pending"], true);
        assert_eq!(s.email.text, "");
        // role change, then remove
        set_role(&mut app, "bob@example.com", "editor", &mut tx);
        assert_eq!(log(&rest)[0], r#"POST /api/workspaces/team/members {"email":"bob@example.com","role":"editor"}"#);
        assert_eq!(share(&mut app).unwrap().members[1]["role"], "editor");
        let mid = share(&mut app).unwrap().members[1]["id"].as_str().unwrap().to_string();
        remove_member(&mut app, &mid, &mut tx);
        assert_eq!(log(&rest)[0], format!("DELETE /api/workspaces/team/members/{mid}"));
        assert_eq!(share(&mut app).unwrap().members.len(), 1);
        // the last owner can't go
        remove_member(&mut app, "m_1", &mut tx);
        assert!(share(&mut app).unwrap().error.as_deref().unwrap().contains("needs an owner"));
        // link access
        set_link_access(&mut app, "view", &mut tx);
        assert_eq!(log(&rest).last().unwrap(), r#"PATCH /api/workspaces/team {"linkAccess":"view"}"#);
        assert_eq!(share(&mut app).unwrap().details.as_ref().unwrap()["linkAccess"], "view");
        // the domain rule: "company.com" means *@company.com
        type_in(&mut app, 1, "nope");
        save_domain(&mut app, &mut tx);
        assert_eq!(share(&mut app).unwrap().error.as_deref(), Some("Enter a domain like *@company.com."));
        type_in(&mut app, 1, "Company.com");
        share(&mut app).unwrap().domain_role = "viewer".into();
        save_domain(&mut app, &mut tx);
        assert!(log(&rest).iter().any(|l| l == r#"PATCH /api/workspaces/team {"domainRule":"*@company.com=viewer"}"#));
        assert_eq!(app.toast.as_deref(), Some("Anyone with a company.com email can open it."));
        type_in(&mut app, 1, "");
        save_domain(&mut app, &mut tx);
        assert_eq!(log(&rest).last().unwrap(), r#"PATCH /api/workspaces/team {"domainRule":null}"#);
        assert_eq!(app.toast.as_deref(), Some("Domain rule removed."));
        // Copy link
        copy(&mut app, &workspace_url(S, "team"), "share-copy", &mut tx);
        assert_eq!(app.copied.as_deref(), Some("https://grimoire.example/app/team"));
        assert!(share(&mut app).unwrap().copied);
    }

    #[test]
    fn google_on_hides_the_invite_note() {
        let (mut app, _) = app_on("owner", true);
        let mut tx = Tx::default();
        app.run_act(Act::ShareWorkspace, &mut tx);
        assert!(share(&mut app).unwrap().google);
    }

    #[test]
    fn agent_link_prompt_and_note_links() {
        let (mut app, rest) = app_on("editor", true);
        let mut tx = Tx::default();
        log(&rest);
        app.run_act(Act::ShareAgent, &mut tx);
        let Some(Dialog::Agent(a)) = &app.dialog else { panic!() };
        assert_eq!(log(&rest)[0], r#"POST /api/repos/team/shares {"reuse":true}"#);
        let prompt = a.prompt.clone().unwrap();
        assert!(prompt.starts_with("Use this Grimoire notebook as your workspace: https://grimoire.example/s/"), "{prompt}");
        // the same link next time
        app.run_act(Act::ShareAgent, &mut tx);
        let Some(Dialog::Agent(b)) = &app.dialog else { panic!() };
        assert_eq!(b.prompt.as_deref(), Some(prompt.as_str()));
        copy(&mut app, &prompt, "agent-copy", &mut tx);
        assert_eq!(app.copied.as_deref(), Some(prompt.as_str()));
        // the note's Share: view, then edit
        app.dialog = None;
        assert!(app.can_share_note());
        app.share_note_dialog();
        let Some(Dialog::ShareNote(n)) = &app.dialog else { panic!() };
        assert!(n.writable && n.role == "viewer" && n.path == "README.md");
        log(&rest);
        create_note_link(&mut app, &mut tx);
        assert_eq!(log(&rest)[0], r#"POST /api/repos/team/shares {"kind":"note","path":"README.md","role":"viewer"}"#);
        let Some(Dialog::ShareNote(n)) = &app.dialog else { panic!() };
        let url = n.url.clone().unwrap();
        assert!(url.contains("/app/team/README.md?share="), "{url}");
        assert_eq!(app.copied.as_deref(), Some(url.as_str()));
        assert_eq!(app.toast.as_deref(), Some("Link copied."));
    }

    #[test]
    fn viewers_share_notes_read_only_and_errors_show() {
        let (mut app, rest) = app_on("viewer", true);
        let mut tx = Tx::default();
        app.share_note_dialog();
        let Some(Dialog::ShareNote(n)) = &mut app.dialog else { panic!() };
        assert!(!n.writable);
        n.role = "editor".into();
        create_note_link(&mut app, &mut tx);
        let Some(Dialog::ShareNote(n)) = &app.dialog else { panic!() };
        // as on the web: the button shows, the server refuses viewers of a writable workspace
        assert_eq!(n.error.as_deref(), Some("you need write access to share this notebook with an agent"));
        log(&rest);
    }

    #[test]
    fn refresh_leave_and_remove() {
        let (mut app, rest) = app_on("editor", true);
        let mut tx = Tx::default();
        log(&rest);
        app.run_act(Act::Refresh, &mut tx);
        assert_eq!(log(&rest), vec!["POST /api/repos/team/refresh".to_string(), "GET /api/repos/team/tree".to_string()]);
        app.run_act(Act::Leave, &mut tx);
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.confirm.as_str(), c.danger), ("Leave workspace", "Leave", true));
        assert_eq!(c.message, "Leave “Team”? You'll need to be invited again to get back in.");
        confirm(&mut app, &mut tx);
        assert_eq!(log(&rest)[0], "DELETE /api/workspaces/team/join");
        assert_eq!(app.toast.as_deref(), Some("You left “Team”."));
        assert_eq!(app.current.as_ref().unwrap().name(), "Other", "the next joined workspace opens");
        assert!(!app.store.server(S).unwrap().joined.iter().any(|j| j.id == "team"));

        let (mut app, rest) = app_on("owner", true);
        log(&rest);
        app.run_act(Act::Remove, &mut tx);
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.message.as_str(), c.confirm.as_str()), ("Remove workspace", "Remove “Team” from Grimoire for everyone who has it?", "Remove"));
        confirm(&mut app, &mut tx);
        assert_eq!(log(&rest)[0], "DELETE /api/repos/team");
        assert!(!rest.lock().unwrap().workspaces.iter().any(|w| w.id == "team"));
        assert_eq!(app.current.as_ref().unwrap().name(), "Other");
    }

    #[test]
    fn change_name_settings_and_sign_out() {
        let (mut app, rest) = app_on("owner", true);
        let mut tx = Tx::default();
        app.run_act(Act::ChangeName, &mut tx);
        let Some(Dialog::Prompt(p)) = &app.dialog else { panic!() };
        assert_eq!((p.title.as_str(), p.input.text.as_str(), p.submit.as_str()), ("Change name", "Ann", "Save"));
        type_in(&mut app, 0, "Ann Lee");
        log(&rest);
        submit_prompt(&mut app, &mut tx);
        assert_eq!(log(&rest)[0], r#"PATCH /api/me {"name":"Ann Lee"}"#);
        assert_eq!(app.store.server(S).unwrap().account.as_deref(), Some("Ann Lee"));
        assert_eq!(crate::menu::account_line(&app, S), "Signed in as Ann Lee · ann@example.com");

        app.run_act(Act::Settings, &mut tx);
        let Some(Dialog::Settings(s)) = &app.dialog else { panic!() };
        assert_eq!(s.tokens.as_ref().unwrap().len(), 2);
        log(&rest);
        revoke_token(&mut app, "t_old", "Grimoire for Mac (old laptop)", &mut tx);
        assert_eq!(log(&rest), vec!["DELETE /api/tokens/t_old".to_string(), "GET /api/tokens".to_string()]);
        assert_eq!(app.toast.as_deref(), Some("Disconnected Grimoire for Mac (old laptop)."));
        let Some(Dialog::Settings(s)) = &app.dialog else { panic!() };
        assert_eq!(s.tokens.as_ref().unwrap().len(), 1);

        app.run_act(Act::SignOut, &mut tx);
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.confirm.as_str()), ("Sign out", "Sign out"));
        assert!(c.message.starts_with("Sign out of grimoire.example?"));
        confirm(&mut app, &mut tx);
        assert!(app.store.server(S).is_none());
        assert_eq!(app.remote.as_ref().unwrap().problem, Some(crate::remote::Problem::SignedOut));
    }

    #[test]
    fn settings_on_a_server_without_tokens_says_so() {
        let (mut app, rest) = app_on("owner", true);
        rest.lock().unwrap().tokens.clear();
        let mut tx = Tx::default();
        app.run_act(Act::Settings, &mut tx);
        let Some(Dialog::Settings(s)) = &app.dialog else { panic!() };
        assert_eq!(s.tokens.as_deref().map(<[Value]>::len), Some(0));
    }

    #[test]
    fn add_remote_and_open_path_dialogs() {
        let (mut app, _) = app_on("owner", true);
        let mut tx = Tx::default();
        app.run_act(Act::AddRemote, &mut tx);
        let Some(Dialog::Prompt(p)) = &app.dialog else { panic!() };
        assert_eq!((p.title.as_str(), p.label.as_str(), p.submit.as_str()), ("Add remote workspace", "Workspace URL", "Add workspace"));
        type_in(&mut app, 0, "https://g.example/settings");
        submit_prompt(&mut app, &mut tx);
        let Some(Dialog::Prompt(p)) = &app.dialog else { panic!() };
        assert_eq!(p.error.as_deref(), Some("That isn't a workspace link. It looks like https://server/app/workspace."));
        type_in(&mut app, 0, "https://grimoire.example/app/other");
        submit_prompt(&mut app, &mut tx);
        assert!(app.dialog.is_none());
        assert_eq!(app.current.as_ref().unwrap().name(), "Other");
        // Open folder (headless: the path dialog), from a remote workspace, then from a local one
        let dir = std::env::temp_dir().join(format!("grimoire-open-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("b")).unwrap();
        app.run_act(Act::OpenFolder, &mut tx);
        type_in(&mut app, 0, dir.to_str().unwrap());
        submit_prompt(&mut app, &mut tx);
        assert!(app.remote.is_none() && matches!(app.current, Some(WsRef::Local { .. })));
        app.run_act(Act::OpenFolder, &mut tx);
        type_in(&mut app, 0, "/no/such/folder");
        submit_prompt(&mut app, &mut tx);
        assert!(matches!(&app.dialog, Some(Dialog::Prompt(p)) if p.error.as_deref() == Some("No folder at /no/such/folder")));
        type_in(&mut app, 0, dir.join("b").to_str().unwrap());
        submit_prompt(&mut app, &mut tx);
        assert_eq!(app.current.as_ref().unwrap().name(), "b");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn github_refs_and_note_picking() {
        let r = parse_github("https://github.com/acme/docs/tree/main/guide").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str(), r.kind.as_deref(), r.rest.clone()), ("acme", "docs", Some("tree"), vec!["main".to_string(), "guide".to_string()]));
        assert_eq!(parse_github("acme/docs.git").unwrap().name, "docs");
        assert_eq!(parse_github("git@github.com:acme/docs.git").unwrap().owner, "acme");
        assert!(parse_github("https://gitlab.com/a/b").is_none());
        assert!(parse_github("acme").is_none());
        assert!(parse_github("-x/y").is_none());
        let files: Vec<String> = ["README.md", "guide/intro.md", "guide/README.md", "a/b/c.md"].iter().map(|s| s.to_string()).collect();
        assert_eq!(pick_note(&files, None, Some("guide")).as_deref(), Some("guide/README.md"));
        assert_eq!(pick_note(&files, Some("a/b/c.md"), None).as_deref(), Some("a/b/c.md"));
        assert_eq!(pick_note(&files, None, None).as_deref(), Some("README.md"));
        assert!(valid_domain_rule("*@company.com") && !valid_domain_rule("*@company") && !valid_domain_rule("x@company.com"));
    }

    #[test]
    fn add_github_repo_opens_it() {
        let (mut app, rest) = app_on("owner", true);
        rest.lock().unwrap().github_app = Some("grimoire-app".into());
        let mut tx = Tx::default();
        app.run_act(Act::AddGitHub, &mut tx);
        let Some(Dialog::AddGitHub(g)) = &app.dialog else { panic!() };
        assert_eq!(g.app_slug.as_deref(), Some("grimoire-app"));
        type_in(&mut app, 0, "not a repo");
        submit_github(&mut app, &mut tx);
        let Some(Dialog::AddGitHub(g)) = &app.dialog else { panic!() };
        assert_eq!(g.error.as_deref(), Some("Enter a GitHub URL (https://github.com/owner/name) or owner/name."));
        type_in(&mut app, 0, "acme/docs");
        log(&rest);
        submit_github(&mut app, &mut tx);
        let l = log(&rest);
        assert_eq!(l[0], r#"POST /api/repos {"github":"acme/docs","readOnly":true}"#);
        assert!(app.dialog.is_none());
        assert_eq!(app.current.as_ref().unwrap().name(), "acme/docs");
        let items = crate::menu::items(&app);
        assert!(items.iter().any(|i| i.label() == "Open on GitHub"));
        app.run_act(Act::OpenGitHub, &mut tx);
        assert_eq!(app.link_log.last().map(String::as_str), Some("open https://github.com/acme/docs"));
    }
}
