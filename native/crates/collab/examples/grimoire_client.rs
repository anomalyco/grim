//! A scriptable Grimoire multiplayer client on `CollabEditor` (editor-core's Editor on the shared doc): connects
//! to a room over WebSocket, prints events as JSON lines on stdout and takes commands on stdin (one per line;
//! offsets in UTF-16 code units, like the browser):
//!   replace FROM TO "json string" · append "json string" · cursor A H · nocursor · stop · undo · redo
//!   text · cursors · pause · resume · flush · quit
//! Usage: grimoire_client http://HOST:PORT REPO PATH (--login NAME | --cookie np_session=...)

use std::io::{BufRead, ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use collab::{CollabEditor, Notice, Received};
use editor_core::Sel;
use editor_core::text::{byte_to_utf16, utf16_to_byte};
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let base = args[1].trim_end_matches('/').to_string();
    let (repo, path) = (args[2].clone(), args[3].clone());
    let cookie = match args[4].as_str() {
        "--login" => dev_login(&base, &args[5]),
        _ => args[5].clone(),
    };
    say(json!({ "ev": "login", "cookie": cookie.split('=').next() }));

    let host = base.trim_start_matches("http://");
    let url = format!("ws://{host}/ws?repo={}&path={}", enc(&repo), enc(&path));
    let mut req = url.into_client_request().unwrap();
    req.headers_mut().insert("Cookie", cookie.parse().unwrap());
    req.headers_mut().insert("Origin", base.parse().unwrap());
    let client_id: u32 = (std::process::id() ^ (now_nanos() as u32)) | 1;
    let mut ce = CollabEditor::new(client_id, json!({ "id": "grimoire-client", "name": "Rust", "color": "#d33682", "kind": "human" }));
    ce.connecting();
    let (mut ws, _) = tungstenite::connect(req).expect("websocket connect");
    if let MaybeTlsStream::Plain(s) = ws.get_mut() {
        s.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
    }
    say(json!({ "ev": "connected", "client": client_id }));

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let start = Instant::now();
    let now = move || start.elapsed().as_secs_f64() * 1000.0;
    let mut paused = false;
    loop {
        while let Ok(line) = rx.try_recv() {
            if !command(&mut ce, &mut ws, &line, &mut paused, now()) {
                send(&mut ws, ce.leave());
                let _ = ws.close(None);
                let _ = ws.flush();
                say(json!({ "ev": "bye" }));
                return;
            }
        }
        if paused {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        let out = ce.take_outgoing(now());
        send(&mut ws, out.frames);
        match ws.read() {
            Ok(Message::Binary(data)) => match ce.receive(&data) {
                Ok(mut r) => {
                    send(&mut ws, std::mem::take(&mut r.outgoing));
                    report(&ce, r);
                }
                Err(e) => say(json!({ "ev": "error", "error": e })),
            },
            Ok(Message::Close(f)) => {
                let code = f.as_ref().map_or(1005, |f| u16::from(f.code));
                let reason = f.as_ref().map_or(String::new(), |f| f.reason.to_string());
                say(json!({ "ev": "closed", "frame": format!("{f:?}"), "after": format!("{:?}", ce.disconnected(code, &reason)) }));
                return;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => {
                say(json!({ "ev": "closed", "error": e.to_string() }));
                return;
            }
        }
    }
}

fn u16_to_b(ce: &CollabEditor, u: u32) -> usize {
    utf16_to_byte(ce.editor().text(), u as usize)
}

fn text16(ce: &CollabEditor) -> u32 {
    let t = ce.editor().text();
    byte_to_utf16(t, t.len()) as u32
}

fn sel16(ce: &CollabEditor) -> (u32, u32) {
    let t = ce.editor().text();
    let s = ce.editor().selection();
    (byte_to_utf16(t, s.anchor) as u32, byte_to_utf16(t, s.head) as u32)
}

fn command(ce: &mut CollabEditor, ws: &mut Ws, line: &str, paused: &mut bool, now: f64) -> bool {
    let mut it = line.splitn(2, ' ');
    let cmd = it.next().unwrap_or("");
    let rest = it.next().unwrap_or("");
    let nums = |n: usize| -> Vec<u32> { rest.split_whitespace().take(n).map(|x| x.parse().unwrap()).collect() };
    match cmd {
        "replace" => {
            let n = nums(2);
            let s: String = serde_json::from_str(rest.splitn(3, ' ').nth(2).unwrap()).unwrap();
            edit(ce, n[0], n[1], &s);
        }
        "append" => {
            let s: String = serde_json::from_str(rest).unwrap();
            let len = text16(ce);
            edit(ce, len, len, &s);
        }
        "cursor" => {
            let n = nums(2);
            let (a, h) = (u16_to_b(ce, n[0]), u16_to_b(ce, n[1]));
            ce.editor_mut().set_selection(Sel::new(a, h));
            send(ws, ce.set_focused(true, now));
        }
        "nocursor" => send(ws, ce.set_focused(false, now)),
        // a selection change ends the undo group
        "stop" => {
            let s = ce.editor().selection();
            ce.editor_mut().set_selection(s);
        }
        "undo" | "redo" => {
            let done = if cmd == "undo" { ce.editor_mut().undo() } else { ce.editor_mut().redo() };
            say(json!({ "ev": cmd, "done": done, "sel": sel16(ce), "text": ce.editor().text() }));
        }
        "text" => say(json!({ "ev": "text", "text": ce.editor().text() })),
        "cursors" => say(json!({ "ev": "cursors", "cursors": cursors(ce) })),
        "pause" => {
            *paused = true;
            say(json!({ "ev": "paused" }));
        }
        "resume" => {
            *paused = false;
            say(json!({ "ev": "resumed" }));
        }
        "flush" => send(ws, ce.request_flush()),
        "quit" => return false,
        _ => say(json!({ "ev": "error", "error": format!("unknown command {line}") })),
    }
    true
}

/// A local edit through the editor (undo grouping, history), as the web engine will make it.
fn edit(ce: &mut CollabEditor, from: u32, to: u32, s: &str) {
    let (a, b) = (u16_to_b(ce, from), u16_to_b(ce, to));
    ce.editor_mut().replace_range(a, b, s);
    say(json!({ "ev": "edited", "text": ce.editor().text() }));
}

fn report(ce: &CollabEditor, r: Received) {
    if !r.edits_utf16.is_empty() {
        let edits: Vec<Value> = r.edits_utf16.iter().map(|e| json!([e.from, e.to, e.insert])).collect();
        say(json!({ "ev": "remote", "edits": edits, "text": ce.editor().text(), "cursor": sel16(ce) }));
    }
    for n in r.notices {
        match n {
            Notice::Hello { read_only, msg } => say(json!({ "ev": "hello", "readOnly": read_only, "msg": msg })),
            Notice::Synced => say(json!({ "ev": "synced", "text": ce.editor().text() })),
            other => say(json!({ "ev": "notice", "notice": format!("{other:?}") })),
        }
    }
    if r.awareness {
        say(json!({ "ev": "awareness", "cursors": cursors(ce) }));
    }
}

fn cursors(ce: &CollabEditor) -> Vec<Value> {
    ce.remote_cursors()
        .into_iter()
        .map(|c| json!({ "client": c.client, "name": c.name, "color": c.color, "anchor": c.anchor_utf16, "head": c.head_utf16 }))
        .collect()
}

fn send(ws: &mut Ws, frames: Vec<Vec<u8>>) {
    for frame in frames {
        ws.send(Message::binary(frame)).expect("send");
    }
}

fn say(v: Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{v}").unwrap();
    out.flush().unwrap();
}

/// POST /auth/dev with a same-origin Origin header; returns "np_session=…".
fn dev_login(base: &str, name: &str) -> String {
    let host = base.trim_start_matches("http://");
    let body = json!({ "name": name }).to_string();
    let mut s = TcpStream::connect(host).expect("connect for login");
    write!(
        s,
        "POST /auth/dev HTTP/1.1\r\nHost: {host}\r\nOrigin: {base}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut resp = String::new();
    s.read_to_string(&mut resp).unwrap();
    resp.lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.eq_ignore_ascii_case("set-cookie") && v.trim().starts_with("np_session=")).then(|| v.trim().split(';').next().unwrap().to_string())
        })
        .unwrap_or_else(|| panic!("no session cookie in login response:\n{resp}"))
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}
