//! The history drawer, a port of the web's `src/client/history.ts` (its look: `.history` in app.css): the open
//! note's saved versions (newest first), one version's diff or its whole text ("View" / "Diff"), and "Restore this
//! version" (a confirm first). Remote notes use the server's history, diff, file-at-ref and restore endpoints;
//! local notes in a Git repository use `git log` / `git show` (restoring puts that text in the editor, one undo
//! step); in a folder that isn't one, History is disabled.

use std::path::{Path, PathBuf};
use std::process::Command;

use rune::{Drag, El, Phase, ScrollSpec, Shape, TextStyle, Tx, col, el, row, text};
use serde_json::Value;

use crate::App;
use crate::dialogs::{Confirm, ConfirmKind, Dialog};
use crate::remote::{Api, ApiError};
use crate::theme::*;

/// `--history-w`.
pub const HISTORY_W: f32 = 380.0;
/// Below this window width the drawer covers the page instead of pushing it.
pub const OVERLAY_BELOW: f32 = 900.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Commit {
    pub sha: String,
    pub message: String,
    pub author: String,
    /// Milliseconds since the epoch.
    pub date: Option<i64>,
}

impl Commit {
    pub fn title(&self) -> &str {
        self.message.lines().next().unwrap_or("")
    }

    pub fn short(&self) -> &str {
        &self.sha[..self.sha.len().min(7)]
    }

    pub fn from_json_pub(v: &Value) -> Option<Commit> {
        Commit::from_json(v)
    }

    /// The server's `{sha, message, authorName, date}` (`date`: an ISO string or milliseconds).
    fn from_json(v: &Value) -> Option<Commit> {
        let date = v["date"].as_i64().or_else(|| v["date"].as_f64().map(|f| f as i64)).or_else(|| v["date"].as_str().and_then(parse_iso));
        Some(Commit { sha: v["sha"].as_str()?.into(), message: v["message"].as_str().unwrap_or("").into(), author: v["authorName"].as_str().unwrap_or("").into(), date })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Load<T> {
    Loading,
    Failed(String),
    Ready(T),
}

/// Whose history: a remote note (folder id) or a local note in a Git repository (its folder), and the note.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Remote { api: ApiKey, id: String },
    Git { root: PathBuf },
}

/// The server and token of a remote source (the `Api` itself is rebuilt from the app when needed).
#[derive(Clone, Debug, PartialEq)]
pub struct ApiKey {
    pub server: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub source: Source,
    pub path: String,
    pub read_only: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Detail {
    pub commit: Commit,
    /// The newest version (no Restore).
    pub latest: bool,
    /// "View": the whole text at this version instead of the diff.
    pub viewing: bool,
    pub diff: Load<String>,
    pub file: Option<Load<String>>,
}

#[derive(Debug, Default)]
pub struct HistoryPanel {
    pub open: bool,
    pub target: Option<Target>,
    pub list: Option<Load<Vec<Commit>>>,
    pub detail: Option<Detail>,
    /// Bumped by each load and change of target: older answers are dropped.
    pub seq: u64,
    /// The newest commit the room said the note has (`status` / `hello`): a new one refreshes the list.
    pub seen_commit: Option<String>,
}

impl App {
    /// The open note's history source: a remote note, or a local one in a Git repository. `Err`: why History is
    /// disabled.
    pub fn history_target(&self) -> Result<Target, &'static str> {
        let (root, path) = (self.root.as_ref().ok_or("Open a note to see its history.")?, self.path.as_ref().ok_or("Open a note to see its history.")?);
        let rel = crate::files::rel(root, path);
        if let Some(rem) = &self.remote {
            return Ok(Target { source: Source::Remote { api: ApiKey { server: rem.api.server.clone() }, id: rem.id().to_string() }, path: rel, read_only: rem.read_only });
        }
        if !in_git_repo(root) {
            return Err("This workspace isn't a Git repository");
        }
        Ok(Target { source: Source::Git { root: root.clone() }, path: rel, read_only: false })
    }

