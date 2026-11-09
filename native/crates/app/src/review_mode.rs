//! Review mode (the web's `review.ts`), per note, on this Mac only, nothing on the server: it shows the latest batch
//! of changes from the latest author, whoever that is (you, someone else or an agent).
//!
//! Turning it on (the header's Review pill, Edit ▸ Review Mode, ⌥⌘R) reads the note's history, newest first. The
//! latest author is the newest commit's author, or, when the note has live edits not committed yet (its text differs
//! from the newest commit's), whoever made those (the line author of most of the lines that differ). Going back while
//! commits have that same author, the baseline is the note's text at the first commit by somebody else (the empty
//! note when that author made the whole history). Every line that differs from the baseline is tinted (added or
//! changed, not blank; deletions aren't shown). While it's on the baseline stays put and the tints follow the text,
//! so later edits by anyone (a different author's too) are tinted as well, until it's turned off and on again, which
//! recomputes the batch. Off drops it. Remote notes only; forgotten when another note opens.

use rune::{Drag, El, Phase, TextStyle, Tx, el, row, text};

use crate::App;
use crate::history::Commit;
use crate::theme::*;
use crate::workspaces::WsRef;

/// Edit ▸ Review Mode's shortcut (the web's ⌘⌥R / Ctrl+Alt+R).
pub const KEY: &str = "alt+cmd+r";
/// How many commits it reads (`history::Job::history`'s page).
pub const HISTORY: usize = 100;

/// Review mode for the open note: which note (`key`), whose batch it shows and the baseline it's against.
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewMode {
    pub key: String,
    pub author: String,
    pub baseline: String,
}

/// A note's key: its server, workspace and path.
pub fn key(server: &str, ws: &str, path: &str) -> String {
    format!("{server}\u{0}{ws}\u{0}{path}")
}

/// A name as commits and line authors both spell it: guests' commits add " (guest)".
fn plain_name(name: &str) -> String {
    name.strip_suffix(" (guest)").unwrap_or(name).trim().to_lowercase()
}

/// Whether two authors (a name and an email, "" when not known) are the same person or agent: the same email when
/// both have one, else the same name (the web's `sameAuthor`).
pub fn same_author(a: (&str, &str), b: (&str, &str)) -> bool {
    let (ea, eb) = (a.1.trim().to_lowercase(), b.1.trim().to_lowercase());
    if !ea.is_empty() && !eb.is_empty() {
        return ea == eb;
    }
    plain_name(a.0) == plain_name(b.0)
}

/// The latest batch (the web's `latestBatch`): its author (`live`, who made uncommitted edits, else the newest
/// commit's author) and the commit whose text is the baseline (None: the empty note). `commits` are newest first; a
/// full page (`limit`) all by the same author uses its oldest commit as the baseline.
pub fn latest_batch(commits: &[Commit], live: Option<&str>, limit: usize) -> (Option<String>, Option<String>) {
    let author = match (live, commits.first()) {
        (Some(n), _) => (n.to_string(), String::new()),
        (None, Some(c)) => (c.author.clone(), c.email.clone()),
        (None, None) => return (None, None),
    };
    let other = commits.iter().find(|c| !same_author((&c.author, &c.email), (&author.0, &author.1)));
    let baseline = match other {
        Some(c) => Some(c.sha.clone()),
        None if commits.len() >= limit => commits.last().map(|c| c.sha.clone()),
        None => None,
    };
    (Some(author.0), baseline)
}

/// Per line of `text`: whether review mode tints it, i.e. not blank and not a line of `baseline` (a line diff).
pub fn changed(baseline: &str, text: &str) -> Vec<bool> {
    let base: Vec<&str> = baseline.split('\n').collect();
    let lines: Vec<&str> = text.split('\n').collect();
    let mut kept = vec![false; lines.len()];
    for (_, b) in collab::blame::line_pairs(&base, &lines, 4000) {
        kept[b] = true;
    }
    lines.iter().enumerate().map(|(i, l)| !kept[i] && !l.trim().is_empty()).collect()
}

