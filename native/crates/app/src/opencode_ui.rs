//! "Connect to OpenCode" (experimental, File menu): pair with an OpenCode server (a pairing link from `opencode
//! pair`, or its address and password), then its sessions; open one to read its latest messages and send it a
//! plain text prompt, the reply streaming in from the server's event stream. The protocol is `opencode.rs`.
//!
//! One modal dialog with three pages (`Page`): Pair, Sessions, Session. Everything that talks to the server runs
//! on a thread (`task`), its answer applied only while the same dialog is open (`OcDlg::serial`). While paired, one
//! event stream runs (`start_stream`): reconnecting by itself with backoff, its state shown in the status row
//! (Live, Connecting…, Disconnected with the reason); it stops once the dialog is gone (the next event or
//! heartbeat finds no dialog and sets its stop flag).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use rune::{El, ScrollSpec, TextEdit, TextStyle, Tx, col, el, row, text};

use crate::App;
use crate::dialogs::{Btn, Dialog, actions, button, close, field, form_error, hint, label, muted, on_down, p};
use crate::opencode::{self, CHAT_EVENTS, Client, Event, Info, Message, OcError, Outcome, Pairing, Pasted, Redeemed, Session};
use crate::remote::Backend;
use crate::theme::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Pair,
    Sessions,
    Session,
}

/// The pairing form's method: the OpenCode app's ("a pairing link is the way in, the password is the fallback").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Link,
    Password,
}

/// The server, as last checked.
#[derive(Clone, Debug, PartialEq)]
pub enum Conn {
    Checking,
    Connected(Info),
    /// It couldn't be reached (why).
    Failed(String),
    /// It refused the pairing (401): pair again.
    Refused,
}

/// The event stream.
#[derive(Clone, Debug, PartialEq)]
pub enum Stream {
    Off,
    Connecting,
    Live,
    /// Lost (why); it tries again by itself.
    Lost(String),
}

/// A message as shown: the prompt or the reply, the reply's text growing as it streams.
#[derive(Clone, Debug)]
pub struct Msg {
    pub id: String,
    pub user: bool,
    pub text: String,
    pub tools: Vec<String>,
    pub error: Option<String>,
    /// The reply's text part being streamed (parts are joined with a blank line).
    pub ordinal: u64,
}

impl From<Message> for Msg {
    fn from(m: Message) -> Msg {
        Msg { id: m.id, user: m.user, text: m.text, tools: m.tools, error: m.error, ordinal: 0 }
    }
}

#[derive(Clone, Debug)]
pub struct OcDlg {
    /// This dialog (answers for an older one are dropped).
    pub serial: u64,
    pub page: Page,
    pub method: Method,
    pub link: TextEdit,
    pub server: TextEdit,
    pub password: TextEdit,
    pub busy: bool,
    pub error: Option<String>,
    pub client: Option<Client>,
    pub conn: Conn,
    pub stream: Stream,
    /// The running stream's stop flag and id.
    pub stop: Option<Arc<AtomicBool>>,
    pub stream_id: u64,
    pub sessions: Option<Vec<Session>>,
    pub session: Option<Session>,
    /// The open session's messages (None: loading).
    pub messages: Option<Vec<Msg>>,
    /// The agent is working on the open session.
    pub working: bool,
    pub prompt: TextEdit,
    pub sending: bool,
    pub chat_error: Option<String>,
}

static GEN: AtomicU64 = AtomicU64::new(1);

fn next_gen() -> u64 {
    GEN.fetch_add(1, Ordering::SeqCst)
}

/// How many messages a session shows (the latest).
const RECENT: usize = 30;
/// A message's shown text is cut to its last this many characters.
const MAX_CHARS: usize = 6000;

impl OcDlg {
    fn new() -> OcDlg {
        OcDlg {
            serial: next_gen(),
            page: Page::Pair,
            method: Method::Link,
            link: TextEdit::new(""),
            server: TextEdit::new(""),
            password: TextEdit::new(""),
            busy: false,
            error: None,
            client: None,
            conn: Conn::Checking,
            stream: Stream::Off,
            stop: None,
            stream_id: 0,
            sessions: None,
            session: None,
            messages: None,
            working: false,
            prompt: TextEdit::new(""),
            sending: false,
            chat_error: None,
        }
    }

    pub fn title(&self) -> String {
        match self.page {
            Page::Pair => "Connect to OpenCode".into(),
            _ => "OpenCode".into(),
        }
    }

    /// The text fields, by `Dialog::field` number: the link, the server, the password, the prompt.
    fn fields(&mut self) -> [&mut TextEdit; 4] {
        [&mut self.link, &mut self.server, &mut self.password, &mut self.prompt]
    }

    pub fn field(&mut self, n: usize) -> Option<&mut TextEdit> {
        self.fields().into_iter().nth(n)
    }

    pub fn typing(&self) -> bool {
        [&self.link, &self.server, &self.password, &self.prompt].iter().any(|e| e.focused)
    }

    fn focus(&mut self, n: Option<usize>) {
        for (i, e) in self.fields().into_iter().enumerate() {
            e.focused = Some(i) == n;
        }
    }

    fn stop_stream(&mut self) {
        if let Some(s) = self.stop.take() {
            s.store(true, Ordering::SeqCst);
        }
        self.stream = Stream::Off;
    }
}

fn dlg(app: &mut App) -> Option<&mut OcDlg> {
    match &mut app.dialog {
        Some(Dialog::OpenCode(d)) => Some(&mut **d),
        _ => None,
    }
}

