//! Client delegation: GPT-Live (`delegation: {"type":"client"}`) hands requests to the app with
//! `session.delegation.created`, which carries no task text. The coordinator (one thread per voice session) keeps the
//! transcript, builds the request from what the user said since the last delegation and the voice's acknowledgement,
//! prompts the voice session (`oc_tools::delegator()`, an OpenCode session on the paired server), follows it until it
//! finishes and gives the reply back with `session.commentary.append`, which GPT-Live speaks. Every delegation gets a
//! spoken answer: the reply, or what went wrong.
//!
//! Appends interrupt the voice, so results wait for a quiet moment (0.9 s after either side stops) but never more
//! than 5 s. Requests run one at a time, in order (a second waits for the first), so a reply is never mistaken for
//! another's.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::session::{Cmd, Ev, Pipes, Sink};
use crate::oc_tools::{self, SessionRef};
use crate::opencode::{CHAT_EVENTS, Client, Event, Message, Outcome};

/// The voice's persona and how it delegates; with no voice session, it tells the user to pick one.
pub fn instructions(target: Option<&SessionRef>) -> String {
    let base = "You are Grim's voice companion, talking with the user from the Grim notes app on their Mac. Be warm, natural and brief, \
like a thoughtful friend on a call: short spoken replies, no lists or markdown, and never read code, file paths or URLs aloud. \
Ask when something is unclear.";
    match target {
        Some(s) => format!(
            "{base}\n\nYou can delegate to the user's OpenCode session \"{}\"{}: an AI coding agent with their project, notes and tools. \
Delegate anything about their work, their files, the project or \"what are we working on\", and any task they want done or looked up; \
never guess about their work. When you delegate, acknowledge in a few natural words (like \"Let me check.\") and wait. \
The result comes back to you: say it conversationally and briefly, leading with the answer, never reading code aloud. \
If it says more is in the session, mention that in a few words.",
            s.name(),
            if s.directory.is_empty() { String::new() } else { format!(" (working in {})", short_dir(&s.directory)) }
        ),
        None => format!(
            "{base}\n\nNo voice session is selected, so you can't reach the user's OpenCode coding agent. If they ask about their work, \
files, the project or a task, tell them to pick a voice session in Grim's mic menu (Voice session) first, instead of delegating."
        ),
    }
}

/// What the session thread and the request threads tell the coordinator.
pub enum Note {
    Started,
    Input(String),
    Output(String),
    Delegation(String),
    Appended(String),
    /// Context for the voice (`session.thinking.append`, no delegation), fetched off the coordinator.
    Context(String),
    /// A request's progress or end.
    Still(String),
    Done(String, Result<String, String>),
}

/// Waits before results go out.
const QUIET: Duration = Duration::from_millis(900);
const MAX_HOLD: Duration = Duration::from_secs(5);
/// After a spoken result, time for the voice to start saying it before the next append.
const ANSWER_START: Duration = Duration::from_millis(1500);
const SETTLE: Duration = Duration::from_millis(200);
const ACK_WAIT: Duration = Duration::from_millis(1200);
const ACK_PAUSE: Duration = Duration::from_millis(400);
const STILL_AFTER: Duration = Duration::from_secs(60);
const GIVE_UP: Duration = Duration::from_secs(300);
/// About 500 tokens, an append's limit.
pub const CHUNK: usize = 1500;
pub const PREFIX: &str = "Voice request (from Grim's voice call).";

struct Pending {
    id: String,
    t0: Instant,
    target: Option<SessionRef>,
    words: Option<String>,
    ack: String,
    ack_at: Option<Instant>,
}

struct Job {
    id: String,
    target: SessionRef,
    prompt: String,
}

struct Out {
    ty: &'static str,
    delegation: Option<String>,
    content: String,
    hold_until: Instant,
}

/// The coordinator's hold on the session: sends JSON on the data channel through the session thread.
#[derive(Clone)]
pub struct Wire {
    pub cmd: Sender<Cmd>,
    pub pipes: Arc<Pipes>,
}

