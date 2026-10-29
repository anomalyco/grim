//! Git for local folders (`docs/app.md`, "Git in local folders"). The first time a folder opens, a dialog offers to
//! track its changes (`git init`, when it isn't in a work tree) or to commit automatically (when it is; off by
//! default); the choice is kept per folder (`Store::git`) and changed later from the switcher or the File menu.
//! With automatic commits on, a `Committer` thread commits only the files the app itself changed (notes edited,
//! notes and folders created, renamed or deleted) after a quiet pause and on ⌘S, with `git commit --only`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rune::Tx;

use crate::App;
use crate::dialogs::{Confirm, ConfirmKind, Dialog};
use crate::workspaces::WsRef;

/// A commit waits this long after the app's last change (a remote note's room saves after a pause like it).
pub const QUIET: Duration = Duration::from_secs(3);
const GIT: &str = "/usr/bin/git";

/// What the app did to a note or folder (paths relative to the folder, `/`-separated).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Edit(String),
    Create(String),
    Rename { from: String, to: String },
    Delete(String),
    /// "Track Changes": the folder's notes, committed at once.
    Track(Vec<String>),
}

impl Change {
    /// The server's commit messages: "Update a.md", "Create a.md", "Rename a.md to b.md", "Delete a.md".
    pub fn message(&self) -> String {
        match self {
            Change::Edit(p) => format!("Update {p}"),
            Change::Create(p) => format!("Create {p}"),
            Change::Rename { from, to } => format!("Rename {from} to {to}"),
            Change::Delete(p) => format!("Delete {p}"),
            Change::Track(_) => "Track changes".into(),
        }
    }

    fn paths(&self) -> Vec<String> {
        match self {
            Change::Edit(p) | Change::Create(p) | Change::Delete(p) => vec![p.clone()],
            Change::Rename { from, to } => vec![from.clone(), to.clone()],
            Change::Track(ps) => ps.clone(),
        }
    }
}

/// Add `c` to the changes waiting for a commit: an edit of a note already created or edited adds nothing.
pub fn add_change(pending: &mut Vec<Change>, c: Change) {
    if let Change::Edit(p) = &c
        && pending.iter().any(|o| matches!(o, Change::Edit(q) | Change::Create(q) if q == p))
    {
        return;
    }
    if !pending.contains(&c) {
        pending.push(c);
    }
}