/// Run `f` on a thread and hand its answer to `done` on the UI thread, while this dialog is still open.
fn task<T: Send + 'static>(app: &mut App, f: impl FnOnce() -> T + Send + 'static, done: impl FnOnce(&mut App, T, &mut Tx) + Send + 'static) {
    let Some(serial) = dlg(app).map(|d| d.serial) else { return };
    let Backend::Net(h) = &app.backend else { return };
    let h = h.clone();
    std::thread::spawn(move || {
        let r = f();
        h.update(move |app, tx| {
            if dlg(app).is_some_and(|d| d.serial == serial) {
                done(app, r, tx);
                app.handled(tx);
            }
        });
    });
}

impl App {
    /// File ▸ Connect to OpenCode…: the dialog, at its sessions when paired (checking the server and starting
    /// the event stream), else at the pairing form.
    pub fn open_opencode(&mut self, tx: &mut Tx) {
        if dlg(self).is_some() {
            return;
        }
        let mut d = OcDlg::new();
        let paired = opencode::load(&self.tokens);
        match paired {
            Some(p) => {
                d.client = Some(Client::new(p));
                d.page = Page::Sessions;
            }
            None => d.focus(Some(0)),
        }
        let go = d.client.is_some();
        self.dialog = Some(Dialog::OpenCode(Box::new(d)));
        if go {
            connect(self, tx);
        }
    }
}

// ---- pairing ----

fn pick_method(app: &mut App, v: &str, _tx: &mut Tx) {
    if let Some(d) = dlg(app) {
        d.method = if v == "password" { Method::Password } else { Method::Link };
        d.error = None;
        d.focus(Some(if d.method == Method::Link { 0 } else if d.server.text.trim().is_empty() { 1 } else { 2 }));
    }
}

/// Connect: redeem the pairing link, or check the address and password; then keep the pairing and show the
/// server's sessions.
pub fn submit_pair(app: &mut App, _tx: &mut Tx) {
    let Some(d) = dlg(app) else { return };
    if d.busy {
        return;
    }
    d.error = None;
    match d.method {
        Method::Link => match opencode::parse_pasted(&d.link.text) {
            Pasted::Link { urls, code } => {
                d.busy = true;
                task(app, move || opencode::redeem(&urls, &code), |app, r, tx| match r {
                    Redeemed::Paired(p) => paired(app, p, tx),
                    Redeemed::Expired => fail(app, "This pairing link expired or was already used. Run opencode pair again for a new one."),
                    Redeemed::Unreachable(why) => fail(app, &format!("Couldn't reach the server ({why}). Use an address this Mac can reach, and check that OpenCode is running.")),
                });
            }
            Pasted::Server(url) => {
                // an address belongs to the password form
                d.method = Method::Password;
                d.server = TextEdit::new(&url);
                d.focus(Some(2));
            }
            Pasted::Legacy => d.error = Some("This link is from an older OpenCode. Update OpenCode, then run opencode pair for a new link.".into()),
            Pasted::Invalid if d.link.text.trim().is_empty() => d.error = Some("Paste a link from opencode pair.".into()),
            Pasted::Invalid => d.error = Some("That isn't a pairing link. On the computer running OpenCode, run opencode pair and paste one of the links it prints.".into()),
        },
        Method::Password => {
            let Some(url) = opencode::server_address(&d.server.text) else {
                d.error = Some("Enter the server's address, like http://192.168.1.20:4096".into());
                return;
            };
            let p = Pairing { url, password: d.password.text.clone() };
            d.busy = true;
            let c = Client::new(p.clone());
            task(app, move || c.info(), move |app, r, tx| match r {
                Ok(_) => paired(app, p, tx),
                Err(OcError::Unauthorized) => fail(app, "Wrong password."),
                Err(e) => fail(app, &format!("Couldn't connect: {e}")),
            });
        }
    }
}

fn fail(app: &mut App, msg: &str) {
    if let Some(d) = dlg(app) {
        d.busy = false;
        d.error = Some(msg.into());
    }
}

/// Paired: keep it in the Keychain, then the sessions.
fn paired(app: &mut App, p: Pairing, tx: &mut Tx) {
    let kept = opencode::save(&app.tokens, &p);
    let host = p.host();
    if let Some(d) = dlg(app) {
        d.busy = false;
        d.client = Some(Client::new(p));
        d.page = Page::Sessions;
        d.focus(None);
        d.link = TextEdit::new("");
        d.password = TextEdit::new("");
    }
    crate::oc_tools::start_paired(app);
    match kept {
        Ok(_) => app.show_toast(format!("Paired with OpenCode on {host}")),
        Err(e) => app.show_toast(format!("Paired with {host}, but couldn't keep the pairing: {e}")),
    }
    connect(app, tx);
}

/// Forget the pairing: off the Keychain, back to the form.
fn forget(app: &mut App, _tx: &mut Tx) {
    opencode::forget(&app.tokens);
    crate::oc_tools::stop();
    if let Some(d) = dlg(app) {
        d.stop_stream();
        *d = OcDlg { serial: d.serial, ..OcDlg::new() };
        d.focus(Some(0));
    }
    app.show_toast("Forgot the OpenCode server".into());
}

// ---- the connection ----

