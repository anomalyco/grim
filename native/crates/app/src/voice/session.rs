//! A voice session's thread: the microphone permission, the audio engine, the WebRTC offer, the `POST` that creates
//! the session, then `rtc::Link::run` until it ends. The UI talks to it through `Control` and hears from it through
//! the `Sink`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::auth::{Endpoint, Via};
use super::opus;
use super::rtc::Link;

/// The UI's requests.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cmd {
    Mute(bool),
    End,
}

/// What the thread reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Ev {
    /// A line for the log (stderr; the self-test prints them all).
    Log(String),
    /// The connecting step, for the status line.
    Stage(String),
    /// `session.started`.
    Live,
    Muted(bool),
    /// The microphone's level (0–5) and whether the voice is playing.
    Level { user: u8, speaking: bool },
    You(String),
    Agent(String),
    Ending,
    Ended,
    Failed(String),
}

pub type Sink = Arc<dyn Fn(Ev) + Send + Sync>;

pub const INSTRUCTIONS: &str = "You are Grim's voice companion, talking with the user from the Grim notes app on their Mac. \
This is an experimental, conversation-only session: you have no tools and cannot read, change or open notes, files or apps, \
so never claim to. Be warm, natural and concise, like a thoughtful friend on a call: short spoken replies, no lists or \
markdown, and ask when something is unclear.";
pub const VOICE: &str = "marin";

pub enum AudioKind {
    /// The Mac's microphone and speaker (AVAudioEngine with voice processing).
    Device,
    /// Nothing attached: the caller feeds `Pipes::mic` and reads `Pipes::spk` (the self-test).
    Fed,
}

pub struct Opts {
    pub endpoint: Endpoint,
    pub instructions: String,
    pub voice: String,
    pub audio: AudioKind,
}

impl Opts {
    pub fn app(endpoint: Endpoint) -> Opts {
        Opts { endpoint, instructions: INSTRUCTIONS.into(), voice: VOICE.into(), audio: AudioKind::Device }
    }
}

/// Audio between the engine (or the self-test) and the session thread, all 48 kHz mono.
pub struct Pipes {
    /// Microphone samples waiting to be encoded.
    pub mic: Mutex<Vec<f32>>,
    /// The voice's samples waiting to play.
    pub spk: Mutex<VecDeque<f32>>,
    pub waker: Arc<mio::Waker>,
    pub muted: AtomicBool,
    /// The microphone's latest RMS (f32 bits).
    pub level: AtomicU32,
    pub frames_sent: AtomicU64,
    pub packets_received: AtomicU64,
    resampler: Mutex<Resampler>,
}

impl Pipes {
    fn new(waker: Arc<mio::Waker>) -> Pipes {
        Pipes {
            mic: Mutex::default(),
            spk: Mutex::default(),
            waker,
            muted: AtomicBool::new(false),
            level: AtomicU32::new(0),
            frames_sent: AtomicU64::new(0),
            packets_received: AtomicU64::new(0),
            resampler: Mutex::new(Resampler::new(opus::RATE as f64)),
        }
    }

    /// Microphone samples at `rate`; the session thread wakes once a 20 ms frame is waiting.
    pub fn push_mic(&self, samples: &[f32], rate: f64) {
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
        self.level.store(rms.to_bits(), Ordering::Relaxed);
        let ready = {
            let mut mic = self.mic.lock().unwrap();
            let mut rs = self.resampler.lock().unwrap();
            rs.set_rate(rate);
            rs.run(samples, &mut mic);
            // at most a second waits (the link isn't up yet, or the thread is behind)
            let n = mic.len();
            if n > opus::RATE as usize {
                mic.drain(..n - opus::RATE as usize);
            }
            mic.len() >= opus::FRAME
        };
        if ready {
            let _ = self.waker.wake();
        }
    }

