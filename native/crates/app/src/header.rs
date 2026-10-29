//! The note's header, as the web's `.doc-header` (52 pt, padding 0 12 0 24, gap 12): the breadcrumb on the left
//! (folder / folders / note), then on the right the people in the note (avatars: 6 then "+N"), the save status,
//! "Authors" (the line-author margin on or off, pressed = grey fill) and "History".

use rune::{Drag, El, Phase, TextStyle, Transition, Tx, el, row, text};
use serde_json::Value;

use crate::App;
use crate::theme::*;
use crate::workspaces::WsRef;

pub const HEADER_H: f32 = 52.0;
/// `.crumb-sep`'s grey.
const SEP: &str = "#a1a1aa";

/// The web's `initials`: two letters of a one-word name, else the first and last words' first letters.
pub fn initials(name: &str) -> String {
    let parts: Vec<&str> = name.trim().split(|c: char| c.is_whitespace() || c == '.' || c == '_' || c == '-').filter(|s| !s.is_empty()).collect();
    match parts.as_slice() {
        [] => "?".into(),
        [one] => one.chars().take(2).collect::<String>().to_uppercase(),
        [first, .., last] => format!("{}{}", first.chars().next().unwrap_or('?'), last.chars().next().unwrap_or('?')).to_uppercase(),
    }
}

/// Someone in the note: the presence user's id, name, colour, kind ("human", "guest", "agent"), and us.
#[derive(Clone, Debug, PartialEq)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub color: String,
    pub kind: String,
    pub me: bool,
}

impl Person {
    /// A peer's presence `user`, if it has the right shape (the web's `validPeerUser`: peers are untrusted).
    pub fn from_user(u: &Value, me: bool) -> Option<Person> {
        let id = u["id"].as_str().filter(|s| !s.is_empty())?;
        let name = u["name"].as_str()?.trim().chars().take(80).collect::<String>();
        let color = u["color"].as_str().filter(|c| (c.len() == 4 || c.len() == 7) && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit()));
        Some(Person {
            id: id.into(),
            name: if name.is_empty() { "Anonymous".into() } else { name },
            color: color.map_or_else(|| crate::workspaces::guest_color(id), str::to_string),
            kind: match u["kind"].as_str() {
                Some("agent") => "agent",
                Some("guest") => "guest",
                _ => "human",
            }
            .into(),
            me,
        })
    }

    /// The avatar's tooltip, as the web's.
    pub fn title(&self, signed_in: bool) -> String {
        match (self.me, self.kind.as_str()) {
            (true, _) if signed_in => format!("{} (you)", self.name),
            (true, _) => format!("{} (you, not signed in)", self.name),
            (_, "agent") => format!("{} (agent)", self.name),
            (_, "guest") => format!("{} (guest, not signed in)", self.name),
            _ => self.name.clone(),
        }
    }
}

impl App {
    /// The people in the open remote note: us first, then each other participant once.
    pub fn people(&self) -> Vec<Person> {
        let Some(rem) = self.remote.as_ref().filter(|r| r.loaded && r.note.is_some()) else { return Vec::new() };
        let mut out: Vec<Person> = Person::from_user(&rem.user, true).into_iter().collect();
        for (_, u) in self.room_peers() {
            if let Some(p) = Person::from_user(&u["user"], false)
                && !out.iter().any(|o| o.id == p.id)
            {
                out.push(p);
            }
        }
        out
    }

    /// A note is open: the header shows.
    /// The header shows over a note, and over the pages that say why there's none (as the web's, under its header):
    /// a notice keeps the note's breadcrumb, a workspace that can't load an empty header.
    pub fn header_shown(&self) -> bool {
        self.problem_page().is_some() || (self.path.is_some() && self.remote.as_ref().is_none_or(|r| r.loaded))
    }

    /// The header's breadcrumb path: the open note's (relative), or the note a notice is about.
    fn header_rel(&self) -> Option<String> {
        match (&self.root, &self.path) {
            (Some(r), Some(p)) => Some(crate::files::rel(r, p)),
            _ => self.remote.as_ref().and_then(|r| r.note.clone()),
        }
    }
}

