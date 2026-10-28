//! The app's WebSockets, event-driven: after the (blocking) TLS and WebSocket handshakes the socket goes non-blocking
//! and its thread sleeps in `mio::Poll` until the server sends something, the app queues a frame (a `mio::Waker`), or
//! the heartbeat is due. No read timeouts, no polling: an idle socket costs nothing.
//!
//! Used by the v1 per-note room socket and the v2 workspace socket (`ping`: its heartbeat interval, which `welcome`
//! can change while it runs).

use std::io::ErrorKind;
use std::net::TcpStream;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mio::unix::SourceFd;
use mio::{Events, Interest, Poll, Token, Waker};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::net;

pub type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

/// What the app sends to a socket thread.
pub enum ToSock {
    Frame(Vec<u8>),
    Close,
}

const SOCK: Token = Token(0);
const WAKE: Token = Token(1);

/// The app's end of a socket thread: queue a frame or the close, and wake the thread.
#[derive(Clone)]
pub struct SockTx {
    tx: Sender<ToSock>,
    waker: Arc<Waker>,
}

impl SockTx {
    /// False once the socket thread is gone.
    pub fn send(&self, m: ToSock) -> bool {
        let ok = self.tx.send(m).is_ok();
        let _ = self.waker.wake();
        ok
    }
}

/// The heartbeat: send `"ping"` every `ms` (0 = none) and give up when the `"pong"` doesn't come within `timeout`.
#[derive(Clone)]
pub struct Heartbeat {
    pub ms: Arc<AtomicU64>,
    pub timeout: Duration,
}

/// What happened on the socket, for the thread's owner (called on the socket's thread).
pub trait SockEvents: Send + 'static {
    /// The handshake is done.
    fn opened(&mut self) {}
    fn frame(&mut self, data: Vec<u8>);
    /// A queued frame couldn't be written (the socket is failing).
    fn lost(&mut self) {}
    /// The socket is over: the close code and reason (1006 for a failure, 1000 after our `Close`).
    fn closed(self, code: u16, reason: String);
}

/// Open a WebSocket to `url` (`Authorization: Bearer` with a token; `Origin` the server's own) on a thread of its own.
pub fn spawn(server: String, url: String, token: Option<String>, heartbeat: Option<Heartbeat>, mut events: impl SockEvents) -> SockTx {
    let (tx, rx) = mpsc::channel::<ToSock>();
    let poll = Poll::new().expect("a poll");
    let waker = Arc::new(Waker::new(poll.registry(), WAKE).expect("a waker"));
    std::thread::spawn(move || {
        let (code, reason) = match connect(&server, &url, token.as_deref()) {
            Ok(ws) => {
                events.opened();
                run(ws, &rx, poll, heartbeat.as_ref(), &mut events)
            }
            Err(e) => (1006, e),
        };
        events.closed(code, reason);
    });
    SockTx { tx, waker }
}

/// The blocking handshakes (TCP, TLS for https, the upgrade).
pub fn connect(server: &str, url: &str, token: Option<&str>) -> Result<Ws, String> {
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    if let Some(t) = token {
        req.headers_mut().insert("Authorization", format!("Bearer {t}").parse().map_err(|_| "bad token")?);
    }
    // The server checks the origin of browser sockets; ours is the server's own.
    req.headers_mut().insert("Origin", server.parse().map_err(|_| "bad origin")?);
    let u = net::parse_url(server)?;
    let tcp = net::tcp(&u.host, u.port)?;
    let (ws, _) = tungstenite::client_tls(req, tcp).map_err(|e| e.to_string())?;
    Ok(ws)
}

fn tcp(ws: &Ws) -> Option<&TcpStream> {
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => Some(s),
        MaybeTlsStream::NativeTls(s) => Some(s.get_ref()),
        _ => None,
    }
}

fn would_block(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted))
}