impl Wire {
    fn send(&self, v: Value) {
        let _ = self.cmd.send(Cmd::Send(v.to_string()));
        let _ = self.pipes.waker.wake();
    }
}

pub fn spawn(client: Option<Client>, wire: Wire, sink: Sink) -> Sender<Note> {
    let (tx, rx) = channel();
    let me = tx.clone();
    let _ = std::thread::Builder::new().name("grim-voice-delegate".into()).spawn(move || Coord::new(client, wire, sink, me).run(rx));
    tx
}

struct Coord {
    client: Option<Client>,
    wire: Wire,
    sink: Sink,
    me: Sender<Note>,
    live: bool,
    target: Option<SessionRef>,
    /// The conversation, by turn (user?, words).
    turns: Vec<(bool, String)>,
    /// What the user said since the last delegation took its words.
    user_since: String,
    last_input: Option<Instant>,
    pending: Vec<Pending>,
    queue: VecDeque<Job>,
    running: Option<(String, SessionRef, Arc<AtomicBool>)>,
    outbox: VecDeque<Out>,
    last_answer: Option<Instant>,
    seq: u64,
    stops: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
}

impl Coord {
    fn new(client: Option<Client>, wire: Wire, sink: Sink, me: Sender<Note>) -> Coord {
        Coord {
            client,
            wire,
            sink,
            me,
            live: false,
            target: oc_tools::delegator(),
            turns: Vec::new(),
            user_since: String::new(),
            last_input: None,
            pending: Vec::new(),
            queue: VecDeque::new(),
            running: None,
            outbox: VecDeque::new(),
            last_answer: None,
            seq: 0,
            stops: Arc::default(),
        }
    }

    fn log(&self, s: String) {
        (self.sink)(Ev::Log(format!("delegation: {s}")));
    }

