//! Modal dialogs, drawn like the web app's (`dialogs.ts`, `workspaces.ts`, app.css `.modal`): a title with
//! a × close, a body, actions at the bottom right; a dimmed backdrop that closes it, Esc too. Their wording
//! is the web app's. What they do is in `actions.rs`.

use rune::{Drag, El, Phase, Shape, TextEdit, TextStyle, Tx, col, el, row, text, text_input};

use crate::App;
use crate::theme::*;

const W: f32 = 440.0;
const W_WIDE: f32 = 600.0;
/// "Share with an agent" (the web's `.share-modal`).
const W_SHARE: f32 = 520.0;
const PAD: f32 = 20.0;

/// A one-field dialog's purpose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptKind {
    ChangeName,
    /// "Open folder" when the system picker can't run (headless): a path.
    OpenPath,
}

#[derive(Clone, Debug)]
pub struct Prompt {
    pub kind: PromptKind,
    pub title: String,
    pub label: String,
    pub hint: Option<String>,
    pub submit: String,
    pub placeholder: String,
    pub input: TextEdit,
    pub error: Option<String>,
}

impl Prompt {
    /// A one-field dialog with `value` in its field, selected, and the keys.
    pub fn new(kind: PromptKind, title: &str, label: &str, value: &str, submit: &str) -> Prompt {
        let mut input = field_edit(value);
        input.focused = true;
        input.anchor = 0;
        input.focus = value.len();
        Prompt { kind, title: title.into(), label: label.into(), hint: None, submit: submit.into(), placeholder: String::new(), input, error: None }
    }

    pub fn hint(mut self, h: &str) -> Prompt {
        self.hint = Some(h.into());
        self
    }

    pub fn placeholder(mut self, p: &str) -> Prompt {
        self.placeholder = p.into();
        self
    }
}

/// What a guest tried that needs an account there (outside workspaces open to guests): done after signing in.
#[derive(Clone, Debug, PartialEq)]
pub enum GuestAction {
    /// New note / New folder in this folder (the tree's current row then, relative; None: the root).
    NewNote(Option<String>),
    NewFolder(Option<String>),
    Rename(String),
    Delete(String),
    /// Image drop or paste (not done again after signing in: drop or paste it again).
    Images,
}

impl GuestAction {
    /// The sign-in prompt's line (the web's `reasonLine`).
    pub fn line(&self) -> &'static str {
        match self {
            GuestAction::NewNote(_) | GuestAction::NewFolder(_) => "Sign in to create notes and folders. It's free.",
            GuestAction::Rename(_) => "Sign in to rename notes and folders. It's free.",
            GuestAction::Delete(_) => "Sign in to delete notes and folders. It's free.",
            GuestAction::Images => "Sign in to add images. It's free.",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ConfirmKind {
    /// A guest's sign-in prompt: Sign in connects this Mac to an account on `server` (the browser's /connect,
    /// Continue with Google), then the action runs.
    SignIn { server: String, action: GuestAction },
    SignOut { server: String },
    /// Signing in: "Continue in your browser…" with Cancel only (closing it cancels the sign-in).
    SigningIn { server: String },
    /// The sign-in failed: why, with Retry.
    SignInFailed { server: String },
    /// A folder row's ×: take it off the list (leave a remote one, forget a local one).
    ForgetFolder { ws: crate::workspaces::WsRef },
    /// The × on the only folder in the list: it can't go ("New workspace…" opens the New dialog).
    OnlyFolder,
    /// A tree row's Delete: a note, or a folder and everything in it.
    Delete { rel: String, dir: bool },
    /// History's "Restore this version".
    Restore { sha: String },
    /// A local folder's first opening: track its changes (`repo` false: `git init`), or commit
    /// automatically in its repository (`repo`: off unless chosen; `gitsync`).
    Git { root: std::path::PathBuf, repo: bool },
}

#[derive(Clone, Debug)]
pub struct Confirm {
    pub kind: ConfirmKind,
    pub title: String,
    pub message: String,
    pub confirm: String,
    /// The other button ("Cancel"; "OK" where it just closes a notice).
    pub cancel: String,
    pub danger: bool,
}

/// "Delete your account?" (the web's `deleteAccountDialog`): what goes, the email, Cancel and a red Delete account
/// that can be pressed after a second (`armed`).
#[derive(Clone, Debug)]
pub struct DeleteAccountDlg {
    pub server: String,
    pub email: String,
    /// A second after opening (headless and tests: at once), so a double click on the menu item can't delete.
    pub armed: bool,
    /// The request is out: both buttons wait, Esc and the backdrop don't close it.
    pub busy: bool,
    pub error: Option<String>,
}

/// How long "Delete account" stays disabled after the dialog opens (the web's `DELETE_ACCOUNT_DELAY_MS`).
pub const DELETE_ACCOUNT_DELAY: std::time::Duration = std::time::Duration::from_millis(1000);

#[derive(Clone, Debug)]
pub struct AddGitHub {
    pub server: String,
    pub input: TextEdit,
    /// Edit (needs the GitHub App) rather than read-only; offered only when the server has the app.
    pub edit: bool,
    pub app_slug: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
    pub busy: bool,
}

/// What the "Open" and "New" dialogs show: their list of choices on the left (Open: Folder, URL, GitHub repo;
/// New: Folder, Remote folder), the chosen one's form on the right.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenChoice {
    /// A folder on this Mac (the system folder picker).
    Folder,
    /// "URL": a remote folder by its link, or a note in it (the folder opens at that note).
    Remote,
    GitHub,
    /// A new folder on this Mac: where and its name.
    NewFolder,
    /// A new folder on a server (typed; connected first when the app isn't yet).
    NewRemote,
}

impl OpenChoice {
    /// Open…: remote folders only (a folder on this Mac is Open Folder…, the system picker).
    pub const OPEN: [OpenChoice; 2] = [OpenChoice::Remote, OpenChoice::GitHub];
    pub const CREATE: [OpenChoice; 2] = [OpenChoice::NewFolder, OpenChoice::NewRemote];