    /// Fill `out` with the voice (silence where there's none yet).
    pub fn pull_spk(&self, out: &mut [f32]) {
        let mut spk = match self.spk.try_lock() {
            Ok(s) => s,
            Err(_) => {
                out.fill(0.0);
                return;
            }
        };
        for o in out.iter_mut() {
            *o = spk.pop_front().unwrap_or(0.0);
        }
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
}

/// Linear resampling to 48 kHz (the engine's input may run at 44.1 kHz or another rate).
struct Resampler {
    rate: f64,
    pos: f64,
    prev: f32,
}

impl Resampler {
    fn new(rate: f64) -> Resampler {
        Resampler { rate, pos: 0.0, prev: 0.0 }
    }

    fn set_rate(&mut self, rate: f64) {
        if rate != self.rate {
            *self = Resampler::new(rate);
        }
    }

    fn run(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if (self.rate - opus::RATE as f64).abs() < 0.5 {
            out.extend_from_slice(input);
            return;
        }
        let n = input.len();
        if n == 0 {
            return;
        }
        // positions in [prev, input…]; index 0 is the last chunk's final sample
        let at = |i: usize, prev: f32| if i == 0 { prev } else { input[i - 1] };
        let step = self.rate / opus::RATE as f64;
        while self.pos < n as f64 {
            let i = self.pos as usize;
            let f = (self.pos - i as f64) as f32;
            let (a, b) = (at(i, self.prev), at(i + 1, self.prev));
            out.push(a + (b - a) * f);
            self.pos += step;
        }
        self.pos -= n as f64;
        self.prev = input[n - 1];
    }
}

/// The UI's hold on the session thread.
pub struct Control {
    tx: Sender<Cmd>,
    pub pipes: Arc<Pipes>,
    done: Arc<AtomicBool>,
}

impl Control {
    pub fn send(&self, c: Cmd) {
        let _ = self.tx.send(c);
        let _ = self.pipes.waker.wake();
    }

    pub fn done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }

