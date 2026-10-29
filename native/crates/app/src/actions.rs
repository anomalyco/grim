//! What the switcher's items and the dialogs do, through the same server endpoints as the web app
//! (`src/client/api.ts`): New, Open (a remote folder, a GitHub repo), the agent card's link, Leave (a folder
//! row's ×), Remove, Change name, Sign out. Requests run on a thread (`Backend::Net`) or in place against the mock
//! server's REST stand-in; their answers come back to the UI thread.

use std::path::PathBuf;

use rune::Tx;
use serde_json::{Value, json};

use crate::App;
use crate::dialogs::{self, AddGitHub, Confirm, ConfirmKind, Dialog, OpenChoice, OpenDlg, Prompt, PromptKind};
use crate::menu::Act;
use crate::net;
use crate::remote::{Api, ApiError, Backend};
use crate::workspaces::{self, WsRef};

fn host(server: &str) -> String {
    WsRef::Remote { server: server.to_string(), id: String::new(), title: String::new() }.location()
}

/// An error the way the web app's `errorMessage` shows it.
pub fn message(e: &ApiError) -> String {
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

    fn prompt(&mut self, p: Prompt) {
        self.dialog = Some(Dialog::Prompt(Box::new(p)));
    }

    fn confirm_dialog(&mut self, kind: ConfirmKind, title: &str, message: String, confirm: &str) {
        self.dialog = Some(Dialog::Confirm(Confirm { kind, title: title.into(), message, confirm: confirm.into(), cancel: "Cancel".into(), danger: true }));
    }

    /// A menu item was chosen.
    pub fn run_act(&mut self, act: Act, tx: &mut Tx) {
        self.close_switcher();
        self.close_search();
        self.marked = None;
        let server = self.remote.as_ref().map(|r| r.api.server.clone());
        match act {
            Act::New => self.open_dialog(OpenChoice::NewFolder, tx),
            Act::Open => self.open_dialog(OpenChoice::Remote, tx),
            Act::OpenFolder => self.open_folder_dialog(tx),
            Act::OpenGitHub => {
                if let Some(r) = &self.remote
                    && let (Some(o), Some(n)) = (r.repo["ghOwner"].as_str(), r.repo["ghName"].as_str())
                {
                    let url = format!("https://github.com/{o}/{n}");
                    self.launch(&url);
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

    /// "Open folder…" (from the menu, local or remote): the system folder picker (`Tx::open_folder`, or
    /// `App::picker` in tests), or the path dialog when headless or the picker can't run.
    pub fn open_folder_dialog(&mut self, tx: &mut Tx) {
        let Backend::Net(h) = &self.backend else {
            self.open_path_dialog();
            return;
        };
        let Some(pick) = self.picker else {
            let options = rune::FileDialogOptions { title: "Choose a folder to open as a workspace".into(), ..Default::default() };
            tx.open_folder(options, |app: &mut App, answer, tx| {
                match answer {
                    Ok(Some(p)) => app.open_local(p, tx),
                    Ok(None) => return,
                    Err(_) => app.open_path_dialog(),
                }
                app.handled(tx);
            });
            return;
        };
        let h = h.clone();
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

    /// "Open Workspace…" / "New Workspace…": the Open dialog showing `choice`, or the New dialog for a new folder.
    pub fn open_dialog(&mut self, choice: OpenChoice, tx: &mut Tx) {
        let servers: Vec<String> = self.store.servers.iter().map(|s| s.url.clone()).filter(|s| crate::menu::signed_in(self, s)).collect();
        let here = self.remote.as_ref().map(|r| r.api.server.clone()).filter(|s| servers.contains(s));
        let server = here.or_else(|| servers.first().cloned());
        let gh = AddGitHub { server: server.clone().unwrap_or_default(), input: dialogs::field_edit(""), edit: false, app_slug: None, status: None, error: None, busy: false };
        let mut d = OpenDlg {
            choice,
            servers,
            server,
            new: OpenChoice::CREATE.contains(&choice),
            server_url: dialogs::field_edit(&self.new_remote_server()),
            status: None,
            url: dialogs::field_edit(""),
            gh,
            parent: dialogs::field_edit("~/Documents"),
            folder_name: dialogs::field_edit(""),
            remote_name: dialogs::field_edit(""),
            error: None,
            busy: false,
        };
        d.pick(choice);
        self.dialog = Some(Dialog::Open(Box::new(d)));
        self.github_config(tx);
    }

    /// The New dialog's Server: the open folder's server when it's remote, else the first connected server
    /// in the switcher's order, else `DEFAULT_SERVER`.
    pub fn new_remote_server(&self) -> String {
        let open = self.remote.as_ref().map(|r| r.api.server.clone());
        let connected = || self.store.servers.iter().map(|s| s.url.clone()).find(|s| crate::menu::signed_in(self, s));
        open.or_else(connected).map_or_else(|| DEFAULT_SERVER.to_string(), |s| format!("{}/", s.trim_end_matches('/')))
    }

    /// The chosen server's GitHub App (whether repos can be added for editing), once per server.
    fn github_config(&mut self, tx: &mut Tx) {
        let Some(Dialog::Open(d)) = &self.dialog else { return };
        let Some(server) = d.server.clone().filter(|_| d.choice == OpenChoice::GitHub && d.gh.app_slug.is_none()) else { return };
        let api = self.api_for_open(&server);
        self.api_task(
            api,
            |api| api.config(),
            move |app, r, _| {
                if let (Ok(c), Some(g)) = (r, app.dialog.as_mut().and_then(Dialog::github_mut))
                    && g.server == server
                {
                    g.app_slug = c["githubAppSlug"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
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

    /// A folder row's ×: always a confirm first (the web's wording) — "Remove <name> from your list?", Remove /
    /// Cancel — or, for the only folder in the whole list, "Can't remove your only workspace" (New folder… / OK).
    pub fn ask_remove_folder(&mut self, ws: WsRef, _tx: &mut Tx) {
        let rows = crate::menu::items(self).iter().filter(|i| matches!(i, crate::menu::Item::Ws { .. })).count();
        self.close_switcher();
        let (kind, title, message, confirm, cancel) = if rows <= 1 {
            (
                ConfirmKind::OnlyFolder,
                "Can't remove your only workspace".to_string(),
                "You can't remove the only workspace in your list. Create a new workspace first, then remove this one.".to_string(),
                "New workspace…",
                "OK",
            )
        } else {
            let message = match &ws {
                WsRef::Remote { .. } => "This doesn't delete the workspace. All existing links to it keep working, and if you open a link to it again, it'll come back to your list.",
                WsRef::Local { .. } => "This doesn't delete the workspace's folder or its files. You can open it again any time with Open Folder…",
            };
            (ConfirmKind::ForgetFolder { ws: ws.clone() }, format!("Remove {} from your list?", ws.name()), message.to_string(), "Remove", "Cancel")
        };
        self.dialog = Some(Dialog::Confirm(Confirm { kind, title, message, confirm: confirm.into(), cancel: cancel.into(), danger: false }));
    }

    /// A remote folder off the list: leave `id` on `server` (with that server's token), as on the web
    /// (`DELETE /api/workspaces/:id/join`; opening it again joins it again). Leaving the open folder opens
    /// another one (or none).
    pub fn leave_folder(&mut self, server: &str, id: &str, title: &str, tx: &mut Tx) {
        let (server, id, title) = (server.to_string(), id.to_string(), title.to_string());
        let api = self.api_for_open(&server);
        let i2 = id.clone();
        self.api_task(
            api,
            move |api| api.leave(&i2),
            move |app, r, tx| match r {
                Ok(()) => {
                    if app.current.as_ref().is_some_and(|c| matches!(c, WsRef::Remote { server: s, id: i, .. } if *s == server && *i == id)) {
                        app.close_switcher();
                    }
                    app.after_leaving(&server, &id, tx);
                    app.show_toast(format!("Removed {title} from your list"));
                }
                Err(e) => app.show_error(message(&e)),
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

impl App {
    /// The sidebar's "Share with an agent" card shows: for a local folder, and for a remote one that's loaded
    /// and ready (anyone signed in may make an agent link).
    /// The open remote folder is open as a guest (no account there).
    pub fn is_guest(&self) -> bool {
        self.remote.as_ref().is_some_and(App::is_guest_in)
    }

    pub fn is_guest_in(r: &crate::remote::Remote) -> bool {
        r.me["kind"] == "guest"
    }

    pub fn agent_card_shown(&self) -> bool {
        match (&self.current, &self.remote) {
            (Some(WsRef::Local { .. }), _) => self.root.is_some(),
            // handing a folder to an agent is for accounts: a guest doesn't see the card (as on the web)
            (Some(WsRef::Remote { .. }), Some(r)) => r.loaded && r.problem.is_none() && r.repo["status"] == "ready" && !App::is_guest_in(r),
            _ => false,
        }
    }
}

/// What the card copies for a local folder: work on its files directly (no server).
pub fn local_agent_prompt(path: &std::path::Path) -> String {
    format!(
        "Work in this folder of Markdown notes: {}\nRead and edit the .md files in it directly (any tools are fine); Grimoire shows the changes as they happen. Keep notes as Markdown.",
        path.display()
    )
}

/// The card's Copy: for a local folder its instructions; for a remote one the web's agent prompt with this
/// account's agent link for it (`POST /api/repos/:id/shares`, made once, then remembered).
pub fn copy_agent_prompt(app: &mut App, tx: &mut Tx) {
    match app.current.clone() {
        Some(WsRef::Local { path }) => copy(app, &local_agent_prompt(&path), tx),
        Some(WsRef::Remote { server, id, .. }) => {
            if let Some(url) = app.agent.urls.get(&(server.clone(), id.clone())).cloned() {
                return copy(app, &dialogs::agent_prompt(&url), tx);
            }
            if app.agent.busy {
                return;
            }
            app.agent.busy = true;
            let api = app.api_for_open(&server);
            let i2 = id.clone();
            app.api_task(
                api,
                move |api| api.agent_link(&i2),
                move |app, r, tx| {
                    app.agent.busy = false;
                    match r {
                        Ok(url) => {
                            app.agent.urls.insert((server, id), url.clone());
                            copy(app, &dialogs::agent_prompt(&url), tx);
                        }
                        Err(e) => app.show_error(message(&e)),
                    }
                },
                tx,
            );
        }
        None => {}
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
        PromptKind::OpenPath => {
            let path = expand_tilde(&v);
            if path.is_dir() {
                app.dialog = None;
                app.open_local(path, tx);
            } else {
                p.error = Some(format!("No folder at {v}"));
            }
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
                    Err(e) => app.show_error(message(&e)),
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
        ConfirmKind::ForgetFolder { ws } => match &ws {
            WsRef::Remote { server, id, .. } if app.store.server(server).is_some() => app.leave_folder(server, id, &ws.name(), tx),
            // a local folder, or a remote one opened as a guest: off this Mac's list
            _ => {
                app.remove_recent(&ws, tx);
                app.show_toast(format!("Removed {} from your list", ws.name()));
            }
        },
        ConfirmKind::OnlyFolder => app.open_dialog(OpenChoice::NewFolder, tx),
        ConfirmKind::Delete { rel, dir } => app.delete_path(&rel, dir, tx),
        ConfirmKind::Restore { sha } => app.history_restore(sha, tx),
        ConfirmKind::Remove { server, id, .. } => {
            let api = app.api_for_open(&server);
            let i2 = id.clone();
            app.api_task(
                api,
                move |api| api.remove_workspace(&i2),
                move |app, r, tx| match r {
                    Ok(()) => app.after_leaving(&server, &id, tx),
                    Err(e) => app.show_error(message(&e)),
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

/// The Open dialog shows `choice`'s form.
pub fn pick_open(app: &mut App, choice: OpenChoice, tx: &mut Tx) {
    if let Some(Dialog::Open(d)) = &mut app.dialog {
        d.pick(choice);
    }
    app.github_config(tx);
}

/// The server a GitHub repo or a new remote folder goes to.
pub fn pick_open_server(app: &mut App, server: &str, tx: &mut Tx) {
    if let Some(Dialog::Open(d)) = &mut app.dialog {
        d.server = Some(server.to_string());
        d.error = None;
        d.gh = AddGitHub { server: server.to_string(), app_slug: None, status: None, error: None, busy: false, ..d.gh.clone() };
    }
    app.github_config(tx);
}

/// The Open dialog's primary button (or Return in its field): what the shown form does.
pub fn submit_open(app: &mut App, tx: &mut Tx) {
    let Some(Dialog::Open(d)) = &mut app.dialog else { return };
    if d.busy {
        return;
    }
    match d.choice {
        OpenChoice::Folder => {
            app.dialog = None;
            app.open_folder_dialog(tx);
        }
        OpenChoice::Remote => {
            let v = d.url.text.trim().to_string();
            if v.is_empty() {
                return;
            }
            match workspaces::parse_remote_url(&v) {
                Ok(u) => {
                    app.dialog = None;
                    app.open_remote(u.server, u.id, String::new(), u.note, tx);
                }
                Err(_) => d.error = Some("That isn't a workspace or note link. It looks like https://server/app/workspace or https://server/app/workspace/note.md.".into()),
            }
        }
        OpenChoice::GitHub => {
            if d.server.is_some() {
                submit_github(app, tx);
            }
        }
        OpenChoice::NewFolder => {
            let name = d.folder_name.text.trim().to_string();
            if name.is_empty() {
                return;
            }
            let parent = expand_tilde(d.parent.text.trim());
            match new_folder(&parent, &name, !app.headless) {
                Ok(dir) => {
                    app.dialog = None;
                    app.open_local(dir, tx);
                }
                Err(e) => d.error = Some(e),
            }
        }
        OpenChoice::NewRemote => {
            let title = d.remote_name.text.trim().to_string();
            if title.is_empty() {
                return;
            }
            let server = match server_origin(&d.server_url.text) {
                Ok(s) => s,
                Err(e) => {
                    d.error = Some(e);
                    return;
                }
            };
            d.busy = true;
            d.error = None;
            if crate::menu::signed_in(app, &server) {
                app.create_remote(server, title, tx);
            } else {
                app.connect_then_create(server, title, tx);
            }
        }
    }
}

/// The New dialog's default server.
pub const DEFAULT_SERVER: &str = "https://grimnotes.app/";

/// A typed server address as an origin (`https://host[:port]`; no scheme means https).
pub fn server_origin(s: &str) -> Result<String, String> {
    let bad = || "Enter a server address like https://grimnotes.app/".to_string();
    let u = crate::net::parse_url(s.trim()).map_err(|_| bad())?;
    if u.host.is_empty() || u.host.contains(char::is_whitespace) || !(u.host.contains('.') || u.host.contains(':') || u.host == "localhost") {
        return Err(bad());
    }
    Ok(u.origin())
}

/// What went wrong making a new remote folder, for the form.
pub fn new_remote_error(server: &str, e: &ApiError) -> String {
    let h = host(server);
    match e {
        ApiError::NotGrimoire(_) | ApiError::NotFound(_) => format!("{h} isn't a Grimoire server."),
        ApiError::Network(_) => format!("Can't reach {h}. Check the address and your connection."),
        ApiError::Forbidden(_) => format!("You don't have permission to create workspaces on {h}."),
        ApiError::Unauthorized => format!("Not signed in to {h}."),
        e => message(e),
    }
}

impl App {
    /// Shows a new remote folder form's error (or a toast when the dialog is gone).
    pub fn new_remote_failed_pub(&mut self, msg: String) {
        self.new_remote_failed(msg);
    }

    fn new_remote_failed(&mut self, msg: String) {
        match &mut self.dialog {
            Some(Dialog::Open(d)) if d.choice == OpenChoice::NewRemote => {
                d.busy = false;
                d.status = None;
                d.error = Some(msg);
            }
            _ => self.show_toast(msg),
        }
    }

    /// `POST /api/workspaces {title}` on `server` (private: only its creator until shared), then open it.
    pub fn create_remote(&mut self, server: String, title: String, tx: &mut Tx) {
        let api = self.api_for_open(&server);
        self.api_task(
            api,
            move |api| api.create_workspace(&title),
            move |app, r, tx| match r {
                Ok((id, title)) => {
                    app.dialog = None;
                    app.refresh_joined(&server);
                    app.open_remote(server.clone(), id, title.clone(), None, tx);
                    app.show_toast(format!("Created “{title}”"));
                }
                Err(e) => app.new_remote_failed(new_remote_error(&server, &e)),
            },
            tx,
        );
    }

    /// Not connected to `server` yet: check it's a Grimoire server, run the connect flow, and create the
    /// folder once it's done (`connected` picks up `pending_new`).
    fn connect_then_create(&mut self, server: String, title: String, tx: &mut Tx) {
        let api = self.api_with(&server, None);
        self.api_task(
            api,
            |api| api.server_info(),
            move |app, r, _| match r {
                Ok(_) => {
                    if let Some(Dialog::Open(d)) = &mut app.dialog {
                        d.status = Some(format!("Waiting for the browser to connect to {}…", host(&server)));
                    }
                    app.switcher.pending_new = Some((server.clone(), title));
                    app.start_connect(&server);
                }
                Err(e) => app.new_remote_failed(new_remote_error(&server, &e)),
            },
            tx,
        );
    }
}

/// A new folder `name` in `parent` (made only when `write`; headless runs don't write): never one that
/// exists, never a path.
pub fn new_folder(parent: &std::path::Path, name: &str, write: bool) -> Result<PathBuf, String> {
    if name.contains('/') || name == "." || name == ".." || name.starts_with('.') {
        return Err("A workspace name can't start with “.” or contain “/”.".into());
    }
    if !parent.is_dir() {
        return Err(format!("No folder at {}", workspaces::tilde(parent)));
    }
    let dir = parent.join(name);
    if dir.exists() {
        return Err(format!("There's already a “{name}” in {}.", workspaces::tilde(parent)));
    }
    if write {
        std::fs::create_dir(&dir).map_err(|e| format!("Couldn't create {}: {e}", workspaces::tilde(&dir)))?;
    }
    Ok(dir)
}

/// New folder's "Choose…": the system folder picker for where it goes.
pub fn choose_parent(app: &mut App, tx: &mut Tx) {
    let Some(Dialog::Open(d)) = &app.dialog else { return };
    if !matches!(app.backend, Backend::Net(_)) {
        return;
    }
    let directory = Some(expand_tilde(d.parent.text.trim())).filter(|p| p.is_dir());
    let options = rune::FileDialogOptions { title: "Where to create the workspace".into(), directory, ..Default::default() };
    tx.open_folder(options, |app: &mut App, answer, tx| {
        if let (Ok(Some(p)), Some(Dialog::Open(d))) = (answer, &mut app.dialog) {
            d.parent = dialogs::field_edit(&workspaces::tilde(&p));
            d.error = None;
        }
        app.handled(tx);
    });
}

fn submit_github(app: &mut App, tx: &mut Tx) {
    let Some(g) = app.dialog.as_mut().and_then(Dialog::github_mut) else { return };
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
    let Some(g) = app.dialog.as_mut().and_then(Dialog::github_mut) else { return };
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
            if let Some(g) = app.dialog.as_mut().and_then(Dialog::github_mut) {
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
            if let Some(g) = app.dialog.as_mut().and_then(Dialog::github_mut) {
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
                            if let Some(g) = app.dialog.as_mut().and_then(Dialog::github_mut) {
                                fail(g, message(&e));
                            }
                            return;
                        }
                    };
                    if files.is_empty() {
                        if let Some(g) = app.dialog.as_mut().and_then(Dialog::github_mut) {
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

/// The agent card's Copy: the system clipboard, "Copied" on the button for a moment.
pub fn copy(app: &mut App, text: &str, tx: &mut Tx) {
    tx.copy(text.to_string());
    app.copied = Some(text.to_string());
    app.agent.copied = true;
    if let Backend::Net(h) = &app.backend {
        let h = h.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            h.update(|app, tx| {
                app.agent.copied = false;
                app.handled(tx);
            });
        });
    }
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

    /// "Team" on the mock server (made by us when `mine`) open, and "Other" joined there too.
    fn app_on(mine: bool) -> (App, Arc<Mutex<FakeRest>>) {
        let mut rest = FakeRest::new(S, "Ann", "ann@example.com");
        let mut w = FakeWs::new("team", "Team", mine);
        w.files = vec!["README.md".into(), "plan.md".into()];
        rest.workspaces.push(w);
        rest.workspaces.push(FakeWs::new("other", "Other", false));
        let rest = Arc::new(Mutex::new(rest));
        let mut m = Mock::new(&[("README.md", "# Team\n"), ("plan.md", "plan\n")]);
        m.rest = Some(rest.clone());
        m.account = "Ann".into();
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(Rc::new(RefCell::new(m)));
        app.store.upsert_server(S, Some("Grimoire"), Some(vec![workspaces::Joined::new("team", "Team"), workspaces::Joined::new("other", "Other")]));
        app.store.set_account(S, Some("Ann".into()), Some("t_mac".into()));
        app.store.set_details(S, Some("ann@example.com".into()), Some(true));
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

    /// The Open dialog (or New, for a new folder) showing `choice`, as a click on it in the list would.
    fn open(app: &mut App, choice: OpenChoice, tx: &mut Tx) -> OpenDlg {
        let new = OpenChoice::CREATE.contains(&choice);
        app.run_act(if new { Act::New } else { Act::Open }, tx);
        pick_open(app, choice, tx);
        let Some(Dialog::Open(d)) = &app.dialog else { panic!() };
        assert_eq!(app.dialog.as_ref().unwrap().title(), if new { "New workspace" } else { "Open workspace" });
        assert_eq!(d.choices(), if new { &OpenChoice::CREATE[..] } else { &OpenChoice::OPEN[..] });
        assert_eq!(d.choice, choice);
        (**d).clone()
    }

    /// Not signed in anywhere (a guest): Open offers URLs, not GitHub repos (as the web hides it for guests); asked
    /// for one, it shows the URL form. Signed in: both.
    #[test]
    fn a_guest_gets_no_github_repo_choice() {
        let mut app = App::new("", None, true);
        let mut tx = Tx::default();
        app.open_dialog(OpenChoice::GitHub, &mut tx);
        let Some(Dialog::Open(d)) = &app.dialog else { panic!() };
        assert_eq!(d.choices(), [OpenChoice::Remote], "no folder on this Mac (that's Open Folder…), no GitHub repo for a guest");
        assert_eq!(d.choice, OpenChoice::Remote);
        pick_open(&mut app, OpenChoice::GitHub, &mut tx);
        let Some(Dialog::Open(d)) = &app.dialog else { panic!() };
        assert_eq!(d.choice, OpenChoice::Remote);
        let (mut app, _) = app_on(true);
        app.open_dialog(OpenChoice::Remote, &mut tx);
        let Some(Dialog::Open(d)) = &app.dialog else { panic!() };
        assert_eq!(d.choices(), OpenChoice::OPEN);
    }

    #[test]
    fn new_remote_folder_creates_and_opens_it() {
        let (mut app, rest) = app_on(true);
        let mut tx = Tx::default();
        log(&rest);
        let d = open(&mut app, OpenChoice::NewRemote, &mut tx);
        assert_eq!((d.choice.label(), d.choice.submit()), ("On a server", "Create"));
        assert_eq!(d.server_url.text, "https://grimoire.example/", "the open folder's server");
        assert!(d.remote_name.focused && !d.url.focused);
        type_in(&mut app, 4, "Road trip");
        submit_open(&mut app, &mut tx);
        assert!(app.dialog.is_none());
        let l = log(&rest);
        assert_eq!(l[0], r#"POST /api/workspaces {"title":"Road trip"}"#);
        assert_eq!(app.current.as_ref().unwrap().name(), "Road trip");
        assert_eq!(app.toast(), Some("Created “Road trip”"));
        assert_eq!(app.remote.as_ref().unwrap().repo["canRemove"], true, "its maker may remove it");
    }

    /// New → Remote folder on a server the app isn't connected to: it checks the server, runs the connect
    /// flow, then creates the folder there and opens it; bad addresses and failures show in the form.
    #[test]
    fn new_remote_folder_connects_first_then_creates() {
        let (mut app, rest) = app_on(true);
        let mut tx = Tx::default();
        open(&mut app, OpenChoice::NewRemote, &mut tx);
        type_in(&mut app, 4, "Road trip");
        for bad in ["not a server", "ftp://x.example", "https://"] {
            type_in(&mut app, 5, bad);
            submit_open(&mut app, &mut tx);
            assert!(matches!(&app.dialog, Some(Dialog::Open(d)) if d.error.as_deref() == Some("Enter a server address like https://grimnotes.app/") && !d.busy), "{bad}");
        }
        log(&rest);
        let other = "https://other.example";
        type_in(&mut app, 5, "https://other.example/");
        submit_open(&mut app, &mut tx);
        assert_eq!(log(&rest), vec!["GET /api/server".to_string()], "checked, nothing created before the connect flow");
        let Some(Dialog::Open(d)) = &app.dialog else { panic!("the dialog waits") };
        assert!(d.busy && d.error.is_none());
        assert_eq!(d.status.as_deref(), Some("Waiting for the browser to connect to other.example…"));
        assert_eq!(app.switcher.pending_new, Some((other.to_string(), "Road trip".to_string())));
        let ok = crate::remote::Connected { name: "Other".into(), token: "t_new".into(), token_id: None, account: Some("Ann".into()) };
        app.connected(app.switcher.connect_gen, other, Ok(ok), &mut tx);
        assert!(log(&rest).contains(&r#"POST /api/workspaces {"title":"Road trip"}"#.to_string()));
        assert!(app.dialog.is_none() && app.switcher.pending_new.is_none());
        assert!(matches!(&app.current, Some(WsRef::Remote { server, .. }) if server == other), "{:?}", app.current);
        assert_eq!(app.current.as_ref().unwrap().name(), "Road trip");
        // the connect flow failing: said in the form
        open(&mut app, OpenChoice::NewRemote, &mut tx);
        type_in(&mut app, 4, "Trip");
        type_in(&mut app, 5, "https://third.example");
        submit_open(&mut app, &mut tx);
        app.connected(app.switcher.connect_gen, "https://third.example", Err(ApiError::Network("refused".into())), &mut tx);
        assert!(matches!(&app.dialog, Some(Dialog::Open(d)) if d.error.as_deref() == Some("Can't reach third.example. Check the address and your connection.") && !d.busy && d.status.is_none()));
        assert!(app.switcher.pending_new.is_none());
        let s = "https://grimoire.example";
        assert_eq!(new_remote_error(s, &ApiError::NotGrimoire("x".into())), "grimoire.example isn't a Grimoire server.");
        assert_eq!(new_remote_error(s, &ApiError::Forbidden("no".into())), "You don't have permission to create workspaces on grimoire.example.");
        assert_eq!(server_origin("grimoire.exe.xyz").as_deref(), Ok("https://grimoire.exe.xyz"));
        assert_eq!(server_origin(" http://100.1.2.3:3000/app/x ").as_deref(), Ok("http://100.1.2.3:3000"));
    }

    /// New → Remote folder's Server: the open folder's server, else the first connected one (the switcher's
    /// order), else grimnotes.app; editable either way.
    #[test]
    fn new_remote_folder_server_defaults_to_one_already_known() {
        let mut tx = Tx::default();
        let server_of = |app: &mut App, tx: &mut Tx| open(app, OpenChoice::NewRemote, tx).server_url.text.clone();
        // nothing known
        let mut app = App::new("", None, true);
        assert_eq!(server_of(&mut app, &mut tx), "https://grimnotes.app/");
        // a remote folder open: its server, even with another connected first
        let (mut app, _) = app_on(false);
        app.store.servers.insert(0, app.store.servers[0].clone());
        app.store.servers[0].url = "http://100.1.2.3:3000".into();
        assert_eq!(server_of(&mut app, &mut tx), "https://grimoire.example/");
        // a local folder open: the first connected server in the switcher's order
        let dir = std::env::temp_dir().join(format!("grimoire-newsrv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        app.open_local(dir.clone(), &mut tx);
        assert_eq!(server_of(&mut app, &mut tx), "http://100.1.2.3:3000/");
        // … skipping a signed-out one
        app.switcher.server_issues.push(("http://100.1.2.3:3000".into(), crate::switcher::ServerIssue::SignedOut));
        assert_eq!(server_of(&mut app, &mut tx), "https://grimoire.example/");
        // still editable
        type_in(&mut app, 5, "https://elsewhere.example/");
        let Some(Dialog::Open(d)) = &app.dialog else { panic!() };
        assert_eq!(d.server_url.text, "https://elsewhere.example/");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_local_folders_are_made_and_opened_never_over_one_that_exists() {
        let parent = std::env::temp_dir().join(format!("grimoire-newfolder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        std::fs::create_dir_all(parent.join("Taken")).unwrap();
        let parent = std::fs::canonicalize(&parent).unwrap();
        // a window's app (not headless) writes
        let mut app = App::new("", None, false);
        let mut tx = Tx::default();
        let d = open(&mut app, OpenChoice::NewFolder, &mut tx);
        assert_eq!(d.parent.text, "~/Documents");
        assert!(d.folder_name.focused);
        type_in(&mut app, 2, parent.to_str().unwrap());
        for (name, err) in [("Taken", format!("There's already a “Taken” in {}.", workspaces::tilde(&parent))), ("a/b", "A workspace name can't start with “.” or contain “/”.".into()), (".hidden", "A workspace name can't start with “.” or contain “/”.".into())] {
            type_in(&mut app, 3, name);
            submit_open(&mut app, &mut tx);
            assert!(matches!(&app.dialog, Some(Dialog::Open(d)) if d.error.as_deref() == Some(err.as_str())), "{name}");
        }
        type_in(&mut app, 2, "/no/such/place");
        type_in(&mut app, 3, "Trip");
        submit_open(&mut app, &mut tx);
        assert!(matches!(&app.dialog, Some(Dialog::Open(d)) if d.error.as_deref() == Some("No folder at /no/such/place")));
        type_in(&mut app, 2, parent.to_str().unwrap());
        submit_open(&mut app, &mut tx);
        assert!(app.dialog.is_none());
        assert!(parent.join("Trip").is_dir(), "made");
        assert_eq!(app.current, Some(WsRef::Local { path: parent.join("Trip") }), "and open");
        assert_eq!((app.root.as_deref(), app.path.as_deref()), (Some(parent.join("Trip").as_path()), None), "an empty folder: no note yet");
        assert!(app.store.recent.iter().any(|(w, _)| *w == WsRef::Local { path: parent.join("Trip") }), "remembered under This Mac");
        // headless runs don't write
        let mut app = App::new("", None, true);
        open(&mut app, OpenChoice::NewFolder, &mut tx);
        type_in(&mut app, 2, parent.to_str().unwrap());
        type_in(&mut app, 3, "Dry");
        submit_open(&mut app, &mut tx);
        assert!(app.dialog.is_none() && !parent.join("Dry").exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    fn labels_of(app: &App) -> Vec<String> {
        crate::menu::items(app).iter().map(crate::menu::Item::label).collect()
    }

    /// The card shows on every remote folder (anyone signed in may make an agent link, someone else's folder
    /// too), and for a local folder copies instructions with its path (no server).
    #[test]
    fn the_agent_card_everywhere_and_for_local_folders() {
        let (app, _) = app_on(false);
        assert!(app.agent_card_shown());
        let dir = std::env::temp_dir().join(format!("grimoire-agent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let mut app = App::new("", None, true);
        let mut tx = Tx::default();
        app.open_local(dir.clone(), &mut tx);
        assert!(app.agent_card_shown());
        copy_agent_prompt(&mut app, &mut tx);
        let want = format!(
            "Work in this folder of Markdown notes: {}\nRead and edit the .md files in it directly (any tools are fine); Grimoire shows the changes as they happen. Keep notes as Markdown.",
            dir.display()
        );
        assert_eq!(app.copied.as_deref(), Some(want.as_str()));
        assert!(app.agent.copied);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_link_prompt() {
        let (mut app, rest) = app_on(false);
        let mut tx = Tx::default();
        log(&rest);
        // the sidebar card's Copy: the web's prompt with this account's agent link, copied
        assert!(app.agent_card_shown());
        assert!(!labels_of(&app).contains(&"Share with agent…".to_string()), "no menu item any more");
        copy_agent_prompt(&mut app, &mut tx);
        assert_eq!(log(&rest), vec![r#"POST /api/repos/team/shares {}"#.to_string()]);
        let prompt = app.copied.clone().unwrap();
        let url = prompt.split_whitespace().find(|w| w.starts_with("https://")).unwrap();
        assert!(url.starts_with("https://grimoire.example/a/"), "{prompt}");
        assert_eq!(prompt, dialogs::agent_prompt(url));
        assert!(app.agent.copied && !app.agent.busy, "Copied");
        // the same link next time, without asking the server again
        app.copied = None;
        copy_agent_prompt(&mut app, &mut tx);
        assert!(log(&rest).is_empty());
        assert_eq!(app.copied.as_deref(), Some(prompt.as_str()));
        assert!(!app.ed.is_read_only(), "someone else's folder: editable");
    }

    /// The × always asks first (the web's wording); Remove leaves a remote folder or forgets a local one;
    /// the only folder in the list can't go.
    #[test]
    fn the_x_asks_before_removing_a_folder_from_the_list() {
        let (mut app, rest) = app_on(false);
        let mut tx = Tx::default();
        log(&rest);
        app.switcher.open = true;
        let other = WsRef::Remote { server: S.into(), id: "other".into(), title: "Other".into() };
        app.ask_remove_folder(other, &mut tx);
        assert!(!app.switcher.open, "the menu closes under the dialog");
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.confirm.as_str(), c.cancel.as_str(), c.danger), ("Remove Other from your list?", "Remove", "Cancel", false));
        assert_eq!(c.message, "This doesn't delete the workspace. All existing links to it keep working, and if you open a link to it again, it'll come back to your list.");
        assert!(log(&rest).is_empty(), "nothing sent before Remove");
        confirm(&mut app, &mut tx);
        assert_eq!(log(&rest)[0], "DELETE /api/workspaces/other/join");
        assert_eq!(app.toast(), Some("Removed Other from your list"));
        assert_eq!(app.current.as_ref().unwrap().name(), "Team", "not the open one: it stays open");
        // a local folder: forgotten here, its files untouched
        let dir = std::env::temp_dir().join(format!("grimoire-forget-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let local = WsRef::Local { path: dir.clone() };
        app.store.touch(&local, None);
        app.ask_remove_folder(local.clone(), &mut tx);
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!(c.title, format!("Remove {} from your list?", local.name()));
        assert_eq!(c.message, "This doesn't delete the workspace's folder or its files. You can open it again any time with Open Folder…");
        confirm(&mut app, &mut tx);
        assert!(!app.store.recent.iter().any(|(w, _)| w.same(&local)) && dir.is_dir());
        assert_eq!(app.toast(), Some(format!("Removed {} from your list", local.name()).as_str()));
        // Team is the only folder left: it can't go; "New workspace…" opens the New dialog
        let team = app.current.clone().unwrap();
        app.ask_remove_folder(team, &mut tx);
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.confirm.as_str(), c.cancel.as_str()), ("Can't remove your only workspace", "New workspace…", "OK"));
        assert_eq!(c.message, "You can't remove the only workspace in your list. Create a new workspace first, then remove this one.");
        confirm(&mut app, &mut tx);
        assert_eq!(app.dialog.as_ref().map(Dialog::title).as_deref(), Some("New workspace"));
        assert!(log(&rest).is_empty() && app.current.as_ref().unwrap().name() == "Team", "nothing removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leave_and_remove() {
        let (mut app, rest) = app_on(false);
        let mut tx = Tx::default();
        log(&rest);
        // the open folder: left (after the ×'s confirm), and the next one opens
        app.leave_folder(S, "team", "Team", &mut tx);
        assert!(app.dialog.is_none());
        assert_eq!(log(&rest)[0], "DELETE /api/workspaces/team/join");
        assert_eq!(app.toast(), Some("Removed Team from your list"));
        assert_eq!(app.current.as_ref().unwrap().name(), "Other", "the next joined workspace opens");
        assert!(!app.store.server(S).unwrap().joined.iter().any(|j| j.id == "team"));

        // a folder that isn't open (one we made, too): the open one stays put
        let (mut app, rest) = app_on(true);
        log(&rest);
        app.switcher.open = true;
        app.leave_folder(S, "other", "Other", &mut tx);
        assert!(app.dialog.is_none());
        assert_eq!(log(&rest)[0], "DELETE /api/workspaces/other/join");
        assert_eq!(app.toast(), Some("Removed Other from your list"));
        assert_eq!(app.current.as_ref().unwrap().name(), "Team");
        assert!(app.switcher.open, "the menu stays open, without the row");
        assert!(!app.store.server(S).unwrap().joined.iter().any(|j| j.id == "other"));
        // leaving the open folder when it was the last one: no folder open
        app.leave_folder(S, "team", "Team", &mut tx);
        assert!(!app.switcher.open);
        assert!(!matches!(app.current, Some(WsRef::Remote { .. })), "{:?}", app.current);

        let (mut app, rest) = app_on(true);
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
    fn change_name_and_sign_out() {
        let (mut app, rest) = app_on(true);
        let mut tx = Tx::default();
        app.run_act(Act::ChangeName, &mut tx);
        let Some(Dialog::Prompt(p)) = &app.dialog else { panic!() };
        assert_eq!((p.title.as_str(), p.input.text.as_str(), p.submit.as_str()), ("Change name", "Ann", "Save"));
        type_in(&mut app, 0, "Ann Lee");
        log(&rest);
        submit_prompt(&mut app, &mut tx);
        assert_eq!(log(&rest)[0], r#"PATCH /api/me {"name":"Ann Lee"}"#);
        assert_eq!(app.store.server(S).unwrap().account.as_deref(), Some("Ann Lee"));
        assert_eq!(crate::menu::account(&app, S), ("Ann Lee".to_string(), "ann@example.com".to_string()));
        assert_eq!(crate::menu::account_label(&app).as_deref(), Some("Ann Lee"));

        app.run_act(Act::SignOut, &mut tx);
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!((c.title.as_str(), c.confirm.as_str()), ("Sign out", "Sign out"));
        assert!(c.message.starts_with("Sign out of grimoire.example?"));
        confirm(&mut app, &mut tx);
        assert!(app.store.server(S).is_none());
        assert_eq!(app.remote.as_ref().unwrap().problem, Some(crate::remote::Problem::SignedOut));
    }

    #[test]
    fn open_remote_and_local_folders() {
        let (mut app, _) = app_on(true);
        let mut tx = Tx::default();
        let d = open(&mut app, OpenChoice::Remote, &mut tx);
        assert_eq!(d.choice.submit(), "Open");
        type_in(&mut app, 0, "https://g.example/settings");
        submit_open(&mut app, &mut tx);
        let Some(Dialog::Open(d)) = &app.dialog else { panic!() };
        assert_eq!(d.error.as_deref(), Some("That isn't a workspace or note link. It looks like https://server/app/workspace or https://server/app/workspace/note.md."));
        type_in(&mut app, 0, "https://grimoire.example/app/other");
        submit_open(&mut app, &mut tx);
        assert!(app.dialog.is_none());
        assert_eq!(app.current.as_ref().unwrap().name(), "Other");
        // Open Folder… (headless: the path dialog in place of the system picker; no sign-in), from a remote
        // folder, then from a local one
        let dir = std::env::temp_dir().join(format!("grimoire-open-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("b")).unwrap();
        app.run_act(Act::OpenFolder, &mut tx);
        assert!(matches!(&app.dialog, Some(Dialog::Prompt(p)) if p.kind == PromptKind::OpenPath));
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

    /// Open → URL takes a folder's link or a note's (nested, encoded spaces, old /r/ links, no .md): the folder
    /// opens, at that note; a note that isn't there opens the folder with "No note at …".
    #[test]
    fn open_url_takes_folder_and_note_links() {
        let mut tx = Tx::default();
        let (mut app, rest) = app_on(true);
        rest.lock().unwrap().workspaces.iter_mut().find(|w| w.id == "other").unwrap().files = vec!["README.md".into(), "trips/summer plans/Day one.md".into(), "Plan.md".into()];
        if let crate::remote::Backend::Mock(m) = &app.backend {
            m.borrow_mut().tree = vec!["README.md".into(), "trips/summer plans/Day one.md".into(), "Plan.md".into()];
        }
        let d = open(&mut app, OpenChoice::Remote, &mut tx);
        assert_eq!(d.choice.label(), "URL");
        let open_url = |app: &mut App, url: &str, tx: &mut Tx| {
            open(app, OpenChoice::Remote, tx);
            type_in(app, 0, url);
            submit_open(app, tx);
            assert!(app.dialog.is_none(), "{url}");
        };
        let note = |app: &App| app.remote.as_ref().and_then(|r| r.note.clone());
        // a folder link: its first note (by name)
        open_url(&mut app, "https://grimoire.example/app/other", &mut tx);
        assert_eq!((app.current.as_ref().unwrap().name().as_str(), note(&app).as_deref()), ("Other", Some("Plan.md")));
        // a note link: nested, encoded spaces
        app.toasts.clear();
        open_url(&mut app, "https://grimoire.example/app/other/trips/summer%20plans/Day%20one.md", &mut tx);
        assert_eq!(note(&app).as_deref(), Some("trips/summer plans/Day one.md"));
        assert_eq!(app.toast(), None);
        // an old /r/ link without .md
        open_url(&mut app, "https://grimoire.example/r/other/Plan", &mut tx);
        assert_eq!(note(&app).as_deref(), Some("Plan.md"));
        // a missing note: the folder, and why not the note
        open_url(&mut app, "https://grimoire.example/app/other/nope/Missing.md", &mut tx);
        assert_eq!(app.current.as_ref().unwrap().name(), "Other");
        assert_eq!(note(&app).as_deref(), Some("Plan.md"), "its first note");
        assert_eq!(app.toast(), Some("No note at “nope/Missing.md”"));
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
    }

    #[test]
    fn add_github_repo_opens_it() {
        let (mut app, rest) = app_on(true);
        rest.lock().unwrap().github_app = Some("grimoire-app".into());
        let mut tx = Tx::default();
        let d = open(&mut app, OpenChoice::GitHub, &mut tx);
        assert_eq!((d.choice.label(), d.choice.submit(), d.server.as_deref()), ("GitHub repo", "Add", Some(S)));
        assert_eq!(d.gh.app_slug.as_deref(), Some("grimoire-app"));
        type_in(&mut app, 1, "not a repo");
        submit_open(&mut app, &mut tx);
        let Some(g) = app.dialog.as_mut().and_then(Dialog::github_mut) else { panic!() };
        assert_eq!(g.error.as_deref(), Some("Enter a GitHub URL (https://github.com/owner/name) or owner/name."));
        type_in(&mut app, 1, "acme/docs");
        log(&rest);
        submit_open(&mut app, &mut tx);
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
