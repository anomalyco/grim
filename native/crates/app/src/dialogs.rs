//! Modal dialogs, drawn like the web app's (`dialogs.ts`, `workspaces.ts`, app.css `.modal`): a title with
//! a × close, a body, actions at the bottom right; a dimmed backdrop that closes it, Esc too. Their wording
//! is the web app's. What they do is in `actions.rs`.

use rune::{Drag, El, Phase, Shape, TextEdit, TextStyle, Tx, col, el, row, text, text_input};
use serde_json::Value;

use crate::App;
use crate::theme::*;

const W: f32 = 440.0;
const W_WIDE: f32 = 600.0;
const PAD: f32 = 20.0;

/// A one-field dialog's purpose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptKind {
    /// "Add remote workspace": a workspace URL.
    AddRemote,
    NewWorkspace,
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
    Leave { server: String, id: String, title: String },
    Remove { server: String, id: String, title: String },
    SignOut { server: String },
}

#[derive(Clone, Debug)]
pub struct Confirm {
    pub kind: ConfirmKind,
    pub title: String,
    pub message: String,
    pub confirm: String,
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

#[derive(Clone, Debug)]
pub struct ShareWs {
    pub server: String,
    pub id: String,
    pub title: String,
    /// Google sign-in is on there (otherwise invites can't be accepted yet: a note says so).
    pub google: bool,
    pub details: Option<Value>,
    pub members: Vec<Value>,
    /// Loading failed: shown instead of the body.
    pub load_error: Option<String>,
    pub error: Option<String>,
    pub email: TextEdit,
    pub invite_role: String,
    pub domain: TextEdit,
    pub domain_role: String,
    pub copied: bool,
}

#[derive(Clone, Debug)]
pub struct Agent {
    pub title: String,
    pub read_only: bool,
    pub prompt: Option<String>,
    pub error: Option<String>,
    pub copied: bool,
}

#[derive(Clone, Debug)]
pub struct ShareNote {
    pub server: String,
    pub id: String,
    pub title: String,
    pub path: String,
    pub writable: bool,
    pub role: String,
    pub url: Option<String>,
    pub error: Option<String>,
    pub busy: bool,
    pub copied: bool,
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub server: String,
    pub tokens: Option<Vec<Value>>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Dialog {
    Prompt(Prompt),
    Confirm(Confirm),
    AddGitHub(AddGitHub),
    ShareWs(Box<ShareWs>),
    Agent(Agent),
    ShareNote(ShareNote),
    Settings(Settings),
}

impl Dialog {
    pub fn title(&self) -> String {
        match self {
            Dialog::Prompt(p) => p.title.clone(),
            Dialog::Confirm(c) => c.title.clone(),
            Dialog::AddGitHub(_) => "Add a GitHub repo".into(),
            Dialog::ShareWs(s) => format!("Share “{}”", s.title),
            Dialog::Agent(_) => "Share with agent".into(),
            Dialog::ShareNote(_) => "Share note".into(),
            Dialog::Settings(_) => "Settings".into(),
        }
    }

    fn wide(&self) -> bool {
        matches!(self, Dialog::ShareWs(_) | Dialog::Agent(_) | Dialog::Settings(_))
    }

    /// A text field of the dialog (`n`: which), for Rune's `on_edit`.
    pub fn field(&mut self, n: usize) -> Option<&mut TextEdit> {
        match (self, n) {
            (Dialog::Prompt(p), _) => Some(&mut p.input),
            (Dialog::AddGitHub(g), _) => Some(&mut g.input),
            (Dialog::ShareWs(s), 0) => Some(&mut s.email),
            (Dialog::ShareWs(s), _) => Some(&mut s.domain),
            _ => None,
        }
    }

