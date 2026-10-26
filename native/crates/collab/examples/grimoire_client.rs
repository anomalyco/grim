//! A scriptable Grimoire multiplayer client: connects to a room over WebSocket, prints events as JSON lines on
//! stdout and takes commands on stdin (one per line):
//!   replace FROM TO "json string" · append "json string" · cursor A H · nocursor · stop · undo · redo
//!   text · cursors · pause · resume · flush · quit
//! Usage: grimoire_client http://HOST:PORT REPO PATH (--login NAME | --cookie np_session=...)

use std::io::{BufRead, ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;

use collab::{Event, Session, YrsStore};
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

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
    let (mut ws, _) = tungstenite::connect(req).expect("websocket connect");
    if let MaybeTlsStream::Plain(s) = ws.get_mut() {
        s.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
    }

    let client_id: u32 = (std::process::id() ^ (now_nanos() as u32)) | 1;
    let mut sess = Session::new(YrsStore::new(client_id), json!({ "name": "Rust" }));
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

    let mut paused = false;
    let mut cursor: Option<(u32, u32)> = None;
    loop {
        while let Ok(line) = rx.try_recv() {
            if !command(&mut sess, &line, &mut paused, &mut cursor) {
                sess.leave();
                send_all(&mut ws, &mut sess);
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
        send_all(&mut ws, &mut sess);
        match ws.read() {
            Ok(Message::Binary(data)) => match sess.receive(&data) {
                Ok(events) => {
                    for e in events {
                        report(&sess, e, cursor);
                    }
                }
                Err(e) => say(json!({ "ev": "error", "error": e })),
            },
            Ok(Message::Close(f)) => {
                say(json!({ "ev": "closed", "frame": format!("{f:?}") }));
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

fn command(sess: &mut Session, line: &str, paused: &mut bool, cursor: &mut Option<(u32, u32)>) -> bool {
    let mut it = line.splitn(2, ' ');
    let cmd = it.next().unwrap_or("");
    let rest = it.next().unwrap_or("");
    let nums = |n: usize| -> Vec<u32> { rest.split_whitespace().take(n).map(|x| x.parse().unwrap()).collect() };
    match cmd {
        "replace" => {
            let n = nums(2);
            let s: String = serde_json::from_str(rest.splitn(3, ' ').nth(2).unwrap()).unwrap();
            edit(sess, n[0], n[1], &s, cursor);
        }
        "append" => {
            let s: String = serde_json::from_str(rest).unwrap();
            let len = sess.store.len();
            edit(sess, len, len, &s, cursor);
        }
        "cursor" => {
            let n = nums(2);
            *cursor = Some((n[0], n[1]));
            sess.set_cursor(*cursor);
        }
        "nocursor" => {
            *cursor = None;
            sess.set_cursor(None);
        }
        "stop" => sess.store.stop_capturing(),
        "undo" | "redo" => {
            let r = if cmd == "undo" { sess.store.undo() } else { sess.store.redo() };
            if let Some(sel) = r.as_ref().and_then(|r| r.sel) {
                *cursor = Some(sel);
                sess.set_cursor(*cursor);
            }
            say(json!({ "ev": cmd, "done": r.is_some(), "sel": r.as_ref().and_then(|r| r.sel), "text": sess.store.text() }));
        }
        "text" => say(json!({ "ev": "text", "text": sess.store.text() })),
        "cursors" => say(json!({ "ev": "cursors", "cursors": cursors(sess) })),
        "pause" => {
            *paused = true;
            say(json!({ "ev": "paused" }));
        }
        "resume" => {
            *paused = false;
            say(json!({ "ev": "resumed" }));
        }
        "flush" => sess.request_flush(),
        "quit" => return false,
        _ => say(json!({ "ev": "error", "error": format!("unknown command {line}") })),
    }
    true
}

/// A local edit the way the editor will do it: selection before/after for undo, then publish the caret.
fn edit(sess: &mut Session, from: u32, to: u32, s: &str, cursor: &mut Option<(u32, u32)>) {
    let (a, h) = cursor.unwrap_or((from, to));
    sess.store.will_edit(a, h, "input");
    sess.store.replace(from, to, s);
    let end = from + collab::store::utf16_len(s);
    sess.store.did_edit(end, end);
    *cursor = Some((end, end));
    sess.set_cursor(*cursor);
    say(json!({ "ev": "edited", "text": sess.store.text() }));
}

fn report(sess: &Session, e: Event, cursor: Option<(u32, u32)>) {
    match e {
        Event::Hello { generation, read_only } => say(json!({ "ev": "hello", "generation": generation, "readOnly": read_only })),
        Event::Synced => say(json!({ "ev": "synced", "text": sess.store.text() })),
        Event::Changes(cs) => {
            for c in cs {
                let edits: Vec<Value> = c.edits.iter().map(|e| json!([e.from, e.to, e.insert])).collect();
                say(json!({ "ev": "remote", "kind": format!("{:?}", c.kind), "edits": edits, "text": sess.store.text(), "cursor": cursor }));
            }
        }
        Event::Awareness => say(json!({ "ev": "awareness", "cursors": cursors(sess) })),
        Event::Control(v) => say(json!({ "ev": "control", "msg": v })),
    }
}

fn cursors(sess: &Session) -> Vec<Value> {
    sess.remote_cursors()
        .into_iter()
        .map(|c| json!({ "client": c.client, "name": c.user["name"], "anchor": c.anchor, "head": c.head }))
        .collect()
}

fn send_all(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>, sess: &mut Session) {
    for frame in sess.take_outgoing() {
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
