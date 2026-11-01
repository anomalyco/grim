//! `grim --voice-selftest[=console|openai|server|loopback] [--delegate]`: a whole voice session without a window, microphone or speaker. It makes
//! the WebRTC offer, `POST`s it, connects ICE, DTLS and SCTP, waits for `session.started` on data channel 4, speaks a
//! question synthesized with `say` (48 kHz, Opus over RTP), listens for the transcripts and the voice's audio, then
//! sends `session.close` and waits for `session.closed`. The key comes from `GRIM_VOICE_KEY`, else `OPENAI_API_KEY`
//! (openai), else the Keychain; it's never printed. Without one it still `POST`s (a refusal proves the request).

use std::sync::atomic::Ordering;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::auth::{self, Via};
use super::opus;
use super::session::{self, AudioKind, Cmd, Ev, Opts};

const QUESTION: &str = "Hi there! In one short sentence, what is the capital of France?";

pub fn run(args: &[String]) -> i32 {
    let which = args.iter().find_map(|a| a.strip_prefix("--voice-selftest=")).unwrap_or("console");
    let loopback = which == "loopback";
    let via = Via::from_id(which).unwrap_or(if loopback { Via::OpenAi } else { Via::Console });
    let key = std::env::var("GRIM_VOICE_KEY")
        .ok()
        .or_else(|| (via == Via::OpenAi).then(|| std::env::var("OPENAI_API_KEY").ok()).flatten())
        .filter(|k| !k.trim().is_empty())
        .or_else(|| auth::key(via));
    let key = if loopback { Some("loopback".to_string()) } else if via == Via::Server { std::env::var("GRIM_VOICE_SERVER_PASSWORD").ok() } else { key };
    let have_key = key.is_some();
    let t0 = Instant::now();
    let say = move |s: &str| eprintln!("[{:6.2}s] {s}", t0.elapsed().as_secs_f32());
    let label = if loopback { "the loopback stand-in on this Mac" } else { via.label() };
    let have_key = have_key || via == Via::Server;
    say(&format!("voice selftest via {label} ({})", if have_key { "with a key" } else { "WITHOUT a key: expecting a refusal" }));
    let arg = |name: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_string));
    let endpoint = if via == Via::Server {
        // `--voice-server=<url>`; its password in GRIM_VOICE_SERVER_PASSWORD (never printed)
        let Some(url) = arg("voice-server").and_then(|u| crate::opencode::server_address(&u)) else {
            say("--voice-selftest=server needs --voice-server=<OpenCode server URL>");
            return 2;
        };
        Ok(auth::server_endpoint(&crate::opencode::Pairing { url, password: std::env::var("GRIM_VOICE_SERVER_PASSWORD").unwrap_or_default() }))
    } else {
        auth::endpoint(via, key.clone().unwrap_or_else(|| "invalid-selftest-key".into()))
    };
    let endpoint = match endpoint {
        Ok(mut e) if loopback => match super::rtc::local_ip().ok_or("no local address".to_string()).and_then(super::loopback::start) {
            Ok(url) => {
                e.url = url;
                e
            }
            Err(err) => {
                say(&err);
                return 1;
            }
        },
        Ok(e) => e,
        Err(e) => {
            say(&e);
            return 1;
        }
    };
    if args.iter().any(|a| a == "--delegate") {
        return delegate_test(args, endpoint, &say);
    }
    let speech = match speech(QUESTION) {
        Ok(s) => s,
        Err(e) => {
            say(&format!("no speech ({e}); sending silence"));
            vec![0.0; opus::RATE as usize]
        }
    };
    say(&format!("speech ready: {:.1} s at 48 kHz", speech.len() as f32 / opus::RATE as f32));
    let r = call(endpoint, super::delegate::instructions(None), None, &speech, false, &say);
    say(&format!("RTP: {} Opus frames sent, {} packets received", r.sent, r.got));
    match r.failed {
        Some(e) => {
            say(&format!("RESULT: failed: {e}"));
            if have_key { 1 } else { 2 }
        }
        None if r.closed_ok && r.live => {
            say("RESULT: ok: offer, POST, ICE/DTLS/SCTP, data channel 4, session.started, audio both ways, session.close -> closed");
            0
        }
        None => {
            say("RESULT: ended before the session started");
            1
        }
    }
}

struct CallResult {
    live: bool,
    closed_ok: bool,
    failed: Option<String>,
    you: String,
    agent: String,
    /// The voice's words after the first spoken result went out.
    agent_after: String,
    logs: Vec<String>,
    sent: u64,
    got: u64,
}