    fn run(mut self, rx: Receiver<Note>) {
        let mut last_check = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(n) => self.note(n),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if self.live && last_check.elapsed() > Duration::from_millis(400) {
                last_check = Instant::now();
                self.follow_delegator();
            }
            self.advance();
            self.flush();
        }
        // the call ended: running requests stop following their session (their prompts stay in it)
        for s in self.stops.lock().unwrap().iter() {
            s.store(true, Ordering::SeqCst);
        }
        (self.sink)(Ev::Working(None));
    }

    fn note(&mut self, n: Note) {
        match n {
            Note::Started => {
                self.live = true;
                self.fetch_context(self.target.clone(), false);
            }
            Note::Input(d) => {
                self.last_input = Some(Instant::now());
                self.user_since.push_str(&d);
                push_turn(&mut self.turns, true, &d);
            }
            Note::Output(d) => {
                push_turn(&mut self.turns, false, &d);
                let now = Instant::now();
                for p in self.pending.iter_mut().filter(|p| p.words.is_some() || now - p.t0 < ACK_WAIT) {
                    p.ack.push_str(&d);
                    p.ack_at = Some(now);
                }
            }
            Note::Delegation(id) => {
                let target = oc_tools::delegator();
                self.log(format!("{id} created (voice session: {})", target.as_ref().map_or("none".into(), |t| t.name())));
                if target.is_none() || self.client.is_none() {
                    let msg = if target.is_none() {
                        "No voice session is selected; pick one in the mic menu (Voice session)."
                    } else {
                        "Grim isn't connected to OpenCode; use File, Connect to OpenCode, then pick a voice session."
                    };
                    self.user_since.clear();
                    self.send_now("session.commentary.append", Some(&id), msg);
                    return;
                }
                self.pending.push(Pending { id, t0: Instant::now(), target, words: None, ack: String::new(), ack_at: None });
            }
            Note::Appended(id) => self.log(format!("appended {id}")),
            Note::Context(text) => self.queue_out("session.thinking.append", None, text, Duration::ZERO),
            Note::Still(id) => {
                if let Some((rid, t, _)) = &self.running
                    && *rid == id
                {
                    let msg = format!("Still working on it in {}.", t.name());
                    self.queue_out("session.commentary.append", Some(id), msg, MAX_HOLD);
                }
            }
            Note::Done(id, r) => {
                let title = self.running.as_ref().filter(|(rid, ..)| *rid == id).map(|(_, t, _)| t.name()).unwrap_or_default();
                self.running = None;
                // the "working" note is moot now
                self.outbox.retain(|o| !(o.ty == "session.thinking.append" && o.delegation.as_deref() == Some(id.as_str())));
                let content = match r {
                    Ok(reply) => {
                        self.log(format!("{id} replied ({} chars)", reply.chars().count()));
                        speakable_answer(&reply, &title)
                    }
                    Err(e) => {
                        self.log(format!("{id} failed: {e}"));
                        e
                    }
                };
                self.queue_out("session.commentary.append", Some(id), content, MAX_HOLD);
                if self.queue.is_empty() {
                    (self.sink)(Ev::Working(None));
                }
            }
        }
    }

    /// The voice session changed mid-call: tell the voice (and, if one came or went, change what it may do).
    fn follow_delegator(&mut self) {
        let now = oc_tools::delegator();
        if now == self.target {
            return;
        }
        let had = self.target.is_some();
        self.target = now.clone();
        self.log(format!("voice session now {}", now.as_ref().map_or("none".into(), |t| t.name())));
        if had != now.is_some() {
            let text = match &now {
                Some(t) => format!("Update: the user picked a voice session, \"{}\". You can now delegate to it as described: anything about their work, files, project or tasks.", t.name()),
                None => "Update: no voice session is selected now. If the user asks about their work or a task, tell them to pick one in Grim's mic menu (Voice session) instead of delegating.".into(),
            };
            self.queue_out("session.instructions.append", None, text, MAX_HOLD);
        }
        self.fetch_context(now, true);
    }

    /// The voice session's title, directory and latest messages, as silent context.
    fn fetch_context(&self, target: Option<SessionRef>, switched: bool) {
        let Some(t) = target else {
            if switched {
                let _ = self.me.send(Note::Context("No voice session is selected now.".into()));
            }
            return;
        };
        let client = self.client.clone();
        let me = self.me.clone();
        std::thread::spawn(move || {
            let msgs = client.as_ref().and_then(|c| c.messages(&t.id, 8).ok()).unwrap_or_default();
            let _ = me.send(Note::Context(context_text(&t, &msgs, switched)));
        });
    }

    /// Pending delegations: the user's words once settled, the acknowledgement once said (or a second gone), then the
    /// request queued; the next queued request starts when none runs.
    fn advance(&mut self) {
        let now = Instant::now();
        for p in self.pending.iter_mut() {
            if p.words.is_none() && now - p.t0 >= SETTLE {
                p.words = Some(std::mem::take(&mut self.user_since).trim().to_string());
            }
        }
        let mut ready = Vec::new();
        self.pending.retain(|p| {
            let acked = p.ack_at.is_some_and(|t| now - t >= ACK_PAUSE);
            let go = p.words.is_some() && (acked || now - p.t0 >= ACK_WAIT);
            if go {
                ready.push((p.id.clone(), p.target.clone(), p.words.clone().unwrap_or_default(), p.ack.trim().to_string()));
            }
            !go
        });
        for (id, target, words, ack) in ready {
            let target = target.expect("checked when created");
            let prompt = prompt_text(&words, &ack, &self.turns);
            self.log(format!("{id} queued: user said {words:?}; acknowledgement {ack:?}"));
            self.queue.push_back(Job { id, target, prompt });
        }
        if self.running.is_none()
            && let Some(job) = self.queue.pop_front()
        {
            self.start(job);
        }
    }

    fn start(&mut self, job: Job) {
        let Some(client) = self.client.clone() else { return };
        let stop = Arc::new(AtomicBool::new(false));
        self.stops.lock().unwrap().push(stop.clone());
        self.running = Some((job.id.clone(), job.target.clone(), stop.clone()));
        (self.sink)(Ev::Working(Some(job.target.name())));
        self.log(format!("{} prompting {} ({})", job.id, job.target.name(), job.target.id));
        let working = format!("Sent to {}; working on it, no result yet.", job.target.name());
        self.queue_out("session.thinking.append", Some(job.id.clone()), working, MAX_HOLD);
        let me = self.me.clone();
        let sink = self.sink.clone();
        std::thread::spawn(move || {
            let id = job.id.clone();
            let r = run_job(&client, &job, &stop, &me, &sink);
            stop.store(true, Ordering::SeqCst);
            let _ = me.send(Note::Done(id, r));
        });
    }

    fn queue_out(&mut self, ty: &'static str, delegation: Option<String>, content: String, hold: Duration) {
        self.outbox.push_back(Out { ty, delegation, content, hold_until: Instant::now() + hold });
    }

    fn send_now(&mut self, ty: &'static str, delegation: Option<&str>, content: &str) {
        self.seq += 1;
        let event_id = format!("grim_{}_{}", ty.split('.').nth(1).unwrap_or("x"), self.seq);
        self.log(format!("sending {ty} {event_id} (delegation {}): {:?}", delegation.unwrap_or("null"), content.chars().take(200).collect::<String>()));
        if ty == "session.commentary.append" {
            self.last_answer = Some(Instant::now());
            (self.sink)(Ev::Log(format!("COMMENTARY {}: {content}", delegation.unwrap_or("null"))));
        }
        self.wire.send(json!({ "type": ty, "event_id": event_id, "delegation_id": delegation, "content": content }));
    }

    /// Send what waits, in order, at a quiet moment (or once held too long).
    fn flush(&mut self) {
        if !self.live {
            return;
        }
        while let Some(o) = self.outbox.front() {
            let now = Instant::now();
            let quiet = self.wire.pipes.voice_quiet() >= QUIET && self.last_input.is_none_or(|t| now - t >= QUIET);
            let answer_settled = self.last_answer.is_none_or(|t| now - t >= ANSWER_START);
            // context before anything was said can go at once
            let silent_start = o.ty == "session.thinking.append" && o.delegation.is_none() && self.turns.is_empty();
            if !(silent_start || (quiet && answer_settled) || now >= o.hold_until) {
                return;
            }
            let o = self.outbox.pop_front().unwrap();
            self.send_now(o.ty, o.delegation.as_deref(), &o.content);
        }
    }
}