    /// Wait up to `limit` for the thread to finish.
    pub fn wait_done(&self, limit: Duration) {
        let t = Instant::now();
        while !self.done() && t.elapsed() < limit {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

pub fn spawn(opts: Opts, sink: Sink) -> Result<Control, String> {
    let poll = mio::Poll::new().map_err(|e| e.to_string())?;
    let waker = Arc::new(mio::Waker::new(poll.registry(), super::rtc::WAKE).map_err(|e| e.to_string())?);
    let pipes = Arc::new(Pipes::new(waker));
    let (tx, rx) = channel();
    let done = Arc::new(AtomicBool::new(false));
    let (p, d) = (pipes.clone(), done.clone());
    std::thread::Builder::new()
        .name("grim-voice".into())
        .spawn(move || {
            let r = run(opts, poll, rx, p, sink.clone());
            d.store(true, Ordering::SeqCst);
            match r {
                Ok(()) => sink(Ev::Ended),
                Err(e) => {
                    sink(Ev::Log(format!("failed: {e}")));
                    sink(Ev::Failed(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Control { tx, pipes, done })
}

fn run(opts: Opts, poll: mio::Poll, rx: Receiver<Cmd>, pipes: Arc<Pipes>, sink: Sink) -> Result<(), String> {
    let _engine = match opts.audio {
        AudioKind::Device => {
            sink(Ev::Stage("Waiting for the microphone…".into()));
            super::audio::mic_permission()?;
            let e = super::audio::Engine::start(pipes.clone())?;
            sink(Ev::Log(format!("audio engine running ({})", e.describe())));
            Some(e)
        }
        AudioKind::Fed => None,
    };
    if ended(&rx) {
        return Ok(());
    }
    sink(Ev::Stage("Connecting…".into()));
    let (mut link, pending, offer) = Link::offer(&poll)?;
    sink(Ev::Log(format!("offer created ({} bytes of SDP, host candidate {})", offer.len(), link.local)));
    let answer = create(&opts, &offer, &sink)?;
    if ended(&rx) {
        return Ok(());
    }
    link.accept(pending, &answer)?;
    sink(Ev::Log("answer accepted; connecting ICE, DTLS, SCTP".into()));
    link.run(poll, &rx, &pipes, &sink)
}

/// An End already asked for (while the permission or the `POST` waited).
fn ended(rx: &Receiver<Cmd>) -> bool {
    rx.try_iter().any(|c| c == Cmd::End)
}

/// `POST` the session with the offer; the answer's SDP. Without delegation first (just conversation); if the service
/// insists on one, again with the least it accepts (`responses`), still without tools.
fn create(opts: &Opts, offer: &str, sink: &Sink) -> Result<String, String> {
    let ep = &opts.endpoint;
    let mut tries: Vec<Option<&str>> = vec![None];
    if ep.via != Via::OpenAi {
        tries.push(Some("responses"));
    }
    let mut last = String::new();
    for (i, delegation) in tries.iter().enumerate() {
        let body = super::auth::body(ep.via, offer, &opts.instructions, &opts.voice, *delegation);
        let headers: Vec<(&str, &str)> = ep.headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let t = Instant::now();
        let r = crate::net::request_with("POST", &ep.url, ep.bearer.as_deref(), &headers, Some(&body)).map_err(|e| no_answer(ep, e))?;
        let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap_or_default();
        let mode = delegation.map_or("no delegation".to_string(), |d| format!("delegation {d}"));
        sink(Ev::Log(format!("POST {} ({mode}) -> {} in {} ms", ep.url, r.status, t.elapsed().as_millis())));
        if (200..300).contains(&r.status) {
            if let Some(id) = v["session"]["id"].as_str() {
                sink(Ev::Log(format!("session {id} created ({mode})")));
            }
            // (the OpenCode server wraps it in `data`)
            let transport = if v["data"].is_object() { &v["data"]["transport"] } else { &v["transport"] };
            return transport["sdp"].as_str().map(str::to_string).ok_or_else(|| "The voice service answered without an SDP answer.".to_string());
        }
        let msg = v["error"]["message"].as_str().or_else(|| v["data"]["message"].as_str()).map(str::to_string).or_else(|| v["message"].as_str().map(str::to_string)).unwrap_or_else(|| String::from_utf8_lossy(&r.body).chars().take(300).collect());
        sink(Ev::Log(format!("refused: {msg}")));
        last = refusal(ep.via, r.status, &msg);
        let about_delegation = msg.to_ascii_lowercase().contains("delegation");
        if !(about_delegation && i + 1 < tries.len()) {
            break;
        }
    }
    Err(last)
}

fn refusal(via: Via, status: u16, msg: &str) -> String {
    if via == Via::Server {
        return server_refusal(status, msg);
    }
    match status {
        401 | 403 => format!("{} refused the key ({status}): {msg}", via.label()),
        429 => format!("Rate limited by {}: {msg}", via.label()),
        _ => format!("Couldn't start the session ({status}): {msg}"),
    }
}

/// The paired OpenCode server's refusal, saying whose: the pairing (401/403), a server without voice (404), or the
/// server's own credential (503, e.g. not signed in to OpenCode Console), with the server's message.
fn server_refusal(status: u16, msg: &str) -> String {
    let lower = msg.to_ascii_lowercase();
    match status {
        401 | 403 => format!("Your OpenCode server refused this Mac's pairing ({status}); pair again with File ▸ Connect to OpenCode…: {msg}"),
        404 => format!("Your OpenCode server doesn't support voice sessions; update OpenCode ({status}): {msg}"),
        503 if lower.contains("console connection") || lower.contains("needs an") => format!("Your OpenCode server isn't signed in to OpenCode Console: {msg}"),
        429 => format!("Rate limited (through your OpenCode server): {msg}"),
        _ => format!("Your OpenCode server couldn't start the session ({status}): {msg}"),
    }
}

fn no_answer(ep: &Endpoint, e: impl std::fmt::Display) -> String {
    match ep.via {
        Via::Server => format!("Couldn't reach your OpenCode server ({}): {e}", host(&ep.url)),
        _ => format!("Couldn't reach {}: {e}", host(&ep.url)),
    }
}

fn host(url: &str) -> String {
    crate::net::parse_url(url).map(|u| u.display_host()).unwrap_or_else(|_| url.to_string())
}