fn crumb(s: &str, key: String, ink: &str) -> El {
    text(s.to_string()).key(key).font(TextStyle::new(14.0, 500.0).lh(17.0)).color(c(ink))
}

fn sep(i: usize) -> El {
    text("/").key(format!("crumb-sep{i}")).font(TextStyle::new(14.0, 400.0).lh(17.0)).color(c(SEP))
}

/// An avatar (`.avatar-md`): 26 pt, 4 pt corners, white initials on the person's colour; a guest's has a ring
/// (paper 1.5 pt, then its colour 1 pt) and 85 % opacity; an agent's an "AI" badge at its bottom right.
fn avatar(p: &Person, i: usize, signed_in: bool) -> El {
    let col = rune::color::hex(&p.color).unwrap_or_else(|| c("#888888"));
    let face = row()
        .key(format!("avatar-face{i}"))
        .absolute(0.0, 0.0)
        .size(26.0, 26.0)
        .radius(4.0)
        .fill(col)
        .center()
        .child(text(initials(&p.name)).key(format!("avatar-initials{i}")).font(TextStyle::new(10.5, 650.0).lh(13.0).tracking(0.21)).color(c("#ffffff")));
    let mut e = el().key(format!("avatar{i}")).size(26.0, 26.0).help(p.title(signed_in));
    if p.kind == "guest" {
        e = e
            .opacity(0.85)
            .child(el().key(format!("avatar-ring{i}")).absolute(-2.5, -2.5).size(31.0, 31.0).radius(6.5).fill(col))
            .child(el().key(format!("avatar-gap{i}")).absolute(-1.5, -1.5).size(29.0, 29.0).radius(5.5).fill(c(PAPER)));
    }
    e = e.child(face);
    if p.kind == "agent" {
        e = e.child(
            text("AI")
                .key(format!("avatar-ai{i}"))
                .font(TextStyle::new(7.5, 650.0).lh(10.0).tracking(0.45))
                .color(c(PAPER))
                .fill(c(INK))
                .radius(3.0)
                .px(3.0)
                .absolute(26.0 + 5.0 - 15.0, 26.0 + 5.0 - 10.0),
        );
    }
    e
}

/// A `.btn-tab`: 30 pt, 10 pt sides, 550 13 pt ink; grey under the pointer; pressed: `#e4e4e7`.
fn tab(label: &str, key: &str, pressed: bool, help: &str, on: fn(&mut App, &mut Tx)) -> El {
    let b = row()
        .key(key.to_string())
        .label(label.to_string())
        .help(help.to_string())
        .h(30.0)
        .px(10.0)
        .radius(6.0)
        .center()
        .child(text(label.to_string()).key(format!("{key}-text")).font(TextStyle::new(13.0, 550.0).lh(16.0)).color(c(INK)))
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                on(app, tx);
                app.handled(tx);
            }
        });
    if pressed { b.fill(c(TINT_ACTIVE)).hover(c(TINT_ACTIVE)) } else { b.hover(c(PAPER_2)) }
}

/// `.save-status`: muted 12.5 pt text; a warning (`.warn`) is ink 500 on the soft yellow (`--warn-soft` over the
/// paper) with a 6 pt `--warn` dot, 4/9/4/8 padding, 6 pt corners.
fn save_status(msg: &str, warn: bool) -> El {
    let t = text(msg.to_string()).key("save-status-text").font(TextStyle::new(12.5, if warn { 500.0 } else { 400.0 }).lh(16.0)).color(c(if warn { INK } else { MUTED }));
    if !warn {
        return row().key("save-status").center_y().child(t);
    }
    row()
        .key("save-status")
        .pl(8.0)
        .pr(9.0)
        .py(4.0)
        .gap(7.0)
        .center_y()
        .radius(6.0)
        .fill(c("#faeecb"))
        .child(el().key("save-status-dot").size(6.0, 6.0).radius(3.0).fill(c("#e0a800")))
        .child(t)
}


/// The header shows the sidebar button: the sidebar is hidden (narrow window, or ⌘\\).
pub fn wants_sidebar_button(app: &App) -> bool {
    app.root.is_some() && !crate::sidebar::shown(app, crate::sidebar::window_w())
}