fn push_turn(turns: &mut Vec<(bool, String)>, user: bool, d: &str) {
    match turns.last_mut() {
        Some((u, s)) if *u == user => s.push_str(d),
        _ => turns.push((user, d.to_string())),
    }
    if turns.len() > 40 {
        turns.remove(0);
    }
}

/// The prompt the voice session gets.
pub fn prompt_text(words: &str, ack: &str, turns: &[(bool, String)]) -> String {
    let words = if words.is_empty() { "(not transcribed; see the recent transcript)" } else { words };
    let mut recent = Vec::new();
    let mut n = 0;
    for (user, s) in turns.iter().rev() {
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        let line = format!("{}: {}", if *user { "user" } else { "assistant" }, clip(s, 400));
        n += line.len();
        if n > 1500 || recent.len() >= 8 {
            break;
        }
        recent.push(line);
    }
    recent.reverse();
    let mut p = format!("{PREFIX} The user said: \"{words}\"\n(\"My coding session\", \"OpenCode\" or \"the agent\" means you: do it here.)\n");
    if !ack.is_empty() {
        p.push_str(&format!("Voice agent framing: \"{ack}\"\n"));
    }
    if !recent.is_empty() {
        p.push_str(&format!("Recent transcript:\n{}\n", recent.join("\n")));
    }
    p.push_str("Reply for speech: lead with a short plain answer suitable for reading aloud (no markdown, no code), then any detail.");
    p
}