/// Check the server, load its sessions (and the open session's messages), start the event stream.
fn connect(app: &mut App, _tx: &mut Tx) {
    let Some(d) = dlg(app) else { return };
    let Some(c) = d.client.clone() else { return };
    d.stop_stream();
    d.conn = Conn::Checking;
    d.error = None;
    task(app, move || c.info().and_then(|i| c.sessions(100).map(|s| (i, s))), |app, r, tx| {
        let Some(d) = dlg(app) else { return };
        match r {
            Ok((info, list)) => {
                d.conn = Conn::Connected(info);
                d.sessions = Some(list);
                start_stream(app);
                reload_messages(app, tx);
            }
            Err(OcError::Unauthorized) => d.conn = Conn::Refused,
            Err(e) => d.conn = Conn::Failed(e.to_string()),
        }
    });
}

fn reconnect(app: &mut App, tx: &mut Tx) {
    connect(app, tx);
}

/// Forget the pairing and show the form (the server refused it).
fn pair_again(app: &mut App, tx: &mut Tx) {
    forget(app, tx);
}

/// The event stream, on its own thread: every event to `on_event`; reconnects with backoff (1 s, doubling to
/// 15 s) until the dialog is gone or the server refuses the pairing.
fn start_stream(app: &mut App) {
    let Backend::Net(h) = &app.backend else { return };
    let h = h.clone();
    let Some(d) = dlg(app) else { return };
    let Some(c) = d.client.clone() else { return };
    d.stop_stream();
    let stop = Arc::new(AtomicBool::new(false));
    d.stop = Some(stop.clone());
    d.stream_id = next_gen();
    d.stream = Stream::Connecting;
    let (serial, id) = (d.serial, d.stream_id);
    std::thread::spawn(move || {
        let post = |ev: Result<Event, Stream>| {
            let stop = stop.clone();
            h.update(move |app, tx| on_event(app, serial, id, &stop, ev, tx));
        };
        let mut delay = Duration::from_secs(1);
        let mut first = true;
        loop {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            if !first {
                post(Err(Stream::Connecting));
            }
            first = false;
            let r = c.events(CHAT_EVENTS, &stop, |ev| {
                if ev == Event::Connected {
                    delay = Duration::from_secs(1);
                }
                post(Ok(ev));
                !stop.load(Ordering::SeqCst)
            });
            if stop.load(Ordering::SeqCst) {
                return;
            }
            match r {
                Ok(()) => return,
                Err(OcError::Unauthorized) => {
                    post(Err(Stream::Off));
                    return;
                }
                Err(e) => post(Err(Stream::Lost(e.to_string()))),
            }
            let until = std::time::Instant::now() + delay;
            while std::time::Instant::now() < until {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            delay = (delay * 2).min(Duration::from_secs(15));
        }
    });
}

/// An event (or the stream's new state) on the UI thread. No such dialog or stream any more: stop it.
fn on_event(app: &mut App, serial: u64, id: u64, stop: &AtomicBool, ev: Result<Event, Stream>, tx: &mut Tx) {
    let Some(d) = dlg(app).filter(|d| d.serial == serial && d.stream_id == id) else {
        stop.store(true, Ordering::SeqCst);
        return;
    };
    let ev = match ev {
        Ok(ev) => ev,
        Err(Stream::Off) => {
            // refused (401)
            d.stream = Stream::Off;
            d.conn = Conn::Refused;
            tx.instant();
            return;
        }
        Err(s) => {
            d.stream = s;
            tx.instant();
            return;
        }
    };
    match ev {
        Event::Heartbeat | Event::Other(_) => return,
        Event::Connected => {
            let again = matches!(d.stream, Stream::Lost(_) | Stream::Connecting) && d.messages.is_some();
            d.stream = Stream::Live;
            // events missed while disconnected are gone: read the session again
            if again {
                reload_messages(app, tx);
            }
            tx.instant();
            return;
        }
        _ => {}
    }
    let open = d.session.as_ref().map(|s| s.id.clone());
    if ev.session() != open.as_deref() {
        return;
    }
    let Some(list) = d.messages.as_mut() else { return };
    match ev {
        Event::UserQueued { id, text, .. } => {
            if !list.iter().any(|m| m.id == id) {
                // our own prompt, sent from here: it gets its id
                match list.iter_mut().find(|m| m.user && m.id.starts_with("local-") && m.text == text) {
                    Some(m) => m.id = id,
                    None => list.push(Msg { id, user: true, text, tools: Vec::new(), error: None, ordinal: 0 }),
                }
            }
        }
        Event::Started { .. } => {
            d.working = true;
            d.chat_error = None;
        }
        Event::TextStarted { message, ordinal, .. } => {
            reply(list, &message, ordinal);
        }
        Event::TextDelta { message, ordinal, delta, .. } => {
            reply(list, &message, ordinal).text.push_str(&delta);
        }
        Event::TextEnded { message, ordinal, text, .. } => {
            let m = reply(list, &message, ordinal);
            if m.text.is_empty() {
                m.text = text;
            }
        }
        Event::Finished { outcome, .. } => {
            d.working = false;
            d.sending = false;
            match outcome {
                Outcome::Succeeded => {}
                Outcome::Failed(why) => d.chat_error = Some(why),
                Outcome::Interrupted(why) => d.chat_error = Some(if why.is_empty() { "Stopped.".into() } else { format!("Stopped ({why}).") }),
            }
            // the stored messages: tools, final text
            reload_messages(app, tx);
        }
        _ => {}
    }
    tx.instant();
}

/// The reply `message`, at text part `ordinal` (a new part after a blank line).
fn reply<'a>(list: &'a mut Vec<Msg>, message: &str, ordinal: u64) -> &'a mut Msg {
    let i = match list.iter().position(|m| m.id == message) {
        Some(i) => i,
        None => {
            list.push(Msg { id: message.to_string(), user: false, text: String::new(), tools: Vec::new(), error: None, ordinal });
            list.len() - 1
        }
    };
    let m = &mut list[i];
    if ordinal != m.ordinal {
        if !m.text.is_empty() {
            m.text.push_str("\n\n");
        }
        m.ordinal = ordinal;
    }
    m
}

