//! "Search files" (⌘P, the sidebar's search button, File ▸ Search Files…): a dialog near the top of the
//! window with the open folder's notes as full paths, filtered and ranked as you type, as the web's
//! (`src/client/filesearch.ts`, `.fs-modal`). The tree itself is never filtered.

use rune::{Drag, El, Key, KeyEvent, Phase, TextEdit, TextStyle, Tx, col, el, row, text, text_input};

use crate::App;
use crate::files::{self, Entry};
use crate::theme::*;

/// Rows shown at most (a big folder: type more to narrow it down).
pub const LIMIT: usize = 200;
const W: f32 = 600.0;
const ROW: f32 = 28.0;
/// The selected row: the app blue 18 % over the dialog's paper (`#fafaf9`), mixed in sRGB like the web's
/// `color-mix(in srgb, var(--blue) 18%, var(--paper))`.
const SELECTED: &str = "#dae5eb";

#[derive(Debug, Default)]
pub struct Search {
    pub open: bool,
    pub input: TextEdit,
    /// The highlighted row (Up/Down, the pointer), for the query in `sel_for`: another query starts at the
    /// first row again.
    pub sel: usize,
    pub sel_for: String,
}

impl Search {
    pub fn selected(&self) -> usize {
        if self.sel_for == self.input.text { self.sel } else { 0 }
    }

    fn select(&mut self, i: usize) {
        self.sel = i;
        self.sel_for = self.input.text.clone();
    }
}

/// `p` without a Markdown extension (`.md`, `.markdown`, `.mdx`, any case).
fn strip_ext(p: &str) -> &str {
    let l = p.to_ascii_lowercase();
    for ext in [".markdown", ".mdx", ".md"] {
        if l.ends_with(ext) {
            return &p[..p.len() - ext.len()];
        }
    }
    p
}

fn subsequence(needle: &str, hay: &str) -> bool {
    let mut n = needle.chars().peekable();
    for c in hay.chars() {
        if n.peek() == Some(&c) {
            n.next();
        }
    }
    n.peek().is_none()
}

/// The notes matching `query`, best first (the web's `rankFiles`): the name starts with it, then the name
/// contains it, then the path does, then every word is in the path (or loosely, in order, in the name), then
/// its letters are in order in the path. Ties: shorter names first, then shorter paths, then by path. An
/// empty query lists every note by path.
pub fn rank(notes: &[String], query: &str) -> Vec<String> {
    let q = query.trim().to_lowercase();
    let by_path = |a: &String, b: &String| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b));
    if q.is_empty() {
        let mut all = notes.to_vec();
        all.sort_by(by_path);
        return all;
    }
    let terms: Vec<&str> = q.split_whitespace().collect();
    let loose: String = q.split_whitespace().collect();
    let mut scored: Vec<(u8, usize, usize, &String)> = Vec::new();
    for f in notes {
        let p = strip_ext(f).to_lowercase();
        let name = p.rsplit('/').next().unwrap_or(&p);
        let s = if name.starts_with(&q) {
            0
        } else if name.contains(&q) {
            1
        } else if p.contains(&q) {
            2
        } else if terms.iter().all(|t| p.contains(t) || (t.chars().count() > 1 && subsequence(t, name))) {
            3
        } else if subsequence(&loose, &p) {
            4
        } else {
            continue;
        };
        scored.push((s, name.chars().count(), p.chars().count(), f));
    }
    scored.sort_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)).then_with(|| by_path(a.3, b.3)));
    scored.into_iter().map(|x| x.3.clone()).collect()
}

/// Every note in the tree, relative to the root.
fn note_paths(entries: &[Entry], root: &std::path::Path, out: &mut Vec<String>) {
    for e in entries {
        match &e.kids {
            Some(k) => note_paths(k, root, out),
            None => out.push(files::rel(root, &e.path)),
        }
    }
}

impl App {
    /// The open folder's notes, ranked for what's typed (all of them; the dialog shows `LIMIT`).
    pub fn search_results(&self) -> Vec<String> {
        let Some(root) = &self.root else { return Vec::new() };
        let mut notes = Vec::new();
        note_paths(&self.files, root, &mut notes);
        rank(&notes, &self.search.input.text)
    }