/// The pill's label (the web's `reviewLabel`): "Review" while off; "Reviewing: Alice · 12 lines" while on.
pub fn label(author: Option<&str>, count: usize) -> String {
    match author {
        None => "Review".into(),
        Some(a) => format!("Reviewing: {a} · {count} {}", if count == 1 { "line" } else { "lines" }),
    }
}

/// What turning it on fetched: the history, the newest commit's text, and the text at the first commit by somebody
/// other than the newest commit's author (the two baselines it can need).
type Fetched = Result<(Vec<Commit>, String, Option<(String, String)>), String>;

impl App {
    /// The open remote note's key (none for a local note, or before one is open).
    pub fn review_key(&self) -> Option<String> {
        let rem = self.remote.as_ref()?;
        let WsRef::Remote { server, id, .. } = &rem.ws else { return None };
        Some(key(server, id, rem.note.as_deref()?))
    }

    /// Review mode for the open note, while it's on.
    pub fn review(&self) -> Option<&ReviewMode> {
        self.review_mode.as_ref().filter(|r| Some(&r.key) == self.review_key().as_ref())
    }

    pub fn review_on(&self) -> bool {
        self.review().is_some()
    }

    /// Per line of the open note, whether review mode tints it (empty while it's off).
    pub fn review_lines(&self) -> Vec<bool> {
        self.review().map(|r| changed(&r.baseline, self.ed.text())).unwrap_or_default()
    }

    /// How many lines review mode tints now.
    pub fn review_count(&self) -> usize {
        self.review_lines().into_iter().filter(|&b| b).count()
    }

    /// Another note opened: review mode was for the one before.
    pub fn review_retarget(&mut self) {
        if self.review_mode.is_some() && self.review().is_none() {
            self.review_mode = None;
            self.refresh_menu();
        }
    }

    /// The header's pill, Edit ▸ Review Mode and ⌥⌘R: off (everything dropped), or on: the history, the newest
    /// commit's text and the live edits' author give the batch (in the background; the pill shows once it's in).
    pub fn toggle_review(&mut self, tx: &mut Tx) {
        let Some(k) = self.review_key() else { return };
        if self.review_on() {
            self.review_mode = None;
            self.refresh_menu();
            self.handled(tx);
            return;
        }
        if self.review_loading {
            return;
        }
        let Some((job, path)) = self.review_job() else { return };
        self.review_loading = true;
        self.background(
            move || -> Fetched {
                let commits = job.history(&path)?;
                let head = match commits.first() {
                    Some(c) => job.file(&c.sha, &path)?,
                    None => String::new(),
                };
                let other = match commits.first().and_then(|h| commits.iter().find(|c| !same_author((&c.author, &c.email), (&h.author, &h.email)))) {
                    Some(c) => Some((c.sha.clone(), job.file(&c.sha, &path)?)),
                    None => None,
                };
                Ok((commits, head, other))
            },
            move |app, r, tx| {
                app.review_loading = false;
                if app.review_key().as_ref() != Some(&k) {
                    return;
                }
                let (commits, head, other) = match r {
                    Ok(f) => f,
                    Err(e) => return app.show_error(format!("Couldn't start review mode: {e}")),
                };
                app.review_start(k, &commits, head, other);
                app.handled(tx);
            },
            tx,
        );
    }

    /// Review mode on from what `toggle_review` fetched.
    fn review_start(&mut self, key: String, commits: &[Commit], head: String, other: Option<(String, String)>) {
        let live = if self.ed.text() != head {
            self.remote.as_ref().and_then(|r| r.authors.as_ref()).and_then(|la| la.live_author(&head)).map(|a| a.name.clone())
        } else {
            None
        };
        let (author, sha) = latest_batch(commits, live.as_deref(), HISTORY);
        let baseline = match sha {
            None => String::new(),
            Some(s) if commits.first().is_some_and(|c| c.sha == s) => head,
            Some(s) => match other {
                Some((o, t)) if o == s => t,
                _ => head,
            },
        };
        self.review_mode = Some(ReviewMode { key, author: author.unwrap_or_else(|| "Unknown".into()), baseline });
        self.refresh_menu();
    }
}