/// One commit's message: the change's, or the first one's with how many more (each on its own line below).
pub fn message(changes: &[Change]) -> String {
    match changes {
        [] => String::new(),
        [c] => c.message(),
        [c, rest @ ..] => {
            let more = if rest.len() == 1 { "1 more change".to_string() } else { format!("{} more changes", rest.len()) };
            let body: Vec<String> = changes.iter().map(Change::message).collect();
            format!("{} and {more}\n\n{}", c.message(), body.join("\n"))
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Committed,
    /// Nothing the app changed differs from the last commit.
    Nothing,
    /// Not now: a merge, rebase, cherry-pick or revert under way, conflicts, or no repository (any more).
    Busy,
}

fn git(dir: &Path) -> Command {
    let mut c = Command::new(GIT);
    c.arg("-C").arg(dir).arg("--literal-pathspecs").env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true").stdin(Stdio::null());
    c
}

fn run(c: &mut Command) -> Result<String, String> {
    let out = c.output().map_err(|e| format!("Couldn't run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let out_text = String::from_utf8_lossy(&out.stdout);
        let why = [err.trim(), out_text.trim()].into_iter().find(|s| !s.is_empty()).unwrap_or("git failed");
        return Err(why.lines().filter(|l| !l.trim().is_empty()).take(6).collect::<Vec<_>>().join("\n"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Whether `dir` is inside a Git work tree (`git rev-parse --show-toplevel`; a subfolder of a repository counts).
/// Without a `.git` here or above, git isn't run at all.
pub fn work_tree(dir: &Path) -> bool {
    crate::history::in_git_repo(dir) && git(dir).args(["rev-parse", "--show-toplevel"]).output().is_ok_and(|o| o.status.success())
}

/// `git init` in `dir`.
pub fn init(dir: &Path) -> Result<(), String> {
    run(git(dir).args(["init", "-q"])).map(|_| ())
}

fn nul_list(s: &str) -> Vec<String> {
    s.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect()
}

/// Commit `changes` in the repository around `root` (the folder): only their paths (`git commit --only`; other
/// files and what's staged for them stay as they are). New notes are added first. The author is git's own
/// configuration, else `fallback` (name, email), given per command.
pub fn commit(root: &Path, changes: &[Change], fallback: &(String, String)) -> Result<Outcome, String> {
    let Ok(git_dir) = run(git(root).args(["rev-parse", "--absolute-git-dir"])) else { return Ok(Outcome::Busy) };
    let git_dir = PathBuf::from(git_dir.trim());
    if ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].iter().any(|f| git_dir.join(f).exists()) {
        return Ok(Outcome::Busy);
    }
    if !run(git(root).args(["ls-files", "-u"]))?.trim().is_empty() {
        return Ok(Outcome::Busy);
    }
    let mut specs: Vec<String> = Vec::new();
    for p in changes.iter().flat_map(Change::paths) {
        if !p.is_empty() && !specs.contains(&p) {
            specs.push(p);
        }
    }
    if specs.is_empty() {
        return Ok(Outcome::Nothing);
    }
    // tracked files under the paths (deleted ones too: still in the index), and new ones that aren't ignored
    let tracked = nul_list(&run(git(root).args(["ls-files", "-z", "--cached", "--"]).args(&specs))?);
    let new = nul_list(&run(git(root).args(["ls-files", "-z", "--others", "--exclude-standard", "--"]).args(&specs))?);
    let mut files = tracked;
    files.extend(new.iter().cloned());
    if files.is_empty() {
        return Ok(Outcome::Nothing);
    }
    if !new.is_empty() {
        run(git(root).args(["add", "--"]).args(&new))?;
    }
    let undo_add = |root: &Path| {
        if !new.is_empty() {
            let _ = run(git(root).args(["reset", "-q", "--"]).args(&new));
        }
    };
    let changed = match run(git(root).args(["status", "--porcelain", "-z", "--untracked-files=no", "--"]).args(&files)) {
        Ok(s) => !s.is_empty(),
        Err(e) => {
            undo_add(root);
            return Err(e);
        }
    };
    if !changed {
        return Ok(Outcome::Nothing);
    }
    let mut c = git(root);
    for (key, value) in [("user.name", &fallback.0), ("user.email", &fallback.1)] {
        let set = git(root).args(["config", "--get", key]).output().is_ok_and(|o| o.status.success() && !o.stdout.trim_ascii().is_empty());
        if !set {
            c.arg("-c").arg(format!("{key}={value}"));
        }
    }
    c.args(["commit", "-q", "--only", "-m", &message(changes), "--"]).args(&files);
    match run(&mut c) {
        Ok(_) => Ok(Outcome::Committed),
        Err(e) => {
            undo_add(root);
            Err(e)
        }
    }
}

enum Msg {
    Change(Change),
    Now,
    Wait(Sender<()>),
}

/// Commits the app's changes in one folder, off the UI thread: after `QUIET` with no new change, at once on
/// `now` (⌘S) and "Track Changes", and what's left when it's dropped. A failure (a hook refusing, say) is kept
/// for the header (`failure`) and logged once; the changes stay queued and are tried again with the next one.
/// While the repository is busy (a merge…), it waits quietly for the next change too.
pub struct Committer {
    pub root: PathBuf,
    tx: Sender<Msg>,
    failure: Arc<Mutex<Option<String>>>,
}

impl Committer {
    pub fn spawn(root: PathBuf, fallback: (String, String)) -> Committer {
        let (tx, rx) = mpsc::channel::<Msg>();
        let failure: Arc<Mutex<Option<String>>> = Arc::default();
        let (dir, fail) = (root.clone(), failure.clone());
        std::thread::spawn(move || {
            let mut pending: Vec<Change> = Vec::new();
            // a change came since the last try: the quiet pause counts
            let mut armed = false;
            let attempt = |pending: &mut Vec<Change>, armed: &mut bool| {
                *armed = false;
                if pending.is_empty() {
                    return;
                }
                match commit(&dir, pending, &fallback) {
                    Ok(Outcome::Committed | Outcome::Nothing) => {
                        pending.clear();
                        *fail.lock().unwrap() = None;
                    }
                    Ok(Outcome::Busy) => {}
                    Err(e) => {
                        let mut f = fail.lock().unwrap();
                        if f.is_none() {
                            eprintln!("grimoire: committing in {}: {e}", dir.display());
                        }
                        *f = Some(e);
                    }
                }
            };
            loop {
                let msg = if armed { rx.recv_timeout(QUIET) } else { rx.recv().map_err(|_| RecvTimeoutError::Disconnected) };
                match msg {
                    Ok(Msg::Change(c)) => {
                        let at_once = matches!(c, Change::Track(_));
                        add_change(&mut pending, c);
                        armed = true;
                        if at_once {
                            attempt(&mut pending, &mut armed);
                        }
                    }
                    Ok(Msg::Now) => attempt(&mut pending, &mut armed),
                    Ok(Msg::Wait(done)) => {
                        attempt(&mut pending, &mut armed);
                        let _ = done.send(());
                    }
                    Err(RecvTimeoutError::Timeout) => attempt(&mut pending, &mut armed),
                    Err(RecvTimeoutError::Disconnected) => {
                        attempt(&mut pending, &mut armed);
                        break;
                    }
                }
            }
        });
        Committer { root, tx, failure }
    }

    pub fn change(&self, c: Change) {
        let _ = self.tx.send(Msg::Change(c));
    }

    /// Commit what's waiting now (⌘S), without waiting for it.
    pub fn now(&self) {
        let _ = self.tx.send(Msg::Now);
    }

    /// Commit what's waiting and wait for it (at most `limit`): the window is closing, tests.
    pub fn finish(&self, limit: Duration) {
        let (done, wait) = mpsc::channel();
        if self.tx.send(Msg::Wait(done)).is_ok() {
            let _ = wait.recv_timeout(limit);
        }
    }

    /// Why the last commit failed (cleared by the next one that works).
    pub fn failure(&self) -> Option<String> {
        self.failure.lock().unwrap().clone()
    }
}

/// What the File menu shows for the open workspace: nothing to do (no local folder), Track Changes… (not a
/// repository), or the Automatic Commits check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitMenu {
    None,
    NotRepo,
    Repo { auto: bool },
}

/// The first-time (or Track Changes…) dialog for the folder `root`.
pub fn ask(root: PathBuf, repo: bool) -> Dialog {
    let (title, message, confirm, cancel) = if repo {
        (
            "This folder is a Git repository",
            "Grimoire can commit your changes automatically as you write, or leave the repository entirely to you.",
            "Turn On Automatic Commits",
            "Leave It to Me",
        )
    } else {
        (
            "Track changes in this folder?",
            "Grimoire can create a Git repository here to keep a history of every change, so you can see and restore earlier versions.",
            "Track Changes",
            "Not Now",
        )
    };
    Dialog::Confirm(Confirm { kind: ConfirmKind::Git { root, repo }, title: title.into(), message: message.into(), confirm: confirm.into(), cancel: cancel.into(), danger: false })
}

/// The dialog's default button is "Leave It to Me" (Return and Escape both choose it), not its confirm.
pub fn default_is_cancel(kind: &ConfirmKind) -> bool {
    matches!(kind, ConfirmKind::Git { repo: true, .. })
}

impl App {
    /// The open local folder, if one is.
    fn local_root(&self) -> Option<PathBuf> {
        match (&self.current, &self.remote) {
            (Some(WsRef::Local { path }), None) => Some(path.clone()),
            _ => None,
        }
    }

    /// A local folder was opened (at launch or switching): whether it's in a Git work tree, the first-time
    /// dialog for a folder the app hasn't seen, and its committer when automatic commits are on.
    pub fn local_opened(&mut self) {
        let Some(root) = self.local_root() else {
            self.committer = None;
            return;
        };
        self.git_repo = work_tree(&root);
        if self.store.git_auto(&root).is_none() && (!self.headless || self.ask_git) && self.dialog.is_none() {
            self.dialog = Some(ask(root.clone(), self.git_repo));
        }
        self.start_committer();
    }

    /// A committer for the open local folder when it's a repository with automatic commits on (else none).
    fn start_committer(&mut self) {
        let want = self.local_root().filter(|r| !self.headless && self.git_repo && self.store.git_auto(r) == Some(true));
        if self.committer.as_ref().map(|c| &c.root) == want.as_ref() {
            return;
        }
        self.committer = want.map(|r| Committer::spawn(r, self.git_author()));
        self.refresh_menu();
    }

    /// Who commits when git has no `user.name` / `user.email`: the account the app is signed in with, else "Grimoire".
    fn git_author(&self) -> (String, String) {
        let s = self.store.servers.iter().find(|s| s.account.is_some() && s.email.is_some());
        match s {
            Some(s) => (s.account.clone().unwrap_or_default(), s.email.clone().unwrap_or_default()),
            None => ("Grimoire".into(), "grimoire@localhost".into()),
        }
    }

    /// Something the app changed in the open local folder (`rel` paths), for the next commit.
    pub fn git_change(&self, c: Change) {
        if let Some(cm) = &self.committer {
            cm.change(c);
        }
    }

    /// The open note was edited.
    pub fn git_edited(&self) {
        if self.committer.is_some()
            && let (Some(root), Some(p)) = (&self.root, &self.path)
        {
            self.git_change(Change::Edit(crate::files::rel(root, p)));
        }
    }

    /// An image the app copied beside the open note (`link`: its Markdown, `![alt](images/x.png)`).
    pub fn git_image(&self, link: &str) {
        let (Some(root), Some(dir)) = (&self.root, self.path.as_deref().and_then(Path::parent)) else { return };
        let Some(url) = link.rsplit_once("](").map(|(_, u)| u.trim_end_matches(')')) else { return };
        if self.committer.is_none() || url.split('/').any(|s| s == "..") {
            return;
        }
        let p = dir.join(crate::net::dec(url));
        if p.starts_with(root) {
            self.git_change(Change::Create(crate::files::rel(root, &p)));
        }
    }

    /// ⌘S: commit now.
    pub fn git_commit_now(&self) {
        if let Some(c) = &self.committer {
            c.now();
        }
    }

    /// After every event: the committer goes when its folder is no longer the open one, and the File menu follows.
    pub fn git_follow(&mut self) {
        if self.committer.as_ref().is_some_and(|c| Some(&c.root) != self.local_root().as_ref()) {
            self.committer = None;
        }
        self.refresh_menu();
    }

    /// What the File menu's Git items show.
    pub fn git_menu(&self) -> GitMenu {
        match self.local_root() {
            None => GitMenu::None,
            Some(_) if !self.git_repo => GitMenu::NotRepo,
            Some(r) => GitMenu::Repo { auto: self.store.git_auto(&r) == Some(true) },
        }
    }

    /// The header's quiet warning: the last automatic commit failed (its reason as the tooltip).
    pub fn commit_failure(&self) -> Option<String> {
        self.committer.as_ref().and_then(Committer::failure)
    }

    /// The dialog's answer, or the menu's: automatic commits on or off for `root` (remembered).
    pub fn set_auto_commits(&mut self, root: &Path, on: bool) {
        self.store.set_git(root, on);
        self.store.save();
        self.start_committer();
        self.refresh_menu();
    }

    /// "Track Changes": `git init` in `root`, automatic commits on, and its notes in a first commit.
    pub fn track_changes(&mut self, root: PathBuf, _tx: &mut Tx) {
        if !self.headless
            && let Err(e) = init(&root)
        {
            self.show_error(format!("Couldn't create a Git repository: {e}"));
            self.store.set_git(&root, false);
            self.store.save();
            return;
        }
        if self.local_root().as_ref() == Some(&root) {
            self.git_repo = true;
        }
        self.set_auto_commits(&root, true);
        if self.local_root().as_ref() == Some(&root) {
            let notes: Vec<String> = crate::files::notes_under(&self.files, &root).iter().map(|p| crate::files::rel(&root, p)).collect();
            self.git_change(Change::Track(notes));
        }
    }

    /// The menus' Automatic Commits: turn it on or off for the open folder.
    pub fn toggle_auto_commits(&mut self) {
        if let Some(root) = self.local_root() {
            let on = self.store.git_auto(&root) == Some(true);
            self.set_auto_commits(&root, !on);
        }
    }

    /// The menus' Track Changes…: the dialog again for the open folder.
    pub fn ask_track_changes(&mut self) {
        if let Some(root) = self.local_root() {
            self.git_repo = work_tree(&root);
            self.dialog = Some(ask(root, self.git_repo));
        }
    }

    /// The dialog closed without its confirm ("Not Now", "Leave It to Me", Escape, ×): off, and never asked again.
    pub fn git_declined(&mut self, root: &Path) {
        if self.store.git_auto(root).is_none() {
            self.set_auto_commits(root, false);
        }
    }

    /// The window is closing: what's waiting is committed (a few seconds at most).
    pub fn git_finish(&mut self) {
        if let Some(c) = self.committer.take() {
            c.finish(Duration::from_secs(5));
        }
    }
}

/// `--git-selftest`: the dialogs and automatic commits against temporary folders (a one-off check of the built app;
/// prints what it saw, exits 0 when all is as expected).
pub fn selftest() -> i32 {
    let base = std::env::temp_dir().join(format!("grimoire-git-selftest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ok = std::cell::Cell::new(true);
    let check = |what: &str, good: bool| {
        eprintln!("git selftest: {} {what}", if good { "ok  " } else { "FAIL" });
        if !good {
            ok.set(false);
        }
    };
    let sh = |dir: &Path, args: &[&str]| -> String { run(git(dir).args(args)).unwrap_or_else(|e| format!("<error: {e}>")) };
    let mut tx = Tx::default();
    let wait = |app: &App| {
        if let Some(c) = &app.committer {
            c.finish(Duration::from_secs(10));
        }
    };
    let edit = |app: &mut App, tx: &mut Tx, text: &str| {
        app.ed.set_text(text);
        app.handled(tx);
        app.save_now();
        app.git_commit_now();
    };
    let dialog = |app: &App| match &app.dialog {
        Some(Dialog::Confirm(c)) => format!("{} [{} | {}]", c.title, c.cancel, c.confirm),
        _ => "none".into(),
    };

    // 1. a plain folder: "Track changes in this folder?"; Track Changes makes a repository and commits edits
    let plain = base.join("Plain");
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::write(plain.join("One.md"), "one\n").unwrap();
    std::fs::write(plain.join("Two.md"), "two\n").unwrap();
    let mut app = App::new("", None, false);
    app.open_local(plain.clone(), &mut tx);
    let plain = std::fs::canonicalize(&plain).unwrap();
    eprintln!("git selftest: plain folder dialog: {}", dialog(&app));
    check("a plain folder asks to track changes", matches!(&app.dialog, Some(Dialog::Confirm(c)) if c.kind == ConfirmKind::Git { root: plain.clone(), repo: false }));
    crate::actions::confirm(&mut app, &mut tx);
    check("Track Changes made .git", plain.join(".git").is_dir());
    check("automatic commits on", app.store.git_auto(&plain) == Some(true) && app.committer.is_some());
    wait(&app);
    eprintln!("git selftest: log after Track Changes: {:?}", sh(&plain, &["log", "--format=%s", "--name-only"]));
    edit(&mut app, &mut tx, "one, edited\n");
    wait(&app);
    let log = sh(&plain, &["log", "--format=%s"]);
    eprintln!("git selftest: log after an edit: {:?}", log);
    let open = app.path.as_ref().map(|p| crate::files::rel(&plain, p)).unwrap_or_default();
    check("the edit is committed", log.lines().next() == Some(&format!("Update {open}")));
    app.open_local(plain.clone(), &mut tx);
    check("never asked again", app.dialog.is_none());

    // 2. a repository: "This folder is a Git repository", off by default (Return), no commits
    let repo = base.join("Repo");
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    std::fs::write(repo.join("sub/A.md"), "a\n").unwrap();
    std::fs::write(repo.join("sub/B.md"), "b\n").unwrap();
    sh(&repo, &["init", "-q"]);
    sh(&repo, &["add", "-A"]);
    sh(&repo, &["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Start"]);
    let sub = std::fs::canonicalize(repo.join("sub")).unwrap();
    let mut app = App::new("", None, false);
    app.open_local(sub.clone(), &mut tx);
    eprintln!("git selftest: repository dialog: {}", dialog(&app));
    check("a subfolder of a repository asks about automatic commits", matches!(&app.dialog, Some(Dialog::Confirm(c)) if c.kind == ConfirmKind::Git { root: sub.clone(), repo: true }));
    // Return: "Leave It to Me"
    crate::actions::confirm_default(&mut app, &mut tx);
    check("Return leaves it to me (off)", app.dialog.is_none() && app.store.git_auto(&sub) == Some(false) && app.committer.is_none());
    let head = sh(&repo, &["rev-parse", "HEAD"]);
    app.open_note(sub.join("A.md"), &mut tx);
    edit(&mut app, &mut tx, "a, edited while off\n");
    std::thread::sleep(Duration::from_millis(300));
    check("off: no commit", sh(&repo, &["rev-parse", "HEAD"]) == head);
    check("off: the file is saved but uncommitted", sh(&repo, &["status", "--porcelain"]).contains("sub/A.md"));

    // 3. turned on: only the edited note is committed; another modified file and a staged one stay as they were
    app.toggle_auto_commits();
    check("the toggle turns it on", app.store.git_auto(&sub) == Some(true) && app.committer.is_some());
    std::fs::write(sub.join("B.md"), "b, changed outside\n").unwrap();
    std::fs::write(repo.join("staged.txt"), "staged\n").unwrap();
    sh(&repo, &["add", "staged.txt"]);
    edit(&mut app, &mut tx, "a, edited while on\n");
    wait(&app);
    let last = sh(&repo, &["show", "--format=%s", "--name-only", "HEAD"]);
    eprintln!("git selftest: last commit: {:?}", last);
    eprintln!("git selftest: status: {:?}", sh(&repo, &["status", "--porcelain"]));
    check("on: the edited note is committed", last.lines().next() == Some("Update A.md") && last.contains("sub/A.md"));
    check("on: B.md (changed outside) isn't", !last.contains("B.md") && sh(&repo, &["status", "--porcelain"]).contains(" M sub/B.md"));
    check("on: the staged file stays staged", sh(&repo, &["status", "--porcelain"]).contains("A  staged.txt"));
    // a new note, a rename and a delete (into a bin of our own: no real Trash)
    app.new_note(&mut tx);
    app.ed.set_text("# Fresh\n");
    app.handled(&mut tx);
    app.save_now();
    wait(&app);
    eprintln!("git selftest: after New Note: {:?}", sh(&repo, &["log", "-n", "2", "--format=%s"]));
    app.rename_path("A.md", "Renamed.md", &mut tx);
    app.git_commit_now();
    wait(&app);
    let last = sh(&repo, &["log", "-n", "1", "--format=%s", "--name-status"]);
    eprintln!("git selftest: after a rename: {:?}", last);
    check("the rename is committed", last.starts_with("Rename A.md to Renamed.md"));
    app.open_note(sub.join("Renamed.md"), &mut tx);
    // 4. a failing hook: shown, the change kept for the next try
    let hook = repo.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    edit(&mut app, &mut tx, "edited with a failing hook\n");
    wait(&app);
    eprintln!("git selftest: failure shown: {:?}", app.commit_failure());
    check("a failing hook shows", app.commit_failure().is_some_and(|f| f.contains("hook says no")));
    std::fs::remove_file(&hook).unwrap();
    edit(&mut app, &mut tx, "edited after the hook was fixed\n");
    wait(&app);
    check("the next change commits and clears it", app.commit_failure().is_none() && sh(&repo, &["log", "-n", "1", "--format=%s"]).trim() == "Update Renamed.md");
    // 5. a merge under way: skipped quietly
    std::fs::write(repo.join(".git/MERGE_HEAD"), sh(&repo, &["rev-parse", "HEAD"])).unwrap();
    let head = sh(&repo, &["rev-parse", "HEAD"]);
    edit(&mut app, &mut tx, "edited during a merge\n");
    wait(&app);
    check("during a merge: no commit, no failure", sh(&repo, &["rev-parse", "HEAD"]) == head && app.commit_failure().is_none());
    let _ = std::fs::remove_file(repo.join(".git/MERGE_HEAD"));
    drop(app);
    std::thread::sleep(Duration::from_millis(500));
    let _ = std::fs::remove_dir_all(&base);
    eprintln!("git selftest: {}", if ok.get() { "all ok" } else { "FAILED" });
    if ok.get() { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_follow_the_servers() {
        let mut p = Vec::new();
        add_change(&mut p, Change::Create("a.md".into()));
        add_change(&mut p, Change::Edit("a.md".into()));
        assert_eq!(message(&p), "Create a.md");
        add_change(&mut p, Change::Rename { from: "a.md".into(), to: "b.md".into() });
        add_change(&mut p, Change::Delete("c.md".into()));
        assert_eq!(message(&p), "Create a.md and 2 more changes\n\nCreate a.md\nRename a.md to b.md\nDelete c.md");
    }
}