    fn history_api(&self, key: &ApiKey) -> Api {
        match &self.remote {
            Some(r) if r.api.server == key.server => r.api.clone(),
            _ => self.api_for(&key.server),
        }
    }

    /// History (the header ⋯ menu's Show / Hide History): open or close the drawer.
    pub fn toggle_history(&mut self, tx: &mut Tx) {
        if self.history.open {
            self.close_history();
            return;
        }
        if self.history_target().is_err() {
            return;
        }
        self.history.open = true;
        self.history_retarget(tx);
        self.history_refresh(tx);
    }

    pub fn close_history(&mut self) {
        self.history.open = false;
        self.history.detail = None;
        self.history.seq += 1;
    }

    /// Another note (or folder) is open: the drawer follows it.
    pub fn history_retarget(&mut self, tx: &mut Tx) {
        let t = self.history_target().ok();
        if t.as_ref().map(|t| (&t.source, &t.path)) == self.history.target.as_ref().map(|t| (&t.source, &t.path)) {
            if let (Some(t), Some(old)) = (t, self.history.target.as_mut()) {
                old.read_only = t.read_only;
            }
            return;
        }
        self.history.target = t;
        self.history.seq += 1;
        self.history.detail = None;
        self.history.list = None;
        self.history.seen_commit = None;
        if self.history.open {
            if self.history.target.is_none() {
                self.close_history();
            } else {
                self.history_refresh(tx);
            }
        }
    }

    /// The room says the note's newest commit is `commit`: a new one refreshes the list (when it's showing).
    pub fn history_saved(&mut self, commit: Option<&str>, tx: &mut Tx) {
        let Some(c) = commit.filter(|c| !c.is_empty()) else { return };
        if self.history.seen_commit.as_deref() == Some(c) {
            return;
        }
        let first = self.history.seen_commit.is_none();
        self.history.seen_commit = Some(c.to_string());
        if !first && self.history.open && self.history.detail.is_none() {
            self.history_refresh(tx);
        }
    }

    /// The list again (the newest 100).
    pub fn history_refresh(&mut self, tx: &mut Tx) {
        let Some(t) = self.history.target.clone() else { return };
        self.history.seq += 1;
        let seq = self.history.seq;
        self.history.detail = None;
        if !matches!(self.history.list, Some(Load::Ready(_))) {
            self.history.list = Some(Load::Loading);
        }
        let job = self.history_job(&t);
        self.background(
            move || job.history(&t.path),
            move |app, r, _| {
                if app.history.seq == seq {
                    app.history.list = Some(match r {
                        Ok(c) => Load::Ready(c),
                        Err(e) => Load::Failed(e),
                    });
                }
            },
            tx,
        );
    }

    fn history_job(&self, t: &Target) -> Job {
        match &t.source {
            Source::Remote { api, id } => Job::Remote(self.history_api(api), id.clone()),
            Source::Git { root } => Job::Git(root.clone()),
        }
    }

    /// A version from the list: its diff.
    pub fn history_show(&mut self, i: usize, tx: &mut Tx) {
        let (Some(t), Some(Load::Ready(list))) = (self.history.target.clone(), &self.history.list) else { return };
        let Some(c) = list.get(i).cloned() else { return };
        self.history.seq += 1;
        let seq = self.history.seq;
        self.history.detail = Some(Detail { commit: c.clone(), latest: i == 0, viewing: false, diff: Load::Loading, file: None });
        let job = self.history_job(&t);
        let sha = c.sha.clone();
        self.background(
            move || job.diff(&sha, &t.path),
            move |app, r, _| {
                if app.history.seq == seq
                    && let Some(d) = app.history.detail.as_mut()
                {
                    d.diff = match r {
                        Ok(s) => Load::Ready(s),
                        Err(e) => Load::Failed(e),
                    };
                }
            },
            tx,
        );
    }