    pub fn label(self) -> &'static str {
        match self {
            OpenChoice::Folder => "Folder",
            OpenChoice::NewFolder => "On this Mac",
            OpenChoice::Remote => "URL",
            OpenChoice::NewRemote => "On a server",
            OpenChoice::GitHub => "GitHub repo",
        }
    }

    /// Element keys (`open-choice-<id>`).
    pub fn id(self) -> &'static str {
        match self {
            OpenChoice::Folder => "folder",
            OpenChoice::Remote => "remote",
            OpenChoice::GitHub => "github",
            OpenChoice::NewFolder => "new-folder",
            OpenChoice::NewRemote => "new-remote",
        }
    }

    /// Its primary button.
    pub fn submit(self) -> &'static str {
        match self {
            OpenChoice::Folder | OpenChoice::Remote => "Open",
            OpenChoice::GitHub => "Add",
            OpenChoice::NewFolder | OpenChoice::NewRemote => "Create",
        }
    }
}

#[derive(Clone, Debug)]
pub struct OpenDlg {
    pub choice: OpenChoice,
    /// The servers the app is signed in to, and the one a GitHub repo or a new remote folder goes to
    /// (the open remote folder's, else the first).
    pub servers: Vec<String>,
    pub server: Option<String>,
    /// Of `servers`, the ones that let people add GitHub repos (`/api/server` `githubCopies`, grim's
    /// `GITHUB_COPIES`): none, and Open doesn't offer GitHub repo.
    pub gh_servers: Vec<String>,
    /// The "New" dialog (Folder, Remote folder) rather than "Open".
    pub new: bool,
    /// New remote folder: the server's address.
    pub server_url: TextEdit,
    /// What it's waiting for ("Waiting for the browser to connect to …").
    pub status: Option<String>,
    /// URL: a folder's or a note's link.
    pub url: TextEdit,
    /// GitHub repo (its `server` follows `OpenDlg::server`).
    pub gh: AddGitHub,
    /// New folder: where (a path, ~ allowed) and its name.
    pub parent: TextEdit,
    pub folder_name: TextEdit,
    /// New remote folder: its name.
    pub remote_name: TextEdit,
    /// The shown form's error.
    pub error: Option<String>,
    pub busy: bool,
}

impl OpenDlg {
    /// The text fields, by `Dialog::field` number: URL, GitHub, location, folder name, remote name, server.
    fn fields(&mut self) -> [&mut TextEdit; 6] {
        [&mut self.url, &mut self.gh.input, &mut self.parent, &mut self.folder_name, &mut self.remote_name, &mut self.server_url]
    }

    /// Its list of choices.
    pub fn choices(&self) -> &'static [OpenChoice] {
        if self.new {
            &OpenChoice::CREATE
        } else if self.gh_servers.is_empty() {
            // a guest everywhere (no account), or no server allows it: no GitHub repo, as the web hides it then
            &OpenChoice::OPEN[..1]
        } else {
            &OpenChoice::OPEN
        }
    }

    /// The field a choice puts the keys in.
    fn field_of(choice: OpenChoice) -> Option<usize> {
        match choice {
            OpenChoice::Folder => None,
            OpenChoice::Remote => Some(0),
            OpenChoice::GitHub => Some(1),
            OpenChoice::NewFolder => Some(3),
            OpenChoice::NewRemote => Some(4),
        }
    }

    /// Show `choice`'s form, its field focused.
    pub fn pick(&mut self, choice: OpenChoice) {
        // a choice it doesn't offer (GitHub repo for a guest): the URL form
        let choice = if self.choices().contains(&choice) { choice } else { OpenChoice::Remote };
        if choice == OpenChoice::GitHub && !self.server.as_ref().is_some_and(|s| self.gh_servers.contains(s)) {
            // GitHub repos go to a server that takes them
            self.server = self.gh_servers.first().cloned();
            self.gh = AddGitHub { server: self.server.clone().unwrap_or_default(), app_slug: None, status: None, error: None, busy: false, ..self.gh.clone() };
        }
        self.choice = choice;
        self.error = None;
        self.status = None;
        let f = Self::field_of(choice);
        for (i, e) in self.fields().into_iter().enumerate() {
            e.focused = Some(i) == f;
        }
    }
}

/// "Share with an agent" (the sidebar card's Share; the web's `shareDialog`): for a remote folder, "This
/// workspace" (this account's agent link and its prompt) and "All your workspaces (MCP)" (the server's `/mcp`,
/// a prompt to add it, opencode's config); for a local folder only its prompt.
#[derive(Clone, Debug)]
pub struct ShareDlg {
    /// A local folder's prompt (`actions::local_agent_prompt`): nothing else to show.
    pub local: Option<String>,
    /// The remote folder: its server and id.
    pub server: String,
    pub id: String,
    /// This account's agent link for it (None while it's being made).
    pub link: Option<String>,
    /// Making the link failed: why.
    pub error: Option<String>,
    /// The server has no sign-in: MCP needs none.
    pub no_sign_in: bool,
    /// "opencode config" is open (collapsed at first).
    pub snippets: bool,
}

impl ShareDlg {
    pub fn local(prompt: String) -> ShareDlg {
        ShareDlg { local: Some(prompt), server: String::new(), id: String::new(), link: None, error: None, no_sign_in: false, snippets: false }
    }

    pub fn remote(server: &str, id: &str, link: Option<String>, no_sign_in: bool) -> ShareDlg {
        ShareDlg { local: None, server: server.into(), id: id.into(), link, error: None, no_sign_in, snippets: false }
    }

    /// The server's MCP URL: its public address (the agent link's origin), else the address we connect to.
    pub fn mcp_url(&self) -> String {
        format!("{}/mcp", origin(self.link.as_deref().unwrap_or(&self.server)))
    }
}