// ---- sessions ----

fn open_session(app: &mut App, s: Session, tx: &mut Tx) {
    if let Some(d) = dlg(app) {
        d.page = Page::Session;
        d.session = Some(s);
        d.messages = None;
        d.working = false;
        d.sending = false;
        d.chat_error = None;
        d.focus(Some(3));
    }
    reload_messages(app, tx);
}

/// The open session's latest messages; a reply still streaming that the server hasn't stored yet stays.
fn reload_messages(app: &mut App, _tx: &mut Tx) {
    let Some(d) = dlg(app) else { return };
    let (Some(c), Some(id)) = (d.client.clone(), d.session.as_ref().map(|s| s.id.clone())) else { return };
    let open = id.clone();
    task(app, move || c.messages(&id, RECENT), move |app, r, _tx| {
        let Some(d) = dlg(app).filter(|d| d.session.as_ref().is_some_and(|x| x.id == open)) else { return };
        match r {
            Ok(list) => {
                let mut list: Vec<Msg> = list.into_iter().map(Msg::from).collect();
                if let Some(old) = &d.messages {
                    for m in old {
                        if !list.iter().any(|n| n.id == m.id) && (d.working || m.id.starts_with("local-")) && (!m.user || d.sending) {
                            list.push(m.clone());
                        }
                    }
                }
                d.messages = Some(list);
            }
            Err(OcError::Unauthorized) => d.conn = Conn::Refused,
            Err(e) => {
                d.chat_error = Some(format!("Couldn't load the messages: {e}"));
                d.messages.get_or_insert_with(Vec::new);
            }
        }
    });
}

fn back(app: &mut App, tx: &mut Tx) {
    let Some(d) = dlg(app) else { return };
    d.page = Page::Sessions;
    d.session = None;
    d.messages = None;
    d.focus(None);
    let Some(c) = d.client.clone() else { return };
    let _ = tx;
    task(app, move || c.sessions(100), |app, r, _| {
        if let (Some(d), Ok(list)) = (dlg(app), r) {
            d.sessions = Some(list);
        }
    });
}

/// Send the prompt field's text to the open session; the reply streams in.
pub fn send(app: &mut App, _tx: &mut Tx) {
    let Some(d) = dlg(app) else { return };
    let text = d.prompt.text.trim().to_string();
    let (Some(c), Some(s)) = (d.client.clone(), d.session.clone()) else { return };
    if text.is_empty() || d.sending || d.messages.is_none() {
        return;
    }
    let local = format!("local-{}", next_gen());
    d.messages.get_or_insert_with(Vec::new).push(Msg { id: local.clone(), user: true, text: text.clone(), tools: Vec::new(), error: None, ordinal: 0 });
    d.prompt = TextEdit::new("");
    d.prompt.focused = true;
    d.sending = true;
    d.working = true;
    d.chat_error = None;
    task(app, move || c.prompt(&s.id, &text), move |app, r, _| {
        let Some(d) = dlg(app) else { return };
        match r {
            Ok(id) => {
                if let Some(list) = d.messages.as_mut() {
                    if list.iter().any(|m| m.id == id) {
                        list.retain(|m| m.id != local);
                    } else if let Some(m) = list.iter_mut().find(|m| m.id == local) {
                        m.id = id;
                    }
                }
                d.sending = false;
            }
            Err(e) => {
                d.sending = false;
                d.working = false;
                if e == OcError::Unauthorized {
                    d.conn = Conn::Refused;
                }
                d.chat_error = Some(format!("Couldn't send: {e}"));
            }
        }
    });
}

// ---- drawing ----

/// "Experimental", as a quiet tag.
fn experimental() -> El {
    row()
        .key("oc-experimental")
        .h(20.0)
        .px(7.0)
        .center()
        .radius(4.0)
        .fill(c(WARN_SOFT))
        .child(text("Experimental").key("oc-experimental-text").font(TextStyle::new(11.5, crate::theme::wt(600.0)).lh(14.0)).color(c(INK_2)))
}

pub fn body(d: &OcDlg, w: f32, vh: f32) -> Vec<El> {
    match d.page {
        Page::Pair => pair_body(d, w),
        Page::Sessions => sessions_body(d, w, vh),
        Page::Session => session_body(d, w, vh),
    }
}

