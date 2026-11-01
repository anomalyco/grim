//! Where a voice session is created, and with which credential ("Connect via"): OpenCode Console (the default, a
//! Console API key), an OpenAI API key, or (not yet) the paired OpenCode server. Keys live in the Keychain (service
//! "Grimoire", accounts `voice.opencode-console` and `voice.openai`); the choice in the support folder's `voice.json`.

use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Console,
    OpenAi,
    /// `POST <server>/api/experimental/voice/session` with the same body, through the paired OpenCode server (File ▸
    /// Connect to OpenCode…), which creates the session with its own credentials.
    Server,
}

pub const CONSOLE_URL: &str = "https://opencode.ai/inference/openai/v1/live/sessions";
pub const OPENAI_URL: &str = "https://api.openai.com/v1/live/sessions";
pub const SERVER_PATH: &str = "/api/experimental/voice/session";
pub const NOT_PAIRED: &str = "Pair with an OpenCode server first (File ▸ Connect to OpenCode…), or choose another connection.";

impl Via {
    pub const ALL: [Via; 3] = [Via::Console, Via::OpenAi, Via::Server];

    pub fn id(self) -> &'static str {
        match self {
            Via::Console => "console",
            Via::OpenAi => "openai",
            Via::Server => "server",
        }
    }

    pub fn from_id(s: &str) -> Option<Via> {
        Via::ALL.into_iter().find(|v| v.id() == s)
    }

    pub fn label(self) -> &'static str {
        match self {
            Via::Console => "OpenCode Console",
            Via::OpenAi => "OpenAI API key",
            Via::Server => "Paired OpenCode server",
        }
    }

    /// Its key's Keychain account.
    pub fn account(self) -> Option<&'static str> {
        match self {
            Via::Console => Some("voice.opencode-console"),
            Via::OpenAi => Some("voice.openai"),
            Via::Server => None,
        }
    }
}

/// Where to `POST` the session and how to sign it.
#[derive(Clone)]
pub struct Endpoint {
    pub via: Via,
    pub url: String,
    pub bearer: Option<String>,
    pub headers: Vec<(String, String)>,
}

impl std::fmt::Debug for Endpoint {
    // never the key
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.url, self.via.label())
    }
}

pub fn endpoint(via: Via, key: String) -> Result<Endpoint, String> {
    let key = key.trim().to_string();
    let url = match via {
        Via::Console => CONSOLE_URL,
        Via::OpenAi => OPENAI_URL,
        Via::Server => return Err(NOT_PAIRED.into()),
    };
    // (an OAuth token scoped to a Console org would add `x-opencode-org-id`; a Console API key needs none)
    Ok(Endpoint { via, url: url.into(), bearer: Some(key), headers: Vec::new() })
}

/// Through the paired OpenCode server: HTTP Basic `opencode:<token>` as its other requests (none without a password).
pub fn server_endpoint(p: &crate::opencode::Pairing) -> Endpoint {
    let mut headers = Vec::new();
    if !p.password.is_empty() {
        let basic = crate::opencode::base64(format!("{}:{}", crate::opencode::USERNAME, p.password).as_bytes());
        headers.push(("Authorization".to_string(), format!("Basic {basic}")));
    }
    Endpoint { via: Via::Server, url: format!("{}{SERVER_PATH}", p.url), bearer: None, headers }
}

/// The session's create body: the model, its instructions and voice, no tools; the WebRTC offer (data channel 4).
/// GPT-Live negotiates the audio format in SDP, so there is no `audio.format`. `delegation` only when the service
/// insists (`session::create`).
pub fn body(via: Via, sdp: &str, instructions: &str, voice: &str, delegation: Option<&str>) -> Value {
    let mut session = json!({
        "model": "gpt-live-1",
        "instructions": instructions,
        "audio": { "output": { "voice": voice } },
    });
    if let Some(d) = delegation {
        session["delegation"] = json!({ "type": d });
    }
    let mut b = json!({ "session": session, "transport": { "type": "webrtc", "sdp": sdp, "dcid": crate::voice::rtc::DCID } });
    // the OpenCode server picks the model from the top level
    if via == Via::Server {
        b["model"] = json!("gpt-live-1");
    }
    b
}

pub fn key(via: Via) -> Option<String> {
    crate::workspaces::keychain::get_secret(via.account()?).map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

pub fn save_key(via: Via, key: &str) -> Result<(), String> {
    let account = via.account().ok_or("no key for this connection")?;
    crate::workspaces::keychain::set(account, key.trim()).map(|_| ())
}

pub fn remove_key(via: Via) {
    if let Some(a) = via.account() {
        crate::workspaces::keychain::remove(a);
    }
}

fn via_file() -> Option<std::path::PathBuf> {
    crate::workspaces::default_support_dir().map(|d| d.join("voice.json"))
}

/// The chosen connection (OpenCode Console unless changed).
pub fn load_via() -> Via {
    via_file()
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["via"].as_str().and_then(Via::from_id))
        .unwrap_or(Via::Console)
}

pub fn save_via(via: Via) {
    if let Some(f) = via_file() {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(f, json!({ "via": via.id() }).to_string());
    }
}
