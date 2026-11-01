//! GPT-Live over WebRTC with str0m (no IO of its own) on one UDP socket, polled with mio: one sendrecv Opus audio
//! track and the negotiated data channel 4 (`oai-events`) for the JSON events.
//!
//! str0m's contract: after every mutation (a packet in, a timeout, a write) drain `poll_output` to its timeout before
//! the next one; `pump` does, and events found while draining are handled after it.

use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};

use std::os::fd::AsRawFd;

use mio::unix::SourceFd;
use mio::{Events, Interest, Poll, Token};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelId};
use str0m::format::Codec;
use str0m::media::{Direction, Frequency, MediaKind, MediaTime, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

use super::delegate::Note;
use super::events::{self, Server};
use super::opus;
use super::session::{Cmd, Ev, Pipes, Sink};

/// The pre-negotiated event channel's id (no DCEP round trip).
pub const DCID: u16 = 4;
pub const SOCK: Token = Token(0);
pub const WAKE: Token = Token(1);
/// From the answer to `session.started` (ICE, DTLS, SCTP and the service).
const CONNECT_LIMIT: Duration = Duration::from_secs(15);
/// A connection that drops this long is gone.
const LOST_LIMIT: Duration = Duration::from_secs(5);
/// After `session.close`, how long `session.closed` may take.
const CLOSE_LIMIT: Duration = Duration::from_secs(10);
/// The voice keeps at most this much waiting to play (it would be stale).
const SPK_MAX: usize = opus::RATE as usize * 30;

pub struct Link {
    rtc: Rtc,
    sock: UdpSocket,
    pub local: SocketAddr,
    mid: Mid,
    chan: ChannelId,
    pt: Option<Pt>,
    /// Events seen while draining, handled after.
    seen: Vec<Event>,
}

/// What the run loop is waiting for.
#[derive(PartialEq)]
enum Phase {
    Connecting,
    Live,
    Closing(Instant),
}

impl Link {
    /// A socket on this Mac's outgoing address, its host candidate, the audio track and the event channel; the offer.
    pub fn offer(poll: &Poll) -> Result<(Link, SdpPendingOffer, String), String> {
        let ip = local_ip().ok_or("No network connection (no local address).")?;
        let std_sock = UdpSocket::bind(SocketAddr::new(ip, 0)).map_err(|e| format!("UDP socket: {e}"))?;
        std_sock.set_nonblocking(true).map_err(|e| e.to_string())?;
        let local = std_sock.local_addr().map_err(|e| e.to_string())?;
        let sock = std_sock;
        poll.registry().register(&mut SourceFd(&sock.as_raw_fd()), SOCK, Interest::READABLE).map_err(|e| e.to_string())?;
        let mut rtc = RtcConfig::new().clear_codecs().enable_opus(true, false).build(Instant::now());
        let cand = Candidate::host(local, "udp").map_err(|e| format!("ICE candidate: {e}"))?;
        rtc.add_local_candidate(cand);
        let mut change = rtc.sdp_api();
        let mid = change.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None);
        let chan = change.add_channel_with_config(ChannelConfig { label: "oai-events".into(), negotiated: Some(DCID), ..Default::default() });
        let (offer, pending) = change.apply().ok_or("No WebRTC offer.")?;
        let sdp = offer.to_sdp_string();
        Ok((Link { rtc, sock, local, mid, chan, pt: None, seen: Vec::new() }, pending, sdp))
    }

    pub fn accept(&mut self, pending: SdpPendingOffer, answer: &str) -> Result<(), String> {
        let answer = SdpAnswer::from_sdp_string(answer).map_err(|e| format!("The voice service's SDP answer: {e}"))?;
        self.rtc.sdp_api().accept_answer(pending, answer).map_err(|e| format!("The SDP answer: {e}"))?;
        self.pt = self.rtc.writer(self.mid).and_then(|w| w.payload_params().find(|p| p.spec().codec == Codec::Opus).map(|p| p.pt()));
        Ok(())
    }

    /// Drain str0m to its next timeout: datagrams out, events kept.
    fn pump(&mut self) -> Result<Instant, String> {
        loop {
            match self.rtc.poll_output().map_err(|e| format!("WebRTC: {e}"))? {
                Output::Timeout(t) => return Ok(t),
                Output::Transmit(t) => {
                    let _ = self.sock.send_to(&t.contents, t.destination);
                }
                Output::Event(e) => self.seen.push(e),
            }
        }
    }

    fn send_json(&mut self, s: &str) -> Result<bool, String> {
        let ok = match self.rtc.channel(self.chan) {
            Some(mut ch) => ch.write(false, s.as_bytes()).map_err(|e| format!("data channel: {e}"))?,
            None => false,
        };
        self.pump()?;
        Ok(ok)
    }

    /// Until the session ends: `Ok` once closed (or ended before it started), `Err` when it fails.
    pub fn run(mut self, mut poll: Poll, rx: &Receiver<Cmd>, pipes: &Arc<Pipes>, sink: &Sink, notes: &Sender<Note>) -> Result<(), String> {
        let mut events_buf = Events::with_capacity(64);
        let mut buf = vec![0u8; 2000];
        let mut enc = opus::Encoder::new()?;
        let mut dec = opus::Decoder::new()?;
        let mut phase = Phase::Connecting;
        let started = Instant::now();
        let mut connected = false;
        let mut channel_open = false;
        let mut lost_at: Option<Instant> = None;
        let mut media_time: u64 = 0;
        let mut last_level = Instant::now();
        let mut shown: (u8, bool) = (0, false);
        let mut next = self.pump()?;
        loop {
            // what was seen while draining
            while !self.seen.is_empty() {
                for e in std::mem::take(&mut self.seen) {
                    match e {
                        Event::IceConnectionStateChange(s) => {
                            sink(Ev::Log(format!("ICE {s:?}")));
                            match s {
                                IceConnectionState::Disconnected => lost_at = lost_at.or(Some(Instant::now())),
                                IceConnectionState::Connected | IceConnectionState::Completed => lost_at = None,
                                _ => {}
                            }
                        }
                        Event::Connected => {
                            connected = true;
                            sink(Ev::Log("DTLS connected".into()));
                        }
                        Event::ChannelOpen(id, label) if id == self.chan => {
                            channel_open = true;
                            sink(Ev::Log(format!("data channel {label} open (id {DCID})")));
                        }
                        Event::ChannelData(d) if d.id == self.chan => match events::parse(&d.data) {
                            Some(Server::Started) => {
                                sink(Ev::Log("session.started".into()));
                                if phase == Phase::Connecting {
                                    phase = Phase::Live;
                                    sink(Ev::Live);
                                    let _ = notes.send(Note::Started);
                                }
                            }
                            Some(Server::Output(t)) => {
                                let _ = notes.send(Note::Output(t.clone()));
                                sink(Ev::Agent(t));
                            }
                            Some(Server::Input(t)) => {
                                let _ = notes.send(Note::Input(t.clone()));
                                sink(Ev::You(t));
                            }
                            Some(Server::Delegation(id)) => {
                                sink(Ev::Log(format!("session.delegation.created {id}")));
                                let _ = notes.send(Note::Delegation(id));
                            }
                            Some(Server::Appended(id)) => {
                                let _ = notes.send(Note::Appended(id));
                            }
                            Some(Server::Muted(m)) => sink(Ev::Muted(m)),
                            Some(Server::Closed(reason)) => {
                                sink(Ev::Log(format!("session.closed ({reason})")));
                                return Ok(());
                            }
                            Some(Server::Error(m)) => {
                                sink(Ev::Log(format!("error event: {m}")));
                                if phase == Phase::Connecting {
                                    return Err(m);
                                }
                            }
                            Some(Server::Other(t)) => sink(Ev::Log(format!("event {t}"))),
                            None => {}
                        },
                        Event::ChannelClose(id) if id == self.chan => {
                            sink(Ev::Log("data channel closed".into()));
                            return match phase {
                                Phase::Closing(_) => Ok(()),
                                _ => Err("The voice service closed the connection.".into()),
                            };
                        }
                        Event::MediaData(m) => {
                            pipes.packets_received.fetch_add(1, Ordering::Relaxed);
                            if !m.contiguous {
                                let lost = dec.decode(None).to_vec();
                                push_spk(pipes, &lost);
                            }
                            let pcm = dec.decode(Some(&m.data)).to_vec();
                            push_spk(pipes, &pcm);
                            // (the voice's audio, not its silence: for when appends may go out)
                            if pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len().max(1) as f32 > 1e-5 {
                                pipes.voice_heard(pipes.spk.lock().unwrap().len());
                            }
                        }
                        _ => {}
                    }
                }
                next = self.pump()?;
            }

            // the UI's requests
            loop {
                match rx.try_recv() {
                    Ok(Cmd::Mute(m)) => {
                        pipes.muted.store(m, Ordering::Relaxed);
                        if channel_open {
                            self.send_json(&events::mute(m))?;
                        }
                    }
                    Ok(Cmd::Send(json)) => {
                        if !channel_open || !self.send_json(&json)? {
                            sink(Ev::Log("couldn't send an event (data channel not open)".into()));
                        }
                    }
                    Ok(Cmd::End) => match phase {
                        Phase::Live => {
                            sink(Ev::Log("sending session.close".into()));
                            if !channel_open || !self.send_json(&events::close())? {
                                return Ok(());
                            }
                            phase = Phase::Closing(Instant::now());
                            sink(Ev::Ending);
                        }
                        Phase::Connecting => return Ok(()),
                        Phase::Closing(_) => {}
                    },
                    // the app let go of the session: close it
                    Err(TryRecvError::Disconnected) if phase == Phase::Live => {
                        if !channel_open || !self.send_json(&events::close())? {
                            return Ok(());
                        }
                        phase = Phase::Closing(Instant::now());
                    }
                    Err(TryRecvError::Disconnected) if phase == Phase::Connecting => return Ok(()),
                    Err(_) => break,
                }
            }

            // the microphone, 20 ms at a time
            let frames: Vec<Vec<f32>> = {
                let mut mic = pipes.mic.lock().unwrap();
                let n = mic.len() / opus::FRAME;
                let out = mic.chunks(opus::FRAME).take(n).map(<[f32]>::to_vec).collect();
                mic.drain(..n * opus::FRAME);
                out
            };
            for mut f in frames {
                // (SRTP needs DTLS's keys)
                if !connected {
                    continue;
                }
                let Some(pt) = self.pt else { continue };
                if pipes.muted.load(Ordering::Relaxed) {
                    f.fill(0.0);
                }
                let packet = enc.encode(&f)?;
                if let Some(w) = self.rtc.writer(self.mid) {
                    w.write(pt, Instant::now(), MediaTime::new(media_time, Frequency::FORTY_EIGHT_KHZ), packet).map_err(|e| format!("RTP: {e}"))?;
                    pipes.frames_sent.fetch_add(1, Ordering::Relaxed);
                }
                media_time += opus::FRAME as u64;
                next = self.pump()?;
            }

            // timers
            let now = Instant::now();
            match phase {
                Phase::Connecting if now - started > CONNECT_LIMIT => {
                    return Err(if connected { "The voice session didn't start." } else { "Couldn't connect to the voice service (WebRTC)." }.into());
                }
                Phase::Closing(t) if now - t > CLOSE_LIMIT => {
                    sink(Ev::Log("no session.closed within 10 s; closing anyway".into()));
                    return Ok(());
                }
                _ => {}
            }
            if lost_at.is_some_and(|t| now - t > LOST_LIMIT) {
                return if matches!(phase, Phase::Closing(_)) { Ok(()) } else { Err("The connection dropped.".into()) };
            }
            if phase == Phase::Live && now - last_level > Duration::from_millis(100) {
                last_level = now;
                let user = ((pipes.level() * 40.0).sqrt() * 5.0).clamp(0.0, 5.0) as u8;
                let speaking = pipes.spk.lock().unwrap().len() > opus::FRAME;
                if (user, speaking) != shown {
                    shown = (user, speaking);
                    sink(Ev::Level { user, speaking });
                }
            }

            // wait for a datagram, a request, a frame or the next timeout
            let wait = next.saturating_duration_since(Instant::now()).min(Duration::from_millis(50));
            if let Err(e) = poll.poll(&mut events_buf, Some(wait)) {
                if e.kind() != std::io::ErrorKind::Interrupted {
                    return Err(format!("poll: {e}"));
                }
            }
            let mut readable = false;
            for e in events_buf.iter() {
                if e.token() == SOCK {
                    readable = true;
                }
            }
            if readable {
                loop {
                    match self.sock.recv_from(&mut buf) {
                        Ok((n, source)) => {
                            let Ok(r) = Receive::new(Protocol::Udp, source, self.local, &buf[..n]) else { continue };
                            self.rtc.handle_input(Input::Receive(Instant::now(), r)).map_err(|e| format!("WebRTC: {e}"))?;
                            next = self.pump()?;
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(e) => return Err(format!("UDP: {e}")),
                    }
                }
            }
            if Instant::now() >= next {
                self.rtc.handle_input(Input::Timeout(Instant::now())).map_err(|e| format!("WebRTC: {e}"))?;
                next = self.pump()?;
            }
        }
    }
}

fn push_spk(pipes: &Pipes, pcm: &[f32]) {
    let mut spk = pipes.spk.lock().unwrap();
    spk.extend(pcm.iter().copied());
    let n = spk.len();
    if n > SPK_MAX {
        spk.drain(..n - SPK_MAX);
    }
}

/// The address this Mac sends from (no packet is sent: connecting a UDP socket only picks the route).
pub fn local_ip() -> Option<std::net::IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}