    /// ⌘P: the dialog, its field focused and empty (already open: what's typed gets selected).
    pub fn open_search(&mut self) {
        if self.root.is_none() || self.dialog.is_some() {
            return;
        }
        if self.search.open {
            self.search.input.anchor = 0;
            self.search.input.focus = self.search.input.text.len();
            self.search.input.focused = true;
            return;
        }
        self.close_switcher();
        self.renaming = None;
        self.tree_focus = false;
        // the editor's composition, if any, doesn't follow the keys
        self.marked = None;
        let mut input = TextEdit::new("");
        input.focused = true;
        self.search = Search { open: true, input, ..Search::default() };
    }

    /// Escape, a press outside, another note opening: the dialog goes, the keys go back to the editor.
    pub fn close_search(&mut self) {
        self.search.open = false;
        self.search.input.focused = false;
        self.search.input.preedit = None;
    }

    /// Open the `i`th row's note: the dialog closes and the editor has the keys.
    pub fn search_choose(&mut self, i: usize, tx: &mut Tx) {
        let Some(rel) = self.search_results().into_iter().take(LIMIT).nth(i) else { return };
        let Some(root) = self.root.clone() else { return };
        self.close_search();
        self.tree_focus = false;
        self.open_note(root.join(rel), tx);
        self.handled(tx);
    }

    /// A key while the dialog is open: Up/Down move (no wrap), Return opens, Escape closes; the rest go to
    /// its field (`false`).
    pub fn search_key(&mut self, ev: &KeyEvent, tx: &mut Tx) -> bool {
        let n = self.search_results().len().min(LIMIT);
        match ev.key {
            Key::Down => self.search.select((self.search.selected() + 1).min(n.saturating_sub(1))),
            Key::Up => self.search.select(self.search.selected().saturating_sub(1)),
            Key::Enter => {
                let sel = self.search.selected();
                self.search_choose(sel, tx);
            }
            Key::Escape => self.close_search(),
            _ => return false,
        }
        tx.scroll_into_view(format!("fs-item:{}", self.search.selected()));
        true
    }
}

