//! The voice session's controls: the header's mic button (left of the ⋯; its menu starts or ends a session and picks
//! "Connect via"), and the voice bar under the header while a session runs (status, captions, Mute, End).

use rune::{Cursor, Drag, El, Phase, PopupItem, PopupMenu, Shape, TextStyle, Tx, el, row, text};

use super::State;
use super::auth::{self, Via};
use crate::App;
use crate::theme::*;

const GREEN: &str = "#34c759";
const AMBER: &str = "#f5c542";
const RED_DOT: &str = "#ff453a";

/// A microphone glyph (capsule, cradle, stem) in `ink`, 14 × 16.
fn mic_glyph(key: &str, ink: rune::Color) -> El {
    let capsule: Vec<[f32; 2]> = {
        let mut p = Vec::new();
        for i in 0..=12 {
            let a = std::f32::consts::PI * i as f32 / 12.0;
            p.push([7.0 - 2.6 * a.cos(), 3.6 - 2.6 * a.sin()]);
        }
        for i in 0..=12 {
            let a = std::f32::consts::PI * i as f32 / 12.0;
            p.push([7.0 + 2.6 * a.cos(), 7.4 + 2.6 * a.sin()]);
        }
        p.push(p[0]);
        p
    };
    let cradle: Vec<[f32; 2]> = (0..=14)
        .map(|i| {
            let a = std::f32::consts::PI * i as f32 / 14.0;
            [7.0 - 5.0 * a.cos(), 7.6 + 4.6 * a.sin()]
        })
        .collect();
    el().key(key.to_string()).size(14.0, 16.0).shape(
        Shape::new().stroke(capsule, 1.4, ink).stroke(cradle, 1.4, ink).stroke(vec![[7.0, 12.2], [7.0, 14.6]], 1.4, ink).stroke(vec![[4.6, 14.8], [9.4, 14.8]], 1.4, ink),
    )
}

/// The header's mic button: a 30 pt square like the ⋯; green dot while a session is live.
pub fn mic_button(app: &App) -> El {
    let st = &app.voice.state;
    let active = st.active();
    let mut b = row()
        .key("voice-mic")
        .label(if active { "Voice session (Experimental)" } else { "Start a voice session (Experimental)" })
        .help(if active { "Voice session (Experimental)" } else { "Talk with GPT-Live (Experimental)" })
        .size(30.0, 30.0)
        .radius(6.0)
        .center()
        .cursor(Cursor::Pointer)
        .child(mic_glyph("voice-mic-glyph", c(INK)))
        .on_drag(|app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                app.voice_menu(tx);
                app.handled(tx);
            }
        });
    if active {
        let dot = match st {
            State::Live { muted: true, .. } => AMBER,
            State::Live { .. } => GREEN,
            _ => AMBER,
        };
        b = b.child(el().key("voice-mic-dot").absolute(21.0, 5.0).size(6.0, 6.0).radius(3.0).fill(c(dot)));
        b.fill(c(TINT_ACTIVE)).hover(c(TINT_ACTIVE))
    } else {
        b.hover(c(PAPER_2))
    }
}

