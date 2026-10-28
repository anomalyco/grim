//! Modal dialogs, drawn like the web app's (`dialogs.ts`, `workspaces.ts`, app.css `.modal`): a title with
//! a × close, a body, actions at the bottom right; a dimmed backdrop that closes it, Esc too. Their wording
//! is the web app's. What they do is in `actions.rs`.

use rune::{Drag, El, Phase, Shape, TextEdit, TextStyle, Tx, col, el, row, text, text_input};

use crate::App;
use crate::theme::*;

const W: f32 = 440.0;
const W_WIDE: f32 = 600.0;
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

#[derive(Clone, Debug, PartialEq)]
pub enum ConfirmKind {
    Remove { server: String, id: String, title: String },
    SignOut { server: String },
    /// A folder row's ×: take it off the list (leave a remote one, forget a local one).
    ForgetFolder { ws: crate::workspaces::WsRef },
    /// The × on the only folder in the list: it can't go ("New folder…" opens the New dialog).
    OnlyFolder,
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
    pub const OPEN: [OpenChoice; 3] = [OpenChoice::Folder, OpenChoice::Remote, OpenChoice::GitHub];
    pub const CREATE: [OpenChoice; 2] = [OpenChoice::NewFolder, OpenChoice::NewRemote];

    pub fn label(self) -> &'static str {
        match self {
            OpenChoice::Folder | OpenChoice::NewFolder => "Folder",
            OpenChoice::Remote => "URL",
            OpenChoice::NewRemote => "Remote folder",
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
        if self.new { &OpenChoice::CREATE } else { &OpenChoice::OPEN }
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
        self.choice = choice;
        self.error = None;
        self.status = None;
        let f = Self::field_of(choice);
        for (i, e) in self.fields().into_iter().enumerate() {
            e.focused = Some(i) == f;
        }
    }
}

#[derive(Clone, Debug)]
pub enum Dialog {
    Prompt(Box<Prompt>),
    Confirm(Confirm),
    Open(Box<OpenDlg>),
}

impl Dialog {
    pub fn title(&self) -> String {
        match self {
            Dialog::Prompt(p) => p.title.clone(),
            Dialog::Confirm(c) => c.title.clone(),
            Dialog::Open(o) => if o.new { "New" } else { "Open" }.into(),
        }
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
        "Work in this Grimoire notebook: {url}\nFetch that URL first (HTTP GET) for instructions; it is a folder of Markdown files you work on by POSTing shell commands to the same URL."
    )
}