/// The dialog (`fs-…` keys): a backdrop that closes it, and the card 12 % down the window.
pub fn overlay(app: &App, vw: f32, vh: f32) -> Vec<El> {
    if !app.search.open {
        return Vec::new();
    }
    // the web's `.fs-modal`: min(600px, 90vw)
    let w = W.min((vw * 0.9).floor());
    let soft = c("#18181b").alpha(0.07);
    let all = app.search_results();
    let shown: Vec<&String> = all.iter().take(LIMIT).collect();
    let backdrop = el().key("fs-backdrop").absolute(0.0, 0.0).size(vw, vh).fill(c("#18181b").alpha(0.3)).on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
        if d.phase == Phase::Down {
            app.close_search();
            app.handled(tx);
        }
    });
    // `.fs-field` 8 pt around a 32 pt field, 14 pt text, 8 pt inside
    let field = row().key("fs-field").w(w - 2.0).padding(8.0).child(
        text_input(&app.search.input, TextStyle::new(14.0, 400.0).lh(16.8))
            .single_line()
            .key("fs-input")
            .w(w - 18.0)
            .h(32.0)
            .px(8.0)
            .py(7.6)
            .color(c(INK))
            .placeholder("Search files", c(MUTED))
            .caret(c(INK), selection())
            .on_edit(|app: &mut App| &mut app.search.input)
            // the field takes its keys before the app: Up/Down/Return/Esc are the dialog's
            .on_input_key(|app: &mut App, ev: &KeyEvent, tx: &mut Tx| {
                if !matches!(ev.key, Key::Up | Key::Down | Key::Enter | Key::Escape) || !app.search_key(ev, tx) {
                    return false;
                }
                app.handled(tx);
                tx.instant();
                true
            })
            .on_submit(|app: &mut App, tx: &mut Tx| {
                let sel = app.search.selected();
                app.search_choose(sel, tx);
            }),
    );
    let sel = app.search.selected().min(shown.len().saturating_sub(1));
    let items: Vec<El> = if shown.is_empty() {
        vec![text("No matching files").key("fs-empty").font(TextStyle::new(14.0, 400.0).lh(18.0)).color(c(MUTED)).px(10.0).py(12.0)]
    } else {
        shown.iter().enumerate().map(|(i, f)| item(i, f, i == sel, w - 10.0)).collect()
    };
    // `.fs-list`: 4 pt inside, growing with its rows up to min(420, 60% of the window, 88% − 120), then scrolling
    let list_h = 420.0f32.min(vh * 0.6).min(vh * 0.88 - 120.0);
    let list = col().key("fs-list").w(w - 2.0).max_h(list_h.max(ROW + 8.0)).padding(4.0).scroll(rune::ScrollSpec { stick_bottom: false }).child(col().key("fs-rows").w(w - 10.0).children(items));
    let mut card = col()
        .key("fs")
        .w(w)
        .fill(c(PAPER))
        .radius(8.0)
        .border(1.0, line())
        .shadow(24.0, 64.0, c("#18181b").alpha(0.18))
        .clip_soft(0.0)
        .on_drag(|_: &mut App, _: &mut Drag, _: &mut Tx| {})
        .child(field)
        .child(el().key("fs-rule").w(w - 2.0).h(1.0).fill(soft))
        .child(list);
    if all.len() > shown.len() {
        card = card.child(el().key("fs-foot-rule").w(w - 2.0).h(1.0).fill(soft)).child(
            text(format!("Showing {} of {}. Type more to narrow it down.", shown.len(), all.len()))
                .key("fs-foot")
                .font(TextStyle::new(12.5, 400.0).lh(16.0))
                .color(c(MUTED))
                .px(14.0)
                .py(7.0),
        );
    }
    let top = (vh * 0.12).round();
    vec![backdrop, card.absolute(((vw - w) / 2.0).round(), top)]
}

/// A row: the directory muted, the name semibold (the path without its extension).
fn item(i: usize, f: &str, selected: bool, w: f32) -> El {
    let p = strip_ext(f);
    let cut = p.rfind('/').map_or(0, |k| k + 1);
    let style = TextStyle::new(14.0, 400.0).lh(18.0);
    let mut t = row().key(format!("fs-text:{i}")).w(w - 20.0).absolute(10.0, (ROW - 18.0) / 2.0).clip_soft(0.0);
    if cut > 0 {
        t = t.child(text(&p[..cut]).key(format!("fs-dir:{i}")).font(style).color(c(MUTED)));
    }
    t = t.child(text(&p[cut..]).key(format!("fs-name:{i}")).font(TextStyle::new(14.0, 600.0).lh(18.0)).color(c(INK)).truncate());
    let e = el()
        .key(format!("fs-item:{i}"))
        .label(f.to_string())
        .w(w)
        .h(ROW)
        .radius(4.0)
        .child(t)
        .on_hover(move |app: &mut App| app.search.select(i))
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.search_choose(i, tx);
            }
        });
    if selected { e.fill(c(SELECTED)) } else { e }
}