    /// "View" / "Diff": the version's whole text, or its diff again.
    pub fn history_toggle_view(&mut self, tx: &mut Tx) {
        let Some(t) = self.history.target.clone() else { return };
        let Some(d) = self.history.detail.as_mut() else { return };
        d.viewing = !d.viewing;
        if !d.viewing || d.file.is_some() {
            return;
        }
        d.file = Some(Load::Loading);
        let (seq, sha) = (self.history.seq, d.commit.sha.clone());
        let job = self.history_job(&t);
        self.background(
            move || job.file(&sha, &t.path),
            move |app, r, _| {
                if app.history.seq == seq
                    && let Some(d) = app.history.detail.as_mut()
                {
                    d.file = Some(match r {
                        Ok(s) => Load::Ready(s),
                        Err(e) => Load::Failed(e),
                    });
                }
            },
            tx,
        );
    }

    /// "Restore this version": the web's confirm first.
    pub fn history_ask_restore(&mut self) {
        let Some(d) = &self.history.detail else { return };
        let short = d.commit.short().to_string();
        self.dialog = Some(Dialog::Confirm(Confirm {
            kind: ConfirmKind::Restore { sha: d.commit.sha.clone() },
            title: "Restore version".into(),
            message: format!("Replace the current text with the version from {short}? Everyone editing will see the change, and it can be undone from history."),
            confirm: "Restore".into(),
            cancel: "Cancel".into(),
            danger: false,
        }));
    }

    /// Restore confirmed: the server's restore (everyone sees it), or for a local note that version's text in the
    /// editor (one undo step; saved as any edit).
    pub fn history_restore(&mut self, sha: String, tx: &mut Tx) {
        let Some(t) = self.history.target.clone() else { return };
        let short = sha[..sha.len().min(7)].to_string();
        let seq = self.history.seq;
        let job = self.history_job(&t);
        let local = matches!(t.source, Source::Git { .. });
        let path = t.path.clone();
        self.background(
            move || if local { job.file(&sha, &path) } else { job.restore(&sha, &path).map(|_| String::new()) },
            move |app, r, tx| match r {
                Ok(text) => {
                    if local && app.history.target.as_ref().is_some_and(|x| x.path == t.path) {
                        let end = app.ed.text().len();
                        app.ed.set_selection(editor_core::Sel { anchor: 0, head: end });
                        app.ed.insert_text(&text);
                        app.ed.set_selection(editor_core::Sel::caret(0));
                        app.handled(tx);
                    }
                    app.show_toast(format!("Restored version {short}"));
                    if app.history.seq == seq {
                        app.history_refresh(tx);
                    }
                }
                Err(e) => app.show_error(e),
            },
            tx,
        );
    }

    /// Run `f` off the main thread (in the window; at once in tests and headless runs), then `done` with its result.
    pub fn background<T: Send + 'static>(&mut self, f: impl FnOnce() -> T + Send + 'static, done: impl FnOnce(&mut App, T, &mut Tx) + Send + 'static, tx: &mut Tx) {
        if let crate::remote::Backend::Net(h) = &self.backend {
            let h = h.clone();
            std::thread::spawn(move || {
                let r = f();
                h.update(move |app, tx| {
                    done(app, r, tx);
                    app.handled(tx);
                });
            });
        } else {
            let r = f();
            done(self, r, tx);
        }
    }
}

/// Where a load runs (sent to a thread).
enum Job {
    Remote(Api, String),
    Git(PathBuf),
}

fn api_err(e: ApiError) -> String {
    crate::actions::message(&e)
}

