//! A small blocking HTTP/1.1 client (http, and https through the system's TLS) for the server's REST API,
//! URL helpers, and the loopback listener of the connect flow. Everything here runs on background threads;
//! the UI thread never waits on the network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde_json::Value;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(20);
/// Bodies larger than this are refused (a tree or a workspace list is a few kB).
const MAX_BODY: usize = 32 << 20;

/// `scheme://host[:port]` plus the rest, as parsed by `parse_url`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Url {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    /// Starts with `/` (query included).
    pub path: String,
}

impl Url {
    /// `https://host` (the port only when it isn't the scheme's default).
    pub fn origin(&self) -> String {
        let scheme = if self.tls { "https" } else { "http" };
        let default = if self.tls { 443 } else { 80 };
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        if self.port == default { format!("{scheme}://{host}") } else { format!("{scheme}://{host}:{}", self.port) }
    }

    /// The host for display (`grimoire.exe.xyz`, `100.1.2.3:3000`).
    pub fn display_host(&self) -> String {
        let o = self.origin();
        o.split_once("://").map_or(o.clone(), |(_, h)| h.to_string())
    }
}

/// An http(s) URL. A missing scheme means https. User info and fragments are dropped.
pub fn parse_url(s: &str) -> Result<Url, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("Enter a URL".into());
    }
    let (tls, rest) = if let Some(r) = strip_prefix_ci(s, "https://") {
        (true, r)
    } else if let Some(r) = strip_prefix_ci(s, "http://") {
        (false, r)
    } else if s.contains("://") {
        return Err("Only http and https URLs work".into());
    } else {
        (true, s)
    };
    let rest = rest.split('#').next().unwrap_or("");
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let authority = authority.rsplit('@').next().unwrap_or("");
    let (host, port) = if let Some(r) = authority.strip_prefix('[') {
        let (h, after) = r.split_once(']').ok_or("Invalid host")?;
        (h.to_string(), after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c == '/' || c == '\\') {
        return Err("Invalid host".into());
    }
    let port = match port {
        Some(p) => p.parse::<u16>().map_err(|_| "Invalid port".to_string())?,
        None if tls => 443,
        None => 80,
    };
    let path = if path.is_empty() { "/".to_string() } else if path.starts_with('?') { format!("/{path}") } else { path.to_string() };
    Ok(Url { tls, host: host.to_lowercase(), port, path })
}

fn strip_prefix_ci<'a>(s: &'a str, p: &str) -> Option<&'a str> {
    (s.len() >= p.len() && s[..p.len()].eq_ignore_ascii_case(p)).then(|| &s[p.len()..])
}

/// Percent-encode a query value or path segment (unreserved characters stay).
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `%XX` decoded (invalid escapes kept as they are; invalid UTF-8 replaced).
pub fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A query parameter's decoded value.
pub fn query_param(path: &str, name: &str) -> Option<String> {
    let q = path.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (dec(k) == name).then(|| dec(v))
    })
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(&self) -> Result<Value, String> {
        serde_json::from_slice(&self.body).map_err(|e| format!("bad JSON from the server: {e}"))
    }

    /// The server's `{error}` message, or the status.
    pub fn error(&self) -> String {
        self.json()
            .ok()
            .and_then(|v| v["error"].as_str().map(str::to_string))
            .unwrap_or_else(|| format!("HTTP {}", self.status))
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Either kind of stream the client talks over.
pub enum Stream {
    Plain(TcpStream),
    Tls(Box<native_tls::TlsStream<TcpStream>>),
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(s) => s.read(buf),
            Stream::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(s) => s.write(buf),
            Stream::Tls(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Stream::Plain(s) => s.flush(),
            Stream::Tls(s) => s.flush(),
        }
    }
}

/// A TCP connection with timeouts (the first address that answers).
pub fn tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs = (host, port).to_socket_addrs().map_err(|e| format!("can't find {host}: {e}"))?;
    let mut last = format!("can't reach {host}");
    for a in addrs {
        match TcpStream::connect_timeout(&a, CONNECT_TIMEOUT) {
            Ok(s) => {
                s.set_read_timeout(Some(IO_TIMEOUT)).ok();
                s.set_write_timeout(Some(IO_TIMEOUT)).ok();
                s.set_nodelay(true).ok();
                return Ok(s);
            }
            Err(e) => last = format!("can't reach {host}:{port}: {e}"),
        }
    }
    Err(last)
}

/// A connection to `url`'s host, TLS when it's https.
pub fn connect(url: &Url) -> Result<Stream, String> {
    let s = tcp(&url.host, url.port)?;
    if !url.tls {
        return Ok(Stream::Plain(s));
    }
    let c = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    let t = c.connect(&url.host, s).map_err(|e| format!("TLS with {}: {e}", url.host))?;
    Ok(Stream::Tls(Box::new(t)))
}