/// `https://host:port` of a URL (no path).
fn origin(url: &str) -> &str {
    let rest = url.find("://").map_or(0, |i| i + 3);
    url[rest..].find('/').map_or(url, |i| &url[..rest + i])
}

#[derive(Clone, Debug)]
pub enum Dialog {
    Prompt(Box<Prompt>),
    Confirm(Confirm),
    Open(Box<OpenDlg>),
    Share(Box<ShareDlg>),
    /// The first sign-in's welcome: the new workspace's title (the web's `welcomeDialog`, word for word).
    Welcome(String),
    DeleteAccount(Box<DeleteAccountDlg>),
}

impl Dialog {
    pub fn title(&self) -> String {
        match self {
            Dialog::Prompt(p) => p.title.clone(),
            Dialog::Confirm(c) => c.title.clone(),
            Dialog::Open(o) => if o.new { "New workspace" } else { "Open workspace" }.into(),
            Dialog::Share(_) => "Share with an agent".into(),
            Dialog::Welcome(_) => "Welcome to Grim".into(),
            Dialog::DeleteAccount(_) => "Delete your account?".into(),
        }
    }

    /// The sign-in dialog (waiting for the browser, or its error with Retry).
    pub fn is_sign_in(&self) -> bool {
        matches!(self, Dialog::Confirm(c) if matches!(c.kind, ConfirmKind::SigningIn { .. } | ConfirmKind::SignInFailed { .. }))
    }

    fn wide(&self) -> bool {
        matches!(self, Dialog::Open(_))
    }

    /// A text field of the dialog (`n`: which), for Rune's `on_edit`.
    pub fn field(&mut self, n: usize) -> Option<&mut TextEdit> {
        match (self, n) {
            (Dialog::Prompt(p), _) => Some(&mut p.input),
            (Dialog::Open(o), n) => o.fields().into_iter().nth(n),
            _ => None,
        }
    }

    /// Whether one of its fields has the keys.
    pub fn typing(&self) -> bool {
        match self {
            Dialog::Prompt(p) => p.input.focused,
            Dialog::Open(o) => [&o.url, &o.gh.input, &o.parent, &o.folder_name, &o.remote_name, &o.server_url].iter().any(|e| e.focused),
            _ => false,
        }
    }
}

impl Dialog {
    /// The GitHub form, while the Open dialog shows it.
    pub fn github_mut(&mut self) -> Option<&mut AddGitHub> {
        match self {
            Dialog::Open(o) if o.choice == OpenChoice::GitHub => Some(&mut o.gh),
            _ => None,
        }
    }
}

pub fn field_edit(text: &str) -> TextEdit {
    TextEdit::new(text)
}

/// The text the sidebar's "Share with an agent" card copies for a remote folder (the web app's, word for word).
pub fn agent_prompt(url: &str) -> String {
    format!(
        "Work in this Grim notebook: {url}\nFetch that URL first (HTTP GET) for instructions; it is a workspace of Markdown files you work on by POSTing shell commands to the same URL."
    )
}

/// The MCP section's prompt: add the server's `/mcp` to the agent's MCP configuration (the web app's, word for word).
pub fn mcp_prompt(mcp_url: &str, no_sign_in: bool) -> String {
    let auth = if no_sign_in { "no sign-in needed on this server" } else { "it signs in with OAuth in the browser the first time" };
    format!("Add the Grim MCP server to your MCP configuration: URL {mcp_url} (Streamable HTTP; {auth}). Then use its list_workspaces, command and changes tools to work in my Grim workspaces.")
}

/// "opencode config" (the web's `mcpSnippets`, from docs/README.md): where it goes, the snippet.
pub fn mcp_snippet(mcp_url: &str, no_sign_in: bool) -> (&'static str, String) {
    (if no_sign_in { "In opencode.json:" } else { "In opencode.json, then opencode mcp auth grim:" }, format!(r#"{{"mcp": {{"grim": {{"type": "remote", "url": "{mcp_url}"}}}}}}"#))
}

// ---------------------------------------------------------------------------------------------
// Drawing

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Btn {
    Primary,
    Secondary,
    Danger,
    /// The red one: "Delete account" (the web's `.btn-red`).
    Red,
    Small,
}

type Handler = Box<dyn Fn(&mut App, &mut Tx)>;

fn on_down(f: Handler) -> impl Fn(&mut App, &mut Drag, &mut Tx) + 'static {
    move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
        if d.phase == Phase::Down {
            f(app, tx);
            app.handled(tx);
        }
    }
}

/// A button like the web app's `.btn` (32 pt; primary/danger in ink; small 28 pt).
pub fn button(label: &str, key: &str, kind: Btn, disabled: bool, f: Handler) -> El {
    let small = matches!(kind, Btn::Small);
    let dark = matches!(kind, Btn::Primary | Btn::Danger | Btn::Red);
    let (fill, ink, border) = match (dark, disabled) {
        _ if kind == Btn::Red => (c(RED).alpha(if disabled { 0.45 } else { 1.0 }), c("#ffffff"), c(RED).alpha(if disabled { 0.45 } else { 1.0 })),
        (true, false) => (c(INK), c(PAPER), c(INK)),
        (true, true) => (c(PAPER_3), c(MUTED), c(PAPER_3)),
        (false, _) => (c(PAPER), c(if disabled { MUTED } else { INK }), line()),
    };
    let mut b = row()
        .key(key.to_string())
        .label(label.to_string())
        .h(if small { 28.0 } else { 32.0 })
        .px(if small { 10.0 } else { 14.0 })
        .center()
        .radius(6.0)
        .fill(fill)
        .border(1.0, border)
        .child(text(label.to_string()).key(format!("{key}-text")).font(TextStyle::new(if small { 12.5 } else { 13.0 }, crate::theme::wt(550.0)).lh(16.0)).color(ink));
    if !disabled {
        b = b.hover(if kind == Btn::Red { c(RED_HOVER) } else if dark { c("#000000") } else { c(PAPER_2) }).on_drag(on_down(f));
    }
    b
}