/// The web's `.sidebar-toggle`: a 32 pt ink button (6 pt corners) with its burger (14×10, three 2 pt bars); it
/// shows the sidebar.
fn burger() -> El {
    let bar = |i: usize| el().key(format!("burger-bar{i}")).absolute(0.0, i as f32 * 4.0).size(14.0, 2.0).fill(c(INK));
    row()
        .key("sidebar-toggle")
        .label("Sidebar")
        .size(32.0, 32.0)
        .center()
        .radius(6.0)
        .hover(c(TINT_HOVER))
        .cursor(rune::Cursor::Pointer)
        .on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.toggle_sidebar();
                app.handled(tx);
            }
        })
        .child(el().key("burger").size(14.0, 10.0).child(bar(0)).child(bar(1)).child(bar(2)))
}

/// The open note on GitHub, for a read-only GitHub copy (the web's `githubFileUrl`; the repo's branch, else HEAD).
pub fn github_file_url(app: &App) -> Option<String> {
    let rem = app.remote.as_ref()?;
    let repo = &rem.repo;
    if repo["kind"] != "github" || !rem.read_only {
        return None;
    }
    let (owner, name) = (repo["ghOwner"].as_str()?, repo["ghName"].as_str()?);
    let branch = repo["branch"].as_str().filter(|b| !b.is_empty()).unwrap_or("HEAD");
    let path = rem.note.as_deref()?;
    let enc = |s: &str| s.split('/').map(component).collect::<Vec<_>>().join("/");
    Some(format!("https://github.com/{owner}/{name}/blob/{}/{}", enc(branch), enc(path)))
}

/// `encodeURIComponent`.
fn component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The web's `.gh-source`: "Read-only · from GitHub ↗" (12 pt, muted on paper-2, darker on hover), opening the file
/// on GitHub.
fn gh_source(url: String, rel: &str) -> El {
    let label = "Read-only · from GitHub ↗";
    row()
        .key("gh-source")
        .label(label)
        .help(format!("View {rel} on GitHub"))
        .ml(6.0)
        .px(8.0)
        .py(3.0)
        .radius(6.0)
        .fill(c(PAPER_2))
        .hover(c(TINT_HOVER))
        .cursor(rune::Cursor::Pointer)
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.launch(&url);
                app.handled(tx);
            }
        })
        .child(text(label).key("gh-source-text").font(TextStyle::new(12.0, 500.0).lh(16.0)).color(c(MUTED)).group_color(c(INK)))
}

