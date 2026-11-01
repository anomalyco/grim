//! Experimental voice sessions: talk with GPT-Live (`gpt-live-1`) from the Mac app; what needs the user's work is
//! delegated to the voice session (an OpenCode session, `delegate`) and its reply spoken. The session is created through the paired OpenCode server, an OpenCode Console key or an OpenAI API
//! key (`auth`), and runs over WebRTC
//! (`rtc`: str0m on one UDP socket, Opus at 48 kHz, events on the negotiated data channel 4). The microphone and the
//! speaker are one AVAudioEngine with voice processing (`audio`), so the model doesn't hear itself.
//!
//! The session lives on its own thread (`session`); the UI hears from it through `remote::Handle::update` and talks to
//! it through `session::Control` (a channel plus the thread's mio `Waker`). The header's mic button (`ui`) starts and
//! ends it; the voice bar under the header shows its status, captions, Mute and End.

pub mod audio;
pub mod auth;
pub mod delegate;
pub mod events;
pub mod loopback;
pub mod opus;
pub mod rtc;
pub mod selftest;
pub mod session;
pub mod ui;

use std::time::Duration;

use rune::Tx;

use crate::App;
use crate::dialogs::{Dialog, Prompt, PromptKind};
pub use auth::Via;
use session::{Cmd, Control, Ev};

/// What the voice session is doing, as the UI shows it.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum State {
    #[default]
    Idle,
    /// Asking for the microphone, creating the session, connecting (the step, for the status line).
    Connecting(String),
    Live { muted: bool, user_level: u8, agent_speaking: bool },
    /// `session.close` sent; waiting (up to 10 s) for `session.closed`.
    Ending,
    Ended,
    Failed(String),
}

impl State {
    /// A session is under way (the mic button ends it).
    pub fn active(&self) -> bool {
        matches!(self, State::Connecting(_) | State::Live { .. } | State::Ending)
    }
}

#[derive(Default)]
pub struct Voice {
    pub state: State,
    pub ctl: Option<Control>,
    /// This session (events from an older one are dropped).
    pub epoch: u64,
    /// The live captions: the latest of what you said and of what the voice said (`session.*_transcript.delta`).
    pub you: String,
    pub agent: String,
    /// Who spoke last (the caption shown).
    pub agent_last: bool,
    /// The key prompt was opened by Start: the session starts once the key is saved.
    pub start_after_key: bool,
    /// A delegation is running in this OpenCode session (its title).
    pub working: Option<String>,
}

/// The captions keep about this many characters (the bar shows the end).
const CAPTION_KEEP: usize = 240;

impl App {
    /// Start a voice session through the chosen connection (the paired OpenCode server when there is one, unless
    /// another was picked); a key connection without its key asks for it first.
    pub fn voice_start(&mut self, tx: &mut Tx) {
        if self.voice.state.active() {
            return;
        }
        let paired = crate::opencode::load(&self.tokens);
        let client = paired.clone().map(crate::opencode::Client::new);
        let via = auth::current(paired.is_some());
        let endpoint = match (via, paired) {
            (Via::Server, Some(p)) => Ok(auth::server_endpoint(&p)),
            _ => match auth::key(via) {
                Some(key) => auth::endpoint(via, key),
                None => {
                    self.voice.start_after_key = true;
                    self.voice_ask_key(via);
                    return;
                }
            },
        };
        let endpoint = match endpoint {
            Ok(e) => e,
            Err(e) => {
                self.voice.state = State::Failed(e);
                return;
            }
        };
        let crate::remote::Backend::Net(handle) = &self.backend else {
            self.voice.state = State::Failed("Voice sessions need the app window.".into());
            return;
        };
        let handle = handle.clone();
        self.voice.epoch += 1;
        let epoch = self.voice.epoch;
        self.voice.you.clear();
        self.voice.agent.clear();
        self.voice.working = None;
        self.voice.state = State::Connecting("Starting…".into());
        let sink: session::Sink = std::sync::Arc::new(move |ev: Ev| {
            if let Ev::Log(line) = &ev {
                eprintln!("grim voice: {line}");
                return;
            }
            handle.update(move |app, _| app.voice_event(epoch, ev));
        });
        match session::spawn(session::Opts::app(endpoint, client), sink) {
            Ok(ctl) => self.voice.ctl = Some(ctl),
            Err(e) => self.voice.state = State::Failed(e),
        }
        tx.instant();
    }

    /// Ask the session to end (`session.close`, then up to 10 s for `session.closed`).
    pub fn voice_end(&mut self) {
        match &self.voice.state {
            State::Connecting(_) | State::Live { .. } => {
                if let Some(c) = &self.voice.ctl {
                    c.send(Cmd::End);
                }
                self.voice.state = State::Ending;
            }
            State::Ended | State::Failed(_) => self.voice_dismiss(),
            _ => {}
        }
    }