/// A text field (34 pt, the web app's `input[type=text]`).
pub fn field(key: &str, edit: &TextEdit, placeholder: &str, n: usize, w: f32, submit: fn(&mut App, &mut Tx)) -> El {
    text_input(edit, TextStyle::new(14.0, 400.0).lh(18.0))
        .single_line()
        .key(key.to_string())
        .w(w)
        .h(34.0)
        .px(10.0)
        .py(8.0)
        .fill(c(PAPER))
        .radius(6.0)
        .border(1.0, if edit.focused { c(LINK) } else { c(GREY) })
        .color(c(INK))
        .placeholder(placeholder.to_string(), c(GREY))
        .caret(c(INK), selection())
        .on_edit(move |app: &mut App| match app.dialog.as_mut().and_then(|d| d.field(n)) {
            Some(f) => f,
            None => &mut app.switcher.input,
        })
        // Esc closes the dialog (Rune's field would only blur).
        .on_input_key(|app: &mut App, ev: &rune::KeyEvent, tx: &mut Tx| {
            if !matches!(ev.key, rune::Key::Escape) {
                return false;
            }
            app.dialog = None;
            app.handled(tx)
        })
        .on_submit(move |app: &mut App, tx: &mut Tx| {
            submit(app, tx);
            app.handled(tx);
        })
}

/// A choice between a few options (the web app's `<select>`), as a segmented control.
pub fn segmented(key: &str, options: &[(&str, &str)], value: &str, f: fn(&mut App, &str, &mut Tx)) -> El {
    let mut r = row().key(key.to_string()).h(30.0).padding(2.0).gap(2.0).radius(7.0).fill(c(BG2)).center_y();
    for (v, l) in options {
        let on = *v == value;
        let v2 = v.to_string();
        let mut seg = row()
            .key(format!("{key}-{v}"))
            .label(l.to_string())
            .h(26.0)
            .px(10.0)
            .center()
            .radius(5.0)
            .child(text(l.to_string()).key(format!("{key}-{v}-text")).font(TextStyle::new(12.5, if on { 600.0 } else { 500.0 }).lh(16.0)).color(c(if on { INK } else { INK_2 })));
        seg = if on { seg.fill(c(PAPER)).border(1.0, line()) } else { seg.hover(c(TINT_ACTIVE)) };
        if !on {
            seg = seg.on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
                if d.phase == Phase::Down {
                    f(app, &v2, tx);
                    app.handled(tx);
                }
            });
        }
        r = r.child(seg);
    }
    r
}

/// A vertical choice (radio buttons).
pub fn radios(key: &str, options: &[(&str, &str)], value: &str, f: fn(&mut App, &str, &mut Tx)) -> El {
    let mut col_ = col().key(key.to_string()).gap(8.0);
    for (v, l) in options {
        let on = *v == value;
        let v2 = v.to_string();
        let dot = el().key(format!("{key}-{v}-dot")).size(16.0, 16.0).radius(8.0).border(if on { 5.0 } else { 1.5 }, c(if on { INK } else { GREY })).fill(c(PAPER));
        let mut r = row().key(format!("{key}-{v}")).label(l.to_string()).gap(8.0).center_y().child(dot).child(
            text(l.to_string()).key(format!("{key}-{v}-text")).font(TextStyle::new(13.5, 400.0).lh(18.0)).color(c(INK)),
        );
        if !on {
            r = r.on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
                if d.phase == Phase::Down {
                    f(app, &v2, tx);
                    app.handled(tx);
                }
            });
        }
        col_ = col_.child(r);
    }
    col_
}

fn p(s: impl Into<String>, key: &str, w: f32) -> El {
    text(s.into()).key(key.to_string()).font(TextStyle::new(14.0, 400.0).lh(21.0)).color(c(INK)).w(w).wrap()
}

fn hint(s: impl Into<String>, key: &str, w: f32) -> El {
    text(s.into()).key(key.to_string()).font(TextStyle::new(12.5, 400.0).lh(19.0)).color(c(MUTED)).w(w).wrap()
}

fn muted(s: impl Into<String>, key: &str, w: f32) -> El {
    text(s.into()).key(key.to_string()).font(TextStyle::new(14.0, 400.0).lh(21.0)).color(c(MUTED)).w(w).wrap()
}

fn label(s: &str, key: &str) -> El {
    text(s.to_string()).key(key.to_string()).font(TextStyle::new(12.5, crate::theme::wt(550.0)).lh(15.0)).color(c(INK_2))
}

/// The web app's `.form-error`: a soft yellow box.
fn form_error(s: &str, key: &str, w: f32) -> El {
    col().key(key.to_string()).w(w).px(10.0).py(8.0).radius(6.0).fill(c(WARN_SOFT)).child(
        text(s.to_string()).key(format!("{key}-text")).font(TextStyle::new(13.0, crate::theme::wt(500.0)).lh(18.0)).color(c(INK)).w(w - 20.0).wrap(),
    )
}

fn actions(kids: Vec<El>, key: &str, w: f32) -> El {
    row().key(key.to_string()).w(w).mt(6.0).gap(8.0).justify_end().children(kids)
}

fn close(app: &mut App, _tx: &mut Tx) {
    app.close_dialog();
}

impl App {
    /// Close the open dialog; the sign-in dialog's closing cancels the sign-in.
    pub fn close_dialog(&mut self) {
        // the account is being deleted: it waits for the answer
        if matches!(&self.dialog, Some(Dialog::DeleteAccount(d)) if d.busy) {
            return;
        }
        if let Some(Dialog::Confirm(c)) = &self.dialog
            && matches!(c.kind, ConfirmKind::SigningIn { .. })
        {
            self.cancel_connect();
        }
        if let Some(Dialog::Confirm(c)) = self.dialog.take()
            && let ConfirmKind::Git { root, .. } = c.kind
        {
            self.git_declined(&root);
        }
    }
}