/// One request (`Connection: close`). `bearer` goes into `Authorization`; a body is sent as JSON.
pub fn request(method: &str, url: &str, bearer: Option<&str>, body: Option<&Value>) -> Result<Response, String> {
    let auth = bearer.map(|t| format!("Bearer {t}"));
    let mut headers: Vec<(&str, &str)> = vec![("Accept", "application/json")];
    if let Some(a) = &auth {
        headers.push(("Authorization", a));
    }
    let payload = body.map(|b| b.to_string());
    if payload.is_some() {
        headers.push(("Content-Type", "application/json"));
    }
    raw(method, url, &headers, payload.as_deref().map(str::as_bytes)).map(|(status, _, body)| Response { status, body })
}

/// Status, headers (names lower-case) and body.
pub type Raw = (u16, Vec<(String, String)>, Vec<u8>);

/// A request with any headers and body; the response's status, headers (names lower-case) and body.
pub fn raw(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>) -> Result<Raw, String> {
    let u = parse_url(url)?;
    let mut s = connect(&u)?;
    let mut head = format!(
        "{method} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: Grimoire-Mac/{}\r\nConnection: close\r\n",
        u.path,
        u.display_host(),
        env!("CARGO_PKG_VERSION")
    );
    for (k, v) in headers {
        if k.contains(['\r', '\n']) || v.contains(['\r', '\n']) {
            return Err("bad header".into());
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    match body {
        Some(b) => head.push_str(&format!("Content-Length: {}\r\n", b.len())),
        None if method != "GET" && method != "HEAD" => head.push_str("Content-Length: 0\r\n"),
        None => {}
    }
    head.push_str("\r\n");
    let send = |s: &mut Stream| -> std::io::Result<()> {
        s.write_all(head.as_bytes())?;
        if let Some(b) = body {
            s.write_all(b)?;
        }
        s.flush()
    };
    send(&mut s).map_err(|e| format!("{}: {e}", u.display_host()))?;
    read_response(s).map_err(|e| format!("{}: {e}", u.display_host()))
}

#[cfg(test)]
pub fn get(url: &str, bearer: Option<&str>) -> Result<Response, String> {
    request("GET", url, bearer, None)
}

fn read_response(s: Stream) -> Result<Raw, String> {
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    let status: u16 = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or("not an HTTP response")?;
    let (mut len, mut chunked) = (None, false);
    let mut headers = Vec::new();
    loop {
        line.clear();
        if r.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
            if k == "content-length" {
                len = v.parse::<usize>().ok();
            } else if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
            headers.push((k, v.to_string()));
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            line.clear();
            r.read_line(&mut line).map_err(|e| e.to_string())?;
            let n = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16).map_err(|_| "bad chunk")?;
            if n == 0 {
                break;
            }
            if body.len() + n > MAX_BODY {
                return Err("response too large".into());
            }
            let at = body.len();
            body.resize(at + n, 0);
            r.read_exact(&mut body[at..]).map_err(|e| e.to_string())?;
            line.clear();
            r.read_line(&mut line).map_err(|e| e.to_string())?;
        }
    } else if let Some(n) = len {
        if n > MAX_BODY {
            return Err("response too large".into());
        }
        body.resize(n, 0);
        r.read_exact(&mut body).map_err(|e| e.to_string())?;
    } else {
        r.take(MAX_BODY as u64).read_to_end(&mut body).map_err(|e| e.to_string())?;
    }
    Ok((status, headers, body))
}

// ---- the loopback listener (connect flow) ----

/// A listener on 127.0.0.1 at a port the system picks.
pub fn loopback() -> std::io::Result<(TcpListener, u16)> {
    let l = TcpListener::bind(("127.0.0.1", 0))?;
    let port = l.local_addr()?.port();
    Ok((l, port))
}