impl Job {
    fn history(&self, path: &str) -> Result<Vec<Commit>, String> {
        match self {
            Job::Remote(api, id) => api.history(id, path, 100).map_err(api_err),
            Job::Git(root) => {
                let out = git(root, &["log", "-n", "100", "--format=%H%x1f%an%x1f%at%x1f%B%x1e", "--", path])?;
                Ok(out
                    .split('\u{1e}')
                    .filter_map(|r| {
                        let mut f = r.trim_start_matches('\n').splitn(4, '\u{1f}');
                        let (sha, author, at, msg) = (f.next()?, f.next()?, f.next()?, f.next().unwrap_or(""));
                        (!sha.is_empty()).then(|| Commit { sha: sha.into(), author: author.into(), date: at.trim().parse::<i64>().ok().map(|s| s * 1000), message: msg.trim_end().into() })
                    })
                    .collect())
            }
        }
    }

    fn diff(&self, sha: &str, path: &str) -> Result<String, String> {
        match self {
            Job::Remote(api, id) => api.diff(id, sha, path).map_err(api_err),
            Job::Git(root) => git(root, &["show", "--format=", "--no-color", sha, "--", path]),
        }
    }

    fn file(&self, sha: &str, path: &str) -> Result<String, String> {
        match self {
            Job::Remote(api, id) => api.file_at(id, path, sha).map_err(api_err),
            Job::Git(root) => git(root, &["show", &format!("{sha}:./{path}")]),
        }
    }

    fn restore(&self, sha: &str, path: &str) -> Result<(), String> {
        match self {
            Job::Remote(api, id) => api.restore(id, path, sha).map_err(api_err),
            Job::Git(_) => Ok(()),
        }
    }
}

