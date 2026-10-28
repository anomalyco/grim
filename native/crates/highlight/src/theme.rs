//! Grimoire's highlight theme (`highlight-theme.json`, shared with the web editor): token names to
//! a colour and italic/bold, the longest dotted prefix of a token's name that the theme lists
//! winning (`keyword.control` → `keyword`), else the foreground; `lines` gives diff/patch lines a
//! background.

use serde_json::Value;

use crate::{DIFF, TOKEN_NAMES, Token};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Style {
    /// `#rrggbb` (the theme's foreground when the token has none).
    pub color: String,
    pub italic: bool,
    pub bold: bool,
}

#[derive(Clone, Debug)]
pub struct Theme {
    pub foreground: String,
    /// Per token id (`TOKEN_NAMES`).
    styles: Vec<Style>,
    /// `lines["diff.plus"]`, `lines["diff.minus"]` backgrounds.
    plus_bg: Option<String>,
    minus_bg: Option<String>,
}

impl Theme {
    pub fn parse(json: &str) -> Result<Theme, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let foreground = v["foreground"].as_str().ok_or("theme has no foreground")?.to_string();
        let tokens = v["tokens"].as_object().ok_or("theme has no tokens")?;
        let styles = TOKEN_NAMES
            .iter()
            .map(|&name| {
                let mut key = name;
                let entry = loop {
                    if let Some(e) = tokens.get(key).filter(|e| e.is_object()) {
                        break Some(e);
                    }
                    match key.rfind('.') {
                        Some(i) => key = &key[..i],
                        None => break None,
                    }
                };
                let get = |k: &str| entry.and_then(|e| e.get(k));
                Style {
                    color: get("color").and_then(Value::as_str).unwrap_or(&foreground).to_string(),
                    italic: get("italic").and_then(Value::as_bool).unwrap_or(false),
                    bold: get("bold").and_then(Value::as_bool).unwrap_or(false),
                }
            })
            .collect();
        let bg = |k: &str| v["lines"][k]["background"].as_str().map(str::to_string);
        Ok(Theme { styles, plus_bg: bg("diff.plus"), minus_bg: bg("diff.minus"), foreground })
    }

    pub fn style(&self, id: u8) -> &Style {
        &self.styles[(id as usize).min(self.styles.len() - 1)]
    }

    /// Drawn like the block's plain text (foreground, upright, regular).
    pub fn is_plain(&self, id: u8) -> bool {
        let s = self.style(id);
        s.color == self.foreground && !s.italic && !s.bold
    }

    /// A line's background (`lines`): the first token that isn't punctuation (the `+`/`-` marker
    /// is `punctuation.special`) is `diff.plus` or `diff.minus`; in a diff, a line of just the
    /// marker (an added or removed empty line) too.
    pub fn line_bg(&self, lang: u8, tokens: &[Token], text: &str) -> Option<&str> {
        let side = |name: &str| {
            if name == "diff.plus" || name.starts_with("diff.plus.") {
                Some(true)
            } else if name == "diff.minus" || name.starts_with("diff.minus.") {
                Some(false)
            } else {
                None
            }
        };
        let first = tokens.iter().find(|t| !t.name().starts_with("punctuation"));
        let plus = match first {
            Some(t) => side(t.name())?,
            None if lang == DIFF && text == "+" => true,
            None if lang == DIFF && text == "-" => false,
            None => return None,
        };
        if plus { self.plus_bg.as_deref() } else { self.minus_bg.as_deref() }
    }
}