    pub fn voice_toggle_mute(&mut self) {
        if let State::Live { muted, .. } = &mut self.voice.state {
            *muted = !*muted;
            if let Some(c) = &self.voice.ctl {
                c.send(Cmd::Mute(*muted));
            }
        }
    }

    /// The ended or failed bar goes.
    pub fn voice_dismiss(&mut self) {
        if !self.voice.state.active() {
            self.voice.state = State::Idle;
            self.voice.ctl = None;
        }
    }

    /// The app is quitting: end the session politely (a short wait, so usage settles).
    pub fn voice_quit(&mut self) {
        if let Some(c) = self.voice.ctl.take() {
            c.send(Cmd::End);
            c.wait_done(Duration::from_millis(1500));
        }
    }

    /// An event from session `epoch`'s thread.
    pub fn voice_event(&mut self, epoch: u64, ev: Ev) {
        if epoch != self.voice.epoch {
            return;
        }
        match ev {
            Ev::Log(_) => {}
            Ev::Stage(s) => {
                if matches!(self.voice.state, State::Connecting(_)) {
                    self.voice.state = State::Connecting(s);
                }
            }
            Ev::Live => {
                if !matches!(self.voice.state, State::Ending) {
                    self.voice.state = State::Live { muted: false, user_level: 0, agent_speaking: false };
                }
            }
            Ev::Muted(m) => {
                if let State::Live { muted, .. } = &mut self.voice.state {
                    *muted = m;
                }
            }
            Ev::Level { user, speaking } => {
                if let State::Live { user_level, agent_speaking, .. } = &mut self.voice.state {
                    *user_level = user;
                    *agent_speaking = speaking;
                }
            }
            Ev::You(d) => {
                if self.voice.agent_last {
                    self.voice.you.clear();
                }
                self.voice.agent_last = false;
                push_caption(&mut self.voice.you, &d);
            }
            Ev::Agent(d) => {
                if !self.voice.agent_last {
                    self.voice.agent.clear();
                }
                self.voice.agent_last = true;
                push_caption(&mut self.voice.agent, &d);
            }
            Ev::Working(w) => self.voice.working = w,
            Ev::Ending => self.voice.state = State::Ending,
            Ev::Ended => {
                self.voice.state = State::Ended;
                self.voice.ctl = None;
                // the "Ended" bar goes by itself
                if let crate::remote::Backend::Net(h) = &self.backend {
                    let h = h.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(4));
                        h.update(move |app, _| {
                            if app.voice.epoch == epoch && app.voice.state == State::Ended {
                                app.voice.state = State::Idle;
                            }
                        });
                    });
                }
            }
            Ev::Failed(msg) => {
                self.voice.state = State::Failed(msg);
                self.voice.ctl = None;
            }
        }
    }

    /// The prompt for `via`'s key (saved in the Keychain).
    pub fn voice_ask_key(&mut self, via: Via) {
        let (title, label, hint, placeholder) = match via {
            Via::OpenAi => ("OpenAI API key", "API key", "For experimental voice sessions with GPT-Live. Saved in your Keychain.", "sk-…"),
            _ => ("OpenCode Console key", "API key", "For experimental voice sessions with GPT-Live, through OpenCode Console (opencode.ai). Saved in your Keychain.", "Paste your Console API key"),
        };
        self.dialog = Some(Dialog::Prompt(Box::new(Prompt::new(PromptKind::VoiceKey(via), title, label, "", "Save").hint(hint).placeholder(placeholder))));
    }

    /// The key prompt's Save.
    pub fn voice_key_entered(&mut self, via: Via, key: &str, tx: &mut Tx) {
        if let Err(e) = auth::save_key(via, key) {
            self.show_error(format!("Couldn't save the key: {e}"));
            return;
        }
        if std::mem::take(&mut self.voice.start_after_key) {
            self.voice_start(tx);
        } else if auth::current(crate::opencode::load(&self.tokens).is_some()) == via {
            self.show_toast(format!("{} saved", via.label()));
        } else {
            self.show_toast(format!("{} saved; choose it under Connect via to use it", via.label()));
        }
    }
}

fn push_caption(s: &mut String, delta: &str) {
    s.push_str(delta);
    let n = s.chars().count();
    if n > CAPTION_KEEP {
        let cut = s.char_indices().nth(n - CAPTION_KEEP).map_or(0, |(i, _)| i);
        s.replace_range(..cut, "");
    }
}