pub fn view(app: &App, w: f32) -> El {
    let mut r = row().key("doc-header").w(w).h(HEADER_H).pr(12.0).gap(12.0).center_y();
    // the sidebar hidden: the web's burger brings it back
    r = if wants_sidebar_button(app) { r.pl(12.0).child(burger()) } else { r.pl(24.0) };
    // a workspace that can't load: the header is empty (the web's `showMissing` clears it)
    let problem = app.remote.as_ref().is_some_and(|x| x.problem.is_some());
    let notice = app.remote.as_ref().is_some_and(|x| x.notice.is_some());
    let Some(rel) = app.header_rel().filter(|_| !problem) else { return r };
    let folder = app.current.as_ref().map(WsRef::name).unwrap_or_default();
    let parts: Vec<&str> = rel.split('/').collect();
    let file = crate::files::note_name(std::path::Path::new(&rel));
    let repo = row().key("crumb-repo").label(folder.clone()).hover(c(PAPER).alpha(0.0)).child(crumb(&folder, "crumb-repo-text".into(), MUTED).group_color(c(INK))).on_drag(
        |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                if !crate::sidebar::shown(app, crate::sidebar::window_w()) {
                    app.sidebar = Some(true);
                }
                app.handled(tx);
            }
        },
    );
    let mut crumbs = row().key("breadcrumb").gap(6.0).center_y().grow(1.0).min_w(0.0).clip_soft(0.0).child(repo);
    for (i, d) in parts[..parts.len().saturating_sub(1)].iter().enumerate() {
        crumbs = crumbs.child(sep(i)).child(crumb(d, format!("crumb{i}"), MUTED));
    }
    crumbs = crumbs.child(sep(parts.len())).child(crumb(&file, "crumb-file".into(), INK).help(rel.clone()));
    // a read-only GitHub copy: the web's link to the file there (not in a narrow window, as the web's)
    if let Some(url) = github_file_url(app)
        && crate::sidebar::window_w() >= 900.0
    {
        crumbs = crumbs.child(gh_source(url, &rel));
    }
    let mut r = r.child(crumbs);
    // a notice (no note open): only the breadcrumb, as the web's header without a session
    if notice {
        return r;
    }
    let remote = app.remote.is_some();
    if remote {
        let signed_in = !app.is_guest();
        let people = app.people();
        let mut ps = row().key("participants").gap(4.0).center_y();
        for (i, p) in people.iter().take(6).enumerate() {
            // they arrive after the note: faded in, in space that pushes nothing (the row ends at History)
            ps = ps.child(avatar(p, i, signed_in).transition(Transition::opacity()));
        }
        if people.len() > 6 {
            ps = ps.child(
                row()
                    .key("avatar-more")
                    .size(26.0, 26.0)
                    .radius(4.0)
                    .fill(c(TINT_ACTIVE))
                    .center()
                    .child(text(format!("+{}", people.len() - 6)).key("avatar-more-text").font(TextStyle::new(10.5, 650.0).lh(13.0)).color(c(INK_2))),
            );
        }
        r = r.child(ps);
    }
    if let Some((msg, warn)) = app.save_status() {
        r = r.child(save_status(&msg, warn));
    }
    if remote {
        r = r.child(tab("Authors", "authors-btn", app.show_authors(), "Show who wrote each line", |app, tx| app.toggle_authors(tx)));
    }
    match app.history_target() {
        Ok(_) => r.child(tab("History", "history-btn", app.history.open, "History", |app, tx| app.toggle_history(tx))),
        // a local folder that isn't a Git repository: disabled, the reason as its tooltip
        Err(why) => r.child(
            row()
                .key("history-btn")
                .label("History")
                .help(why)
                .h(30.0)
                .px(10.0)
                .center()
                .child(text("History").key("history-btn-text").font(TextStyle::new(13.0, 550.0).lh(16.0)).color(c(MUTED))),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_sidebar_button_shows_while_the_sidebar_is_hidden() {
        let dir = std::env::temp_dir().join(format!("grimoire-burger-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut app = App::new("# A", None, true).with_root_pub(Some(dir.clone()));
        app.sidebar = Some(true);
        assert!(!wants_sidebar_button(&app));
        app.sidebar = Some(false);
        assert!(wants_sidebar_button(&app));
        app.toggle_sidebar();
        assert!(!wants_sidebar_button(&app), "its press shows the sidebar");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn initials_and_people_like_the_web() {
        assert_eq!(initials("Ann Lee"), "AL");
        assert_eq!(initials("moist-noodle"), "MN");
        assert_eq!(initials("james"), "JA");
        assert_eq!(initials("Mary Ann van Dyke"), "MD");
        assert_eq!(initials("  "), "?");
        assert_eq!(initials("Me"), "ME", "the account row too (it said M)");
        assert_eq!(initials("bob@example.com"), "BC");
        let p = Person::from_user(&json!({ "id": "guest:x", "name": " spicy-waffle ", "kind": "guest", "color": "#2b6a54" }), false).unwrap();
        assert_eq!((p.name.as_str(), p.kind.as_str(), p.title(true).as_str()), ("spicy-waffle", "guest", "spicy-waffle (guest, not signed in)"));
        let a = Person::from_user(&json!({ "id": "agent:1", "name": "Claude", "kind": "agent", "color": "javascript:" }), false).unwrap();
        assert_eq!((a.title(true).as_str(), a.color.as_str()), ("Claude (agent)", crate::workspaces::guest_color("agent:1").as_str()));
        assert!(Person::from_user(&json!({ "id": "", "name": "x" }), false).is_none());
        let me = Person::from_user(&json!({ "id": "u", "name": "Ann", "kind": "weird" }), true).unwrap();
        assert_eq!((me.kind.as_str(), me.title(true).as_str(), me.title(false).as_str()), ("human", "Ann (you)", "Ann (you, not signed in)"));
    }
}