/// Whether `dir` is inside a Git working tree (a `.git` here or above; `git` itself only runs when asked for history).
pub fn in_git_repo(dir: &Path) -> bool {
    dir.ancestors().any(|d| d.join(".git").exists())
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("/usr/bin/git").arg("-C").arg(root).args(args).output().map_err(|e| format!("Couldn't run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().lines().next().unwrap_or("git failed").to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `2026-10-28T16:04:05Z` / `…+02:00` / `….123Z` → milliseconds.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut rest = &s[19..];
    let mut ms = 0;
    if let Some(r) = rest.strip_prefix('.') {
        let digits: String = r.chars().take_while(char::is_ascii_digit).collect();
        ms = format!("{:0<3}", &digits[..digits.len().min(3)]).parse().unwrap_or(0);
        rest = &r[digits.len()..];
    }
    let off = match rest {
        "" | "Z" => 0,
        o if o.len() == 6 => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            sign * (o[1..3].parse::<i64>().ok()? * 60 + o[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    Some(((days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se) - off * 60) * 1000 + ms)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// The web's `relativeTime`: "just now", "12s ago", "5 min ago", "3 h ago", "2 d ago", else the date.
pub fn relative_time(ms: i64, now_ms: i64) -> String {
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
    let (y, mo, dd) = civil_from_days(ms.div_euclid(86_400_000));
    format!("{mo}/{dd}/{y}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

// ---- the drawer ----

fn small_btn(label: &str, key: &str, primary: bool, disabled: bool, help: &str, f: fn(&mut App, &mut Tx)) -> El {
    let (fill, ink, border) = match (primary, disabled) {
        (true, false) => (c(INK), c(PAPER), c(INK)),
        (true, true) => (c(PAPER_3), c(MUTED), c(PAPER_3)),
        (false, _) => (c(PAPER), c(INK), line()),
    };
    let mut b = row()
        .key(key.to_string())
        .label(label.to_string())
        .h(28.0)
        .px(10.0)
        .center()
        .radius(6.0)
        .fill(fill)
        .border(1.0, border)
        .child(text(label.to_string()).key(format!("{key}-text")).font(TextStyle::new(12.5, crate::theme::wt(550.0)).lh(16.0)).color(ink));
    if !help.is_empty() {
        b = b.help(help.to_string());
    }
    if !disabled {
        b = b.hover(if primary { c("#000000") } else { c(PAPER_2) }).on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                f(app, tx);
                app.handled(tx);
            }
        });
    }
    b
}

fn note(s: &str, key: &str, w: f32) -> El {
    text(s.to_string()).key(key.to_string()).font(TextStyle::new(13.5, 400.0).lh(20.0)).color(c(MUTED)).w(w).px(20.0).py(12.0).wrap()
}

fn mono(s: String, key: String, w: f32, ink: &str) -> El {
    text(s).key(key).font(TextStyle::new(12.0, 400.0).lh(19.2).mono()).color(c(ink)).w(w).wrap_anywhere()
}

/// A unified diff, line by line (the web's `renderDiff`): added lines tinted blue with a blue edge, removed ones
/// grey with a grey edge and muted, hunk and meta lines muted.
fn diff_view(diff: &str, w: f32) -> El {
    if diff.trim().is_empty() {
        return note("No changes to this file in this commit.", "diff-empty", w);
    }
    let inner = w - 24.0;
    let mut lines: Vec<El> = Vec::new();
    for (i, line) in diff.trim_end_matches('\n').split('\n').enumerate() {
        let meta = ["diff ", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity", "rename "].iter().any(|p| line.starts_with(p));
        let kind = if meta {
            "meta"
        } else if line.starts_with("@@") {
            "hunk"
        } else if line.starts_with('+') {
            "add"
        } else if line.starts_with('-') {
            "del"
        } else {
            "ctx"
        };
        let ink = if matches!(kind, "meta" | "hunk" | "del") { MUTED } else { INK };
        let mut r = el().key(format!("dl{i}")).w(inner).px(14.0).child(mono(if line.is_empty() { " ".into() } else { line.to_string() }, format!("dl{i}-text"), inner - 28.0, ink));
        r = match kind {
            "add" => r.fill(c(LINK).alpha(0.09)).child(el().key(format!("dl{i}-edge")).absolute(0.0, 0.0).w(2.0).h_full().fill(c(LINK))),
            "del" => r.fill(c("#18181b").alpha(0.045)).child(el().key(format!("dl{i}-edge")).absolute(0.0, 0.0).w(2.0).h_full().fill(c("#a1a1aa"))),
            "hunk" => r.mt(6.0),
            _ => r,
        };
        lines.push(r);
    }
    col().key("diff").w(inner).mx(12.0).mb(24.0).py(10.0).radius(6.0).fill(c(PAPER)).clip_soft(0.0).children(lines)
}

pub fn view(app: &App, vh: f32) -> El {
    let w = HISTORY_W;
    let close = el()
        .key("history-close")
        .label("Close history")
        .size(28.0, 28.0)
        .radius(6.0)
        .hover(c(TINT_HOVER))
        .shape(Shape::new().stroke(vec![[9.0, 9.0], [19.0, 19.0]], 1.4, c(INK_2)).stroke(vec![[19.0, 9.0], [9.0, 19.0]], 1.4, c(INK_2)))
        .on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.close_history();
                app.handled(tx);
            }
        });
    let head = row()
        .key("history-head")
        .w(w)
        .h(crate::header::HEADER_H)
        .pl(20.0)
        .pr(12.0)
        .center_y()
        .justify_between()
        .child(text("History").key("history-title").font(TextStyle::new(14.0, crate::theme::wt(600.0)).lh(17.0)).color(c(INK)))
        .child(close);
    let h = &app.history;
    let body: Vec<El> = match (&h.detail, &h.list) {
        (Some(d), _) => detail_view(app, d, w),
        (None, None) if h.target.is_none() => vec![note("Open a note to see its history.", "history-empty", w)],
        (None, None | Some(Load::Loading)) => vec![note("Loading…", "history-loading", w)],
        (None, Some(Load::Failed(e))) => vec![note(e, "history-error", w)],
        (None, Some(Load::Ready(list))) if list.is_empty() => {
            vec![note("No saved versions yet. Changes are committed after a short pause, or press ⌘S.", "history-empty", w)]
        }
        (None, Some(Load::Ready(list))) => vec![commits(list, w)],
    };
    col()
        .key("history")
        .w(w)
        .h(vh)
        .fill(c(PAPER_2))
        .on_drag(|_: &mut App, _: &mut Drag, _: &mut Tx| {})
        .child(head)
        .child(col().key("history-body").w(w).grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(col().key("history-content").w(w).children(body)))
}

fn commits(list: &[Commit], w: f32) -> El {
    let now = now_ms();
    let inner = w - 24.0;
    let rows: Vec<El> = list
        .iter()
        .enumerate()
        .map(|(i, c_)| {
            let when = c_.date.map(|d| relative_time(d, now)).unwrap_or_default();
            let meta = row()
                .key(format!("commit{i}-meta"))
                .w(inner - 16.0)
                .gap(5.0)
                .center_y()
                .child(text(c_.author.clone()).key(format!("commit{i}-author")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)))
                .child(text("·").key(format!("commit{i}-dot")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)))
                .child(text(when).key(format!("commit{i}-when")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).grow(1.0))
                .child(text(c_.short().to_string()).key(format!("commit{i}-sha")).font(TextStyle::new(11.5, 400.0).lh(16.0).mono()).color(c(MUTED)));
            col()
                .key(format!("commit{i}"))
                .label(c_.title().to_string())
                .w(inner)
                .pt(9.0)
                .pb(10.0)
                .px(8.0)
                .gap(3.0)
                .radius(6.0)
                .hover(c(TINT_HOVER))
                .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
                    if d.phase == Phase::Down {
                        app.history_show(i, tx);
                        app.handled(tx);
                    }
                })
                .child(text(c_.title().to_string()).key(format!("commit{i}-msg")).font(TextStyle::new(13.5, crate::theme::wt(550.0)).lh(18.0)).color(c(INK)).w(inner - 16.0).truncate())
                .child(meta)
        })
        .collect();
    col().key("commits").w(w).px(12.0).pb(24.0).gap(2.0).children(rows)
}

