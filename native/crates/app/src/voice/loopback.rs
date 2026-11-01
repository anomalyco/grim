//! A stand-in for GPT-Live on this Mac (`--voice-selftest=loopback`): it takes the session `POST` on 127.0.0.1,
//! checks the body as the service would (model, WebRTC transport, data channel 4, no audio format), answers the offer
//! as an ICE-lite str0m peer, sends `session.started` on the negotiated channel, echoes the microphone's Opus back,
//! reports what it heard as transcript deltas, and answers `session.close` with `session.closed`. It proves the app's
//! side of the stack (ICE, DTLS, SCTP, RTP both ways, the events) without a service account.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, UdpSocket};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use str0m::change::SdpOffer;
use str0m::channel::ChannelConfig;
use str0m::media::Mid;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, RtcConfig};

/// Serve one session; its URL.
pub fn start(ip: std::net::IpAddr) -> Result<String, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        if let Err(e) = serve(l, ip) {
            eprintln!("loopback server: {e}");
        }
    });
    Ok(format!("http://127.0.0.1:{port}/v1/live/sessions"))
}

fn respond(s: &mut std::net::TcpStream, status: u16, body: &Value) {
    let b = body.to_string();
    let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
}

fn serve(l: TcpListener, ip: std::net::IpAddr) -> Result<(), String> {
    let (mut s, _) = l.accept().map_err(|e| e.to_string())?;
    let mut r = BufReader::new(s.try_clone().map_err(|e| e.to_string())?);
    let (mut len, mut auth) = (0usize, false);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    loop {
        line.clear();
        r.read_line(&mut line).map_err(|e| e.to_string())?;
        let t = line.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some((k, v)) = t.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = v.trim().parse().unwrap_or(0),
                "authorization" => auth = v.trim().starts_with("Bearer "),
                _ => {}
            }
        }
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let problems: Vec<&str> = [
        (!auth, "no bearer"),
        (v["session"]["model"] != "gpt-live-1", "model"),
        (v["transport"]["type"] != "webrtc", "transport.type"),
        (v["transport"]["dcid"] != 4, "transport.dcid"),
        (!v["session"]["audio"]["format"].is_null(), "audio.format on WebRTC"),
        (v["session"]["audio"]["output"]["voice"].as_str().is_none(), "voice"),
        (!v["session"]["tools"].is_null(), "tools"),
    ]
    .into_iter()
    .filter_map(|(bad, what)| bad.then_some(what))
    .collect();
    if !problems.is_empty() {
        respond(&mut s, 400, &json!({ "error": { "message": format!("loopback: bad request: {}", problems.join(", ")) } }));
        return Err(format!("bad request: {problems:?}"));
    }
    eprintln!("loopback server: request ok (model gpt-live-1, webrtc, dcid 4, no audio.format, delegation {})", v["session"]["delegation"]);
    let offer = SdpOffer::from_sdp_string(v["transport"]["sdp"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
    let sock = UdpSocket::bind(SocketAddr::new(ip, 0)).map_err(|e| e.to_string())?;
    let local = sock.local_addr().map_err(|e| e.to_string())?;
    let mut rtc = RtcConfig::new().clear_codecs().enable_opus(true, false).set_ice_lite(true).build(Instant::now());
    rtc.add_local_candidate(Candidate::host(local, "udp").map_err(|e| e.to_string())?);
    let chan = rtc.direct_api().create_data_channel(ChannelConfig { label: "oai-events".into(), negotiated: Some(4), ..Default::default() });
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| e.to_string())?;
    respond(&mut s, 200, &json!({ "session": { "id": "sess_loopback" }, "transport": { "sdp": answer.to_sdp_string() } }));
    drop(s);

    let mut buf = vec![0u8; 2000];
    let (mut mid, mut open, mut started, mut heard, mut said) = (None::<Mid>, false, false, 0u64, false);
    let mut close_at: Option<Instant> = None;
    let begun = Instant::now();
    loop {
        let timeout = loop {
            match rtc.poll_output().map_err(|e| e.to_string())? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    let _ = sock.send_to(&t.contents, t.destination);
                }
                Output::Event(e) => match e {
                    Event::MediaAdded(m) => mid = Some(m.mid),
                    Event::ChannelOpen(..) => open = true,
                    Event::Connected => open = true,
                    Event::MediaData(d) => {
                        heard += 1;
                        let pt = mid.and_then(|m| rtc.writer(m)).and_then(|w| w.payload_params().next().map(|p| p.pt()));
                        if let (Some(m), Some(pt)) = (mid, pt)
                            && let Some(w) = rtc.writer(m)
                        {
                            let _ = w.write(pt, Instant::now(), d.time, d.data);
                        }
                    }
                    Event::ChannelData(d) => {
                        let ev: Value = serde_json::from_slice(&d.data).unwrap_or_default();
                        if ev["type"] == "session.close" {
                            if let Some(mut ch) = rtc.channel(chan) {
                                let _ = ch.write(false, json!({ "type": "session.closed", "reason": "client_closed" }).to_string().as_bytes());
                            }
                            close_at = Some(Instant::now());
                        } else if let Some(t) = ev["type"].as_str()
                            && let Some(mut ch) = rtc.channel(chan)
                        {
                            let muted = match t {
                                "session.input_audio.mute" => Some("session.input_audio.muted"),
                                "session.input_audio.unmute" => Some("session.input_audio.unmuted"),
                                _ => None,
                            };
                            if let Some(m) = muted {
                                let _ = ch.write(false, json!({ "type": m }).to_string().as_bytes());
                            }
                        }
                    }
                    _ => {}
                },
            }
        };
        if open && !started
            && let Some(mut ch) = rtc.channel(chan)
            && ch.write(false, json!({ "type": "session.started" }).to_string().as_bytes()).unwrap_or(false)
        {
            started = true;
            continue;
        }
        if started && !said && heard >= 100
            && let Some(mut ch) = rtc.channel(chan)
        {
            let _ = ch.write(false, json!({ "type": "session.input_transcript.delta", "delta": format!("({heard} Opus frames heard)") }).to_string().as_bytes());
            let _ = ch.write(false, json!({ "type": "session.output_transcript.delta", "delta": "Loopback here: your audio arrived and is echoed back." }).to_string().as_bytes());
            said = true;
            continue;
        }
        if close_at.is_some_and(|t| t.elapsed() > Duration::from_secs(1)) || begun.elapsed() > Duration::from_secs(90) {
            eprintln!("loopback server: done ({heard} frames heard and echoed)");
            return Ok(());
        }
        let wait = timeout.saturating_duration_since(Instant::now()).clamp(Duration::from_millis(1), Duration::from_millis(50));
        sock.set_read_timeout(Some(wait)).map_err(|e| e.to_string())?;
        let input = match sock.recv_from(&mut buf) {
            Ok((n, source)) => match Receive::new(Protocol::Udp, source, local, &buf[..n]) {
                Ok(r) => Input::Receive(Instant::now(), r),
                Err(_) => continue,
            },
            Err(_) => Input::Timeout(Instant::now()),
        };
        rtc.handle_input(input).map_err(|e| e.to_string())?;
    }
}