/// The mic's menu: Start or End (and Mute) a session, then Connect via and the keys.
pub fn menu(app: &App) -> PopupMenu {
    let st = &app.voice.state;
    let via = auth::load_via();
    let mut m = PopupMenu::new().item(PopupItem::new("title", "Voice (Experimental)").enabled(false));
    if st.active() {
        if let State::Live { muted, .. } = st {
            m = m.item(PopupItem::new("mute", if *muted { "Unmute Microphone" } else { "Mute Microphone" }).symbol(if *muted { "mic" } else { "mic.slash" }));
        }
        m = m.item(PopupItem::new("end", "End Voice Session").symbol("phone.down"));
    } else {
        m = m.item(PopupItem::new("start", "Start Voice Session").symbol("mic"));
    }
    m = m.separator().item(PopupItem::new("via-title", "Connect via").enabled(false));
    let paired = crate::opencode::load(&app.tokens);
    for v in Via::ALL {
        let title = match (v, &paired) {
            (Via::Server, Some(p)) => format!("{} ({})", v.label(), p.host()),
            (Via::Server, None) => format!("{} (not paired)", v.label()),
            _ => v.label().to_string(),
        };
        m = m.item(PopupItem::new(format!("via-{}", v.id()), title).checked(v == via).enabled(!st.active() && (v != Via::Server || paired.is_some() || via == Via::Server)));
    }
    m = m.separator();
    for v in [Via::Console, Via::OpenAi] {
        let has = auth::key(v).is_some();
        let what = match v {
            Via::Console => "OpenCode Console Key",
            _ => "OpenAI API Key",
        };
        m = m.item(PopupItem::new(format!("key-{}", v.id()), format!("{} {what}…", if has { "Change" } else { "Set" })));
        if has {
            m = m.item(PopupItem::new(format!("forget-{}", v.id()), format!("Remove {what}")));
        }
    }
    m
}

impl App {
    pub fn voice_menu(&mut self, tx: &mut Tx) {
        tx.popup_menu(menu(self), "voice-mic", move |app: &mut App, picked, tx| {
            match picked {
                Some("start") => app.voice_start(tx),
                Some("end") => app.voice_end(),
                Some("mute") => app.voice_toggle_mute(),
                Some(p) if p.starts_with("via-") => {
                    if let Some(v) = Via::from_id(&p[4..]) {
                        auth::save_via(v);
                    }
                }
                Some(p) if p.starts_with("key-") => {
                    if let Some(v) = Via::from_id(&p[4..]) {
                        app.voice.start_after_key = false;
                        app.voice_ask_key(v);
                    }
                }
                Some(p) if p.starts_with("forget-") => {
                    if let Some(v) = Via::from_id(&p[7..]) {
                        auth::remove_key(v);
                        app.show_toast(format!("{} key removed", v.label()));
                    }
                }
                _ => {}
            }
            app.handled(tx);
        });
    }
}

fn small_button(label: &str, key: &str, f: fn(&mut App, &mut Tx)) -> El {
    row()
        .key(key.to_string())
        .label(label.to_string())
        .px(9.0)
        .py(4.0)
        .radius(6.0)
        .fill(c(PAPER).alpha(0.14))
        .hover(c(PAPER).alpha(0.24))
        .cursor(Cursor::Pointer)
        .child(text(label.to_string()).key(format!("{key}-text")).font(TextStyle::new(12.5, crate::theme::wt(600.0)).lh(16.0)).color(c(PAPER)))
        .on_drag(move |app: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase == Phase::Down {
                f(app, tx);
                app.handled(tx);
            }
        })
}