/// Until the socket closes: queued frames out, frames in, the heartbeat. Sleeps in `poll` between events.
fn run(mut ws: Ws, rx: &Receiver<ToSock>, mut poll: Poll, heartbeat: Option<&Heartbeat>, events: &mut impl SockEvents) -> (u16, String) {
    let Some(stream) = tcp(&ws) else { return (1006, "unsupported stream".into()) };
    if let Err(e) = stream.set_nonblocking(true) {
        return (1006, e.to_string());
    }
    let fd = stream.as_raw_fd();
    if let Err(e) = poll.registry().register(&mut SourceFd(&fd), SOCK, Interest::READABLE) {
        return (1006, e.to_string());
    }
    let mut writable_wanted = false;
    let mut evs = Events::with_capacity(8);
    let interval = |hb: &Heartbeat| Duration::from_millis(hb.ms.load(Ordering::Relaxed));
    let mut next_ping = heartbeat.filter(|hb| !interval(hb).is_zero()).map(|hb| Instant::now() + interval(hb));
    let mut pong_due: Option<Instant> = None;
    loop {
        // queued frames out
        loop {
            match rx.try_recv() {
                Ok(ToSock::Frame(f)) => {
                    if let Err(e) = ws.write(Message::Binary(f.into()))
                        && !would_block(&e)
                    {
                        events.lost();
                        return (1006, e.to_string());
                    }
                }
                Ok(ToSock::Close) | Err(TryRecvError::Disconnected) => {
                    let _ = ws.close(None);
                    // best effort: the close frame goes out if the socket takes it now
                    let _ = ws.flush();
                    return (1000, "closed".into());
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        // the heartbeat
        let now = Instant::now();
        if let Some(hb) = heartbeat {
            if pong_due.is_some_and(|d| now >= d) {
                return (1006, "no pong".into());
            }
            if next_ping.is_some_and(|t| now >= t) {
                if let Err(e) = ws.write(Message::Text(collab::mux::PING.into()))
                    && !would_block(&e)
                {
                    return (1006, e.to_string());
                }
                pong_due.get_or_insert(now + hb.timeout);
                let ms = interval(hb);
                next_ping = (!ms.is_zero()).then(|| now + ms);
            }
        }
        // frames in, until the socket has no more (edge-triggered: always drain)
        loop {
            match ws.read() {
                Ok(Message::Binary(data)) => events.frame(data.to_vec()),
                Ok(Message::Text(t)) if t.as_str() == collab::mux::PONG => pong_due = None,
                Ok(Message::Close(f)) => {
                    let code = f.as_ref().map_or(1005, |f| u16::from(f.code));
                    return (code, f.map_or(String::new(), |f| f.reason.to_string()));
                }
                Ok(_) => {}
                Err(e) if would_block(&e) => break,
                Err(e) => return (1006, e.to_string()),
            }
        }
        // what's written so far (and tungstenite's replies to pings) goes out; what the socket can't take now waits
        // for it to be writable
        let pending = match ws.flush() {
            Ok(()) => false,
            Err(e) if would_block(&e) => true,
            Err(e) => {
                events.lost();
                return (1006, e.to_string());
            }
        };
        if pending != writable_wanted {
            writable_wanted = pending;
            let interest = if pending { Interest::READABLE | Interest::WRITABLE } else { Interest::READABLE };
            if let Err(e) = poll.registry().reregister(&mut SourceFd(&fd), SOCK, interest) {
                return (1006, e.to_string());
            }
        }
        // sleep until something happens: data, a queued frame, writable, or the heartbeat
        let now = Instant::now();
        let wake = [next_ping, pong_due].into_iter().flatten().min();
        let timeout = wake.map(|t| t.saturating_duration_since(now));
        if let Err(e) = poll.poll(&mut evs, timeout)
            && e.kind() != ErrorKind::Interrupted
        {
            return (1006, e.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;

    /// What the socket thread reports, as a channel.
    struct Report(Sender<Result<Vec<u8>, (u16, String)>>);

    impl SockEvents for Report {
        fn frame(&mut self, data: Vec<u8>) {
            let _ = self.0.send(Ok(data));
        }

        fn closed(self, code: u16, reason: String) {
            let _ = self.0.send(Err((code, reason)));
        }
    }

    /// A WebSocket server on a thread (one connection): echoes binary frames, answers `ping` with `pong` unless
    /// `pong` is false; blocks in `read` (no timeout), so it costs nothing while idle. Counts the pings.
    fn server(pong: bool) -> (String, Arc<AtomicUsize>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("127.0.0.1:{}", l.local_addr().unwrap().port());
        let pings = Arc::new(AtomicUsize::new(0));
        let counted = pings.clone();
        std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap();
            while let Ok(m) = ws.read() {
                match m {
                    Message::Binary(b) => ws.send(Message::Binary(b)).unwrap(),
                    Message::Text(t) if t.as_str() == collab::mux::PING => {
                        counted.fetch_add(1, Ordering::SeqCst);
                        if pong {
                            ws.send(Message::Text(collab::mux::PONG.into())).unwrap();
                        }
                    }
                    _ => {}
                }
            }
        });
        (addr, pings)
    }

    fn open(addr: &str, heartbeat: Option<Heartbeat>) -> (SockTx, Receiver<Result<Vec<u8>, (u16, String)>>) {
        let (tx, rx) = mpsc::channel();
        let sock = spawn(format!("http://{addr}"), format!("ws://{addr}/ws?repo=x"), None, heartbeat, Report(tx));
        (sock, rx)
    }

    fn heartbeat(ms: u64, timeout_ms: u64) -> Heartbeat {
        Heartbeat { ms: Arc::new(AtomicU64::new(ms)), timeout: Duration::from_millis(timeout_ms) }
    }

    /// The round trip of one frame through the echo server.
    fn echo(sock: &SockTx, rx: &Receiver<Result<Vec<u8>, (u16, String)>>, n: u8) -> Duration {
        let t = Instant::now();
        assert!(sock.send(ToSock::Frame(vec![n; 3])));
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Ok(vec![n; 3]));
        t.elapsed()
    }

    #[test]
    fn sends_go_out_at_once_and_close_is_clean() {
        let (addr, _) = server(true);
        let (sock, rx) = open(&addr, None);
        for n in 0..20 {
            let rtt = echo(&sock, &rx, n);
            assert!(rtt < Duration::from_millis(50), "frame {n}: {rtt:?}");
        }
        sock.send(ToSock::Close);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Err((1000, "closed".into())));
    }

    #[test]
    fn the_heartbeat_pings_and_a_missing_pong_closes() {
        let (addr, pings) = server(true);
        let (sock, rx) = open(&addr, Some(heartbeat(100, 1000)));
        std::thread::sleep(Duration::from_millis(550));
        let n = pings.load(Ordering::SeqCst);
        assert!((4..=6).contains(&n), "{n} pings in 550 ms");
        echo(&sock, &rx, 1);
        sock.send(ToSock::Close);

        let (addr, _) = server(false);
        let (_sock, rx) = open(&addr, Some(heartbeat(100, 200)));
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Err((1006, "no pong".into())));
    }

    /// The process's CPU time so far (`ps`).
    fn cpu() -> f64 {
        let out = std::process::Command::new("ps").args(["-o", "time=", "-p", &std::process::id().to_string()]).output().unwrap();
        let s = String::from_utf8(out.stdout).unwrap();
        s.trim().split(':').fold(0.0, |acc, part| acc * 60.0 + part.parse::<f64>().unwrap())
    }

    /// `cargo test --release -p grimoire idle_sockets -- --ignored --nocapture`: a v1 socket (no heartbeat) and a v2
    /// one (30 s heartbeat) open for 30 s use no CPU, and a frame still goes out at once afterwards.
    #[test]
    #[ignore]
    fn idle_sockets_use_no_cpu() {
        let (a1, _) = server(true);
        let (a2, pings) = server(true);
        let (v1, rx1) = open(&a1, None);
        let (v2, rx2) = open(&a2, Some(heartbeat(30_000, 10_000)));
        echo(&v1, &rx1, 1);
        echo(&v2, &rx2, 1);
        let (c0, t0) = (cpu(), Instant::now());
        std::thread::sleep(Duration::from_secs(30));
        let (c1, secs) = (cpu(), t0.elapsed().as_secs_f64());
        let (r1, r2) = (echo(&v1, &rx1, 2), echo(&v2, &rx2, 2));
        let pct = (c1 - c0) / secs * 100.0;
        println!("IDLE cpu {:.3} s over {secs:.1} s = {pct:.3}%; pings {}; echo after idle v1 {r1:?} v2 {r2:?}", c1 - c0, pings.load(Ordering::SeqCst));
        assert!(pct < 0.5, "{pct}% idle");
        assert!(r1 < Duration::from_millis(50) && r2 < Duration::from_millis(50));
    }
}