// ---------------------------------------------------------------------------------------------
// Drawing

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Btn {
    Primary,
    Secondary,
    Danger,
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
    let dark = matches!(kind, Btn::Primary | Btn::Danger);
    let (fill, ink, border) = match (dark, disabled) {
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
        .child(text(label.to_string()).key(format!("{key}-text")).font(TextStyle::new(if small { 12.5 } else { 13.0 }, 550.0).lh(16.0)).color(ink));
    if !disabled {
        b = b.hover(if dark { c("#000000") } else { c(PAPER_2) }).on_drag(on_down(f));
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
    text(s.to_string()).key(key.to_string()).font(TextStyle::new(12.5, 550.0).lh(15.0)).color(c(INK_2))
}

/// The web app's `.form-error`: a soft yellow box.
fn form_error(s: &str, key: &str, w: f32) -> El {
    col().key(key.to_string()).w(w).px(10.0).py(8.0).radius(6.0).fill(c(WARN_SOFT)).child(
        text(s.to_string()).key(format!("{key}-text")).font(TextStyle::new(13.0, 500.0).lh(18.0)).color(c(INK)).w(w - 20.0).wrap(),
    )
}

fn actions(kids: Vec<El>, key: &str, w: f32) -> El {
    row().key(key.to_string()).w(w).mt(6.0).gap(8.0).justify_end().children(kids)
}

fn close(app: &mut App, _tx: &mut Tx) {
    app.dialog = None;
}

/// The open dialog: a backdrop over the window and the dialog in the middle.
pub fn overlay(app: &App, vw: f32, vh: f32) -> Vec<El> {
    let Some(d) = &app.dialog else { return Vec::new() };
    let w = (if d.wide() { W_WIDE } else { W }).min(vw - 32.0);
    let bw = w - 2.0 * PAD;
    let body = match d {
        Dialog::Prompt(p_) => prompt_body(p_, bw),
        Dialog::Confirm(c_) => confirm_body(c_, bw),
        Dialog::Open(o) => open_body(o, bw),
    };
    let backdrop = el().key("dlg-backdrop").absolute(0.0, 0.0).size(vw, vh).fill(c("#18181b").alpha(0.3)).on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
        if d.phase == Phase::Down {
            app.dialog = None;
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
        .child(text(d.title()).key("dlg-title").font(TextStyle::new(16.0, 650.0).lh(21.0).tracking(-0.16)).color(c(INK)).w(w - PAD - 12.0 - 36.0).truncate())
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
    vec![
        p(d.message.clone(), "dlg-message", w),
        actions(
            vec![
                button(&d.cancel, "dlg-cancel", Btn::Secondary, false, Box::new(close)),
                button(&d.confirm, "dlg-confirm", if d.danger { Btn::Danger } else { Btn::Primary }, false, Box::new(crate::actions::confirm)),
            ],
            "dlg-actions",
            w,
        ),
    ]
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
            kids.push(hint(format!("Editing syncs both ways and needs the Grimoire GitHub App (github.com/apps/{slug}) installed on the repo."), "gh-install", w));
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
    let pw = w - OPEN_NAV_W - 20.0;
    let mut kids: Vec<El> = Vec::new();
    let no_server = d.servers.is_empty();
    match d.choice {
        OpenChoice::Folder => kids.push(p("Open a folder of Markdown notes on this Mac.", "open-folder-text", pw)),
        OpenChoice::Remote => {
            let placeholder = format!("{}app/…", d.server.as_deref().map_or_else(|| crate::actions::DEFAULT_SERVER.to_string(), |s| format!("{}/", s.trim_end_matches('/'))));
            kids.push(col().key("dlg-field").gap(6.0).child(label("URL", "dlg-label")).child(field("open-url", &d.url, &placeholder, 0, pw, crate::actions::submit_open)));
            kids.push(hint("Paste the link to a folder or a note on any Grimoire server.", "dlg-hint", pw));
        }
        OpenChoice::GitHub if no_server => {
            kids.push(muted("Connect to a Grimoire server first: open a remote folder by its URL and sign in.", "open-no-server", pw));
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
            kids.push(hint("A new folder of Markdown notes on this Mac.", "dlg-hint", pw));
        }
        OpenChoice::NewRemote => {
            kids.push(col().key("open-server").gap(6.0).child(label("Server", "open-server-label")).child(field("open-server-url", &d.server_url, crate::actions::DEFAULT_SERVER, 5, pw, crate::actions::submit_open)));
            kids.push(col().key("dlg-field").gap(6.0).child(label("Name", "dlg-label")).child(field("open-remote-name", &d.remote_name, "", 4, pw, crate::actions::submit_open)));
            kids.push(hint("A folder of Markdown notes on that server. If you haven't connected to the server yet, you sign in first.", "dlg-hint", pw));
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
    vec![row().key("open-dlg").w(w).gap(20.0).child(nav).child(col().key("open-pane").w(pw).gap(14.0).children(kids))]
}

/// Which connected server a GitHub repo goes to: a choice when there are several.
fn server_choice(d: &OpenDlg, w: f32, kids: &mut Vec<El>) {
    if d.servers.len() < 2 {
        return;
    }
    let hosts: Vec<(String, String)> = d.servers.iter().map(|s| (s.clone(), crate::menu::host(s))).collect();
    let opts: Vec<(&str, &str)> = hosts.iter().map(|(s, h)| (s.as_str(), h.as_str())).collect();
    kids.push(
        col().key("open-server").w(w).gap(6.0).child(label("Server", "open-server-label")).child(segmented("open-server-pick", &opts, d.server.as_deref().unwrap_or_default(), |app, v, tx| {
            crate::actions::pick_open_server(app, v, tx);
        })),
    );
}

pub fn initials(who: &str) -> String {
    let parts: Vec<&str> = who.split(|c: char| c.is_whitespace() || c == '@' || c == '.').filter(|s| !s.is_empty()).collect();
    let mut s: String = parts.iter().take(2).filter_map(|p| p.chars().next()).collect();
    if s.is_empty() {
        s = "?".into();
    }
    s.to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_for_the_account_row() {
        assert_eq!(initials("Ann Lee"), "AL");
        assert_eq!(initials("bob@example.com"), "BE");
        assert_eq!(initials(""), "?");
    }

    #[test]
    fn the_agent_prompt_is_the_web_apps() {
        assert_eq!(
            agent_prompt("https://g.example/a/abc"),
            "Work in this Grimoire notebook: https://g.example/a/abc\nFetch that URL first (HTTP GET) for instructions; it is a folder of Markdown files you work on by POSTing shell commands to the same URL."
        );
    }
}