/// The voice bar: an ink pill at the top right of the page, under the header, while there is a session to show.
pub fn bar(app: &App, x0: f32, w: f32, top: f32) -> Option<El> {
    let st = &app.voice.state;
    if *st == State::Idle {
        return None;
    }
    let (dot, status) = match st {
        State::Idle => return None,
        State::Connecting(s) => (AMBER, s.clone()),
        State::Live { muted: true, .. } => (AMBER, "Muted".to_string()),
        State::Live { agent_speaking: true, .. } => (GREEN, "Speaking".to_string()),
        State::Live { .. } => (GREEN, "Listening".to_string()),
        State::Ending => (AMBER, "Ending…".to_string()),
        State::Ended => (MUTED, "Voice session ended".to_string()),
        State::Failed(e) => (RED_DOT, e.clone()),
    };
    let max_w = (w - 32.0).clamp(200.0, 460.0);
    let style = TextStyle::new(13.0, crate::theme::wt(550.0)).lh(18.0);
    let mut head = row().key("voice-bar-head").gap(8.0).center_y().child(el().key("voice-bar-dot").size(7.0, 7.0).radius(3.5).fill(c(dot)));
    // the microphone's level, five short bars
    if let State::Live { muted: false, user_level, .. } = st {
        let mut lv = row().key("voice-level").gap(2.0).center_y().h(12.0);
        for i in 0..5u8 {
            let on = i < *user_level;
            lv = lv.child(el().key(format!("voice-level{i}")).size(2.5, 4.0 + i as f32 * 2.0).radius(1.0).fill(c(PAPER).alpha(if on { 0.9 } else { 0.25 })));
        }
        head = head.child(lv);
    }
    let failed = matches!(st, State::Failed(_));
    let status_el = text(status.clone()).key("voice-bar-status").font(style).color(c(PAPER));
    let (tw, _) = crate::layout::measure(&status, style);
    let room = max_w - 200.0;
    head = head.child(if tw > room { status_el.w(room).wrap() } else { status_el });
    head = head.child(el().key("voice-bar-gap").grow(1.0));
    head = head.child(text("Experimental").key("voice-bar-exp").font(TextStyle::new(11.0, 400.0).lh(14.0)).color(c(PAPER).alpha(0.55)));
    match st {
        State::Live { muted, .. } => {
            head = head.child(small_button(if *muted { "Unmute" } else { "Mute" }, "voice-mute", |app, _| app.voice_toggle_mute()));
            head = head.child(small_button("End", "voice-end", |app, _| app.voice_end()));
        }
        State::Connecting(_) => head = head.child(small_button("Cancel", "voice-end", |app, _| app.voice_end())),
        State::Failed(_) => {
            head = head.child(small_button("Try again", "voice-retry", |app, tx| {
                app.voice_dismiss();
                app.voice_start(tx);
            }));
            head = head.child(small_button("Close", "voice-close", |app, _| app.voice_dismiss()));
        }
        State::Ended => head = head.child(small_button("Close", "voice-close", |app, _| app.voice_dismiss())),
        _ => {}
    }
    let mut pill = rune::col().key("voice-bar").label(format!("Voice: {status}")).w(max_w).px(14.0).py(10.0).gap(6.0).radius(10.0).fill(c(INK)).shadow(16.0, 40.0, c("#18181b").alpha(0.18)).child(head);
    // the live caption: the latest speaker's words, the end that fits on two lines
    if !failed && matches!(st, State::Live { .. } | State::Ending) {
        let (who, words) = if app.voice.agent_last { ("Voice", &app.voice.agent) } else { ("You", &app.voice.you) };
        let words = words.trim();
        if !words.is_empty() {
            let cap = TextStyle::new(12.5, 400.0).lh(17.0);
            let shown: String = {
                let n = words.chars().count();
                let keep = 110;
                if n > keep { format!("…{}", words.chars().skip(n - keep).collect::<String>()) } else { words.to_string() }
            };
            pill = pill.child(text(format!("{who}: {shown}")).key("voice-caption").font(cap).color(c(PAPER).alpha(0.8)).w(max_w - 28.0).wrap());
        }
    }
    Some(row().key("voice-bar-wrap").absolute(x0 + w - max_w - 16.0, top + 8.0).child(pill))
}

/// `--voice-demo=<state>` (headless snapshots): the bar in a state, with made-up captions.
pub fn demo(app: &mut App, state: &str) {
    app.voice.state = match state {
        "connecting" => State::Connecting("Connecting…".into()),
        "muted" => State::Live { muted: true, user_level: 0, agent_speaking: false },
        "speaking" => State::Live { muted: false, user_level: 1, agent_speaking: true },
        "ending" => State::Ending,
        "ended" => State::Ended,
        "failed" => State::Failed("The connection dropped.".into()),
        _ => State::Live { muted: false, user_level: 3, agent_speaking: false },
    };
    app.voice.you = "What should I call the new folder for the launch notes?".into();
    app.voice.agent = "Something short like Launch works well, and you can add dates inside it later.".into();
    app.voice.agent_last = state == "speaking";
}