fn pair_body(d: &OcDlg, w: f32) -> Vec<El> {
    let mut kids = vec![
        row().key("oc-intro").w(w).gap(8.0).items_start().child(experimental()).child(p("Pair Grim with an OpenCode server to see its sessions and talk to them from this Mac.", "oc-intro-text", w - 104.0)),
        crate::dialogs::segmented("oc-method", &[("link", "Pairing link"), ("password", "Address and password")], if d.method == Method::Link { "link" } else { "password" }, pick_method),
    ];
    match d.method {
        Method::Link => {
            kids.push(col().key("dlg-field").gap(6.0).child(label("Pairing link", "dlg-label")).child(field("oc-link", &d.link, "http://192.168.1.20:4096/auth/connect/…", 0, w, submit_pair)));
            kids.push(hint(
                "On the computer running OpenCode, run opencode pair and paste one of the links it prints, or the text of its QR code. Pick an address this Mac can reach; links work once and expire after 5 minutes.",
                "dlg-hint",
                w,
            ));
        }
        Method::Password => {
            kids.push(col().key("oc-server").gap(6.0).child(label("Server", "oc-server-label")).child(field("oc-server-url", &d.server, "http://192.168.1.20:4096", 1, w, submit_pair)));
            kids.push(col().key("oc-password").gap(6.0).child(label("Password", "oc-password-label")).child(field("oc-password-input", &d.password, "", 2, w, submit_pair).secure()));
            kids.push(hint("The server's password (OPENCODE_SERVER_PASSWORD); leave it empty for a server without one.", "dlg-hint", w));
        }
    }
    if let Some(e) = &d.error {
        kids.push(form_error(e, "dlg-error", w));
    }
    kids.push(actions(
        vec![
            button("Cancel", "dlg-cancel", Btn::Secondary, false, Box::new(close)),
            button(if d.busy { "Connecting…" } else { "Connect" }, "dlg-submit", Btn::Primary, d.busy, Box::new(submit_pair)),
        ],
        "dlg-actions",
        w,
    ));
    kids
}

/// The connection: a dot and what it says, Reconnect, Forget.
fn status_row(d: &OcDlg, w: f32) -> El {
    let host = d.client.as_ref().map(|c| c.pairing.host()).unwrap_or_default();
    let (dot, line) = match (&d.conn, &d.stream) {
        (Conn::Checking, _) => ("#d4a017", format!("Connecting to {host}…")),
        (Conn::Refused, _) => (RED, format!("{host} · pairing refused")),
        (Conn::Failed(_), _) => (RED, format!("Can't reach {host}")),
        (Conn::Connected(i), Stream::Live) => ("#2f9e44", format!("{} · OpenCode {}", i.hostname.clone().unwrap_or_else(|| host.clone()), i.version)),
        (Conn::Connected(_), Stream::Lost(_)) => (RED, format!("{host} · disconnected, retrying…")),
        (Conn::Connected(_), _) => ("#d4a017", format!("{host} · connecting to events…")),
    };
    let mut buttons: Vec<El> = Vec::new();
    if !matches!(d.conn, Conn::Checking) {
        buttons.push(button("Reconnect", "oc-reconnect", Btn::Small, false, Box::new(reconnect)));
    }
    buttons.push(button("Forget", "oc-forget", Btn::Small, false, Box::new(forget)));
    let bw = 190.0;
    row()
        .key("oc-status")
        .w(w)
        .gap(8.0)
        .center_y()
        .child(experimental())
        .child(el().key("oc-status-dot").size(8.0, 8.0).radius(4.0).fill(c(dot)))
        .child(text(line).key("oc-status-text").font(TextStyle::new(12.5, 400.0).lh(16.0)).color(c(INK_2)).w(w - 8.0 - 8.0 - 100.0 - bw).truncate())
        .child(row().key("oc-status-buttons").w(bw).gap(6.0).justify_end().children(buttons))
}

/// The connection's problem, if any: what's wrong and what to do.
fn conn_problem(d: &OcDlg, w: f32, kids: &mut Vec<El>) {
    match (&d.conn, &d.stream) {
        (Conn::Refused, _) => {
            kids.push(form_error("The server no longer accepts this Mac's pairing: its password changed, or the pairing expired (after 30 days). Pair again with a new link from opencode pair.", "oc-refused", w));
            kids.push(row().key("oc-pair-again-row").w(w).justify_end().child(button("Pair again…", "oc-pair-again", Btn::Primary, false, Box::new(pair_again))));
        }
        (Conn::Failed(why), _) => kids.push(form_error(&format!("Couldn't reach the server: {why}. Check that OpenCode is running and this Mac can reach it, then Reconnect."), "oc-failed", w)),
        (Conn::Connected(_), Stream::Lost(why)) => kids.push(hint(format!("Live updates stopped ({why}); reconnecting by itself."), "oc-lost", w)),
        _ => {}
    }
}

fn list_h(vh: f32, reserved: f32) -> f32 {
    (vh - 48.0 - reserved).clamp(120.0, 440.0)
}

fn sessions_body(d: &OcDlg, w: f32, vh: f32) -> Vec<El> {
    let mut kids = vec![status_row(d, w)];
    if let Some(tools) = crate::oc_tools::summary() {
        kids.push(muted(&tools, "oc-tools-status", w));
    }
    conn_problem(d, w, &mut kids);
    let extra = if matches!(d.conn, Conn::Connected(_)) && !matches!(d.stream, Stream::Lost(_)) { 0.0 } else { 90.0 };
    match &d.sessions {
        // refused: nothing here works until it's paired again
        _ if d.conn == Conn::Refused => {}
        None if matches!(d.conn, Conn::Checking) => kids.push(muted("Loading sessions…", "oc-sessions-loading", w)),
        None => {}
        Some(list) => {
            let top: Vec<&Session> = list.iter().filter(|s| s.parent.is_none()).collect();
            kids.push(label(&format!("Sessions ({})", top.len()), "oc-sessions-label"));
            if top.is_empty() {
                kids.push(muted("No sessions on this server yet. Start one in OpenCode.", "oc-sessions-empty", w));
            } else {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |t| t.as_millis() as i64);
                let rows: Vec<El> = top.iter().map(|s| session_row(s, now, w - 4.0)).collect();
                kids.push(
                    col()
                        .key("oc-sessions")
                        .w(w)
                        .h(list_h(vh, 210.0 + extra + if crate::oc_tools::summary().is_some() { 24.0 } else { 0.0 }))
                        .radius(6.0)
                        .border(1.0, line())
                        .clip_soft(0.0)
                        .scroll(ScrollSpec { stick_bottom: false })
                        .child(col().key("oc-sessions-list").w(w - 2.0).py(2.0).children(rows)),
                );
            }
        }
    }
    kids.push(actions(vec![button("Done", "dlg-done", Btn::Primary, false, Box::new(close))], "dlg-actions", w));
    kids
}