/// The sidebar's search button: looks like a field ("Search files", the ⌘P hint), opens the dialog.
pub fn button(w: f32) -> El {
    row()
        .key("search-button")
        .label("Search files")
        .w(w)
        .h(32.0)
        .pl(10.0)
        .pr(7.0)
        .center_y()
        .fill(c(PAPER))
        .radius(6.0)
        .border(1.0, line())
        .on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.open_search();
                app.handled(tx);
            }
        })
        .child(text("Search files").key("search-label").font(TextStyle::new(13.5, 400.0).lh(18.0)).color(c(MUTED)).grow(1.0))
        .child(
            text("⌘P")
                .key("search-hint")
                .font(TextStyle::new(10.5, 500.0).lh(16.0))
                .color(c(MUTED))
                .w(26.0)
                .align(rune::Align::Center)
                .border(1.0, line())
                .radius(4.0),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    /// The web's test vectors (test/client/filesearch.test.ts).
    #[test]
    fn ranking_matches_the_web() {
        let files = s(&["projects/launch/plan.md", "projects/Planets.md", "notes/explain.md", "Plan B.md", "archive/2024/p-l-a-n.md", "Welcome.md"]);
        assert_eq!(rank(&files, "  "), s(&["archive/2024/p-l-a-n.md", "notes/explain.md", "Plan B.md", "projects/launch/plan.md", "projects/Planets.md", "Welcome.md"]));
        assert_eq!(rank(&files, "plan"), s(&["projects/launch/plan.md", "Plan B.md", "projects/Planets.md", "notes/explain.md", "archive/2024/p-l-a-n.md"]));
        assert_eq!(rank(&files, "launch"), s(&["projects/launch/plan.md"]));
        assert_eq!(rank(&files, "proj plan"), s(&["projects/launch/plan.md", "projects/Planets.md"]));
        assert_eq!(rank(&files, "WELC"), s(&["Welcome.md"]));
        assert!(rank(&files, "zzz").is_empty());
        assert!(rank(&files, ".md").is_empty(), "the extension isn't matched");
    }

    fn app() -> (App, std::path::PathBuf) {
        let _ = crate::layout::FONTS.set(crate::layout::Fonts { list: &[], sans: "Inter", mono: "Inter" });
        let dir = std::env::temp_dir().join(format!("grimoire-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (p, t) in [("a.md", "# A"), ("people/hiring.md", "# H"), ("people/Grace.md", "# G")] {
            std::fs::create_dir_all(dir.join(p).parent().unwrap()).unwrap();
            std::fs::write(dir.join(p), t).unwrap();
        }
        let dir = std::fs::canonicalize(&dir).unwrap();
        let app = App::new("# A", Some(dir.join("a.md")), true).with_root(Some(dir.clone()), files::scan(&dir).0);
        (app, dir)
    }

    fn key(app: &mut App, k: Key, tx: &mut Tx) -> bool {
        crate::input::on_key(app, &KeyEvent { key: k, mods: rune::Mods::default() }, tx)
    }

    #[test]
    fn the_dialog_takes_the_keys_and_opens_the_chosen_note() {
        let (mut app, dir) = app();
        let mut tx = Tx::default();
        // ⌘P: File ▸ Search Files…
        (crate::tree_edit::FILE_MENU.iter().find(|m| m.0 == "search-files").unwrap().3)(&mut app, &mut tx);
        assert!(app.search.open && app.search.input.focused);
        assert_eq!(app.search_results(), ["a.md", "people/Grace.md", "people/hiring.md"]);
        // typing goes to the field, not the editor
        assert!(!key(&mut app, Key::Text("x".into()), &mut tx));
        assert_eq!(app.ed.text(), "# A");
        app.search.input = TextEdit::new("h");
        assert_eq!(app.search_results(), ["people/hiring.md"]);
        app.search.input = TextEdit::new("");
        app.search.input.focused = true;
        assert!(key(&mut app, Key::Down, &mut tx));
        assert!(key(&mut app, Key::Down, &mut tx));
        assert!(key(&mut app, Key::Down, &mut tx));
        assert_eq!(app.search.selected(), 2, "no wrap");
        // another query: the first row again
        app.search.input.text.push('x');
        assert_eq!(app.search.selected(), 0);
        app.search.input.text.pop();
        assert!(key(&mut app, Key::Up, &mut tx));
        assert!(key(&mut app, Key::Enter, &mut tx));
        assert!(!app.search.open && !app.tree_focus);
        assert_eq!(app.path, Some(dir.join("people/Grace.md")));
        // Escape closes; nothing opens
        app.open_search();
        assert!(key(&mut app, Key::Escape, &mut tx));
        assert!(!app.search.open);
        assert_eq!(app.path, Some(dir.join("people/Grace.md")));
        // the tree is never filtered
        app.open_search();
        app.search.input = TextEdit::new("zzz");
        assert!(app.search_results().is_empty());
        assert_eq!(app.tree_rows().len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
