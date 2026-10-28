//! Other people's name labels on their carets, as the web's `cursors.ts`: a label shows for 2 s after its cursor
//! last moved, and while the pointer is within 5 pt of the caret; then it fades out.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use rune::{Live, Tx};

use crate::App;

/// How long a label stays after its cursor last moved (the web's `LABEL_MS`).
pub const LABEL_FOR: Duration = Duration::from_millis(2000);
/// How far from a caret (each side) the pointer counts as over it (the web's `HOVER_PX`).
pub const HOVER: f32 = 5.0;

pub struct Label {
    /// The cursor as published: a change is a move.
    key: String,
    /// When it last moved.
    at: Instant,
    /// Bumped on each move: a hide scheduled before it does nothing.
    pub(crate) generation: u64,
    pub alpha: Live<f32>,
}

#[derive(Default)]
pub struct Labels {
    pub by_client: HashMap<u64, Label>,
    /// The caret the pointer is over.
    pub hover: Option<u64>,
}

impl App {
    /// Note who moved since last time: their label shows, and fades 2 s later (headless runs keep it).
    pub fn track_cursors(&mut self) {
        let cursors = self.remote_carets();
        let now = Instant::now();
        let live: Vec<u64> = cursors.iter().map(|(c, _, _)| c.client).collect();
        self.labels.by_client.retain(|k, _| live.contains(k));
        for (c, _, _) in cursors {
            let l = self.labels.by_client.entry(c.client).or_insert_with(|| Label { key: String::new(), at: now, generation: 0, alpha: Live::new(1.0) });
            if l.key == c.key {
                continue;
            }
            l.key = c.key.clone();
            l.at = now;
            l.generation += 1;
            l.alpha.set(1.0);
            let (client, generation) = (c.client, l.generation);
            if let crate::remote::Backend::Net(h) = &self.backend
                && !self.headless
            {
                let h = h.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(LABEL_FOR + Duration::from_millis(20));
                    h.update(move |app, _| app.hide_label(client, generation, Instant::now()));
                });
            }
        }
    }

    /// The time is up for `client`'s label (unless it moved again meanwhile, or the pointer is on its caret).
    pub fn hide_label(&mut self, client: u64, generation: u64, now: Instant) {
        let hovered = self.labels.hover == Some(client);
        if let Some(l) = self.labels.by_client.get(&client)
            && l.generation == generation
            && !hovered
            && now.duration_since(l.at) >= LABEL_FOR
        {
            l.alpha.set(0.0);
        }
    }

    /// The pointer came onto (or left) `client`'s caret: its label shows while it's there.
    pub fn hover_caret(&mut self, client: u64, inside: bool, _tx: &mut Tx) {
        if inside {
            self.labels.hover = Some(client);
            if let Some(l) = self.labels.by_client.get(&client) {
                l.alpha.set(1.0);
            }
        } else if self.labels.hover == Some(client) {
            self.labels.hover = None;
            let generation = self.labels.by_client.get(&client).map(|l| l.generation);
            if let Some(g) = generation {
                self.hide_label(client, g, Instant::now());
            }
        }
    }

    /// `client`'s label opacity (full until it's tracked).
    pub fn label_alpha(&self, client: u64) -> Option<Live<f32>> {
        self.labels.by_client.get(&client).map(|l| l.alpha.clone())
    }
}