    /// Whether one of its fields has the keys.
    pub fn typing(&self) -> bool {
        match self {
            Dialog::Prompt(p) => p.input.focused,
            Dialog::AddGitHub(g) => g.input.focused,
            Dialog::ShareWs(s) => s.email.focused || s.domain.focused,
            _ => false,
        }
    }
}

pub fn field_edit(text: &str) -> TextEdit {
    let mut e = TextEdit::new(text);
    e.single_line = true;
    e
}

/// The text of the "Share with agent" prompt (the web app's, word for word).
pub fn agent_prompt(url: &str) -> String {
    format!(
        "Use this Grimoire notebook as your workspace: {url}\nFetch that URL first (HTTP GET) for instructions; it is a folder of Markdown files you work on by POSTing shell commands to the same URL."
    )
}

/// "just now", "12s ago", "5 min ago", "3 h ago", "2 d ago", else the date (the web app's `relativeTime`).
pub fn relative_time(t: &Value, now_ms: i64) -> String {
    let ms = match t {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        _ => return String::new(),
    };
    let s = ((now_ms - ms) as f64 / 1000.0).round() as i64;
    if s < 10 {
        return "just now".into();
    }
    if s < 60 {
        return format!("{s}s ago");
    }
    let m = (s as f64 / 60.0).round() as i64;
    if m < 60 {
        return format!("{m} min ago");
    }
    let h = (m as f64 / 60.0).round() as i64;
    if h < 24 {
        return format!("{h} h ago");
    }
    let d = (h as f64 / 24.0).round() as i64;
    if d < 7 {
        return format!("{d} d ago");
    }
    // days since the epoch → y-m-d (civil from days)
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{month}/{day}/{year}")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

// ---------------------------------------------------------------------------------------------
// Drawing

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Btn {
    Primary,
    Secondary,
    Danger,
    Small,
    SmallPrimary,
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
    let small = matches!(kind, Btn::Small | Btn::SmallPrimary);
    let dark = matches!(kind, Btn::Primary | Btn::Danger | Btn::SmallPrimary);
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

fn h3(s: &str, key: &str) -> El {
    text(s.to_string()).key(key.to_string()).font(TextStyle::new(12.0, 600.0).lh(15.0)).color(c(INK_2))
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

/// A block of monospaced text with a button under it at the right (the web app's `.copy-block`).
fn copy_block(text_: &str, key: &str, w: f32, button_: El) -> El {
    col().key(key.to_string()).w(w).gap(10.0).child(
        col().key(format!("{key}-pre")).w(w).px(14.0).py(12.0).radius(6.0).fill(c(CODE_BG)).child(
            text(text_.to_string()).key(format!("{key}-text")).font(TextStyle::new(12.5, 400.0).lh(19.0).mono()).color(c(INK)).w(w - 28.0).wrap(),
        ),
    )
    .child(row().key(format!("{key}-row")).w(w).justify_end().child(button_))
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
        Dialog::AddGitHub(g) => github_body(g, bw),
        Dialog::ShareWs(s) => share_ws_body(s, bw),
        Dialog::Agent(a) => agent_body(a, bw),
        Dialog::ShareNote(n) => share_note_body(n, bw),
        Dialog::Settings(s) => settings_body(s, bw, app.now_epoch()),
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
                button("Cancel", "dlg-cancel", Btn::Secondary, false, Box::new(close)),
                button(&d.confirm, "dlg-confirm", if d.danger { Btn::Danger } else { Btn::Primary }, false, Box::new(crate::actions::confirm)),
            ],
            "dlg-actions",
            w,
        ),
    ]
}

fn github_body(d: &AddGitHub, w: f32) -> Vec<El> {
    let mut kids = vec![col()
        .key("dlg-field")
        .gap(6.0)
        .child(label("GitHub URL or owner/name", "dlg-label"))
        .child(field("dlg-input", &d.input, "https://github.com/owner/name", 0, w, crate::actions::submit_github))];
    if let Some(slug) = &d.app_slug {
        kids.push(radios(
            "gh-mode",
            &[("read", "Read-only"), ("edit", "Edit (needs the GitHub App installed)")],
            if d.edit { "edit" } else { "read" },
            |app, v, _| {
                if let Some(Dialog::AddGitHub(g)) = &mut app.dialog {
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
    kids.push(actions(
        vec![
            button("Cancel", "dlg-cancel", Btn::Secondary, false, Box::new(close)),
            button("Add repo", "dlg-submit", Btn::Primary, d.busy, Box::new(crate::actions::submit_github)),
        ],
        "dlg-actions",
        w,
    ));
    kids
}

const ROLE_OPTS: [(&str, &str); 2] = [("editor", "Can edit"), ("viewer", "Can view")];
const MEMBER_OPTS: [(&str, &str); 3] = [("owner", "Owner"), ("editor", "Can edit"), ("viewer", "Can view")];
const ACCESS_OPTS: [(&str, &str); 3] = [("none", "Only people added"), ("view", "Anyone with the link can view"), ("edit", "Anyone with the link can edit")];

fn initials(who: &str) -> String {
    let parts: Vec<&str> = who.split(|c: char| c.is_whitespace() || c == '@' || c == '.').filter(|s| !s.is_empty()).collect();
    let mut s: String = parts.iter().take(2).filter_map(|p| p.chars().next()).collect();
    if s.is_empty() {
        s = "?".into();
    }
    s.to_uppercase()
}

fn share_ws_body(d: &ShareWs, w: f32) -> Vec<El> {
    let Some(det) = &d.details else {
        return vec![match &d.load_error {
            Some(e) => form_error(e, "share-load-error", w),
            None => muted("Loading…", "share-loading", w),
        }];
    };
    let mut kids = Vec::new();
    kids.push(
        row()
            .key("invite-row")
            .w(w)
            .gap(8.0)
            .center_y()
            .child(field("invite-email", &d.email, "name@example.com", 0, (w - 8.0 * 2.0 - 160.0 - 72.0).max(120.0), crate::actions::invite))
            .child(segmented("invite-role", &ROLE_OPTS, &d.invite_role, |app, v, _| {
                if let Some(Dialog::ShareWs(s)) = &mut app.dialog {
                    s.invite_role = v.to_string();
                }
            }))
            .child(button("Invite", "invite-submit", Btn::Primary, false, Box::new(crate::actions::invite))),
    );
    if !d.google {
        kids.push(hint(
            "People you invite can accept once Google sign-in is turned on for this server. They'll be asked to sign in with Google using that email.",
            "invite-note",
            w,
        ));
    }
    if let Some(e) = &d.error {
        kids.push(form_error(e, "share-error", w));
    }
    // People
    let owners = d.members.iter().filter(|m| m["role"] == "owner" && m["pending"] != true).count();
    let mut people = col().key("share-people").w(w).gap(8.0).child(h3("People", "share-people-label"));
    if d.members.is_empty() {
        people = people.child(muted("Nobody added yet.", "share-nobody", w));
    } else {
        let mut list = col().key("members").w(w);
        for (i, m) in d.members.iter().enumerate() {
            let pending = m["pending"].as_bool().unwrap_or_else(|| !m["userId"].is_string());
            let name = m["name"].as_str().filter(|s| !s.is_empty());
            let email = m["email"].as_str().filter(|s| !s.is_empty());
            let who = name.or(email).unwrap_or("Someone").to_string();
            let role = m["role"].as_str().unwrap_or("viewer").to_string();
            let last_owner = role == "owner" && owners <= 1;
            let seed = m["userId"].as_str().or(email).or(m["id"].as_str()).unwrap_or("x").to_string();
            let key = format!("member-{i}");
            let color = rune::color::hex(&crate::remote::color_for(&seed)).unwrap_or_else(|| c(MUTED));
            let mut r = row()
                .key(key.clone())
                .w(w)
                .min_h(44.0)
                .py(4.0)
                .gap(10.0)
                .center_y()
                .child(row().key(format!("{key}-avatar")).size(28.0, 28.0).radius(4.0).fill(color).center().child(
                    text(initials(&who)).key(format!("{key}-initials")).font(TextStyle::new(11.0, 650.0).lh(14.0)).color(c("#ffffff")),
                ));
            let mut whocol = col().key(format!("{key}-who")).grow(1.0).shrink().child(
                text(who.clone()).key(format!("{key}-name")).font(TextStyle::new(14.0, 550.0).lh(19.0)).color(c(INK)).truncate(),
            );
            if let (Some(_), Some(e)) = (name, email) {
                whocol = whocol.child(text(e.to_string()).key(format!("{key}-email")).font(TextStyle::new(12.5, 400.0).lh(17.0)).color(c(MUTED)).truncate());
            }
            r = r.child(whocol);
            if pending {
                r = r.child(
                    row().key(format!("{key}-badge")).px(6.0).py(2.0).radius(4.0).fill(c(TINT_ACTIVE)).child(
                        text("Invited").key(format!("{key}-badge-text")).font(TextStyle::new(10.5, 550.0).lh(14.0)).color(c(INK_2)),
                    ),
                );
            }
            if last_owner {
                r = r.child(text("Owner").key(format!("{key}-role")).font(TextStyle::new(13.0, 400.0).lh(17.0)).color(c(MUTED)).px(10.0));
            } else {
                let (mid, em) = (m["id"].as_str().unwrap_or_default().to_string(), email.unwrap_or_default().to_string());
                let opts: Vec<(&str, &str)> = MEMBER_OPTS.to_vec();
                r = r.child(member_role(&key, &opts, &role, em));
                r = r.child(
                    el().key(format!("{key}-remove"))
                        .label(format!("Remove {who}"))
                        .size(24.0, 24.0)
                        .radius(4.0)
                        .hover(c(PAPER_2))
                        .shape(Shape::new().stroke(vec![[8.0, 8.0], [16.0, 16.0]], 1.4, c(MUTED)).stroke(vec![[16.0, 8.0], [8.0, 16.0]], 1.4, c(MUTED)))
                        .on_drag(on_down(Box::new(move |app, tx| crate::actions::remove_member(app, &mid, tx)))),
                );
            }
            if i > 0 {
                list = list.child(el().key(format!("{key}-line")).w(w).h(1.0).fill(c("#18181b").alpha(0.07)));
            }
            list = list.child(r);
        }
        people = people.child(list);
    }
    kids.push(people);
    // General access
    let access = det["linkAccess"].as_str().unwrap_or("none").to_string();
    kids.push(
        col()
            .key("share-access")
            .w(w)
            .gap(8.0)
            .child(h3("General access", "share-access-label"))
            .child(radios("link-access", &ACCESS_OPTS, &access, crate::actions::set_link_access))
            .child(hint(if access == "none" { "Only the people above can open it." } else { "People who aren't signed in get a guest name." }, "share-access-hint", w)),
    );
    // Everyone at a company
    kids.push(
        col()
            .key("share-domain")
            .w(w)
            .gap(8.0)
            .child(h3("Everyone at a company", "share-domain-label"))
            .child(
                row()
                    .key("domain-row")
                    .w(w)
                    .gap(8.0)
                    .center_y()
                    .child(field("domain-input", &d.domain, "*@company.com", 1, (w - 8.0 * 2.0 - 160.0 - 64.0).max(120.0), crate::actions::save_domain))
                    .child(segmented("domain-role", &ROLE_OPTS, &d.domain_role, |app, v, _| {
                        if let Some(Dialog::ShareWs(s)) = &mut app.dialog {
                            s.domain_role = v.to_string();
                        }
                    }))
                    .child(button("Save", "domain-save", Btn::Secondary, false, Box::new(crate::actions::save_domain))),
            )
            .child(hint("Anyone signed in with an email at this domain gets access.", "share-domain-hint", w)),
    );
    let link = crate::actions::workspace_url(&d.server, &d.id);
    kids.push(el().key("share-actions-line").w(w).h(1.0).fill(c("#18181b").alpha(0.07)));
    kids.push(
        row()
            .key("share-actions")
            .w(w)
            .gap(8.0)
            .center_y()
            .child(text(link.clone()).key("share-link").font(TextStyle::new(12.5, 400.0).lh(17.0)).color(c(MUTED)).grow(1.0).shrink().truncate())
            .child(button(if d.copied { "Copied" } else { "Copy link" }, "share-copy", Btn::Small, false, Box::new(move |app, tx| crate::actions::copy(app, &link, "share-copy", tx)))),
    );
    kids
}

fn member_role(key: &str, opts: &[(&str, &str)], role: &str, email: String) -> El {
    let mut r = row().key(format!("{key}-roles")).h(30.0).padding(2.0).gap(2.0).radius(7.0).fill(c(BG2)).center_y();
    for (v, l) in opts {
        let on = *v == role;
        let (v2, em) = (v.to_string(), email.clone());
        let mut seg = row()
            .key(format!("{key}-role-{v}"))
            .label(l.to_string())
            .h(26.0)
            .px(8.0)
            .center()
            .radius(5.0)
            .child(text(l.to_string()).key(format!("{key}-role-{v}-text")).font(TextStyle::new(12.0, if on { 600.0 } else { 500.0 }).lh(16.0)).color(c(if on { INK } else { INK_2 })));
        seg = if on { seg.fill(c(PAPER)).border(1.0, line()) } else { seg.hover(c(TINT_ACTIVE)) };
        if !on {
            seg = seg.on_drag(on_down(Box::new(move |app, tx| crate::actions::set_role(app, &em, &v2, tx))));
        }
        r = r.child(seg);
    }
    r
}

fn agent_body(d: &Agent, w: f32) -> Vec<El> {
    if let Some(e) = &d.error {
        return vec![form_error(e, "agent-error", w)];
    }
    let Some(prompt) = &d.prompt else { return vec![muted("Preparing a link…", "agent-preparing", w)] };
    let what = if d.read_only { "read" } else { "read and edit" };
    let pr = prompt.clone();
    vec![
        hint(format!("Paste this to your agent. It can {what} “{}” as a folder of Markdown files.", d.title), "agent-hint", w),
        copy_block(prompt, "agent-prompt", w, button(if d.copied { "Copied" } else { "Copy" }, "agent-copy", Btn::SmallPrimary, false, Box::new(move |app, tx| crate::actions::copy(app, &pr, "agent-copy", tx)))),
    ]
}

fn share_note_body(d: &ShareNote, w: f32) -> Vec<El> {
    let opts: Vec<(&str, &str)> = if d.writable { vec![("viewer", "Can view"), ("editor", "Can edit")] } else { vec![("viewer", "Can view")] };
    let mut kids = vec![
        p(format!("Anyone with the link sees just this note, not the rest of {}.", d.title), "note-intro", w),
        col().key("note-field").gap(6.0).child(label("People with the link", "note-label")).child(row().key("note-role-row").child(segmented("note-role", &opts, &d.role, |app, v, _| {
            if let Some(Dialog::ShareNote(n)) = &mut app.dialog {
                n.role = v.to_string();
            }
        }))),
    ];
    if let Some(e) = &d.error {
        kids.push(form_error(e, "note-error", w));
    }
    if let Some(url) = &d.url {
        let u = url.clone();
        kids.push(copy_block(url, "note-link", w, button(if d.copied { "Copied" } else { "Copy" }, "note-copy", Btn::Small, false, Box::new(move |app, tx| crate::actions::copy(app, &u, "note-copy", tx)))));
    }
    kids.push(actions(
        vec![
            button("Done", "dlg-cancel", Btn::Secondary, false, Box::new(close)),
            button("Create link", "note-create", Btn::Primary, d.busy, Box::new(crate::actions::create_note_link)),
        ],
        "dlg-actions",
        w,
    ));
    kids
}

fn settings_body(d: &Settings, w: f32, now: i64) -> Vec<El> {
    let list: El = match (&d.tokens, &d.error) {
        (_, Some(e)) => form_error(e, "tokens-error", w),
        (None, None) => muted("Loading…", "tokens-loading", w),
        (Some(t), None) if t.is_empty() => muted("No connected apps.", "tokens-empty", w),
        (Some(t), None) => {
            let mut l = col().key("token-list").w(w);
            for (i, tok) in t.iter().enumerate() {
                let key = format!("token-{i}");
                let label_ = tok["label"].as_str().filter(|s| !s.is_empty()).unwrap_or("App").to_string();
                let used = if tok["lastUsedAt"].is_null() { " · never used".to_string() } else { format!(" · last used {}", relative_time(&tok["lastUsedAt"], now)) };
                let meta = format!("Connected {}{used}", relative_time(&tok["createdAt"], now));
                let id = tok["id"].as_str().unwrap_or_default().to_string();
                let lb = label_.clone();
                if i > 0 {
                    l = l.child(el().key(format!("{key}-line")).w(w).h(1.0).fill(c("#18181b").alpha(0.07)));
                }
                l = l.child(
                    row()
                        .key(key.clone())
                        .w(w)
                        .min_h(44.0)
                        .py(4.0)
                        .gap(10.0)
                        .center_y()
                        .child(
                            col()
                                .key(format!("{key}-who"))
                                .grow(1.0)
                                .shrink()
                                .child(text(label_).key(format!("{key}-label")).font(TextStyle::new(14.0, 550.0).lh(19.0)).color(c(INK)).truncate())
                                .child(text(meta).key(format!("{key}-meta")).font(TextStyle::new(12.5, 400.0).lh(17.0)).color(c(MUTED)).truncate()),
                        )
                        .child(button("Revoke", &format!("{key}-revoke"), Btn::Small, false, Box::new(move |app, tx| crate::actions::revoke_token(app, &id, &lb, tx)))),
                );
            }
            l
        }
    };
    vec![col()
        .key("settings-apps")
        .w(w)
        .gap(8.0)
        .child(h3("Connected apps", "settings-label"))
        .child(hint("Apps you allowed to open your workspaces on this server, like Grimoire for Mac.", "settings-hint", w))
        .child(list)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_like_the_web() {
        let now = 1_793_000_000_000;
        let t = |ago_s: i64| relative_time(&serde_json::json!(now - ago_s * 1000), now);
        assert_eq!(t(3), "just now");
        assert_eq!(t(42), "42s ago");
        assert_eq!(t(5 * 60), "5 min ago");
        assert_eq!(t(3 * 3600), "3 h ago");
        assert_eq!(t(2 * 86_400), "2 d ago");
        assert_eq!(relative_time(&serde_json::json!(0), now), "1/1/1970");
        assert_eq!(relative_time(&Value::Null, now), "");
        assert_eq!(initials("Ann Lee"), "AL");
        assert_eq!(initials("bob@example.com"), "BE");
    }

    #[test]
    fn the_agent_prompt_is_the_web_apps() {
        assert_eq!(
            agent_prompt("https://g.example/s/abc"),
            "Use this Grimoire notebook as your workspace: https://g.example/s/abc\nFetch that URL first (HTTP GET) for instructions; it is a folder of Markdown files you work on by POSTing shell commands to the same URL."
        );
    }
}