/// The open dialog: a backdrop over the window and the dialog in the middle.
pub fn overlay(app: &App, vw: f32, vh: f32) -> Vec<El> {
    let Some(d) = &app.dialog else { return Vec::new() };
    let w = (if d.wide() { W_WIDE } else if matches!(d, Dialog::Share(_)) { W_SHARE } else { W }).min(vw - 32.0);
    let bw = w - 2.0 * PAD;
    let body = match d {
        Dialog::Prompt(p_) => prompt_body(p_, bw),
        Dialog::Confirm(c_) => confirm_body(c_, bw),
        Dialog::Open(o) => open_body(o, bw),
        Dialog::Share(s_) => share_body(s_, app.agent.copied.as_deref(), bw),
        Dialog::Welcome(t) => welcome_body(t, bw),
        Dialog::DeleteAccount(d_) => delete_account_body(d_, bw),
    };
    let backdrop = el().key("dlg-backdrop").absolute(0.0, 0.0).size(vw, vh).fill(c("#18181b").alpha(0.3)).on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
        // the sign-in dialog closes only through its own buttons (and Escape, its Cancel), never a click outside;
        // nor does "Delete your account?" (the web's `backdrop: false`)
        if d.phase == Phase::Down && !app.dialog.as_ref().is_some_and(|d| d.is_sign_in() || matches!(d, Dialog::DeleteAccount(_))) {
            app.close_dialog();
            app.handled(tx);
        }
    });
    let x_btn = el()
        .key("dlg-close")
        .label("Close")
        .size(24.0, 24.0)
        .radius(4.0)
        .hover(c(PAPER_2))
        .shape(Shape::new().stroke(vec![[7.5, 7.5], [16.5, 16.5]], 1.4, c(MUTED)).stroke(vec![[16.5, 7.5], [7.5, 16.5]], 1.4, c(MUTED)))
        .on_drag(on_down(Box::new(close)));
    let head = row()
        .key("dlg-head")
        .w(w - 2.0)
        .pt(16.0)
        .pl(PAD)
        .pr(12.0)
        .justify_between()
        .center_y()
        .child(text(d.title()).key("dlg-title").font(TextStyle::new(16.0, crate::theme::wt(650.0)).lh(21.0).tracking(-0.16)).color(c(INK)).w(w - PAD - 12.0 - 36.0).truncate())
        .child(x_btn);
    let modal = col()
        .key("dlg")
        .w(w)
        .max_h(vh - 48.0)
        .fill(c(PAPER))
        .radius(8.0)
        .border(1.0, line())
        .shadow(24.0, 64.0, c("#18181b").alpha(0.18))
        .clip_soft(0.0)
        // presses inside it don't reach the backdrop
        .on_drag(|_: &mut App, _: &mut Drag, _: &mut Tx| {})
        .child(head)
        .child(col().key("dlg-body").w(w - 2.0).px(PAD).pt(14.0).pb(PAD).gap(14.0).children(body));
    let center = col().key("dlg-center").absolute(0.0, 0.0).size(vw, vh).center().child(modal);
    vec![backdrop, center]
}

fn prompt_body(d: &Prompt, w: f32) -> Vec<El> {
    let mut kids = vec![col().key("dlg-field").gap(6.0).child(label(&d.label, "dlg-label")).child(field("dlg-input", &d.input, &d.placeholder, 0, w, crate::actions::submit_prompt))];
    if let Some(h) = &d.hint {
        kids.push(hint(h.clone(), "dlg-hint", w));
    }
    if let Some(e) = &d.error {
        kids.push(form_error(e, "dlg-error", w));
    }
    let submit = d.submit.clone();
    kids.push(actions(
        vec![
            button("Cancel", "dlg-cancel", Btn::Secondary, false, Box::new(close)),
            button(&submit, "dlg-submit", Btn::Primary, false, Box::new(crate::actions::submit_prompt)),
        ],
        "dlg-actions",
        w,
    ));
    kids
}

fn confirm_body(d: &Confirm, w: f32) -> Vec<El> {
    // "Leave It to Me" is the default (Return) of the Git repository dialog: it's the primary button there
    let cancel_first = crate::gitsync::default_is_cancel(&d.kind);
    let confirm_kind = if cancel_first { Btn::Secondary } else if d.danger { Btn::Danger } else { Btn::Primary };
    let mut buttons: Vec<El> = vec![
        button(&d.cancel, "dlg-cancel", if cancel_first { Btn::Primary } else { Btn::Secondary }, false, Box::new(close)),
        button(&d.confirm, "dlg-confirm", confirm_kind, false, Box::new(crate::actions::confirm)),
    ]
    .into_iter()
    .enumerate()
    .filter(|(i, _)| *i == 0 || !d.confirm.is_empty())
    .map(|(_, b)| b)
    .collect();
    // the default button at the right, as on the Mac
    if cancel_first {
        buttons.reverse();
    }
    vec![p(d.message.clone(), "dlg-message", w), actions(buttons, "dlg-actions", w)]
}

pub const SELF_HOST_URL: &str = "https://github.com/anomalyco/grim";

fn welcome_body(title: &str, w: f32) -> Vec<El> {
    let lead = "If you need privacy, you can self-host Grim: ";
    let link = "github.com/anomalyco/grim";
    let range = lead.len()..lead.len() + link.len();
    let span = rune::Span { color: Some(c(LINK)), underline: Some(c(LINK).alpha(0.55)), ..rune::Span::new(range.start, range.end) };
    let self_host = rune::rich(format!("{lead}{link}."), vec![span])
        .key("welcome-self-host")
        .font(TextStyle::new(14.0, 400.0).lh(21.0))
        .color(c(INK))
        .w(w)
        .link(rune::Link::new(range, SELF_HOST_URL))
        .on_link(|app: &mut App, url: &str, _tx: &mut Tx| app.launch(url));
    vec![
        p(format!("Your notes live in “{title}”."), "welcome-where", w),
        // the key warning: the whole line bold
        p("Your notes are public. Anyone with the link to a workspace can see and edit its notes, even without signing in.", "welcome-link", w)
            .font(TextStyle::new(14.0, crate::theme::wt(650.0)).lh(21.0)),
        p("Grim is in beta, and private notes aren’t available yet.", "welcome-beta", w),
        self_host,
        actions(vec![button("Got it", "dlg-confirm", Btn::Primary, false, Box::new(close))], "dlg-actions", w),
    ]
}