fn context_text(t: &SessionRef, msgs: &[Message], switched: bool) -> String {
    let mut s = if switched { format!("Now working with the voice session \"{}\"", t.name()) } else { format!("The user's voice session is \"{}\"", t.name()) };
    if !t.directory.is_empty() {
        s.push_str(&format!(" (directory {})", short_dir(&t.directory)));
    }
    s.push_str(". Use this to answer \"what are we working on\"; delegate for anything more.");
    let newest_reply = msgs.iter().rposition(|m| !m.user && !m.text.trim().is_empty());
    let mut lines = Vec::new();
    for (i, m) in msgs.iter().enumerate().rev().take(5).collect::<Vec<_>>().into_iter().rev() {
        let text = strip_markdown(&m.text);
        if text.trim().is_empty() {
            continue;
        }
        let limit = if Some(i) == newest_reply { CHUNK } else { 300 };
        lines.push(format!("{}: {}", if m.user { "user" } else { "agent" }, clip(text.trim(), limit)));
    }
    if !lines.is_empty() {
        s.push_str(&format!("\nIts latest messages:\n{}", lines.join("\n")));
    }
    clip(&s, 1900)
}

fn short_dir(d: &str) -> String {
    let parts: Vec<&str> = d.trim_end_matches('/').rsplit('/').take(2).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>().trim_end()) }
}

/// Prompt the session and follow it until our request's run ends: the reply's text, or what went wrong (spoken).
fn run_job(client: &Client, job: &Job, stop: &Arc<AtomicBool>, me: &Sender<Note>, sink: &Sink) -> Result<String, String> {
    let name = job.target.name();
    let (etx, erx) = channel::<Option<Outcome>>();
    {
        // the session's events, reconnecting until the request is answered
        let (client, stop, session, sink) = (client.clone(), stop.clone(), job.target.id.clone(), sink.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let r = client.events(CHAT_EVENTS, &stop, |ev| {
                    match ev {
                        Event::Connected => {
                            let _ = etx.send(None);
                        }
                        Event::Finished { session: s, outcome } if s == session => {
                            let _ = etx.send(Some(outcome));
                        }
                        _ => {}
                    }
                    !stop.load(Ordering::SeqCst)
                });
                if let Err(e) = r {
                    sink(Ev::Log(format!("delegation: event stream: {e}; reconnecting")));
                    std::thread::sleep(Duration::from_secs(1));
                    let _ = etx.send(None);
                }
            }
        });
    }
    // the stream up first, so the end isn't missed
    let _ = erx.recv_timeout(Duration::from_secs(5));
    let t0 = Instant::now();
    client.prompt(&job.target.id, &job.prompt).map_err(|e| format!("I couldn't send that to {name}: {e}."))?;
    sink(Ev::Log(format!("delegation: {} prompt sent to {}", job.id, job.target.id)));
    let mut still_sent = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err("The call ended.".into());
        }
        let elapsed = t0.elapsed();
        if elapsed > GIVE_UP {
            return Err(format!("{name} is still working on it after five minutes; check the session for the answer."));
        }
        if elapsed > STILL_AFTER && !still_sent {
            still_sent = true;
            let _ = me.send(Note::Still(job.id.clone()));
        }
        match erx.recv_timeout(Duration::from_secs(10)) {
            Ok(Some(outcome)) => {
                // a run ended: ours if its reply follows our prompt
                match reply_after(client, job) {
                    Ok(Some(text)) => return Ok(text),
                    Ok(None) => {
                        if let Outcome::Failed(m) = &outcome
                            && prompt_seen(client, job)
                        {
                            return Err(format!("{name} ran into an error: {m}"));
                        }
                        if let Outcome::Interrupted(_) = &outcome
                            && prompt_seen(client, job)
                        {
                            return Err(format!("The request in {name} was interrupted."));
                        }
                    }
                    Err(e) => return Err(format!("I lost touch with {name}: {e}.")),
                }
            }
            Ok(None) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err(format!("I lost touch with {name}.")),
        }
    }
}

