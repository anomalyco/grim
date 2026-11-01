//! `grim --voice-selftest[=console|openai]`: a whole voice session without a window, microphone or speaker. It makes
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
    let speech = match speech() {
        Ok(s) => s,
        Err(e) => {
            say(&format!("no speech ({e}); sending silence"));
            vec![0.0; opus::RATE as usize]
        }
    };
    say(&format!("speech ready: {:.1} s at 48 kHz", speech.len() as f32 / opus::RATE as f32));

    let (tx, rx) = channel::<Ev>();
    let tx = Mutex::new(tx);
    let sink: session::Sink = Arc::new(move |ev| {
        let _ = tx.lock().unwrap().send(ev);
    });
    let opts = Opts { endpoint, instructions: session::INSTRUCTIONS.into(), voice: session::VOICE.into(), audio: AudioKind::Fed };
    let ctl = match session::spawn(opts, sink) {
        Ok(c) => c,
        Err(e) => {
            say(&e);
            return 1;
        }
    };
    let pipes = ctl.pipes.clone();
    let (mut live, mut closed_ok, mut failed) = (false, false, None::<String>);
    let (mut you, mut agent) = (String::new(), String::new());
    let mut last_agent: Option<Instant> = None;
    let mut fed = 0usize;
    let mut feed_clock: Option<Instant> = None;
    let mut asked_close = false;
    let deadline = Instant::now() + Duration::from_secs(70);
    loop {
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ev::Log(l)) => say(&l),
            Ok(Ev::Stage(s)) => say(&format!("stage: {s}")),
            Ok(Ev::Live) => {
                live = true;
                feed_clock = Some(Instant::now());
                say("LIVE: session.started; speaking the question");
            }
            Ok(Ev::You(d)) => you.push_str(&d),
            Ok(Ev::Agent(d)) => {
                agent.push_str(&d);
                last_agent = Some(Instant::now());
            }
            Ok(Ev::Muted(m)) => say(&format!("muted: {m}")),
            Ok(Ev::Level { .. }) | Ok(Ev::Ending) => {}
            Ok(Ev::Ended) => {
                closed_ok = true;
                break;
            }
            Ok(Ev::Failed(e)) => {
                failed = Some(e);
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
        let answered = last_agent.is_some_and(|t| t.elapsed() > Duration::from_secs(3));
        let waited = feed_clock.is_some_and(|t| t.elapsed() > Duration::from_secs(30));
        if live && !asked_close && (answered || waited) {
            say(&format!("you (transcribed): {:?}", you.trim()));
            say(&format!("voice (transcript): {:?}", agent.trim()));
            say("ending: session.close");
            ctl.send(Cmd::End);
            asked_close = true;
        }
        if Instant::now() > deadline {
            failed = Some("selftest timed out".into());
            break;
        }
    }
    let sent = pipes.frames_sent.load(Ordering::Relaxed);
    let got = pipes.packets_received.load(Ordering::Relaxed);
    say(&format!("RTP: {sent} Opus frames sent, {got} packets received"));
    match failed {
        Some(e) => {
            say(&format!("RESULT: failed: {e}"));
            if have_key { 1 } else { 2 }
        }
        None if closed_ok && live => {
            say("RESULT: ok: offer, POST, ICE/DTLS/SCTP, data channel 4, session.started, audio both ways, session.close -> closed");
            0
        }
        None => {
            say("RESULT: ended before the session started");
            1
        }
    }
}

/// The question as 48 kHz mono samples, spoken by `say`.
fn speech() -> Result<Vec<f32>, String> {
    let path = std::env::temp_dir().join(format!("grim-voice-selftest-{}.wav", std::process::id()));
    let st = std::process::Command::new("/usr/bin/say")
        .args(["-o"])
        .arg(&path)
        .args(["--file-format=WAVE", "--data-format=LEI16@48000", QUESTION])
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