/// "Delete your account?" (the web's `deleteAccountDialog`, word for word).
fn delete_account_body(d: &DeleteAccountDlg, w: f32) -> Vec<El> {
    let mut kids = Vec::new();
    if !d.email.is_empty() {
        let sz = TextStyle::new(14.0, 400.0).lh(21.0);
        kids.push(
            row()
                .key("del-email")
                .w(w)
                .child(text("Signed in as ".to_string()).key("del-email-pre").font(sz).color(c(INK)))
                .child(text(d.email.clone()).key("del-email-addr").font(TextStyle::new(14.0, crate::theme::wt(650.0)).lh(21.0)).color(c(INK)).truncate())
                .child(text(".".to_string()).key("del-email-post").font(sz).color(c(INK))),
        );
    }
    let mut list = col().key("del-list").w(w).gap(2.0);
    for (n, line) in [
        "Your account and all its sign-ins, including Grim for Mac and connected MCP apps",
        "Your agent links",
        "The workspaces you created, with their notes and history",
    ]
    .into_iter()
    .enumerate()
    {
        list = list.child(
            row()
                .key(format!("del-li-{n}"))
                .w(w)
                .child(text("•".to_string()).key(format!("del-li-{n}-dot")).font(TextStyle::new(14.0, 400.0).lh(21.0)).color(c(INK)).w(20.0).pl(6.0))
                .child(p(line, &format!("del-li-{n}-text"), w - 20.0)),
        );
    }
    kids.push(col().key("del-what").w(w).gap(8.0).child(p("This permanently deletes:", "del-intro", w)).child(list));
    kids.push(p("Workspaces other people created aren't affected. This can't be undone.", "del-outro", w));
    if let Some(e) = &d.error {
        kids.push(form_error(e, "dlg-error", w));
    }
    kids.push(actions(
        vec![
            button("Cancel", "dlg-cancel", Btn::Secondary, d.busy, Box::new(close)),
            button(if d.busy { "Deleting…" } else { "Delete account" }, "dlg-delete-account", Btn::Red, !d.armed || d.busy, Box::new(crate::actions::delete_account)),
        ],
        "dlg-actions",
        w,
    ));
    kids
}

fn github_body(d: &AddGitHub, w: f32, kids: &mut Vec<El>) {
    kids.push(col()
        .key("dlg-field")
        .gap(6.0)
        .child(label("GitHub URL or owner/name", "dlg-label"))
        .child(field("open-github", &d.input, "https://github.com/owner/name", 1, w, crate::actions::submit_open)));
    if let Some(slug) = &d.app_slug {
        kids.push(radios(
            "gh-mode",
            &[("read", "Read-only"), ("edit", "Edit (needs the GitHub App installed)")],
            if d.edit { "edit" } else { "read" },
            |app, v, _| {
                if let Some(g) = app.dialog.as_mut().and_then(Dialog::github_mut) {
                    g.edit = v == "edit";
                }
            },
        ));
        if d.edit {
            kids.push(hint(format!("Editing syncs both ways and needs the Grim GitHub App (github.com/apps/{slug}) installed on the repo."), "gh-install", w));
        }
    }
    kids.push(hint("Shows the repo's Markdown files and keeps them up to date with GitHub. Read-only works for any public repo.", "dlg-hint", w));
    if let Some(s) = &d.status {
        kids.push(hint(s.clone(), "gh-status", w));
    }
    if let Some(e) = &d.error {
        kids.push(form_error(e, "dlg-error", w));
    }
}

/// Width of the Open dialog's list of choices.
const OPEN_NAV_W: f32 = 150.0;