/// The header's Review pill (the web's `.review-toggle`): a 26 pt pill, muted with a hairline while off; green (the
/// tints' colour, a dot) with whose batch it shows and how many lines while on.
pub fn pill(app: &App) -> Option<El> {
    app.review_key()?;
    let r = app.review();
    let on = r.is_some();
    let label = label(r.map(|r| r.author.as_str()), if on { app.review_count() } else { 0 });
    let green = "#34a853";
    let mut b = row()
        .key("review-toggle")
        .label(label.clone())
        .help("Review mode: highlight the latest batch of changes by the latest author (⌥⌘R)")
        .h(26.0)
        .px(10.0)
        .gap(6.0)
        .radius(13.0)
        .center_y()
        .cursor(rune::Cursor::Pointer)
        .on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.toggle_review(tx);
            }
        });
    b = if on {
        b.fill(c(green).alpha(0.13)).border(1.0, c(green).alpha(0.6)).child(el().key("review-dot").size(6.0, 6.0).radius(3.0).fill(c(green)))
    } else {
        b.border(1.0, c("#18181b").alpha(0.12)).hover(c(PAPER_2))
    };
    Some(b.child(text(label).key("review-toggle-text").font(TextStyle::new(12.5, crate::theme::wt(500.0)).lh(16.0)).color(c(if on { "#1e7e3a" } else { MUTED })).group_color(c(if on { "#1e7e3a" } else { INK }))))
}