/// The last two parts of a path (`projects/grim`).
fn short_dir(dir: &str) -> String {
    let parts: Vec<&str> = dir.trim_end_matches('/').rsplit('/').take(2).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

fn session_row(s: &Session, now: i64, w: f32) -> El {
    let title = if s.title.trim().is_empty() { "Untitled session".to_string() } else { s.title.clone() };
    let meta = format!("{} · {}", short_dir(&s.directory), crate::history::relative_time(s.updated, now));
    let key = format!("oc-session-{}", s.id);
    let s2 = s.clone();
    col()
        .key(key.clone())
        .label(title.clone())
        .w(w)
        .px(10.0)
        .py(7.0)
        .gap(2.0)
        .radius(5.0)
        .hover(c(PAPER_2))
        .child(text(title).key(format!("{key}-title")).font(TextStyle::new(13.5, crate::theme::wt(550.0)).lh(18.0)).color(c(INK)).w(w - 20.0).truncate())
        .child(text(meta).key(format!("{key}-meta")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).w(w - 20.0).truncate())
        .on_drag(on_down(Box::new(move |app: &mut App, tx: &mut Tx| open_session(app, s2.clone(), tx))))
}

fn session_body(d: &OcDlg, w: f32, vh: f32) -> Vec<El> {
    let Some(s) = &d.session else { return Vec::new() };
    let title = if s.title.trim().is_empty() { "Untitled session".to_string() } else { s.title.clone() };
    let mut kids = vec![
        status_row(d, w),
        row()
            .key("oc-session-head")
            .w(w)
            .gap(10.0)
            .center_y()
            .child(button("‹ Sessions", "oc-back", Btn::Small, false, Box::new(back)))
            .child(text(title).key("oc-session-title").font(TextStyle::new(14.0, crate::theme::wt(600.0)).lh(18.0)).color(c(INK)).w(w - 110.0).truncate()),
    ];
    conn_problem(d, w, &mut kids);
    let extra = if matches!(d.conn, Conn::Connected(_)) && !matches!(d.stream, Stream::Lost(_)) { 0.0 } else { 90.0 } + if d.chat_error.is_some() { 50.0 } else { 0.0 };
    let tw = w - 28.0;
    let mut entries: Vec<El> = Vec::new();
    match &d.messages {
        None => entries.push(muted("Loading messages…", "oc-msgs-loading", tw)),
        Some(list) if list.is_empty() && !d.working => entries.push(muted("No messages yet.", "oc-msgs-empty", tw)),
        Some(list) => {
            for (i, m) in list.iter().enumerate() {
                // the reply streaming in
                let live = d.working && !m.user && i + 1 == list.len();
                entries.push(message(m, live, tw));
            }
        }
    }
    if d.working && !d.messages.as_ref().and_then(|l| l.last()).is_some_and(|m| !m.user && !m.text.is_empty()) {
        entries.push(muted("Working…", "oc-working", tw));
    }
    kids.push(
        col()
            .key("oc-transcript")
            .w(w)
            .h(list_h(vh, 280.0 + extra))
            .radius(6.0)
            .fill(c(PAPER_2))
            .border(1.0, line())
            .clip_soft(0.0)
            .scroll(ScrollSpec { stick_bottom: true })
            .child(col().key("oc-transcript-list").w(w - 2.0).px(13.0).py(12.0).gap(14.0).children(entries)),
    );
    if let Some(e) = &d.chat_error {
        kids.push(form_error(e, "oc-chat-error", w));
    }
    let can_send = !d.sending && !d.prompt.text.trim().is_empty() && d.messages.is_some() && matches!(d.conn, Conn::Connected(_));
    kids.push(
        row()
            .key("oc-compose")
            .w(w)
            .gap(8.0)
            .center_y()
            .child(field("oc-prompt", &d.prompt, "Message this session…", 3, w - 78.0, send))
            .child(button(if d.sending { "Sending…" } else { "Send" }, "oc-send", Btn::Primary, !can_send, Box::new(send)).w(70.0)),
    );
    kids.push(hint("Plain text only. The reply streams in from the server; OpenCode runs the session with its own agent and permissions.", "oc-compose-hint", w));
    kids
}

fn message(m: &Msg, live: bool, w: f32) -> El {
    let who = if m.user { "You" } else if live { "OpenCode · writing…" } else { "OpenCode" };
    let mut body = m.text.clone();
    let n = body.chars().count();
    if n > MAX_CHARS {
        body = format!("…{}", body.chars().skip(n - MAX_CHARS).collect::<String>());
    }
    let key = format!("oc-msg-{}", m.id);
    let mut c_ = col()
        .key(key.clone())
        .w(w)
        .gap(3.0)
        .child(text(who).key(format!("{key}-who")).font(TextStyle::new(12.0, crate::theme::wt(650.0)).lh(15.0)).color(c(if m.user { LINK } else { INK_2 })));
    if !body.trim().is_empty() {
        c_ = c_.child(text(body).key(format!("{key}-text")).font(TextStyle::new(13.5, 400.0).lh(20.0)).color(c(INK)).w(w).wrap());
    }
    if !m.tools.is_empty() {
        let mut names: Vec<String> = Vec::new();
        for t in &m.tools {
            if !names.contains(t) {
                names.push(t.clone());
            }
        }
        c_ = c_.child(text(format!("Used {}", names.join(", "))).key(format!("{key}-tools")).font(TextStyle::new(12.0, 400.0).lh(16.0)).color(c(MUTED)).w(w).wrap());
    }
    if let Some(e) = &m.error {
        c_ = c_.child(text(e.clone()).key(format!("{key}-error")).font(TextStyle::new(12.5, 400.0).lh(17.0)).color(c(RED)).w(w).wrap());
    }
    c_
}

// ---- headless demo (snapshots) ----

/// `--opencode-demo=pair|password|sessions|session|refused`: the dialog in that state with made-up data.
pub fn demo(app: &mut App, state: &str) {
    let mut d = OcDlg::new();
    let p = Pairing { url: "http://100.73.96.98:49374".into(), password: "demo".into() };
    let info = Info { version: "0.0.0-dev-21233".into(), hostname: Some("devbox".into()) };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |t| t.as_millis() as i64);
    let ses = |id: &str, title: &str, dir: &str, ago: i64| Session { id: id.into(), title: title.into(), directory: dir.into(), updated: now - ago, parent: None };
    let sessions = vec![
        ses("ses_1", "Grim Mac: pair with OpenCode server", "/root/projects/grimoire-native", 40_000),
        ses("ses_2", "Fix the event stream reconnect", "/root/projects/opencode", 25 * 60_000),
        ses("ses_3", "Release notes for 1.18", "/root/projects/opencode", 5 * 3_600_000),
        ses("ses_4", "", "/tmp/opencode/grimpair", 3 * 86_400_000),
    ];
    match state {
        "password" => {
            d.method = Method::Password;
            d.server = TextEdit::new("http://100.73.96.98:49374");
            d.password = TextEdit::new("secret");
            d.focus(Some(2));
            d.error = Some("Wrong password.".into());
        }
        "sessions" | "session" | "refused" => {
            d.client = Some(Client::new(p));
            d.page = Page::Sessions;
            d.conn = if state == "refused" { Conn::Refused } else { Conn::Connected(info) };
            d.stream = Stream::Live;
            d.sessions = Some(sessions.clone());
            if state == "session" {
                d.page = Page::Session;
                d.session = Some(sessions[0].clone());
                let m = |id: &str, user: bool, text: &str, tools: &[&str]| Msg { id: id.into(), user, text: text.into(), tools: tools.iter().map(|t| t.to_string()).collect(), error: None, ordinal: 0 };
                d.messages = Some(vec![
                    m("m1", true, "What does the pairing link carry?", &[]),
                    m("m2", false, "A single-use code. The app redeems it at /auth/connect/<code> for a session token and then signs every request with HTTP Basic opencode:<token>.", &["read", "grep"]),
                    m("m3", true, "Reply with exactly: pong from opencode", &[]),
                    m("m4", false, "pong from", &[]),
                ]);
                d.working = true;
                d.prompt = TextEdit::new("");
                d.focus(Some(3));
            }
        }
        _ => {
            d.link = TextEdit::new("http://100.73.96.98:49374/auth/connect/MWClz7TUU2yW3U88stV_Iw");
            d.focus(Some(0));
        }
    }
    app.dialog = Some(Dialog::OpenCode(Box::new(d)));
}