/// "Open" / "New": the choices at the left, the chosen form at the right.
fn open_body(d: &OpenDlg, w: f32) -> Vec<El> {
    let mut nav = col().key("open-nav").w(OPEN_NAV_W).gap(2.0);
    {
        for &ch in d.choices() {
            let on = ch == d.choice;
            let mut r = row()
                .key(format!("open-choice-{}", ch.id()))
                .label(ch.label())
                .w(OPEN_NAV_W)
                .h(30.0)
                .px(8.0)
                .center_y()
                .radius(6.0)
                .child(text(ch.label()).key(format!("open-choice-{}-text", ch.id())).font(TextStyle::new(13.5, if on { 600.0 } else { 450.0 }).lh(18.0)).color(c(INK)));
            r = if on { r.fill(c(TINT_ACTIVE)) } else { r.hover(c(PAPER_2)).on_drag(on_down(Box::new(move |app: &mut App, tx: &mut Tx| crate::actions::pick_open(app, ch, tx)))) };
            nav = nav.child(r);
        }
    }
    // one choice (URL only): just its form, no list of choices
    let single = d.choices().len() < 2;
    let pw = if single { w } else { w - OPEN_NAV_W - 20.0 };
    let mut kids: Vec<El> = Vec::new();
    let no_server = d.gh_servers.is_empty();
    match d.choice {
        OpenChoice::Folder => kids.push(p("Open a folder of Markdown notes on this Mac.", "open-folder-text", pw)),
        OpenChoice::Remote => {
            let placeholder = format!("{}app/…", d.server.as_deref().map_or_else(|| crate::actions::DEFAULT_SERVER.to_string(), |s| format!("{}/", s.trim_end_matches('/'))));
            kids.push(col().key("dlg-field").gap(6.0).child(label("URL", "dlg-label")).child(field("open-url", &d.url, &placeholder, 0, pw, crate::actions::submit_open)));
            kids.push(hint("Paste the link to a workspace or a note on any Grim server.", "dlg-hint", pw));
        }
        OpenChoice::GitHub if no_server => {
            kids.push(muted("Connect to a Grim server first: open a workspace by its URL and sign in.", "open-no-server", pw));
        }
        OpenChoice::GitHub => {
            server_choice(d, pw, &mut kids);
            github_body(&d.gh, pw, &mut kids);
        }
        OpenChoice::NewFolder => {
            kids.push(
                col().key("open-where").gap(6.0).child(label("Location", "open-where-label")).child(
                    row()
                        .key("open-where-row")
                        .w(pw)
                        .gap(8.0)
                        .center_y()
                        .child(field("open-where-input", &d.parent, "~/Documents", 2, pw - 90.0, crate::actions::submit_open))
                        .child(button("Choose…", "open-where-choose", Btn::Secondary, false, Box::new(crate::actions::choose_parent))),
                ),
            );
            kids.push(col().key("dlg-field").gap(6.0).child(label("Name", "dlg-label")).child(field("open-name", &d.folder_name, "", 3, pw, crate::actions::submit_open)));
            kids.push(hint("A new workspace on this Mac: a folder of Markdown notes.", "dlg-hint", pw));
        }
        OpenChoice::NewRemote => {
            kids.push(col().key("open-server").gap(6.0).child(label("Server", "open-server-label")).child(field("open-server-url", &d.server_url, crate::actions::DEFAULT_SERVER, 5, pw, crate::actions::submit_open)));
            kids.push(col().key("dlg-field").gap(6.0).child(label("Name", "dlg-label")).child(field("open-remote-name", &d.remote_name, "", 4, pw, crate::actions::submit_open)));
            kids.push(hint("A workspace of Markdown notes on that server. If you haven't connected to the server yet, you sign in first.", "dlg-hint", pw));
            if let Some(s) = &d.status {
                kids.push(hint(s.clone(), "open-status", pw));
            }
        }
    }
    if let Some(e) = &d.error {
        kids.push(form_error(e, "dlg-error", pw));
    }
    let mut buttons = vec![button("Cancel", "dlg-cancel", Btn::Secondary, false, Box::new(close))];
    if d.choice == OpenChoice::GitHub && no_server {
        buttons.push(button("Add a server…", "open-add-server", Btn::Primary, false, Box::new(|app: &mut App, tx: &mut Tx| crate::actions::pick_open(app, OpenChoice::Remote, tx))));
    } else {
        let busy = d.busy || (d.choice == OpenChoice::GitHub && d.gh.busy);
        buttons.push(button(d.choice.submit(), "dlg-submit", Btn::Primary, busy, Box::new(crate::actions::submit_open)));
    }
    kids.push(actions(buttons, "dlg-actions", pw));
    let pane = col().key("open-pane").w(pw).gap(14.0).children(kids);
    if single {
        return vec![row().key("open-dlg").w(w).child(pane)];
    }
    vec![row().key("open-dlg").w(w).gap(20.0).child(nav).child(pane)]
}