fn our_prompt(msgs: &[Message], job: &Job) -> Option<usize> {
    msgs.iter().rposition(|m| m.user && m.text.trim() == job.prompt.trim()).or_else(|| msgs.iter().rposition(|m| m.user && m.text.trim_start().starts_with(PREFIX)))
}

fn prompt_seen(client: &Client, job: &Job) -> bool {
    client.messages(&job.target.id, 40).ok().is_some_and(|m| our_prompt(&m, job).is_some())
}

/// The reply to our prompt: the last of the assistant messages after it with text.
fn reply_after(client: &Client, job: &Job) -> Result<Option<String>, String> {
    let msgs = client.messages(&job.target.id, 40).map_err(|e| e.to_string())?;
    let Some(i) = our_prompt(&msgs, job) else { return Ok(None) };
    let after = &msgs[i + 1..];
    if let Some(e) = after.iter().rev().find_map(|m| m.error.clone())
        && after.iter().all(|m| m.text.trim().is_empty())
    {
        return Err(e);
    }
    Ok(after.iter().rev().find(|m| !m.user && !m.text.trim().is_empty()).map(|m| m.text.clone()))
}

/// The reply as the voice should get it: no code or markdown, the first ~1,500 characters (at a sentence), and a word
/// that the rest is in the session.
pub fn speakable_answer(reply: &str, title: &str) -> String {
    let had_code = reply.contains("```");
    let text = strip_markdown(reply);
    let text = text.trim();
    if text.is_empty() {
        return if had_code { format!("The answer is code; it's in {title}.") } else { format!("{title} finished without a written answer.") };
    }
    let chunks = chunks(text, CHUNK);
    let mut out = chunks[0].clone();
    if chunks.len() > 1 {
        out.push_str(&format!("\n(That's the start; the rest is in {title}.)"));
    } else if had_code {
        out.push_str(&format!("\n(The code is in {title}.)"));
    }
    out
}

/// Fenced code dropped; headings, emphasis, inline code, links and tables reduced to their words.
pub fn strip_markdown(s: &str) -> String {
    let mut out = Vec::new();
    let mut fence = false;
    for line in s.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        if t.starts_with('|') {
            // a table row: its cells, unless it's the divider
            if t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
                continue;
            }
            out.push(t.split('|').map(str::trim).filter(|c| !c.is_empty()).collect::<Vec<_>>().join(", "));
            continue;
        }
        let mut t = t.trim_start_matches('#').trim_start_matches('>').trim_start().to_string();
        if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            t = rest.to_string();
        }
        out.push(inline(&t));
    }
    let joined = out.join("\n");
    // at most one blank line
    let mut s = String::new();
    let mut blanks = 0;
    for l in joined.lines() {
        if l.trim().is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        s.push_str(l);
        s.push('\n');
    }
    s.trim().to_string()
}

fn inline(s: &str) -> String {
    let mut out = String::new();
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        // [text](url) -> text
        if c == '['
            && let Some(close) = cs[i..].iter().position(|&x| x == ']').map(|p| p + i)
            && cs.get(close + 1) == Some(&'(')
            && let Some(end) = cs[close..].iter().position(|&x| x == ')').map(|p| p + close)
        {
            out.extend(&cs[i + 1..close]);
            i = end + 1;
            continue;
        }
        if c == '`' || c == '*' || (c == '_' && cs.get(i + 1) == Some(&'_')) {
            i += if c == '_' { 2 } else { 1 };
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Pieces of at most `max` characters, cut at a paragraph, sentence or word.
pub fn chunks(s: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest: &str = s.trim();
    while rest.chars().count() > max {
        let end = rest.char_indices().nth(max).map_or(rest.len(), |(i, _)| i);
        let head = &rest[..end];
        let cut = head.rfind("\n\n").or_else(|| head.rfind(". ").map(|i| i + 1)).or_else(|| head.rfind('\n')).or_else(|| head.rfind(' ')).filter(|&i| i > max / 3).unwrap_or(end);
        out.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim_start();
    }
    if !rest.is_empty() || out.is_empty() {
        out.push(rest.to_string());
    }
    out
}