/// One session: speak `speech` once live, then listen; ends 3 s after the voice answers (with `delegated`, after it
/// speaks a delegation's result), or after 30 s of nothing.
fn call(endpoint: auth::Endpoint, instructions: String, client: Option<crate::opencode::Client>, speech: &[f32], delegated: bool, say: &dyn Fn(&str)) -> CallResult {
    let (tx, rx) = channel::<Ev>();
    let tx = Mutex::new(tx);
    let sink: session::Sink = Arc::new(move |ev| {
        let _ = tx.lock().unwrap().send(ev);
    });
    let opts = Opts { endpoint, instructions, voice: session::VOICE.into(), audio: AudioKind::Fed, client };
    let mut r = CallResult { live: false, closed_ok: false, failed: None, you: String::new(), agent: String::new(), agent_after: String::new(), logs: Vec::new(), sent: 0, got: 0 };
    let ctl = match session::spawn(opts, sink) {
        Ok(c) => c,
        Err(e) => {
            r.failed = Some(e);
            return r;
        }
    };
    let pipes = ctl.pipes.clone();
    let mut last_agent: Option<Instant> = None;
    let mut fed = 0usize;
    let mut feed_clock: Option<Instant> = None;
    let mut asked_close = false;
    let mut commentary: Option<Instant> = None;
    let mut delegation_seen = false;
    let deadline = Instant::now() + Duration::from_secs(if delegated { 400 } else { 70 });
    loop {
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ev::Log(l)) => {
                say(&l);
                if l.starts_with("session.delegation.created") {
                    delegation_seen = true;
                }
                if l.starts_with("COMMENTARY") && commentary.is_none() {
                    commentary = Some(Instant::now());
                }
                r.logs.push(l);
            }
            Ok(Ev::Stage(s)) => say(&format!("stage: {s}")),
            Ok(Ev::Live) => {
                r.live = true;
                feed_clock = Some(Instant::now());
                say("LIVE: session.started; speaking the question");
            }
            Ok(Ev::You(d)) => r.you.push_str(&d),
            Ok(Ev::Agent(d)) => {
                r.agent.push_str(&d);
                if commentary.is_some() {
                    r.agent_after.push_str(&d);
                }
                last_agent = Some(Instant::now());
            }
            Ok(Ev::Working(w)) => say(&format!("voice bar: {}", w.map_or("(not working)".into(), |t| format!("Working in {t}…")))),
            Ok(Ev::Muted(m)) => say(&format!("muted: {m}")),
            Ok(Ev::Level { .. }) | Ok(Ev::Ending) => {}
            Ok(Ev::Ended) => {
                r.closed_ok = true;
                break;
            }
            Ok(Ev::Failed(e)) => {
                r.failed = Some(e);
                break;
            }
            Err(_) => {}
        }
        // the question in real time, then silence
        if let Some(t) = feed_clock {
            let due = (t.elapsed().as_secs_f64() * opus::RATE as f64) as usize;
            if due > fed {
                let mut chunk = vec![0.0f32; due - fed];
                for (i, s) in chunk.iter_mut().enumerate() {
                    *s = speech.get(fed + i).copied().unwrap_or(0.0);
                }
                pipes.push_mic(&chunk, opus::RATE as f64);
                fed = due;
            }
            // nobody plays the voice here: its samples are counted and dropped
            pipes.spk.lock().unwrap().clear();
        }
        let quiet = |s: u64| last_agent.is_some_and(|t| t.elapsed() > Duration::from_secs(s));
        let done = if delegated {
            // the result said (or nothing delegated in 40 s)
            commentary.is_some_and(|c| c.elapsed() > Duration::from_secs(4)) && quiet(4) && !r.agent_after.trim().is_empty() || (!delegation_seen && feed_clock.is_some_and(|t| t.elapsed() > Duration::from_secs(40)))
        } else {
            quiet(3) || feed_clock.is_some_and(|t| t.elapsed() > Duration::from_secs(30))
        };
        if r.live && !asked_close && done {
            say(&format!("you (transcribed): {:?}", r.you.trim()));
            say(&format!("voice (transcript): {:?}", r.agent.trim()));
            say("ending: session.close");
            ctl.send(Cmd::End);
            asked_close = true;
        }
        if Instant::now() > deadline {
            r.failed = Some("selftest timed out".into());
            break;
        }
    }
    r.sent = pipes.frames_sent.load(Ordering::Relaxed);
    r.got = pipes.packets_received.load(Ordering::Relaxed);
    r
}

const DELEGATE_QUESTION: &str = "Ask my coding session: what word is written in the file secret word dot T X T?";
const SECRET: &str = "marmalade";

