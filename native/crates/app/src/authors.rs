//! Line authors in the editor's left margin (remote notes), as the web's `editor-rs/authors.ts`: the room says
//! who wrote each line (`{t:"blame"}`, collab's `Notice::Blame`); a small muted name at the editor pane's left
//! edge, only where the author changes. Between messages the values follow the text (`collab::blame::attribute`):
//! our own edits are ours at once, others' keep the line's previous author until the next message.

use std::collections::HashSet;

use collab::{Blame, BlameAuthor};
use editor_core::BlockType;
use rune::{El, TextStyle, Tx, text};
use serde_json::Value;

use crate::App;
use crate::layout::{self, Geo};
use crate::theme::*;

/// Where names start: this far right of the editor pane's left edge.
pub const INSET: f32 = 16.0;
/// Space kept between a name and the text column.
const GAP: f32 = 12.0;
/// Narrowest margin worth drawing names in.
pub const MIN_MARGIN: f32 = 24.0;
/// `.mde-author`'s colour.
const NAME_INK: &str = "#9a9aa1";

/// `.mde-author .nm`: 500 11px, 0.01em.
pub fn name_style() -> TextStyle {
    TextStyle::new(11.0, 500.0).lh(13.0).tracking(0.11)
}

/// The room's line authors, kept in step with the editor's text between its messages.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LineAuthors {
    pub authors: Vec<BlameAuthor>,
    /// Per line of `text`: an index into `authors`, or -1.
    pub values: Vec<i32>,
    /// The text `values` describe.
    pub text: String,
    /// Our own index in `authors` (-1 until we're there).
    pub me: i32,
}

impl LineAuthors {
    /// A message arrived: it describes the server's text, which `text` (ours) may be ahead of.
    pub fn new(b: Blame, text: &str, me_id: &str) -> LineAuthors {
        let me = b.authors.iter().position(|a| a.id == me_id).map_or(-1, |i| i as i32);
        LineAuthors { authors: b.authors, values: b.lines, text: text.to_string(), me }
    }

    /// The text became `next`: by us (`me`: our presence user, the lines become ours) or by someone else.
    pub fn follow(&mut self, next: &str, me: Option<&Value>) {
        if next == self.text {
            return;
        }
        let who = me.map(|u| {
            if self.me < 0 {
                self.authors.push(BlameAuthor {
                    id: u["id"].as_str().unwrap_or_default().into(),
                    name: u["name"].as_str().unwrap_or_default().into(),
                    kind: u["kind"].as_str().unwrap_or("human").into(),
                    color: u["color"].as_str().unwrap_or("#888").into(),
                });
                self.me = self.authors.len() as i32 - 1;
            }
            self.me
        });
        self.values = collab::blame::attribute(&self.text, next, &self.values, who);
        self.text = next.to_string();
    }
}

/// For each line the author to show (an index), or -1 (the web's `authorMarks`): a name only where the author
/// differs from the last line that could show one; `skip` lines (headings, fences, table delimiter rows, rules,
/// empty and folded lines) show nothing and don't count; an unknown line shows nothing and ends the run. Fewer
/// than two distinct authors over all the lines (unknown ones aside): no names at all.
pub fn marks(skip: &[bool], values: &[i32]) -> Vec<i32> {
    let mut out = vec![-1; skip.len()];
    let mut distinct = HashSet::new();
    for i in 0..skip.len() {
        let v = values.get(i).copied().unwrap_or(-1);
        if v >= 0 {
            distinct.insert(v);
            if distinct.len() >= 2 {
                break;
            }
        }
    }
    if distinct.len() < 2 {
        return out;
    }
    let mut last = -1;
    for (i, &sk) in skip.iter().enumerate() {
        if sk {
            continue;
        }
        let v = values.get(i).copied().unwrap_or(-1);
        if v >= 0 && v != last {
            out[i] = v;
        }
        last = v;
    }
    out
}

impl App {
    /// The editor's text may have changed: the line authors follow (`local`: our edit).
    pub fn authors_follow(&mut self, local: bool) {
        let Some(rem) = self.remote.as_mut() else { return };
        let Some(la) = rem.authors.as_mut() else { return };
        let me = local.then_some(&rem.user);
        la.follow(self.ed.text(), me);
    }

    /// "Authors" (next to History) and View ▸ Show Authors: the margin on or off, remembered.
    pub fn toggle_authors(&mut self, tx: &mut Tx) {
        self.store.hide_authors = !self.store.hide_authors;
        self.store.save();
        self.refresh_menu();
        self.handled(tx);
    }