/// Wait (up to `timeout`) for `GET /callback?...` on `l`; answer every request with a small page. Returns
/// the callback's path and query. Requests for other paths (a favicon) are answered 404 and skipped.
pub fn accept_callback(l: &TcpListener, timeout: Duration) -> Result<String, String> {
    l.set_nonblocking(true).map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    loop {
        match l.accept() {
            Ok((s, _)) => {
                s.set_nonblocking(false).ok();
                s.set_read_timeout(Some(Duration::from_secs(5))).ok();
                if let Some(target) = serve_one(s) {
                    return Ok(target);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if start.elapsed() > timeout {
                    return Err("Timed out waiting for the browser".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn serve_one(s: TcpStream) -> Option<String> {
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let target = line.split_whitespace().nth(1)?.to_string();
    // the rest of the head
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 || h.trim().is_empty() {
            break;
        }
    }
    let mut s = r.into_inner();
    let ok = target.starts_with("/callback?") || target == "/callback";
    let (status, page) = if ok {
        ("200 OK", "<!doctype html><meta charset=utf-8><title>Grimoire</title><body style=\"font:15px -apple-system,sans-serif;padding:48px;color:#1d1e22\"><h2>Grimoire for Mac is connected.</h2><p>You can close this tab and go back to the app.</p>")
    } else {
        ("404 Not Found", "not found")
    };
    let _ = write!(
        s,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{page}",
        page.len()
    );
    let _ = s.flush();
    ok.then_some(target)
}

/// Random bytes from the system, as hex.
pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        // never expected; still unpredictable enough for a session id, not for secrets
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        for (i, x) in b.iter_mut().enumerate() {
            *x = (t >> ((i % 16) * 8)) as u8 ^ (std::process::id() as u8);
        }
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn urls() {
        let u = parse_url("https://grimoire.exe.xyz/app/notes/a%20b.md").unwrap();
        assert_eq!((u.tls, u.host.as_str(), u.port, u.path.as_str()), (true, "grimoire.exe.xyz", 443, "/app/notes/a%20b.md"));
        assert_eq!(u.origin(), "https://grimoire.exe.xyz");
        let u = parse_url("http://100.73.96.98:3000").unwrap();
        assert_eq!((u.tls, u.port, u.path.as_str()), (false, 3000, "/"));
        assert_eq!(u.origin(), "http://100.73.96.98:3000");
        assert_eq!(u.display_host(), "100.73.96.98:3000");
        assert_eq!(parse_url("Grimoire.Exe.xyz/app/x").unwrap().origin(), "https://grimoire.exe.xyz");
        assert_eq!(parse_url("https://u:p@h.com:8443/x?y#z").unwrap(), Url { tls: true, host: "h.com".into(), port: 8443, path: "/x?y".into() });
        assert_eq!(parse_url("http://[::1]:9/").unwrap().origin(), "http://[::1]:9");
        assert!(parse_url("ftp://x").is_err());
        assert!(parse_url("").is_err());
        assert!(parse_url("https:///x").is_err());
        assert!(parse_url("https://h:99999/").is_err());
    }

    #[test]
    fn escapes() {
        assert_eq!(enc("a b/ü"), "a%20b%2F%C3%BC");
        assert_eq!(dec("a%20b%2F%C3%BC+x%zz"), "a b/ü x%zz");
        assert_eq!(query_param("/callback?token=t%2B1&state=s", "token").as_deref(), Some("t+1"));
        assert_eq!(query_param("/callback?token=t&state=s", "state").as_deref(), Some("s"));
        assert_eq!(query_param("/callback", "state"), None);
        assert_eq!(random_hex(16).len(), 32);
        assert_ne!(random_hex(16), random_hex(16));
    }

    /// A one-shot HTTP server on a thread: answers each connection with the next canned response and records
    /// the requests (head and body).
    pub fn mock_server(responses: Vec<(u16, String)>) -> (String, std::sync::mpsc::Receiver<String>) {
        let (l, port) = loopback().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let Ok((s, _)) = l.accept() else { return };
                let mut r = BufReader::new(s);
                let mut req = String::new();
                let mut len = 0;
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).unwrap_or(0) == 0 {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    req.push_str(&h);
                    if h.trim().is_empty() {
                        break;
                    }
                }
                let mut b = vec![0; len];
                let _ = r.read_exact(&mut b);
                req.push_str(&String::from_utf8_lossy(&b));
                let _ = tx.send(req);
                let mut s = r.into_inner();
                let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            }
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    #[test]
    fn requests_and_responses() {
        let (base, rx) = mock_server(vec![(200, r#"{"a":1}"#.into()), (404, r#"{"error":"repo not found"}"#.into())]);
        let r = request("POST", &format!("{base}/api/x?q=1"), Some("tok"), Some(&serde_json::json!({"path": "a.md"}))).unwrap();
        assert!(r.ok());
        assert_eq!(r.json().unwrap()["a"], 1);
        let req = rx.recv().unwrap();
        assert!(req.starts_with("POST /api/x?q=1 HTTP/1.1\r\n"), "{req}");
        assert!(req.contains("Authorization: Bearer tok\r\n"));
        assert!(req.contains("Content-Type: application/json\r\n"));
        assert!(req.ends_with(r#"{"path":"a.md"}"#));
        let r = get(&format!("{base}/api/y"), None).unwrap();
        assert_eq!((r.status, r.error()), (404, "repo not found".to_string()));
        assert!(!rx.recv().unwrap().contains("Authorization"));
    }

    #[test]
    fn chunked_bodies() {
        let (l, port) = loopback().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:2}\r\n0\r\n\r\n");
        });
        let r = get(&format!("http://127.0.0.1:{port}/"), None).unwrap();
        assert_eq!(r.json().unwrap()["a"], 2);
    }

    #[test]
    fn the_loopback_listener_takes_the_callback() {
        let (l, port) = loopback().unwrap();
        let h = std::thread::spawn(move || accept_callback(&l, Duration::from_secs(5)));
        let r = get(&format!("http://127.0.0.1:{port}/favicon.ico"), None).unwrap();
        assert_eq!(r.status, 404);
        let r = get(&format!("http://127.0.0.1:{port}/callback?token=abc&state=s1"), None).unwrap();
        assert_eq!(r.status, 200);
        assert!(String::from_utf8_lossy(&r.body).contains("connected"));
        assert_eq!(h.join().unwrap().unwrap(), "/callback?token=abc&state=s1");
        let (l, _) = loopback().unwrap();
        assert!(accept_callback(&l, Duration::from_millis(100)).is_err());
    }
}