/// `--delegate`: (1) no voice session: the delegation is answered at once, spoken; (2) a temporary session (in a
/// temporary folder with secret-word.txt) as the voice session: the request reaches it and its reply is spoken. The
/// session and folder are deleted afterwards.
fn delegate_test(args: &[String], endpoint: auth::Endpoint, say: &dyn Fn(&str)) -> i32 {
    use crate::oc_tools::{self, SessionRef};
    use crate::opencode::{Client, Pairing};
    let arg = |name: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_string));
    let Some(url) = arg("voice-server").and_then(|u| crate::opencode::server_address(&u)) else {
        say("--delegate needs --voice-server=<OpenCode server URL> (for the voice session)");
        return 2;
    };
    let client = Client::new(Pairing { url, password: std::env::var("GRIM_VOICE_SERVER_PASSWORD").unwrap_or_default() });
    let speech = match speech(DELEGATE_QUESTION) {
        Ok(s) => s,
        Err(e) => {
            say(&format!("no speech: {e}"));
            return 1;
        }
    };
    let mut ok = true;
    let mut check = |pass: bool, what: &str| {
        say(&format!("{} {what}", if pass { "CHECK ok:" } else { "CHECK FAILED:" }));
        ok &= pass;
    };
    let only = arg("delegate-only");

    // (1) no voice session (instructions as if there were one, so the voice delegates)
    if only.as_deref() != Some("session") {
        say("=== (1) no voice session ===");
        oc_tools::set_delegator(None);
        let fake = SessionRef { id: "ses_none".into(), directory: String::new(), title: "your coding session".into() };
        let r = call(endpoint.clone(), super::delegate::instructions(Some(&fake)), Some(client.clone()), &speech, true, say);
        let created = r.logs.iter().any(|l| l.starts_with("session.delegation.created"));
        let answered = r.logs.iter().any(|l| l.starts_with("COMMENTARY") && l.contains("No voice session is selected"));
        say(&format!("(1) voice after the commentary: {:?}", r.agent_after.trim()));
        check(r.failed.is_none() && r.live, &format!("(1) session ran ({:?})", r.failed));
        check(created, "(1) session.delegation.created");
        check(answered, "(1) answered at once: \"No voice session is selected…\" as session.commentary.append");
        let a = r.agent_after.to_lowercase();
        check(a.contains("session") || a.contains("pick") || a.contains("select"), "(1) the voice said so (transcript mentions picking a session)");
    }

    // (2) a temporary voice session
    if only.as_deref() != Some("none") {
        say("=== (2) a temporary voice session ===");
        let dir = std::env::temp_dir().join(format!("grim-voice-delegate-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("secret-word.txt"), format!("{SECRET}\n"));
        let dir_s = dir.canonicalize().unwrap_or(dir.clone()).to_string_lossy().to_string();
        let s = match client.create_session(Some("Grim voice delegation selftest"), Some(&dir_s)) {
            Ok(s) => s,
            Err(e) => {
                say(&format!("couldn't create the test session: {e}"));
                return 1;
            }
        };
        say(&format!("test session {} in {}", s.id, s.directory));
        let target = SessionRef::of(&s);
        oc_tools::set_delegator(Some(target.clone()));
        let r = call(endpoint, super::delegate::instructions(Some(&target)), Some(client.clone()), &speech, true, say);
        let msgs = client.messages(&s.id, 20).unwrap_or_default();
        let prompt = msgs.iter().find(|m| m.user && m.text.starts_with(super::delegate::PREFIX));
        let reply = msgs.iter().rev().find(|m| !m.user && !m.text.trim().is_empty());
        say(&format!("(2) the session got: {:?}", prompt.map(|m| m.text.as_str())));
        say(&format!("(2) the session replied: {:?}", reply.map(|m| m.text.as_str())));
        let comm = r.logs.iter().find(|l| l.starts_with("COMMENTARY") && !l.contains("Still working")).cloned();
        say(&format!("(2) commentary: {comm:?}"));
        say(&format!("(2) voice after the commentary: {:?}", r.agent_after.trim()));
        check(r.failed.is_none() && r.live, &format!("(2) session ran ({:?})", r.failed));
        check(r.logs.iter().any(|l| l.starts_with("session.delegation.created")), "(2) session.delegation.created");
        check(prompt.is_some(), "(2) the prompt reached the test session");
        check(comm.as_ref().is_some_and(|c| c.to_lowercase().contains(SECRET)), "(2) its reply went back as session.commentary.append");
        check(r.agent_after.to_lowercase().contains(SECRET), &format!("(2) the voice spoke the delegated answer ({SECRET:?} in the output transcript)"));
        oc_tools::set_delegator(None);
        match client.delete_session(&s.id) {
            Ok(()) => say("test session deleted"),
            Err(e) => say(&format!("couldn't delete the test session {}: {e}", s.id)),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    say(if ok { "RESULT: ok: delegation" } else { "RESULT: FAILED: delegation" });
    if ok { 0 } else { 1 }
}

/// The question as 48 kHz mono samples, spoken by `say`.
fn speech(text: &str) -> Result<Vec<f32>, String> {
    let path = std::env::temp_dir().join(format!("grim-voice-selftest-{}.wav", std::process::id()));
    let st = std::process::Command::new("/usr/bin/say")
        .args(["-o"])
        .arg(&path)
        .args(["--file-format=WAVE", "--data-format=LEI16@48000", text])
        .status()
        .map_err(|e| e.to_string())?;
    if !st.success() {
        return Err("say failed".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    // the WAVE's data chunk
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
        if id == b"data" {
            let data = &bytes[i + 8..(i + 8 + len).min(bytes.len())];
            return Ok(data.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect());
        }
        i += 8 + len + (len & 1);
    }
    Err("no data chunk".into())
}