/// `--review-mode-selftest`: undo giving lines back and review mode on the mock server with a history of its own,
/// headless, checked step by step: an agent's line typed into (ours), undone (the agent's, also after the room's
/// next message), redone, typed back; then a note Alice wrote and Bob edited twice: review on shows Bob's batch only
/// (back to Alice's commit), the pill names him and counts the lines; our edit while on is tinted too (the baseline
/// stays); off clears it; on again with our live edits: our batch (against Bob's newest commit). Prints `ok`/`FAIL`
/// lines; exits 1 on a failure.
pub fn selftest() -> i32 {
    use serde_json::{Value, json};
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};
    let mut fails = 0;
    let mut check = |name: &str, ok: bool, detail: String| {
        if !ok {
            fails += 1;
        }
        println!("{} {name}{}", if ok { "ok  " } else { "FAIL" }, if ok { String::new() } else { format!(" {detail}") });
    };
    let server = "https://grimoire.example";
    let v1 = "# Plan\n\nAlice's first line\nAlice's second line\n";
    let v2 = "# Plan\n\nAlice's first line\nAlice's second line, Bob was here\n";
    let v3 = "# Plan\n\nAlice's first line\nAlice's second line, Bob was here\nBob's own line\n";
    let note = "# Plan\n\nMy first line\nThe agent's line.\n";
    let mut rest = crate::fake::FakeRest::new(server, "Ann", "ann@example.com");
    let mut w = crate::fake::FakeWs::new("team", "Team", true);
    w.files = vec!["Plan.md".into(), "Agent.md".into()];
    rest.workspaces.push(w);
    rest.history = Some(vec![
        (json!({ "sha": "c3", "message": "Update Plan.md", "authorName": "Bob", "authorEmail": "bob@example.com", "date": 3 }), v3.to_string()),
        (json!({ "sha": "c2", "message": "Update Plan.md", "authorName": "Bob", "authorEmail": "bob@example.com", "date": 2 }), v2.to_string()),
        (json!({ "sha": "c1", "message": "Create Plan.md", "authorName": "Alice", "authorEmail": "alice@example.com", "date": 1 }), v1.to_string()),
    ]);
    let rest = Arc::new(Mutex::new(rest));
    let mut mock = crate::remote::Mock::new(&[("Plan.md", v3), ("Agent.md", note)]);
    mock.rest = Some(rest.clone());
    let m: crate::remote::MockRef = Rc::new(RefCell::new(mock));
    let agent_author = json!({ "id": "agent-1", "name": "OpenCode", "kind": "agent", "color": "#3b5b8c" });
    let mut app = App::new("", None, true);
    app.backend = crate::remote::Backend::Mock(m.clone());
    let mut tx = Tx::default();

    // undo gives a line back to its author (Agent.md: line authors from the room)
    app.open_remote(server.into(), "team".into(), "Team".into(), Some("Agent.md".into()), &mut tx);
    let me = app.remote.as_ref().map(|r| r.user.clone()).unwrap_or_default();
    let me_name = me["name"].as_str().unwrap_or_default().to_string();
    let me_author = json!({ "id": me["id"], "name": me["name"], "kind": me["kind"], "color": me["color"] });
    let blame = |app: &mut App, authors: Value, lines: Value| {
        m.borrow_mut().to_app.push_back(collab::protocol::control_frame(&json!({ "t": "blame", "authors": authors, "lines": lines })));
        app.pump_mock();
        app.pump_collab();
    };
    let author_of = |app: &App, needle: &str| -> String {
        let Some(i) = app.ed.text().split('\n').position(|l| l.contains(needle)) else { return "(no line)".into() };
        let la = app.remote.as_ref().and_then(|r| r.authors.as_ref());
        la.and_then(|la| la.values.get(i).and_then(|&v| la.authors.get(v as usize))).map_or("-".into(), |a| a.name.clone())
    };
    let caret_end_of = |app: &mut App, needle: &str| {
        let t = app.ed.text().to_string();
        let at = t.find(needle).map_or(t.len(), |i| i + needle.len());
        app.ed.set_selection(editor_core::Sel::caret(at));
    };
    blame(&mut app, json!([agent_author, me_author]), json!([1, 1, 1, 0, 1]));
    check("the agent's line is the agent's", author_of(&app, "The agent's line.") == "OpenCode", author_of(&app, "The agent's line."));
    caret_end_of(&mut app, "The agent's line.");
    app.ed.insert_text(" We add");
    app.handled(&mut tx);
    check("typing into it: ours at once", author_of(&app, "We add") == me_name, author_of(&app, "We add"));
    app.ed.undo();
    app.handled(&mut tx);
    check("undo: the agent's at once", author_of(&app, "The agent's line.") == "OpenCode", author_of(&app, "The agent's line."));
    blame(&mut app, json!([agent_author, me_author]), json!([1, 1, 1, 0, 1]));
    check("…and after the room's message", author_of(&app, "The agent's line.") == "OpenCode", author_of(&app, "The agent's line."));
    app.ed.redo();
    app.handled(&mut tx);
    check("redo: ours again", author_of(&app, "We add") == me_name, author_of(&app, "We add"));
    app.ed.undo();
    app.handled(&mut tx);
    caret_end_of(&mut app, "The agent's line.");
    app.ed.insert_text(" xy");
    app.handled(&mut tx);
    for _ in 0..3 {
        app.ed.delete_backward();
        app.handled(&mut tx);
    }
    check("typed back to the agent's text: the agent's", author_of(&app, "The agent's line.") == "OpenCode", author_of(&app, "The agent's line."));

    // review mode (Plan.md: Alice wrote it, Bob edited it twice)
    app.open_remote(server.into(), "team".into(), "Team".into(), Some("Plan.md".into()), &mut tx);
    let alice = json!({ "id": "u-alice", "name": "Alice", "kind": "human", "color": "#a00000" });
    let bob = json!({ "id": "u-bob", "name": "Bob", "kind": "human", "color": "#0000a0" });
    blame(&mut app, json!([alice, bob, me_author]), json!([0, 0, 0, 1, 1, 0]));
    let lit = |app: &App| -> Vec<String> {
        let lines: Vec<String> = app.ed.text().split('\n').map(str::to_string).collect();
        app.review_lines().iter().enumerate().filter(|(_, b)| **b).map(|(i, _)| lines[i].clone()).collect()
    };
    let pill_label = |app: &App| label(app.review().map(|r| r.author.as_str()), app.review_count());
    check("off: nothing tinted, the pill says Review", lit(&app).is_empty() && pill_label(&app) == "Review", pill_label(&app));
    app.toggle_review(&mut tx);
    check("on: Bob's batch, back to Alice's commit", lit(&app) == ["Alice's second line, Bob was here", "Bob's own line"], format!("{:?}", lit(&app)));
    check("the pill names Bob and counts his lines", pill_label(&app) == "Reviewing: Bob · 2 lines", pill_label(&app));
    check("the history was read", rest.lock().unwrap().log.iter().any(|l| l.contains("/history?path=Plan.md")), String::new());
    caret_end_of(&mut app, "Alice's first line");
    app.ed.insert_text(" (ours)");
    app.handled(&mut tx);
    check("our edit while on: tinted too (the baseline stays)", lit(&app).len() == 3 && lit(&app)[0] == "Alice's first line (ours)", format!("{:?}", lit(&app)));
    app.toggle_review(&mut tx);
    check("off: no tints", !app.review_on() && lit(&app).is_empty() && pill_label(&app) == "Review", format!("{:?}", lit(&app)));
    app.toggle_review(&mut tx);
    check("on again with our live edit: our batch only (against Bob's newest commit)", lit(&app) == ["Alice's first line (ours)"], format!("{:?}", lit(&app)));
    check("…the pill names us", pill_label(&app) == format!("Reviewing: {me_name} · 1 line"), pill_label(&app));
    app.toggle_review(&mut tx);
    app.toggle_review(&mut tx);
    check("off and on again: the same", lit(&app) == ["Alice's first line (ours)"], format!("{:?}", lit(&app)));
    app.open_remote(server.into(), "team".into(), "Team".into(), Some("Agent.md".into()), &mut tx);
    check("another note: off", !app.review_on() && app.review_mode.is_none(), String::new());
    println!("{}", if fails == 0 { "all ok".to_string() } else { format!("{fails} failed") });
    i32::from(fails > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, author: &str) -> Commit {
        Commit { sha: sha.into(), message: String::new(), author: author.into(), email: format!("{}@x.com", author.to_lowercase()), date: None }
    }

    #[test]
    fn the_latest_authors_batch() {
        let commits = [c("c4", "Alice"), c("c3", "Alice"), c("c2", "Bob"), c("c1", "Alice")];
        assert_eq!(latest_batch(&commits, None, 100), (Some("Alice".into()), Some("c2".into())));
        assert_eq!(latest_batch(&commits, Some("Bob"), 100), (Some("Bob".into()), Some("c4".into())), "someone else's live edits");
        assert_eq!(latest_batch(&commits, Some("alice"), 100).1.as_deref(), Some("c2"), "the same author's live edits");
        assert_eq!(latest_batch(&[c("c2", "Alice"), c("c1", "Alice")], None, 100).1, None, "the empty note");
        assert_eq!(latest_batch(&[c("c2", "Alice"), c("c1", "Alice")], None, 2).1.as_deref(), Some("c1"), "a full page");
        assert_eq!(latest_batch(&[], None, 100), (None, None));
        assert!(same_author(("moist-noodle (guest)", ""), ("moist-noodle", "")));
        assert!(!same_author(("A", "a@x"), ("A", "b@x")));
    }

    #[test]
    fn tinted_lines_and_labels() {
        assert_eq!(changed("one\ntwo\nthree", "one\nTWO\nthree\n\nfour"), [false, true, false, false, true]);
        assert_eq!(changed("", "a"), [true]);
        assert_eq!((label(None, 3), label(Some("Alice"), 12), label(Some("Alice"), 1)), ("Review".into(), "Reviewing: Alice · 12 lines".into(), "Reviewing: Alice · 1 line".into()));
    }
}