fn detail_view(app: &App, d: &Detail, w: f32) -> Vec<El> {
    let read_only = app.history.target.as_ref().is_some_and(|t| t.read_only);
    let when = d.commit.date.map(|t| relative_time(t, now_ms())).unwrap_or_default();
    let restore_help = if d.latest {
        "This is the latest version"
    } else if read_only {
        "Read-only"
    } else {
        ""
    };
    let inner = w - 40.0;
    let back = text("← All versions").key("history-back").font(TextStyle::new(12.5, crate::theme::wt(550.0)).lh(16.0)).color(c(MUTED)).mb(8.0).on_drag(
        |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.history_refresh(tx);
                app.handled(tx);
            }
        },
    );
    let head = col()
        .key("commit-detail")
        .w(w)
        .px(20.0)
        .pb(16.0)
        .gap(4.0)
        .child(back)
        .child(text(d.commit.title().to_string()).key("commit-title").font(TextStyle::new(15.0, crate::theme::wt(650.0)).lh(20.0)).color(c(INK)).w(inner).wrap())
        .child(
            text(format!("{} · {} · {}", d.commit.author, when, d.commit.short()))
                .key("commit-detail-meta")
                .font(TextStyle::new(12.0, 400.0).lh(16.0))
                .color(c(MUTED))
                .w(inner),
        )
        .child(
            row()
                .key("commit-actions")
                .gap(8.0)
                .mt(10.0)
                .child(small_btn(if d.viewing { "Diff" } else { "View" }, "history-view", false, false, "", |app, tx| app.history_toggle_view(tx)))
                .child(small_btn("Restore this version", "history-restore", true, d.latest || read_only, restore_help, |app, _| app.history_ask_restore())),
        );
    let content = if d.viewing {
        match &d.file {
            Some(Load::Ready(t)) => {
                col().key("file-at-ref").w(w - 24.0).mx(12.0).mb(24.0).px(14.0).py(12.0).radius(6.0).fill(c(PAPER)).child(mono(t.clone(), "file-at-ref-text".into(), w - 52.0, INK))
            }
            Some(Load::Failed(e)) => note(e, "history-error", w),
            _ => note("Loading…", "history-loading", w),
        }
    } else {
        match &d.diff {
            Load::Ready(s) => diff_view(s, w),
            Load::Failed(e) => note(e, "history-error", w),
            Load::Loading => note("Loading diff…", "history-loading", w),
        }
    };
    vec![head, content]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Notes, diff lines and the commit's title wrap as the web's (`.dl`, `.file-at-ref`: pre-wrap, break-word).
    #[test]
    fn long_texts_wrap() {
        assert!(note("No saved versions yet.", "n", 300.0).wraps());
        assert!(mono("x".repeat(200), "m".into(), 300.0, INK).wraps());
    }

    #[test]
    fn times_like_the_web() {
        let now = 1_800_000_000_000;
        assert_eq!(relative_time(now - 3_000, now), "just now");
        assert_eq!(relative_time(now - 42_000, now), "42s ago");
        assert_eq!(relative_time(now - 5 * 60_000, now), "5 min ago");
        assert_eq!(relative_time(now - 3 * 3_600_000, now), "3 h ago");
        assert_eq!(relative_time(now - 2 * 86_400_000, now), "2 d ago");
        assert_eq!(parse_iso("2026-10-28T16:04:05Z"), Some(1_793_203_445_000));
        assert_eq!(parse_iso("2026-10-28T18:04:05.250+02:00"), Some(1_793_203_445_250));
        assert_eq!(relative_time(1_793_203_445_000, 1_793_203_445_000 + 30 * 86_400_000), "10/28/2026");
    }

    /// A remote note: the server's history, a version's diff and text, Restore through the server; a new commit
    /// from the room refreshes the list.
    #[test]
    fn remote_history_through_the_server() {
        use crate::fake::{FakeRest, FakeWs};
        use crate::remote::{Backend, Mock};
        use std::sync::{Arc, Mutex};
        let mut rest = FakeRest::new("https://g.example", "Ann", "ann@example.com");
        let mut w = FakeWs::new("team", "Team", true);
        w.files = vec!["Team notes.md".into()];
        rest.workspaces.push(w);
        let rest = Arc::new(Mutex::new(rest));
        let mut m = Mock::new(&[("Team notes.md", "# Team notes\n")]);
        m.rest = Some(rest.clone());
        let mut app = App::new("", None, true);
        app.backend = Backend::Mock(std::rc::Rc::new(std::cell::RefCell::new(m)));
        let mut tx = Tx::default();
        app.open_remote("https://g.example".into(), "team".into(), "Team".into(), None, &mut tx);
        app.toggle_history(&mut tx);
        let Some(Load::Ready(list)) = app.history.list.clone() else { panic!("{:?}", app.history.list) };
        assert_eq!(list.iter().map(|c| (c.title(), c.author.as_str(), c.short())).collect::<Vec<_>>(), [("Edit Team notes.md", "Ada", "c3f9a1e"), ("Edit Team notes.md", "Ann Lee", "9b2e7c4"), ("Create Team notes.md", "Ann Lee", "41d0e8f")]);
        assert!(rest.lock().unwrap().log.iter().any(|l| l == "GET /api/workspace/team/history?path=Team%20notes.md&limit=100"));
        app.history_show(0, &mut tx);
        assert!(app.history.detail.as_ref().unwrap().latest, "the newest: no Restore");
        app.history_show(1, &mut tx);
        assert!(matches!(&app.history.detail.as_ref().unwrap().diff, Load::Ready(d) if d.contains("+- Review the docs today")));
        app.history_toggle_view(&mut tx);
        assert!(matches!(&app.history.detail.as_ref().unwrap().file, Some(Load::Ready(t)) if t.starts_with("# Team notes")));
        app.history_ask_restore();
        let Some(Dialog::Confirm(c)) = &app.dialog else { panic!() };
        assert_eq!(
            (c.title.as_str(), c.message.as_str(), c.confirm.as_str()),
            ("Restore version", "Replace the current text with the version from 9b2e7c4? Everyone editing will see the change, and it can be undone from history.", "Restore")
        );
        crate::actions::confirm(&mut app, &mut tx);
        assert!(rest.lock().unwrap().log.iter().any(|l| l.starts_with("POST /api/workspace/team/restore") && l.contains("9b2e7c41aa03")));
        assert_eq!(app.toast(), Some("Restored version 9b2e7c4"));
        assert!(app.history.detail.is_none());
        // the room's newest commit changes: the list loads again
        let n = || rest.lock().unwrap().log.iter().filter(|l| l.contains("/history?")).count();
        app.history_saved(Some("aaa"), &mut tx);
        let before = n();
        app.history_saved(Some("bbb"), &mut tx);
        assert_eq!(n(), before + 1);
        // the drawer closes; another note retargets it
        app.toggle_history(&mut tx);
        assert!(!app.history.open);
    }

    /// A local note in a Git repository: its commits, a diff, the text at a version, and Restore (into the editor).
    #[test]
    fn local_git_history() {
        let dir = std::env::temp_dir().join(format!("grimoire-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let g = |args: &[&str]| assert!(Command::new("/usr/bin/git").arg("-C").arg(&dir).args(args).output().unwrap().status.success(), "{args:?}");
        g(&["init", "-q"]);
        std::fs::write(dir.join("a.md"), "one\n").unwrap();
        g(&["add", "a.md"]);
        g(&["-c", "user.name=Ann", "-c", "user.email=a@x", "commit", "-q", "-m", "First"]);
        std::fs::write(dir.join("a.md"), "one\ntwo\n").unwrap();
        g(&["-c", "user.name=Bob", "-c", "user.email=b@x", "commit", "-q", "-am", "Second\n\nbody"]);
        let mut app = App::new("one\ntwo\n", Some(dir.join("a.md")), true).with_root(Some(dir.clone()), crate::files::scan(&dir).0);
        let mut tx = Tx::default();
        app.toggle_history(&mut tx);
        let Some(Load::Ready(list)) = app.history.list.clone() else { panic!("{:?}", app.history.list) };
        assert_eq!(list.iter().map(|c| (c.title(), c.author.as_str())).collect::<Vec<_>>(), [("Second", "Bob"), ("First", "Ann")]);
        app.history_show(1, &mut tx);
        let d = app.history.detail.clone().unwrap();
        assert!(matches!(&d.diff, Load::Ready(s) if s.contains("+one")), "{:?}", d.diff);
        assert!(!d.latest);
        app.history_toggle_view(&mut tx);
        assert_eq!(app.history.detail.as_ref().unwrap().file, Some(Load::Ready("one\n".into())));
        app.history_ask_restore();
        crate::actions::confirm(&mut app, &mut tx);
        assert_eq!(app.ed.text(), "one\n");
        assert_eq!(app.toast(), Some(format!("Restored version {}", list[1].short()).as_str()));
        assert!(app.history.detail.is_none(), "back to the list");
        // not a Git folder: disabled
        let plain = std::env::temp_dir().join(format!("grimoire-hist-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("b.md"), "b").unwrap();
        let app2 = App::new("b", Some(plain.join("b.md")), true).with_root(Some(plain.clone()), crate::files::scan(&plain).0);
        if !in_git_repo(&plain) {
            assert_eq!(app2.history_target().unwrap_err(), "This workspace isn't a Git repository");
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&plain);
    }
}