/// `--opencode-ui-selftest=<pairing link>` (`--opencode-session=<id>` or `--opencode-dir=<directory on the server>`,
/// `--opencode-prompt=`): this dialog's own code against a real server, headless, its threads' updates through a
/// channel: the pairing form, the pairing kept, the dialog opened again from it, a session's messages, a prompt
/// sent and its reply streaming in, Forget. Exit status 0 when every step passed.
pub fn ui_selftest(args: &[String]) -> i32 {
    use crate::remote::{Handle, Update};
    use std::time::Instant;
    let arg = |name: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_string));
    let Some(link) = arg("opencode-ui-selftest") else { return 2 };
    let dir = std::env::temp_dir().join(format!("grim-opencode-ui-selftest-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let (utx, urx) = std::sync::mpsc::channel::<Update>();
    let mut app = App::new("", None, true);
    app.backend = Backend::Net(Handle::Chan(utx));
    app.tokens = crate::workspaces::Tokens::File(dir.join("tokens.json"));
    let mut tx = Tx::default();
    let st = |app: &App| match &app.dialog {
        Some(Dialog::OpenCode(d)) => Some(d.as_ref().clone()),
        _ => None,
    };
    let pump = |app: &mut App, tx: &mut Tx, secs: u64, cond: &dyn Fn(&OcDlg) -> bool, seen: &mut dyn FnMut(&OcDlg)| -> bool {
        let until = Instant::now() + Duration::from_secs(secs);
        loop {
            if let Some(d) = st(app) {
                seen(&d);
                if cond(&d) {
                    return true;
                }
            }
            let Some(left) = until.checked_duration_since(Instant::now()) else { return false };
            match urx.recv_timeout(left) {
                Ok(u) => u(app, tx),
                Err(_) => return false,
            }
        }
    };
    let mut ok = true;
    let mut check = |pass: bool, what: &str| {
        eprintln!("opencode ui selftest: {} {what}", if pass { "ok" } else { "FAILED" });
        ok &= pass;
    };
    let live = |d: &OcDlg| matches!(d.conn, Conn::Connected(_)) && d.stream == Stream::Live && d.sessions.is_some();
    // the form: paste the link, Connect
    app.open_opencode(&mut tx);
    check(st(&app).is_some_and(|d| d.page == Page::Pair && d.link.focused), "unpaired: the pairing form, its field focused");
    if let Some(d) = dlg(&mut app) {
        d.link = TextEdit::new(&link);
    }
    submit_pair(&mut app, &mut tx);
    let t = Instant::now();
    let paired = pump(&mut app, &mut tx, 30, &|d| live(d) || d.error.is_some(), &mut |_| {});
    let d = st(&app);
    check(paired && d.as_ref().is_some_and(live), &format!("paired: sessions and a live event stream after {} ms ({:?})", t.elapsed().as_millis(), d.as_ref().and_then(|d| d.error.clone())));
    if !paired {
        let _ = std::fs::remove_dir_all(&dir);
        return 1;
    }
    let stored = opencode::load(&app.tokens);
    check(stored.is_some(), &format!("the pairing kept ({})", stored.as_ref().map_or(String::new(), |p| p.url.clone())));
    // closed and opened again: straight to the sessions, from what was kept
    app.dialog = None;
    app.open_opencode(&mut tx);
    check(st(&app).is_some_and(|d| d.page == Page::Sessions), "opened again: the sessions page");
    check(pump(&mut app, &mut tx, 30, &live, &mut |_| {}), "connected again from the kept pairing");
    let n = st(&app).and_then(|d| d.sessions.map(|s| s.iter().filter(|s| s.parent.is_none()).count())).unwrap_or(0);
    eprintln!("opencode ui selftest: {n} top-level sessions");
    let client = Client::new(stored.unwrap_or_else(|| Pairing { url: String::new(), password: String::new() }));
    let session = match arg("opencode-session") {
        Some(id) => Session { id, title: String::new(), directory: String::new(), updated: 0, parent: None },
        None => match client.create_session(Some("Grim dialog selftest"), arg("opencode-dir").as_deref()) {
            Ok(s) => s,
            Err(e) => {
                check(false, &format!("create a session: {e}"));
                return 1;
            }
        },
    };
    open_session(&mut app, session.clone(), &mut tx);
    check(pump(&mut app, &mut tx, 20, &|d| d.messages.is_some(), &mut |_| {}), &format!("session {}: its messages", session.id));
    let before = st(&app).and_then(|d| d.messages.map(|m| m.len())).unwrap_or(0);
    let text = arg("opencode-prompt").unwrap_or_else(|| "Reply with exactly: pong from opencode".into());
    if let Some(d) = dlg(&mut app) {
        d.prompt = TextEdit::new(&text);
    }
    send(&mut app, &mut tx);
    check(st(&app).is_some_and(|d| d.sending && d.prompt.text.is_empty()), "sent: the field cleared, sending");
    let mut streamed = 0usize;
    let mut texts: Vec<String> = Vec::new();
    let done = pump(
        &mut app,
        &mut tx,
        180,
        &|d| !d.working && !d.sending && d.messages.as_ref().and_then(|m| m.last()).is_some_and(|m| !m.user && !m.text.is_empty()),
        &mut |d| {
            if d.working
                && let Some(m) = d.messages.as_ref().and_then(|m| m.last()).filter(|m| !m.user && !m.text.is_empty())
                && texts.last() != Some(&m.text)
            {
                streamed += 1;
                texts.push(m.text.clone());
            }
        },
    );
    let d = st(&app);
    let last = d.as_ref().and_then(|d| d.messages.as_ref()?.last().cloned());
    check(done, &format!("the reply: {:?}; seen streaming {streamed} time(s) ({:?}); error {:?}", last.as_ref().map(|m| m.text.clone()), texts, d.as_ref().and_then(|d| d.chat_error.clone())));
    let after = d.as_ref().and_then(|d| d.messages.as_ref().map(|m| m.len())).unwrap_or(0);
    check(after >= before + 2, &format!("the prompt and the reply in the transcript ({before} → {after} messages)"));
    check(d.as_ref().and_then(|d| d.messages.as_ref()).is_some_and(|m| !m.iter().any(|m| m.id.starts_with("local-"))), "the prompt got its server id");
    // Forget
    forget(&mut app, &mut tx);
    check(opencode::load(&app.tokens).is_none() && st(&app).is_some_and(|d| d.page == Page::Pair && d.stop.is_none()), "Forget: nothing kept, the form again");
    app.dialog = None;
    let _ = std::fs::remove_dir_all(&dir);
    if ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streamed_text_parts_join_with_a_blank_line() {
        let mut list = Vec::new();
        reply(&mut list, "msg_1", 0).text.push_str("Hello");
        reply(&mut list, "msg_1", 1).text.push_str("World");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].text, "Hello\n\nWorld");
        assert_eq!(short_dir("/root/projects/grim/"), "projects/grim");
    }
}
