//! Recently seen notes' text, in memory (the web's `NoteCache`): what a note had when it was last open here, when it
//! synced, or what a prefetch got. Opening a note shows it at once, read-only, until the live editor has synced and
//! takes over (its text wins). At most `MAX` notes and `MAX_CHARS` characters in all, least recently used out first.

use std::collections::VecDeque;

pub const MAX: usize = 100;
pub const MAX_CHARS: usize = 8_000_000;

/// A note's key: server, workspace and path.
pub fn key(server: &str, id: &str, path: &str) -> String {
    format!("{server}\u{0}{id}\u{0}{path}")
}

#[derive(Default)]
pub struct NoteCache {
    /// (key, text), most recently used last.
    notes: VecDeque<(String, String)>,
    chars: usize,
}

impl NoteCache {
    pub fn get(&mut self, key: &str) -> Option<String> {
        let i = self.notes.iter().position(|n| n.0 == key)?;
        let n = self.notes.remove(i)?;
        let text = n.1.clone();
        self.notes.push_back(n);
        Some(text)
    }

    pub fn put(&mut self, key: &str, text: &str) {
        self.forget(key);
        let len = text.chars().count();
        if len > MAX_CHARS {
            return;
        }
        self.notes.push_back((key.to_string(), text.to_string()));
        self.chars += len;
        while self.notes.len() > MAX || self.chars > MAX_CHARS {
            let Some(old) = self.notes.pop_front() else { break };
            self.chars -= old.1.chars().count();
        }
    }

    pub fn forget(&mut self, key: &str) {
        if let Some(i) = self.notes.iter().position(|n| n.0 == key)
            && let Some(old) = self.notes.remove(i)
        {
            self.chars -= old.1.chars().count();
        }
    }

    pub fn len(&self) -> usize {
        self.notes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn least_recently_used_out_past_max_notes_or_chars() {
        let mut c = NoteCache::default();
        for i in 0..MAX + 5 {
            c.put(&format!("n{i}"), "x");
        }
        assert_eq!(c.len(), MAX);
        assert_eq!(c.get("n0"), None);
        // a get makes it recent
        assert_eq!(c.get("n5").as_deref(), Some("x"));
        c.put("big", &"y".repeat(MAX_CHARS - 50));
        assert!(c.get("n5").is_some(), "the most recent small ones stay");
        assert!(c.get("n6").is_none(), "older ones went for the characters");
        c.put("too big", &"z".repeat(MAX_CHARS + 1));
        assert_eq!(c.get("too big"), None);
        c.put("n5", "new");
        assert_eq!(c.get("n5").as_deref(), Some("new"));
        c.forget("n5");
        assert_eq!(c.get("n5"), None);
    }
}