    pub fn show_authors(&self) -> bool {
        !self.store.hide_authors
    }
}

/// The names drawn (keys `author:<line>`).
pub fn margin(app: &App, geo: &Geo, pane_w: f32) -> Vec<El> {
    let style = name_style();
    names(app, geo, pane_w).into_iter().map(|(i, name, x, y)| text(name).key(format!("author:{i}")).font(style).color(c(NAME_INK)).absolute(x, y)).collect()
}

/// The names to draw — (line, name, x, y) in the editor surface's coordinates: left-aligned `INSET` from the
/// editor pane's left edge (the surface is centred in a pane `pane_w` wide), each on its line's first baseline;
/// a name that doesn't fit whole between there and `GAP` before the text column isn't shown (never cut).
pub fn names(app: &App, geo: &Geo, pane_w: f32) -> Vec<(usize, String, f32, f32)> {
    let Some(la) = app.remote.as_ref().and_then(|r| r.authors.as_ref()).filter(|_| app.show_authors()) else { return Vec::new() };
    let surface_left = (pane_w - layout::surface_w()) / 2.0;
    let left = INSET - surface_left;
    let room = PAD_L - GAP - left;
    if room < MIN_MARGIN {
        return Vec::new();
    }
    let t = app.ed.text();
    let skip: Vec<bool> = geo
        .lines
        .iter()
        .map(|l| {
            !l.drawn()
                || matches!(l.view.kind, BlockType::Heading | BlockType::Fence | BlockType::TableDelim | BlockType::Hr)
                || t.get(l.view.from..l.view.to).is_none_or(|s| s.trim().is_empty())
        })
        .collect();
    let style = name_style();
    let mut out = Vec::new();
    for (i, a) in marks(&skip, &la.values).into_iter().enumerate() {
        let (Some(author), Some(piece)) = (la.authors.get(a as usize).filter(|_| a >= 0), geo.lines[i].pieces.first()) else { continue };
        let (w, base) = layout::measure(&author.name, style);
        if w > room + 0.5 {
            continue;
        }
        out.push((i, author.name.clone(), left, PAD_T + piece.baseline() - base));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The web's `authorMarks` rules.
    #[test]
    fn names_show_where_the_author_changes() {
        // a: Ann, b: Bob; skip marks headings/empty/etc.
        assert_eq!(marks(&[false, false, false, false], &[0, 0, 1, 1]), [0, -1, 1, -1]);
        // a skipped line doesn't show and doesn't count as the last one shown
        assert_eq!(marks(&[false, true, false], &[0, 1, 0]), [0, -1, -1]);
        // unknown: nothing, and the next known author shows again
        assert_eq!(marks(&[false, false, false, false], &[0, -1, 0, 1]), [0, -1, 0, 1]);
        // one distinct author (unknown ignored, skipped lines count): no names at all
        assert_eq!(marks(&[false, false], &[1, 1]), [-1, -1]);
        assert_eq!(marks(&[false, false], &[-1, -1]), [-1, -1]);
        // two authors, one only on a skipped line (a heading): names show
        assert_eq!(marks(&[true, false, false], &[1, 0, 0]), [-1, 0, -1]);
    }

    /// Our own edits are ours at once (a first keystroke in someone else's note brings the names); others' keep
    /// the line's author; a deleted line takes its author away (one author left: no names).
    #[test]
    fn values_follow_the_text() {
        let b = Blame { authors: vec![BlameAuthor { id: "u1".into(), name: "Ann".into(), kind: "human".into(), color: "#123456".into() }], lines: vec![0, 0] };
        let mut la = LineAuthors::new(b, "one\ntwo", "me");
        assert_eq!(la.me, -1);
        let me = serde_json::json!({ "id": "me", "name": "Mac", "color": "#0090ff", "kind": "human" });
        la.follow("one\ntwo!", Some(&me));
        assert_eq!((la.values.clone(), la.me, la.authors[1].name.as_str()), (vec![0, 1], 1, "Mac"));
        assert_eq!(marks(&[false, false], &la.values), [0, 1]);
        la.follow("one?\ntwo!", None);
        assert_eq!(la.values, [0, 1]);
        la.follow("one?", Some(&me));
        assert_eq!(marks(&[false], &la.values), [-1]);
    }
}