/// Which connected server a GitHub repo goes to: a choice when there are several.
fn server_choice(d: &OpenDlg, w: f32, kids: &mut Vec<El>) {
    if d.gh_servers.len() < 2 {
        return;
    }
    let hosts: Vec<(String, String)> = d.gh_servers.iter().map(|s| (s.clone(), crate::menu::host(s))).collect();
    let opts: Vec<(&str, &str)> = hosts.iter().map(|(s, h)| (s.as_str(), h.as_str())).collect();
    kids.push(
        col().key("open-server").w(w).gap(6.0).child(label("Server", "open-server-label")).child(segmented("open-server-pick", &opts, d.server.as_deref().unwrap_or_default(), |app, v, tx| {
            crate::actions::pick_open_server(app, v, tx);
        })),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_prompt_is_the_web_apps() {
        assert_eq!(
            agent_prompt("https://g.example/a/abc"),
            "Work in this Grim notebook: https://g.example/a/abc\nFetch that URL first (HTTP GET) for instructions; it is a workspace of Markdown files you work on by POSTing shell commands to the same URL."
        );
    }

    /// The first sign-in's welcome: its title, and Escape or Return closes it.
    #[test]
    fn the_welcome_closes_on_escape_and_return() {
        let mut app = App::new("", None, true);
        let mut tx = Tx::default();
        for k in [rune::Key::Escape, rune::Key::Enter] {
            app.dialog = Some(Dialog::Welcome("Ada's notes".into()));
            assert_eq!(app.dialog.as_ref().unwrap().title(), "Welcome to Grim");
            crate::input::on_key(&mut app, &rune::KeyEvent { key: k, mods: rune::Mods::default() }, &mut tx);
            assert!(app.dialog.is_none());
        }
    }
}

// ---------------------------------------------------------------------------------------------
// "Share with an agent" (the web's `shareDialog`, app.css `.share-*`)

/// A section: its heading (the web's `.share-sec h3`), then its parts 8 pt apart.
fn share_sec(key: &str, title: &str, kids: Vec<El>, w: f32) -> El {
    col()
        .key(key.to_string())
        .w(w)
        .gap(8.0)
        .child(text(title.to_string()).key(format!("{key}-title")).font(TextStyle::new(13.5, crate::theme::wt(600.0)).lh(17.5)).color(c(INK)))
        .children(kids)
}

/// "Copy" → "Copied" for a moment: the button that copied last (`AgentCard::copied`).
fn copy_label(label: &str, key: &str, copied: Option<&str>) -> String {
    if copied == Some(key) { "Copied".into() } else { label.into() }
}

/// Copies `text` (the shown dialog's), "Copied" on the button `key` for a moment.
fn copier(text: String, key: &str) -> Handler {
    let key = key.to_string();
    Box::new(move |app: &mut App, tx: &mut Tx| crate::actions::copy(app, &text, &key, tx))
}

const CODE_COPY_W: f32 = 58.0;

/// A value in a monospace field with its own small Copy (the web's `.share-code`); `wrap`: long snippets wrap.
fn code_field(key: &str, value: &str, copy: Option<String>, copied: Option<&str>, wrap: bool, w: f32) -> El {
    let tw = w - 2.0 - 10.0 - 4.0 - 8.0 - CODE_COPY_W;
    let mono = TextStyle::new(12.5, 400.0).lh(19.0).mono();
    let t = text(value.to_string()).key(format!("{key}-text")).font(if copy.is_some() { mono } else { TextStyle::new(12.5, 400.0).lh(19.0) }).color(c(if copy.is_some() { INK } else { MUTED })).w(tw);
    let t = if wrap { t.wrap() } else { t.truncate() };
    let copy_key = format!("{key}-copy");
    let disabled = copy.is_none();
    let label = copy_label("Copy", &copy_key, copied);
    let mut b = row()
        .key(copy_key.clone())
        .label(label.clone())
        .w(CODE_COPY_W)
        .h(24.0)
        .center()
        .radius(4.0)
        .fill(c(PAPER))
        .border(1.0, line())
        .child(text(label).key(format!("{copy_key}-text")).font(TextStyle::new(12.0, crate::theme::wt(550.0)).lh(15.0)).color(c(if disabled { MUTED } else { INK_2 })));
    if let Some(v) = copy {
        b = b.hover(c(PAPER_2)).on_drag(on_down(copier(v, &copy_key)));
    }
    let r = row().key(key.to_string()).w(w).min_h(34.0).pl(10.0).pr(4.0).py(4.0).gap(8.0).radius(6.0).fill(c(PAPER_2)).border(1.0, line());
    let r = if wrap { r.items_start() } else { r.center_y() };
    r.child(if wrap { t.mt(2.0) } else { t }).child(b)
}

/// "Copy prompt" (the web's `.share-btns .btn`: 112 pt at least, so "Copied" doesn't shrink it).
fn prompt_button(key: &str, ready: bool, f: fn(&mut App, &mut Tx), copied: Option<&str>) -> El {
    let label = copy_label("Copy prompt", key, copied);
    let disabled = !ready;
    let f: Handler = Box::new(f);
    row().key(format!("{key}-row")).mt(2.0).child(button(&label, key, Btn::Secondary, disabled, f).min_w(112.0))
}

fn share_body(d: &ShareDlg, copied: Option<&str>, w: f32) -> Vec<El> {
    let done = actions(vec![button("Done", "dlg-done", Btn::Primary, false, Box::new(close))], "dlg-actions", w);
    // the web's `.share-modal .modal-actions`: 20 pt above (14 of the body's gap, 6 here)
    if d.local.is_some() {
        let kids = vec![
            hint("Give this prompt to an agent on this Mac. It reads and edits the notes in this folder directly; Grim shows its changes as they happen.", "share-local-hint", w).mb(4.0),
            prompt_button("share-prompt", true, crate::actions::copy_agent_prompt, copied),
        ];
        return vec![share_sec("share-local", "This folder", kids, w), done];
    }
    let link_text = match (&d.link, &d.error) {
        (Some(l), _) => l.clone(),
        (None, Some(e)) => e.clone(),
        (None, None) => "Making a link…".into(),
    };
    let ws = vec![
        hint("Give this prompt to an agent. It works with this workspace directly over HTTP (no setup) and can only see this workspace.", "share-ws-hint", w).mb(4.0),
        code_field("share-link", &link_text, d.link.clone(), copied, false, w),
        prompt_button("share-prompt", d.link.is_some(), crate::actions::copy_agent_prompt, copied),
    ];
    let mcp = d.mcp_url();
    let line = if d.no_sign_in {
        "Add Grim as an MCP server in your agent or tool (Claude, Cursor, opencode…). It can work with all the workspaces on this server; no sign-in needed on this server."
    } else {
        "Add Grim as an MCP server in your agent or tool (Claude, Cursor, opencode…). It can work with all your workspaces, and signs in with your Grim account the first time."
    };
    let open = d.snippets;
    let toggle = row()
        .key("share-snippets")
        .label("opencode config")
        .mt(4.0)
        .gap(6.0)
        .center_y()
        .child(text(if open { "▼" } else { "▶" }).key("share-snippets-arrow").font(TextStyle::new(9.0, 400.0).lh(17.0)).color(c(INK_2)))
        .child(text("opencode config").key("share-snippets-text").font(TextStyle::new(13.0, crate::theme::wt(550.0)).lh(17.0)).color(c(INK_2)))
        .on_drag(on_down(Box::new(|app: &mut App, _: &mut Tx| {
            if let Some(Dialog::Share(s)) = &mut app.dialog {
                s.snippets = !s.snippets;
            }
        })));
    let mut mcp_kids = vec![
        hint(line, "share-mcp-hint", w).mb(4.0),
        code_field("share-mcp", &mcp, Some(mcp.clone()), copied, false, w),
        prompt_button("share-mcp-prompt", true, crate::actions::copy_mcp_prompt, copied),
        toggle,
    ];
    if open {
        let (where_, code) = mcp_snippet(&mcp, d.no_sign_in);
        mcp_kids.push(
            col()
                .key("share-snippet")
                .w(w)
                .mt(4.0)
                .gap(6.0)
                .child(text(where_).key("share-snippet-where").font(TextStyle::new(12.5, 400.0).lh(18.0)).color(c(MUTED)))
                .child(code_field("share-snippet-code", &code, Some(code.clone()), copied, true, w)),
        );
    }
    // a hairline between the sections, 18 pt either side (the body's 14 + 4)
    let rule = el().key("share-rule").w(w).h(1.0).my(4.0).fill(c("#18181b").alpha(0.07));
    vec![share_sec("share-ws", "This workspace", ws, w), rule, share_sec("share-mcp-sec", "All your workspaces (MCP)", mcp_kids, w), done]
}
